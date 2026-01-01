/**
 * BlockRegistry - Central registry for block type definitions
 * 
 * Maps block names to numeric IDs and provides rendering properties.
 * All block lookups in the meshing pipeline use numeric IDs for performance.
 * 
 * ARCHITECTURE NOTES FOR FUTURE TEXTURE ATLAS SUPPORT:
 * =====================================================
 * 
 * Current implementation uses flat colors (RGB values) for each block.
 * To migrate to a texture atlas:
 * 
 * 1. COLOR → UV MAPPING:
 *    - Each block ID currently maps to an RGB color
 *    - Replace colorR/G/B with uvX/uvY/uvWidth/uvHeight
 *    - The mesher already generates color attributes per vertex
 *    - Change to UV attributes: geometry.setAttribute('uv', ...)
 * 
 * 2. TEXTURE ATLAS STRUCTURE:
 *    - Create a single 2048x2048 or 4096x4096 texture atlas
 *    - Each block type gets a 16x16 or 32x32 region
 *    - Store UV coordinates in the registry instead of colors
 * 
 * 3. MATERIAL CHANGES:
 *    - Current: vertexColors: true, uses vertex color attributes
 *    - Future: Add sampler2D for texture atlas
 *    - Shader: Sample texture at UV instead of using vertex color
 * 
 * 4. BLOCK PROPERTY EXTENSIONS:
 *    - Add 'topUV', 'sideUV', 'bottomUV' for different faces
 *    - Add rotation/flip flags for variation
 *    - Add animation frame count for animated textures (water, lava)
 * 
 * 5. MEMORY CONSIDERATIONS:
 *    - UV coordinates use less memory than colors (2 floats vs 3)
 *    - Texture atlas uses fixed GPU memory regardless of block count
 *    - Consider texture compression (DXT/S3TC) for large atlases
 * 
 * TRANSPARENCY SYSTEM:
 * ====================
 * Water and Lava currently render at 50-60% opacity via the material:
 * - WaterMaterial.js: uOpacity: 0.6
 * - LavaMaterial.js: uOpacity: 0.5
 * 
 * To add transparency to other blocks:
 * 1. Add 'opacity' field to BlockInfo (0.0-1.0)
 * 2. Modify mesher to separate transparent blocks (like glass)
 * 3. Create TransparentMaterial.js similar to WaterMaterial
 * 4. Sort transparent meshes back-to-front for correct blending
 */

// Block categories determine meshing strategy
export const BlockCategory = {
  SOLID: 'solid',           // Opaque cubes - greedy meshing
  TRANSPARENT: 'transparent', // Transparent cubes - separate pass
  FLUID: 'fluid',           // Water/lava - height-aware meshing
  CUSTOM: 'custom',         // Non-cube shapes - instanced rendering (future)
  AIR: 'air',               // Skip during meshing
};

// Import comprehensive block colors from data module
import { getBlockColorsNumeric, COLOR_PATTERNS_NUMERIC } from '../data/blockColors.js';

