/**
 * SuperChunkWorker - Unified Decode → Mesh Worker for Super-Chunks
 * 
 * Handles the complete pipeline for a 2x2 super-chunk:
 * 1. Decompress raw chunk data (native or pako)
 * 2. Parse NBT
 * 3. Decode blocks to grid + state grid
 * 4. Include neighbor boundary data
 * 5. Propagate light
 * 6. Build ALL meshes using WASM (solid + water + lava + glass + models)
 * 7. Return transferable ArrayBuffers
 * 
 * Now uses WASM meshing for maximum performance with full texture/lighting support.
 */

import pako from 'pako';
import { ModelStateLookup } from './ModelStateLookup.js';
import { buildMultipartMeshes, combineMeshes } from './MultipartMesher.js';
import {
  S, S2, S3, MIN_Y, MAX_Y,
  BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT,
  AXIS_Y, AXIS_X, AXIS_Z, AXIS_SHIFT,
  AIR_BLOCKS, UNDERWATER_BLOCKS,
  isRotatableBlock,
  parseSectionKey,
  sectionToWorldY,
} from './shared.js';

// Check if native DecompressionStream is available
const hasNativeDecompress = typeof DecompressionStream !== 'undefined';

// ============================================================================
// Bounding Volume Computation (for main thread optimization)
// ============================================================================

/**
 * Compute bounding box and sphere from positions array
 * This is done in worker to avoid blocking main thread
 * 
 * @param {Float32Array} positions - Vertex positions (xyz interleaved)
 * @returns {{boundingBox: {min: {x,y,z}, max: {x,y,z}}, boundingSphere: {center: {x,y,z}, radius: number}}}
 */
function computeBounds(positions) {
  if (!positions || positions.length < 3) {
    return null;
  }
  
  // Compute AABB
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  
  // Compute bounding sphere center (AABB center)
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  
  // Compute radius as max distance from center to any vertex
  let radiusSq = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - centerX;
    const dy = positions[i + 1] - centerY;
    const dz = positions[i + 2] - centerZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > radiusSq) radiusSq = distSq;
  }
  
  return {
    boundingBox: {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    },
    boundingSphere: {
      center: { x: centerX, y: centerY, z: centerZ },
      radius: Math.sqrt(radiusSq),
    },
  };
}

/**
 * Add pre-computed bounds to a mesh result object
 * Mutates the mesh object to add bounds properties
 */
function addBoundsToMesh(mesh) {
  if (!mesh || !mesh.positions || mesh.positions.length === 0) return;
  
  const bounds = computeBounds(mesh.positions);
  if (bounds) {
    mesh.boundingBox = bounds.boundingBox;
    mesh.boundingSphere = bounds.boundingSphere;
  }
}

// ============================================================================
// Worker State
// ============================================================================

let workerInitialized = false;
let blockRegistry = null;
let stateRegistry = null;
let textureIndexLookup = null;
let tintTypeLookup = null;

// WASM mesher state
let wasmModule = null;
let wasmInitialized = false;
let wasmLookupsInitialized = false;

// V3 model meshing state
let modelStateLookup = null;
let v3RegistryInitialized = false;

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
// WASM Mesher Loading
// ============================================================================

async function initWasmMesher() {
  if (wasmInitialized) return true;
  
  try {
    // Dynamic import of WASM module - works in workers
    const wasm = await import('../wasm/pkg/wasm_mesher.js');
    await wasm.default(); // Initialize WASM
    wasm.init(); // Call our init function
    
    wasmModule = wasm;
    wasmInitialized = true;
    console.log('[SuperChunkWorker] WASM module initialized');
    return true;
  } catch (error) {
    console.warn('[SuperChunkWorker] Failed to load WASM:', error.message);
    return false;
  }
}

function initWasmLookups(lookups) {
  if (!wasmInitialized || !wasmModule) {
    console.warn('[SuperChunkWorker] Cannot init lookups - WASM not available');
    return false;
  }
  
  try {
    wasmModule.init_lookups(
      lookups.isOpaque,
      lookups.isNonCube,
      lookups.isSlab,
      lookups.isFluid,
      lookups.isGlass,
      lookups.isAOTransparent,
      lookups.isRotatable,
      lookups.isDirectional,
      lookups.colorR,
      lookups.colorG,
      lookups.colorB,
      lookups.faceTintTypes,
      lookups.textureIndices,
      lookups.waterStillIdx || 0,
      lookups.waterFlowIdx || 0,
      lookups.lavaStillIdx || 0,
      lookups.lavaFlowIdx || 0
    );
    wasmLookupsInitialized = true;
    console.log('[SuperChunkWorker] WASM lookups initialized');
    return true;
  } catch (error) {
    console.error('[SuperChunkWorker] Failed to init WASM lookups:', error);
    return false;
  }
}

function serializeGridForWasm(grid) {
  const sections = [...grid.sections.entries()];
  const sectionCount = sections.length;
  
  const totalSize = 4 + sectionCount * (8 + 4096 * 2);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8View = new Uint8Array(buffer);
  
  view.setUint32(0, sectionCount, true);
  
  let offset = 4;
  for (const [key, section] of sections) {
    const parts = key.split(',');
    const chunkX = parseInt(parts[0], 10);
    const chunkZ = parseInt(parts[1], 10);
    const sectionY = parseInt(parts[2], 10);
    
    const cx = BigInt(chunkX + 0x800000);
    const cz = BigInt(chunkZ + 0x800000);
    const sy = BigInt(sectionY & 0xFFFF);
    const packed = (cx << 40n) | (cz << 16n) | sy;
    
    view.setBigUint64(offset, packed, true);
    offset += 8;
    
    const sectionBytes = new Uint8Array(section.buffer, section.byteOffset, section.byteLength);
    uint8View.set(sectionBytes, offset);
    offset += 4096 * 2;
  }
  
  return new Uint8Array(buffer);
}

function serializeLightGridForWasm(lightGrid) {
  if (!lightGrid || lightGrid.sections.size === 0) {
    return new Uint8Array(4);
  }

  const sections = [...lightGrid.sections.entries()];
  const sectionCount = sections.length;
  
  const totalSize = 4 + sectionCount * (8 + 4096);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8View = new Uint8Array(buffer);
  
  view.setUint32(0, sectionCount, true);
  
  let offset = 4;
  for (const [key, section] of sections) {
    const parts = key.split(',');
    const chunkX = parseInt(parts[0], 10);
    const chunkZ = parseInt(parts[1], 10);
    const sectionY = parseInt(parts[2], 10);
    
    const cx = BigInt(chunkX + 0x800000);
    const cz = BigInt(chunkZ + 0x800000);
    const sy = BigInt(sectionY & 0xFFFF);
    const packed = (cx << 40n) | (cz << 16n) | sy;
    
    view.setBigUint64(offset, packed, true);
    offset += 8;
    
    uint8View.set(section, offset);
    offset += 4096;
  }
  
  return new Uint8Array(buffer);
}

function wasmMeshChunk(grid, lightGrid, bounds) {
  if (!wasmInitialized || !wasmLookupsInitialized) {
    throw new Error('WASM mesher not ready');
  }
  
  const gridData = serializeGridForWasm(grid);
  const lightData = serializeLightGridForWasm(lightGrid);
  const stateData = new Uint8Array(4); // Empty state grid for now
  
  const result = wasmModule.mesh_chunk_bounded(
    gridData, lightData, stateData, null, 0,
    bounds.minChunkX, bounds.minChunkZ, bounds.maxChunkX, bounds.maxChunkZ
  );
  
  return {
    solid: {
      positions: new Float32Array(result.solid_positions),
      normals: new Float32Array(result.solid_normals),
      colors: new Float32Array(result.solid_colors),
      texIndices: new Float32Array(result.solid_tex_indices),
      texRotations: new Float32Array(result.solid_tex_rotations),
      tintTypes: new Float32Array(result.solid_tint_types),
      skyLight: new Float32Array(result.solid_sky_light),
      blockLight: new Float32Array(result.solid_block_light),
      indices: new Uint32Array(result.solid_indices),
      vertexCount: result.solid_vertex_count,
    },
    water: {
      positions: new Float32Array(result.water_positions),
      normals: new Float32Array(result.water_normals),
      colors: new Float32Array(result.water_colors),
      uvs: new Float32Array(result.water_uvs),
      texIndices: new Float32Array(result.water_tex_indices),
      skyLight: new Float32Array(result.water_sky_light),
      blockLight: new Float32Array(result.water_block_light),
      indices: new Uint32Array(result.water_indices),
      vertexCount: result.water_vertex_count,
    },
    lava: {
      positions: new Float32Array(result.lava_positions),
      normals: new Float32Array(result.lava_normals),
      colors: new Float32Array(result.lava_colors),
      uvs: new Float32Array(result.lava_uvs),
      texIndices: new Float32Array(result.lava_tex_indices),
      skyLight: new Float32Array(result.lava_sky_light),
      blockLight: new Float32Array(result.lava_block_light),
      indices: new Uint32Array(result.lava_indices),
      vertexCount: result.lava_vertex_count,
    },
    glass: {
      positions: new Float32Array(result.glass_positions),
      normals: new Float32Array(result.glass_normals),
      colors: new Float32Array(result.glass_colors),
      texIndices: new Float32Array(result.glass_tex_indices),
      texRotations: new Float32Array(result.glass_tex_rotations),
      tintTypes: new Float32Array(result.glass_tint_types),
      skyLight: new Float32Array(result.glass_sky_light),
      blockLight: new Float32Array(result.glass_block_light),
      indices: new Uint32Array(result.glass_indices),
      vertexCount: result.glass_vertex_count,
    },
  };
}

