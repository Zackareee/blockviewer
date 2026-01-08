/**
 * ModelTextureMapper - Extracts per-face texture mappings from Minecraft block models
 * 
 * Replaces the hardcoded BlockTextureRegistry with a data-driven approach that reads
 * texture mappings directly from the texture pack's model JSON files.
 * 
 * Model Inheritance Chain Example:
 *   stone.json → cube_all.json → cube.json → block.json
 *   
 *   stone.json:     { parent: "block/cube_all", textures: { all: "block/stone" } }
 *   cube_all.json:  { parent: "block/cube", textures: { down: "#all", up: "#all", ... } }
 *   cube.json:      { elements: [{ faces: { down: { texture: "#down" }, ... } }] }
 * 
 * The resolved model contains fully resolved textures for each face.
 */

import { getModelResolver } from './ModelResolver.js';
import { getBlockstateResolver } from './BlockstateResolver.js';

// Face names used by Minecraft models
const FACE_NAMES = ['up', 'down', 'north', 'south', 'east', 'west'];

// Enable debug logging for specific blocks (set to empty array to disable)
const DEBUG_BLOCKS = [];  // e.g., ['stone', 'dirt', 'grass_block']

// Set to true to completely disable model-based texture mapping
// This will force all blocks to use BlockTextureRegistry (hardcoded mappings)
const DISABLE_MODEL_MAPPING = true;

/**
 * ModelTextureMapper class
 * 
 * Extracts per-face textures from resolved block models.
 */
class ModelTextureMapper {
  constructor() {
    // Cache: blockName -> { up, down, north, south, east, west } texture paths
    this.cache = new Map();
    
    // Reference to model resolver (set during init)
    this.modelResolver = null;
    
    // Reference to blockstate resolver (set during init)
    this.blockstateResolver = null;
    
    // Initialization state
    this.initialized = false;
  }

  /**
   * Initialize with resolvers
   * Must be called after models are preloaded
   */
  init(modelResolver, blockstateResolver) {
    this.modelResolver = modelResolver || getModelResolver();
    this.blockstateResolver = blockstateResolver || getBlockstateResolver();
    this.initialized = true;
  }

  /**
   * Get texture paths for all 6 faces of a block
   * Returns null if block model not found (caller should use fallback)
   * 
   * @param {string} blockName - Block name (e.g., "stone" or "minecraft:stone")
   * @returns {{ up: string, down: string, north: string, south: string, east: string, west: string } | null}
   */
  getBlockFaceTextures(blockName) {
    // If model mapping is disabled, always return null to use fallback
    if (DISABLE_MODEL_MAPPING) {
      return null;
    }
    
    if (!this.initialized) {
      console.warn('[ModelTextureMapper] Not initialized, call init() first');
      return null;
    }

    // Normalize name
    const name = blockName.replace('minecraft:', '');
    
    // Check cache
    if (this.cache.has(name)) {
      return this.cache.get(name);
    }

    // Try to get textures from model
    const textures = this._extractFaceTextures(name);
    
    // Cache result (even null, to avoid repeated lookups)
    this.cache.set(name, textures);
    
    return textures;
  }

  /**
   * Extract face textures from a block's model
   * @private
   */
  _extractFaceTextures(blockName) {
    const shouldDebug = DEBUG_BLOCKS.includes(blockName);
    
    // Get the default model for this block (without properties)
    // For blocks with properties, we use the first/default variant
    const modelPath = this._getDefaultModelPath(blockName);
    if (!modelPath) {
      if (shouldDebug) console.log(`[ModelTextureMapper] ${blockName}: no model path found`);
      return null;
    }

    // Get the resolved model (with all parent data merged)
    const model = this.modelResolver.resolveSync(modelPath);
    if (!model || !model.textures || Object.keys(model.textures).length === 0) {
      if (shouldDebug) console.log(`[ModelTextureMapper] ${blockName}: model not resolved or has no textures`);
      return null;
    }

    if (shouldDebug) {
      console.log(`[ModelTextureMapper] ${blockName}: model=${modelPath}, textures=`, model.textures);
    }

    // Extract textures for each face
    const result = {};
    let foundCount = 0;
    
    for (const face of FACE_NAMES) {
      const texturePath = this._getTextureForFace(model, face);
      if (texturePath) {
        const normalized = this._normalizeTexturePath(texturePath);
        // Validate the texture path looks reasonable
        if (normalized && normalized.startsWith('block/') && !normalized.includes('#')) {
          result[face] = normalized;
          foundCount++;
        } else {
          if (shouldDebug) console.log(`[ModelTextureMapper] ${blockName}: invalid texture for ${face}: ${texturePath}`);
          result[face] = null;
        }
      } else {
        // No texture found for this face - mark as null
        result[face] = null;
      }
    }

    // Only return if we found textures for ALL 6 faces
    // Partial results would cause incorrect rendering
    if (foundCount < 6) {
      if (shouldDebug) console.log(`[ModelTextureMapper] ${blockName}: only found ${foundCount}/6 faces, returning null`);
      return null;
    }

    if (shouldDebug) {
      console.log(`[ModelTextureMapper] ${blockName}: SUCCESS, result=`, result);
    }

    return result;
  }

