/**
 * EntityStateLookup - Maps block names and NBT data to entity states
 * 
 * Handles the conversion from Minecraft block data to the packed EntityState
 * format expected by the WASM entity mesher.
 * 
 * ## EntityState Bit Layout (32 bits)
 * - [0-7]:   Entity type index (256 types max)
 * - [8-15]:  Variant index (256 variants max)
 * - [16-19]: Y rotation (0-15 for fine rotation, 0-3 for facing)
 * - [20-23]: Color index (16 colors for beds/banners/shulkers)
 * - [24-31]: Flags (hasBannerPatterns, isWallMounted, etc.)
 */

// Entity type indices (must match baked-block-entities.bin order)
// These are built from the binary index, check with: xxd public/assets/baked-block-entities.bin | head -50
const ENTITY_TYPE_INDEX = {
  // Chests (indices 0-2)
  'chest_single': 0,
  'chest_double_left': 1,
  'chest_double_right': 2,
  // Beds (indices 3-4)
  'bed_head': 3,
  'bed_foot': 4,
  // Signs (indices 5-7)
  'sign_standing': 5,
  'sign_wall': 6,
  'hanging_sign': 7,
  // Skulls (indices 8-14)
  'skull_skeleton': 8,
  'skull_wither_skeleton': 9,
  'skull_zombie': 10,
  'skull_creeper': 11,
  'skull_player': 12,
  'skull_dragon': 13,
  'skull_piglin': 14,
  // Other (indices 15-23)
  'bell': 15,
  'shulker_box': 16,
  'banner_standing': 17,
  'banner_wall': 18,
  'banner_flag': 19,
  'conduit_shell': 20,
  'conduit_eye': 21,
  'decorated_pot': 22,
  'book': 23,
  // Copper golem statues (indices 24-27)
  'copper_golem_standing': 24,
  'copper_golem_sitting': 25,
  'copper_golem_running': 26,
  'copper_golem_star': 27,
};

// Color indices (Minecraft dye order)
const COLOR_INDEX = {
  'white': 0,
  'orange': 1,
  'magenta': 2,
  'light_blue': 3,
  'yellow': 4,
  'lime': 5,
  'pink': 6,
  'gray': 7,
  'light_gray': 8,
  'cyan': 9,
  'purple': 10,
  'blue': 11,
  'brown': 12,
  'green': 13,
  'red': 14,
  'black': 15,
};

// Facing to rotation mapping using 16-step rotation
// Each step = 22.5 degrees: north=0°, east=90°(4), south=180°(8), west=270°(12)
const FACING_TO_ROTATION = {
  'north': 0,
  'east': 4,
  'south': 8,
  'west': 12,
};

// Skull type mapping (block name -> baked model name)
const SKULL_TYPES = {
  'skeleton_skull': 'skull_skeleton',
  'skeleton_wall_skull': 'skull_skeleton',
  'wither_skeleton_skull': 'skull_wither_skeleton',
  'wither_skeleton_wall_skull': 'skull_wither_skeleton',
  'creeper_head': 'skull_creeper',
  'creeper_wall_head': 'skull_creeper',
  'zombie_head': 'skull_zombie',
  'zombie_wall_head': 'skull_zombie',
  'player_head': 'skull_player',
  'player_wall_head': 'skull_player',
  'dragon_head': 'skull_dragon',
  'dragon_wall_head': 'skull_dragon',
  'piglin_head': 'skull_piglin',
  'piglin_wall_head': 'skull_piglin',
};

// Entity state flags
const FLAG_HAS_BANNER_PATTERNS = 1 << 24;
const FLAG_IS_WALL_MOUNTED = 1 << 25;
const FLAG_IS_LIT = 1 << 26;
const FLAG_IS_OPEN = 1 << 27;

/**
 * Pack entity state from components
 */
export function packEntityState(entityType, variant, rotation, color, flags) {
  return (
    (entityType & 0xFF) |
    ((variant & 0xFF) << 8) |
    ((rotation & 0x0F) << 16) |
    ((color & 0x0F) << 20) |
    ((flags & 0xFF) << 24)
  );
}

/**
 * EntityStateLookup class
 * 
 * Provides methods to determine entity type and state from block data.
 */
export class EntityStateLookup {
  constructor() {
    // Cache for block name -> entity type mapping
    this.blockToEntityType = new Map();
    
    // Initialize common block entity mappings
    this._initMappings();
  }
  
