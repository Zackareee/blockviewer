/**
 * RegionWorker - Unified Parse → Decode → Mesh Worker
 * 
 * Handles the entire region processing pipeline in a single worker to avoid
 * main thread blocking. Returns transferable mesh buffers for direct GPU upload.
 * 
 * This is the most efficient approach for loading hundreds of regions because:
 * 1. No main thread blocking during parsing/meshing
 * 2. Transferable buffers avoid memory copies
 * 3. Single worker context avoids repeated initialization
 */

import pako from 'pako';

// ============================================================================
// NBT Parser (embedded to run in worker context)
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
    this.readString(); // name
    return this.readCompound();
  }
}

// ============================================================================
// MCA Parser
// ============================================================================

const SECTOR_SIZE = 4096;
const CHUNKS_PER_REGION = 32;

function parseMCABuffer(buffer) {
  const view = new DataView(buffer);
  const chunks = [];

  for (let z = 0; z < CHUNKS_PER_REGION; z++) {
    for (let x = 0; x < CHUNKS_PER_REGION; x++) {
      const index = x + z * CHUNKS_PER_REGION;
      const locationData = view.getUint32(index * 4, false);
      const offset = (locationData >> 8) * SECTOR_SIZE;
      const sectorCount = locationData & 0xFF;

      if (offset === 0 || sectorCount === 0) continue;

      try {
        const length = view.getUint32(offset, false);
        const compressionType = view.getUint8(offset + 4);
        const compressedData = new Uint8Array(buffer, offset + 5, length - 1);
        
        let decompressedData;
        if (compressionType === 1) {
          decompressedData = pako.ungzip(compressedData);
        } else if (compressionType === 2) {
          decompressedData = pako.inflate(compressedData);
        } else {
          continue;
        }

        const reader = new NBTReader(decompressedData.buffer);
        chunks.push({ x, z, data: reader.parse() });
      } catch (e) {
        // Skip failed chunks
      }
    }
  }

  return chunks;
}

// ============================================================================
// Block Registry (using comprehensive color map)
// ============================================================================

// Import comprehensive block colors
import { getBlockColorsNumeric, COLOR_PATTERNS_NUMERIC } from '../../data/blockColors.js';

// Load the comprehensive color map (1166 blocks)
const BLOCK_COLORS = getBlockColorsNumeric();

// Convert pattern format for worker usage
const COLOR_PATTERNS = COLOR_PATTERNS_NUMERIC.map(({ pattern, color }) => [pattern, color]);

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

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
    
    let color = BLOCK_COLORS[short];
    if (!color) {
      for (const [pattern, c] of COLOR_PATTERNS) {
        if (short.includes(pattern)) { color = c; break; }
      }
    }
    if (!color) color = 0x707070;
    
    return this._register(name, color, isOpaque, isFluid);
  }
  
  getInfo(id) { return this.idToInfo[id]; }
  isOpaque(id) { return this.idToInfo[id]?.isOpaque || false; }
  isFluid(id) { return this.idToInfo[id]?.isFluid || false; }
  isWater(id) { return this.idToInfo[id]?.name?.includes('water') || false; }
  isLava(id) { return this.idToInfo[id]?.name?.includes('lava') || false; }
  getColor(id) {
    const info = this.idToInfo[id];
    return info ? { r: info.colorR, g: info.colorG, b: info.colorB } : { r: 0.44, g: 0.44, b: 0.44 };
  }
}

// ============================================================================
// Binary Grid
// ============================================================================

