/**
 * ModelStateLookup - Converts block states to packed ModelState values
 * 
 * This module provides workers with the ability to encode block states
 * into 32-bit ModelState values that can be looked up in WASM without
 * needing to match state IDs with the main thread.
 * 
 * ModelState bit layout (32 bits):
 * - [0-11]: Block index (12 bits, 4096 blocks max)
 * - [12-19]: Variant index (8 bits, 256 variants max)
 * - [20-23]: Rotation (4 bits, 0-3 = 0°/90°/180°/270°)
 * - [24-31]: Flags (8 bits)
 */

// State flags
export const STATE_FLAGS = {
  FLIPPED: 0x01,
  WATERLOGGED: 0x02,
  LIT: 0x04,
  POWERED: 0x08,
  OPEN: 0x10,
  HAS_OVERLAY: 0x20,
};

// Facing to rotation mapping
// Adjusted to compensate for model baking orientation
const FACING_TO_ROTATION = {
  north: 3,
  east: 0,
  south: 1,
  west: 2,
};

// Axis to rotation (for logs, pillars)
// Axis encoding - stored in upper bits of rotation field
// Rotation field is 4 bits: [axis (2 bits) | y_rotation (2 bits)]
// axis: 0=Y (default), 1=X, 2=Z
const AXIS_TO_BITS = {
  y: 0,
  x: 1,
  z: 2,
};

/**
 * Model State Lookup - initialized from manifest data
 */
export class ModelStateLookup {
  constructor() {
    // Block name → block index
    this.blockNameToIndex = new Map();
    
    // Block name → variant key → variant index
    this.blockVariants = new Map();
    
    // Block name → metadata (rotationProperties, flipProperties, etc.)
    this.blockMetadata = new Map();
    
    // For fast lookups during chunk decoding
    this.initialized = false;
  }
  
  /**
   * Initialize from manifest and baked data
   * @param {Object} manifest - The block-model-manifest.json data
   * @param {Map<string, number>} textureNameToIndex - Texture name → atlas index
   */
  init(manifest, textureNameToIndex) {
    if (!manifest || !manifest.blocks) {
      console.warn('[ModelStateLookup] No manifest data');
      return;
    }
    
    let blockIndex = 0;
    
    for (const [blockName, blockData] of Object.entries(manifest.blocks)) {
      // Assign block index
      this.blockNameToIndex.set(blockName, blockIndex);
      
      // Build variant lookup
      const variantMap = new Map();
      let variantIndex = 0;
      
      for (const variantKey of Object.keys(blockData.variants)) {
        variantMap.set(variantKey, variantIndex);
        variantIndex++;
      }
      
      this.blockVariants.set(blockName, variantMap);
      
      // Store metadata
      this.blockMetadata.set(blockName, {
        rotationProperties: blockData.rotationProperties || [],
        flipProperties: blockData.flipProperties || [],
        geometryProperties: blockData.geometryProperties || [],
        flagProperties: blockData.flagProperties || [],
        flags: blockData.flags || {},
        isMultipart: blockData.isMultipart || false,
      });
      
      blockIndex++;
    }
    
    this.initialized = true;
    console.log(`[ModelStateLookup] Initialized with ${blockIndex} blocks`);
  }
  
  /**
   * Check if a block is a model block (has pre-baked geometry)
   * Returns true if the block has variants in the manifest AND is not a multipart block.
   * Multipart blocks are handled by the JS MultipartMesher instead.
   * @param {string} blockName - Block name (without minecraft:)
   * @returns {boolean} True if this is a model block with geometry
   */
  isModelBlock(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    if (!this.blockNameToIndex.has(normalized)) {
      return false;
    }
    
    // Check if this is a multipart block by metadata flag
    const metadata = this.blockMetadata.get(normalized);
    if (metadata && metadata.isMultipart) {
      return false;
    }
    
    // Also check multipart patterns - these blocks are handled by JS MultipartMesher
    // even if they don't have multipart blockstate format
    if (this._isMultipartByPattern(normalized)) {
      return false;
    }
    
    // Only return true if the block has variants (geometry)
    const variants = this.blockVariants.get(normalized);
    return variants && variants.size > 0;
  }
  
  /**
   * Check if a block is handled by multipart mesher based on name patterns
   * @private
   */
  _isMultipartByPattern(blockName) {
    // Patterns that indicate multipart meshing (must match ModelMesher.js MULTIPART_PATTERNS)
    const patterns = [
      '_fence', '_wall', '_pane', 'iron_bars', 'copper_bars',
      'redstone_wire', 'tripwire',
      'chorus_plant', 'vine', 'glow_lichen',
      'fire', 'soul_fire',
      'mushroom_block',
      'shelf',
      'brewing_stand',
    ];
    
    // Exact matches
    const exactMatches = new Set(['bamboo', 'chorus_plant']);
    if (exactMatches.has(blockName)) {
      return true;
    }
    
    return patterns.some(pattern => blockName.includes(pattern));
  }
  