  _initMappings() {
    // Chests - these get resolved to specific models based on 'type' property
    this.blockToEntityType.set('chest', 'chest_single');
    this.blockToEntityType.set('trapped_chest', 'chest_single');
    this.blockToEntityType.set('ender_chest', 'chest_single');
    // Copper chests
    this.blockToEntityType.set('copper_chest', 'chest_single');
    this.blockToEntityType.set('exposed_copper_chest', 'chest_single');
    this.blockToEntityType.set('weathered_copper_chest', 'chest_single');
    this.blockToEntityType.set('oxidized_copper_chest', 'chest_single');
    this.blockToEntityType.set('waxed_copper_chest', 'chest_single');
    this.blockToEntityType.set('waxed_exposed_copper_chest', 'chest_single');
    this.blockToEntityType.set('waxed_weathered_copper_chest', 'chest_single');
    this.blockToEntityType.set('waxed_oxidized_copper_chest', 'chest_single');
    
    // Bells
    this.blockToEntityType.set('bell', 'bell');
    
    // Books (for enchanting tables)
    this.blockToEntityType.set('enchanting_table', 'book');
    
    // Decorated pots
    this.blockToEntityType.set('decorated_pot', 'decorated_pot');
    
    // Conduit
    this.blockToEntityType.set('conduit', 'conduit_shell');
    
    // Skulls - resolved based on specific block name
    for (const [blockName, entityType] of Object.entries(SKULL_TYPES)) {
      this.blockToEntityType.set(blockName, entityType);
    }
    
    // Banners
    for (const color of Object.keys(COLOR_INDEX)) {
      this.blockToEntityType.set(`${color}_banner`, 'banner_standing');
      this.blockToEntityType.set(`${color}_wall_banner`, 'banner_wall');
    }
    
    // Shulker boxes
    this.blockToEntityType.set('shulker_box', 'shulker_box');
    for (const color of Object.keys(COLOR_INDEX)) {
      this.blockToEntityType.set(`${color}_shulker_box`, 'shulker_box');
    }
    
    // Beds - resolved to bed_head or bed_foot based on 'part' property
    for (const color of Object.keys(COLOR_INDEX)) {
      this.blockToEntityType.set(`${color}_bed`, 'bed_foot'); // Default to foot, resolved in getEntityState
    }
    
    // Signs - all wood types
    const woodTypes = [
      'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
      'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak'
    ];
    
    for (const wood of woodTypes) {
      // Standing signs
      this.blockToEntityType.set(`${wood}_sign`, 'sign_standing');
      // Wall signs
      this.blockToEntityType.set(`${wood}_wall_sign`, 'sign_wall');
      // Hanging signs
      this.blockToEntityType.set(`${wood}_hanging_sign`, 'hanging_sign');
      // Wall hanging signs - use hanging_sign model (same geometry)
      this.blockToEntityType.set(`${wood}_wall_hanging_sign`, 'hanging_sign');
    }
    
    // Copper golem statues - default to standing pose, resolved in getEntityState
    // 4 oxidation levels + 4 waxed versions = 8 block types
    const copperGolemStatues = [
      'copper_golem_statue',
      'exposed_copper_golem_statue',
      'weathered_copper_golem_statue',
      'oxidized_copper_golem_statue',
      'waxed_copper_golem_statue',
      'waxed_exposed_copper_golem_statue',
      'waxed_weathered_copper_golem_statue',
      'waxed_oxidized_copper_golem_statue',
    ];
    for (const statue of copperGolemStatues) {
      this.blockToEntityType.set(statue, 'copper_golem_standing');
    }
  }
  
  /**
   * Check if a block has an associated block entity that we render
   * @param {string} blockName - Block name without minecraft: prefix
   * @returns {boolean}
   */
  isBlockEntity(blockName) {
    return this.blockToEntityType.has(blockName);
  }
  
  /**
   * Get entity type name for a block
   * @param {string} blockName - Block name
   * @returns {string | null}
   */
  getEntityTypeName(blockName) {
    return this.blockToEntityType.get(blockName) || null;
  }
  
  /**
   * Get entity type index
   * @param {string} entityTypeName - Entity type name
   * @returns {number}
   */
  getEntityTypeIndex(entityTypeName) {
    return ENTITY_TYPE_INDEX[entityTypeName] ?? 0;
  }
  
