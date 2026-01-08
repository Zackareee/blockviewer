/**
 * ModelResolver - Loads and resolves Minecraft block models
 * 
 * Pre-loads all models at startup and resolves parent inheritance chains.
 * Caches resolved models for fast lookup during meshing.
 * Supports loading from texture packs with fallback to bundled assets.
 */

// Base path to assets
const ASSETS_BASE = '/textures/1.21.11+Template/assets/minecraft';

// Legacy block names that were renamed in Minecraft 1.21+
// Maps old model paths to new model paths
const LEGACY_MODEL_RENAMES = {
  'block/chain': 'block/iron_chain',
  'block/grass': 'block/short_grass',
};

/**
 * Resolved model with all parent data merged
 * @typedef {Object} ResolvedModel
 * @property {Array} elements - Geometry elements (boxes)
 * @property {Object} textures - Resolved texture references
 * @property {boolean} ambientOcclusion - Whether AO is enabled
 */

class ModelResolver {
  constructor() {
    // Raw model JSON cache: modelName → raw JSON
    this.rawModels = new Map();
    
    // Resolved models cache: modelName → ResolvedModel
    this.resolvedModels = new Map();
    
    // Failed models cache: modelName → true (to avoid repeated fetch attempts)
    this.failedModels = new Set();
    
    // Loading state
    this.loaded = false;
    this.loading = null;
    
    // Optional texture pack manager for overrides
    this.packManager = null;
  }
  
  /**
   * Set the texture pack manager for model overrides
   * @param {TexturePackManager} packManager
   */
  setPackManager(packManager) {
    this.packManager = packManager;
    // Clear ALL caches when pack changes - critical for texture pack hot-swapping
    this.rawModels.clear();
    this.resolvedModels.clear();
    this.failedModels.clear();
    this.loaded = false; // Force re-preloading if requested
    console.log('[ModelResolver] Pack changed, all caches cleared');
  }

  /**
   * Load all block models from assets
   * Call once at startup
   */
  async loadAll() {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = this._loadAllModels();
    await this.loading;
    this.loaded = true;
    this.loading = null;
    
    console.log(`[ModelResolver] Loaded ${this.rawModels.size} models`);
  }

  async _loadAllModels() {
    // Fetch the model index (we'll need to create this or fetch individually)
    // For now, we'll load models on-demand and cache them
    // In production, we'd pre-bundle a model index
  }