const S = 16, S2 = 256, S3 = 4096;
const BLOCK_ID_MASK = 0x0FFF, LEVEL_MASK = 0xF000, LEVEL_SHIFT = 12;
const MIN_Y = -64;

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
  
  getBounds() {
    if (this.sections.size === 0) return null;
    return {
      minX: this.minChunkX * S, maxX: (this.maxChunkX + 1) * S - 1,
      minY: sectionToWorldY(this.minSectionY), maxY: sectionToWorldY(this.maxSectionY + 1) - 1,
      minZ: this.minChunkZ * S, maxZ: (this.maxChunkZ + 1) * S - 1,
    };
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
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const entriesPerLong = Math.floor(64 / bitsPerBlock);
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

function decodeChunk(chunk, grid, registry, regionX, regionZ) {
  const chunkX = chunk.x + regionX * 32;
  const chunkZ = chunk.z + regionZ * 32;
  const sections = chunk.data.sections || (chunk.data.Level?.Sections);
  if (!sections) return 0;
  
  let totalBlocks = 0;
  
  for (const section of sections) {
    const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
    const baseY = sectionY * S;
    if (baseY < MIN_Y || baseY > 320) continue;
    
    const internalSY = sectionY - Math.floor(MIN_Y / S);
    const blockStates = section.block_states;
    
    if (blockStates) {
      const palette = blockStates.palette;
      if (!palette || palette.length === 0) continue;
      
      // Pre-process palette
      const blockIds = new Uint16Array(palette.length);
      const isAir = new Uint8Array(palette.length);
      const levels = new Int8Array(palette.length);
      
      for (let i = 0; i < palette.length; i++) {
        const entry = palette[i];
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        blockIds[i] = registry.getBlockId(name);
        isAir[i] = AIR_BLOCKS.has(name) || name.endsWith(':air') ? 1 : 0;
        
        if (name.includes('water') || name.includes('lava')) {
          levels[i] = entry.Properties?.level !== undefined ? parseInt(entry.Properties.level, 10) || 0 : 0;
        } else {
          levels[i] = -1;
        }
      }
      
      const blockData = blockStates.data;
      const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSY);
      
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        if (!isAir[0]) {
          const val = (blockIds[0] & 0x0FFF) | (((levels[0] >= 0 ? levels[0] : 0) & 0xF) << 12);
          gridSection.fill(val);
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
          const lv = levels[pi] >= 0 ? levels[pi] : 0;
          gridSection[i] = (blockIds[pi] & 0x0FFF) | ((lv & 0xF) << 12);
          totalBlocks++;
          grid.totalBlocks++;
        }
      }
    } else if (section.Palette && section.BlockStates) {
      // Legacy format - similar processing
      const palette = section.Palette;
      if (palette.length === 0) continue;
      
      const blockIds = new Uint16Array(palette.length);
      const isAir = new Uint8Array(palette.length);
      
      for (let i = 0; i < palette.length; i++) {
        const entry = palette[i];
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        blockIds[i] = registry.getBlockId(name);
        isAir[i] = AIR_BLOCKS.has(name) || name.endsWith(':air') ? 1 : 0;
      }
      
      const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSY);
      
      if (palette.length === 1) {
        if (!isAir[0]) {
          gridSection.fill(blockIds[0] & 0x0FFF);
          totalBlocks += S3;
          grid.totalBlocks += S3;
        }
        continue;
      }
      
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const indices = unpackBlockIndices(section.BlockStates, bitsPerBlock, S3);
      
      for (let i = 0; i < S3; i++) {
        const pi = indices[i];
        if (pi < palette.length && !isAir[pi]) {
          gridSection[i] = blockIds[pi] & 0x0FFF;
          totalBlocks++;
          grid.totalBlocks++;
        }
      }
    }
  }
  
  return totalBlocks;
}

// ============================================================================
// Greedy Mesher
// ============================================================================