// Non-cube block patterns (blocks that need model-based rendering, not greedy meshing)
// Glass panes and iron bars are included - they use multipart model rendering
const NON_CUBE_PATTERNS = [
  // Slabs, stairs, fences, walls, doors, trapdoors
  '_slab', '_stairs', '_fence', '_wall', '_door', '_trapdoor', '_pane', 'iron_bars',
  
  // Flowers
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'rose_bush',
  'peony', 'torchflower', 'pitcher', 'pink_petals', 'spore_blossom', 'cactus_flower',
  'eyeblossom', 'wildflowers',
  
  // Grass and plants
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush',
  'seagrass', 'tall_seagrass', 'kelp', 'sugar_cane', 'cactus', 'lily_pad',
  'nether_sprouts', 'hanging_roots', 'short_dry_grass', 'tall_dry_grass', 'leaf_litter',
  'pale_hanging_moss', 'firefly_bush',
  'crimson_roots', 'warped_roots', 'crimson_fungus', 'warped_fungus', // Nether cross-model plants
  'twisting_vines', 'weeping_vines', 'cave_vines', // Vine plants (use cross model)
  
  // Saplings
  '_sapling', 'mangrove_propagule',
  
  // Note: Small mushrooms need a special check because their names overlap with mushroom_block
  // We handle this in _isNonCube() with specific exact matching
  
  // Crops
  'wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush', 'nether_wart',
  'melon_stem', 'pumpkin_stem', 'cocoa',
  
  // Rails (covers rail, powered_rail, detector_rail, activator_rail)
  'rail',
  
  // Torches and lighting
  'torch', 'soul_torch', 'redstone_torch', 'lantern', 'soul_lantern',
  
  // Note: 'iron_chain' and variants - renamed from 'chain' in Minecraft 1.21
  
  // Carpets and thin layers (note: 'snow' is exact match to avoid snow_block)
  '_carpet', 'moss_carpet',
  
  // Buttons and pressure plates
  '_button', '_pressure_plate',
  
  // Signs
  '_sign',
  
  // Misc redstone and utility
  'lever', 'ladder', 'tripwire', 'tripwire_hook', 'redstone_wire',
  
  // Vines and climbing plants
  'vine', 'weeping_vines', 'twisting_vines', 'cave_vines', 'glow_lichen',
  
  // Coral fans (small corals like tube_coral are exact matched)
  'coral_fan', 'coral_wall_fan',
  
  // Candles
  'candle',
  
  // Sculk
  'sculk_vein', 'sculk_sensor', 'sculk_shrieker', 'calibrated_sculk_sensor',
  
  // Dripleaf
  'dripleaf',
  
  // Flower pots
  'flower_pot', 'potted_',
  
  // Campfires
  'campfire', 'soul_campfire',
  
  // Utility blocks with custom models
  'anvil', 'bell', 'grindstone', 'brewing_stand', 'cauldron', 'end_rod', 'lightning_rod',
  'stonecutter', 'heavy_core', 'dried_ghast',
  
  // Portals (thin panels, not full cubes)
  // Note: end_portal and end_gateway use block entity renderers, not block models
  'nether_portal',
  
  // Path blocks (15 blocks tall, not 16)
  'farmland', 'dirt_path',
  
  // Fire (cross pattern)
  'fire', 'soul_fire',
  
  // Special blocks with inner elements (not simple cubes)
  'slime_block', 'honey_block', 'powder_snow', 'mangrove_roots',
  
  // Dripstone and amethyst
  'pointed_dripstone', 'amethyst_cluster', 'amethyst_bud',
  
  // Note: 'bamboo' is handled as exact match to avoid bamboo_block, bamboo_planks, etc.
  
  // Eggs
  'turtle_egg', 'sniffer_egg', 'frogspawn', 'dragon_egg',
  
  // Chorus
  'chorus_plant', 'chorus_flower',
  
  // Sea pickle
  'sea_pickle',
  
  // Cake
  'cake',
  
  // Decorated pot
  'decorated_pot',
  
  // Heads and skulls
  '_head', '_skull',
  
  // Cobweb
  'cobweb',
  
  // Note: azalea and flowering_azalea are handled as exact matches to avoid matching azalea_leaves
  
  // Conduit
  'conduit',
  
  // Resin clump
  'resin_clump',
  
  // Beds
  '_bed',
  
  // Enchanting table and lectern
  'enchanting_table', 'lectern',
  
  // Chests
  'chest', 'ender_chest', 'trapped_chest',
  
  // Piston head
  'piston_head',
  
  // End portal frame
  'end_portal_frame',
  
  // Banner
  '_banner',
  
  // Redstone components with custom models
  'comparator', 'repeater', 'daylight_detector',
  
  // Hopper and composter
  'hopper', 'composter',
  
  // Scaffolding
  'scaffolding',
  
  // Shulker boxes (not full cubes when open)
  'shulker_box',
];

// Pre-defined block colors (hex values) - loaded from comprehensive color map
const BLOCK_COLORS = getBlockColorsNumeric();

// Pattern-based color fallbacks
const COLOR_PATTERNS = COLOR_PATTERNS_NUMERIC;

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
   * Check if block ID is a non-cube (needs model-based rendering)
   * @param {number} id - Block type ID
   * @returns {boolean}
   */
  isNonCube(id) {
    const info = this.idToInfo[id];
    return info ? info.category === BlockCategory.CUSTOM : false;
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
    
    // Check for non-cube blocks (model-based rendering)
    if (this._isNonCube(name)) {
      return BlockCategory.CUSTOM;
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
   * Check if block is a non-cube (needs model-based rendering)
   */
  _isNonCube(name) {
    // Exact match blocks that would otherwise overlap with full cube variants
    // e.g., 'brown_mushroom' vs 'brown_mushroom_block'
    const EXACT_MATCH_NON_CUBES = new Set([
      'brown_mushroom', 'red_mushroom',  // Small mushrooms (not _block variants)
      'azalea', 'flowering_azalea',       // Azalea bushes (not azalea_leaves)
      'bamboo',                            // Bamboo plant (not bamboo_block, bamboo_planks, etc.)
      'snow',                              // Snow layers (not snow_block)
      'iron_chain',                        // Iron chain (renamed from 'chain' in 1.21)
      'copper_chain',                      // Copper chain variants
      'exposed_copper_chain',
      'weathered_copper_chain',
      'oxidized_copper_chain',
      'waxed_copper_chain',
      'waxed_exposed_copper_chain',
      'waxed_weathered_copper_chain',
      'waxed_oxidized_copper_chain',
      'beacon',                            // Multi-element block (glass shell, obsidian base, beacon core)
      // Small corals (not coral_block variants)
      'tube_coral', 'brain_coral', 'bubble_coral', 'fire_coral', 'horn_coral',
      'dead_tube_coral', 'dead_brain_coral', 'dead_bubble_coral', 'dead_fire_coral', 'dead_horn_coral',
    ]);
    
    if (EXACT_MATCH_NON_CUBES.has(name)) {
      return true;
    }
    
    // Pattern-based matching for all other non-cube blocks
    for (const pattern of NON_CUBE_PATTERNS) {
      if (name.includes(pattern)) {
        return true;
      }
    }
    return false;
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

