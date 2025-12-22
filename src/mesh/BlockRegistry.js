/**
 * BlockRegistry - Central registry for block type definitions
 * 
 * Maps block names to numeric IDs and provides rendering properties.
 * All block lookups in the meshing pipeline use numeric IDs for performance.
 */

// Block categories determine meshing strategy
export const BlockCategory = {
  SOLID: 'solid',           // Opaque cubes - greedy meshing
  TRANSPARENT: 'transparent', // Transparent cubes - separate pass
  FLUID: 'fluid',           // Water/lava - height-aware meshing
  CUSTOM: 'custom',         // Non-cube shapes - instanced rendering (future)
  AIR: 'air',               // Skip during meshing
};

// Pre-defined block colors (hex values)
const BLOCK_COLORS = {
  // Stone variants
  'stone': 0x808080,
  'granite': 0x9A6C4C,
  'polished_granite': 0xA67B5B,
  'diorite': 0xBFBFBF,
  'polished_diorite': 0xD0D0D0,
  'andesite': 0x888888,
  'polished_andesite': 0x9A9A9A,
  'deepslate': 0x4A4A4A,
  'cobblestone': 0x7A7A7A,
  'cobbled_deepslate': 0x3A3A3A,
  'bedrock': 0x2A2A2A,
  'tuff': 0x5A5A4A,
  'calcite': 0xE0E0E0,
  
  // Dirt variants
  'dirt': 0x8B6C4C,
  'coarse_dirt': 0x7A5C3C,
  'rooted_dirt': 0x8B6C4C,
  'grass_block': 0x5D8C32,
  'podzol': 0x6A5D3A,
  'mycelium': 0x8B7B7B,
  'mud': 0x3C3C3C,
  'clay': 0x9BA4AF,
  
  // Sand
  'sand': 0xE3D59E,
  'red_sand': 0xBA6629,
  'gravel': 0x8A8A8A,
  'sandstone': 0xD9C896,
  'red_sandstone': 0xA44D22,
  
  // Ores
  'coal_ore': 0x4A4A4A,
  'deepslate_coal_ore': 0x3A3A3A,
  'iron_ore': 0xB8A090,
  'deepslate_iron_ore': 0x8A7060,
  'copper_ore': 0xA67B5B,
  'deepslate_copper_ore': 0x8A5A3A,
  'gold_ore': 0xFCEE4B,
  'deepslate_gold_ore': 0xDAC42B,
  'redstone_ore': 0xFF0000,
  'deepslate_redstone_ore': 0xCC0000,
  'emerald_ore': 0x17DD62,
  'deepslate_emerald_ore': 0x0AAA4A,
  'lapis_ore': 0x1E4B9B,
  'deepslate_lapis_ore': 0x0E3B7B,
  'diamond_ore': 0x4AEDD9,
  'deepslate_diamond_ore': 0x2ACDB9,
  'ancient_debris': 0x6C4A3A,
  'raw_iron_block': 0xD4B090,
  'raw_copper_block': 0xC48050,
  'raw_gold_block': 0xE8C030,
  
  // Metal blocks
  'iron_block': 0xD8D8D8,
  'gold_block': 0xF8D830,
  'diamond_block': 0x62EDD8,
  'emerald_block': 0x2DD070,
  'lapis_block': 0x1E4BA0,
  'redstone_block': 0xB00000,
  'copper_block': 0xC06040,
  'exposed_copper': 0xA08060,
  'weathered_copper': 0x6A9A70,
  'oxidized_copper': 0x4A9A8A,
  'netherite_block': 0x4A4044,
  
  // Wood
  'oak_log': 0x8B7355,
  'spruce_log': 0x4A3728,
  'birch_log': 0xE8E4D5,
  'jungle_log': 0x6A5B3A,
  'acacia_log': 0x6A3D2A,
  'dark_oak_log': 0x3A2714,
  'mangrove_log': 0x6A2A2A,
  'cherry_log': 0x4A2A3A,
  'oak_planks': 0xBA9862,
  'spruce_planks': 0x7A5A3A,
  'birch_planks': 0xC9B87A,
  'jungle_planks': 0xAB8254,
  'acacia_planks': 0xBA6229,
  'dark_oak_planks': 0x4A3314,
  'mangrove_planks': 0x7A3030,
  'cherry_planks': 0xE8B8C0,
  'oak_leaves': 0x3A8B25,
  'spruce_leaves': 0x2A5A35,
  'birch_leaves': 0x5A9A3A,
  'jungle_leaves': 0x3A8B25,
  'acacia_leaves': 0x6A9A4A,
  'dark_oak_leaves': 0x2A5A25,
  'azalea_leaves': 0x5A8A3A,
  'flowering_azalea_leaves': 0x7A5A7A,
  'cherry_leaves': 0xFFAACC,
  'mangrove_leaves': 0x4A8A3A,
  
  // Fluids
  'water': 0x3F76E4,
  'flowing_water': 0x3F76E4,
  'lava': 0xFF6600,
  'flowing_lava': 0xFF6600,
  
  // Building blocks
  'bricks': 0x9A5A4A,
  'stone_bricks': 0x7A7A7A,
  'mossy_stone_bricks': 0x5A7A5A,
  'cracked_stone_bricks': 0x6A6A6A,
  'chiseled_stone_bricks': 0x7A7A7A,
  'deepslate_bricks': 0x4A4A4A,
  'deepslate_tiles': 0x3A3A3A,
  'obsidian': 0x1A0A2A,
  'crying_obsidian': 0x2A1A4A,
  'netherrack': 0x8A3A3A,
  'soul_sand': 0x5A4A3A,
  'soul_soil': 0x4A3A2A,
  'basalt': 0x4A4A4A,
  'smooth_basalt': 0x3A3A3A,
  'polished_basalt': 0x5A5A5A,
  'blackstone': 0x2A2A2A,
  'polished_blackstone': 0x3A3A3A,
  'end_stone': 0xDADA9A,
  'end_stone_bricks': 0xD0D090,
  'purpur_block': 0xAA6AAA,
  'purpur_pillar': 0xBA7ABA,
  
  // Glass
  'glass': 0xC0E0F0,
  'tinted_glass': 0x3A3A3A,
  
  // Terracotta
  'terracotta': 0x9A5A4A,
  'white_terracotta': 0xD9C8B8,
  'orange_terracotta': 0xA45B2A,
  'magenta_terracotta': 0x9A5A7A,
  'light_blue_terracotta': 0x7A8AA0,
  'yellow_terracotta': 0xBA982A,
  'lime_terracotta': 0x6A7A3A,
  'pink_terracotta': 0xA0605A,
  'gray_terracotta': 0x4A3A3A,
  'light_gray_terracotta': 0x8A7A70,
  'cyan_terracotta': 0x5A6A6A,
  'purple_terracotta': 0x7A4A6A,
  'blue_terracotta': 0x4A4A6A,
  'brown_terracotta': 0x5A3A2A,
  'green_terracotta': 0x4A5A3A,
  'red_terracotta': 0x8A3A3A,
  'black_terracotta': 0x3A2A2A,
  
  // Concrete
  'white_concrete': 0xCFCFCF,
  'orange_concrete': 0xE06100,
  'magenta_concrete': 0xA9309F,
  'light_blue_concrete': 0x2389C6,
  'yellow_concrete': 0xF1AF15,
  'lime_concrete': 0x5EA818,
  'pink_concrete': 0xD5658E,
  'gray_concrete': 0x36393D,
  'light_gray_concrete': 0x7D7D73,
  'cyan_concrete': 0x157788,
  'purple_concrete': 0x641F9C,
  'blue_concrete': 0x2C2E8E,
  'brown_concrete': 0x603B1F,
  'green_concrete': 0x495B24,
  'red_concrete': 0x8E2121,
  'black_concrete': 0x080A0F,
  
  // Concrete powder
  'white_concrete_powder': 0xE1E1E1,
  'orange_concrete_powder': 0xE38320,
  'magenta_concrete_powder': 0xC050B0,
  'light_blue_concrete_powder': 0x6AA8D0,
  'yellow_concrete_powder': 0xE8C830,
  'lime_concrete_powder': 0x7DC020,
  'pink_concrete_powder': 0xE8A0B0,
  'gray_concrete_powder': 0x4A4A4A,
  'light_gray_concrete_powder': 0x9A9A9A,
  'cyan_concrete_powder': 0x20A0A8,
  'purple_concrete_powder': 0x8030C0,
  'blue_concrete_powder': 0x4040B0,
  'brown_concrete_powder': 0x7A5030,
  'green_concrete_powder': 0x608020,
  'red_concrete_powder': 0xA03030,
  'black_concrete_powder': 0x1A1A1A,
  
  // Ice and snow
  'ice': 0x91B9FF,
  'packed_ice': 0x7AA4FF,
  'blue_ice': 0x5A84FF,
  'snow_block': 0xF0F0F0,
  'snow': 0xFAFAFA,
  'powder_snow': 0xF8F8F8,
  
  // Nether blocks
  'nether_bricks': 0x3A2A2A,
  'red_nether_bricks': 0x4A1A1A,
  'nether_wart_block': 0x7A1A1A,
  'warped_wart_block': 0x1A7A7A,
  'crimson_nylium': 0x7A2A2A,
  'warped_nylium': 0x2A7A7A,
  'crimson_stem': 0x6A2A4A,
  'warped_stem': 0x2A6A6A,
  'crimson_planks': 0x6A3040,
  'warped_planks': 0x2A7060,
  'shroomlight': 0xF0C040,
  'glowstone': 0xFFDD75,
  'nether_gold_ore': 0xDA9040,
  'nether_quartz_ore': 0xB0A090,
  'quartz_block': 0xECE8E0,
  'smooth_quartz': 0xECE8E0,
  'quartz_bricks': 0xE0DCD4,
  'quartz_pillar': 0xE8E4DC,
  'chiseled_quartz_block': 0xE4E0D8,
  
  // Amethyst
  'amethyst_block': 0x8A5AAA,
  'budding_amethyst': 0x9A6ABA,
  
  // Sculk
  'sculk': 0x0A2A3A,
  'sculk_catalyst': 0x0A3A4A,
  'sculk_sensor': 0x0A4A5A,
  'sculk_shrieker': 0x0A3A4A,
  'sculk_vein': 0x0A2030,
  
  // Misc
  'dripstone_block': 0x8A7A6A,
  'pointed_dripstone': 0x8A7A6A,
  'moss_block': 0x4A7A3A,
  'moss_carpet': 0x4A7A3A,
  'bone_block': 0xE5DCC5,
  'hay_block': 0xB8A050,
  'honeycomb_block': 0xE8A030,
  'slime_block': 0x80CC60,
  'honey_block': 0xFFAA20,
  'sponge': 0xC4C040,
  'wet_sponge': 0xA4A030,
  'melon': 0xA0C830,
  'pumpkin': 0xCC8020,
  'carved_pumpkin': 0xCC8020,
  'jack_o_lantern': 0xCC8020,
  'prismarine': 0x5A9A8A,
  'prismarine_bricks': 0x4A8A7A,
  'dark_prismarine': 0x3A6A5A,
  'sea_lantern': 0xA0D8D0,
  
  // Wool colors
  'white_wool': 0xE8E8E8,
  'orange_wool': 0xE87020,
  'magenta_wool': 0xB838B8,
  'light_blue_wool': 0x58A8D8,
  'yellow_wool': 0xE8C820,
  'lime_wool': 0x60B820,
  'pink_wool': 0xE888A8,
  'gray_wool': 0x484848,
  'light_gray_wool': 0x989898,
  'cyan_wool': 0x189090,
  'purple_wool': 0x7828B8,
  'blue_wool': 0x3838B8,
  'brown_wool': 0x784818,
  'green_wool': 0x407820,
  'red_wool': 0xA82020,
  'black_wool': 0x181818,
};