/**
 * V3 Model Meshing - uses block-name-based registry with ModelStateGrid
 * This meshes model blocks in WASM using the pre-baked geometry
 */
function wasmMeshModelsV3(grid, lightGrid, modelStateGrid, bounds) {
  if (!wasmInitialized || !wasmLookupsInitialized || !v3RegistryInitialized) {
    throw new Error('V3 WASM model mesher not ready');
  }
  
  const gridData = serializeGridForWasm(grid);
  const lightData = serializeLightGridForWasm(lightGrid);
  const modelStateData = modelStateGrid.serializeForWasm();
  
  const result = wasmModule.mesh_models_v3(
    gridData, lightData, modelStateData,
    bounds.minChunkX, bounds.minChunkZ, bounds.maxChunkX, bounds.maxChunkZ
  );
  
  // Extract model meshes from result
  return {
    modelOpaque: {
      positions: new Float32Array(result.opaque_positions()),
      normals: new Float32Array(result.opaque_normals()),
      uvs: new Float32Array(result.opaque_uvs()),
      colors: new Float32Array(result.opaque_colors()),
      texIndices: new Float32Array(result.opaque_tex_indices()),
      tintTypes: new Float32Array(result.opaque_tint_types()),
      skyLight: new Float32Array(result.opaque_sky_light()),
      blockLight: new Float32Array(result.opaque_block_light()),
      shadeFlags: new Float32Array(result.opaque_shade_flags()),
      indices: new Uint32Array(result.opaque_indices()),
      vertexCount: result.opaque_vertex_count(),
    },
    modelTransparent: {
      positions: new Float32Array(result.transparent_positions()),
      normals: new Float32Array(result.transparent_normals()),
      uvs: new Float32Array(result.transparent_uvs()),
      colors: new Float32Array(result.transparent_colors()),
      texIndices: new Float32Array(result.transparent_tex_indices()),
      tintTypes: new Float32Array(result.transparent_tint_types()),
      skyLight: new Float32Array(result.transparent_sky_light()),
      blockLight: new Float32Array(result.transparent_block_light()),
      shadeFlags: new Float32Array(result.transparent_shade_flags()),
      indices: new Uint32Array(result.transparent_indices()),
      vertexCount: result.transparent_vertex_count(),
    },
    // Translucent mesh (slime, honey) - check if WASM supports it
    modelTranslucent: (typeof result.translucent_positions === 'function') ? {
      positions: new Float32Array(result.translucent_positions()),
      normals: new Float32Array(result.translucent_normals()),
      uvs: new Float32Array(result.translucent_uvs()),
      colors: new Float32Array(result.translucent_colors()),
      texIndices: new Float32Array(result.translucent_tex_indices()),
      tintTypes: new Float32Array(result.translucent_tint_types()),
      skyLight: new Float32Array(result.translucent_sky_light()),
      blockLight: new Float32Array(result.translucent_block_light()),
      shadeFlags: new Float32Array(result.translucent_shade_flags()),
      indices: new Uint32Array(result.translucent_indices()),
      vertexCount: result.translucent_vertex_count(),
    } : { positions: new Float32Array(0), vertexCount: 0 },
    modelOverlay: {
      positions: new Float32Array(result.overlay_positions()),
      normals: new Float32Array(result.overlay_normals()),
      uvs: new Float32Array(result.overlay_uvs()),
      colors: new Float32Array(result.overlay_colors()),
      texIndices: new Float32Array(result.overlay_tex_indices()),
      tintTypes: new Float32Array(result.overlay_tint_types()),
      skyLight: new Float32Array(result.overlay_sky_light()),
      blockLight: new Float32Array(result.overlay_block_light()),
      shadeFlags: new Float32Array(result.overlay_shade_flags()),
      indices: new Uint32Array(result.overlay_indices()),
      vertexCount: result.overlay_vertex_count(),
    },
    beaconPositions: Array.from(result.beacon_positions()),
  };
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

/**
 * Extract inactive beacon positions from decoded chunks
 * A beacon is inactive if its Levels property is 0 (no valid pyramid)
 * 
 * @param {Array} chunks - Array of decoded chunks with {x, z, data}
 * @returns {Set<string>} Set of "x,y,z" keys for inactive beacons
 */
function extractInactiveBeacons(chunks) {
  const inactive = new Set();
  
  for (const chunk of chunks) {
    if (!chunk || !chunk.data) continue;
    
    // Block entities are stored differently in different Minecraft versions
    const blockEntities = chunk.data.block_entities || 
                         (chunk.data.Level && chunk.data.Level.TileEntities) || [];
    
    for (const entity of blockEntities) {
      // Check if this is a beacon block entity
      const id = entity.id || entity.Id;
      if (!id) continue;
      
      const idLower = id.toLowerCase();
      if (!idLower.includes('beacon')) continue;
      
      // Get position
      const x = entity.x ?? entity.X ?? 0;
      const y = entity.y ?? entity.Y ?? 0;
      const z = entity.z ?? entity.Z ?? 0;
      
      // Get pyramid level (Levels property)
      // In Minecraft: 0 = no valid pyramid, 1-4 = valid pyramid levels
      const levels = entity.Levels ?? entity.levels ?? 0;
      
      // Only track inactive beacons (Levels = 0)
      if (levels === 0) {
        inactive.add(`${x},${y},${z}`);
      }
    }
  }
  
  return inactive;
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
// End Portal Geometry Generation
// ============================================================================

/**
 * Detect end_portal and end_gateway blocks and generate simple geometry
 * end_portal: flat horizontal plane at Y+0.75
 * end_gateway: full cube (all 6 faces)
 * 
 * @param {WorkerBinaryGrid} grid - Block grid
 * @param {WorkerBlockRegistry} registry - Block registry
 * @returns {Object|null} Mesh data with positions, normals, indices
 */
function buildEndPortalMesh(grid, registry) {
  // Find end portal block IDs
  let endPortalId = 0;
  let endGatewayId = 0;
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getInfo(id);
    if (!info?.name) continue;
    const name = info.name.replace('minecraft:', '');
    if (name === 'end_portal') endPortalId = id;
    else if (name === 'end_gateway') endGatewayId = id;
  }
  
  if (endPortalId === 0 && endGatewayId === 0) return null;
  
  // Collect portal block positions
  const portals = []; // {x, y, z, isGateway}
  
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S;
    const baseY = sectionToWorldY(sy);
    const baseZ = cz * S;
    
    for (let i = 0; i < S3; i++) {
      const bid = section[i] & BLOCK_ID_MASK;
      if (bid !== endPortalId && bid !== endGatewayId) continue;
      
      const lx = i & 15;
      const lz = (i >> 4) & 15;
      const ly = i >> 8;
      
      portals.push({
        x: baseX + lx,
        y: baseY + ly,
        z: baseZ + lz,
        isGateway: bid === endGatewayId,
      });
    }
  }
  
  if (portals.length === 0) return null;
  
  // Calculate buffer sizes
  // end_portal: 1 face (top) = 4 verts, 6 indices
  // end_gateway: 6 faces = 24 verts, 36 indices
  let totalVerts = 0;
  let totalIndices = 0;
  for (const p of portals) {
    if (p.isGateway) {
      totalVerts += 24;
      totalIndices += 36;
    } else {
      totalVerts += 4;
      totalIndices += 6;
    }
  }
  
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  
  let vi = 0; // vertex index
  let ii = 0; // index index
  
  for (const p of portals) {
    const x = p.x;
    const y = p.y;
    const z = p.z;
    
    if (p.isGateway) {
      // Full cube for end_gateway (6 faces)
      const faces = [
        // up (+Y)
        { verts: [[x,y+1,z], [x+1,y+1,z], [x+1,y+1,z+1], [x,y+1,z+1]], normal: [0,1,0] },
        // down (-Y)
        { verts: [[x,y,z+1], [x+1,y,z+1], [x+1,y,z], [x,y,z]], normal: [0,-1,0] },
        // north (-Z)
        { verts: [[x+1,y+1,z], [x,y+1,z], [x,y,z], [x+1,y,z]], normal: [0,0,-1] },
        // south (+Z)
        { verts: [[x,y+1,z+1], [x+1,y+1,z+1], [x+1,y,z+1], [x,y,z+1]], normal: [0,0,1] },
        // east (+X)
        { verts: [[x+1,y+1,z+1], [x+1,y+1,z], [x+1,y,z], [x+1,y,z+1]], normal: [1,0,0] },
        // west (-X)
        { verts: [[x,y+1,z], [x,y+1,z+1], [x,y,z+1], [x,y,z]], normal: [-1,0,0] },
      ];
      
      for (const face of faces) {
        const startVert = vi;
        for (let v = 0; v < 4; v++) {
          const pi = vi * 3;
          positions[pi] = face.verts[v][0];
          positions[pi + 1] = face.verts[v][1];
          positions[pi + 2] = face.verts[v][2];
          normals[pi] = face.normal[0];
          normals[pi + 1] = face.normal[1];
          normals[pi + 2] = face.normal[2];
          vi++;
        }
        // Two triangles per face
        indices[ii++] = startVert;
        indices[ii++] = startVert + 1;
        indices[ii++] = startVert + 2;
        indices[ii++] = startVert;
        indices[ii++] = startVert + 2;
        indices[ii++] = startVert + 3;
      }
    } else {
      // Flat plane for end_portal at Y+0.75 (top face only)
      const py = y + 0.75;
      const startVert = vi;
      
      // Top face vertices
      const pi0 = vi * 3;
      positions[pi0] = x; positions[pi0 + 1] = py; positions[pi0 + 2] = z;
      normals[pi0] = 0; normals[pi0 + 1] = 1; normals[pi0 + 2] = 0;
      vi++;
      
      const pi1 = vi * 3;
      positions[pi1] = x + 1; positions[pi1 + 1] = py; positions[pi1 + 2] = z;
      normals[pi1] = 0; normals[pi1 + 1] = 1; normals[pi1 + 2] = 0;
      vi++;
      
      const pi2 = vi * 3;
      positions[pi2] = x + 1; positions[pi2 + 1] = py; positions[pi2 + 2] = z + 1;
      normals[pi2] = 0; normals[pi2 + 1] = 1; normals[pi2 + 2] = 0;
      vi++;
      
      const pi3 = vi * 3;
      positions[pi3] = x; positions[pi3 + 1] = py; positions[pi3 + 2] = z + 1;
      normals[pi3] = 0; normals[pi3 + 1] = 1; normals[pi3 + 2] = 0;
      vi++;
      
      // Two triangles
      indices[ii++] = startVert;
      indices[ii++] = startVert + 1;
      indices[ii++] = startVert + 2;
      indices[ii++] = startVert;
      indices[ii++] = startVert + 2;
      indices[ii++] = startVert + 3;
    }
  }
  
  return {
    positions,
    normals,
    indices,
    vertexCount: vi,
    portalCount: portals.length,
  };
}

