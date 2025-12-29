/**
 * BlockTextureRegistry - Maps block names to their texture paths
 * 
 * Handles:
 * - Simple blocks (same texture all faces)
 * - Multi-face blocks (different top/side/bottom textures)
 * - Block states that affect textures
 */

/**
 * Get the texture path for a block face
 * @param {string} blockName - Block name (e.g., "minecraft:stone" or "stone")
 * @param {string} face - Face name: "up", "down", "north", "south", "east", "west"
 * @returns {string} Texture path (e.g., "block/stone")
 */
export function getBlockTexture(blockName, face = 'up') {
  // Normalize block name
  const name = blockName.replace('minecraft:', '');
  
  // Check for special multi-face blocks
  const multiface = MULTIFACE_BLOCKS[name];
  if (multiface) {
    if (face === 'up' && multiface.top) return multiface.top;
    if (face === 'down' && multiface.bottom) return multiface.bottom;
    return multiface.side || multiface.all || `block/${name}`;
  }
  
  // Check for special mappings
  if (TEXTURE_MAPPINGS[name]) {
    return TEXTURE_MAPPINGS[name];
  }
  
  // Handle slabs, stairs, walls, and fences - derive texture from base material
  const baseTexture = getDerivedBlockTexture(name);
  if (baseTexture) {
    return baseTexture;
  }
  
  // Default: same name as block
  return `block/${name}`;
}

/**
 * Get texture for partial blocks (slabs, stairs, walls, fences) by deriving from base material
 * @param {string} name - Block name without minecraft: prefix
 * @returns {string|null} Texture path or null if not a partial block
 */
function getDerivedBlockTexture(name) {
  // Common suffixes for partial blocks
  const suffixes = ['_slab', '_stairs', '_wall', '_fence', '_fence_gate', '_button', '_pressure_plate'];
  
  for (const suffix of suffixes) {
    if (name.endsWith(suffix)) {
      const baseName = name.slice(0, -suffix.length);
      
      // Try to find the base texture
      // First check if there's a direct mapping
      if (TEXTURE_MAPPINGS[baseName]) {
        return TEXTURE_MAPPINGS[baseName];
      }
      
      // Check for planks-based blocks
      if (WOOD_TYPES.has(baseName)) {
        return `block/${baseName}_planks`;
      }
      
      // Check for stone variants
      if (STONE_TYPES.has(baseName)) {
        return `block/${baseName}`;
      }
      
      // Check special cases
      if (PARTIAL_BLOCK_TEXTURES[baseName]) {
        return PARTIAL_BLOCK_TEXTURES[baseName];
      }
      
      // Default: assume base name is the texture
      return `block/${baseName}`;
    }
  }
  
  return null;
}

// Wood types for planks-based blocks
const WOOD_TYPES = new Set([
  'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
  'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak',
]);

// Stone types that use their own texture directly
const STONE_TYPES = new Set([
  'stone', 'cobblestone', 'mossy_cobblestone', 'stone_brick', 'mossy_stone_brick',
  'granite', 'polished_granite', 'diorite', 'polished_diorite', 'andesite', 'polished_andesite',
  'deepslate', 'cobbled_deepslate', 'polished_deepslate', 'deepslate_brick', 'deepslate_tile',
  'brick', 'nether_brick', 'red_nether_brick', 'prismarine', 'prismarine_brick', 'dark_prismarine',
  'sandstone', 'smooth_sandstone', 'cut_sandstone', 'red_sandstone', 'smooth_red_sandstone', 'cut_red_sandstone',
  'quartz', 'smooth_quartz', 'purpur', 'end_stone_brick', 'blackstone', 'polished_blackstone', 'polished_blackstone_brick',
  'tuff', 'polished_tuff', 'tuff_brick', 'mud_brick',
]);

