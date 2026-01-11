/**
 * StateRegistry - Efficient block state to variant ID mapping
 * 
 * Maps unique (blockName, properties) combinations to numeric IDs
 * for compact storage in the block grid.
 * 
 * Also caches pre-resolved model variants for each state.
 */

import { getBlockstateResolver } from './BlockstateResolver.js';
import { getModelResolver } from './ModelResolver.js';
import { getModelGeometry } from './ModelGeometry.js';

// Blocks that use texture rotation instead of model rotation
// For these blocks, we only store the base (non-rotated) geometry
// and apply rotation via the texRotation vertex attribute in the shader
// NOTE: Only use for FLAT PLANE blocks where UV rotation is equivalent to model rotation
// Complex models with positioned elements (stems, etc.) need actual model rotation
const TEXTURE_ROTATION_BLOCKS = new Set([
  // Position-based random rotation (no facing property)
  'lily_pad',
  
  // Facing-based rotation (flat plane multipart with facing property)
  'leaf_litter',
]);

// Blocks that have random Y-rotation in their blockstate (as variant arrays)
// but need actual MODEL rotation applied at render time by ModelMesher.
// For these blocks, we only store the base (non-rotated) geometry.
const MODEL_ROTATION_BLOCKS = new Set([
  // Cross-model plants
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  'nether_sprouts', 'crimson_roots', 'warped_roots',
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower', 'pink_petals', 'eyeblossom', 'dead_bush',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'pale_oak_sapling', 'hanging_roots', 'spore_blossom',
  'red_mushroom', 'brown_mushroom', 'crimson_fungus', 'warped_fungus',
  // 3D models with rotation variants
  'sea_pickle',
  // Path blocks - have 4 rotation variants that would cause z-fighting if all rendered
  'dirt_path', 'farmland',
]);

/**
 * Registered block state with cached data
 * @typedef {Object} BlockState
 * @property {number} id - Unique state ID
 * @property {string} blockName - Block name (without minecraft:)
 * @property {Object} properties - Block properties
 * @property {string} propsKey - Sorted properties string for lookup
 * @property {Array} variants - Resolved model variants
 * @property {Array} geometry - Pre-computed geometry per variant
 * @property {boolean} isFullCube - Whether all variants are full cubes
 */

class StateRegistry {
  constructor() {
    // State ID → BlockState
    this.states = [];
    
    // "blockName|propsKey" → state ID
    this.lookup = new Map();
    
    // Block name → Set of state IDs for that block
    this.byBlock = new Map();
    
    // Next available ID (start at 1; 0 is reserved as "no state" sentinel)
    this.nextId = 1;
    
    // Resolver references (set on init)
    this.blockstateResolver = null;
    this.modelResolver = null;
    this.modelGeometry = null;
    
    // Track initialization
    this.initialized = false;
  }

  /**
   * Initialize with resolver instances
   */
  async init() {
    if (this.initialized) return;
    
    this.blockstateResolver = getBlockstateResolver();
    this.modelResolver = getModelResolver();
    this.modelGeometry = getModelGeometry();
    
    this.initialized = true;
  }

  /**
   * Register a block state and return its ID
   * Returns existing ID if already registered
   * 
   * @param {string} blockName - Block name (with or without minecraft:)
   * @param {Object} properties - Block properties
   * @returns {number} State ID
   */
  register(blockName, properties = {}) {
    const normalized = blockName.replace('minecraft:', '');
    const propsKey = this._buildPropsKey(properties);
    const lookupKey = `${normalized}|${propsKey}`;

    // Check if already registered
    if (this.lookup.has(lookupKey)) {
      return this.lookup.get(lookupKey);
    }

    // Create new state
    const id = this.nextId++;
    const state = {
      id,
      blockName: normalized,
      properties: { ...properties },
      propsKey,
      variants: null,      // Lazy resolved
      geometry: null,      // Lazy computed
      isFullCube: null,    // Lazy determined
    };

    this.states[id] = state;
    this.lookup.set(lookupKey, id);

    // Track by block name
    if (!this.byBlock.has(normalized)) {
      this.byBlock.set(normalized, new Set());
    }
    this.byBlock.get(normalized).add(id);

    return id;
  }

  /**
   * Get state by ID
   */
  getState(stateId) {
    return this.states[stateId] || null;
  }

  /**
   * Get all states for a block
   */
  getStatesForBlock(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    const ids = this.byBlock.get(normalized);
    if (!ids) return [];
    return Array.from(ids).map(id => this.states[id]);
  }