// ============================================================================
// Binary Grid
// ============================================================================

function makeSectionKey(cx, cz, sy) { return `${cx},${cz},${sy}`; }

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
  
  getBlockId(x, y, z) {
    return this.getBlock(x, y, z) & BLOCK_ID_MASK;
  }
  
  // Serialize for transfer to main thread
  serialize() {
    const serialized = [];
    for (const [key, section] of this.sections) {
      serialized.push({ key, data: section });
    }
    return {
      sections: serialized,
      totalBlocks: this.totalBlocks,
      minChunkX: this.minChunkX,
      maxChunkX: this.maxChunkX,
      minChunkZ: this.minChunkZ,
      maxChunkZ: this.maxChunkZ,
      minSectionY: this.minSectionY,
      maxSectionY: this.maxSectionY,
    };
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
  
  // Serialize for transfer to main thread
  serialize() {
    const serialized = [];
    for (const [key, section] of this.sections) {
      // Only include non-empty sections
      let hasData = false;
      for (let i = 0; i < section.length; i++) {
        if (section[i] !== 0) {
          hasData = true;
          break;
        }
      }
      if (hasData) {
        serialized.push({ key, data: section });
      }
    }
    return serialized;
  }
}

// ============================================================================
// Model State Grid (V3)
// ============================================================================

class WorkerModelStateGrid {
  constructor() {
    this.sections = new Map(); // key → Uint32Array(4096)
  }
  
  _getOrCreateSection(cx, cz, sy) {
    const key = makeSectionKey(cx, cz, sy);
    let sec = this.sections.get(key);
    if (!sec) {
      sec = new Uint32Array(S3);
      this.sections.set(key, sec);
    }
    return sec;
  }
  
  set(x, y, z, modelState) {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const sy = Math.floor((y - MIN_Y) / S);
    const sec = this._getOrCreateSection(cx, cz, sy);
    
    const lx = ((x % S) + S) % S;
    const ly = ((y - MIN_Y) % S + S) % S;
    const lz = ((z % S) + S) % S;
    
    sec[ly * S2 + lz * S + lx] = modelState;
  }
  
  get(x, y, z) {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const sy = Math.floor((y - MIN_Y) / S);
    const key = makeSectionKey(cx, cz, sy);
    const sec = this.sections.get(key);
    if (!sec) return 0;
    
    const lx = ((x % S) + S) % S;
    const ly = ((y - MIN_Y) % S + S) % S;
    const lz = ((z % S) + S) % S;
    
    return sec[ly * S2 + lz * S + lx];
  }
  
  get size() {
    return this.sections.size;
  }
  
  // Serialize for WASM consumption
  // Format: [sectionCount: u32][sections...]
  // Section: [key: u64][data: u32 × 4096]
  serializeForWasm() {
    // Count non-empty sections
    const nonEmptySections = [];
    let totalNonZeroStates = 0;
    for (const [key, section] of this.sections) {
      let hasData = false;
      let nonZeroCount = 0;
      for (let i = 0; i < section.length; i++) {
        if (section[i] !== 0) {
          hasData = true;
          nonZeroCount++;
        }
      }
      if (hasData) {
        nonEmptySections.push({ key, section, nonZeroCount });
        totalNonZeroStates += nonZeroCount;
      }
    }
    
    // DEBUG: Log detailed V3 serialization info
    if (nonEmptySections.length > 0) {
      const firstSection = nonEmptySections[0];
      const sampleStates = [];
      for (let i = 0; i < firstSection.section.length && sampleStates.length < 5; i++) {
        if (firstSection.section[i] !== 0) {
          sampleStates.push({
            index: i,
            state: firstSection.section[i],
            blockIdx: firstSection.section[i] & 0xFFF,
            variantIdx: (firstSection.section[i] >> 12) & 0xFF,
          });
        }
      }
      console.log(`[V3 Debug] serializeForWasm: ${nonEmptySections.length} sections, ${totalNonZeroStates} states, samples:`, sampleStates);
    }
    
    const sectionCount = nonEmptySections.length;
    const totalSize = 4 + sectionCount * (8 + S3 * 4);
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;
    
    view.setUint32(offset, sectionCount, true);
    offset += 4;
    
    for (const { key, section } of nonEmptySections) {
      // Parse section key back to coords and pack as u64
      const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
      const cx = (chunkX + 0x800000) & 0xFFFFFF;
      const cz = (chunkZ + 0x800000) & 0xFFFFFF;
      const sy = sectionY & 0xFFFF;
      
      // Pack: cx (24 bits at [40:64]) | cz (24 bits at [16:40]) | sy (16 bits at [0:16])
      // Write as two 32-bit little-endian values
      // low = bits 0-31: lower 16 bits of cz at [16:31], sy at [0:15]
      // high = bits 32-63: cx at [8:31], upper 8 bits of cz at [0:7]
      const low = ((cz & 0xFFFF) << 16) | (sy & 0xFFFF);
      const high = ((cx & 0xFFFFFF) << 8) | ((cz >> 16) & 0xFF);
      view.setUint32(offset, low, true);
      view.setUint32(offset + 4, high, true);
      offset += 8;
      
      // Write section data
      for (let i = 0; i < S3; i++) {
        view.setUint32(offset, section[i], true);
        offset += 4;
      }
    }
    
    return new Uint8Array(buffer);
  }
  