  /**
   * Get the default model path for a block
   * Uses blockstate to find the model, returns null if model not available
   * @private
   */
  _getDefaultModelPath(blockName) {
    // Try blockstate resolver first (handles variants)
    if (this.blockstateResolver) {
      const variants = this.blockstateResolver.resolveSync(blockName, {});
      if (variants && variants.length > 0 && variants[0].model) {
        const modelPath = variants[0].model.replace('minecraft:', '');
        
        // Check if this model is actually resolved (pre-loaded)
        // Don't return paths for models that weren't loaded
        if (this.modelResolver.resolveSync(modelPath)) {
          return modelPath;
        }
      }
    }

    // Try default model path, but only if it's actually resolved
    const defaultPath = `block/${blockName}`;
    if (this.modelResolver.resolveSync(defaultPath)) {
      return defaultPath;
    }

    // No valid model found - caller should use fallback
    return null;
  }

  /**
   * Get the texture path for a specific face from a resolved model
   * @private
   */
  _getTextureForFace(model, faceName) {
    if (!model || !model.textures) {
      return null;
    }

    const textures = model.textures;

    // Try direct face mapping first (most models use this)
    // cube.json defines: down, up, north, south, east, west
    if (textures[faceName] && !textures[faceName].startsWith('#')) {
      return textures[faceName];
    }

    // Try common aliases used by various parent models
    // Different parent models use different texture variable names
    
    // For 'up' face
    if (faceName === 'up') {
      if (textures.top && !textures.top.startsWith('#')) return textures.top;
      if (textures.end && !textures.end.startsWith('#')) return textures.end;
    }
    
    // For 'down' face
    if (faceName === 'down') {
      if (textures.bottom && !textures.bottom.startsWith('#')) return textures.bottom;
      if (textures.end && !textures.end.startsWith('#')) return textures.end;
    }
    
    // For side faces (north, south, east, west)
    if (['north', 'south', 'east', 'west'].includes(faceName)) {
      if (textures.side && !textures.side.startsWith('#')) return textures.side;
      // For directional blocks, 'north' might be 'front'
      if (faceName === 'north' && textures.front && !textures.front.startsWith('#')) {
        return textures.front;
      }
      if (faceName === 'south' && textures.back && !textures.back.startsWith('#')) {
        return textures.back;
      }
    }

    // Try 'all' for cube_all style models
    if (textures.all && !textures.all.startsWith('#')) {
      return textures.all;
    }

    // Try 'particle' as last resort (usually the main texture)
    if (textures.particle && !textures.particle.startsWith('#')) {
      return textures.particle;
    }

    return null;
  }

  /**
   * Normalize texture path to standard format
   * "minecraft:block/stone" -> "block/stone"
   * @private
   */
  _normalizeTexturePath(texturePath) {
    if (!texturePath) return null;
    return texturePath.replace('minecraft:', '');
  }

  /**
   * Preload face textures for all blocks in a block registry
   * Call after models are preloaded but before meshing
   * 
   * @param {BlockRegistry} blockRegistry - The block registry
   * @returns {number} Number of blocks successfully mapped
   */
  preloadForRegistry(blockRegistry) {
    if (!this.initialized) {
      console.warn('[ModelTextureMapper] Not initialized, call init() first');
      return 0;
    }

    let successCount = 0;
    const idToInfo = blockRegistry.idToInfo;

    for (const info of idToInfo) {
      if (!info || !info.name) continue;
      
      const name = info.name.replace('minecraft:', '');
      const textures = this.getBlockFaceTextures(name);
      
      if (textures) {
        successCount++;
      }
    }

    console.log(`[ModelTextureMapper] Preloaded ${successCount}/${idToInfo.length} blocks from models`);
    return successCount;
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    let hitCount = 0;
    let missCount = 0;
    
    for (const value of this.cache.values()) {
      if (value) {
        hitCount++;
      } else {
        missCount++;
      }
    }

    return {
      cacheSize: this.cache.size,
      hitCount,
      missCount,
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get the ModelTextureMapper singleton
 * @returns {ModelTextureMapper}
 */
export function getModelTextureMapper() {
  if (!instance) {
    instance = new ModelTextureMapper();
  }
  return instance;
}

export { ModelTextureMapper };
export default ModelTextureMapper;