  /**
   * Get the full entity state from block data
   * @param {string} blockName - Block name
   * @param {Object} blockProperties - Block state properties
   * @param {Object} nbtData - NBT data if available
   * @returns {number | null} Packed entity state or null if not an entity block
   */
  getEntityState(blockName, blockProperties, nbtData) {
    let entityTypeName = this.getEntityTypeName(blockName);
    if (!entityTypeName) {
      return null;
    }
    
    // Handle chests - type property determines single/left/right
    // Default mapping is 'chest_single', but double chests use left/right
    if (entityTypeName === 'chest_single') {
      const type = blockProperties?.type || 'single';
      if (type === 'left') entityTypeName = 'chest_double_left';
      else if (type === 'right') entityTypeName = 'chest_double_right';
      // 'single' stays as 'chest_single'
    }
    
    // Handle beds - part property determines head/foot
    // Default mapping is 'bed_foot', but head part uses 'bed_head'
    if (entityTypeName === 'bed_foot') {
      const part = blockProperties?.part || 'foot';
      entityTypeName = part === 'head' ? 'bed_head' : 'bed_foot';
    }
    
    // Handle copper golem statues - pose property determines model
    // Poses: standing, sitting, running, star
    if (entityTypeName === 'copper_golem_standing') {
      const pose = blockProperties?.pose || 'standing';
      const poseToModel = {
        'standing': 'copper_golem_standing',
        'sitting': 'copper_golem_sitting',
        'running': 'copper_golem_running',
        'star': 'copper_golem_star',
      };
      entityTypeName = poseToModel[pose] || 'copper_golem_standing';
    }
    
    const entityType = this.getEntityTypeIndex(entityTypeName);
    const variant = this._getVariant(blockName, blockProperties, entityTypeName);
    const rotation = this._getRotation(blockName, blockProperties, nbtData, entityTypeName);
    const color = this._getColor(blockName, nbtData);
    const flags = this._getFlags(blockName, blockProperties, nbtData, entityTypeName);
    
    return packEntityState(entityType, variant, rotation, color, flags);
  }
  
  /**
   * Get variant index for an entity
   */
  _getVariant(blockName, blockProperties, entityTypeName) {
    // Most entities use variant 0 (default)
    // Chests are now handled by separate entity types (chest, chest_left, chest_right)
    // rather than variants
    return 0;
  }
  
  /**
   * Get rotation value
   */
  _getRotation(blockName, blockProperties, nbtData, entityTypeName) {
    // Check for 16-rotation blocks (skulls, banners, standing signs)
    // Note: entityTypeName now uses actual model names like 'skull_skeleton', 'banner_standing', 'sign_standing'
    const isSkull = entityTypeName.startsWith('skull_');
    const isBannerStanding = entityTypeName === 'banner_standing';
    const isSignStanding = entityTypeName === 'sign_standing';
    const isHangingSign = entityTypeName === 'hanging_sign';
    const isBannerWall = entityTypeName === 'banner_wall';
    const isSignWall = entityTypeName === 'sign_wall';
    
    // Standing signs, banners use rotation property (16 rotations)
    if (isSignStanding || isBannerStanding) {
      const rotation = blockProperties?.rotation;
      if (rotation !== undefined) {
        return parseInt(rotation) & 0x0F;
      }
    }
    
    // Wall mounted signs and banners use facing
    if (isSignWall || isBannerWall) {
      const facing = blockProperties?.facing || 'north';
      return FACING_TO_ROTATION[facing] || 0;
    }
    
    // Skulls can be standing (16 rotations) or wall-mounted (4 rotations)
    if (isSkull) {
      // Check if wall skull
      if (blockName.includes('wall')) {
        const facing = blockProperties?.facing || 'north';
        return FACING_TO_ROTATION[facing] || 0;
      }
      // Standing skull uses rotation property
      const rotation = blockProperties?.rotation;
      if (rotation !== undefined) {
        return parseInt(rotation) & 0x0F;
      }
    }
    
    // Hanging signs use rotation property (16 rotations)
    if (isHangingSign) {
      // Wall hanging signs use facing
      if (blockName.includes('wall_hanging')) {
        const facing = blockProperties?.facing || 'north';
        return FACING_TO_ROTATION[facing] || 0;
      }
      // Standing hanging signs use rotation
      const rotation = blockProperties?.rotation;
      if (rotation !== undefined) {
        return parseInt(rotation) & 0x0F;
      }
    }
    
    // Beds use facing property
    if (entityTypeName.startsWith('bed_')) {
      const facing = blockProperties?.facing || 'south';
      return FACING_TO_ROTATION[facing] || 0;
    }
    
    // Chests use facing property
    if (entityTypeName.startsWith('chest_')) {
      const facing = blockProperties?.facing || 'north';
      return FACING_TO_ROTATION[facing] || 0;
    }
    
    // Copper golem statues store rotation in NBT as yRot (degrees)
    // Convert degrees to 0-15 rotation (16 discrete rotations)
    if (entityTypeName.startsWith('copper_golem_')) {
      // Try yRot from NBT (stored as float degrees 0-360)
      const yRot = nbtData?.yRot ?? nbtData?.Rotation?.[0] ?? nbtData?.bodyRot;
      if (yRot !== undefined) {
        // Convert degrees to 16-step rotation
        // 0° = north, 90° = east, 180° = south, 270° = west
        // Each step is 22.5°
        const normalizedRot = ((yRot % 360) + 360) % 360;
        return Math.round(normalizedRot / 22.5) % 16;
      }
      // Fall back to facing property if available
      const facing = blockProperties?.facing || 'north';
      return FACING_TO_ROTATION[facing] || 0;
    }
    
    // Default facing-based rotation
    const facing = blockProperties?.facing || 'north';
    return FACING_TO_ROTATION[facing] || 0;
  }
  
