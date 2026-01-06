/**
 * WasmMesher - JavaScript bridge for WASM meshing module
 * 
 * Handles:
 * - Loading and initializing the WASM module
 * - Serializing grid data for WASM consumption
 * - Extracting mesh results from WASM memory
 * - Initializing lookup tables in WASM
 */

let wasmModule = null;
let wasmInitialized = false;
let initPromise = null;

/**
 * Initialize the WASM mesher module
 * @returns {Promise<boolean>} True if initialization succeeded
 */
export async function initWasmMesher() {
  if (wasmInitialized) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Dynamic import of the WASM module
      // The module is built by wasm-pack and placed in ./pkg/
      const wasm = await import('./pkg/wasm_mesher.js');
      await wasm.default(); // Initialize WASM
      wasm.init(); // Call our init function
      
      wasmModule = wasm;
      wasmInitialized = true;
      console.log('[WasmMesher] WASM module initialized successfully');
      return true;
    } catch (error) {
      console.warn('[WasmMesher] Failed to load WASM module:', error.message);
      console.warn('[WasmMesher] Falling back to JavaScript mesher');
      return false;
    }
  })();

  return initPromise;
}

/**
 * Check if WASM mesher is available
 */
export function isWasmAvailable() {
  return wasmInitialized && wasmModule !== null;
}

/**
 * Initialize lookup tables in WASM memory
 * Call this after loading the block registry
 * 
 * @param {Object} lookups - Lookup table data
 * @param {Uint8Array} lookups.isOpaque - Block opacity flags
 * @param {Uint8Array} lookups.isNonCube - Non-cube block flags
 * @param {Uint8Array} lookups.isSlab - Slab block flags
 * @param {Uint8Array} lookups.isFluid - Fluid type (0=none, 1=water, 2=lava)
 * @param {Uint8Array} lookups.isGlass - Glass/transparent flags
 * @param {Uint8Array} lookups.isAOTransparent - AO transparency flags
 * @param {Float32Array} lookups.colorR - Block red color component
 * @param {Float32Array} lookups.colorG - Block green color component
 * @param {Float32Array} lookups.colorB - Block blue color component
 * @param {Uint8Array} lookups.faceTintTypes - Per-face tint types (6 per block)
 * @param {Float32Array} lookups.textureIndices - Per-face texture indices (6 per block)
 */
export function initLookups(lookups) {
  if (!isWasmAvailable()) {
    console.warn('[WasmMesher] Cannot init lookups - WASM not available');
    return;
  }

  wasmModule.init_lookups(
    lookups.isOpaque,
    lookups.isNonCube,
    lookups.isSlab,
    lookups.isFluid,
    lookups.isGlass,
    lookups.isAOTransparent,
    lookups.colorR,
    lookups.colorG,
    lookups.colorB,
    lookups.faceTintTypes,
    lookups.textureIndices,
    lookups.waterStillIdx,
    lookups.waterFlowIdx,
    lookups.lavaStillIdx,
    lookups.lavaFlowIdx
  );

  console.log('[WasmMesher] Lookup tables initialized');
}

/**
 * Serialize a BinaryGrid for WASM consumption
 * Format: [num_sections: u32][section_key: u64, data: [u16; 4096]]...
 * 
 * @param {BinaryGrid} grid - The grid to serialize
 * @returns {Uint8Array} Serialized grid data
 */
export function serializeGrid(grid) {
  const sections = [...grid.sections.entries()];
  const sectionCount = sections.length;
  
  // Calculate total size
  // 4 bytes for count + (8 bytes key + 8192 bytes data) per section
  const totalSize = 4 + sectionCount * (8 + 4096 * 2);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8View = new Uint8Array(buffer);
  
  // Write section count
  view.setUint32(0, sectionCount, true);
  
  let offset = 4;
  for (const [key, section] of sections) {
    // Parse key "chunkX,chunkZ,sectionY" and pack into u64
    const parts = key.split(',');
    const chunkX = parseInt(parts[0], 10);
    const chunkZ = parseInt(parts[1], 10);
    const sectionY = parseInt(parts[2], 10);
    
    // Pack into u64: (cx + 0x800000) << 40 | (cz + 0x800000) << 16 | (sy & 0xFFFF)
    const cx = BigInt(chunkX + 0x800000);
    const cz = BigInt(chunkZ + 0x800000);
    const sy = BigInt(sectionY & 0xFFFF);
    const packed = (cx << 40n) | (cz << 16n) | sy;
    
    view.setBigUint64(offset, packed, true);
    offset += 8;
    
    // Copy section data (Uint16Array -> bytes)
    const sectionBytes = new Uint8Array(section.buffer, section.byteOffset, section.byteLength);
    uint8View.set(sectionBytes, offset);
    offset += 4096 * 2;
  }
  
  return new Uint8Array(buffer);
}

/**
 * Serialize a LightGrid for WASM consumption
 * Format: [num_sections: u32][section_key: u64, data: [u8; 4096]]...
 * 
 * @param {LightGrid} lightGrid - The light grid to serialize
 * @returns {Uint8Array} Serialized light data
 */
