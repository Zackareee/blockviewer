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

// Track if block registry has been initialized
let blockRegistryInitialized = false;

/**
 * Check if the unified WASM pipeline is ready
 * Requires both WASM module and block registry to be initialized
 */
export function isUnifiedPipelineReady() {
  return isWasmAvailable() && blockRegistryInitialized;
}

/**
 * Initialize block registry in WASM (call once after loading BlockRegistry)
 * This enables the unified pipeline where NBT parsing happens in WASM.
 * 
 * @param {BlockRegistry} registry - The block registry with name-to-ID mappings
 */
export function initBlockRegistry(registry) {
  if (!isWasmAvailable()) {
    console.warn('[WasmMesher] Cannot init block registry - WASM not available');
    return false;
  }
  
  if (blockRegistryInitialized) {
    console.log('[WasmMesher] Block registry already initialized');
    return true;
  }
  
  const names = [];
  const ids = [];
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info?.name) {
      names.push(info.name);
      ids.push(id);
    }
  }
  
  try {
    wasmModule.init_block_registry(names, new Uint16Array(ids));
    blockRegistryInitialized = true;
    console.log(`[WasmMesher] Block registry initialized with ${names.length} blocks`);
    return true;
  } catch (error) {
    console.error('[WasmMesher] Failed to init block registry:', error);
    return false;
  }
}

/**
 * Process a chunk directly from compressed bytes using the unified WASM pipeline
 * 
 * This is the high-performance path that handles:
 * 1. Decompression (zlib/gzip)
 * 2. NBT parsing
 * 3. Chunk decoding to grids
 * 4. Greedy meshing
 * 
 * All in WASM with no JS↔WASM boundary crossing for grid data.
 * 
 * @param {Uint8Array} compressedData - Raw compressed chunk data from region file
 * @param {number} compressionType - Compression type: 1=gzip, 2=zlib, 3=uncompressed
 * @param {number} chunkX - Chunk X coordinate in world space
 * @param {number} chunkZ - Chunk Z coordinate in world space
 * @returns {Object|null} Processed chunk result with mesh buffers, or null on failure
 */
export function processChunk(compressedData, compressionType, chunkX, chunkZ) {
  if (!isUnifiedPipelineReady()) {
    console.warn('[WasmMesher] Unified pipeline not ready');
    return null;
  }
  
  try {
    const result = wasmModule.process_chunk(compressedData, compressionType, chunkX, chunkZ);
    
    if (!result.success) {
      console.warn(`[WasmMesher] process_chunk failed: ${result.error_message}`);
      return null;
    }
    
    // Parse particle emitters from flat array [blockId, x, y, z, ...]
    const emitterData = result.particle_emitters;
    const particleEmitters = [];
    for (let i = 0; i < emitterData.length; i += 4) {
      particleEmitters.push({
        blockId: emitterData[i],
        x: emitterData[i + 1],
        y: emitterData[i + 2],
        z: emitterData[i + 3],
      });
    }
    
    // Extract mesh data from result
    return {
      blocksDecoded: result.blocks_decoded,
      chunkX: result.chunk_x,
      chunkZ: result.chunk_z,
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
      // Model meshes (non-cube blocks like slabs, stairs, etc.)
      modelOpaque: {
        positions: new Float32Array(result.model_opaque_positions),
        normals: new Float32Array(result.model_opaque_normals),
        colors: new Float32Array(result.model_opaque_colors),
        uvs: new Float32Array(result.model_opaque_uvs),
        texIndices: new Float32Array(result.model_opaque_tex_indices),
        tintTypes: new Float32Array(result.model_opaque_tint_types),
        skyLight: new Float32Array(result.model_opaque_sky_light),
        blockLight: new Float32Array(result.model_opaque_block_light),
        indices: new Uint32Array(result.model_opaque_indices),
        vertexCount: result.model_opaque_vertex_count,
      },
      modelTransparent: {
        positions: new Float32Array(result.model_transparent_positions),
        normals: new Float32Array(result.model_transparent_normals),
        colors: new Float32Array(result.model_transparent_colors),
        uvs: new Float32Array(result.model_transparent_uvs),
        texIndices: new Float32Array(result.model_transparent_tex_indices),
        tintTypes: new Float32Array(result.model_transparent_tint_types),
        skyLight: new Float32Array(result.model_transparent_sky_light),
        blockLight: new Float32Array(result.model_transparent_block_light),
        indices: new Uint32Array(result.model_transparent_indices),
        vertexCount: result.model_transparent_vertex_count,
      },
      particleEmitters,
    };
  } catch (error) {
    console.error('[WasmMesher] processChunk error:', error);
    return null;
  }
}

