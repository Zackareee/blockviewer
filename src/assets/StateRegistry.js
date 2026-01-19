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

// Patterns for transparent PARTIAL blocks that need special rendering
// These blocks use single-sided rendering with transparency
// Note: Full cube transparent blocks (ice, glass) are handled by FastMesher, not here
const TRANSPARENT_MODEL_PATTERNS = [
  '_pane',           // Glass panes (all stained variants)
  'iron_bars',       // Iron bars
  'copper_bars',     // Copper bars
  'slime_block',     // Translucent with inner cube
  'honey_block',     // Translucent with inner cube
  'nether_portal',   // Portal effect
  'powder_snow',     // Hollow translucent block
  'mangrove_roots',  // See-through roots
];

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
        // Set transparency flag based on block name patterns
        // Note: packed_ice and blue_ice are OPAQUE, not transparent
        const isPackedOrBlueIce = state.blockName.includes('packed_ice') || state.blockName.includes('blue_ice');
        geom.isTransparent = !isPackedOrBlueIce && TRANSPARENT_MODEL_PATTERNS.some(pattern => state.blockName.includes(pattern));
        
        // Set overlay flag based on whether any face is an overlay (torch bulb panels, etc.)
        geom.isOverlay = geom.cullFaces?.some(face => face.overlay) || false;
        
        // Set shade flag based on whether any face has shading enabled
        // Default to true if no explicit shade info (most blocks use shading)
        geom.hasShade = geom.cullFaces?.some(face => face.shade !== false) ?? true;
        
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
    for (let i = 0; i < this.nextId; i++) {
      // Skip states that already have geometry computed
      if (this.states[i]?.geometry) continue;
      promises.push(this.getGeometry(i));
    }
    // Only await if there are new states to compute
    if (promises.length > 0) {
      await Promise.all(promises);
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
   * Pre-register all non-cube blocks from a BlockRegistry with default states
   * This populates the registry BEFORE chunk decoding so WASM can use it.
   * 
   * @param {BlockRegistry} blockRegistry - The block registry with all known blocks
   * @returns {Promise<number>} Number of states registered
   */
  async preregisterNonCubeBlocks(blockRegistry) {
    let registered = 0;
    
    for (let id = 0; id < 4096; id++) {
      const info = blockRegistry.getBlockInfo(id);
      if (!info || !info.name) continue;
      
      // Only pre-register non-cube blocks (model blocks)
      if (!blockRegistry.isNonCube(id)) continue;
      
      const blockName = info.name.replace('minecraft:', '');
      
      // Register with empty properties (default state)
      this.register(blockName, {});
      registered++;
    }
    
    // Precompute geometry for all registered states
    await this.precomputeAll();
    
    console.log(`[StateRegistry] Pre-registered ${registered} non-cube block states`);
    return registered;
  }

  /**
   * Pre-register all property combinations for multipart blocks
   * These blocks have geometry that depends on state properties
   * Must be called BEFORE exporting to worker to ensure all states have geometry
   * 
   * @returns {Promise<number>} Number of states registered
   */
  async preregisterMultipartBlockStates() {
    let registered = 0;
    
    // Fire: up, north, south, east, west (boolean), age 0-15 (but age doesn't affect geometry)
    for (const fireName of ['fire', 'soul_fire']) {
      for (let up = 0; up < 2; up++) {
        for (let north = 0; north < 2; north++) {
          for (let south = 0; south < 2; south++) {
            for (let east = 0; east < 2; east++) {
              for (let west = 0; west < 2; west++) {
                // Only register a few age values since age doesn't affect geometry
                for (const age of [0, 1, 15]) {
                  this.register(fireName, {
                    age: String(age),
                    up: up ? 'true' : 'false',
                    north: north ? 'true' : 'false',
                    south: south ? 'true' : 'false',
                    east: east ? 'true' : 'false',
                    west: west ? 'true' : 'false',
                  });
                  registered++;
                }
              }
            }
          }
        }
      }
    }
    
    // Chiseled bookshelf: facing (4) + 6 slot_X_occupied (2^6)
    for (const facing of ['north', 'south', 'east', 'west']) {
      for (let slots = 0; slots < 64; slots++) {
        this.register('chiseled_bookshelf', {
          facing,
          slot_0_occupied: (slots & 1) ? 'true' : 'false',
          slot_1_occupied: (slots & 2) ? 'true' : 'false',
          slot_2_occupied: (slots & 4) ? 'true' : 'false',
          slot_3_occupied: (slots & 8) ? 'true' : 'false',
          slot_4_occupied: (slots & 16) ? 'true' : 'false',
          slot_5_occupied: (slots & 32) ? 'true' : 'false',
        });
        registered++;
      }
    }
    
    // Glass panes and iron bars: north, south, east, west (boolean), waterlogged
    const paneBlocks = [
      'glass_pane', 'iron_bars', 'copper_bars',
      'white_stained_glass_pane', 'orange_stained_glass_pane', 'magenta_stained_glass_pane',
      'light_blue_stained_glass_pane', 'yellow_stained_glass_pane', 'lime_stained_glass_pane',
      'pink_stained_glass_pane', 'gray_stained_glass_pane', 'light_gray_stained_glass_pane',
      'cyan_stained_glass_pane', 'purple_stained_glass_pane', 'blue_stained_glass_pane',
      'brown_stained_glass_pane', 'green_stained_glass_pane', 'red_stained_glass_pane',
      'black_stained_glass_pane',
    ];
    for (const paneName of paneBlocks) {
      for (let dirs = 0; dirs < 16; dirs++) {
        for (const waterlogged of ['true', 'false']) {
          this.register(paneName, {
            north: (dirs & 1) ? 'true' : 'false',
            south: (dirs & 2) ? 'true' : 'false',
            east: (dirs & 4) ? 'true' : 'false',
            west: (dirs & 8) ? 'true' : 'false',
            waterlogged,
          });
          registered++;
        }
      }
    }
    
    // Fences: north/south/east/west (boolean), waterlogged
    const fenceBlocks = [
      'oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence', 
      'acacia_fence', 'dark_oak_fence', 'mangrove_fence', 'cherry_fence',
      'bamboo_fence', 'crimson_fence', 'warped_fence', 'nether_brick_fence',
    ];
    for (const fenceName of fenceBlocks) {
      for (let dirs = 0; dirs < 16; dirs++) {
        for (const waterlogged of ['true', 'false']) {
          this.register(fenceName, {
            north: (dirs & 1) ? 'true' : 'false',
            south: (dirs & 2) ? 'true' : 'false',
            east: (dirs & 4) ? 'true' : 'false',
            west: (dirs & 8) ? 'true' : 'false',
            waterlogged,
          });
          registered++;
        }
      }
    }
    
    // Vines: up, north, south, east, west (boolean)
    for (let up = 0; up < 2; up++) {
      for (let dirs = 0; dirs < 16; dirs++) {
        this.register('vine', {
          up: up ? 'true' : 'false',
          north: (dirs & 1) ? 'true' : 'false',
          south: (dirs & 2) ? 'true' : 'false',
          east: (dirs & 4) ? 'true' : 'false',
          west: (dirs & 8) ? 'true' : 'false',
        });
        registered++;
      }
    }
    
    // Glow lichen: down, up, north, south, east, west (boolean), waterlogged
    for (let down = 0; down < 2; down++) {
      for (let up = 0; up < 2; up++) {
        for (let dirs = 0; dirs < 16; dirs++) {
          for (const waterlogged of ['true', 'false']) {
            this.register('glow_lichen', {
              down: down ? 'true' : 'false',
              up: up ? 'true' : 'false',
              north: (dirs & 1) ? 'true' : 'false',
              south: (dirs & 2) ? 'true' : 'false',
              east: (dirs & 4) ? 'true' : 'false',
              west: (dirs & 8) ? 'true' : 'false',
              waterlogged,
            });
            registered++;
          }
        }
      }
    }
    
    // Redstone wire: north/south/east/west can be none/side/up, power 0-15
    // Register common power levels to reduce combinations
    const wireStates = ['none', 'side', 'up'];
    for (let power = 0; power <= 15; power += 5) {
      for (const north of wireStates) {
        for (const south of wireStates) {
          for (const east of wireStates) {
            for (const west of wireStates) {
              this.register('redstone_wire', {
                north, south, east, west,
                power: String(power),
              });
              registered++;
            }
          }
        }
      }
    }
    
    // Chorus plant: down, up, north, south, east, west (boolean)
    for (let down = 0; down < 2; down++) {
      for (let up = 0; up < 2; up++) {
        for (let dirs = 0; dirs < 16; dirs++) {
          this.register('chorus_plant', {
            down: down ? 'true' : 'false',
            up: up ? 'true' : 'false',
            north: (dirs & 1) ? 'true' : 'false',
            south: (dirs & 2) ? 'true' : 'false',
            east: (dirs & 4) ? 'true' : 'false',
            west: (dirs & 8) ? 'true' : 'false',
          });
          registered++;
        }
      }
    }
    
    // Mushroom blocks: down, up, north, south, east, west (boolean)
    for (const mushroom of ['brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem']) {
      for (let down = 0; down < 2; down++) {
        for (let up = 0; up < 2; up++) {
          for (let dirs = 0; dirs < 16; dirs++) {
            this.register(mushroom, {
              down: down ? 'true' : 'false',
              up: up ? 'true' : 'false',
              north: (dirs & 1) ? 'true' : 'false',
              south: (dirs & 2) ? 'true' : 'false',
              east: (dirs & 4) ? 'true' : 'false',
              west: (dirs & 8) ? 'true' : 'false',
            });
            registered++;
          }
        }
      }
    }
    
    // Tripwire: attached, powered, north/south/east/west (boolean)
    for (const attached of ['true', 'false']) {
      for (const powered of ['true', 'false']) {
        for (let dirs = 0; dirs < 16; dirs++) {
          this.register('tripwire', {
            attached,
            disarmed: 'false',
            powered,
            north: (dirs & 1) ? 'true' : 'false',
            south: (dirs & 2) ? 'true' : 'false',
            east: (dirs & 4) ? 'true' : 'false',
            west: (dirs & 8) ? 'true' : 'false',
          });
          registered++;
        }
      }
    }
    
    // Brewing stand: has_bottle_0, has_bottle_1, has_bottle_2 (boolean)
    for (let bottles = 0; bottles < 8; bottles++) {
      this.register('brewing_stand', {
        has_bottle_0: (bottles & 1) ? 'true' : 'false',
        has_bottle_1: (bottles & 2) ? 'true' : 'false',
        has_bottle_2: (bottles & 4) ? 'true' : 'false',
      });
      registered++;
    }
    
    // Walls: north/south/east/west can be none/low/tall, up (boolean), waterlogged
    const wallBlocks = [
      'cobblestone_wall', 'mossy_cobblestone_wall', 'stone_brick_wall',
      'mossy_stone_brick_wall', 'granite_wall', 'diorite_wall', 'andesite_wall',
      'brick_wall', 'prismarine_wall', 'sandstone_wall', 'red_sandstone_wall',
      'nether_brick_wall', 'red_nether_brick_wall', 'blackstone_wall',
      'polished_blackstone_wall', 'polished_blackstone_brick_wall',
      'cobbled_deepslate_wall', 'polished_deepslate_wall', 'deepslate_brick_wall',
      'deepslate_tile_wall', 'mud_brick_wall', 'tuff_wall', 'polished_tuff_wall',
      'tuff_brick_wall',
    ];
    const wallStates = ['none', 'low', 'tall'];
    for (const wallName of wallBlocks) {
      for (const up of ['true', 'false']) {
        for (const waterlogged of ['true', 'false']) {
          for (const north of wallStates) {
            for (const south of wallStates) {
              for (const east of wallStates) {
                for (const west of wallStates) {
                  this.register(wallName, {
                    up, waterlogged, north, south, east, west,
                  });
                  registered++;
                }
              }
            }
          }
        }
      }
    }
    
    // Pink petals: facing (4) + flower_amount (1-4)
    for (const facing of ['north', 'south', 'east', 'west']) {
      for (let flower_amount = 1; flower_amount <= 4; flower_amount++) {
        this.register('pink_petals', { facing, flower_amount: String(flower_amount) });
        registered++;
      }
    }
    
    // Leaf litter: facing (4) + segment_amount (1-4)
    for (const facing of ['north', 'south', 'east', 'west']) {
      for (let segment_amount = 1; segment_amount <= 4; segment_amount++) {
        this.register('leaf_litter', { facing, segment_amount: String(segment_amount) });
        registered++;
      }
    }
    
    // Wood shelves: facing (4) + powered (2) + side_chain (4)
    const shelfWoodTypes = [
      'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
      'crimson', 'warped', 'mangrove', 'cherry', 'bamboo', 'pale_oak'
    ];
    const sideChainStates = ['unconnected', 'left', 'center', 'right'];
    for (const wood of shelfWoodTypes) {
      const shelfName = `${wood}_shelf`;
      for (const facing of ['north', 'south', 'east', 'west']) {
        for (const powered of ['true', 'false']) {
          for (const side_chain of sideChainStates) {
            this.register(shelfName, { facing, powered, side_chain });
            registered++;
          }
        }
      }
    }
    
    // Precompute geometry for all newly registered states
    await this.precomputeAll();
    
    console.log(`[StateRegistry] Pre-registered ${registered} multipart block states`);
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