// Pattern-based color fallbacks
const COLOR_PATTERNS = [
  { pattern: 'ore', color: 0x8A7A6A },
  { pattern: 'log', color: 0x8B7355 },
  { pattern: 'wood', color: 0x8B7355 },
  { pattern: 'leaves', color: 0x3A8B25 },
  { pattern: 'leaf', color: 0x3A8B25 },
  { pattern: 'stone', color: 0x808080 },
  { pattern: 'dirt', color: 0x8B6C4C },
  { pattern: 'mud', color: 0x8B6C4C },
  { pattern: 'sand', color: 0xE3D59E },
  { pattern: 'grass', color: 0x5D8C32 },
  { pattern: 'water', color: 0x3F76E4 },
  { pattern: 'lava', color: 0xFF6600 },
  { pattern: 'ice', color: 0x91B9FF },
  { pattern: 'snow', color: 0xF0F0F0 },
  { pattern: 'nether', color: 0x7A2A2A },
  { pattern: 'crimson', color: 0x7A2A2A },
  { pattern: 'warped', color: 0x2A7A7A },
  { pattern: 'copper', color: 0xC06040 },
  { pattern: 'iron', color: 0xD8D8D8 },
  { pattern: 'gold', color: 0xFCEE4B },
  { pattern: 'diamond', color: 0x4AEDD9 },
  { pattern: 'emerald', color: 0x17DD62 },
  { pattern: 'redstone', color: 0xFF0000 },
  { pattern: 'lapis', color: 0x1E4B9B },
  { pattern: 'coal', color: 0x2A2A2A },
  { pattern: 'wool', color: 0xE8E8E8 },
  { pattern: 'concrete', color: 0x808080 },
  { pattern: 'terracotta', color: 0x9A5A4A },
  { pattern: 'glass', color: 0xC0E0F0 },
  { pattern: 'brick', color: 0x9A5A4A },
  { pattern: 'planks', color: 0xBA9862 },
  { pattern: 'deepslate', color: 0x4A4A4A },
  { pattern: 'amethyst', color: 0x8A5AAA },
  { pattern: 'prismarine', color: 0x5A9A8A },
  { pattern: 'quartz', color: 0xECE8E0 },
  { pattern: 'slab', color: 0x808080 },
  { pattern: 'stairs', color: 0x808080 },
];