// Track if state registry has been initialized
let stateRegistryInitialized = false;
let modelRegistryInitialized = false;

/**
 * Initialize state registry in WASM for model block resolution
 * This maps state strings to state IDs for model meshing.
 * 
 * @param {StateRegistry} stateRegistry - The state registry with state mappings
 */
export function initStateRegistry(stateRegistry) {
  if (!isWasmAvailable()) {
    console.warn('[WasmMesher] Cannot init state registry - WASM not available');
    return false;
  }
  
  if (stateRegistryInitialized) {
    console.log('[WasmMesher] State registry already initialized');
    return true;
  }
  
  try {
    // Collect state strings and IDs
    const stateStrings = [];
    const stateIds = [];
    
    for (const state of stateRegistry.states) {
      if (!state) continue;
      
      // Build state string: "minecraft:block_name[prop1=val1,prop2=val2]"
      let stateString = `minecraft:${state.blockName}`;
      if (state.propsKey && state.propsKey !== '') {
        stateString += `[${state.propsKey}]`;
      }
      
      stateStrings.push(stateString);
      stateIds.push(state.id);
    }
    
    if (stateStrings.length > 0) {
      // Pass as newline-separated string + array
      wasmModule.init_state_registry(stateStrings.join('\n'), new Uint16Array(stateIds));
      stateRegistryInitialized = true;
      console.log(`[WasmMesher] State registry initialized with ${stateStrings.length} states`);
    }
    
    return true;
  } catch (error) {
    console.error('[WasmMesher] Failed to init state registry:', error);
    return false;
  }
}

/**
 * Initialize model registry in WASM with pre-computed geometry
 * This enables WASM to mesh model blocks without JS callbacks.
 * 
 * @param {StateRegistry} stateRegistry - The state registry with geometry data
 */
export function initModelRegistry(stateRegistry) {
  if (!isWasmAvailable()) {
    console.warn('[WasmMesher] Cannot init model registry - WASM not available');
    return false;
  }
  
  if (modelRegistryInitialized) {
    console.log('[WasmMesher] Model registry already initialized');
    return true;
  }
  
  try {
    const startTime = performance.now();
    
    // Serialize all geometry to binary format
    const { stateIds, geometryData, faceCount } = serializeModelGeometry(stateRegistry);
    
    if (stateIds.length === 0) {
      console.warn('[WasmMesher] No model geometry to initialize');
      return false;
    }
    
    // Pass to WASM
    wasmModule.init_model_registry(new Uint16Array(stateIds), geometryData);
    modelRegistryInitialized = true;
    
    const elapsed = (performance.now() - startTime).toFixed(1);
    console.log(`[WasmMesher] Model registry initialized: ${stateIds.length} states, ${faceCount} faces, ${(geometryData.length / 1024).toFixed(1)}KB in ${elapsed}ms`);
    
    return true;
  } catch (error) {
    console.error('[WasmMesher] Failed to init model registry:', error);
    return false;
  }
}

// Track if hash-based model registry has been initialized
let hashModelRegistryInitialized = false;

/**
 * Initialize hash-based model registry in WASM
 * This is the preferred method for WASM model meshing as it doesn't require
 * synchronized state IDs between main thread and workers.
 * 
 * @param {StateRegistry} stateRegistry - The state registry with geometry data
 * @returns {boolean} True if initialization succeeded
 */