  /**
   * Get color index
   */
  _getColor(blockName, nbtData) {
    // Extract color from block name
    for (const [colorName, index] of Object.entries(COLOR_INDEX)) {
      if (blockName.startsWith(colorName + '_')) {
        return index;
      }
    }
    
    // Default to white
    return 0;
  }
  
  /**
   * Get flags
   */
  _getFlags(blockName, blockProperties, nbtData, entityTypeName) {
    let flags = 0;
    
    // Wall-mounted flag
    if (entityTypeName.includes('wall')) {
      flags |= (1 << 1); // FLAG_IS_WALL_MOUNTED bit in lower byte
    }
    
    // Banner patterns flag
    if (nbtData?.Patterns && nbtData.Patterns.length > 0) {
      flags |= (1 << 0); // FLAG_HAS_BANNER_PATTERNS bit in lower byte
    }
    
    // Lit flag (for candles, etc.)
    if (blockProperties?.lit === 'true') {
      flags |= (1 << 2); // FLAG_IS_LIT bit in lower byte
    }
    
    return flags;
  }
}

/**
 * WorkerEntityStateGrid
 * 
 * Collects entity states from parsed chunks and serializes them
 * for the WASM entity mesher.
 */
export class WorkerEntityStateGrid {
  constructor() {
    // Map of "x,y,z" -> entityState
    this.entities = new Map();
  }
  
  /**
   * Add an entity to the grid
   * @param {number} x - World X coordinate
   * @param {number} y - World Y coordinate
   * @param {number} z - World Z coordinate
   * @param {number} state - Packed entity state
   */
  addEntity(x, y, z, state) {
    this.entities.set(`${x},${y},${z}`, state);
  }
  
  /**
   * Get entity at position
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number | undefined}
   */
  getEntity(x, y, z) {
    return this.entities.get(`${x},${y},${z}`);
  }
  
  /**
   * Clear all entities
   */
  clear() {
    this.entities.clear();
  }
  
  /**
   * Get entity count
   * @returns {number}
   */
  get size() {
    return this.entities.size;
  }
  
  /**
   * Serialize for WASM
   * 
   * Format:
   *   u32: entity count
   *   [entries]:
   *     i32: x
   *     i32: y
   *     i32: z
   *     u32: state
   * 
   * @returns {Uint8Array}
   */
  serializeForWasm() {
    const count = this.entities.size;
    const buffer = new ArrayBuffer(4 + count * 16);
    const view = new DataView(buffer);
    
    view.setUint32(0, count, true);
    
    let offset = 4;
    for (const [key, state] of this.entities) {
      const [x, y, z] = key.split(',').map(Number);
      
      view.setInt32(offset, x, true);
      offset += 4;
      view.setInt32(offset, y, true);
      offset += 4;
      view.setInt32(offset, z, true);
      offset += 4;
      view.setUint32(offset, state, true);
      offset += 4;
    }
    
    return new Uint8Array(buffer);
  }
  
  /**
   * Merge entities from another grid
   * @param {WorkerEntityStateGrid} other
   */
  mergeFrom(other) {
    for (const [key, state] of other.entities) {
      this.entities.set(key, state);
    }
  }
}

// Singleton lookup instance
let lookupInstance = null;

/**
 * Get the singleton EntityStateLookup instance
 * @returns {EntityStateLookup}
 */
export function getEntityStateLookup() {
  if (!lookupInstance) {
    lookupInstance = new EntityStateLookup();
  }
  return lookupInstance;
}

export default EntityStateLookup;