// Air block names (for fast lookup)
const AIR_BLOCKS = new Set([
  'air', 'cave_air', 'void_air',
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air',
]);

// Fluid block names
const FLUID_BLOCKS = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava',
  'minecraft:water', 'minecraft:flowing_water',
  'minecraft:lava', 'minecraft:flowing_lava',
]);

// Transparent blocks (not fully opaque)
const TRANSPARENT_BLOCKS = new Set([
  'glass', 'ice', 'leaves', 'tinted_glass',
]);

/**
 * BlockRegistry class - manages block type IDs and properties
 */
export class BlockRegistry {
  constructor() {
    // Name -> ID mapping (string -> number)
    this.nameToId = new Map();
    
    // ID -> BlockInfo mapping (number -> object)
    this.idToInfo = [];
    
    // Next available ID
    this.nextId = 0;
    
    // Pre-register air as ID 0
    this._registerBlock('minecraft:air', BlockCategory.AIR, 0x000000, false);
  }
  
  /**
   * Register a block type and return its ID
   * @param {string} name - Full block name (e.g., 'minecraft:stone')
   * @returns {number} - Block type ID
   */
  registerBlock(name) {
    // Check if already registered
    const existingId = this.nameToId.get(name);
    if (existingId !== undefined) {
      return existingId;
    }
    
    // Determine category and properties
    const shortName = name.replace('minecraft:', '');
    const category = this._getCategory(shortName);
    const color = this._getColor(shortName);
    const isOpaque = this._isOpaque(shortName, category);
    
    return this._registerBlock(name, category, color, isOpaque);
  }
  
