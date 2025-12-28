/**
 * ModelResolver - Loads and resolves Minecraft block models
 * 
 * Pre-loads all models at startup and resolves parent inheritance chains.
 * Caches resolved models for fast lookup during meshing.
 */

// Base path to assets
const ASSETS_BASE = '/textures/1.21.11+Template/assets/minecraft';

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
    
    // Loading state
    this.loaded = false;
    this.loading = null;
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
   */
  async getRawModel(modelPath) {
    // Normalize path: "minecraft:block/stone" → "block/stone"
    const normalized = modelPath.replace('minecraft:', '');
    
    if (this.rawModels.has(normalized)) {
      return this.rawModels.get(normalized);
    }

    try {
      const url = `${ASSETS_BASE}/models/${normalized}.json`;
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[ModelResolver] Failed to load model: ${normalized}`);
        return null;
      }
      const json = await response.json();
      this.rawModels.set(normalized, json);
      return json;
    } catch (e) {
      console.warn(`[ModelResolver] Error loading model ${normalized}:`, e.message);
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