  get size() {
    return this.sections.size;
  }
}

// ============================================================================
// Light Grid
// ============================================================================

class WorkerLightGrid {
  constructor() {
    this.sections = new Map();
    this.hasMinecraftLightData = false;
    // Track bounds for smart missing section handling
    this.minChunkX = Infinity;
    this.maxChunkX = -Infinity;
    this.minChunkZ = Infinity;
    this.maxChunkZ = -Infinity;
  }
  
  _getOrCreateSection(cx, cz, sy) {
    const key = makeSectionKey(cx, cz, sy);
    let sec = this.sections.get(key);
    if (!sec) {
      // Each byte: high nibble = block light, low nibble = sky light
      // Default to 0 (dark) - propagation will fill in correct values
      sec = new Uint8Array(S3);
      sec.fill(0x00);
      this.sections.set(key, sec);
      // Update bounds
      if (cx < this.minChunkX) this.minChunkX = cx;
      if (cx > this.maxChunkX) this.maxChunkX = cx;
      if (cz < this.minChunkZ) this.minChunkZ = cz;
      if (cz > this.maxChunkZ) this.maxChunkZ = cz;
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
    if (!sec) {
      // Smart default: check if position is within loaded bounds
      const withinBounds = 
        cx >= this.minChunkX && cx <= this.maxChunkX &&
        cz >= this.minChunkZ && cz <= this.maxChunkZ;
      
      if (this.hasMinecraftLightData && withinBounds) {
        // Within loaded chunks with MC data - missing section = underground
        return { sky: 0, block: 0 };
      }
      // Outside bounds or no MC data - default to bright (safe fallback)
      return { sky: 15, block: 0 };
    }
    const lx = ((x % S) + S) % S;
    const ly = ((y - MIN_Y) % S + S) % S;
    const lz = ((z % S) + S) % S;
    const val = sec[ly * S2 + lz * S + lx];
    return { sky: val & 0x0F, block: (val >> 4) & 0x0F };
  }
  
  getSkyLight(x, y, z) {
    const light = this.getLight(x, y, z);
    return light.sky;
  }
  
  setSkyLight(x, y, z, level) {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const sy = Math.floor((y - MIN_Y) / S);
    const sec = this._getOrCreateSection(cx, cz, sy);
    const lx = ((x % S) + S) % S;
    const ly = ((y - MIN_Y) % S + S) % S;
    const lz = ((z % S) + S) % S;
    const idx = ly * S2 + lz * S + lx;
    sec[idx] = (sec[idx] & 0xF0) | (level & 0x0F);
  }
  
  getBlockLight(x, y, z) {
    const light = this.getLight(x, y, z);
    return light.block;
  }
  
  setBlockLight(x, y, z, level) {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const sy = Math.floor((y - MIN_Y) / S);
    const sec = this._getOrCreateSection(cx, cz, sy);
    const lx = ((x % S) + S) % S;
    const ly = ((y - MIN_Y) % S + S) % S;
    const lz = ((z % S) + S) % S;
    const idx = ly * S2 + lz * S + lx;
    // Block light is stored in high nibble
    sec[idx] = (sec[idx] & 0x0F) | ((level & 0x0F) << 4);
  }
  
  // Serialize for transfer to main thread
  serialize() {
    const serialized = [];
    for (const [key, section] of this.sections) {
      serialized.push({ key, data: section });
    }
    return {
      sections: serialized,
      hasMinecraftLightData: this.hasMinecraftLightData,
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

function decodeChunk(chunk, grid, registry, stateGrid, stateRegistry, lightGrid, modelStateGrid = null) {
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
      const modelStates = (modelStateGrid && modelStateLookup) ? new Uint32Array(palette.length) : null;
      const isAir = new Uint8Array(palette.length);
      const levels = new Int8Array(palette.length);
      const isWaterlogged = new Uint8Array(palette.length);
      const axisValues = new Uint8Array(palette.length); // Axis for rotatable blocks
      
      for (let i = 0; i < palette.length; i++) {
        const entry = palette[i];
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        const shortName = name.replace('minecraft:', '');
        blockIds[i] = registry.getBlockId(name);
        isAir[i] = AIR_BLOCKS.has(name) || name.endsWith(':air') ? 1 : 0;
        
        // Register state if stateGrid and stateRegistry available
        const props = (typeof entry === 'object' && entry.Properties) ? entry.Properties : {};
        if (stateGrid && stateRegistry && !isAir[i]) {
          stateIds[i] = stateRegistry.register(name, props);
        }
        
        // V3: Get model state for model blocks
        if (modelStates && !isAir[i] && modelStateLookup.isModelBlock(shortName)) {
          const ms = modelStateLookup.getModelState(shortName, props);
          modelStates[i] = ms;
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
        
        // Extract axis for rotatable blocks (logs, pillars, etc.)
        if (isRotatableBlock(shortName) && props?.axis) {
          if (props.axis === 'x') {
            axisValues[i] = AXIS_X;
          } else if (props.axis === 'z') {
            axisValues[i] = AXIS_Z;
          } else {
            axisValues[i] = AXIS_Y;
          }
        }
      }
      
      const blockData = blockStates.data;
      const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSY);
      const stateSection = stateGrid ? stateGrid._getOrCreateSection(chunkX, chunkZ, internalSY) : null;
      
      // Pre-create model state section if needed
      const hasModelBlocks = modelStates && modelStates.some(ms => ms !== 0);
      
      // Debug logging disabled for performance
      // if (modelStates && v3RegistryInitialized) {
      //   const modelBlocksInPalette = modelStates.filter(ms => ms !== 0).length;
      //   if (modelBlocksInPalette > 0 && totalBlocks < 50) {
      //     console.log(`[V3 Decode] Section (${chunkX}, ${chunkZ}, y=${baseY}): ${modelBlocksInPalette}/${palette.length} palette entries are model blocks`);
      //   }
      // }
      
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        if (!isAir[0]) {
          // Encode metadata: fluid level > waterlogged > axis for rotatable blocks
          let metadata;
          if (levels[0] >= 0) {
            metadata = levels[0]; // Fluid level
          } else if (isWaterlogged[0]) {
            metadata = 8; // Waterlogged marker
          } else if (axisValues[0] > 0) {
            metadata = axisValues[0]; // Axis for rotatable blocks (1=x, 2=z)
          } else {
            metadata = 0;
          }
          const val = (blockIds[0] & 0x0FFF) | ((metadata & 0xF) << 12);
          gridSection.fill(val);
          if (stateSection && stateIds) stateSection.fill(stateIds[0]);
          
          // V3: Fill model state section if this is a model block
          if (hasModelBlocks && modelStates[0] !== 0 && modelStateGrid) {
            const worldBaseX = chunkX * S;
            const worldBaseZ = chunkZ * S;
            const worldBaseY = baseY;
            for (let ly = 0; ly < S; ly++) {
              for (let lz = 0; lz < S; lz++) {
                for (let lx = 0; lx < S; lx++) {
                  modelStateGrid.set(worldBaseX + lx, worldBaseY + ly, worldBaseZ + lz, modelStates[0]);
                }
              }
            }
          }
          
          totalBlocks += S3;
          grid.totalBlocks += S3;
        }
        continue;
      }
      
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const indices = unpackBlockIndices(blockData, bitsPerBlock, S3);
      
      // Pre-compute world coordinates base
      const worldBaseX = chunkX * S;
      const worldBaseZ = chunkZ * S;
      const worldBaseY = baseY;
      
      for (let i = 0; i < S3; i++) {
        const pi = indices[i];
        if (pi < palette.length && !isAir[pi]) {
          // Encode metadata: fluid level > waterlogged > axis for rotatable blocks
          let metadata;
          if (levels[pi] >= 0) {
            metadata = levels[pi]; // Fluid level
          } else if (isWaterlogged[pi]) {
            metadata = 8; // Waterlogged marker
          } else if (axisValues[pi] > 0) {
            metadata = axisValues[pi]; // Axis for rotatable blocks (1=x, 2=z)
          } else {
            metadata = 0;
          }
          gridSection[i] = (blockIds[pi] & 0x0FFF) | ((metadata & 0xF) << 12);
          if (stateSection && stateIds) stateSection[i] = stateIds[pi];
          
          // V3: Store model state if this is a model block
          if (modelStates && modelStates[pi] !== 0 && modelStateGrid) {
            // Convert section index to local coords
            const ly = Math.floor(i / S2);
            const lz = Math.floor((i % S2) / S);
            const lx = i % S;
            modelStateGrid.set(worldBaseX + lx, worldBaseY + ly, worldBaseZ + lz, modelStates[pi]);
          }
          
          totalBlocks++;
          grid.totalBlocks++;
        }
      }
    }
  }
  
  return totalBlocks;
}

// ============================================================================
// Light Propagation - Full BFS with neighbor data support
// ============================================================================

/**
 * Ring buffer queue for O(1) enqueue/dequeue operations.
 * Standard array.shift() is O(n) which becomes a bottleneck for BFS.
 */
class LightQueue {
  constructor(initialCapacity = 32768) {
    this.capacity = initialCapacity;
    // Packed: x (i16), y (i16), z (i16), light (i16)
    this.data = new Int16Array(initialCapacity * 4);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }
  