  /**
   * Internal block registration
   */
  _registerBlock(name, category, color, isOpaque) {
    const id = this.nextId++;
    
    const info = {
      id,
      name,
      category,
      color,
      isOpaque,
      colorR: ((color >> 16) & 0xFF) / 255,
      colorG: ((color >> 8) & 0xFF) / 255,
      colorB: (color & 0xFF) / 255,
    };
    
    this.nameToId.set(name, id);
    this.idToInfo[id] = info;
    
    // Also register without minecraft: prefix
    const shortName = name.replace('minecraft:', '');
    if (shortName !== name) {
      this.nameToId.set(shortName, id);
    }
    
    return id;
  }
  
  /**
   * Get block ID by name (registers if new)
   * @param {string} name - Block name
   * @returns {number} - Block type ID
   */
  getBlockId(name) {
    if (!name) return 0; // Air
    
    const existing = this.nameToId.get(name);
    if (existing !== undefined) {
      return existing;
    }
    
    return this.registerBlock(name);
  }
  
  /**
   * Get block info by ID
   * @param {number} id - Block type ID
   * @returns {Object|null} - Block info or null
   */
  getBlockInfo(id) {
    return this.idToInfo[id] || null;
  }
  
  /**
   * Get block info by name
   * @param {string} name - Block name
   * @returns {Object|null} - Block info or null
   */
  getBlockInfoByName(name) {
    const id = this.nameToId.get(name);
    return id !== undefined ? this.idToInfo[id] : null;
  }
  
  /**
   * Check if block ID represents air
   * @param {number} id - Block type ID
   * @returns {boolean}
   */
  isAir(id) {
    const info = this.idToInfo[id];
    return !info || info.category === BlockCategory.AIR;
  }
  