  /**
   * Get a raw model JSON, loading if necessary
   * Checks texture pack first if available, then falls back to bundled assets
   */
  async getRawModel(modelPath) {
    // Normalize path: "minecraft:block/stone" → "block/stone"
    let normalized = modelPath.replace('minecraft:', '');
    
    // Apply legacy renames for blocks renamed in Minecraft 1.21+
    if (LEGACY_MODEL_RENAMES[normalized]) {
      normalized = LEGACY_MODEL_RENAMES[normalized];
    }
    
    // Check cache first
    if (this.rawModels.has(normalized)) {
      return this.rawModels.get(normalized);
    }
    
    // Check failed cache to avoid repeated attempts
    if (this.failedModels.has(normalized)) {
      return null;
    }
    
    // Try texture pack first if available
    if (this.packManager && this.packManager.isLoaded) {
      const packModel = this.packManager.getModel(normalized);
      if (packModel) {
        this.rawModels.set(normalized, packModel);
        return packModel;
      }
    }

    // Fall back to bundled assets
    try {
      const url = `${ASSETS_BASE}/models/${normalized}.json`;
      const response = await fetch(url);
      if (!response.ok) {
        // Mark as failed to avoid repeated attempts
        this.failedModels.add(normalized);
        return null;
      }
      // Verify response is JSON before parsing
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        this.failedModels.add(normalized);
        return null;
      }
      const json = await response.json();
      this.rawModels.set(normalized, json);
      return json;
    } catch (e) {
      // Only log once per model, then cache failure
      this.failedModels.add(normalized);
      return null;
    }
  }

  /**
   * Resolve a model with full parent inheritance
   * Returns cached result if available
   */
  async resolve(modelPath) {
    const normalized = modelPath.replace('minecraft:', '');
    
    if (this.resolvedModels.has(normalized)) {
      return this.resolvedModels.get(normalized);
    }

    const resolved = await this._resolveModel(normalized, new Set());
    if (resolved) {
      this.resolvedModels.set(normalized, resolved);
    }
    return resolved;
  }

  /**
   * Internal: resolve model with cycle detection
   */
  async _resolveModel(modelPath, visited) {
    if (visited.has(modelPath)) {
      console.warn(`[ModelResolver] Circular dependency detected: ${modelPath}`);
      return null;
    }
    visited.add(modelPath);

    const raw = await this.getRawModel(modelPath);
    if (!raw) return null;

    // Start with parent's data if exists
    let result = {
      elements: [],
      textures: {},
      ambientOcclusion: true,
    };

    if (raw.parent) {
      const parentPath = raw.parent.replace('minecraft:', '');
      const parent = await this._resolveModel(parentPath, visited);
      if (parent) {
        result.elements = [...parent.elements];
        result.textures = { ...parent.textures };
        result.ambientOcclusion = parent.ambientOcclusion;
      }
    }

    // Override with current model's data
    if (raw.textures) {
      Object.assign(result.textures, raw.textures);
    }
    if (raw.elements) {
      result.elements = raw.elements; // Elements replace, don't merge
    }
    if (raw.ambientocclusion !== undefined) {
      result.ambientOcclusion = raw.ambientocclusion;
    }

    // Resolve texture references (#texture → actual path)
    result.textures = this._resolveTextureRefs(result.textures);

    return result;
  }

  /**
   * Resolve texture variable references
   * #side → minecraft:block/stone
   */
  _resolveTextureRefs(textures) {
    const resolved = {};
    const maxDepth = 10;

    for (const [key, value] of Object.entries(textures)) {
      resolved[key] = this._resolveTextureRef(value, textures, maxDepth);
    }

    return resolved;
  }

  _resolveTextureRef(ref, textures, depth) {
    if (depth <= 0) return ref;
    if (!ref || !ref.startsWith('#')) return ref;

    const varName = ref.substring(1);
    const target = textures[varName];
    if (!target) return ref;

    return this._resolveTextureRef(target, textures, depth - 1);
  }

  /**
   * Synchronous resolve - only works for pre-loaded models
   * Use for hot path during meshing
   */
  resolveSync(modelPath) {
    const normalized = modelPath.replace('minecraft:', '');
    return this.resolvedModels.get(normalized) || null;
  }

  /**
   * Check if a model is a full cube (for optimization)
   */
  isFullCube(model) {
    if (!model || !model.elements || model.elements.length !== 1) {
      return false;
    }
    const el = model.elements[0];
    return (
      el.from[0] === 0 && el.from[1] === 0 && el.from[2] === 0 &&
      el.to[0] === 16 && el.to[1] === 16 && el.to[2] === 16
    );
  }

  /**
   * Get model statistics
   */
  getStats() {
    return {
      rawCount: this.rawModels.size,
      resolvedCount: this.resolvedModels.size,
    };
  }

  /**
   * Preload and resolve all block models from a TexturePackManager
   * 
   * This enables synchronous model lookup via resolveSync() after preloading.
   * Call this at startup after loading the texture pack, before building the atlas.
   * 
   * @param {TexturePackManager} packManager - The loaded texture pack
   * @returns {Promise<number>} Number of models successfully resolved
   */
  async preloadAllModels(packManager) {
    if (!packManager || !packManager.isLoaded) {
      console.warn('[ModelResolver] Cannot preload - packManager not loaded');
      return 0;
    }

    // Set the pack manager for model loading
    this.setPackManager(packManager);

    // Get all block model names from the pack
    // TexturePackManager stores models as: "block/stone" -> JSON
    const modelNames = [];
    if (packManager.models) {
      for (const name of packManager.models.keys()) {
        if (name.startsWith('block/')) {
          modelNames.push(name);
        }
      }
    }

    console.log(`[ModelResolver] Preloading ${modelNames.length} block models...`);

    // First, populate rawModels from the pack (synchronous, already in memory)
    for (const name of modelNames) {
      const model = packManager.getModel(name);
      if (model) {
        this.rawModels.set(name, model);
      }
    }

    // Resolve all models (handles parent inheritance)
    let successCount = 0;
    const batchSize = 100; // Process in batches to avoid blocking

    for (let i = 0; i < modelNames.length; i += batchSize) {
      const batch = modelNames.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (modelName) => {
        try {
          const resolved = await this.resolve(modelName);
          if (resolved) {
            successCount++;
          }
        } catch (e) {
          // Skip failed models silently
        }
      }));
    }

    this.loaded = true;
    console.log(`[ModelResolver] Preloaded ${successCount}/${modelNames.length} models (${this.resolvedModels.size} total resolved)`);
    
    return successCount;
  }

  /**
   * Check if models have been preloaded
   * @returns {boolean}
   */
  isPreloaded() {
    return this.loaded && this.resolvedModels.size > 0;
  }
}

// Singleton instance
let instance = null;

export function getModelResolver() {
  if (!instance) {
    instance = new ModelResolver();
  }
  return instance;
}

export { ModelResolver };
export default ModelResolver;

