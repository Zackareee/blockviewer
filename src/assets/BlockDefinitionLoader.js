/**
 * BlockDefinitionLoader - Data-driven block definition loader
 * 
 * Scans blockstate JSON files from the texture pack to discover all blocks.
 * No hardcoded block lists - everything is derived from pack data.
 * 
 * Provides:
 * - List of all known blocks
 * - All possible property combinations per block
 * - Block metadata (full cube, transparent, fluid) derived from model data
 */

/**
 * @typedef {Object} BlockDefinition
 * @property {string} name - Block name (e.g., "stone", "oak_slab")
 * @property {Object} blockstate - Raw blockstate JSON
 * @property {Set<string>} properties - Set of property names this block uses
 * @property {Map<string, Set<string>>} propertyValues - Map of property name to possible values
 * @property {boolean} isMultipart - Whether this uses multipart format
 * @property {string[]} variants - List of variant keys (for variant format)
 */

/**
 * @typedef {Object} BlockMetadata
 * @property {boolean} isFullCube - True if all variants are 0-16 cubes
 * @property {boolean} isTransparent - True if any texture has alpha
 * @property {boolean} isFluid - True if block name indicates fluid (water/lava)
 * @property {boolean} hasAmbientOcclusion - From model ambientocclusion field
 */

class BlockDefinitionLoader {
  constructor() {
    // blockName -> BlockDefinition
    this.definitions = new Map();
    
    // Loading state
    this.loaded = false;
    this.loading = null;
    
    // Progress callback
    this.onProgress = null;
  }

  /**
   * Set progress callback for loading status updates
   * @param {function(string, number, number): void} callback - (message, current, total)
   */
  setProgressCallback(callback) {
    this.onProgress = callback;
  }

  /**
   * Load all block definitions from a TexturePackManager
   * @param {TexturePackManager} packManager - Loaded texture pack
   * @returns {Promise<Map<string, BlockDefinition>>}
   */
  async loadFromPack(packManager) {
    if (this.loaded) return this.definitions;
    if (this.loading) return this.loading;

    this.loading = this._loadAll(packManager);
    const result = await this.loading;
    this.loaded = true;
    this.loading = null;
    return result;
  }

  /**
   * Internal loading implementation
   */
  async _loadAll(packManager) {
    this.definitions.clear();

    // Get all blockstate names from the pack
    const blockstateNames = this._getBlockstateNames(packManager);
    const total = blockstateNames.length;
    
    console.log(`[BlockDefinitionLoader] Found ${total} blockstates to process`);
    
    let processed = 0;
    for (const blockName of blockstateNames) {
      const blockstate = packManager.getBlockstate(blockName);
      if (blockstate) {
        const definition = this._parseBlockstate(blockName, blockstate);
        this.definitions.set(blockName, definition);
      }
      
      processed++;
      if (this.onProgress && processed % 100 === 0) {
        this.onProgress('Loading block definitions', processed, total);
      }
    }

    if (this.onProgress) {
      this.onProgress('Block definitions loaded', total, total);
    }

    console.log(`[BlockDefinitionLoader] Loaded ${this.definitions.size} block definitions`);
    return this.definitions;
  }

  /**
   * Get all blockstate names from the pack's blockstates map
   */
  _getBlockstateNames(packManager) {
    // TexturePackManager stores blockstates in a Map
    const names = [];
    if (packManager.blockstates) {
      for (const name of packManager.blockstates.keys()) {
        names.push(name);
      }
    }
    return names.sort();
  }

  /**
   * Parse a blockstate JSON into a BlockDefinition
   */
  _parseBlockstate(blockName, blockstate) {
    const definition = {
      name: blockName,
      blockstate: blockstate,
      properties: new Set(),
      propertyValues: new Map(),
      isMultipart: false,
      variants: [],
    };

    if (blockstate.variants) {
      // Variants format: { "prop1=val1,prop2=val2": {...} }
      definition.isMultipart = false;
      
      for (const variantKey of Object.keys(blockstate.variants)) {
        definition.variants.push(variantKey);
        this._extractPropertiesFromVariantKey(variantKey, definition);
      }
    } else if (blockstate.multipart) {
      // Multipart format: array of { when: {...}, apply: {...} }
      definition.isMultipart = true;
      
      for (const part of blockstate.multipart) {
        if (part.when) {
          this._extractPropertiesFromWhen(part.when, definition);
        }
      }
    }

    return definition;
  }

  /**
   * Extract property names and values from a variant key like "facing=east,half=bottom"
   */
  _extractPropertiesFromVariantKey(variantKey, definition) {
    if (!variantKey || variantKey === '') return;
    
    const pairs = variantKey.split(',');
    for (const pair of pairs) {
      const [propName, propValue] = pair.split('=');
      if (propName && propValue !== undefined) {
        definition.properties.add(propName);
        
        if (!definition.propertyValues.has(propName)) {
          definition.propertyValues.set(propName, new Set());
        }
        definition.propertyValues.get(propName).add(propValue);
      }
    }
  }

