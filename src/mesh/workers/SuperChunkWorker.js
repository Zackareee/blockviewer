/**
 * SuperChunkWorker - Unified Decode → Mesh Worker for Super-Chunks
 * 
 * Handles the complete pipeline for a 2x2 super-chunk:
 * 1. Decompress raw chunk data (native or pako)
 * 2. Parse NBT
 * 3. Decode blocks to grid + state grid
 * 4. Include neighbor boundary data
 * 5. Propagate light
 * 6. Build ALL meshes (solid + water + lava + glass + models)
 * 7. Return transferable ArrayBuffers
 * 
 * This keeps the main thread free for rendering (~2ms per super-chunk).
 */

import pako from 'pako';

// ============================================================================
// Constants
// ============================================================================

const S = 16, S2 = 256, S3 = 4096;
const BLOCK_ID_MASK = 0x0FFF, LEVEL_MASK = 0xF000, LEVEL_SHIFT = 12;
const MIN_Y = -64;
const MAX_Y = 321;

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

const UNDERWATER_BLOCKS = new Set([
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column',
  'minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:kelp', 
  'minecraft:kelp_plant', 'minecraft:bubble_column'
]);

// Check if native DecompressionStream is available
const hasNativeDecompress = typeof DecompressionStream !== 'undefined';

// ============================================================================
// Worker State
// ============================================================================

let workerInitialized = false;
let blockRegistry = null;
let stateRegistry = null;
let textureIndexLookup = null;
let tintTypeLookup = null;

// ============================================================================
// Decompression Helpers
// ============================================================================

async function decompressNative(data, format) {
  try {
    const stream = new DecompressionStream(format);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    
    writer.write(data);
    writer.close();
    
    const chunks = [];
    let totalLength = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }
    
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    return result;
  } catch {
    return null;
  }
}

async function decompressChunk(compressedData, compressionType) {
  if (compressionType === 1) {
    // GZip - try native first
    if (hasNativeDecompress) {
      const result = await decompressNative(compressedData, 'gzip');
      if (result) return result;
    }
    return pako.ungzip(compressedData);
  } else if (compressionType === 2) {
    // Zlib - try native deflate-raw with stripped header
    if (hasNativeDecompress && compressedData.length > 6) {
      const rawData = compressedData.slice(2, -4);
      const result = await decompressNative(rawData, 'deflate-raw');
      if (result) return result;
    }
    return pako.inflate(compressedData);
  }
  throw new Error(`Unsupported compression type: ${compressionType}`);
}

// ============================================================================
// NBT Parser
// ============================================================================

const TAG_END = 0, TAG_BYTE = 1, TAG_SHORT = 2, TAG_INT = 3, TAG_LONG = 4;
const TAG_FLOAT = 5, TAG_DOUBLE = 6, TAG_BYTE_ARRAY = 7, TAG_STRING = 8;
const TAG_LIST = 9, TAG_COMPOUND = 10, TAG_INT_ARRAY = 11, TAG_LONG_ARRAY = 12;

class NBTReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  readByte() { return this.view.getInt8(this.offset++); }
  readUByte() { return this.view.getUint8(this.offset++); }
  
  readShort() {
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }
  
  readInt() {
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }
  
  readLong() {
    const high = this.view.getInt32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return BigInt(high) * BigInt(0x100000000) + BigInt(low);
  }
  
  readFloat() {
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return v;
  }
  
  readDouble() {
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }
  
  readString() {
    const length = this.readShort();
    if (length <= 0) return '';
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return new TextDecoder('utf-8').decode(bytes);
  }
  
  readByteArray() {
    const length = this.readInt();
    const arr = new Int8Array(this.buffer, this.offset, length);
    this.offset += length;
    return Array.from(arr);
  }
  
  readIntArray() {
    const length = this.readInt();
    const arr = [];
    for (let i = 0; i < length; i++) arr.push(this.readInt());
    return arr;
  }
  
  readLongArray() {
    const length = this.readInt();
    const arr = [];
    for (let i = 0; i < length; i++) arr.push(this.readLong());
    return arr;
  }
  
  readTag(tagType) {
    switch (tagType) {
      case TAG_END: return null;
      case TAG_BYTE: return this.readByte();
      case TAG_SHORT: return this.readShort();
      case TAG_INT: return this.readInt();
      case TAG_LONG: return this.readLong();
      case TAG_FLOAT: return this.readFloat();
      case TAG_DOUBLE: return this.readDouble();
      case TAG_BYTE_ARRAY: return this.readByteArray();
      case TAG_STRING: return this.readString();
      case TAG_LIST: return this.readList();
      case TAG_COMPOUND: return this.readCompound();
      case TAG_INT_ARRAY: return this.readIntArray();
      case TAG_LONG_ARRAY: return this.readLongArray();
      default: throw new Error(`Unknown tag type: ${tagType}`);
    }
  }
  
  readList() {
    const itemType = this.readByte();
    const length = this.readInt();
    const list = [];
    for (let i = 0; i < length; i++) list.push(this.readTag(itemType));
    return list;
  }
  
  readCompound() {
    const compound = {};
    while (true) {
      const tagType = this.readByte();
      if (tagType === TAG_END) break;
      compound[this.readString()] = this.readTag(tagType);
    }
    return compound;
  }
  
  parse() {
    const tagType = this.readByte();
    if (tagType !== TAG_COMPOUND) throw new Error('Root tag must be a compound');
    this.readString();
    return this.readCompound();
  }
}

function parseNBT(buffer) {
  const reader = new NBTReader(buffer);
  return reader.parse();
}

// ============================================================================
// Block Registry (Worker Version)
// ============================================================================

class WorkerBlockRegistry {
  constructor() {
    this.nameToId = new Map();
    this.idToInfo = [];
    this.nextId = 0;
    this._register('minecraft:air', 0x000000, false, false);
  }
  
  _register(name, color, isOpaque, isFluid) {
    const id = this.nextId++;
    const info = {
      id, name, color, isOpaque, isFluid,
      colorR: ((color >> 16) & 0xFF) / 255,
      colorG: ((color >> 8) & 0xFF) / 255,
      colorB: (color & 0xFF) / 255,
      isNonCube: false,
    };
    this.nameToId.set(name, id);
    this.idToInfo[id] = info;
    const short = name.replace('minecraft:', '');
    if (short !== name) this.nameToId.set(short, id);
    return id;
  }
  
  getBlockId(name) {
    if (!name) return 0;
    const existing = this.nameToId.get(name);
    if (existing !== undefined) return existing;
    
    const short = name.replace('minecraft:', '');
    const isAir = AIR_BLOCKS.has(name) || AIR_BLOCKS.has(short);
    if (isAir) return 0;
    
    const isFluid = short.includes('water') || short.includes('lava');
    const isOpaque = !isFluid && !short.includes('glass') && !short.includes('leaves') && !short.includes('ice');
    
    // Default color - will be updated from main thread data
    const color = 0x707070;
    
    return this._register(name, color, isOpaque, isFluid);
  }
  
  getInfo(id) { return this.idToInfo[id]; }
  isOpaque(id) { return this.idToInfo[id]?.isOpaque || false; }
  isFluid(id) { return this.idToInfo[id]?.isFluid || false; }
  isWater(id) { return this.idToInfo[id]?.name?.includes('water') || false; }
  isLava(id) { return this.idToInfo[id]?.name?.includes('lava') || false; }
  isNonCube(id) { return this.idToInfo[id]?.isNonCube || false; }
  getColor(id) {
    const info = this.idToInfo[id];
    return info ? { r: info.colorR, g: info.colorG, b: info.colorB } : { r: 0.44, g: 0.44, b: 0.44 };
  }
  