// Special texture mappings for partial blocks
const PARTIAL_BLOCK_TEXTURES = {
  'stone_brick': 'block/stone_bricks',
  'mossy_stone_brick': 'block/mossy_stone_bricks',
  'nether_brick': 'block/nether_bricks',
  'red_nether_brick': 'block/red_nether_bricks',
  'prismarine_brick': 'block/prismarine_bricks',
  'deepslate_brick': 'block/deepslate_bricks',
  'deepslate_tile': 'block/deepslate_tiles',
  'polished_blackstone_brick': 'block/polished_blackstone_bricks',
  'end_stone_brick': 'block/end_stone_bricks',
  'mud_brick': 'block/mud_bricks',
  'tuff_brick': 'block/tuff_bricks',
  'quartz': 'block/quartz_block_side',
  'smooth_quartz': 'block/quartz_block_bottom',
  'purpur': 'block/purpur_block',
  'cut_sandstone': 'block/cut_sandstone',
  'cut_red_sandstone': 'block/cut_red_sandstone',
  'brick': 'block/bricks',
  'copper': 'block/copper_block',
  'exposed_copper': 'block/exposed_copper',
  'weathered_copper': 'block/weathered_copper',
  'oxidized_copper': 'block/oxidized_copper',
  'cut_copper': 'block/cut_copper',
  'exposed_cut_copper': 'block/exposed_cut_copper',
  'weathered_cut_copper': 'block/weathered_cut_copper',
  'oxidized_cut_copper': 'block/oxidized_cut_copper',
  'waxed_copper': 'block/copper_block',
  'waxed_exposed_copper': 'block/exposed_copper',
  'waxed_weathered_copper': 'block/weathered_copper',
  'waxed_oxidized_copper': 'block/oxidized_copper',
  'waxed_cut_copper': 'block/cut_copper',
  'waxed_exposed_cut_copper': 'block/exposed_cut_copper',
  'waxed_weathered_cut_copper': 'block/weathered_cut_copper',
  'waxed_oxidized_cut_copper': 'block/oxidized_cut_copper',
};

/**
 * Get the texture path for a block face considering block state properties
 * Handles rotation for logs, pillars, and other axis-rotatable blocks
 * 
 * @param {string} blockName - Block name (e.g., "minecraft:oak_log" or "oak_log")
 * @param {string} face - Face name: "up", "down", "north", "south", "east", "west"
 * @param {Object} properties - Block state properties (e.g., { axis: 'x' })
 * @returns {{ texturePath: string, rotation: number }} Texture path and UV rotation (0-3)
 */
export function getBlockTextureWithState(blockName, face = 'up', properties = {}) {
  const name = blockName.replace('minecraft:', '');
  const axis = properties?.axis || 'y'; // Default axis is Y (vertical)
  
  // Check if this is a rotatable block (logs, pillars, etc.)
  if (isRotatableBlock(name) && axis !== 'y') {
    return getRotatedTexture(name, face, axis);
  }
  
  // For non-rotatable blocks or axis=y, use standard lookup
  return {
    texturePath: getBlockTexture(name, face),
    rotation: 0
  };
}

/**
 * Get texture and rotation for a rotated block
 * Maps faces based on block axis rotation
 */
function getRotatedTexture(blockName, face, axis) {
  const multiface = MULTIFACE_BLOCKS[blockName];
  const topTexture = multiface?.top || `block/${blockName}_top`;
  const sideTexture = multiface?.side || `block/${blockName}`;
  
  // For axis=x: ends are on east/west faces
  // For axis=z: ends are on north/south faces
  // Rotation value rotates the texture on the side faces
  
  if (axis === 'x') {
    // Block is horizontal along X axis (east-west)
    if (face === 'east' || face === 'west') {
      // End faces (like top/bottom of upright log)
      return { texturePath: topTexture, rotation: 0 };
    } else if (face === 'up' || face === 'down') {
      // Top/bottom become sides, rotated 90°
      return { texturePath: sideTexture, rotation: 1 };
    } else {
      // North/south sides
      return { texturePath: sideTexture, rotation: 1 };
    }
  } else if (axis === 'z') {
    // Block is horizontal along Z axis (north-south)
    if (face === 'north' || face === 'south') {
      // End faces
      return { texturePath: topTexture, rotation: 0 };
    } else if (face === 'up' || face === 'down') {
      // Top/bottom become sides, no rotation needed
      return { texturePath: sideTexture, rotation: 0 };
    } else {
      // East/west sides
      return { texturePath: sideTexture, rotation: 1 };
    }
  }
  
  // Fallback (shouldn't reach here for non-y axis)
  return { texturePath: getBlockTexture(blockName, face), rotation: 0 };
}