  /**
   * Resolve model variants for a state (lazy, cached)
   */
  async resolveVariants(stateId) {
    const state = this.states[stateId];
    if (!state) return null;

    if (state.variants !== null) {
      return state.variants;
    }

    // Load blockstate if needed
    await this.blockstateResolver.getBlockstate(state.blockName);
    
    // Resolve variants
    state.variants = this.blockstateResolver.resolve(state.blockName, state.properties);
    
    return state.variants;
  }

  /**
   * Get pre-computed geometry for a state (lazy, cached)
   */
  async getGeometry(stateId) {
    const state = this.states[stateId];
    if (!state) return null;

    if (state.geometry !== null) {
      return state.geometry;
    }

    // Ensure variants are resolved
    await this.resolveVariants(stateId);
    if (!state.variants) return null;

    // Check if this block uses texture rotation instead of model rotation
    const usesTextureRotation = TEXTURE_ROTATION_BLOCKS.has(state.blockName);
    
    // Check if this block uses model rotation applied at render time
    const usesModelRotation = MODEL_ROTATION_BLOCKS.has(state.blockName);
    
    // For both texture and model rotation blocks, skip duplicate rotation variants
    const skipDuplicateRotations = usesTextureRotation || usesModelRotation;

    // Track which model paths we've already processed (to avoid duplicate geometries)
    // This prevents duplicate geometries when multiple rotation variants of the same model exist
    const processedModels = skipDuplicateRotations ? new Set() : null;

    // Compute geometry for each variant
    state.geometry = [];
    state.isFullCube = true;

    for (const variant of state.variants) {
      // For rotation blocks, skip duplicate rotation variants of the same model
      if (skipDuplicateRotations && processedModels.has(variant.model)) {
        continue;
      }

      const modelPath = variant.model.replace('minecraft:', '');
      const model = await this.modelResolver.resolve(modelPath);
      if (!model) continue;

      // For blocks with texture/model rotation at render time, use base geometry (no model rotation)
      const rotX = skipDuplicateRotations ? 0 : variant.x;
      const rotY = skipDuplicateRotations ? 0 : variant.y;
      
      // Pass uvlock flag - when true, UVs remain world-aligned even when model rotates
      const uvlock = variant.uvlock || false;

      // Pass model path and uvlock for proper caching and UV handling
      const geom = this.modelGeometry.getGeometry(model, rotX, rotY, modelPath, uvlock);
      if (geom) {
        state.geometry.push(geom);
        if (!geom.isFullCube) {
          state.isFullCube = false;
        }

        // Mark this model as processed
        if (skipDuplicateRotations) {
          processedModels.add(variant.model);
        }
      }
    }

    return state.geometry;
  }

  /**
   * Synchronous geometry access (only works if pre-computed)
   */
  getGeometrySync(stateId) {
    const state = this.states[stateId];
    return state?.geometry || null;
  }

  /**
   * Check if state is a full cube (synchronous, only if pre-computed)
   */
  isFullCubeSync(stateId) {
    const state = this.states[stateId];
    return state?.isFullCube ?? true; // Default to true for unknown
  }

  /**
   * Pre-load and compute geometry for all registered states
   * Call after chunk decoding to prepare for meshing
   * Optimized: only computes geometry for states that don't have it yet
   */
  async precomputeAll() {
    const promises = [];
    let alreadyComputed = 0;
    let needsComputation = 0;
    
    for (let i = 0; i < this.nextId; i++) {
      // Skip states that already have geometry computed
      if (this.states[i]?.geometry) {
        alreadyComputed++;
        continue;
      }
      needsComputation++;
      promises.push(this.getGeometry(i));
    }
    
    console.log(`[StateRegistry] precomputeAll: ${needsComputation} need computation, ${alreadyComputed} already done, total ${this.nextId} states`);
    
    // Only await if there are new states to compute
    if (promises.length > 0) {
      await Promise.all(promises);
      
      // Check how many now have geometry
      let withGeometry = 0;
      for (let i = 0; i < this.nextId; i++) {
        if (this.states[i]?.geometry && this.states[i].geometry.length > 0) {
          withGeometry++;
        }
      }
      console.log(`[StateRegistry] precomputeAll complete: ${withGeometry} states now have geometry`);
    }
  }