  get length() { return this.size; }
  
  push(x, y, z, light) {
    if (this.size >= this.capacity) this._grow();
    const idx = this.tail * 4;
    this.data[idx] = x;
    this.data[idx + 1] = y;
    this.data[idx + 2] = z;
    this.data[idx + 3] = light;
    this.tail = (this.tail + 1) % this.capacity;
    this.size++;
  }
  
  shift() {
    if (this.size === 0) return null;
    const idx = this.head * 4;
    const x = this.data[idx];
    const y = this.data[idx + 1];
    const z = this.data[idx + 2];
    const light = this.data[idx + 3];
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    return { x, y, z, light };
  }
  
  _grow() {
    const newCapacity = this.capacity * 2;
    const newData = new Int16Array(newCapacity * 4);
    for (let i = 0; i < this.size; i++) {
      const oldIdx = ((this.head + i) % this.capacity) * 4;
      const newIdx = i * 4;
      newData[newIdx] = this.data[oldIdx];
      newData[newIdx + 1] = this.data[oldIdx + 1];
      newData[newIdx + 2] = this.data[oldIdx + 2];
      newData[newIdx + 3] = this.data[oldIdx + 3];
    }
    this.data = newData;
    this.head = 0;
    this.tail = this.size;
    this.capacity = newCapacity;
  }
}

/**
 * Get light opacity for a block
 */
function getLightOpacity(blockId, isOpaque, isGlass, isFluid, isNonCube) {
  if (blockId === 0) return 0; // Air
  if (isNonCube[blockId]) return 0; // Transparent non-cubes
  if (isGlass[blockId]) return 0; // Glass passes light
  if (isFluid[blockId]) return 1; // Water/lava attenuates slightly
  if (isOpaque[blockId]) return 15; // Fully opaque
  return 0;
}

/**
 * Propagate sky light through the block grid using BFS flood-fill.
 * 
 * Algorithm:
 * 1. Build heightmap (highest opaque block per column)
 * 2. Set sky light = 15 for all blocks above heightmap
 * 3. BFS flood-fill light into shadowed areas
 */
function propagateSkyLight(grid, lightGrid, registry) {
  // Build lookup tables for fast access
  const isOpaque = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096);
  const isFluid = new Uint8Array(4096);
  const isNonCube = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getInfo(id);
    if (info) {
      isOpaque[id] = info.isOpaque ? 1 : 0;
      isNonCube[id] = info.isNonCube ? 1 : 0;
      if (info.name) {
        if (info.name.includes('glass') || info.name.includes('ice') || info.name.includes('leaves')) {
          isGlass[id] = 1;
        }
        if (info.name.includes('water') || info.name.includes('lava')) {
          isFluid[id] = 1;
        }
      }
    }
  }
  
  // Get bounds from grid
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  
  for (const [key] of grid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
    const baseX = chunkX * S;
    const baseZ = chunkZ * S;
    const baseY = sectionY * S + MIN_Y;
    
    minX = Math.min(minX, baseX);
    maxX = Math.max(maxX, baseX + S - 1);
    minZ = Math.min(minZ, baseZ);
    maxZ = Math.max(maxZ, baseZ + S - 1);
    minY = Math.min(minY, baseY);
    maxY = Math.max(maxY, baseY + S - 1);
  }
  
  if (minX === Infinity) return; // No sections
  
  const width = maxX - minX + 1;
  const depth = maxZ - minZ + 1;
  
  // Phase 1: Build heightmap (highest Y that blocks sky light)
  const heightmap = new Int16Array(width * depth);
  heightmap.fill(minY - 1);
  
  for (const [key, section] of grid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
    const baseX = chunkX * S;
    const baseZ = chunkZ * S;
    const baseY = sectionY * S + MIN_Y;
    
    for (let ly = S - 1; ly >= 0; ly--) {
      const worldY = baseY + ly;
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const worldX = baseX + lx;
          const worldZ = baseZ + lz;
          const hmIdx = (worldX - minX) + (worldZ - minZ) * width;
          
          if (heightmap[hmIdx] < worldY) {
            const idx = ly * S2 + lz * S + lx;
            const blockId = section[idx] & BLOCK_ID_MASK;
            
            // Check if this block blocks light
            const opacity = getLightOpacity(blockId, isOpaque, isGlass, isFluid, isNonCube);
            if (opacity >= 15) {
              heightmap[hmIdx] = worldY;
            }
          }
        }
      }
    }
  }
  
  // Phase 2: Set sky light and seed BFS queue
  const queue = new LightQueue();
  const MAX_LIGHT = 15;
  
  for (const [key, section] of grid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
    const lightSection = lightGrid._getOrCreateSection(chunkX, chunkZ, sectionY);
    const baseX = chunkX * S;
    const baseZ = chunkZ * S;
    const baseY = sectionY * S + MIN_Y;
    
    for (let ly = 0; ly < S; ly++) {
      const worldY = baseY + ly;
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const worldX = baseX + lx;
          const worldZ = baseZ + lz;
          const hmIdx = (worldX - minX) + (worldZ - minZ) * width;
          const heightmapY = heightmap[hmIdx];
          const idx = ly * S2 + lz * S + lx;
          const blockId = section[idx] & BLOCK_ID_MASK;
          
          if (worldY > heightmapY) {
            // Above heightmap - full sunlight
            lightSection[idx] = (lightSection[idx] & 0xF0) | MAX_LIGHT;
            
            // Add to queue if at shadow boundary (for spreading into caves)
            let atBoundary = (worldY === heightmapY + 1);
            
            // Also check horizontal neighbors for shadow entry points
            if (!atBoundary) {
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = worldX + dx;
                const nz = worldZ + dz;
                if (nx >= minX && nx <= maxX && nz >= minZ && nz <= maxZ) {
                  const nhmIdx = (nx - minX) + (nz - minZ) * width;
                  if (heightmap[nhmIdx] >= worldY) {
                    atBoundary = true;
                    break;
                  }
                }
              }
            }
            
            if (atBoundary) {
              queue.push(worldX, worldY, worldZ, MAX_LIGHT);
            }
          } else if (blockId === 0 || isGlass[blockId] || isNonCube[blockId]) {
            // Air or transparent below heightmap - starts dark
            lightSection[idx] = (lightSection[idx] & 0xF0) | 0;
          }
        }
      }
    }
  }
  
  // Phase 3: BFS flood-fill
  const DX = [1, -1, 0, 0, 0, 0];
  const DY = [0, 0, 1, -1, 0, 0];
  const DZ = [0, 0, 0, 0, 1, -1];
  
  while (queue.length > 0) {
    const { x, y, z, light } = queue.shift();
    if (light <= 1) continue;
    
    for (let i = 0; i < 6; i++) {
      const nx = x + DX[i];
      const ny = y + DY[i];
      const nz = z + DZ[i];
      
      if (ny < minY || ny > maxY) continue;
      
      // Get neighbor block
      const neighborBlockId = grid.getBlockId(nx, ny, nz);
      const opacity = getLightOpacity(neighborBlockId, isOpaque, isGlass, isFluid, isNonCube);
      
      if (opacity >= 15) continue; // Fully opaque
      
      const newLight = light - 1 - opacity;
      if (newLight <= 0) continue;
      
      // Check current light at neighbor
      const currentLight = lightGrid.getSkyLight(nx, ny, nz);
      
      if (newLight > currentLight) {
        lightGrid.setSkyLight(nx, ny, nz, newLight);
        queue.push(nx, ny, nz, newLight);
      }
    }
  }
}

