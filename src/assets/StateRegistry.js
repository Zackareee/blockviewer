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
    
    // Next available ID
    this.nextId = 0;
    
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

    // Track which model paths we've already processed (for texture rotation blocks)
    // This prevents duplicate geometries when multiple rotation variants of the same model exist
    const processedModels = usesTextureRotation ? new Set() : null;

    // Compute geometry for each variant
    state.geometry = [];
    state.isFullCube = true;

    for (const variant of state.variants) {
      // For texture rotation blocks, skip duplicate rotation variants of the same model
      if (usesTextureRotation && processedModels.has(variant.model)) {
        continue;
      }

      const modelPath = variant.model.replace('minecraft:', '');
      const model = await this.modelResolver.resolve(modelPath);
      if (!model) continue;

      // For blocks with texture rotation, use base geometry (no model rotation)
      const rotX = usesTextureRotation ? 0 : variant.x;
      const rotY = usesTextureRotation ? 0 : variant.y;
      
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
        if (usesTextureRotation) {
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
   */
  async precomputeAll() {
    const promises = [];
    for (let i = 0; i < this.nextId; i++) {
      promises.push(this.getGeometry(i));
    }
    await Promise.all(promises);
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