/**
 * Check if a block supports axis rotation
 */
export function isRotatableBlock(blockName) {
  const name = blockName.replace('minecraft:', '');
  return ROTATABLE_BLOCKS.has(name);
}

/**
 * Set of blocks that support axis rotation (logs, pillars, etc.)
 */
const ROTATABLE_BLOCKS = new Set([
  // Logs
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'pale_oak_log',
  'stripped_oak_log', 'stripped_spruce_log', 'stripped_birch_log', 'stripped_jungle_log',
  'stripped_acacia_log', 'stripped_dark_oak_log', 'stripped_mangrove_log', 'stripped_cherry_log',
  'stripped_pale_oak_log',
  
  // Wood (bark on all sides)
  'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood', 'acacia_wood', 'dark_oak_wood',
  'mangrove_wood', 'cherry_wood', 'pale_oak_wood',
  'stripped_oak_wood', 'stripped_spruce_wood', 'stripped_birch_wood', 'stripped_jungle_wood',
  'stripped_acacia_wood', 'stripped_dark_oak_wood', 'stripped_mangrove_wood', 'stripped_cherry_wood',
  'stripped_pale_oak_wood',
  
  // Nether stems
  'crimson_stem', 'warped_stem', 'stripped_crimson_stem', 'stripped_warped_stem',
  'crimson_hyphae', 'warped_hyphae', 'stripped_crimson_hyphae', 'stripped_warped_hyphae',
  
  // Bamboo
  'bamboo_block', 'stripped_bamboo_block',
  
  // Pillars
  'quartz_pillar', 'purpur_pillar',
  
  // Other rotatable blocks
  'bone_block', 'hay_block', 'basalt', 'polished_basalt',
  'deepslate', 'infested_deepslate',
  'muddy_mangrove_roots',
]);

/**
 * Blocks with different textures per face
 */