  /**
   * Pre-load geometry for specific block types (common blocks)
   */
  async precomputeBlocks(blockNames) {
    const promises = [];
    for (const name of blockNames) {
      const states = this.getStatesForBlock(name);
      for (const state of states) {
        promises.push(this.getGeometry(state.id));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Pre-register all non-cube blocks from a BlockRegistry with ALL state variants
   * This populates the registry BEFORE chunk decoding so WASM can use it.
   * 
   * Enumerates ALL possible state combinations from blockstate JSON files.
   * This is critical for WASM model meshing to work without main thread fallback.
   * 
   * @param {BlockRegistry} blockRegistry - The block registry with all known blocks
   * @param {Object} options - Options for registration
   * @param {boolean} options.precomputeGeometry - Whether to precompute geometry (default: true)
   * @param {Function} options.onProgress - Progress callback (registered, total)
   * @returns {Promise<number>} Number of states registered
   */
  async preregisterNonCubeBlocks(blockRegistry, options = {}) {
    const { precomputeGeometry = true, onProgress = null } = options;
    
    let registered = 0;
    let skippedExplosive = 0;
    const startTime = performance.now();
    
    // Maximum state variants per block to prevent combinatorial explosion
    // e.g., redstone_wire has 1296 states (4^5 * 4), we cap these
    const MAX_VARIANTS_PER_BLOCK = 256;
    
    // Collect all non-cube blocks first
    const nonCubeBlocks = [];
    for (let id = 0; id < 4096; id++) {
      const info = blockRegistry.getBlockInfo(id);
      if (!info || !info.name) continue;
      if (!blockRegistry.isNonCube(id)) continue;
      nonCubeBlocks.push(info.name.replace('minecraft:', ''));
    }
    
    console.log(`[StateRegistry] Enumerating states for ${nonCubeBlocks.length} non-cube blocks...`);
    
    // Load all blockstates first
    await this.blockstateResolver.preloadMany(nonCubeBlocks);
    
    // Enumerate all state variants for each block
    for (const blockName of nonCubeBlocks) {
      const domains = this.blockstateResolver.extractPropertyDomains(blockName);
      
      if (!domains || Object.keys(domains).length === 0) {
        // No properties - register single default state
        this.register(blockName, {});
        registered++;
        continue;
      }
      
      // Calculate total combinations
      const combinations = this.blockstateResolver.generateAllCombinations(domains);
      
      if (combinations.length > MAX_VARIANTS_PER_BLOCK) {
        // Too many variants - register only common ones and log
        skippedExplosive++;
        // Register default state
        this.register(blockName, {});
        registered++;
        
        // Register first N variants as a reasonable subset
        for (let i = 0; i < Math.min(MAX_VARIANTS_PER_BLOCK, combinations.length); i++) {
          this.register(blockName, combinations[i]);
          registered++;
        }
        continue;
      }
      
      // Register all combinations
      for (const props of combinations) {
        this.register(blockName, props);
        registered++;
      }
      
      // Progress callback every 50 blocks
      if (onProgress && nonCubeBlocks.indexOf(blockName) % 50 === 0) {
        onProgress(registered, nonCubeBlocks.length);
      }
    }
    
    const enumTime = performance.now() - startTime;
    console.log(`[StateRegistry] Enumerated ${registered} states in ${enumTime.toFixed(0)}ms (${skippedExplosive} blocks capped)`);
    
    // Precompute geometry for all registered states
    if (precomputeGeometry) {
      const geomStart = performance.now();
      await this.precomputeAll();
      const geomTime = performance.now() - geomStart;
      console.log(`[StateRegistry] Precomputed geometry in ${geomTime.toFixed(0)}ms`);
    }
    
    const totalTime = performance.now() - startTime;
    console.log(`[StateRegistry] Pre-registered ${registered} non-cube block states in ${totalTime.toFixed(0)}ms`);
    return registered;
  }

  /**
   * Build sorted properties key
   */
  _buildPropsKey(properties) {
    if (!properties || Object.keys(properties).length === 0) {
      return '';
    }
    return Object.entries(properties)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }

  /**
   * Get statistics
   */
  getStats() {
    let precomputed = 0;
    let fullCubes = 0;
    
    for (const state of this.states) {
      if (state.geometry !== null) precomputed++;
      if (state.isFullCube) fullCubes++;
    }

    return {
      totalStates: this.nextId,
      uniqueBlocks: this.byBlock.size,
      precomputed,
      fullCubes,
    };
  }

  /**
   * Clear all registered states
   */
  clear() {
    this.states = [];
    this.lookup.clear();
    this.byBlock.clear();
    this.nextId = 0;
  }

  /**
   * Export state registry for WASM worker initialization
   * Returns data in format expected by WASM init_state_registry
   * @returns {{ stateStrings: string[], stateIds: number[] }}
   */
  exportStateStringsForWasm() {
    const stateStrings = [];
    const stateIds = [];
    
    for (let i = 1; i < this.nextId; i++) {
      const state = this.states[i];
      if (!state) continue;
      
      // Build state string in format: "minecraft:block_name[prop1=val1,prop2=val2]"
      let stateStr = `minecraft:${state.blockName}`;
      if (state.propsKey) {
        stateStr += `[${state.propsKey}]`;
      }
      
      stateStrings.push(stateStr);
      stateIds.push(state.id);
    }
    
    return { stateStrings, stateIds };
  }

  /**
   * Export model geometry for WASM worker initialization
   * Returns data in format expected by WASM init_model_registry
   * @param {Object} textureIndexLookup - Maps texture paths to atlas indices
   * @returns {{ stateIds: number[], geometryData: Uint8Array, faceCount: number }}
   */
  exportModelGeometryForWasm(textureIndexLookup) {
    const stateIds = [];
    const geometryChunks = [];
    let totalFaceCount = 0;
    
    // Direction name to index mapping (matches WASM Face enum)
    // WASM: Up=0, Down=1, North=2, South=3, East=4, West=5
    const DIRECTION_MAP = {
      'up': 0, 'down': 1, 'north': 2, 'south': 3, 'east': 4, 'west': 5
    };
    
    for (let i = 1; i < this.nextId; i++) {
      const state = this.states[i];
      if (!state || !state.geometry || state.geometry.length === 0) continue;
      
      // Collect all faces from all variants
      const allFaces = [];
      
      for (const geom of state.geometry) {
        if (!geom || !geom.positions || !geom.cullFaces) continue;
        
        // Extract face data for each cullFace entry
        for (const face of geom.cullFaces) {
          // Get the first vertex index (same approach as JS ModelMesher)
          // The indices array stores [v0, v2, v1, v0, v3, v2] for CCW winding
          // The first index points to v0, and vertices are laid out consecutively as v0, v1, v2, v3
          const srcVertexStart = geom.indices[face.indexStart];
          
          // Validate we have enough vertices
          if (srcVertexStart + 3 >= geom.positions.length / 3) continue;
          
          // Read 4 CONSECUTIVE vertices starting from srcVertexStart
          // This matches how JS ModelMesher reads geometry and preserves correct vertex order
          const vertices = [];
          const uvs = [];
          for (let i = 0; i < 4; i++) {
            const vi = srcVertexStart + i;
            vertices.push([
              geom.positions[vi * 3],
              geom.positions[vi * 3 + 1],
              geom.positions[vi * 3 + 2]
            ]);
            uvs.push([
              geom.uvs[vi * 2],
              geom.uvs[vi * 2 + 1]
            ]);
          }
          
          // Get texture index from TextureIndexLookup class
          let textureIndex = 0;
          if (textureIndexLookup && face.texture) {
            const texPath = face.texture.replace('minecraft:', '');
            // textureIndexLookup is a TextureIndexLookup class with a texturePathToIndex Map
            const pathMap = textureIndexLookup.texturePathToIndex || textureIndexLookup;
            textureIndex = pathMap.get?.(texPath) ?? pathMap.get?.(`block/${texPath}`) ?? 0;
          }
          
          // Get direction
          const direction = DIRECTION_MAP[face.faceDirection] ?? 6; // 6 = none
          
          // Get tint type (tintindex: -1 means no tint, 0+ means biome color)
          const tintType = face.tintindex >= 0 ? 1 : 0; // 1 = biome tint, 0 = no tint
          
          // Get cull face
          const cullFace = face.cullface ? (DIRECTION_MAP[face.cullface] ?? 255) : 255;
          
          allFaces.push({
            direction,
            vertices,
            uvs,
            textureIndex,
            tintType,
            cullFace
          });
        }
      }
      
      if (allFaces.length === 0) continue;
      
      stateIds.push(state.id);
      totalFaceCount += allFaces.length;
      
      // Serialize faces for this state
      // Format: [num_faces: u16] + [face data]...
      // Face: direction(1) + vertices(48) + uvs(32) + texIdx(2) + tintType(1) + cullFace(1) = 85 bytes
      const FACE_SIZE = 1 + 48 + 32 + 2 + 1 + 1; // 85 bytes
      const chunkSize = 2 + allFaces.length * FACE_SIZE;
      const chunk = new Uint8Array(chunkSize);
      const view = new DataView(chunk.buffer);
      
      // Write num_faces
      view.setUint16(0, allFaces.length, true);
      
      let offset = 2;
      for (const face of allFaces) {
        // Direction (1 byte)
        chunk[offset++] = face.direction;
        
        // Vertices (4 * 3 * 4 = 48 bytes)
        for (let v = 0; v < 4; v++) {
          for (let c = 0; c < 3; c++) {
            view.setFloat32(offset, face.vertices[v][c], true);
            offset += 4;
          }
        }
        
        // UVs (4 * 2 * 4 = 32 bytes)
        for (let v = 0; v < 4; v++) {
          for (let c = 0; c < 2; c++) {
            view.setFloat32(offset, face.uvs[v][c], true);
            offset += 4;
          }
        }
        
        // Texture index (2 bytes)
        view.setUint16(offset, face.textureIndex, true);
        offset += 2;
        
        // Tint type (1 byte)
        chunk[offset++] = face.tintType;
        
        // Cull face (1 byte)
        chunk[offset++] = face.cullFace;
      }
      
      geometryChunks.push(chunk);
    }
    
    // Concatenate all chunks
    const totalSize = geometryChunks.reduce((sum, c) => sum + c.length, 0);
    const geometryData = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of geometryChunks) {
      geometryData.set(chunk, offset);
      offset += chunk.length;
    }
    
    return { stateIds, geometryData, faceCount: totalFaceCount };
  }

  /**
   * Reset all cached geometry (forces recomputation on next access)
   * Call this after rotation code changes
   */
  resetGeometry() {
    for (const state of this.states) {
      state.geometry = null;
      state.variants = null;
    }
    // Also clear the ModelGeometry cache
    if (this.modelGeometry) {
      this.modelGeometry.clearCache();
    }
    console.log('[StateRegistry] Geometry cache cleared');
  }

  /**
   * Export registry data for worker transfer
   * Only exports states with pre-computed geometry
   */
  export() {
    const statesData = [];
    
    for (let i = 0; i < this.nextId; i++) {
      const state = this.states[i];
      if (!state || !state.geometry) continue;
      
      // Serialize geometry arrays
      const geometryData = state.geometry.map(geom => ({
        positions: geom.positions ? Array.from(geom.positions) : null,
        normals: geom.normals ? Array.from(geom.normals) : null,
        uvs: geom.uvs ? Array.from(geom.uvs) : null,
        texIndices: geom.texIndices ? Array.from(geom.texIndices) : null,
        colors: geom.colors ? Array.from(geom.colors) : null,
        indices: geom.indices ? Array.from(geom.indices) : null,
        isFullCube: geom.isFullCube,
        isTransparent: geom.isTransparent,
        isOverlay: geom.isOverlay,
        hasShade: geom.hasShade,
        faces: geom.faces ? geom.faces.map(face => ({
          normal: face.normal,
          cullFace: face.cullFace,
          vertexCount: face.vertexCount,
          tintIndex: face.tintIndex,
          textureIndex: face.textureIndex,
          shade: face.shade,
        })) : null,
      }));
      
      statesData.push({
        id: state.id,
        blockName: state.blockName,
        properties: state.properties,
        propsKey: state.propsKey,
        geometry: geometryData,
        isFullCube: state.isFullCube,
      });
    }
    
    return {
      states: statesData,
      nextId: this.nextId,
    };
  }

  /**
   * Import registry data from export (for workers)
   */
  static import(data) {
    const registry = new StateRegistry();
    registry.initialized = true; // Workers don't need resolvers
    
    for (const stateData of data.states) {
      // Reconstruct geometry with TypedArrays
      const geometry = stateData.geometry.map(geomData => ({
        positions: geomData.positions ? new Float32Array(geomData.positions) : null,
        normals: geomData.normals ? new Float32Array(geomData.normals) : null,
        uvs: geomData.uvs ? new Float32Array(geomData.uvs) : null,
        texIndices: geomData.texIndices ? new Uint16Array(geomData.texIndices) : null,
        colors: geomData.colors ? new Float32Array(geomData.colors) : null,
        indices: geomData.indices ? new Uint16Array(geomData.indices) : null,
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
        variants: null, // Not needed in worker
        geometry,
        isFullCube: stateData.isFullCube,
      };
      
      registry.states[state.id] = state;
      registry.lookup.set(`${state.blockName}|${state.propsKey}`, state.id);
      
      if (!registry.byBlock.has(state.blockName)) {
        registry.byBlock.set(state.blockName, new Set());
      }
      registry.byBlock.get(state.blockName).add(state.id);
    }
    
    registry.nextId = data.nextId;
    return registry;
  }

  /**
   * Export registry data for worker initialization in an efficient format
   * Returns data and a list of transferable ArrayBuffers for zero-copy transfer
   * 
   * @returns {{ data: Object, transferables: ArrayBuffer[] }}
   */
  exportForWorker() {
    const statesData = [];
    const transferables = [];
    
    for (let i = 0; i < this.nextId; i++) {
      const state = this.states[i];
      if (!state || !state.geometry) continue;
      
      // Collect all geometry data with cloned TypedArrays for transfer
      const geometryData = state.geometry.map(geom => {
        const data = {
          isFullCube: geom.isFullCube,
          isTransparent: geom.isTransparent,
          isOverlay: geom.isOverlay,
          hasShade: geom.hasShade,
        };
        
        // Clone TypedArrays so we can transfer them
        if (geom.positions && geom.positions.length > 0) {
          data.positions = geom.positions.slice();
          transferables.push(data.positions.buffer);
        }
        if (geom.normals && geom.normals.length > 0) {
          data.normals = geom.normals.slice();
          transferables.push(data.normals.buffer);
        }
        if (geom.uvs && geom.uvs.length > 0) {
          data.uvs = geom.uvs.slice();
          transferables.push(data.uvs.buffer);
        }
        if (geom.texIndices && geom.texIndices.length > 0) {
          data.texIndices = new Uint16Array(geom.texIndices);
          transferables.push(data.texIndices.buffer);
        }
        if (geom.colors && geom.colors.length > 0) {
          data.colors = geom.colors.slice();
          transferables.push(data.colors.buffer);
        }
        if (geom.indices && geom.indices.length > 0) {
          data.indices = new Uint16Array(geom.indices);
          transferables.push(data.indices.buffer);
        }
        
        // Face data for culling (not transferred, just cloned)
        if (geom.faces) {
          data.faces = geom.faces.map(face => ({
            normal: face.normal,
            cullFace: face.cullFace,
            vertexCount: face.vertexCount,
            tintIndex: face.tintIndex,
            textureIndex: face.textureIndex,
            shade: face.shade,
          }));
        }
        
        return data;
      });
      
      statesData.push({
        id: state.id,
        blockName: state.blockName,
        properties: state.properties,
        propsKey: state.propsKey,
        geometry: geometryData,
        isFullCube: state.isFullCube,
      });
    }
    
    // Build lookup table: blockName|propsKey -> stateId
    const lookupEntries = [];
    for (const [key, id] of this.lookup.entries()) {
      lookupEntries.push([key, id]);
    }
    
    const data = {
      states: statesData,
      lookup: lookupEntries,
      nextId: this.nextId,
    };
    
    console.log(`[StateRegistry] Exported ${statesData.length} states with ${transferables.length} transferable buffers`);
    
    return { data, transferables };
  }

  /**
   * Import registry data from exportForWorker (for use in workers)
   * Reconstructs the registry from transferred data
   * 
   * @param {Object} data - Data from exportForWorker
   * @returns {StateRegistry}
   */
  static importInWorker(data) {
    const registry = new StateRegistry();
    registry.initialized = true; // Workers don't need resolvers
    
    for (const stateData of data.states) {
      // Geometry data already has TypedArrays from transfer
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
        variants: null,
        geometry,
        isFullCube: stateData.isFullCube,
      };
      
      registry.states[state.id] = state;
      
      if (!registry.byBlock.has(state.blockName)) {
        registry.byBlock.set(state.blockName, new Set());
      }
      registry.byBlock.get(state.blockName).add(state.id);
    }
    
    // Restore lookup table
    for (const [key, id] of data.lookup) {
      registry.lookup.set(key, id);
    }
    
    registry.nextId = data.nextId;
    
    console.log(`[StateRegistry] Imported ${data.states.length} states in worker`);
    return registry;
  }

  // ============================================================================
  // FNV-1a Hashing (matches WASM implementation)
  // ============================================================================

  /**
   * Compute FNV-1a 64-bit hash of a string
   * This is a JavaScript implementation that matches the WASM fnv crate
   * 
   * @param {string} str - String to hash
   * @returns {BigInt} 64-bit hash value
   */
  static fnv1aHash(str) {
    // FNV-1a constants
    const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
    const FNV_PRIME = 0x100000001b3n;
    
    let hash = FNV_OFFSET_BASIS;
    
    // Hash each byte of the string
    for (let i = 0; i < str.length; i++) {
      const byte = BigInt(str.charCodeAt(i));
      hash ^= byte;
      hash = BigInt.asUintN(64, hash * FNV_PRIME);
    }
    
    // Add 0xff suffix to match Rust's str.hash() implementation
    hash ^= 0xFFn;
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
    
    return hash;
  }

  /**
   * Build canonical state string from blockName and properties
   * Format: "minecraft:block_name[prop1=val1,prop2=val2]"
   * Properties are sorted alphabetically for consistent hashing
   * 
   * @param {string} blockName - Block name (with or without minecraft:)
   * @param {Object} properties - Block properties
   * @returns {string} Canonical state string
   */
  static buildStateString(blockName, properties = {}) {
    const name = blockName.startsWith('minecraft:') ? blockName : `minecraft:${blockName}`;
    
    const keys = Object.keys(properties).sort();
    if (keys.length === 0) {
      return name;
    }
    
    const propsStr = keys.map(k => `${k}=${properties[k]}`).join(',');
    return `${name}[${propsStr}]`;
  }

  /**
   * Export model geometry with state strings for hash-based WASM lookup
   * This is the preferred method for WASM model meshing as it doesn't
   * require synchronized state IDs between main thread and workers.
   * 
   * @param {Object} textureIndexLookup - Maps texture paths to atlas indices
   * @returns {{ stateStrings: string, geometryData: Uint8Array, faceCount: number }}
   */
  exportHashModelGeometryForWasm(textureIndexLookup) {
    const stateStrings = [];
    const geometryChunks = [];
    let totalFaceCount = 0;
    
    // Direction name to index mapping (matches WASM Face enum)
    // WASM: Up=0, Down=1, North=2, South=3, East=4, West=5
    const DIRECTION_MAP = {
      'up': 0, 'down': 1, 'north': 2, 'south': 3, 'east': 4, 'west': 5
    };
    
    // Debug: Count states with and without geometry
    let withGeometry = 0;
    let withoutGeometry = 0;
    let noState = 0;
    
    // Debug first few states
    let debugCount = 0;
    
    for (let i = 1; i < this.nextId; i++) {
      const state = this.states[i];
      if (!state) { noState++; continue; }
      if (!state.geometry || state.geometry.length === 0) { 
        withoutGeometry++; 
        // Debug first few states without geometry
        if (debugCount < 3) {
          console.log(`[StateRegistry] State ${i} (${state.blockName}) has no geometry`);
          debugCount++;
        }
        continue; 
      }
      withGeometry++;
      
      // Build canonical state string
      const stateStr = StateRegistry.buildStateString(state.blockName, state.properties);
      const hash = StateRegistry.fnv1aHash(stateStr);
      
      // Debug: Log first 3 stairs and first 3 slabs for hash verification
      // This must match the WASM [WASM Registry] output format for comparison
      if (!this._stairsDebugCount) this._stairsDebugCount = 0;
      if (!this._slabDebugCount) this._slabDebugCount = 0;
      
      if (state.blockName.includes('stairs') && this._stairsDebugCount < 3) {
        this._stairsDebugCount++;
        console.log(`[JS Registry] Stairs registered: "${stateStr}" -> 0x${hash.toString(16)}`);
      }
      if (state.blockName.includes('_slab') && this._slabDebugCount < 3) {
        this._slabDebugCount++;
        console.log(`[JS Registry] Slab registered: "${stateStr}" -> 0x${hash.toString(16)}`);
      }
      
      // Collect all faces from all variants
      const allFaces = [];
      
      for (const geom of state.geometry) {
        if (!geom || !geom.positions || !geom.cullFaces) continue;
        
        // Extract face data for each cullFace entry
        for (const face of geom.cullFaces) {
          // Get the first vertex index (same approach as JS ModelMesher)
          // The indices array stores [v0, v2, v1, v0, v3, v2] for CCW winding
          // The first index points to v0, and vertices are laid out consecutively as v0, v1, v2, v3
          const srcVertexStart = geom.indices[face.indexStart];
          
          // Validate we have enough vertices
          if (srcVertexStart + 3 >= geom.positions.length / 3) continue;
          
          // Read 4 CONSECUTIVE vertices starting from srcVertexStart
          // This matches how JS ModelMesher reads geometry and preserves correct vertex order
          const vertices = [];
          const uvs = [];
          for (let i = 0; i < 4; i++) {
            const vi = srcVertexStart + i;
            vertices.push([
              geom.positions[vi * 3],
              geom.positions[vi * 3 + 1],
              geom.positions[vi * 3 + 2]
            ]);
            uvs.push([
              geom.uvs[vi * 2],
              geom.uvs[vi * 2 + 1]
            ]);
          }
          
          // Get texture index from TextureIndexLookup class
          let textureIndex = 0;
          if (textureIndexLookup && face.texture) {
            const texPath = face.texture.replace('minecraft:', '');
            // textureIndexLookup is a TextureIndexLookup class with a texturePathToIndex Map
            const pathMap = textureIndexLookup.texturePathToIndex || textureIndexLookup;
            textureIndex = pathMap.get?.(texPath) ?? pathMap.get?.(`block/${texPath}`) ?? 0;
          }
          
          // Get direction
          const direction = DIRECTION_MAP[face.faceDirection] ?? 6;
          
          // Get tint type
          const tintType = face.tintindex >= 0 ? 1 : 0;
          
          // Get cull face
          const cullFace = face.cullface ? (DIRECTION_MAP[face.cullface] ?? 255) : 255;
          
          allFaces.push({
            direction,
            vertices,
            uvs,
            textureIndex,
            tintType,
            cullFace
          });
        }
      }
      
      if (allFaces.length === 0) continue;
      
      stateStrings.push(stateStr);
      totalFaceCount += allFaces.length;
      
      // Serialize faces for this state (same format as exportModelGeometryForWasm)
      const FACE_SIZE = 1 + 48 + 32 + 2 + 1 + 1; // 85 bytes
      const chunkSize = 2 + allFaces.length * FACE_SIZE;
      const chunk = new Uint8Array(chunkSize);
      const view = new DataView(chunk.buffer);
      
      // Write num_faces
      view.setUint16(0, allFaces.length, true);
      
      let offset = 2;
      for (const face of allFaces) {
        chunk[offset++] = face.direction;
        
        for (let v = 0; v < 4; v++) {
          for (let c = 0; c < 3; c++) {
            view.setFloat32(offset, face.vertices[v][c], true);
            offset += 4;
          }
        }
        
        for (let v = 0; v < 4; v++) {
          for (let c = 0; c < 2; c++) {
            view.setFloat32(offset, face.uvs[v][c], true);
            offset += 4;
          }
        }
        
        view.setUint16(offset, face.textureIndex, true);
        offset += 2;
        
        chunk[offset++] = face.tintType;
        chunk[offset++] = face.cullFace;
      }
      
      geometryChunks.push(chunk);
    }
    
    // Concatenate all chunks
    const totalSize = geometryChunks.reduce((sum, c) => sum + c.length, 0);
    const geometryData = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of geometryChunks) {
      geometryData.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Debug: Log geometry status
    console.log(`[StateRegistry] exportHashModelGeometryForWasm: ${withGeometry} states with geometry, ${withoutGeometry} without, ${noState} null, nextId=${this.nextId}`);
    
    // Debug: Check if oak_stairs was exported
    const stairsStates = stateStrings.filter(s => s.includes('oak_stairs'));
    console.log(`[StateRegistry] Exported ${stairsStates.length} oak_stairs states, sample:`, stairsStates.slice(0, 3));
    
    // Return state strings as newline-separated string for WASM
    return { 
      stateStrings: stateStrings.join('\n'), 
      geometryData, 
      faceCount: totalFaceCount,
      stateCount: stateStrings.length
    };
  }

  /**
   * Pre-register and pre-compute geometry for ALL possible block states
   * This is called at texture pack load to ensure WASM has all geometry
   * 
   * @param {Object} blockstateResolver - BlockstateResolver instance
   * @returns {Promise<number>} Number of states registered
   */
  async precomputeAllBlockStates(blockstateResolver) {
    let totalStates = 0;
    
    // Get all known blockstate definitions
    const definitions = blockstateResolver.getAllBlockstates();
    
    for (const [blockName, definition] of Object.entries(definitions)) {
      if (!definition) continue;
      
      // Get all possible property combinations
      const allProperties = blockstateResolver.getAllPropertyCombinations(blockName, definition);
      
      for (const properties of allProperties) {
        this.register(blockName, properties);
        totalStates++;
      }
    }
    
    // Pre-compute geometry for all registered states
    await this.precomputeAll();
    
    console.log(`[StateRegistry] Pre-computed ${totalStates} block states for WASM`);
    return totalStates;
  }
}

// Singleton
let instance = null;

export function getStateRegistry() {
  if (!instance) {
    instance = new StateRegistry();
  }
  return instance;
}

export { StateRegistry };
export default StateRegistry;