  /**
   * Get packed ModelState for a block
   * @param {string} blockName - Block name (without minecraft:)
   * @param {Object} properties - Block properties
   * @returns {number} Packed 32-bit ModelState, or 0 if not a model block
   */
  getModelState(blockName, properties = {}) {
    const normalized = blockName.replace('minecraft:', '');
    
    const blockIndex = this.blockNameToIndex.get(normalized);
    if (blockIndex === undefined) {
      return 0; // Not a model block
    }
    
    const metadata = this.blockMetadata.get(normalized);
    const variants = this.blockVariants.get(normalized);
    
    if (!metadata || !variants) {
      return 0;
    }
    
    // Build variant key from geometry-affecting properties
    const variantKey = this._buildVariantKey(properties, metadata.geometryProperties);
    
    // Get variant index
    let variantIndex = variants.get(variantKey);
    if (variantIndex === undefined) {
      // Try default variant
      variantIndex = variants.get('default') ?? 0;
    }
    
    // Get rotation from rotation properties
    const rotation = this._getRotation(properties, metadata.rotationProperties);
    
    // Build flags from properties
    const flags = this._getFlags(properties, metadata.flipProperties);
    
    // Pack into 32-bit value
    return (blockIndex & 0xFFF)
      | ((variantIndex & 0xFF) << 12)
      | ((rotation & 0xF) << 20)
      | ((flags & 0xFF) << 24);
  }
  
  /**
   * Get block index by name
   */
  getBlockIndex(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    return this.blockNameToIndex.get(normalized) ?? -1;
  }
  
  /**
   * Build variant key from geometry-affecting properties
   */
  _buildVariantKey(properties, geometryProperties) {
    if (!properties || geometryProperties.length === 0) {
      return 'default';
    }
    
    const parts = [];
    for (const prop of geometryProperties.sort()) {
      if (properties[prop] !== undefined) {
        parts.push(`${prop}=${properties[prop]}`);
      }
    }
    
    return parts.length > 0 ? parts.join(',') : 'default';
  }
  
  /**
   * Get rotation value from rotation properties
   * Returns a 4-bit value: [axis (2 bits) | y_rotation (2 bits)]
   * - Bits 0-1: Y-axis rotation (0-3 = 0°/90°/180°/270°)
   * - Bits 2-3: Axis (0=Y, 1=X, 2=Z)
   */
  _getRotation(properties, rotationProperties) {
    let yRotation = 0;
    let axisBits = 0;
    
    for (const prop of rotationProperties) {
      const value = properties[prop];
      if (value !== undefined) {
        if (prop === 'facing') {
          yRotation = FACING_TO_ROTATION[value] ?? 0;
        } else if (prop === 'axis') {
          // Axis stored in upper 2 bits
          axisBits = AXIS_TO_BITS[value] ?? 0;
        } else if (prop === 'rotation') {
          // For signs: 0-15 → 0-3 (90° increments)
          yRotation = Math.floor(parseInt(value, 10) / 4) % 4;
        }
      }
    }
    
    // Pack: [axis (2 bits) | y_rotation (2 bits)]
    return (axisBits << 2) | (yRotation & 0x3);
  }
  
  /**
   * Get flags byte from properties
   */
  _getFlags(properties, flipProperties) {
    let flags = 0;
    
    // Check flip properties
    for (const prop of flipProperties) {
      if (prop === 'half' && properties.half === 'top') {
        flags |= STATE_FLAGS.FLIPPED;
      }
      if (prop === 'type' && properties.type === 'top') {
        flags |= STATE_FLAGS.FLIPPED;
      }
    }
    
    // Check common flag properties
    if (properties.waterlogged === 'true') {
      flags |= STATE_FLAGS.WATERLOGGED;
    }
    if (properties.lit === 'true') {
      flags |= STATE_FLAGS.LIT;
    }
    if (properties.powered === 'true') {
      flags |= STATE_FLAGS.POWERED;
    }
    if (properties.open === 'true') {
      flags |= STATE_FLAGS.OPEN;
    }
    
    return flags;
  }
  
  /**
   * Export lookup tables for WASM initialization
   * Returns data that can be used to initialize the block model registry in WASM
   */
  exportForWasm() {
    const blockNames = [...this.blockNameToIndex.keys()];
    const indices = blockNames.map(name => this.blockNameToIndex.get(name));
    
    // Build variant info for each block
    const variantInfo = {};
    for (const [name, variants] of this.blockVariants) {
      variantInfo[name] = [...variants.entries()];
    }
    
    return {
      blockNames,
      indices,
      variantInfo,
    };
  }
}

// Singleton instance
let instance = null;

export function getModelStateLookup() {
  if (!instance) {
    instance = new ModelStateLookup();
  }
  return instance;
}

export function initModelStateLookup(manifest, textureNameToIndex) {
  const lookup = getModelStateLookup();
  lookup.init(manifest, textureNameToIndex);
  return lookup;
}