function buildMeshes(grid, registry, offset = { x: 0, y: 64, z: 0 }) {
  // Build lookup tables
  const isOpaque = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  const isFluid = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getInfo(id);
    if (info) {
      isOpaque[id] = info.isOpaque ? 1 : 0;
      colorR[id] = info.colorR;
      colorG[id] = info.colorG;
      colorB[id] = info.colorB;
      if (info.name?.includes('water')) isFluid[id] = 1;
      else if (info.name?.includes('lava')) isFluid[id] = 2;
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
    } else {
      const nc = Math.floor(lCap * 1.5);
      const np = new Float32Array(nc * 12); np.set(lPos.subarray(0, lVC * 3)); lPos = np;
      const nn = new Float32Array(nc * 12); nn.set(lNorm.subarray(0, lVC * 3)); lNorm = nn;
      const nc2 = new Float32Array(nc * 12); nc2.set(lCol.subarray(0, lVC * 3)); lCol = nc2;
      const ni = new Uint32Array(nc * 6); ni.set(lIdx.subarray(0, lIC)); lIdx = ni;
      lCap = nc;
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
    
    // Process all 6 faces with greedy meshing
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
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Face 1: Bottom (-Y)
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
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = -1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
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
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
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
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = -1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
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
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
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
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = -1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Fluids - top surface only with greedy meshing
    const topWater = new Map();
    const topLava = new Map();
    
    for (let ly = 0; ly < S; ly++) {
      const sliceBase = ly * S2;
      const worldY = baseY + ly;
      
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = sliceBase + lz * S + lx;
          const value = section[idx];
          if (value === 0) continue;
          
          const bid = value & BLOCK_ID_MASK;
          const ft = isFluid[bid];
          if (ft === 0) continue;
          
          const colKey = lx + lz * S;
          const level = (value & LEVEL_MASK) >> LEVEL_SHIFT;
          const h = level >= 8 ? 1.0 : (level > 0 ? Math.max(0.125, (14 - level * 1.5) / 16) : 0.875);
          
          if (ft === 1) {
            const existing = topWater.get(colKey);
            if (!existing || worldY > existing.y) {
              topWater.set(colKey, { y: worldY, ly, blockId: bid, height: h, lx, lz });
            }
          } else {
            const existing = topLava.get(colKey);
            if (!existing || worldY > existing.y) {
              topLava.set(colKey, { y: worldY, ly, blockId: bid, height: h, lx, lz });
            }
          }
        }
      }
    }
    
    // Check if topmost fluids are covered
    if (secTop) {
      for (const [colKey, data] of topWater) {
        if (data.ly === 15) {
          const aboveBid = secTop[data.lz * S + data.lx] & BLOCK_ID_MASK;
          if (isFluid[aboveBid] === 1) topWater.delete(colKey);
        }
      }
      for (const [colKey, data] of topLava) {
        if (data.ly === 15) {
          const aboveBid = secTop[data.lz * S + data.lx] & BLOCK_ID_MASK;
          if (isFluid[aboveBid] === 2) topLava.delete(colKey);
        }
      }
    }
    
    // Build water surface
    if (topWater.size > 0) {
      const fluidMask = new Uint16Array(S2);
      const fluidHeights = new Float32Array(S2);
      const fluidY = new Float32Array(S2);
      
      for (const [colKey, data] of topWater) {
        const hb = Math.floor(data.height * 7.99);
        fluidMask[colKey] = (hb << 12) | data.blockId;
        fluidHeights[colKey] = data.height;
        fluidY[colKey] = data.y;
      }
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || fluidMask[mi] === 0) continue;
          
          const bid = fluidMask[mi] & 0xFFF;
          const h = fluidHeights[mi];
          const y = fluidY[mi];
          const hb = (fluidMask[mi] >> 12) & 0xF;
          
          let w = 1;
          while (ii + w < S && !visited[mi + w] && fluidMask[mi + w] !== 0) {
            if (((fluidMask[mi + w] >> 12) & 0xF) !== hb || fluidY[mi + w] !== y) break;
            w++;
          }
          
          let d = 1;
          outer: while (jj + d < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + d) * S + ii + k;
              if (visited[ci] || fluidMask[ci] === 0) break outer;
              if (((fluidMask[ci] >> 12) & 0xF) !== hb || fluidY[ci] !== y) break outer;
            }
            d++;
          }
          
          for (let dj = 0; dj < d; dj++) for (let di = 0; di < w; di++) visited[(jj + dj) * S + ii + di] = 1;
          
          if (wVC / 4 + 1 > wCap) grow('w');
          
          const x = baseX + ii - ox, wy = y - oy, z = baseZ + jj - oz;
          const pi = wVC * 3;
          const sv = wVC;
          
          wPos[pi] = x; wPos[pi+1] = wy + h; wPos[pi+2] = z + d;
          wPos[pi+3] = x + w; wPos[pi+4] = wy + h; wPos[pi+5] = z + d;
          wPos[pi+6] = x + w; wPos[pi+7] = wy + h; wPos[pi+8] = z;
          wPos[pi+9] = x; wPos[pi+10] = wy + h; wPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            wNorm[pi + v*3] = 0; wNorm[pi + v*3 + 1] = 1; wNorm[pi + v*3 + 2] = 0;
            wCol[pi + v*3] = r; wCol[pi + v*3 + 1] = g; wCol[pi + v*3 + 2] = b;
          }
          
          wIdx[wIC++] = sv; wIdx[wIC++] = sv + 1; wIdx[wIC++] = sv + 2;
          wIdx[wIC++] = sv; wIdx[wIC++] = sv + 2; wIdx[wIC++] = sv + 3;
          wVC += 4;
        }
      }
    }
    
    // Build lava surface
    if (topLava.size > 0) {
      const fluidMask = new Uint16Array(S2);
      const fluidHeights = new Float32Array(S2);
      const fluidY = new Float32Array(S2);
      
      for (const [colKey, data] of topLava) {
        const hb = Math.floor(data.height * 7.99);
        fluidMask[colKey] = (hb << 12) | data.blockId;
        fluidHeights[colKey] = data.height;
        fluidY[colKey] = data.y;
      }
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || fluidMask[mi] === 0) continue;
          
          const bid = fluidMask[mi] & 0xFFF;
          const h = fluidHeights[mi];
          const y = fluidY[mi];
          const hb = (fluidMask[mi] >> 12) & 0xF;
          
          let w = 1;
          while (ii + w < S && !visited[mi + w] && fluidMask[mi + w] !== 0) {
            if (((fluidMask[mi + w] >> 12) & 0xF) !== hb || fluidY[mi + w] !== y) break;
            w++;
          }
          
          let d = 1;
          outer: while (jj + d < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + d) * S + ii + k;
              if (visited[ci] || fluidMask[ci] === 0) break outer;
              if (((fluidMask[ci] >> 12) & 0xF) !== hb || fluidY[ci] !== y) break outer;
            }
            d++;
          }
          
          for (let dj = 0; dj < d; dj++) for (let di = 0; di < w; di++) visited[(jj + dj) * S + ii + di] = 1;
          
          if (lVC / 4 + 1 > lCap) grow('l');
          
          const x = baseX + ii - ox, wy = y - oy, z = baseZ + jj - oz;
          const pi = lVC * 3;
          const sv = lVC;
          
          lPos[pi] = x; lPos[pi+1] = wy + h; lPos[pi+2] = z + d;
          lPos[pi+3] = x + w; lPos[pi+4] = wy + h; lPos[pi+5] = z + d;
          lPos[pi+6] = x + w; lPos[pi+7] = wy + h; lPos[pi+8] = z;
          lPos[pi+9] = x; lPos[pi+10] = wy + h; lPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            lNorm[pi + v*3] = 0; lNorm[pi + v*3 + 1] = 1; lNorm[pi + v*3 + 2] = 0;
            lCol[pi + v*3] = r; lCol[pi + v*3 + 1] = g; lCol[pi + v*3 + 2] = b;
          }
          
          lIdx[lIC++] = sv; lIdx[lIC++] = sv + 1; lIdx[lIC++] = sv + 2;
          lIdx[lIC++] = sv; lIdx[lIC++] = sv + 2; lIdx[lIC++] = sv + 3;
          lVC += 4;
        }
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
  };
}