export function initHashModelRegistry(stateRegistry) {
  if (!isWasmAvailable()) {
    console.warn('[WasmMesher] Cannot init hash model registry - WASM not available');
    return false;
  }
  
  if (hashModelRegistryInitialized) {
    console.log('[WasmMesher] Hash model registry already initialized');
    return true;
  }
  
  try {
    const startTime = performance.now();
    
    // Get hash-based export from state registry
    const exportData = stateRegistry.exportHashModelGeometryForWasm?.();
    
    if (!exportData || !exportData.stateStrings || exportData.stateCount === 0) {
      console.warn('[WasmMesher] No model geometry to initialize for hash registry');
      return false;
    }
    
    const { stateStrings, geometryData, faceCount, stateCount } = exportData;
    
    // Call WASM init function with state strings
    wasmModule.init_hash_model_registry(stateStrings, geometryData);
    hashModelRegistryInitialized = true;
    
    const elapsed = (performance.now() - startTime).toFixed(1);
    console.log(`[WasmMesher] Hash model registry initialized: ${stateCount} states, ${faceCount} faces, ${(geometryData.length / 1024).toFixed(1)}KB in ${elapsed}ms`);
    
    return true;
  } catch (error) {
    console.error('[WasmMesher] Failed to init hash model registry:', error);
    return false;
  }
}

/**
 * Check if hash-based model registry is initialized
 * @returns {boolean}
 */
export function isHashModelRegistryReady() {
  return hashModelRegistryInitialized;
}

/**
 * Serialize model geometry to binary format for WASM
 * 
 * Format per model:
 *   [num_faces: u16]
 *   [face data...]
 * 
 * Face format (84 bytes):
 *   [direction: u8] (0=down, 1=up, 2=north, 3=south, 4=west, 5=east, 6=none)
 *   [vertices: 4 * 3 * f32] (48 bytes) - 4 corners, xyz each
 *   [uvs: 4 * 2 * f32] (32 bytes) - 4 corners, uv each
 *   [texture_index: u16]
 *   [tint_type: u8]
 *   [cull_face: u8] (which direction to check for culling, 255=none)
 * 
 * @param {StateRegistry} stateRegistry - The state registry with geometry
 * @returns {{ stateIds: number[], geometryData: Uint8Array, faceCount: number }}
 */