  // Import from main thread registry data
  importFromData(data) {
    if (!data || !data.blocks) return;
    
    for (const block of data.blocks) {
      if (this.nameToId.has(block.name)) {
        // Update existing
        const id = this.nameToId.get(block.name);
        const info = this.idToInfo[id];
        if (info) {
          info.color = block.color;
          info.colorR = ((block.color >> 16) & 0xFF) / 255;
          info.colorG = ((block.color >> 8) & 0xFF) / 255;
          info.colorB = (block.color & 0xFF) / 255;
          info.isOpaque = block.isOpaque;
          info.isFluid = block.isFluid;
          info.isNonCube = block.isNonCube;
        }
      } else {
        // Register new
        const id = this._register(block.name, block.color, block.isOpaque, block.isFluid);
        this.idToInfo[id].isNonCube = block.isNonCube;
      }
    }
  }
}

// ============================================================================
// State Registry (Worker Version)
// ============================================================================

class WorkerStateRegistry {
  constructor() {
    this.states = [];
    this.lookup = new Map();
    this.byBlock = new Map();
    this.nextId = 1;
  }
  
  register(blockName, properties = {}) {
    const normalized = blockName.replace('minecraft:', '');
    const propsKey = this._buildPropsKey(properties);
    const lookupKey = `${normalized}|${propsKey}`;

    if (this.lookup.has(lookupKey)) {
      return this.lookup.get(lookupKey);
    }

    const id = this.nextId++;
    const state = {
      id,
      blockName: normalized,
      properties: { ...properties },
      propsKey,
      geometry: null,
      isFullCube: null,
    };

    this.states[id] = state;
    this.lookup.set(lookupKey, id);

    if (!this.byBlock.has(normalized)) {
      this.byBlock.set(normalized, new Set());
    }
    this.byBlock.get(normalized).add(id);

    return id;
  }
  
  getState(stateId) {
    return this.states[stateId] || null;
  }
  
  getGeometrySync(stateId) {
    const state = this.states[stateId];
    return state?.geometry || null;
  }
  
  isFullCubeSync(stateId) {
    const state = this.states[stateId];
    return state?.isFullCube ?? true;
  }
  
  _buildPropsKey(properties) {
    if (!properties || Object.keys(properties).length === 0) {
      return '';
    }
    return Object.entries(properties)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }
  
  // Import from exportForWorker() data
  importFromData(data) {
    if (!data || !data.states) return;
    
    for (const stateData of data.states) {
      const geometry = stateData.geometry.map(geomData => ({
        positions: geomData.positions || null,
        normals: geomData.normals || null,
        uvs: geomData.uvs || null,
        texIndices: geomData.texIndices || null,
        colors: geomData.colors || null,
        indices: geomData.indices || null,
        isFullCube: geomData.isFullCube,
        isTransparent: geomData.isTransparent,
        isOverlay: geomData.isOverlay,
        hasShade: geomData.hasShade,
        faces: geomData.faces,
      }));
      
      const state = {
        id: stateData.id,
        blockName: stateData.blockName,
        properties: stateData.properties,
        propsKey: stateData.propsKey,
        geometry,
        isFullCube: stateData.isFullCube,
      };
      
      this.states[state.id] = state;
      
      if (!this.byBlock.has(state.blockName)) {
        this.byBlock.set(state.blockName, new Set());
      }
      this.byBlock.get(state.blockName).add(state.id);
    }
    
    // Restore lookup
    if (data.lookup) {
      for (const [key, id] of data.lookup) {
        this.lookup.set(key, id);
      }
    }
    
    this.nextId = data.nextId || this.nextId;
  }
}

// ============================================================================
// Binary Grid
// ============================================================================

function makeSectionKey(cx, cz, sy) { return `${cx},${cz},${sy}`; }
function parseSectionKey(key) {
  const p = key.split(',');
  return { chunkX: +p[0], chunkZ: +p[1], sectionY: +p[2] };
}
function sectionToWorldY(sy) { return sy * S + MIN_Y; }

class WorkerBinaryGrid {
  constructor() {
    this.sections = new Map();
    this.totalBlocks = 0;
    this.minChunkX = Infinity; this.maxChunkX = -Infinity;
    this.minChunkZ = Infinity; this.maxChunkZ = -Infinity;
    this.minSectionY = Infinity; this.maxSectionY = -Infinity;
  }
  
  _getOrCreateSection(cx, cz, sy) {
    const key = makeSectionKey(cx, cz, sy);
    let sec = this.sections.get(key);
    if (!sec) {
      sec = new Uint16Array(S3);
      this.sections.set(key, sec);
      this.minChunkX = Math.min(this.minChunkX, cx);
      this.maxChunkX = Math.max(this.maxChunkX, cx);
      this.minChunkZ = Math.min(this.minChunkZ, cz);
      this.maxChunkZ = Math.max(this.maxChunkZ, cz);
      this.minSectionY = Math.min(this.minSectionY, sy);
      this.maxSectionY = Math.max(this.maxSectionY, sy);
    }
    return sec;
  }
  
  getSection(cx, cz, sy) {
    return this.sections.get(makeSectionKey(cx, cz, sy));
  }
  
  getBlock(x, y, z) {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const sy = Math.floor((y - MIN_Y) / S);
    const sec = this.getSection(cx, cz, sy);
    if (!sec) return 0;
    const lx = ((x % S) + S) % S;
    const ly = ((y - MIN_Y) % S + S) % S;
    const lz = ((z % S) + S) % S;
    return sec[ly * S2 + lz * S + lx];
  }
}

// ============================================================================
// Block State Grid
// ============================================================================

class WorkerBlockStateGrid {
  constructor() {
    this.sections = new Map();
  }
  
  _getOrCreateSection(cx, cz, sy) {
    const key = makeSectionKey(cx, cz, sy);
    let sec = this.sections.get(key);
    if (!sec) {
      sec = new Uint16Array(S3);
      this.sections.set(key, sec);
    }
    return sec;
  }
  
  getSection(cx, cz, sy) {
    return this.sections.get(makeSectionKey(cx, cz, sy));
  }
}

// ============================================================================
// Light Grid
// ============================================================================

class WorkerLightGrid {
  constructor() {
    this.sections = new Map();
    this.hasMinecraftLightData = false;
  }
  
  _getOrCreateSection(cx, cz, sy) {
    const key = makeSectionKey(cx, cz, sy);
    let sec = this.sections.get(key);
    if (!sec) {
      // Each byte: high nibble = block light, low nibble = sky light
      sec = new Uint8Array(S3);
      sec.fill(0x0F); // Default: sky 15, block 0
      this.sections.set(key, sec);
    }
    return sec;
  }
  
  getSection(cx, cz, sy) {
    return this.sections.get(makeSectionKey(cx, cz, sy));
  }
  
  getLight(x, y, z) {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const sy = Math.floor((y - MIN_Y) / S);
    const sec = this.getSection(cx, cz, sy);
    if (!sec) return { sky: 15, block: 0 };
    const lx = ((x % S) + S) % S;
    const ly = ((y - MIN_Y) % S + S) % S;
    const lz = ((z % S) + S) % S;
    const val = sec[ly * S2 + lz * S + lx];
    return { sky: val & 0x0F, block: (val >> 4) & 0x0F };
  }
}

// ============================================================================
// Chunk Decoder
// ============================================================================

const BIT_OFFSETS = Array.from({ length: 16 }, (_, i) =>
  Array.from({ length: 64 }, (_, j) => BigInt(j * i))
);