// ============================================================================
// Block Light Propagator (Torches, Glowstone, etc.)
// ============================================================================

/**
 * Light emission levels for common light-emitting blocks
 */
const LIGHT_EMISSION = {
  'beacon': 15, 'conduit': 15, 'end_gateway': 15, 'end_portal': 15, 'fire': 15,
  'glowstone': 15, 'jack_o_lantern': 15, 'lantern': 15, 'lava': 15, 'sea_lantern': 15,
  'shroomlight': 15, 'campfire': 15, 'respawn_anchor': 15, 'froglight': 15,
  'pearlescent_froglight': 15, 'verdant_froglight': 15, 'ochre_froglight': 15,
  'torch': 14, 'wall_torch': 14, 'end_rod': 14,
  'blast_furnace': 13, 'furnace': 13, 'smoker': 13,
  'nether_portal': 11,
  'soul_torch': 10, 'soul_wall_torch': 10, 'soul_lantern': 10, 'soul_fire': 10, 'crying_obsidian': 10, 'soul_campfire': 10,
  'enchanting_table': 7, 'ender_chest': 7, 'redstone_torch': 7, 'redstone_wall_torch': 7, 'glow_lichen': 7,
  'sculk_catalyst': 6, 'amethyst_cluster': 5, 'large_amethyst_bud': 4, 'magma_block': 3,
  'medium_amethyst_bud': 2, 'small_amethyst_bud': 1, 'brewing_stand': 1, 'brown_mushroom': 1, 'dragon_egg': 1,
};

function getBlockLightEmission(blockName) {
  if (!blockName) return 0;
  if (LIGHT_EMISSION[blockName] !== undefined) return LIGHT_EMISSION[blockName];
  for (const [pattern, level] of Object.entries(LIGHT_EMISSION)) {
    if (blockName.includes(pattern)) return level;
  }
  if (blockName.includes('sea_pickle')) return 6;
  if (blockName.includes('candle') && !blockName.includes('cake')) return 3;
  return 0;
}

/**
 * Propagate block light from light sources (torches, glowstone, etc.)
 */