export function serializeLightGrid(lightGrid) {
  if (!lightGrid || lightGrid.sections.size === 0) {
    return new Uint8Array(4); // Just the count (0)
  }

  const sections = [...lightGrid.sections.entries()];
  const sectionCount = sections.length;
  
  // 4 bytes for count + (8 bytes key + 4096 bytes data) per section
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

/**
 * Serialize a BlockStateGrid for WASM consumption
 * 
 * @param {BlockStateGrid} stateGrid - The state grid to serialize
 * @returns {Uint8Array} Serialized state data
 */
export function serializeStateGrid(stateGrid) {
  if (!stateGrid || stateGrid.sections.size === 0) {
    return new Uint8Array(4); // Just the count (0)
  }

  const sections = [...stateGrid.sections.entries()];
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

/**
 * Mesh a chunk using WASM
 * 
 * @param {BinaryGrid} grid - Block grid
 * @param {LightGrid} lightGrid - Light grid (optional)
 * @param {BlockStateGrid} stateGrid - State grid for model blocks (optional)
 * @param {Object} bounds - Optional bounds {minChunkX, minChunkZ, maxChunkX, maxChunkZ}
 * @returns {Object} Mesh result with solid, water, lava, glass buffers
 */
export function meshChunk(grid, lightGrid, stateGrid, bounds = null) {
  if (!isWasmAvailable()) {
    throw new Error('WASM mesher not available');
  }

  // Serialize grids
  const gridData = serializeGrid(grid);
  const lightData = lightGrid ? serializeLightGrid(lightGrid) : new Uint8Array(0);
  const stateData = stateGrid ? serializeStateGrid(stateGrid) : new Uint8Array(0);

  // Call WASM mesher (with or without bounds)
  let result;
  if (bounds) {
    result = wasmModule.mesh_chunk_bounded(
      gridData, lightData, stateData, null, 0,
      bounds.minChunkX, bounds.minChunkZ, bounds.maxChunkX, bounds.maxChunkZ
    );
  } else {
    result = wasmModule.mesh_chunk(gridData, lightData, stateData, null, 0);
  }

  // Extract mesh data from result
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

// Import tint type lookup builder
import { buildFaceTintTypeLookup } from '../../data/biomeTinting.js';

/**
 * Build lookup tables from a BlockRegistry
 * 
 * @param {BlockRegistry} registry - The block registry
 * @param {TextureIndexLookup} textureIndexLookup - Texture index lookup
 * @returns {Object} Lookup tables ready for initLookups()
 */
export function buildLookupTables(registry, textureIndexLookup) {
  const MAX_BLOCKS = 4096;
  
  const isOpaque = new Uint8Array(MAX_BLOCKS);
  const isNonCube = new Uint8Array(MAX_BLOCKS);
  const isSlab = new Uint8Array(MAX_BLOCKS);
  const isFluid = new Uint8Array(MAX_BLOCKS);
  const isGlass = new Uint8Array(MAX_BLOCKS);
  const isAOTransparent = new Uint8Array(MAX_BLOCKS);
  const colorR = new Float32Array(MAX_BLOCKS);
  const colorG = new Float32Array(MAX_BLOCKS);
  const colorB = new Float32Array(MAX_BLOCKS);
  const textureIndices = new Float32Array(MAX_BLOCKS * 6);
  
  // Get proper face tint types from biomeTinting.js
  const faceTintTypes = buildFaceTintTypeLookup(registry);
  
  // Fill with default colors
  colorR.fill(1.0);
  colorG.fill(1.0);
  colorB.fill(1.0);
  
  for (let id = 0; id < MAX_BLOCKS; id++) {
    const info = registry.getBlockInfo(id);
    if (!info) continue;
    
    isOpaque[id] = registry.isOpaque(id) ? 1 : 0;
    isNonCube[id] = registry.isNonCube(id) ? 1 : 0;
    
    const col = registry.getColor(id);
    colorR[id] = col.r;
    colorG[id] = col.g;
    colorB[id] = col.b;
    
    if (info.name) {
      if (info.name.includes('water')) {
        isFluid[id] = 1;
      } else if (info.name.includes('lava')) {
        isFluid[id] = 2;
      }
      
      if ((info.name.includes('glass') && !info.name.includes('_pane')) ||
          info.name.includes('ice') || info.name.includes('leaves')) {
        isGlass[id] = 1;
      }
      
      if (info.name.includes('_slab')) {
        isSlab[id] = 1;
      }
      
      // AO transparent blocks
      if (info.name.includes('glass') || info.name.includes('ice') ||
          info.name.includes('leaves') || info.name.includes('slime') ||
          info.name.includes('honey') || info.name.includes('water') ||
          info.name.includes('lava') || info.name.includes('barrier') ||
          info.name.includes('light') || registry.isNonCube(id)) {
        isAOTransparent[id] = 1;
      }
    }
    
    // Get texture indices for each face
    if (textureIndexLookup) {
      for (let face = 0; face < 6; face++) {
        const idx = id * 6 + face;
        textureIndices[idx] = textureIndexLookup.getIndex(id, face);
      }
    }
  }
  
  // Get fluid texture indices
  let waterStillIdx = 0;
  let waterFlowIdx = 0;
  let lavaStillIdx = 0;
  let lavaFlowIdx = 0;
  
  if (textureIndexLookup) {
    waterStillIdx = textureIndexLookup.getIndexByPath('block/water_still') || 0;
    waterFlowIdx = textureIndexLookup.getIndexByPath('block/water_flow') || waterStillIdx;
    lavaStillIdx = textureIndexLookup.getIndexByPath('block/lava_still') || 0;
    lavaFlowIdx = textureIndexLookup.getIndexByPath('block/lava_flow') || lavaStillIdx;
  }
  
  return {
    isOpaque,
    isNonCube,
    isSlab,
    isFluid,
    isGlass,
    isAOTransparent,
    colorR,
    colorG,
    colorB,
    faceTintTypes,
    textureIndices,
    waterStillIdx,
    waterFlowIdx,
    lavaStillIdx,
    lavaFlowIdx,
  };
}

export default {
  initWasmMesher,
  isWasmAvailable,
  initLookups,
  meshChunk,
  buildLookupTables,
  serializeGrid,
  serializeLightGrid,
  serializeStateGrid,
};

