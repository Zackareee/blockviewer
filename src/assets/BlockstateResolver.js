/**
 * BlockstateResolver - Maps block properties to model variants
 * 
 * Handles both "variants" and "multipart" blockstate formats.
 * Pre-loads all blockstates at startup for fast lookup.
 */

const ASSETS_BASE = '/textures/1.21.11+Template/assets/minecraft';

/**
 * Model variant with rotation info
 * @typedef {Object} ModelVariant
 * @property {string} model - Model path
 * @property {number} x - X rotation (0, 90, 180, 270)
 * @property {number} y - Y rotation (0, 90, 180, 270)
 * @property {boolean} uvlock - Whether to lock UVs during rotation
 */

class BlockstateResolver {
  constructor() {
    // Blockstate JSON cache: blockName → raw JSON
    this.blockstates = new Map();
    
    // Compiled lookup: blockName → Map<propsKey, ModelVariant[]>
    this.compiled = new Map();
    
    this.loaded = false;
    this.loading = null;
  }

  /**
   * Load all blockstates from assets
   */
  async loadAll() {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = this._loadAllBlockstates();
    await this.loading;
    this.loaded = true;
    this.loading = null;

    console.log(`[BlockstateResolver] Loaded ${this.blockstates.size} blockstates`);
  }

  async _loadAllBlockstates() {
    // Load on-demand, cache results
    // In production, bundle a blockstate index
  }

  /**
   * Get blockstate JSON, loading if needed
   */
  async getBlockstate(blockName) {
    // Normalize: "minecraft:stone" → "stone"
    const normalized = blockName.replace('minecraft:', '');

    if (this.blockstates.has(normalized)) {
      return this.blockstates.get(normalized);
    }

    try {
      const url = `${ASSETS_BASE}/blockstates/${normalized}.json`;
      const response = await fetch(url);
      if (!response.ok) return null;
      
      const json = await response.json();
      this.blockstates.set(normalized, json);
      this._compileBlockstate(normalized, json);
      return json;
    } catch (e) {
      return null;
    }
  }

  /**
   * Compile blockstate for fast property lookup
   */
  _compileBlockstate(blockName, json) {
    const lookup = new Map();

    if (json.variants) {
      // Variants format: "prop1=val1,prop2=val2" → model
      for (const [propsStr, variant] of Object.entries(json.variants)) {
        const variants = Array.isArray(variant) ? variant : [variant];
        const normalized = variants.map(v => ({
          model: v.model?.replace('minecraft:', '') || '',
          x: v.x || 0,
          y: v.y || 0,
          uvlock: v.uvlock || false,
        }));
        lookup.set(propsStr, normalized);
      }
    } else if (json.multipart) {
      // Multipart format: array of {when, apply}
      // Store the raw multipart for runtime evaluation
      lookup.set('__multipart__', json.multipart);
    }

    this.compiled.set(blockName, lookup);
  }

  /**
   * Resolve block properties to model variant(s)
   * @param {string} blockName - Block name (e.g., "oak_slab")
   * @param {Object} properties - Block properties (e.g., {type: "bottom"})
   * @returns {ModelVariant[]} Array of model variants to apply
   */
  resolve(blockName, properties = {}) {
    const normalized = blockName.replace('minecraft:', '');
    const lookup = this.compiled.get(normalized);
    
    if (!lookup) {
      // Not loaded yet or doesn't exist - return default cube
      return [{ model: `block/${normalized}`, x: 0, y: 0, uvlock: false }];
    }

    // Check for multipart
    if (lookup.has('__multipart__')) {
      return this._resolveMultipart(lookup.get('__multipart__'), properties);
    }

    // Variants format - build property string with ALL properties
    const propsStr = this._buildPropsString(properties);
    
    // Try exact match first
    if (lookup.has(propsStr)) {
      return lookup.get(propsStr);
    }

    // Try empty string (blocks with no variants like "stone")
    if (lookup.has('')) {
      return lookup.get('');
    }

    // No exact match - need to find best matching variant
    // Blockstate JSON only includes properties that affect the model,
    // but NBT includes ALL properties (like waterlogged)
    // Find variant where all its required properties match our values
    const bestMatch = this._findBestMatch(lookup, properties);
    if (bestMatch) {
      return bestMatch;
    }

    // Fallback - return first variant
    const firstKey = lookup.keys().next().value;
    if (firstKey) {
      return lookup.get(firstKey);
    }

    // Ultimate fallback
    return [{ model: `block/${normalized}`, x: 0, y: 0, uvlock: false }];
  }