// ============================================================================
// LOD Mesh Builder (Simplified heightmap-based)
// ============================================================================

function buildLODMesh(grid, registry, offset = { x: 0, y: 0, z: 0 }, lodLevel = 1) {
  // Build lookup tables - include fluids as surface for LOD
  const isSurface = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getInfo(id);
    if (info) {
      const isFluid = info.name && (info.name.includes('water') || info.name.includes('lava'));
      isSurface[id] = (info.isOpaque || isFluid) ? 1 : 0;
      colorR[id] = info.colorR;
      colorG[id] = info.colorG;
      colorB[id] = info.colorB;
    }
  }
  
  // Collect surface points from all sections
  const surfacePoints = new Map();
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S;
    const baseY = sectionToWorldY(sy);
    const baseZ = cz * S;
    
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minZ = Math.min(minZ, wz);
        maxZ = Math.max(maxZ, wz);
        
        // Find highest surface block in column
        for (let ly = S - 1; ly >= 0; ly--) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          
          if (bid !== 0 && isSurface[bid]) {
            const worldY = baseY + ly;
            const pointKey = `${wx},${wz}`;
            const existing = surfacePoints.get(pointKey);
            
            if (!existing || worldY > existing.height) {
              surfacePoints.set(pointKey, { height: worldY, blockId: bid });
            }
            break;
          }
        }
      }
    }
  }
  
  if (surfacePoints.size === 0) return null;
  
  // Grid sizes for LOD levels
  const LOD_GRID_SIZES = [358, 358, 253, 179, 127];
  const gridSize = LOD_GRID_SIZES[Math.min(lodLevel, 4)] || 127;
  
  const rangeX = maxX - minX + 1;
  const rangeZ = maxZ - minZ + 1;
  const cellSizeX = rangeX / gridSize;
  const cellSizeZ = rangeZ / gridSize;
  
  // Build grid data
  const gridData = [];
  for (let gz = 0; gz <= gridSize; gz++) {
    gridData[gz] = [];
    for (let gx = 0; gx <= gridSize; gx++) {
      const wx = minX + gx * cellSizeX;
      const wz = minZ + gz * cellSizeZ;
      
      // Find nearest surface point
      const exactKey = `${Math.round(wx)},${Math.round(wz)}`;
      let point = surfacePoints.get(exactKey);
      
      if (!point) {
        // Search nearby
        const radius = Math.ceil(Math.max(cellSizeX, cellSizeZ));
        const cx = Math.round(wx);
        const cz = Math.round(wz);
        let bestDist = Infinity;
        
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const key = `${cx + dx},${cz + dz}`;
            const p = surfacePoints.get(key);
            if (p) {
              const dist = dx * dx + dz * dz;
              if (dist < bestDist) {
                bestDist = dist;
                point = p;
              }
            }
          }
        }
      }
      
      if (point) {
        gridData[gz][gx] = {
          height: point.height,
          r: colorR[point.blockId],
          g: colorG[point.blockId],
          b: colorB[point.blockId]
        };
      } else {
        gridData[gz][gx] = null;
      }
    }
  }
  
  // Fill null cells by interpolation
  let fallback = null;
  for (let gz = 0; gz <= gridSize && !fallback; gz++) {
    for (let gx = 0; gx <= gridSize && !fallback; gx++) {
      if (gridData[gz][gx]) fallback = gridData[gz][gx];
    }
  }
  
  if (fallback) {
    for (let pass = 0; pass < 5; pass++) {
      for (let gz = 0; gz <= gridSize; gz++) {
        for (let gx = 0; gx <= gridSize; gx++) {
          if (gridData[gz][gx] !== null) continue;
          
          const neighbors = [];
          const radius = pass + 1;
          
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx === 0 && dz === 0) continue;
              const nz = gz + dz;
              const nx = gx + dx;
              if (nz >= 0 && nz <= gridSize && nx >= 0 && nx <= gridSize) {
                if (gridData[nz][nx]) neighbors.push(gridData[nz][nx]);
              }
            }
          }
          
          if (neighbors.length > 0) {
            let h = 0, r = 0, g = 0, b = 0;
            for (const n of neighbors) {
              h += n.height;
              r += n.r;
              g += n.g;
              b += n.b;
            }
            gridData[gz][gx] = {
              height: h / neighbors.length,
              r: r / neighbors.length,
              g: g / neighbors.length,
              b: b / neighbors.length
            };
          } else if (pass >= 3) {
            gridData[gz][gx] = { ...fallback };
          }
        }
      }
    }
  }
  
  // Build mesh
  const ox = offset.x, oy = offset.y, oz = offset.z;
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  
  const vertexIndices = [];
  for (let gz = 0; gz <= gridSize; gz++) {
    vertexIndices[gz] = [];
    for (let gx = 0; gx <= gridSize; gx++) {
      const data = gridData[gz][gx];
      if (!data) continue;
      
      const vi = positions.length / 3;
      vertexIndices[gz][gx] = vi;
      
      const wx = minX + gx * cellSizeX;
      const wz = minZ + gz * cellSizeZ;
      
      positions.push(wx - ox, data.height + 1 - oy, wz - oz);
      
      // Calculate normal
      const hL = gx > 0 && gridData[gz][gx-1] ? gridData[gz][gx-1].height : data.height;
      const hR = gx < gridSize && gridData[gz][gx+1] ? gridData[gz][gx+1].height : data.height;
      const hD = gz > 0 && gridData[gz-1][gx] ? gridData[gz-1][gx].height : data.height;
      const hU = gz < gridSize && gridData[gz+1][gx] ? gridData[gz+1][gx].height : data.height;
      
      const nx = (hL - hR) / (2 * cellSizeX);
      const nz = (hD - hU) / (2 * cellSizeZ);
      const len = Math.sqrt(nx * nx + 1 + nz * nz);
      
      normals.push(nx / len, 1 / len, nz / len);
      colors.push(data.r, data.g, data.b);
    }
  }
  
  // Create triangles
  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const v00 = vertexIndices[gz]?.[gx];
      const v10 = vertexIndices[gz]?.[gx + 1];
      const v01 = vertexIndices[gz + 1]?.[gx];
      const v11 = vertexIndices[gz + 1]?.[gx + 1];
      
      if (v00 !== undefined && v10 !== undefined && v01 !== undefined && v11 !== undefined) {
        indices.push(v00, v01, v11);
        indices.push(v00, v11, v10);
      }
    }
  }
  
  if (positions.length === 0) return null;
  
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