function unpackBlockIndices(data, bitsPerBlock, totalBlocks) {
  const indices = new Uint16Array(totalBlocks);
  const entriesPerLong = Math.floor(64 / bitsPerBlock);
  const dataLen = data.length;
  
  // Fast paths for common bit widths
  if (bitsPerBlock === 4) {
    let i = 0;
    for (let longIndex = 0; longIndex < dataLen && i < totalBlocks; longIndex++) {
      const val = data[longIndex];
      let low, high;
      if (typeof val === 'bigint') {
        low = Number(val & 0xFFFFFFFFn);
        high = Number((val >> 32n) & 0xFFFFFFFFn);
      } else {
        low = val >>> 0;
        high = 0;
      }
      if (i < totalBlocks) indices[i++] = (low) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 4) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 8) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 12) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 16) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 20) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 24) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 28) & 0xF;
      if (i < totalBlocks) indices[i++] = (high) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 4) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 8) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 12) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 16) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 20) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 24) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 28) & 0xF;
    }
    return indices;
  }
  
  // Standard path for other bit widths
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const longValues = data.map(v => typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt(v >>> 0));
  const bitOffsets = bitsPerBlock < 16 ? BIT_OFFSETS[bitsPerBlock] : null;
  
  let i = 0;
  for (let li = 0; li < longValues.length && i < totalBlocks; li++) {
    const lv = longValues[li];
    for (let ii = 0; ii < entriesPerLong && i < totalBlocks; ii++) {
      const bo = bitOffsets ? bitOffsets[ii] : BigInt(ii * bitsPerBlock);
      indices[i++] = Number((lv >> bo) & mask);
    }
  }
  return indices;
}

function decodeChunk(chunk, grid, registry, stateGrid, stateRegistry, lightGrid) {
  const chunkX = chunk.x;
  const chunkZ = chunk.z;
  const sections = chunk.data.sections || (chunk.data.Level?.Sections);
  if (!sections) return 0;
  
  let totalBlocks = 0;
  
  for (const section of sections) {
    const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
    const baseY = sectionY * S;
    if (baseY < MIN_Y || baseY >= MAX_Y) continue;
    
    const internalSY = sectionY - Math.floor(MIN_Y / S);
    
    // Decode block light and sky light if present
    const skyLightData = section.SkyLight || section.sky_light;
    const blockLightData = section.BlockLight || section.block_light;
    
    if ((skyLightData || blockLightData) && lightGrid) {
      lightGrid.hasMinecraftLightData = true;
      const lightSection = lightGrid._getOrCreateSection(chunkX, chunkZ, internalSY);
      
      if (skyLightData && skyLightData.length >= 2048) {
        for (let i = 0; i < 4096; i++) {
          const byteIdx = Math.floor(i / 2);
          const nibbleIdx = i % 2;
          const sky = nibbleIdx === 0 
            ? (skyLightData[byteIdx] & 0x0F)
            : ((skyLightData[byteIdx] >> 4) & 0x0F);
          lightSection[i] = (lightSection[i] & 0xF0) | sky;
        }
      }
      
      if (blockLightData && blockLightData.length >= 2048) {
        for (let i = 0; i < 4096; i++) {
          const byteIdx = Math.floor(i / 2);
          const nibbleIdx = i % 2;
          const block = nibbleIdx === 0 
            ? (blockLightData[byteIdx] & 0x0F)
            : ((blockLightData[byteIdx] >> 4) & 0x0F);
          lightSection[i] = (lightSection[i] & 0x0F) | (block << 4);
        }
      }
    }
    
    const blockStates = section.block_states;
    
    if (blockStates) {
      const palette = blockStates.palette;
      if (!palette || palette.length === 0) continue;
      
      // Pre-process palette
      const blockIds = new Uint16Array(palette.length);
      const stateIds = stateGrid ? new Uint16Array(palette.length) : null;
      const isAir = new Uint8Array(palette.length);
      const levels = new Int8Array(palette.length);
      const isWaterlogged = new Uint8Array(palette.length);
      
      for (let i = 0; i < palette.length; i++) {
        const entry = palette[i];
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        blockIds[i] = registry.getBlockId(name);
        isAir[i] = AIR_BLOCKS.has(name) || name.endsWith(':air') ? 1 : 0;
        
        // Register state if stateGrid and stateRegistry available
        if (stateGrid && stateRegistry && !isAir[i]) {
          const props = (typeof entry === 'object' && entry.Properties) ? entry.Properties : {};
          stateIds[i] = stateRegistry.register(name, props);
        }
        
        if (name.includes('water') || name.includes('lava')) {
          levels[i] = entry.Properties?.level !== undefined ? parseInt(entry.Properties.level, 10) || 0 : 0;
        } else {
          levels[i] = -1;
          if (typeof entry === 'object' && entry.Properties?.waterlogged === 'true') {
            isWaterlogged[i] = 1;
          } else if (UNDERWATER_BLOCKS.has(name)) {
            isWaterlogged[i] = 1;
          }
        }
      }
      
      const blockData = blockStates.data;
      const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSY);
      const stateSection = stateGrid ? stateGrid._getOrCreateSection(chunkX, chunkZ, internalSY) : null;
      
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        if (!isAir[0]) {
          const lv = isWaterlogged[0] ? 8 : (levels[0] >= 0 ? levels[0] : 0);
          const val = (blockIds[0] & 0x0FFF) | ((lv & 0xF) << 12);
          gridSection.fill(val);
          if (stateSection && stateIds) stateSection.fill(stateIds[0]);
          totalBlocks += S3;
          grid.totalBlocks += S3;
        }
        continue;
      }
      
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const indices = unpackBlockIndices(blockData, bitsPerBlock, S3);
      
      for (let i = 0; i < S3; i++) {
        const pi = indices[i];
        if (pi < palette.length && !isAir[pi]) {
          const lv = isWaterlogged[pi] ? 8 : (levels[pi] >= 0 ? levels[pi] : 0);
          gridSection[i] = (blockIds[pi] & 0x0FFF) | ((lv & 0xF) << 12);
          if (stateSection && stateIds) stateSection[i] = stateIds[pi];
          totalBlocks++;
          grid.totalBlocks++;
        }
      }
    }
  }
  
  return totalBlocks;
}

// ============================================================================
// Light Propagation (Simplified - uses Minecraft light data if available)
// ============================================================================

function propagateSkyLight(grid, lightGrid, registry) {
  // For now, just set sky light to 15 for all air blocks at max height
  // Full propagation would be expensive - rely on Minecraft's light data
  for (const [key, section] of grid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
    const lightSection = lightGrid._getOrCreateSection(chunkX, chunkZ, sectionY);
    
    for (let i = 0; i < S3; i++) {
      const bid = section[i] & BLOCK_ID_MASK;
      if (bid === 0) {
        // Air block - set full sky light
        lightSection[i] = (lightSection[i] & 0xF0) | 0x0F;
      }
    }
  }
}

// ============================================================================
// Greedy Mesher for Solid/Water/Lava/Glass
// ============================================================================