function serializeModelGeometry(stateRegistry) {
  const stateIds = [];
  const chunks = [];
  let totalFaces = 0;
  
  for (const state of stateRegistry.states) {
    if (!state || !state.geometry || state.geometry.length === 0) continue;
    
    // Use first geometry variant (most models have only one)
    const geom = state.geometry[0];
    if (!geom || !geom.positions || geom.positions.length === 0) continue;
    if (!geom.faces || geom.faces.length === 0) continue;
    
    stateIds.push(state.id);
    
    // Build face data from the geometry
    const faces = extractFacesFromGeometry(geom);
    totalFaces += faces.length;
    
    // Serialize: [num_faces: u16][face data...]
    const faceDataSize = faces.length * 84; // 84 bytes per face
    const chunkSize = 2 + faceDataSize;
    const chunk = new Uint8Array(chunkSize);
    const view = new DataView(chunk.buffer);
    
    // Write face count
    view.setUint16(0, faces.length, true);
    
    // Write each face
    let offset = 2;
    for (const face of faces) {
      // Direction (0-6)
      chunk[offset] = face.direction;
      offset += 1;
      
      // 4 vertices, 3 floats each
      for (let v = 0; v < 4; v++) {
        for (let c = 0; c < 3; c++) {
          view.setFloat32(offset, face.vertices[v][c], true);
          offset += 4;
        }
      }
      
      // 4 UVs, 2 floats each
      for (let v = 0; v < 4; v++) {
        for (let c = 0; c < 2; c++) {
          view.setFloat32(offset, face.uvs[v][c], true);
          offset += 4;
        }
      }
      
      // Texture index
      view.setUint16(offset, face.textureIndex, true);
      offset += 2;
      
      // Tint type
      chunk[offset] = face.tintType;
      offset += 1;
      
      // Cull face
      chunk[offset] = face.cullFace;
      offset += 1;
    }
    
    chunks.push(chunk);
  }
  
  // Concatenate all chunks
  const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
  const geometryData = new Uint8Array(totalSize);
  let writeOffset = 0;
  for (const chunk of chunks) {
    geometryData.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  
  return { stateIds, geometryData, faceCount: totalFaces };
}

/**
 * Extract face data from pre-computed geometry
 * Each face has 4 vertices forming a quad
 */
function extractFacesFromGeometry(geom) {
  const faces = [];
  
  if (!geom.faces || !geom.positions) return faces;
  
  let vertexOffset = 0;
  
  for (const faceInfo of geom.faces) {
    const vertexCount = faceInfo.vertexCount || 4;
    if (vertexCount < 4) {
      vertexOffset += vertexCount;
      continue;
    }
    
    // Extract 4 vertices for this face
    const vertices = [];
    const uvs = [];
    
    for (let i = 0; i < 4; i++) {
      const vi = vertexOffset + i;
      vertices.push([
        geom.positions[vi * 3 + 0] || 0,
        geom.positions[vi * 3 + 1] || 0,
        geom.positions[vi * 3 + 2] || 0,
      ]);
      
      if (geom.uvs) {
        uvs.push([
          geom.uvs[vi * 2 + 0] || 0,
          geom.uvs[vi * 2 + 1] || 0,
        ]);
      } else {
        uvs.push([0, 0]);
      }
    }
    
    // Convert normal to direction
    const normal = faceInfo.normal || [0, 1, 0];
    const direction = normalToDirection(normal);
    
    // Convert cullFace to direction byte
    let cullFace = 255; // 255 = never cull
    if (faceInfo.cullFace) {
      cullFace = cullFaceToDirection(faceInfo.cullFace);
    }
    
    // Texture index
    const textureIndex = faceInfo.textureIndex || 0;
    
    // Tint type (0=none, 1=grass, 2=foliage, 3=water, etc.)
    const tintType = faceInfo.tintIndex >= 0 ? (faceInfo.tintIndex + 1) : 0;
    
    faces.push({
      direction,
      vertices,
      uvs,
      textureIndex,
      tintType,
      cullFace,
    });
    
    vertexOffset += vertexCount;
  }
  
  return faces;
}

/**
 * Convert normal vector to direction byte
 */
function normalToDirection(normal) {
  const [nx, ny, nz] = normal;
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  
  if (ay >= ax && ay >= az) {
    return ny < 0 ? 0 : 1; // down=0, up=1
  } else if (az >= ax) {
    return nz < 0 ? 2 : 3; // north=2, south=3
  } else {
    return nx < 0 ? 4 : 5; // west=4, east=5
  }
}

/**
 * Convert cull face string to direction byte
 */
function cullFaceToDirection(cullFace) {
  switch (cullFace) {
    case 'down': return 0;
    case 'up': return 1;
    case 'north': return 2;
    case 'south': return 3;
    case 'west': return 4;
    case 'east': return 5;
    default: return 255; // Never cull
  }
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
    lookups.isRotatable,
    lookups.isDirectional,
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
import { isRotatableBlock } from '../../assets/BlockTextureRegistry.js';

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
  const isRotatable = new Uint8Array(MAX_BLOCKS);
  const isDirectional = new Uint8Array(MAX_BLOCKS); // Blocks with horizontal facing (furnace, loom, etc.)
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
    isRotatable[id] = (info.name && isRotatableBlock(info.name)) ? 1 : 0;
    
    // Directional blocks with horizontal facing
    if (info.name) {
      const DIRECTIONAL_BLOCKS = ['furnace', 'blast_furnace', 'smoker', 'loom', 'carved_pumpkin', 'jack_o_lantern'];
      if (DIRECTIONAL_BLOCKS.some(b => info.name === b || info.name === `minecraft:${b}`)) {
        isDirectional[id] = 1;
      }
    }
    
    const col = registry.getColor(id);
    colorR[id] = col.r;
    colorG[id] = col.g;
    colorB[id] = col.b;
    
    if (info.name) {
      // Fluid detection (but exclude cauldrons which contain fluid internally)
      const isCauldron = info.name.includes('cauldron');
      if (info.name.includes('water') && !isCauldron) {
        isFluid[id] = 1;
      } else if (info.name.includes('lava') && !isCauldron) {
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
    isRotatable,     // For logs, pillars, etc.
    isDirectional,   // For horizontal facing blocks (furnace, loom, etc.)
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
  isUnifiedPipelineReady,
  initBlockRegistry,
  initStateRegistry,
  initModelRegistry,
  processChunk,
  initLookups,
  meshChunk,
  buildLookupTables,
  serializeGrid,
  serializeLightGrid,
  serializeStateGrid,
};