  /**
   * Check if block ID is opaque (for face culling)
   * @param {number} id - Block type ID
   * @returns {boolean}
   */
  isOpaque(id) {
    const info = this.idToInfo[id];
    return info ? info.isOpaque : false;
  }
  
  /**
   * Check if block ID is a fluid
   * @param {number} id - Block type ID
   * @returns {boolean}
   */
  isFluid(id) {
    const info = this.idToInfo[id];
    return info ? info.category === BlockCategory.FLUID : false;
  }
  
  /**
   * Check if block ID is water
   * @param {number} id - Block type ID
   * @returns {boolean}
   */
  isWater(id) {
    const info = this.idToInfo[id];
    return info ? info.name.includes('water') : false;
  }
  
  /**
   * Check if block ID is lava
   * @param {number} id - Block type ID
   * @returns {boolean}
   */
  isLava(id) {
    const info = this.idToInfo[id];
    return info ? info.name.includes('lava') : false;
  }
  
  /**
   * Get RGB color components for a block ID
   * @param {number} id - Block type ID
   * @returns {{r: number, g: number, b: number}} - RGB values 0-1
   */
  getColor(id) {
    const info = this.idToInfo[id];
    if (!info) return { r: 0.44, g: 0.44, b: 0.44 }; // Default gray
    return { r: info.colorR, g: info.colorG, b: info.colorB };
  }
  
  /**
   * Determine block category from name
   */
  _getCategory(name) {
    if (AIR_BLOCKS.has(name) || AIR_BLOCKS.has(`minecraft:${name}`)) {
      return BlockCategory.AIR;
    }
    
    if (FLUID_BLOCKS.has(name) || FLUID_BLOCKS.has(`minecraft:${name}`)) {
      return BlockCategory.FLUID;
    }
    
    // Check for transparent blocks
    for (const pattern of TRANSPARENT_BLOCKS) {
      if (name.includes(pattern)) {
        return BlockCategory.TRANSPARENT;
      }
    }
    
    return BlockCategory.SOLID;
  }
  
  /**
   * Get block color from name
   */
  _getColor(name) {
    // Exact match
    if (BLOCK_COLORS[name]) {
      return BLOCK_COLORS[name];
    }
    
    // Pattern matching
    for (const { pattern, color } of COLOR_PATTERNS) {
      if (name.includes(pattern)) {
        return color;
      }
    }
    
    // Default gray
    return 0x707070;
  }
  
  /**
   * Determine if block is opaque
   */
  _isOpaque(name, category) {
    if (category === BlockCategory.AIR) return false;
    if (category === BlockCategory.FLUID) return false;
    if (category === BlockCategory.TRANSPARENT) return false;
    
    // Check for known transparent patterns
    if (name.includes('glass')) return false;
    if (name.includes('leaves')) return false;
    if (name.includes('ice') && !name.includes('packed')) return false;
    
    return true;
  }
  
  /**
   * Get total number of registered blocks
   */
  get blockCount() {
    return this.nextId;
  }
  
  /**
   * Export registry for worker transfer
   * Returns serializable data that can be sent to workers
   */
  export() {
    return {
      idToInfo: this.idToInfo.map(info => ({
        id: info.id,
        name: info.name,
        category: info.category,
        color: info.color,
        isOpaque: info.isOpaque,
        colorR: info.colorR,
        colorG: info.colorG,
        colorB: info.colorB,
      })),
    };
  }
  
  /**
   * Import registry from exported data (for use in workers)
   */
  static import(data) {
    const registry = new BlockRegistry();
    registry.idToInfo = [];
    registry.nameToId = new Map();
    registry.nextId = 0;
    
    for (const info of data.idToInfo) {
      registry.idToInfo[info.id] = info;
      registry.nameToId.set(info.name, info.id);
      
      // Also register without minecraft: prefix
      const shortName = info.name.replace('minecraft:', '');
      if (shortName !== info.name) {
        registry.nameToId.set(shortName, info.id);
      }
      
      if (info.id >= registry.nextId) {
        registry.nextId = info.id + 1;
      }
    }
    
    return registry;
  }
}

// Singleton instance for global use
let globalRegistry = null;

/**
 * Get the global block registry instance
 * @returns {BlockRegistry}
 */
export function getBlockRegistry() {
  if (!globalRegistry) {
    globalRegistry = new BlockRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (for testing)
 */
export function resetBlockRegistry() {
  globalRegistry = null;
}

export default BlockRegistry;