  /**
   * Find the variant that best matches the given properties
   * The blockstate JSON may use fewer properties than the NBT has
   */
  _findBestMatch(lookup, properties) {
    for (const [variantKey, variants] of lookup) {
      if (variantKey === '' || variantKey === '__multipart__') continue;
      
      // Parse the variant key into property requirements
      const requiredProps = this._parsePropsString(variantKey);
      
      // Check if all required properties match
      let matches = true;
      for (const [key, value] of Object.entries(requiredProps)) {
        if (String(properties[key]) !== String(value)) {
          matches = false;
          break;
        }
      }
      
      if (matches) {
        return variants;
      }
    }
    return null;
  }

  /**
   * Parse a property string back into an object
   * "facing=east,half=bottom" -> {facing: "east", half: "bottom"}
   */
  _parsePropsString(propsStr) {
    const result = {};
    if (!propsStr) return result;
    
    for (const pair of propsStr.split(',')) {
      const [key, value] = pair.split('=');
      if (key && value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Build sorted property string for lookup
   */
  _buildPropsString(properties) {
    if (!properties || Object.keys(properties).length === 0) {
      return '';
    }
    
    return Object.entries(properties)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }

  /**
   * Resolve multipart blockstate
   */
  _resolveMultipart(multipart, properties) {
    const results = [];

    for (const part of multipart) {
      if (this._matchesCondition(part.when, properties)) {
        const apply = part.apply;
        const variants = Array.isArray(apply) ? apply : [apply];
        
        for (const v of variants) {
          results.push({
            model: v.model?.replace('minecraft:', '') || '',
            x: v.x || 0,
            y: v.y || 0,
            uvlock: v.uvlock || false,
          });
        }
      }
    }

    return results;
  }

  /**
   * Check if properties match a multipart condition
   */
  _matchesCondition(when, properties) {
    if (!when) return true; // No condition = always apply

    // OR condition
    if (when.OR) {
      return when.OR.some(cond => this._matchesCondition(cond, properties));
    }

    // AND condition (implicit - all keys must match)
    for (const [key, value] of Object.entries(when)) {
      const propValue = properties[key];
      
      // Value can be "true|false" for OR within a single property
      if (typeof value === 'string' && value.includes('|')) {
        const options = value.split('|');
        if (!options.includes(String(propValue))) {
          return false;
        }
      } else if (String(propValue) !== String(value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Synchronous resolve - only works for pre-loaded blockstates
   */
  resolveSync(blockName, properties = {}) {
    const normalized = blockName.replace('minecraft:', '');
    if (!this.compiled.has(normalized)) {
      return null;
    }
    return this.resolve(blockName, properties);
  }

  /**
   * Pre-load a specific blockstate
   */
  async preload(blockName) {
    await this.getBlockstate(blockName);
  }

  /**
   * Pre-load multiple blockstates in parallel
   */
  async preloadMany(blockNames) {
    await Promise.all(blockNames.map(name => this.getBlockstate(name)));
  }
}

// Singleton
let instance = null;

export function getBlockstateResolver() {
  if (!instance) {
    instance = new BlockstateResolver();
  }
  return instance;
}

export { BlockstateResolver };
export default BlockstateResolver;