const MULTIFACE_BLOCKS = {
  // Grass and related
  'grass_block': { top: 'block/grass_block_top', side: 'block/grass_block_side', bottom: 'block/dirt' },
  'podzol': { top: 'block/podzol_top', side: 'block/podzol_side', bottom: 'block/dirt' },
  'mycelium': { top: 'block/mycelium_top', side: 'block/mycelium_side', bottom: 'block/dirt' },
  'dirt_path': { top: 'block/dirt_path_top', side: 'block/dirt_path_side', bottom: 'block/dirt' },
  
  // Logs
  'oak_log': { top: 'block/oak_log_top', side: 'block/oak_log' },
  'spruce_log': { top: 'block/spruce_log_top', side: 'block/spruce_log' },
  'birch_log': { top: 'block/birch_log_top', side: 'block/birch_log' },
  'jungle_log': { top: 'block/jungle_log_top', side: 'block/jungle_log' },
  'acacia_log': { top: 'block/acacia_log_top', side: 'block/acacia_log' },
  'dark_oak_log': { top: 'block/dark_oak_log_top', side: 'block/dark_oak_log' },
  'mangrove_log': { top: 'block/mangrove_log_top', side: 'block/mangrove_log' },
  'cherry_log': { top: 'block/cherry_log_top', side: 'block/cherry_log' },
  'pale_oak_log': { top: 'block/pale_oak_log_top', side: 'block/pale_oak_log' },
  
  // Stripped logs
  'stripped_oak_log': { top: 'block/stripped_oak_log_top', side: 'block/stripped_oak_log' },
  'stripped_spruce_log': { top: 'block/stripped_spruce_log_top', side: 'block/stripped_spruce_log' },
  'stripped_birch_log': { top: 'block/stripped_birch_log_top', side: 'block/stripped_birch_log' },
  'stripped_jungle_log': { top: 'block/stripped_jungle_log_top', side: 'block/stripped_jungle_log' },
  'stripped_acacia_log': { top: 'block/stripped_acacia_log_top', side: 'block/stripped_acacia_log' },
  'stripped_dark_oak_log': { top: 'block/stripped_dark_oak_log_top', side: 'block/stripped_dark_oak_log' },
  'stripped_mangrove_log': { top: 'block/stripped_mangrove_log_top', side: 'block/stripped_mangrove_log' },
  'stripped_cherry_log': { top: 'block/stripped_cherry_log_top', side: 'block/stripped_cherry_log' },
  'stripped_pale_oak_log': { top: 'block/stripped_pale_oak_log_top', side: 'block/stripped_pale_oak_log' },
  
  // Nether stems
  'crimson_stem': { top: 'block/crimson_stem_top', side: 'block/crimson_stem' },
  'warped_stem': { top: 'block/warped_stem_top', side: 'block/warped_stem' },
  'stripped_crimson_stem': { top: 'block/stripped_crimson_stem_top', side: 'block/stripped_crimson_stem' },
  'stripped_warped_stem': { top: 'block/stripped_warped_stem_top', side: 'block/stripped_warped_stem' },
  
  // Bamboo block
  'bamboo_block': { top: 'block/bamboo_block_top', side: 'block/bamboo_block' },
  'stripped_bamboo_block': { top: 'block/stripped_bamboo_block_top', side: 'block/stripped_bamboo_block' },
  
  // Sandstone
  'sandstone': { top: 'block/sandstone_top', side: 'block/sandstone', bottom: 'block/sandstone_bottom' },
  'red_sandstone': { top: 'block/red_sandstone_top', side: 'block/red_sandstone', bottom: 'block/red_sandstone_bottom' },
  'smooth_sandstone': { all: 'block/sandstone_top' },
  'smooth_red_sandstone': { all: 'block/red_sandstone_top' },
  
  // Stone variants
  'deepslate': { top: 'block/deepslate_top', side: 'block/deepslate' },
  'basalt': { top: 'block/basalt_top', side: 'block/basalt_side' },
  'polished_basalt': { top: 'block/polished_basalt_top', side: 'block/polished_basalt_side' },
  
  // Quartz
  'quartz_block': { top: 'block/quartz_block_top', side: 'block/quartz_block_side', bottom: 'block/quartz_block_bottom' },
  'quartz_pillar': { top: 'block/quartz_pillar_top', side: 'block/quartz_pillar' },
  'smooth_quartz': { all: 'block/quartz_block_bottom' },
  
  // Bone block
  'bone_block': { top: 'block/bone_block_top', side: 'block/bone_block_side' },
  
  // Furnaces and utility blocks
  'furnace': { top: 'block/furnace_top', side: 'block/furnace_side', front: 'block/furnace_front' },
  'blast_furnace': { top: 'block/blast_furnace_top', side: 'block/blast_furnace_side', front: 'block/blast_furnace_front' },
  'smoker': { top: 'block/smoker_top', side: 'block/smoker_side', front: 'block/smoker_front' },
  
  // Crafting table
  'crafting_table': { top: 'block/crafting_table_top', side: 'block/crafting_table_side', front: 'block/crafting_table_front' },
  
  // TNT
  'tnt': { top: 'block/tnt_top', side: 'block/tnt_side', bottom: 'block/tnt_bottom' },
  
  // Pumpkin and melon
  'pumpkin': { top: 'block/pumpkin_top', side: 'block/pumpkin_side' },
  'carved_pumpkin': { top: 'block/pumpkin_top', side: 'block/carved_pumpkin', back: 'block/pumpkin_side' },
  'jack_o_lantern': { top: 'block/pumpkin_top', side: 'block/jack_o_lantern', back: 'block/pumpkin_side' },
  'melon': { top: 'block/melon_top', side: 'block/melon_side' },
  
  // Hay block
  'hay_block': { top: 'block/hay_block_top', side: 'block/hay_block_side' },
  
  // Cactus
  'cactus': { top: 'block/cactus_top', side: 'block/cactus_side', bottom: 'block/cactus_bottom' },
  
  // Dispenser/Dropper
  'dispenser': { top: 'block/furnace_top', side: 'block/furnace_side', front: 'block/dispenser_front' },
  'dropper': { top: 'block/furnace_top', side: 'block/furnace_side', front: 'block/dropper_front' },
  
  // Barrel
  'barrel': { top: 'block/barrel_top', side: 'block/barrel_side', bottom: 'block/barrel_bottom' },
  
  // Beehive/Bee nest
  'beehive': { top: 'block/beehive_end', side: 'block/beehive_side', front: 'block/beehive_front' },
  'bee_nest': { top: 'block/bee_nest_top', side: 'block/bee_nest_side', front: 'block/bee_nest_front' },
};

