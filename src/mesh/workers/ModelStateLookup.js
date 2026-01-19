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
        isFullCube: blockData.isFullCube || false, // Full cubes handled by greedy mesher
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
   * Full cube blocks with ONLY a default variant are handled by greedy mesher.
   * Full cube blocks with multiple variants or state properties need model meshing.
   * Block entities (beds, chests, signs, etc.) are handled by the entity mesher.
   * @param {string} blockName - Block name (without minecraft:)
   * @returns {boolean} True if this is a model block with geometry
   */
  isModelBlock(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    if (!this.blockNameToIndex.has(normalized)) {
      return false;
    }
    
    // Block entities have special rendering and no geometry in the block model registry
    if (this._isBlockEntity(normalized)) {
      return false;
    }
    
    // Check metadata flags
    const metadata = this.blockMetadata.get(normalized);
    const variants = this.blockVariants.get(normalized);
    
    if (metadata) {
      // Multipart blocks are handled by JS MultipartMesher
      if (metadata.isMultipart) {
        return false;
      }
      
      // Full cube blocks are handled by greedy mesher ONLY if they have:
      // 1. A single 'default' variant (no state-dependent geometry)
      // 2. No rotation properties (no directional textures)
      // 3. No geometry properties (no state changes affecting model)
      // Blocks like furnace, smoker, loom have facing/lit properties and need model meshing
      if (metadata.isFullCube) {
        const hasOnlyDefaultVariant = variants && variants.size === 1 && variants.has('default');
        const hasNoStateProperties = metadata.geometryProperties.length === 0 &&
                                     metadata.rotationProperties.length === 0;
        
        // Only skip truly simple full cubes (stone, dirt, etc.)
        if (hasOnlyDefaultVariant && hasNoStateProperties) {
          return false;
        }
        // Otherwise, this full cube has variants/states and needs model meshing
        // (furnace, smoker, bee_nest, beehive, redstone_lamp, etc.)
      }
    }
    
    // Also check multipart patterns - these blocks are handled by JS MultipartMesher
    // even if they don't have multipart blockstate format
    if (this._isMultipartByPattern(normalized)) {
      return false;
    }
    
    // Only return true if the block has variants (geometry)
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
      'chorus_plant', 'glow_lichen', 'sculk_vein',
      'fire', 'soul_fire',
      'mushroom_block', 'mushroom_stem', // brown/red_mushroom_block and mushroom_stem
      '_shelf', // wood type shelves (oak_shelf, spruce_shelf, etc.)
      'brewing_stand',
      'resin_clump', // Multipart block with directional faces
    ];
    
    // Exact matches (must match ModelMesher.js MULTIPART_EXACT)
    const exactMatches = new Set([
      'bamboo',
      'chorus_plant',
      'composter', // Multipart block with level-based content layers
      'vine', // The classic wall-climbing vine (not cave_vines, etc.)
      'pink_petals', // Flower patch with flower_amount property
      'leaf_litter', // Ground cover with segment_amount property
      'chiseled_bookshelf', // Has slot_X_occupied properties
    ]);
    if (exactMatches.has(blockName)) {
      return true;
    }
    
    return patterns.some(pattern => blockName.includes(pattern));
  }
  
  /**
   * Check if a block is a block entity (special rendering, no block model geometry)
   * Block entities like beds, chests, signs, skulls, banners, etc. have their geometry
   * stored separately and are rendered by the entity mesher.
   * 
   * NOTE: Blocks with complex models but still using block model geometry (lectern, 
   * enchanting_table) are NOT block entities - they should be meshed by V3 mesher.
   * Only blocks that use completely separate entity geometry (chests with lids,
   * animated signs, etc.) should be here.
   * @private
   */
  _isBlockEntity(blockName) {
    // Exact matches for simple block entities
    // NOTE: enchanting_table and lectern have proper block model geometry
    // and should be rendered by V3 mesher, not excluded as block entities
    const exactMatches = new Set([
      'chest', 'trapped_chest', 'ender_chest',
      'bell',
      'shulker_box',
      'conduit', 'end_portal', 'end_gateway',
      'spawner', 'trial_spawner',
      'decorated_pot', 'brushable_block',
    ]);
    if (exactMatches.has(blockName)) {
      return true;
    }
    
    // Pattern-based matching for block entities
    // Signs (all wood types, standing and wall, regular and hanging)
    if (blockName.endsWith('_sign') || blockName.endsWith('_hanging_sign')) {
      return true;
    }
    
    // Beds (all colors)
    if (blockName.endsWith('_bed')) {
      return true;
    }
    
    // Skulls and heads (all types, standing and wall)
    if (blockName.endsWith('_skull') || blockName.endsWith('_head') ||
        blockName.endsWith('_wall_skull') || blockName.endsWith('_wall_head')) {
      return true;
    }
    
    // Banners (all colors, standing and wall)
    if (blockName.endsWith('_banner') || blockName.endsWith('_wall_banner')) {
      return true;
    }
    
    // Shulker boxes (all colors)
    if (blockName.endsWith('_shulker_box')) {
      return true;
    }
    
    // Chests (copper variants: copper_chest, exposed_copper_chest, etc.)
    // Note: chest, trapped_chest, ender_chest are already in exactMatches
    if (blockName.endsWith('_chest')) {
      return true;
    }
    
    // Copper golem statues (all oxidation levels and waxed variants)
    if (blockName.endsWith('_golem_statue')) {
      return true;
    }
    
    return false;
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