// ============================================================================
// Worker Message Handler
// ============================================================================

const registry = new WorkerBlockRegistry();

self.onmessage = async function(e) {
  const { type, id, buffer, regionX, regionZ, generateLOD } = e.data;
  
  if (type === 'processRegion') {
    const startTime = performance.now();
    
    try {
      // Phase 1: Parse MCA
      const parseStart = performance.now();
      const chunks = parseMCABuffer(buffer);
      const parseTime = performance.now() - parseStart;
      
      if (!chunks || chunks.length === 0) {
        self.postMessage({ type: 'error', id, error: 'No chunks found' });
        return;
      }
      
      // Phase 2: Decode into grid
      const decodeStart = performance.now();
      const grid = new WorkerBinaryGrid();
      
      for (const chunk of chunks) {
        decodeChunk(chunk, grid, registry, regionX, regionZ);
      }
      
      const decodeTime = performance.now() - decodeStart;
      
      // Phase 3: Build meshes
      const meshStart = performance.now();
      const bounds = grid.getBounds();
      // Use { x: 0, y: 0, z: 0 } to match progressive loader with centerMesh: false
      // This keeps meshes at their actual world coordinates
      const offset = { x: 0, y: 0, z: 0 };
      
      const meshes = buildMeshes(grid, registry, offset);
      const meshTime = performance.now() - meshStart;
      
      // Phase 4: Build LOD meshes if requested
      let lodMeshes = null;
      let lodTime = 0;
      
      if (generateLOD) {
        const lodStart = performance.now();
        lodMeshes = {
          lod1: buildLODMesh(grid, registry, offset, 1),
          lod2: buildLODMesh(grid, registry, offset, 2),
          lod3: buildLODMesh(grid, registry, offset, 3),
          lod4: buildLODMesh(grid, registry, offset, 4),
        };
        lodTime = performance.now() - lodStart;
      }
      
      const totalTime = performance.now() - startTime;
      
      // Collect transferable buffers
      const transferables = [];
      const result = { solid: null, water: null, lava: null, lodMeshes: null };
      
      if (meshes.solid) {
        result.solid = {
          positions: meshes.solid.positions,
          normals: meshes.solid.normals,
          colors: meshes.solid.colors,
          indices: meshes.solid.indices,
          vertexCount: meshes.solid.vertexCount,
          triangleCount: meshes.solid.triangleCount,
        };
        transferables.push(
          meshes.solid.positions.buffer,
          meshes.solid.normals.buffer,
          meshes.solid.colors.buffer,
          meshes.solid.indices.buffer
        );
      }
      
      if (meshes.water) {
        result.water = {
          positions: meshes.water.positions,
          normals: meshes.water.normals,
          colors: meshes.water.colors,
          indices: meshes.water.indices,
          vertexCount: meshes.water.vertexCount,
          triangleCount: meshes.water.triangleCount,
        };
        transferables.push(
          meshes.water.positions.buffer,
          meshes.water.normals.buffer,
          meshes.water.colors.buffer,
          meshes.water.indices.buffer
        );
      }
      
      if (meshes.lava) {
        result.lava = {
          positions: meshes.lava.positions,
          normals: meshes.lava.normals,
          colors: meshes.lava.colors,
          indices: meshes.lava.indices,
          vertexCount: meshes.lava.vertexCount,
          triangleCount: meshes.lava.triangleCount,
        };
        transferables.push(
          meshes.lava.positions.buffer,
          meshes.lava.normals.buffer,
          meshes.lava.colors.buffer,
          meshes.lava.indices.buffer
        );
      }
      
      // Add LOD meshes to result
      if (lodMeshes) {
        result.lodMeshes = {};
        const addLodMesh = (key, mesh) => {
          if (mesh) {
            result.lodMeshes[key] = {
              positions: mesh.positions,
              normals: mesh.normals,
              colors: mesh.colors,
              indices: mesh.indices,
              vertexCount: mesh.vertexCount,
              triangleCount: mesh.triangleCount,
            };
            transferables.push(
              mesh.positions.buffer,
              mesh.normals.buffer,
              mesh.colors.buffer,
              mesh.indices.buffer
            );
          }
        };
        addLodMesh('lod1', lodMeshes.lod1);
        addLodMesh('lod2', lodMeshes.lod2);
        addLodMesh('lod3', lodMeshes.lod3);
        addLodMesh('lod4', lodMeshes.lod4);
      }
      
      const stats = {
        chunksProcessed: chunks.length,
        totalBlocks: grid.totalBlocks,
        solidTriangles: result.solid?.triangleCount || 0,
        waterTriangles: result.water?.triangleCount || 0,
        lavaTriangles: result.lava?.triangleCount || 0,
        lod1Triangles: lodMeshes?.lod1?.triangleCount || 0,
        lod2Triangles: lodMeshes?.lod2?.triangleCount || 0,
        lod3Triangles: lodMeshes?.lod3?.triangleCount || 0,
        lod4Triangles: lodMeshes?.lod4?.triangleCount || 0,
        parseTimeMs: parseTime,
        decodeTimeMs: decodeTime,
        meshTimeMs: meshTime,
        lodTimeMs: lodTime,
        totalTimeMs: totalTime,
      };
      
      self.postMessage({
        type: 'complete',
        id,
        result,
        stats,
        bounds,
      }, transferables);
      
    } catch (error) {
      self.postMessage({
        type: 'error',
        id,
        error: error.message || String(error),
      });
    }
  }
};