/**
 * Special texture name mappings
 */
const TEXTURE_MAPPINGS = {
  // Simplified names
  'grass': 'block/short_grass',
  'short_grass': 'block/short_grass',
  'tall_grass': 'block/tall_grass_top',
  'fern': 'block/fern',
  'large_fern': 'block/large_fern_top',
  
  // Stone bricks
  'stone_bricks': 'block/stone_bricks',
  'mossy_stone_bricks': 'block/mossy_stone_bricks',
  'cracked_stone_bricks': 'block/cracked_stone_bricks',
  'chiseled_stone_bricks': 'block/chiseled_stone_bricks',
  
  // Nether bricks
  'nether_bricks': 'block/nether_bricks',
  'red_nether_bricks': 'block/red_nether_bricks',
  'cracked_nether_bricks': 'block/cracked_nether_bricks',
  'chiseled_nether_bricks': 'block/chiseled_nether_bricks',
  
  // Deepslate variants
  'deepslate_bricks': 'block/deepslate_bricks',
  'cracked_deepslate_bricks': 'block/cracked_deepslate_bricks',
  'deepslate_tiles': 'block/deepslate_tiles',
  'cracked_deepslate_tiles': 'block/cracked_deepslate_tiles',
  'chiseled_deepslate': 'block/chiseled_deepslate',
  'cobbled_deepslate': 'block/cobbled_deepslate',
  'polished_deepslate': 'block/polished_deepslate',
  
  // Planks
  'oak_planks': 'block/oak_planks',
  'spruce_planks': 'block/spruce_planks',
  'birch_planks': 'block/birch_planks',
  'jungle_planks': 'block/jungle_planks',
  'acacia_planks': 'block/acacia_planks',
  'dark_oak_planks': 'block/dark_oak_planks',
  'mangrove_planks': 'block/mangrove_planks',
  'cherry_planks': 'block/cherry_planks',
  'bamboo_planks': 'block/bamboo_planks',
  'crimson_planks': 'block/crimson_planks',
  'warped_planks': 'block/warped_planks',
  'pale_oak_planks': 'block/pale_oak_planks',
  
  // Concrete
  'white_concrete': 'block/white_concrete',
  'orange_concrete': 'block/orange_concrete',
  'magenta_concrete': 'block/magenta_concrete',
  'light_blue_concrete': 'block/light_blue_concrete',
  'yellow_concrete': 'block/yellow_concrete',
  'lime_concrete': 'block/lime_concrete',
  'pink_concrete': 'block/pink_concrete',
  'gray_concrete': 'block/gray_concrete',
  'light_gray_concrete': 'block/light_gray_concrete',
  'cyan_concrete': 'block/cyan_concrete',
  'purple_concrete': 'block/purple_concrete',
  'blue_concrete': 'block/blue_concrete',
  'brown_concrete': 'block/brown_concrete',
  'green_concrete': 'block/green_concrete',
  'red_concrete': 'block/red_concrete',
  'black_concrete': 'block/black_concrete',
  
  // Wool
  'white_wool': 'block/white_wool',
  'orange_wool': 'block/orange_wool',
  'magenta_wool': 'block/magenta_wool',
  'light_blue_wool': 'block/light_blue_wool',
  'yellow_wool': 'block/yellow_wool',
  'lime_wool': 'block/lime_wool',
  'pink_wool': 'block/pink_wool',
  'gray_wool': 'block/gray_wool',
  'light_gray_wool': 'block/light_gray_wool',
  'cyan_wool': 'block/cyan_wool',
  'purple_wool': 'block/purple_wool',
  'blue_wool': 'block/blue_wool',
  'brown_wool': 'block/brown_wool',
  'green_wool': 'block/green_wool',
  'red_wool': 'block/red_wool',
  'black_wool': 'block/black_wool',
  
  // Glass
  'glass': 'block/glass',
  'white_stained_glass': 'block/white_stained_glass',
  'orange_stained_glass': 'block/orange_stained_glass',
  'magenta_stained_glass': 'block/magenta_stained_glass',
  'light_blue_stained_glass': 'block/light_blue_stained_glass',
  'yellow_stained_glass': 'block/yellow_stained_glass',
  'lime_stained_glass': 'block/lime_stained_glass',
  'pink_stained_glass': 'block/pink_stained_glass',
  'gray_stained_glass': 'block/gray_stained_glass',
  'light_gray_stained_glass': 'block/light_gray_stained_glass',
  'cyan_stained_glass': 'block/cyan_stained_glass',
  'purple_stained_glass': 'block/purple_stained_glass',
  'blue_stained_glass': 'block/blue_stained_glass',
  'brown_stained_glass': 'block/brown_stained_glass',
  'green_stained_glass': 'block/green_stained_glass',
  'red_stained_glass': 'block/red_stained_glass',
  'black_stained_glass': 'block/black_stained_glass',
  'tinted_glass': 'block/tinted_glass',
  
  // Ore blocks
  'coal_ore': 'block/coal_ore',
  'iron_ore': 'block/iron_ore',
  'copper_ore': 'block/copper_ore',
  'gold_ore': 'block/gold_ore',
  'redstone_ore': 'block/redstone_ore',
  'emerald_ore': 'block/emerald_ore',
  'lapis_ore': 'block/lapis_ore',
  'diamond_ore': 'block/diamond_ore',
  'nether_quartz_ore': 'block/nether_quartz_ore',
  'nether_gold_ore': 'block/nether_gold_ore',
  'ancient_debris': 'block/ancient_debris_side',
  
  // Deepslate ores
  'deepslate_coal_ore': 'block/deepslate_coal_ore',
  'deepslate_iron_ore': 'block/deepslate_iron_ore',
  'deepslate_copper_ore': 'block/deepslate_copper_ore',
  'deepslate_gold_ore': 'block/deepslate_gold_ore',
  'deepslate_redstone_ore': 'block/deepslate_redstone_ore',
  'deepslate_emerald_ore': 'block/deepslate_emerald_ore',
  'deepslate_lapis_ore': 'block/deepslate_lapis_ore',
  'deepslate_diamond_ore': 'block/deepslate_diamond_ore',
  
  // Blocks
  'coal_block': 'block/coal_block',
  'iron_block': 'block/iron_block',
  'copper_block': 'block/copper_block',
  'gold_block': 'block/gold_block',
  'redstone_block': 'block/redstone_block',
  'emerald_block': 'block/emerald_block',
  'lapis_block': 'block/lapis_block',
  'diamond_block': 'block/diamond_block',
  'netherite_block': 'block/netherite_block',
  'amethyst_block': 'block/amethyst_block',
  
  // Raw ore blocks
  'raw_iron_block': 'block/raw_iron_block',
  'raw_copper_block': 'block/raw_copper_block',
  'raw_gold_block': 'block/raw_gold_block',
};

/**
 * Get all textures for a block (for preloading)
 */
export function getBlockTextures(blockName) {
  const name = blockName.replace('minecraft:', '');
  const textures = new Set();
  
  const multiface = MULTIFACE_BLOCKS[name];
  if (multiface) {
    if (multiface.all) textures.add(multiface.all);
    if (multiface.top) textures.add(multiface.top);
    if (multiface.bottom) textures.add(multiface.bottom);
    if (multiface.side) textures.add(multiface.side);
    if (multiface.front) textures.add(multiface.front);
    if (multiface.back) textures.add(multiface.back);
  } else if (TEXTURE_MAPPINGS[name]) {
    textures.add(TEXTURE_MAPPINGS[name]);
  } else {
    textures.add(`block/${name}`);
  }
  
  return Array.from(textures);
}

export default getBlockTexture;