function buildGridMeshes(grid, registry, offset = { x: 0, y: 0, z: 0 }) {
  // Build lookup tables
  const isOpaque = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  const isFluid = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getInfo(id);
    if (info) {
      isOpaque[id] = info.isOpaque ? 1 : 0;
      colorR[id] = info.colorR;
      colorG[id] = info.colorG;
      colorB[id] = info.colorB;
      if (info.name?.includes('water')) isFluid[id] = 1;
      else if (info.name?.includes('lava')) isFluid[id] = 2;
      else if (info.name?.includes('glass') || info.name?.includes('ice') || info.name?.includes('leaves')) {
        isGlass[id] = 1;
      }
    }
  }
  
  // Arrays with initial capacity
  const INITIAL = 100000;
  let sPos = new Float32Array(INITIAL * 12);
  let sNorm = new Float32Array(INITIAL * 12);
  let sCol = new Float32Array(INITIAL * 12);
  let sIdx = new Uint32Array(INITIAL * 6);
  let sVC = 0, sIC = 0, sCap = INITIAL;
  
  let wPos = new Float32Array(50000 * 12);
  let wNorm = new Float32Array(50000 * 12);
  let wCol = new Float32Array(50000 * 12);
  let wIdx = new Uint32Array(50000 * 6);
  let wVC = 0, wIC = 0, wCap = 50000;
  
  let lPos = new Float32Array(5000 * 12);
  let lNorm = new Float32Array(5000 * 12);
  let lCol = new Float32Array(5000 * 12);
  let lIdx = new Uint32Array(5000 * 6);
  let lVC = 0, lIC = 0, lCap = 5000;
  
  let gPos = new Float32Array(20000 * 12);
  let gNorm = new Float32Array(20000 * 12);
  let gCol = new Float32Array(20000 * 12);
  let gIdx = new Uint32Array(20000 * 6);
  let gVC = 0, gIC = 0, gCap = 20000;
  
  function grow(type) {
    if (type === 's') {
      const nc = Math.floor(sCap * 1.5);
      const np = new Float32Array(nc * 12); np.set(sPos.subarray(0, sVC * 3)); sPos = np;
      const nn = new Float32Array(nc * 12); nn.set(sNorm.subarray(0, sVC * 3)); sNorm = nn;
      const nc2 = new Float32Array(nc * 12); nc2.set(sCol.subarray(0, sVC * 3)); sCol = nc2;
      const ni = new Uint32Array(nc * 6); ni.set(sIdx.subarray(0, sIC)); sIdx = ni;
      sCap = nc;
    } else if (type === 'w') {
      const nc = Math.floor(wCap * 1.5);
      const np = new Float32Array(nc * 12); np.set(wPos.subarray(0, wVC * 3)); wPos = np;
      const nn = new Float32Array(nc * 12); nn.set(wNorm.subarray(0, wVC * 3)); wNorm = nn;
      const nc2 = new Float32Array(nc * 12); nc2.set(wCol.subarray(0, wVC * 3)); wCol = nc2;
      const ni = new Uint32Array(nc * 6); ni.set(wIdx.subarray(0, wIC)); wIdx = ni;
      wCap = nc;
    } else if (type === 'l') {
      const nc = Math.floor(lCap * 1.5);
      const np = new Float32Array(nc * 12); np.set(lPos.subarray(0, lVC * 3)); lPos = np;
      const nn = new Float32Array(nc * 12); nn.set(lNorm.subarray(0, lVC * 3)); lNorm = nn;
      const nc2 = new Float32Array(nc * 12); nc2.set(lCol.subarray(0, lVC * 3)); lCol = nc2;
      const ni = new Uint32Array(nc * 6); ni.set(lIdx.subarray(0, lIC)); lIdx = ni;
      lCap = nc;
    } else if (type === 'g') {
      const nc = Math.floor(gCap * 1.5);
      const np = new Float32Array(nc * 12); np.set(gPos.subarray(0, gVC * 3)); gPos = np;
      const nn = new Float32Array(nc * 12); nn.set(gNorm.subarray(0, gVC * 3)); gNorm = nn;
      const nc2 = new Float32Array(nc * 12); nc2.set(gCol.subarray(0, gVC * 3)); gCol = nc2;
      const ni = new Uint32Array(nc * 6); ni.set(gIdx.subarray(0, gIC)); gIdx = ni;
      gCap = nc;
    }
  }
  
  const mask = new Uint16Array(S2);
  const visited = new Uint8Array(S2);
  const ox = offset.x, oy = offset.y, oz = offset.z;
  
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S, baseY = sectionToWorldY(sy), baseZ = cz * S;
    
    // Skip empty sections
    let nonAir = 0;
    for (let i = 0; i < S3; i++) if (section[i] !== 0) nonAir++;
    if (nonAir === 0) continue;
    
    // Get neighbors
    const secTop = grid.sections.get(makeSectionKey(cx, cz, sy + 1));
    const secBot = grid.sections.get(makeSectionKey(cx, cz, sy - 1));
    const secRight = grid.sections.get(makeSectionKey(cx + 1, cz, sy));
    const secLeft = grid.sections.get(makeSectionKey(cx - 1, cz, sy));
    const secFront = grid.sections.get(makeSectionKey(cx, cz + 1, sy));
    const secBack = grid.sections.get(makeSectionKey(cx, cz - 1, sy));
    
    // Face 0: Top (+Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      const sliceBase = ly * S2;
      
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isOpaque[bid]) continue;
        
        let nid = 0;
        if (ly < 15) nid = section[sliceBase + S2 + j] & BLOCK_ID_MASK;
        else if (secTop) nid = secTop[j] & BLOCK_ID_MASK;
        
        if (!isOpaque[nid]) { mask[j] = bid; hasFaces = true; }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++)
            for (let di = 0; di < w; di++)
              visited[(jj + dj) * S + ii + di] = 1;
          
          if (sVC / 4 + 1 > sCap) grow('s');
          
          const x = baseX + ii - ox, y = baseY + ly + 1 - oy, z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + h;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z + h;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;
          
          // Inline normals (+Y) and colors - avoid loop overhead
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          sNorm[pi] = 0; sNorm[pi+1] = 1; sNorm[pi+2] = 0;
          sNorm[pi+3] = 0; sNorm[pi+4] = 1; sNorm[pi+5] = 0;
          sNorm[pi+6] = 0; sNorm[pi+7] = 1; sNorm[pi+8] = 0;
          sNorm[pi+9] = 0; sNorm[pi+10] = 1; sNorm[pi+11] = 0;
          sCol[pi] = r; sCol[pi+1] = g; sCol[pi+2] = b;
          sCol[pi+3] = r; sCol[pi+4] = g; sCol[pi+5] = b;
          sCol[pi+6] = r; sCol[pi+7] = g; sCol[pi+8] = b;
          sCol[pi+9] = r; sCol[pi+10] = g; sCol[pi+11] = b;
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Face 1: Bottom (-Y) - similar pattern
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      const sliceBase = ly * S2;
      
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isOpaque[bid]) continue;
        
        let nid = 0;
        if (ly > 0) nid = section[sliceBase - S2 + j] & BLOCK_ID_MASK;
        else if (secBot) nid = secBot[15 * S2 + j] & BLOCK_ID_MASK;
        
        if (!isOpaque[nid]) { mask[j] = bid; hasFaces = true; }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1; while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
            }
            h++;
          }
          for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) visited[(jj + dj) * S + ii + di] = 1;
          
          if (sVC / 4 + 1 > sCap) grow('s');
          
          const x = baseX + ii - ox, y = baseY + ly - oy, z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z + h;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + h;
          
          // Inline normals (-Y) and colors
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          sNorm[pi] = 0; sNorm[pi+1] = -1; sNorm[pi+2] = 0;
          sNorm[pi+3] = 0; sNorm[pi+4] = -1; sNorm[pi+5] = 0;
          sNorm[pi+6] = 0; sNorm[pi+7] = -1; sNorm[pi+8] = 0;
          sNorm[pi+9] = 0; sNorm[pi+10] = -1; sNorm[pi+11] = 0;
          sCol[pi] = r; sCol[pi+1] = g; sCol[pi+2] = b;
          sCol[pi+3] = r; sCol[pi+4] = g; sCol[pi+5] = b;
          sCol[pi+6] = r; sCol[pi+7] = g; sCol[pi+8] = b;
          sCol[pi+9] = r; sCol[pi+10] = g; sCol[pi+11] = b;
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Face 2: Right (+X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lx < 15) nid = section[idx + 1] & BLOCK_ID_MASK;
          else if (secRight) nid = secRight[ly * S2 + lz * S] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid]) { mask[ly * S + lz] = bid; hasFaces = true; }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1; while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
            }
            h++;
          }
          for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) visited[(jj + dj) * S + ii + di] = 1;
          
          if (sVC / 4 + 1 > sCap) grow('s');
          
          const x = baseX + lx + 1 - ox, y = baseY + jj - oy, z = baseZ + ii - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y + h; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z + w;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + w;
          
          // Inline normals (+X) and colors
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          sNorm[pi] = 1; sNorm[pi+1] = 0; sNorm[pi+2] = 0;
          sNorm[pi+3] = 1; sNorm[pi+4] = 0; sNorm[pi+5] = 0;
          sNorm[pi+6] = 1; sNorm[pi+7] = 0; sNorm[pi+8] = 0;
          sNorm[pi+9] = 1; sNorm[pi+10] = 0; sNorm[pi+11] = 0;
          sCol[pi] = r; sCol[pi+1] = g; sCol[pi+2] = b;
          sCol[pi+3] = r; sCol[pi+4] = g; sCol[pi+5] = b;
          sCol[pi+6] = r; sCol[pi+7] = g; sCol[pi+8] = b;
          sCol[pi+9] = r; sCol[pi+10] = g; sCol[pi+11] = b;
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Face 3: Left (-X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lx > 0) nid = section[idx - 1] & BLOCK_ID_MASK;
          else if (secLeft) nid = secLeft[ly * S2 + lz * S + 15] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid]) { mask[ly * S + lz] = bid; hasFaces = true; }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1; while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
            }
            h++;
          }
          for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) visited[(jj + dj) * S + ii + di] = 1;
          
          if (sVC / 4 + 1 > sCap) grow('s');
          
          const x = baseX + lx - ox, y = baseY + jj - oy, z = baseZ + ii - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + w;
          sPos[pi+3] = x; sPos[pi+4] = y + h; sPos[pi+5] = z + w;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;
          
          // Inline normals (-X) and colors
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          sNorm[pi] = -1; sNorm[pi+1] = 0; sNorm[pi+2] = 0;
          sNorm[pi+3] = -1; sNorm[pi+4] = 0; sNorm[pi+5] = 0;
          sNorm[pi+6] = -1; sNorm[pi+7] = 0; sNorm[pi+8] = 0;
          sNorm[pi+9] = -1; sNorm[pi+10] = 0; sNorm[pi+11] = 0;
          sCol[pi] = r; sCol[pi+1] = g; sCol[pi+2] = b;
          sCol[pi+3] = r; sCol[pi+4] = g; sCol[pi+5] = b;
          sCol[pi+6] = r; sCol[pi+7] = g; sCol[pi+8] = b;
          sCol[pi+9] = r; sCol[pi+10] = g; sCol[pi+11] = b;
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Face 4: Front (+Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lz < 15) nid = section[idx + S] & BLOCK_ID_MASK;
          else if (secFront) nid = secFront[ly * S2 + lx] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid]) { mask[ly * S + lx] = bid; hasFaces = true; }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1; while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
            }
            h++;
          }
          for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) visited[(jj + dj) * S + ii + di] = 1;
          
          if (sVC / 4 + 1 > sCap) grow('s');
          
          const x = baseX + ii - ox, y = baseY + jj - oy, z = baseZ + lz + 1 - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + w; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y + h; sPos[pi+11] = z;
          
          // Inline normals (+Z) and colors
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          sNorm[pi] = 0; sNorm[pi+1] = 0; sNorm[pi+2] = 1;
          sNorm[pi+3] = 0; sNorm[pi+4] = 0; sNorm[pi+5] = 1;
          sNorm[pi+6] = 0; sNorm[pi+7] = 0; sNorm[pi+8] = 1;
          sNorm[pi+9] = 0; sNorm[pi+10] = 0; sNorm[pi+11] = 1;
          sCol[pi] = r; sCol[pi+1] = g; sCol[pi+2] = b;
          sCol[pi+3] = r; sCol[pi+4] = g; sCol[pi+5] = b;
          sCol[pi+6] = r; sCol[pi+7] = g; sCol[pi+8] = b;
          sCol[pi+9] = r; sCol[pi+10] = g; sCol[pi+11] = b;
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Face 5: Back (-Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lz > 0) nid = section[idx - S] & BLOCK_ID_MASK;
          else if (secBack) nid = secBack[ly * S2 + 15 * S + lx] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid]) { mask[ly * S + lx] = bid; hasFaces = true; }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1; while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
            }
            h++;
          }
          for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) visited[(jj + dj) * S + ii + di] = 1;
          
          if (sVC / 4 + 1 > sCap) grow('s');
          
          const x = baseX + ii - ox, y = baseY + jj - oy, z = baseZ + lz - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x + w; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x + w; sPos[pi+10] = y + h; sPos[pi+11] = z;
          
          // Inline normals (-Z) and colors
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          sNorm[pi] = 0; sNorm[pi+1] = 0; sNorm[pi+2] = -1;
          sNorm[pi+3] = 0; sNorm[pi+4] = 0; sNorm[pi+5] = -1;
          sNorm[pi+6] = 0; sNorm[pi+7] = 0; sNorm[pi+8] = -1;
          sNorm[pi+9] = 0; sNorm[pi+10] = 0; sNorm[pi+11] = -1;
          sCol[pi] = r; sCol[pi+1] = g; sCol[pi+2] = b;
          sCol[pi+3] = r; sCol[pi+4] = g; sCol[pi+5] = b;
          sCol[pi+6] = r; sCol[pi+7] = g; sCol[pi+8] = b;
          sCol[pi+9] = r; sCol[pi+10] = g; sCol[pi+11] = b;
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Water surfaces
    const waterBlockId = registry.getBlockId('minecraft:water');
    const topWater = new Map();
    
    for (let ly = 0; ly < S; ly++) {
      const sliceBase = ly * S2;
      const worldY = baseY + ly;
      
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = sliceBase + lz * S + lx;
          const value = section[idx];
          if (value === 0) continue;
          
          const bid = value & BLOCK_ID_MASK;
          const level = (value & LEVEL_MASK) >> LEVEL_SHIFT;
          const ft = isFluid[bid];
          const isWaterlogged = (ft === 0 && level === 8);
          
          if (ft === 1 || isWaterlogged) {
            const colKey = lx + lz * S;
            const h = isWaterlogged ? 0.875 : (level >= 8 ? 1.0 : (level > 0 ? Math.max(0.125, (14 - level * 1.5) / 16) : 0.875));
            const existing = topWater.get(colKey);
            if (!existing || worldY > existing.y) {
              topWater.set(colKey, { y: worldY, blockId: isWaterlogged ? waterBlockId : bid, height: h, lx, lz, ly });
            }
          }
        }
      }
    }
    
    // Build water mesh
    if (topWater.size > 0) {
      for (const [, data] of topWater) {
        if (data.ly === 15 && secTop) {
          const aboveValue = secTop[data.lz * S + data.lx];
          const aboveBid = aboveValue & BLOCK_ID_MASK;
          const aboveLevel = (aboveValue & LEVEL_MASK) >> LEVEL_SHIFT;
          if (isFluid[aboveBid] === 1 || (isFluid[aboveBid] === 0 && aboveLevel === 8)) continue;
        }
        
        if (wVC / 4 + 1 > wCap) grow('w');
        
        const x = baseX + data.lx - ox, y = data.y + data.height - oy, z = baseZ + data.lz - oz;
        const pi = wVC * 3;
        const sv = wVC;
        
        wPos[pi] = x; wPos[pi+1] = y; wPos[pi+2] = z + 1;
        wPos[pi+3] = x + 1; wPos[pi+4] = y; wPos[pi+5] = z + 1;
        wPos[pi+6] = x + 1; wPos[pi+7] = y; wPos[pi+8] = z;
        wPos[pi+9] = x; wPos[pi+10] = y; wPos[pi+11] = z;
        
        // Inline normals and colors for water
        const col = registry.getColor(data.blockId);
        wNorm[pi] = 0; wNorm[pi+1] = 1; wNorm[pi+2] = 0;
        wNorm[pi+3] = 0; wNorm[pi+4] = 1; wNorm[pi+5] = 0;
        wNorm[pi+6] = 0; wNorm[pi+7] = 1; wNorm[pi+8] = 0;
        wNorm[pi+9] = 0; wNorm[pi+10] = 1; wNorm[pi+11] = 0;
        wCol[pi] = col.r; wCol[pi+1] = col.g; wCol[pi+2] = col.b;
        wCol[pi+3] = col.r; wCol[pi+4] = col.g; wCol[pi+5] = col.b;
        wCol[pi+6] = col.r; wCol[pi+7] = col.g; wCol[pi+8] = col.b;
        wCol[pi+9] = col.r; wCol[pi+10] = col.g; wCol[pi+11] = col.b;
        
        wIdx[wIC++] = sv; wIdx[wIC++] = sv + 1; wIdx[wIC++] = sv + 2;
        wIdx[wIC++] = sv; wIdx[wIC++] = sv + 2; wIdx[wIC++] = sv + 3;
        wVC += 4;
      }
    }
  }
  
  // Trim and return
  const trim = (pos, norm, col, idx, vc, ic) => {
    if (vc === 0) return null;
    return {
      positions: pos.subarray(0, vc * 3),
      normals: norm.subarray(0, vc * 3),
      colors: col.subarray(0, vc * 3),
      indices: idx.subarray(0, ic),
      vertexCount: vc,
      triangleCount: ic / 3,
    };
  };
  
  return {
    solid: trim(sPos, sNorm, sCol, sIdx, sVC, sIC),
    water: trim(wPos, wNorm, wCol, wIdx, wVC, wIC),
    lava: trim(lPos, lNorm, lCol, lIdx, lVC, lIC),
    glass: trim(gPos, gNorm, gCol, gIdx, gVC, gIC),
  };
}