function propagateBlockLight(grid, lightGrid, registry) {
  // Build lookup tables
  const isOpaque = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096);
  const isFluid = new Uint8Array(4096);
  const lightEmission = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getInfo(id);
    if (info) {
      isOpaque[id] = info.opaque ? 1 : 0;
      if (info.name) {
        if (info.name.includes('glass') || info.name.includes('ice') || info.name.includes('leaves')) {
          isGlass[id] = 1;
        }
        if (info.name.includes('water') || info.name.includes('lava')) {
          isFluid[id] = 1;
        }
        lightEmission[id] = getBlockLightEmission(info.name);
      }
    }
  }
  
  // Find all light sources
  const queue = [];
  
  for (const [key, section] of grid.sections) {
    const parts = key.split(',').map(Number);
    const [chunkX, chunkZ, sectionY] = parts;
    const baseX = chunkX * S;
    const baseY = sectionY * S + MIN_Y;
    const baseZ = chunkZ * S;
    
    for (let ly = 0; ly < S; ly++) {
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const blockId = section[idx] & 0x0FFF;
          const emission = lightEmission[blockId];
          if (emission > 0) {
            const worldX = baseX + lx;
            const worldY = baseY + ly;
            const worldZ = baseZ + lz;
            lightGrid.setBlockLight(worldX, worldY, worldZ, emission);
            queue.push({ x: worldX, y: worldY, z: worldZ, light: emission });
          }
        }
      }
    }
  }
  
  // BFS propagation
  const DX = [1, -1, 0, 0, 0, 0];
  const DY = [0, 0, 1, -1, 0, 0];
  const DZ = [0, 0, 0, 0, 1, -1];
  
  while (queue.length > 0) {
    const { x, y, z, light } = queue.shift();
    const newLight = light - 1;
    if (newLight <= 0) continue;
    
    for (let i = 0; i < 6; i++) {
      const nx = x + DX[i];
      const ny = y + DY[i];
      const nz = z + DZ[i];
      
      const neighborBlockId = grid.getBlockId(nx, ny, nz);
      let opacity = 0;
      if (isOpaque[neighborBlockId]) opacity = 15;
      else if (isFluid[neighborBlockId]) opacity = 1;
      else if (isGlass[neighborBlockId]) opacity = 0;
      
      if (opacity >= 15) continue;
      
      const attenuatedLight = newLight - opacity;
      if (attenuatedLight <= 0) continue;
      
      const currentLight = lightGrid.getBlockLight(nx, ny, nz);
      if (attenuatedLight > currentLight) {
        lightGrid.setBlockLight(nx, ny, nz, attenuatedLight);
        queue.push({ x: nx, y: ny, z: nz, light: attenuatedLight });
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
  
  // V3: Create model state grid only if V3 registry is initialized
  const modelStateGrid = v3RegistryInitialized && modelStateLookup 
    ? new WorkerModelStateGrid() 
    : null;
  
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
  let totalModelStatesSet = 0;
  for (const chunk of chunkResults) {
    if (chunk) {
      decodedChunks.push(chunk);
      const beforeSize = modelStateGrid?.size ?? 0;
      decodeChunk(chunk, grid, blockRegistry, stateGrid, stateRegistry, lightGrid, modelStateGrid);
      const afterSize = modelStateGrid?.size ?? 0;
      if (afterSize > beforeSize) {
        totalModelStatesSet += (afterSize - beforeSize);
      }
    }
  }
  
  // Debug logging disabled for performance
  // if (modelStateGrid) {
  //   console.log(`[SuperChunkWorker] After decode: modelStateGrid has ${modelStateGrid.size} sections`);
  // }
  
  // Extract inactive beacon positions (beacons with Levels = 0)
  // This is used to filter out beacon beams on the main thread
  const inactiveBeacons = extractInactiveBeacons(decodedChunks);
  
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
    
    // Filter neighbors to only those adjacent to boundary (including diagonals)
    // Diagonals are needed for water corner height calculation which samples 2x2 blocks
    const relevantNeighbors = neighbors.filter(n => {
      const cx = n.chunkX, cz = n.chunkZ;
      
      // Check if chunk is within 1-chunk extended boundary (includes diagonals)
      const isWithinExtended = (
        cx >= minCX - 1 && cx <= maxCX + 1 &&
        cz >= minCZ - 1 && cz <= maxCZ + 1
      );
      
      // Must be outside main super-chunk area
      const isOutside = cx < minCX || cx > maxCX || cz < minCZ || cz > maxCZ;
      
      return isWithinExtended && isOutside && !loadedChunks.has(`${cx},${cz}`);
    });
    
    // Process relevant neighbors - handle both raw compressed and pre-parsed NBT
    if (relevantNeighbors.length > 0) {
      const neighborPromises = relevantNeighbors.map(async (neighborData) => {
        try {
          // Handle pre-parsed NBT data (from main-thread-built super-chunks)
          if (neighborData.isParsed && neighborData.parsedData) {
            return {
              x: neighborData.chunkX,
              z: neighborData.chunkZ,
              data: neighborData.parsedData,
            };
          }
          
          // Handle raw compressed data (preferred path)
          if (neighborData.compressedData) {
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
          }
          
          return null;
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
  // When Minecraft data is present, it already includes correct sky and block light
  // from neighbor chunks (Minecraft pre-computes lighting during world save)
  if (!lightGrid.hasMinecraftLightData) {
    propagateSkyLight(grid, lightGrid, blockRegistry);
    // Also propagate block light from torches/glowstone when no MC data
    propagateBlockLight(grid, lightGrid, blockRegistry);
  }
  
  const decodeTime = performance.now() - startTime;
  
  // Build meshes
  const meshStart = performance.now();
  const offset = { x: 0, y: 0, z: 0 };
  
  let gridMeshes;
  
  // Use WASM meshing if available (includes full texture/lighting attributes)
  // NOTE: WASM mesher does not check light values for merge decisions,
  // which can cause blocky lighting. For now, prefer WASM for speed
  // as light values are still per-vertex (just with larger quads).
  // TODO: Add light-based merge checking to WASM mesher for smoother lighting.
  if (wasmInitialized && wasmLookupsInitialized) {
    try {
      gridMeshes = wasmMeshChunk(grid, lightGrid, bounds);
    } catch (e) {
      console.warn('[SuperChunkWorker] WASM meshing failed, falling back to JS:', e.message);
      gridMeshes = buildGridMeshes(grid, blockRegistry, offset);
    }
  } else {
    // Fall back to simple JS meshing (missing texture/lighting attributes)
    gridMeshes = buildGridMeshes(grid, blockRegistry, offset);
  }
  
  // Serialize grids for main thread model meshing
  // Model meshing requires full ModelGeometry infrastructure not available in worker
  const serializedGrid = grid.serialize();
  const serializedStateGrid = stateGrid.serialize();
  const serializedLightGrid = lightGrid.serialize();
  
  // Serialize state registry so main thread can map worker stateIds to its own IDs
  // Only include states that are actually used in the stateGrid
  const usedStateIds = new Set();
  for (const { data } of serializedStateGrid) {
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0) usedStateIds.add(data[i]);
    }
  }
  
  const serializedStates = [];
  for (const stateId of usedStateIds) {
    const state = stateRegistry.getState(stateId);
    if (state) {
      serializedStates.push({
        workerStateId: stateId,
        blockName: state.blockName,
        properties: state.properties,
      });
    }
  }
  
  const meshTime = performance.now() - meshStart;
  
  // Collect transferables
  const transferables = [];
  const result = {
    solid: null,
    water: null,
    lava: null,
    glass: null,
    models: null,
    // Serialized grids for main thread model meshing
    grids: {
      grid: serializedGrid,
      stateGrid: serializedStateGrid,
      lightGrid: serializedLightGrid,
      states: serializedStates, // Worker state ID -> blockName + properties mapping
    },
  };
  
  // Add grid section buffers to transferables
  for (const section of serializedGrid.sections) {
    transferables.push(section.data.buffer);
  }
  for (const section of serializedStateGrid) {
    transferables.push(section.data.buffer);
  }
  for (const section of serializedLightGrid.sections) {
    transferables.push(section.data.buffer);
  }
  
  // Add grid meshes with all attributes (texture indices, rotations, tint types, lighting)
  // Pre-compute bounding volumes in worker to avoid main thread computation
  if (gridMeshes.solid && gridMeshes.solid.vertexCount > 0) {
    result.solid = {
      positions: gridMeshes.solid.positions,
      normals: gridMeshes.solid.normals,
      colors: gridMeshes.solid.colors,
      texIndices: gridMeshes.solid.texIndices,
      texRotations: gridMeshes.solid.texRotations,
      tintTypes: gridMeshes.solid.tintTypes,
      skyLight: gridMeshes.solid.skyLight,
      blockLight: gridMeshes.solid.blockLight,
      indices: gridMeshes.solid.indices,
      vertexCount: gridMeshes.solid.vertexCount,
      triangleCount: gridMeshes.solid.indices.length / 3,
    };
    addBoundsToMesh(result.solid);
    transferables.push(
      gridMeshes.solid.positions.buffer,
      gridMeshes.solid.normals.buffer,
      gridMeshes.solid.colors.buffer,
      gridMeshes.solid.texIndices.buffer,
      gridMeshes.solid.texRotations.buffer,
      gridMeshes.solid.tintTypes.buffer,
      gridMeshes.solid.skyLight.buffer,
      gridMeshes.solid.blockLight.buffer,
      gridMeshes.solid.indices.buffer
    );
  }
  
  if (gridMeshes.water && gridMeshes.water.vertexCount > 0) {
    result.water = {
      positions: gridMeshes.water.positions,
      normals: gridMeshes.water.normals,
      colors: gridMeshes.water.colors,
      uvs: gridMeshes.water.uvs,
      texIndices: gridMeshes.water.texIndices,
      skyLight: gridMeshes.water.skyLight,
      blockLight: gridMeshes.water.blockLight,
      indices: gridMeshes.water.indices,
      vertexCount: gridMeshes.water.vertexCount,
      triangleCount: gridMeshes.water.indices.length / 3,
    };
    addBoundsToMesh(result.water);
    transferables.push(
      gridMeshes.water.positions.buffer,
      gridMeshes.water.normals.buffer,
      gridMeshes.water.colors.buffer,
      gridMeshes.water.uvs.buffer,
      gridMeshes.water.texIndices.buffer,
      gridMeshes.water.skyLight.buffer,
      gridMeshes.water.blockLight.buffer,
      gridMeshes.water.indices.buffer
    );
  }
  
  if (gridMeshes.lava && gridMeshes.lava.vertexCount > 0) {
    result.lava = {
      positions: gridMeshes.lava.positions,
      normals: gridMeshes.lava.normals,
      colors: gridMeshes.lava.colors,
      uvs: gridMeshes.lava.uvs,
      texIndices: gridMeshes.lava.texIndices,
      skyLight: gridMeshes.lava.skyLight,
      blockLight: gridMeshes.lava.blockLight,
      indices: gridMeshes.lava.indices,
      vertexCount: gridMeshes.lava.vertexCount,
      triangleCount: gridMeshes.lava.indices.length / 3,
    };
    addBoundsToMesh(result.lava);
    transferables.push(
      gridMeshes.lava.positions.buffer,
      gridMeshes.lava.normals.buffer,
      gridMeshes.lava.colors.buffer,
      gridMeshes.lava.uvs.buffer,
      gridMeshes.lava.texIndices.buffer,
      gridMeshes.lava.skyLight.buffer,
      gridMeshes.lava.blockLight.buffer,
      gridMeshes.lava.indices.buffer
    );
  }
  
  if (gridMeshes.glass && gridMeshes.glass.vertexCount > 0) {
    result.glass = {
      positions: gridMeshes.glass.positions,
      normals: gridMeshes.glass.normals,
      colors: gridMeshes.glass.colors,
      texIndices: gridMeshes.glass.texIndices,
      texRotations: gridMeshes.glass.texRotations,
      tintTypes: gridMeshes.glass.tintTypes,
      skyLight: gridMeshes.glass.skyLight,
      blockLight: gridMeshes.glass.blockLight,
      indices: gridMeshes.glass.indices,
      vertexCount: gridMeshes.glass.vertexCount,
      triangleCount: gridMeshes.glass.indices.length / 3,
    };
    addBoundsToMesh(result.glass);
    transferables.push(
      gridMeshes.glass.positions.buffer,
      gridMeshes.glass.normals.buffer,
      gridMeshes.glass.colors.buffer,
      gridMeshes.glass.texIndices.buffer,
      gridMeshes.glass.texRotations.buffer,
      gridMeshes.glass.tintTypes.buffer,
      gridMeshes.glass.skyLight.buffer,
      gridMeshes.glass.blockLight.buffer,
      gridMeshes.glass.indices.buffer
    );
  }
  
  // V3 Model Meshing - if V3 registry initialized, mesh models in WASM
  const v3Enabled = v3RegistryInitialized && modelStateGrid && modelStateGrid.size > 0;
  
  // Debug info for testing
  result.v3Debug = {
    enabled: v3Enabled,
    registryInit: v3RegistryInitialized,
    gridSections: modelStateGrid?.size ?? 0,
    modelStateLookupReady: !!modelStateLookup,
  };
  
  // Collect model meshes from V3 (WASM) and multipart (JS) meshers
  // Then combine and add transferables only once at the end
  let v3Meshes = null;
  let multipartMeshes = null;
  
  // V3 Model Meshing (non-multipart blocks: stairs, slabs, torches, etc.)
  if (v3Enabled) {
    try {
      const serialized = modelStateGrid.serializeForWasm();
      result.v3Debug.serializedBytes = serialized.byteLength;
      
      v3Meshes = wasmMeshModelsV3(grid, lightGrid, modelStateGrid, bounds);
      result.v3Debug.opaqueVerts = v3Meshes.modelOpaque?.vertexCount ?? 0;
      result.v3Debug.transVerts = v3Meshes.modelTransparent?.vertexCount ?? 0;
      
      // Beacon positions from V3
      if (v3Meshes.beaconPositions && v3Meshes.beaconPositions.length > 0) {
        result.beaconPositions = v3Meshes.beaconPositions;
      }
    } catch (e) {
      console.warn('[SuperChunkWorker] V3 model meshing failed:', e.message);
    }
  }
  
  // Multipart meshing in worker (fences, walls, glass panes, redstone_wire, etc.)
  // This replaces main thread model meshing - no more grids sent to main thread
  if (stateRegistry && stateRegistry.states && stateRegistry.states.length > 0) {
    try {
      const offset = { x: 0, y: 0, z: 0 };
      multipartMeshes = buildMultipartMeshes(
        grid,
        stateGrid,
        blockRegistry,
        stateRegistry,
        offset,
        {
          textureIndexLookup,
          lightGrid,
          bounds,
          tintTypeLookup,
        }
      );
      
      if (multipartMeshes) {
        result.v3Debug.multipartMeshed = true;
        result.v3Debug.multipartOpaqueVerts = multipartMeshes.opaque?.vertexCount ?? 0;
        result.v3Debug.multipartTransVerts = multipartMeshes.transparent?.vertexCount ?? 0;
        
        // Particle emitters from multipart meshing
        if (multipartMeshes.particleEmitters && multipartMeshes.particleEmitters.length > 0) {
          result.particleEmitters = multipartMeshes.particleEmitters;
        }
      }
      
      // Keep grids for debug inspector but mark that multipart meshing was done
      // Main thread will skip model mesh building when this flag is set
    } catch (e) {
      console.warn('[SuperChunkWorker] Multipart meshing failed:', e.message, e.stack);
      // Keep grids as fallback for main thread
    }
  }
  
  // Combine V3 and multipart meshes, then add to transferables
  // Pre-compute bounding volumes for model meshes too
  const combined = combineMeshes(v3Meshes, multipartMeshes);
  
  if (combined.modelOpaque && combined.modelOpaque.vertexCount > 0) {
    addBoundsToMesh(combined.modelOpaque);
    result.modelOpaque = combined.modelOpaque;
    transferables.push(
      combined.modelOpaque.positions.buffer,
      combined.modelOpaque.normals.buffer,
      combined.modelOpaque.uvs.buffer,
      combined.modelOpaque.colors.buffer,
      combined.modelOpaque.texIndices.buffer,
      combined.modelOpaque.tintTypes.buffer,
      combined.modelOpaque.skyLight.buffer,
      combined.modelOpaque.blockLight.buffer,
      combined.modelOpaque.shadeFlags.buffer,
      combined.modelOpaque.indices.buffer
    );
  }
  
  if (combined.modelTransparent && combined.modelTransparent.vertexCount > 0) {
    addBoundsToMesh(combined.modelTransparent);
    result.modelTransparent = combined.modelTransparent;
    transferables.push(
      combined.modelTransparent.positions.buffer,
      combined.modelTransparent.normals.buffer,
      combined.modelTransparent.uvs.buffer,
      combined.modelTransparent.colors.buffer,
      combined.modelTransparent.texIndices.buffer,
      combined.modelTransparent.tintTypes.buffer,
      combined.modelTransparent.skyLight.buffer,
      combined.modelTransparent.blockLight.buffer,
      combined.modelTransparent.shadeFlags.buffer,
      combined.modelTransparent.indices.buffer
    );
  }
  
  if (combined.modelTranslucent && combined.modelTranslucent.vertexCount > 0) {
    addBoundsToMesh(combined.modelTranslucent);
    result.modelTranslucent = combined.modelTranslucent;
    transferables.push(
      combined.modelTranslucent.positions.buffer,
      combined.modelTranslucent.normals.buffer,
      combined.modelTranslucent.uvs.buffer,
      combined.modelTranslucent.colors.buffer,
      combined.modelTranslucent.texIndices.buffer,
      combined.modelTranslucent.tintTypes.buffer,
      combined.modelTranslucent.skyLight.buffer,
      combined.modelTranslucent.blockLight.buffer,
      combined.modelTranslucent.shadeFlags.buffer,
      combined.modelTranslucent.indices.buffer
    );
  }
  
  if (combined.modelOverlay && combined.modelOverlay.vertexCount > 0) {
    addBoundsToMesh(combined.modelOverlay);
    result.modelOverlay = combined.modelOverlay;
    transferables.push(
      combined.modelOverlay.positions.buffer,
      combined.modelOverlay.normals.buffer,
      combined.modelOverlay.uvs.buffer,
      combined.modelOverlay.colors.buffer,
      combined.modelOverlay.texIndices.buffer,
      combined.modelOverlay.tintTypes.buffer,
      combined.modelOverlay.skyLight.buffer,
      combined.modelOverlay.blockLight.buffer,
      combined.modelOverlay.shadeFlags.buffer,
      combined.modelOverlay.indices.buffer
    );
  }
  
  // End Portal mesh generation (end_portal and end_gateway blocks)
  const endPortalMesh = buildEndPortalMesh(grid, blockRegistry);
  if (endPortalMesh && endPortalMesh.vertexCount > 0) {
    addBoundsToMesh(endPortalMesh);
    result.endPortal = endPortalMesh;
    transferables.push(
      endPortalMesh.positions.buffer,
      endPortalMesh.normals.buffer,
      endPortalMesh.indices.buffer
    );
  }
  
  const totalTime = performance.now() - startTime;
  
  // Add inactive beacon positions to result (beacons with Levels = 0)
  // These will be filtered out on main thread when registering beacons
  if (inactiveBeacons.size > 0) {
    result.inactiveBeacons = Array.from(inactiveBeacons);
  }
  
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
      
      // Initialize WASM mesher in worker (async)
      const wasmReady = await initWasmMesher();
      
      // Initialize WASM lookups if provided
      if (wasmReady && data.wasmLookups) {
        initWasmLookups(data.wasmLookups);
      }
      
      // Initialize WASM model registry if model geometry data is provided (V2 - legacy)
      let modelRegistryReady = false;
      if (wasmReady && data.modelGeometry && wasmModule) {
        try {
          const mg = data.modelGeometry;
          wasmModule.init_model_registry_v2(
            mg.stateIds,
            mg.blockNames,
            mg.flags,
            mg.geometryData
          );
          modelRegistryReady = true;
          console.log(`[SuperChunkWorker] WASM model registry V2 initialized: ${mg.stateIds.length} states, ${mg.faceCount} faces`);
        } catch (err) {
          console.warn('[SuperChunkWorker] Failed to init model registry V2:', err);
        }
      }
      
      // Initialize V3 block model registry (block-name-based)
      if (wasmReady && data.bakedModels && wasmModule) {
        try {
          const bakedData = new Uint8Array(data.bakedModels);
          // Pass texture remapping if available
          const remapping = data.textureRemapping ? new Uint16Array(data.textureRemapping) : null;
          const result = wasmModule.init_block_model_registry(bakedData, remapping);
          if (result) {
            v3RegistryInitialized = true;
            console.log(`[SuperChunkWorker] V3 block model registry initialized: ${(bakedData.length / 1024).toFixed(1)} KB`);
            if (remapping) {
              console.log(`[SuperChunkWorker] Applied texture remapping with ${remapping.length} entries`);
            }
          }
        } catch (err) {
          console.warn('[SuperChunkWorker] Failed to init V3 block model registry:', err);
        }
      }
      
      // Initialize ModelStateLookup for V3
      if (data.manifest) {
        modelStateLookup = new ModelStateLookup();
        modelStateLookup.init(data.manifest);
        // Count how many blocks have variants (actual model blocks)
        let modelBlockCount = 0;
        for (const [name, blockData] of Object.entries(data.manifest.blocks)) {
          if (Object.keys(blockData.variants).length > 0) {
            modelBlockCount++;
          }
        }
        console.log(`[SuperChunkWorker] ModelStateLookup initialized: ${modelBlockCount} model blocks with variants`);
      } else {
        console.warn(`[SuperChunkWorker] No manifest data - V3 will not work`);
      }
      
      workerInitialized = true;
      
      self.postMessage({ 
        type: 'ready', 
        id, 
        wasmAvailable: wasmInitialized && wasmLookupsInitialized, 
        modelRegistryReady,
        v3RegistryReady: v3RegistryInitialized && modelStateLookup !== null,
      });
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