  /**
   * Extract property names and values from a multipart 'when' condition
   */
  _extractPropertiesFromWhen(when, definition) {
    if (when.OR) {
      // Explicit OR condition: array of conditions
      for (const cond of when.OR) {
        this._extractPropertiesFromWhen(cond, definition);
      }
      return;
    }

    if (when.AND) {
      // Explicit AND condition: array of conditions (used by chiseled_bookshelf)
      for (const cond of when.AND) {
        this._extractPropertiesFromWhen(cond, definition);
      }
      return;
    }

    // Regular condition: { prop: value } or { prop: "value1|value2" }
    for (const [propName, propValue] of Object.entries(when)) {
      if (propName === 'OR' || propName === 'AND') continue;
      
      definition.properties.add(propName);
      
      if (!definition.propertyValues.has(propName)) {
        definition.propertyValues.set(propName, new Set());
      }
      
      // Handle OR within value: "true|false"
      const values = String(propValue).split('|');
      for (const val of values) {
        definition.propertyValues.get(propName).add(val);
      }
    }
  }

  /**
   * Get a block definition by name
   * @param {string} blockName - Block name without minecraft: prefix
   * @returns {BlockDefinition|null}
   */
  getDefinition(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    return this.definitions.get(normalized) || null;
  }

  /**
   * Check if a block exists in the pack
   * @param {string} blockName
   * @returns {boolean}
   */
  hasBlock(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    return this.definitions.has(normalized);
  }

  /**
   * Get all block names
   * @returns {string[]}
   */
  getAllBlockNames() {
    return Array.from(this.definitions.keys());
  }

  /**
   * Get all possible property combinations for a block
   * Used for pre-computing all geometry variants
   * @param {string} blockName
   * @returns {Object[]} Array of property objects like [{facing: "north", half: "bottom"}, ...]
   */
  getAllPropertyCombinations(blockName) {
    const definition = this.getDefinition(blockName);
    if (!definition) return [{}];
    
    if (definition.properties.size === 0) {
      return [{}]; // No properties, single default state
    }

    // Generate cartesian product of all property values
    const propNames = Array.from(definition.properties);
    const propValueArrays = propNames.map(name => 
      Array.from(definition.propertyValues.get(name) || [])
    );

    return this._cartesianProduct(propNames, propValueArrays);
  }

  /**
   * Generate cartesian product of property values
   */
  _cartesianProduct(propNames, propValueArrays) {
    if (propNames.length === 0) return [{}];
    
    const result = [];
    
    function generate(index, current) {
      if (index === propNames.length) {
        result.push({ ...current });
        return;
      }
      
      const propName = propNames[index];
      const values = propValueArrays[index];
      
      if (values.length === 0) {
        generate(index + 1, current);
      } else {
        for (const value of values) {
          current[propName] = value;
          generate(index + 1, current);
        }
        delete current[propName];
      }
    }
    
    generate(0, {});
    return result;
  }

  /**
   * Derive block category from block name (minimal hardcoding - just for fluid detection)
   * Everything else is derived from model data
   * @param {string} blockName
   * @returns {'solid'|'fluid'|'air'}
   */
  deriveBlockCategory(blockName) {
    const name = blockName.replace('minecraft:', '');
    
    // Air blocks
    if (name === 'air' || name === 'cave_air' || name === 'void_air') {
      return 'air';
    }
    
    // Fluid blocks - the only thing we need to detect by name
    // because fluids have special rendering (height levels)
    if (name === 'water' || name === 'flowing_water' || 
        name === 'lava' || name === 'flowing_lava') {
      return 'fluid';
    }
    
    // Everything else is solid (transparency determined by model/texture data)
    return 'solid';
  }

  /**
   * Get statistics about loaded definitions
   */
  getStats() {
    let totalVariants = 0;
    let multipartCount = 0;
    let variantCount = 0;
    
    for (const def of this.definitions.values()) {
      if (def.isMultipart) {
        multipartCount++;
      } else {
        variantCount++;
        totalVariants += def.variants.length;
      }
    }
    
    return {
      totalBlocks: this.definitions.size,
      multipartBlocks: multipartCount,
      variantBlocks: variantCount,
      totalVariants: totalVariants,
    };
  }

  /**
   * Clear all loaded definitions
   */
  clear() {
    this.definitions.clear();
    this.loaded = false;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the BlockDefinitionLoader singleton
 * @returns {BlockDefinitionLoader}
 */
export function getBlockDefinitionLoader() {
  if (!instance) {
    instance = new BlockDefinitionLoader();
  }
  return instance;
}

export { BlockDefinitionLoader };
export default BlockDefinitionLoader;