// ============================================================================
// Model Mesher (Using pre-computed geometry from StateRegistry)
// Optimized with pre-allocated TypedArrays for performance
// ============================================================================

// Initial buffer sizes - will grow if needed
const MODEL_INITIAL_VERTS = 20000;

function buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset = { x: 0, y: 0, z: 0 }) {
  if (!stateGrid || !stateRegistry) return null;
  
  // Pre-allocated TypedArrays for opaque geometry
  let oCap = MODEL_INITIAL_VERTS;
  let oPos = new Float32Array(oCap * 3);
  let oNorm = new Float32Array(oCap * 3);
  let oCol = new Float32Array(oCap * 3);
  let oUv = new Float32Array(oCap * 2);
  let oIdx = new Uint32Array(oCap * 2); // Rough estimate: ~1.5 indices per vertex
  let oPosIdx = 0, oNormIdx = 0, oColIdx = 0, oUvIdx = 0, oIdxIdx = 0;
  let oVC = 0;
  
  // Pre-allocated TypedArrays for transparent geometry
  let tCap = MODEL_INITIAL_VERTS / 4; // Typically less transparent geometry
  let tPos = new Float32Array(tCap * 3);
  let tNorm = new Float32Array(tCap * 3);
  let tCol = new Float32Array(tCap * 3);
  let tUv = new Float32Array(tCap * 2);
  let tIdx = new Uint32Array(tCap * 2);
  let tPosIdx = 0, tNormIdx = 0, tColIdx = 0, tUvIdx = 0, tIdxIdx = 0;
  let tVC = 0;
  
  // Grow functions
  function growOpaque(neededVerts) {
    const newCap = Math.max(oCap * 2, oCap + neededVerts);
    const newPos = new Float32Array(newCap * 3); newPos.set(oPos.subarray(0, oPosIdx)); oPos = newPos;
    const newNorm = new Float32Array(newCap * 3); newNorm.set(oNorm.subarray(0, oNormIdx)); oNorm = newNorm;
    const newCol = new Float32Array(newCap * 3); newCol.set(oCol.subarray(0, oColIdx)); oCol = newCol;
    const newUv = new Float32Array(newCap * 2); newUv.set(oUv.subarray(0, oUvIdx)); oUv = newUv;
    const newIdx = new Uint32Array(newCap * 2); newIdx.set(oIdx.subarray(0, oIdxIdx)); oIdx = newIdx;
    oCap = newCap;
  }
  
  function growTransparent(neededVerts) {
    const newCap = Math.max(tCap * 2, tCap + neededVerts);
    const newPos = new Float32Array(newCap * 3); newPos.set(tPos.subarray(0, tPosIdx)); tPos = newPos;
    const newNorm = new Float32Array(newCap * 3); newNorm.set(tNorm.subarray(0, tNormIdx)); tNorm = newNorm;
    const newCol = new Float32Array(newCap * 3); newCol.set(tCol.subarray(0, tColIdx)); tCol = newCol;
    const newUv = new Float32Array(newCap * 2); newUv.set(tUv.subarray(0, tUvIdx)); tUv = newUv;
    const newIdx = new Uint32Array(newCap * 2); newIdx.set(tIdx.subarray(0, tIdxIdx)); tIdx = newIdx;
    tCap = newCap;
  }
  
  const ox = offset.x, oy = offset.y, oz = offset.z;
  
  for (const [key, stateSection] of stateGrid.sections) {
    const gridSection = grid.sections.get(key);
    if (!gridSection) continue;
    
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S, baseY = sectionToWorldY(sy), baseZ = cz * S;
    
    for (let ly = 0; ly < S; ly++) {
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const stateId = stateSection[idx];
          if (stateId === 0) continue;
          
          const state = stateRegistry.getState(stateId);
          if (!state || !state.geometry || state.geometry.length === 0) continue;
          
          const worldX = baseX + lx - ox;
          const worldY = baseY + ly - oy;
          const worldZ = baseZ + lz - oz;
          
          // Add geometry for each variant
          for (const geom of state.geometry) {
            const gPositions = geom.positions;
            if (!gPositions || gPositions.length === 0) continue;
            
            const numVerts = gPositions.length / 3;
            const numIndices = geom.indices ? geom.indices.length : 0;
            const isTransparent = geom.isTransparent;
            
            if (isTransparent) {
              // Check capacity and grow if needed
              if (tVC + numVerts > tCap) growTransparent(numVerts);
              
              const baseVertex = tVC;
              const gNormals = geom.normals;
              const gColors = geom.colors;
              const gUvs = geom.uvs;
              const gIndices = geom.indices;
              
              // Copy positions with offset (direct assignment)
              for (let v = 0; v < numVerts; v++) {
                const v3 = v * 3;
                tPos[tPosIdx++] = gPositions[v3] + worldX;
                tPos[tPosIdx++] = gPositions[v3 + 1] + worldY;
                tPos[tPosIdx++] = gPositions[v3 + 2] + worldZ;
              }
              
              // Copy normals
              if (gNormals) {
                for (let v = 0; v < numVerts; v++) {
                  const v3 = v * 3;
                  tNorm[tNormIdx++] = gNormals[v3];
                  tNorm[tNormIdx++] = gNormals[v3 + 1];
                  tNorm[tNormIdx++] = gNormals[v3 + 2];
                }
              } else {
                for (let v = 0; v < numVerts; v++) {
                  tNorm[tNormIdx++] = 0;
                  tNorm[tNormIdx++] = 1;
                  tNorm[tNormIdx++] = 0;
                }
              }
              
              // Copy colors
              if (gColors) {
                for (let v = 0; v < numVerts; v++) {
                  const v3 = v * 3;
                  tCol[tColIdx++] = gColors[v3];
                  tCol[tColIdx++] = gColors[v3 + 1];
                  tCol[tColIdx++] = gColors[v3 + 2];
                }
              } else {
                const col = registry.getColor(gridSection[idx] & BLOCK_ID_MASK);
                for (let v = 0; v < numVerts; v++) {
                  tCol[tColIdx++] = col.r;
                  tCol[tColIdx++] = col.g;
                  tCol[tColIdx++] = col.b;
                }
              }
              
              // Copy UVs
              if (gUvs) {
                for (let v = 0; v < numVerts; v++) {
                  tUv[tUvIdx++] = gUvs[v * 2];
                  tUv[tUvIdx++] = gUvs[v * 2 + 1];
                }
              } else {
                for (let v = 0; v < numVerts; v++) {
                  tUv[tUvIdx++] = 0;
                  tUv[tUvIdx++] = 0;
                }
              }
              
              // Copy indices with base vertex offset
              if (gIndices) {
                for (let i = 0; i < numIndices; i++) {
                  tIdx[tIdxIdx++] = gIndices[i] + baseVertex;
                }
              }
              
              tVC += numVerts;
            } else {
              // OPAQUE path
              if (oVC + numVerts > oCap) growOpaque(numVerts);
              
              const baseVertex = oVC;
              const gNormals = geom.normals;
              const gColors = geom.colors;
              const gUvs = geom.uvs;
              const gIndices = geom.indices;
              
              // Copy positions with offset
              for (let v = 0; v < numVerts; v++) {
                const v3 = v * 3;
                oPos[oPosIdx++] = gPositions[v3] + worldX;
                oPos[oPosIdx++] = gPositions[v3 + 1] + worldY;
                oPos[oPosIdx++] = gPositions[v3 + 2] + worldZ;
              }
              
              // Copy normals
              if (gNormals) {
                for (let v = 0; v < numVerts; v++) {
                  const v3 = v * 3;
                  oNorm[oNormIdx++] = gNormals[v3];
                  oNorm[oNormIdx++] = gNormals[v3 + 1];
                  oNorm[oNormIdx++] = gNormals[v3 + 2];
                }
              } else {
                for (let v = 0; v < numVerts; v++) {
                  oNorm[oNormIdx++] = 0;
                  oNorm[oNormIdx++] = 1;
                  oNorm[oNormIdx++] = 0;
                }
              }
              
              // Copy colors
              if (gColors) {
                for (let v = 0; v < numVerts; v++) {
                  const v3 = v * 3;
                  oCol[oColIdx++] = gColors[v3];
                  oCol[oColIdx++] = gColors[v3 + 1];
                  oCol[oColIdx++] = gColors[v3 + 2];
                }
              } else {
                const col = registry.getColor(gridSection[idx] & BLOCK_ID_MASK);
                for (let v = 0; v < numVerts; v++) {
                  oCol[oColIdx++] = col.r;
                  oCol[oColIdx++] = col.g;
                  oCol[oColIdx++] = col.b;
                }
              }
              
              // Copy UVs
              if (gUvs) {
                for (let v = 0; v < numVerts; v++) {
                  oUv[oUvIdx++] = gUvs[v * 2];
                  oUv[oUvIdx++] = gUvs[v * 2 + 1];
                }
              } else {
                for (let v = 0; v < numVerts; v++) {
                  oUv[oUvIdx++] = 0;
                  oUv[oUvIdx++] = 0;
                }
              }
              
              // Copy indices with base vertex offset
              if (gIndices) {
                for (let i = 0; i < numIndices; i++) {
                  oIdx[oIdxIdx++] = gIndices[i] + baseVertex;
                }
              }
              
              oVC += numVerts;
            }
          }
        }
      }
    }
  }
  
  const result = {};
  
  if (oVC > 0) {
    result.opaque = {
      positions: oPos.subarray(0, oPosIdx),
      normals: oNorm.subarray(0, oNormIdx),
      colors: oCol.subarray(0, oColIdx),
      uvs: oUv.subarray(0, oUvIdx),
      indices: oIdx.subarray(0, oIdxIdx),
      vertexCount: oVC,
      triangleCount: oIdxIdx / 3,
    };
  }
  
  if (tVC > 0) {
    result.transparent = {
      positions: tPos.subarray(0, tPosIdx),
      normals: tNorm.subarray(0, tNormIdx),
      colors: tCol.subarray(0, tColIdx),
      uvs: tUv.subarray(0, tUvIdx),
      indices: tIdx.subarray(0, tIdxIdx),
      vertexCount: tVC,
      triangleCount: tIdxIdx / 3,
    };
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

// ============================================================================
// Super-Chunk Processing
// ============================================================================

async function processSuperChunk(data) {
  const { chunks, neighbors, bounds } = data;
  const startTime = performance.now();
  
  const grid = new WorkerBinaryGrid();
  const stateGrid = new WorkerBlockStateGrid();
  const lightGrid = new WorkerLightGrid();
  
  const decodedChunks = [];
  
  // Decompress and decode all main chunks in parallel for speed
  const chunkPromises = chunks.map(async (chunkData) => {
    try {
      const decompressed = await decompressChunk(
        new Uint8Array(chunkData.compressedData),
        chunkData.compressionType
      );
      const nbt = parseNBT(decompressed.buffer);
      return {
        x: chunkData.chunkX,
        z: chunkData.chunkZ,
        data: nbt,
      };
    } catch (e) {
      console.warn(`[SuperChunkWorker] Failed to decode chunk ${chunkData.chunkX},${chunkData.chunkZ}:`, e.message);
      return null;
    }
  });
  
  const chunkResults = await Promise.all(chunkPromises);
  
  // Decode all chunks to grid
  for (const chunk of chunkResults) {
    if (chunk) {
      decodedChunks.push(chunk);
      decodeChunk(chunk, grid, blockRegistry, stateGrid, stateRegistry, lightGrid);
    }
  }
  
  // Determine which neighbors we actually need based on loaded chunk positions
  // Only decompress neighbors adjacent to our actual chunk boundaries
  if (neighbors && neighbors.length > 0 && decodedChunks.length > 0) {
    // Build set of loaded chunk positions
    const loadedChunks = new Set(decodedChunks.map(c => `${c.x},${c.z}`));
    
    // Find min/max chunk coordinates
    let minCX = Infinity, maxCX = -Infinity;
    let minCZ = Infinity, maxCZ = -Infinity;
    for (const c of decodedChunks) {
      minCX = Math.min(minCX, c.x);
      maxCX = Math.max(maxCX, c.x);
      minCZ = Math.min(minCZ, c.z);
      maxCZ = Math.max(maxCZ, c.z);
    }
    
    // Filter neighbors to only those adjacent to boundary
    const relevantNeighbors = neighbors.filter(n => {
      const cx = n.chunkX, cz = n.chunkZ;
      // Only include if adjacent to our chunk area
      const isAdjacent = (
        (cx === minCX - 1 || cx === maxCX + 1) && cz >= minCZ && cz <= maxCZ ||
        (cz === minCZ - 1 || cz === maxCZ + 1) && cx >= minCX && cx <= maxCX
      );
      return isAdjacent && !loadedChunks.has(`${cx},${cz}`);
    });
    
    // Decompress relevant neighbors in parallel
    if (relevantNeighbors.length > 0) {
      const neighborPromises = relevantNeighbors.map(async (neighborData) => {
        try {
          const decompressed = await decompressChunk(
            new Uint8Array(neighborData.compressedData),
            neighborData.compressionType
          );
          const nbt = parseNBT(decompressed.buffer);
          return {
            x: neighborData.chunkX,
            z: neighborData.chunkZ,
            data: nbt,
          };
        } catch {
          return null;
        }
      });
      
      const neighborResults = await Promise.all(neighborPromises);
      
      for (const chunk of neighborResults) {
        if (chunk) {
          decodeChunk(chunk, grid, blockRegistry, stateGrid, stateRegistry, lightGrid);
        }
      }
    }
  }
  
  // Propagate light if no Minecraft light data
  if (!lightGrid.hasMinecraftLightData) {
    propagateSkyLight(grid, lightGrid, blockRegistry);
  }
  
  const decodeTime = performance.now() - startTime;
  
  // Build meshes
  const meshStart = performance.now();
  const offset = { x: 0, y: 0, z: 0 };
  const gridMeshes = buildGridMeshes(grid, blockRegistry, offset);
  const modelMeshes = buildModelMeshes(grid, stateGrid, blockRegistry, stateRegistry, offset);
  const meshTime = performance.now() - meshStart;
  
  // Collect transferables
  const transferables = [];
  const result = {
    solid: null,
    water: null,
    lava: null,
    glass: null,
    models: null,
  };
  
  // Add grid meshes
  if (gridMeshes.solid) {
    result.solid = {
      positions: gridMeshes.solid.positions,
      normals: gridMeshes.solid.normals,
      colors: gridMeshes.solid.colors,
      indices: gridMeshes.solid.indices,
      vertexCount: gridMeshes.solid.vertexCount,
      triangleCount: gridMeshes.solid.triangleCount,
    };
    transferables.push(
      gridMeshes.solid.positions.buffer,
      gridMeshes.solid.normals.buffer,
      gridMeshes.solid.colors.buffer,
      gridMeshes.solid.indices.buffer
    );
  }
  
  if (gridMeshes.water) {
    result.water = {
      positions: gridMeshes.water.positions,
      normals: gridMeshes.water.normals,
      colors: gridMeshes.water.colors,
      indices: gridMeshes.water.indices,
      vertexCount: gridMeshes.water.vertexCount,
      triangleCount: gridMeshes.water.triangleCount,
    };
    transferables.push(
      gridMeshes.water.positions.buffer,
      gridMeshes.water.normals.buffer,
      gridMeshes.water.colors.buffer,
      gridMeshes.water.indices.buffer
    );
  }
  
  if (gridMeshes.lava) {
    result.lava = {
      positions: gridMeshes.lava.positions,
      normals: gridMeshes.lava.normals,
      colors: gridMeshes.lava.colors,
      indices: gridMeshes.lava.indices,
      vertexCount: gridMeshes.lava.vertexCount,
      triangleCount: gridMeshes.lava.triangleCount,
    };
    transferables.push(
      gridMeshes.lava.positions.buffer,
      gridMeshes.lava.normals.buffer,
      gridMeshes.lava.colors.buffer,
      gridMeshes.lava.indices.buffer
    );
  }
  
  if (gridMeshes.glass) {
    result.glass = {
      positions: gridMeshes.glass.positions,
      normals: gridMeshes.glass.normals,
      colors: gridMeshes.glass.colors,
      indices: gridMeshes.glass.indices,
      vertexCount: gridMeshes.glass.vertexCount,
      triangleCount: gridMeshes.glass.triangleCount,
    };
    transferables.push(
      gridMeshes.glass.positions.buffer,
      gridMeshes.glass.normals.buffer,
      gridMeshes.glass.colors.buffer,
      gridMeshes.glass.indices.buffer
    );
  }
  
  // Add model meshes
  if (modelMeshes) {
    result.models = {};
    
    if (modelMeshes.opaque) {
      result.models.opaque = {
        positions: modelMeshes.opaque.positions,
        normals: modelMeshes.opaque.normals,
        colors: modelMeshes.opaque.colors,
        uvs: modelMeshes.opaque.uvs,
        indices: modelMeshes.opaque.indices,
        vertexCount: modelMeshes.opaque.vertexCount,
        triangleCount: modelMeshes.opaque.triangleCount,
      };
      transferables.push(
        modelMeshes.opaque.positions.buffer,
        modelMeshes.opaque.normals.buffer,
        modelMeshes.opaque.colors.buffer,
        modelMeshes.opaque.uvs.buffer,
        modelMeshes.opaque.indices.buffer
      );
    }
    
    if (modelMeshes.transparent) {
      result.models.transparent = {
        positions: modelMeshes.transparent.positions,
        normals: modelMeshes.transparent.normals,
        colors: modelMeshes.transparent.colors,
        uvs: modelMeshes.transparent.uvs,
        indices: modelMeshes.transparent.indices,
        vertexCount: modelMeshes.transparent.vertexCount,
        triangleCount: modelMeshes.transparent.triangleCount,
      };
      transferables.push(
        modelMeshes.transparent.positions.buffer,
        modelMeshes.transparent.normals.buffer,
        modelMeshes.transparent.colors.buffer,
        modelMeshes.transparent.uvs.buffer,
        modelMeshes.transparent.indices.buffer
      );
    }
  }
  
  const totalTime = performance.now() - startTime;
  
  return {
    result,
    transferables,
    stats: {
      chunksProcessed: decodedChunks.length,
      totalBlocks: grid.totalBlocks,
      decodeTimeMs: decodeTime,
      meshTimeMs: meshTime,
      totalTimeMs: totalTime,
    },
  };
}

// ============================================================================
// Worker Message Handler
// ============================================================================

self.onmessage = async function(e) {
  const { type, id, data } = e.data;
  
  switch (type) {
    case 'init': {
      // Initialize with registry data from main thread
      blockRegistry = new WorkerBlockRegistry();
      stateRegistry = new WorkerStateRegistry();
      
      if (data.blockRegistry) {
        blockRegistry.importFromData(data.blockRegistry);
      }
      
      if (data.stateRegistry) {
        stateRegistry.importFromData(data.stateRegistry);
      }
      
      textureIndexLookup = data.textureIndexLookup || null;
      tintTypeLookup = data.tintTypeLookup || null;
      
      workerInitialized = true;
      
      self.postMessage({ type: 'ready', id });
      break;
    }
    
    case 'process': {
      if (!workerInitialized) {
        self.postMessage({
          type: 'error',
          id,
          error: 'Worker not initialized',
        });
        return;
      }
      
      try {
        const { result, transferables, stats } = await processSuperChunk(data);
        
        self.postMessage({
          type: 'complete',
          id,
          result,
          stats,
        }, transferables);
      } catch (error) {
        self.postMessage({
          type: 'error',
          id,
          error: error.message || String(error),
        });
      }
      break;
    }
    
    case 'updateRegistry': {
      // Update registry with new data (e.g., when new block types are encountered)
      if (data.blockRegistry) {
        blockRegistry.importFromData(data.blockRegistry);
      }
      if (data.stateRegistry) {
        stateRegistry.importFromData(data.stateRegistry);
      }
      self.postMessage({ type: 'registryUpdated', id });
      break;
    }
  }
};

