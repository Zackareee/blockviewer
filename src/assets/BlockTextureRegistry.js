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
    // Handle 'all' first (same texture on all faces)
    if (multiface.all) return multiface.all;
    
    // Handle top/bottom faces
    if (face === 'up' && multiface.top) return multiface.top;
    if (face === 'down' && multiface.bottom) return multiface.bottom;
    
    // Handle directional blocks with 'front' face
    // Default facing in Minecraft is typically 'north', so 'north' face shows 'front'
    // For solid block rendering without state, we use 'north' as the front
    if (multiface.front) {
      if (face === 'north') return multiface.front;
      // Back face (south) uses side texture
      if (face === 'south' && multiface.back) return multiface.back;
    }
    
    // Fall back to side texture
    return multiface.side || `block/${name}`;
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
      
      // Check special cases BEFORE stone types (for plural forms like stone_bricks)
      if (PARTIAL_BLOCK_TEXTURES[baseName]) {
        return PARTIAL_BLOCK_TEXTURES[baseName];
      }
      
      // Check for planks-based blocks
      if (WOOD_TYPES.has(baseName)) {
        return `block/${baseName}_planks`;
      }
      
      // Check for stone variants
      if (STONE_TYPES.has(baseName)) {
        return `block/${baseName}`;
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
  // Smooth sandstone uses the top texture
  'smooth_sandstone': 'block/sandstone_top',
  'smooth_red_sandstone': 'block/red_sandstone_top',
  // Petrified oak uses regular oak planks
  'petrified_oak': 'block/oak_planks',
  // Resin bricks
  'resin_brick': 'block/resin_bricks',
  // Copper variants
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
  
  // Froglights
  'ochre_froglight', 'pearlescent_froglight', 'verdant_froglight',
]);

/**
 * Blocks with different textures per face
 */
const MULTIFACE_BLOCKS = {
  // Grass and related
  // Note: grass_block has a tinted overlay on side faces rendered separately in FastMesher
  'grass_block': { top: 'block/grass_block_top', side: 'block/grass_block_side', bottom: 'block/dirt', sideOverlay: 'block/grass_block_side_overlay' },
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
  
  // Wood blocks (bark on all sides - use log side texture for all faces)
  'oak_wood': { all: 'block/oak_log' },
  'spruce_wood': { all: 'block/spruce_log' },
  'birch_wood': { all: 'block/birch_log' },
  'jungle_wood': { all: 'block/jungle_log' },
  'acacia_wood': { all: 'block/acacia_log' },
  'dark_oak_wood': { all: 'block/dark_oak_log' },
  'mangrove_wood': { all: 'block/mangrove_log' },
  'cherry_wood': { all: 'block/cherry_log' },
  'pale_oak_wood': { all: 'block/pale_oak_log' },
  
  // Stripped wood blocks (stripped bark on all sides)
  'stripped_oak_wood': { all: 'block/stripped_oak_log' },
  'stripped_spruce_wood': { all: 'block/stripped_spruce_log' },
  'stripped_birch_wood': { all: 'block/stripped_birch_log' },
  'stripped_jungle_wood': { all: 'block/stripped_jungle_log' },
  'stripped_acacia_wood': { all: 'block/stripped_acacia_log' },
  'stripped_dark_oak_wood': { all: 'block/stripped_dark_oak_log' },
  'stripped_mangrove_wood': { all: 'block/stripped_mangrove_log' },
  'stripped_cherry_wood': { all: 'block/stripped_cherry_log' },
  'stripped_pale_oak_wood': { all: 'block/stripped_pale_oak_log' },
  
  // Nether hyphae (bark on all sides - like wood but for nether)
  'crimson_hyphae': { all: 'block/crimson_stem' },
  'warped_hyphae': { all: 'block/warped_stem' },
  'stripped_crimson_hyphae': { all: 'block/stripped_crimson_stem' },
  'stripped_warped_hyphae': { all: 'block/stripped_warped_stem' },
  
  // Mangrove roots
  'mangrove_roots': { top: 'block/mangrove_roots_top', side: 'block/mangrove_roots_side' },
  'muddy_mangrove_roots': { top: 'block/muddy_mangrove_roots_top', side: 'block/muddy_mangrove_roots_side' },
  
  // Froglights
  'ochre_froglight': { top: 'block/ochre_froglight_top', side: 'block/ochre_froglight_side' },
  'pearlescent_froglight': { top: 'block/pearlescent_froglight_top', side: 'block/pearlescent_froglight_side' },
  'verdant_froglight': { top: 'block/verdant_froglight_top', side: 'block/verdant_froglight_side' },
  
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
  'carved_pumpkin': { top: 'block/pumpkin_top', side: 'block/pumpkin_side', front: 'block/carved_pumpkin' },
  'jack_o_lantern': { top: 'block/pumpkin_top', side: 'block/pumpkin_side', front: 'block/jack_o_lantern' },
  'melon': { top: 'block/melon_top', side: 'block/melon_side' },
  
  // Hay block
  'hay_block': { top: 'block/hay_block_top', side: 'block/hay_block_side' },
  
  // Lodestone and target
  'lodestone': { top: 'block/lodestone_top', side: 'block/lodestone_side' },
  'target': { top: 'block/target_top', side: 'block/target_side' },
  
  // Reinforced deepslate
  'reinforced_deepslate': { top: 'block/reinforced_deepslate_top', side: 'block/reinforced_deepslate_side', bottom: 'block/reinforced_deepslate_bottom' },
  
  // Jukebox
  'jukebox': { top: 'block/jukebox_top', side: 'block/jukebox_side' },
  
  // Sculk
  'sculk_catalyst': { top: 'block/sculk_catalyst_top', side: 'block/sculk_catalyst_side', bottom: 'block/sculk_catalyst_bottom' },
  
  // Nylium (nether grass-like blocks)
  'crimson_nylium': { top: 'block/crimson_nylium', side: 'block/crimson_nylium_side', bottom: 'block/netherrack' },
  'warped_nylium': { top: 'block/warped_nylium', side: 'block/warped_nylium_side', bottom: 'block/netherrack' },
  
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
  
  // Respawn anchor
  'respawn_anchor': { top: 'block/respawn_anchor_top_off', side: 'block/respawn_anchor_side0', bottom: 'block/respawn_anchor_bottom' },
  
  // Bookshelves
  'bookshelf': { top: 'block/oak_planks', side: 'block/bookshelf' },
  // Chiseled bookshelf (empty state - filled states handled separately)
  'chiseled_bookshelf': { top: 'block/chiseled_bookshelf_top', side: 'block/chiseled_bookshelf_side', front: 'block/chiseled_bookshelf_empty' },
  
  // Loom
  'loom': { top: 'block/loom_top', side: 'block/loom_side', front: 'block/loom_front' },
  
  // Lectern
  'lectern': { top: 'block/lectern_top', side: 'block/lectern_sides', front: 'block/lectern_front', bottom: 'block/lectern_base' },
};

/**
 * Special texture name mappings
 */
const TEXTURE_MAPPINGS = {
  // Simplified names
  'grass': 'block/short_grass',
  'short_grass': 'block/short_grass',
  'fern': 'block/fern',
  
  // Tall two-block plants - use top texture as it's more distinctive
  // Note: These blocks have half=upper/lower variants in NBT
  'tall_grass': 'block/tall_grass_top',
  'large_fern': 'block/large_fern_top',
  'sunflower': 'block/sunflower_front',
  'lilac': 'block/lilac_top',
  'rose_bush': 'block/rose_bush_top',
  'peony': 'block/peony_top',
  'pitcher_plant': 'block/pitcher_crop_top',
  'tall_seagrass': 'block/tall_seagrass_top',
  
  // Cross-model plants
  'sugar_cane': 'block/sugar_cane',
  'cactus': 'block/cactus_side',
  'bamboo': 'block/bamboo_stalk',
  'firefly_bush': 'block/firefly_bush',
  
  // Other non-cube blocks that need explicit mappings
  'pink_petals': 'block/pink_petals',
  'lily_pad': 'block/lily_pad',
  'spore_blossom': 'block/spore_blossom',
  'sea_pickle': 'block/sea_pickle',
  'chorus_plant': 'block/chorus_plant',
  'chorus_flower': 'block/chorus_flower',
  'nether_sprouts': 'block/nether_sprouts',
  'hanging_roots': 'block/hanging_roots',
  'azalea': 'block/azalea_plant',
  'flowering_azalea': 'block/flowering_azalea',
  'cave_vines': 'block/cave_vines',
  'cave_vines_plant': 'block/cave_vines_plant',
  'glow_lichen': 'block/glow_lichen',
  'sculk_vein': 'block/sculk_vein',
  'cobweb': 'block/cobweb',
  'dead_bush': 'block/dead_bush',
  
  // Crops
  'wheat': 'block/wheat_stage7',
  'carrots': 'block/carrots_stage3',
  'potatoes': 'block/potatoes_stage3',
  'beetroots': 'block/beetroots_stage3',
  'nether_wart': 'block/nether_wart_stage2',
  'sweet_berry_bush': 'block/sweet_berry_bush_stage3',
  'torchflower': 'block/torchflower',
  
  // Redstone components
  'redstone_wire': 'block/redstone_dust_line0',
  'comparator': 'block/comparator',
  'repeater': 'block/repeater',
  
  // Utility blocks
  'cake': 'block/cake_side',
  'composter': 'block/composter_side',
  'hopper': 'block/hopper_outside',
  
  // Rails
  'rail': 'block/rail',
  'powered_rail': 'block/powered_rail',
  'detector_rail': 'block/detector_rail',
  'activator_rail': 'block/activator_rail',
  
  // Vines
  'vine': 'block/vine',
  'twisting_vines': 'block/twisting_vines',
  'twisting_vines_plant': 'block/twisting_vines_plant',
  'weeping_vines': 'block/weeping_vines',
  'weeping_vines_plant': 'block/weeping_vines_plant',
  
  // Dripleaf
  'big_dripleaf': 'block/big_dripleaf_top',
  'big_dripleaf_stem': 'block/big_dripleaf_stem',
  'small_dripleaf': 'block/small_dripleaf_top',
  
  // Snow
  'snow': 'block/snow',
  'snow_block': 'block/snow',
  'powder_snow': 'block/powder_snow',
  
  // Moss
  'moss_carpet': 'block/moss_block',
  'pale_moss_carpet': 'block/pale_moss_block',
  'pale_hanging_moss': 'block/pale_hanging_moss',
  
  // Other partial blocks  
  'short_dry_grass': 'block/short_dry_grass',
  'tall_dry_grass': 'block/tall_dry_grass',
  'leaf_litter': 'block/leaf_litter',
  'dragon_egg': 'block/dragon_egg',
  'turtle_egg': 'block/turtle_egg',
  'sniffer_egg': 'block/sniffer_egg',
  'frogspawn': 'block/frogspawn',
  'decorated_pot': 'block/decorated_pot_side',
  'scaffolding': 'block/scaffolding_side',
  'conduit': 'block/conduit',
  'end_rod': 'block/end_rod',
  'lightning_rod': 'block/lightning_rod',
  
  // Eyeblossoms
  'open_eyeblossom': 'block/open_eyeblossom',
  'closed_eyeblossom': 'block/closed_eyeblossom',
  
  // Crimson/Warped nether plants
  'crimson_roots': 'block/crimson_roots',
  'warped_roots': 'block/warped_roots',
  'crimson_fungus': 'block/crimson_fungus',
  'warped_fungus': 'block/warped_fungus',
  
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
  
  // Glass panes - these use the full glass texture for the pane face and glass_pane_top for the edge
  'glass_pane': 'block/glass',
  'white_stained_glass_pane': 'block/white_stained_glass',
  'orange_stained_glass_pane': 'block/orange_stained_glass',
  'magenta_stained_glass_pane': 'block/magenta_stained_glass',
  'light_blue_stained_glass_pane': 'block/light_blue_stained_glass',
  'yellow_stained_glass_pane': 'block/yellow_stained_glass',
  'lime_stained_glass_pane': 'block/lime_stained_glass',
  'pink_stained_glass_pane': 'block/pink_stained_glass',
  'gray_stained_glass_pane': 'block/gray_stained_glass',
  'light_gray_stained_glass_pane': 'block/light_gray_stained_glass',
  'cyan_stained_glass_pane': 'block/cyan_stained_glass',
  'purple_stained_glass_pane': 'block/purple_stained_glass',
  'blue_stained_glass_pane': 'block/blue_stained_glass',
  'brown_stained_glass_pane': 'block/brown_stained_glass',
  'green_stained_glass_pane': 'block/green_stained_glass',
  'red_stained_glass_pane': 'block/red_stained_glass',
  'black_stained_glass_pane': 'block/black_stained_glass',
  
  // Iron bars - uses iron_bars texture
  'iron_bars': 'block/iron_bars',
  
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
  
  // Chiseled copper variants
  'chiseled_copper': 'block/chiseled_copper',
  'exposed_chiseled_copper': 'block/exposed_chiseled_copper',
  'weathered_chiseled_copper': 'block/weathered_chiseled_copper',
  'oxidized_chiseled_copper': 'block/oxidized_chiseled_copper',
  'waxed_chiseled_copper': 'block/chiseled_copper',
  'waxed_exposed_chiseled_copper': 'block/exposed_chiseled_copper',
  'waxed_weathered_chiseled_copper': 'block/weathered_chiseled_copper',
  'waxed_oxidized_chiseled_copper': 'block/oxidized_chiseled_copper',
  
  // Copper grate variants
  'copper_grate': 'block/copper_grate',
  'exposed_copper_grate': 'block/exposed_copper_grate',
  'weathered_copper_grate': 'block/weathered_copper_grate',
  'oxidized_copper_grate': 'block/oxidized_copper_grate',
  'waxed_copper_grate': 'block/copper_grate',
  'waxed_exposed_copper_grate': 'block/exposed_copper_grate',
  'waxed_weathered_copper_grate': 'block/weathered_copper_grate',
  'waxed_oxidized_copper_grate': 'block/oxidized_copper_grate',
  
  // Copper bulb variants (uses default non-lit texture)
  'copper_bulb': 'block/copper_bulb',
  'exposed_copper_bulb': 'block/exposed_copper_bulb',
  'weathered_copper_bulb': 'block/weathered_copper_bulb',
  'oxidized_copper_bulb': 'block/oxidized_copper_bulb',
  'waxed_copper_bulb': 'block/copper_bulb',
  'waxed_exposed_copper_bulb': 'block/exposed_copper_bulb',
  'waxed_weathered_copper_bulb': 'block/weathered_copper_bulb',
  'waxed_oxidized_copper_bulb': 'block/oxidized_copper_bulb',
  
  // Copper doors (use top texture as main)
  'copper_door': 'block/copper_door_top',
  'exposed_copper_door': 'block/exposed_copper_door_top',
  'weathered_copper_door': 'block/weathered_copper_door_top',
  'oxidized_copper_door': 'block/oxidized_copper_door_top',
  'waxed_copper_door': 'block/copper_door_top',
  'waxed_exposed_copper_door': 'block/exposed_copper_door_top',
  'waxed_weathered_copper_door': 'block/weathered_copper_door_top',
  'waxed_oxidized_copper_door': 'block/oxidized_copper_door_top',
  
  // Copper trapdoors
  'copper_trapdoor': 'block/copper_trapdoor',
  'exposed_copper_trapdoor': 'block/exposed_copper_trapdoor',
  'weathered_copper_trapdoor': 'block/weathered_copper_trapdoor',
  'oxidized_copper_trapdoor': 'block/oxidized_copper_trapdoor',
  'waxed_copper_trapdoor': 'block/copper_trapdoor',
  'waxed_exposed_copper_trapdoor': 'block/exposed_copper_trapdoor',
  'waxed_weathered_copper_trapdoor': 'block/weathered_copper_trapdoor',
  'waxed_oxidized_copper_trapdoor': 'block/oxidized_copper_trapdoor',
  
  // Copper lanterns
  'copper_lantern': 'block/copper_lantern',
  'exposed_copper_lantern': 'block/exposed_copper_lantern',
  'weathered_copper_lantern': 'block/weathered_copper_lantern',
  'oxidized_copper_lantern': 'block/oxidized_copper_lantern',
  'waxed_copper_lantern': 'block/copper_lantern',
  'waxed_exposed_copper_lantern': 'block/exposed_copper_lantern',
  'waxed_weathered_copper_lantern': 'block/weathered_copper_lantern',
  'waxed_oxidized_copper_lantern': 'block/oxidized_copper_lantern',
  
  // Copper chains
  'copper_chain': 'block/copper_chain',
  'exposed_copper_chain': 'block/exposed_copper_chain',
  'weathered_copper_chain': 'block/weathered_copper_chain',
  'oxidized_copper_chain': 'block/oxidized_copper_chain',
  'waxed_copper_chain': 'block/copper_chain',
  'waxed_exposed_copper_chain': 'block/exposed_copper_chain',
  'waxed_weathered_copper_chain': 'block/weathered_copper_chain',
  'waxed_oxidized_copper_chain': 'block/oxidized_copper_chain',
  
  // Copper bars
  'copper_bars': 'block/copper_bars',
  'exposed_copper_bars': 'block/exposed_copper_bars',
  'weathered_copper_bars': 'block/weathered_copper_bars',
  'oxidized_copper_bars': 'block/oxidized_copper_bars',
  'waxed_copper_bars': 'block/copper_bars',
  'waxed_exposed_copper_bars': 'block/exposed_copper_bars',
  'waxed_weathered_copper_bars': 'block/weathered_copper_bars',
  'waxed_oxidized_copper_bars': 'block/oxidized_copper_bars',
  
  // Lightning rods (weathering variants)
  'lightning_rod': 'block/lightning_rod',
  'exposed_lightning_rod': 'block/exposed_lightning_rod',
  'weathered_lightning_rod': 'block/weathered_lightning_rod',
  'oxidized_lightning_rod': 'block/oxidized_lightning_rod',
  
  // Copper torch
  'copper_torch': 'block/copper_torch',
  'copper_wall_torch': 'block/copper_torch',
  
  // Waxed copper full blocks (map to non-waxed textures)
  'waxed_copper_block': 'block/copper_block',
  'waxed_exposed_copper': 'block/exposed_copper',
  'waxed_weathered_copper': 'block/weathered_copper',
  'waxed_oxidized_copper': 'block/oxidized_copper',
  'waxed_cut_copper': 'block/cut_copper',
  'waxed_exposed_cut_copper': 'block/exposed_cut_copper',
  'waxed_weathered_cut_copper': 'block/weathered_cut_copper',
  'waxed_oxidized_cut_copper': 'block/oxidized_cut_copper',
  
  // Waxed lightning rods (map to non-waxed textures)
  'waxed_lightning_rod': 'block/lightning_rod',
  'waxed_exposed_lightning_rod': 'block/exposed_lightning_rod',
  'waxed_weathered_lightning_rod': 'block/weathered_lightning_rod',
  'waxed_oxidized_lightning_rod': 'block/oxidized_lightning_rod',
  
  // Copper chests (entity-based but need a fallback)
  'copper_chest': 'block/copper_block',
  'exposed_copper_chest': 'block/exposed_copper',
  'weathered_copper_chest': 'block/weathered_copper',
  'oxidized_copper_chest': 'block/oxidized_copper',
  'waxed_copper_chest': 'block/copper_block',
  'waxed_exposed_copper_chest': 'block/exposed_copper',
  'waxed_weathered_copper_chest': 'block/weathered_copper',
  'waxed_oxidized_copper_chest': 'block/oxidized_copper',
  
  // Copper golem statues (entity-based but need a fallback)
  'copper_golem_statue': 'block/copper_block',
  'exposed_copper_golem_statue': 'block/exposed_copper',
  'weathered_copper_golem_statue': 'block/weathered_copper',
  'oxidized_copper_golem_statue': 'block/oxidized_copper',
  'waxed_copper_golem_statue': 'block/copper_block',
  'waxed_exposed_copper_golem_statue': 'block/exposed_copper',
  'waxed_weathered_copper_golem_statue': 'block/weathered_copper',
  'waxed_oxidized_copper_golem_statue': 'block/oxidized_copper',
  
  // Infested blocks (use same texture as non-infested)
  'infested_stone': 'block/stone',
  'infested_cobblestone': 'block/cobblestone',
  'infested_stone_bricks': 'block/stone_bricks',
  'infested_mossy_stone_bricks': 'block/mossy_stone_bricks',
  'infested_cracked_stone_bricks': 'block/cracked_stone_bricks',
  'infested_chiseled_stone_bricks': 'block/chiseled_stone_bricks',
  'infested_deepslate': 'block/deepslate',
  
  // Note: reinforced_deepslate moved to MULTIFACE_BLOCKS (has different top/bottom textures)
  
  // Suspicious blocks (use regular texture, animation handled separately)
  'suspicious_sand': 'block/suspicious_sand_0',
  'suspicious_gravel': 'block/suspicious_gravel_0',
  
  // Wood doors (use door_top texture)
  'oak_door': 'block/oak_door_top',
  'spruce_door': 'block/spruce_door_top',
  'birch_door': 'block/birch_door_top',
  'jungle_door': 'block/jungle_door_top',
  'acacia_door': 'block/acacia_door_top',
  'dark_oak_door': 'block/dark_oak_door_top',
  'mangrove_door': 'block/mangrove_door_top',
  'cherry_door': 'block/cherry_door_top',
  'bamboo_door': 'block/bamboo_door_top',
  'crimson_door': 'block/crimson_door_top',
  'warped_door': 'block/warped_door_top',
  'pale_oak_door': 'block/pale_oak_door_top',
  'iron_door': 'block/iron_door_top',
  
  // Wood trapdoors
  'oak_trapdoor': 'block/oak_trapdoor',
  'spruce_trapdoor': 'block/spruce_trapdoor',
  'birch_trapdoor': 'block/birch_trapdoor',
  'jungle_trapdoor': 'block/jungle_trapdoor',
  'acacia_trapdoor': 'block/acacia_trapdoor',
  'dark_oak_trapdoor': 'block/dark_oak_trapdoor',
  'mangrove_trapdoor': 'block/mangrove_trapdoor',
  'cherry_trapdoor': 'block/cherry_trapdoor',
  'bamboo_trapdoor': 'block/bamboo_trapdoor',
  'crimson_trapdoor': 'block/crimson_trapdoor',
  'warped_trapdoor': 'block/warped_trapdoor',
  'pale_oak_trapdoor': 'block/pale_oak_trapdoor',
  'iron_trapdoor': 'block/iron_trapdoor',
  
  // Wood signs (use planks texture as fallback)
  'oak_sign': 'block/oak_planks',
  'oak_wall_sign': 'block/oak_planks',
  'oak_hanging_sign': 'block/oak_planks',
  'oak_wall_hanging_sign': 'block/oak_planks',
  'spruce_sign': 'block/spruce_planks',
  'spruce_wall_sign': 'block/spruce_planks',
  'spruce_hanging_sign': 'block/spruce_planks',
  'spruce_wall_hanging_sign': 'block/spruce_planks',
  'birch_sign': 'block/birch_planks',
  'birch_wall_sign': 'block/birch_planks',
  'birch_hanging_sign': 'block/birch_planks',
  'birch_wall_hanging_sign': 'block/birch_planks',
  'jungle_sign': 'block/jungle_planks',
  'jungle_wall_sign': 'block/jungle_planks',
  'jungle_hanging_sign': 'block/jungle_planks',
  'jungle_wall_hanging_sign': 'block/jungle_planks',
  'acacia_sign': 'block/acacia_planks',
  'acacia_wall_sign': 'block/acacia_planks',
  'acacia_hanging_sign': 'block/acacia_planks',
  'acacia_wall_hanging_sign': 'block/acacia_planks',
  'dark_oak_sign': 'block/dark_oak_planks',
  'dark_oak_wall_sign': 'block/dark_oak_planks',
  'dark_oak_hanging_sign': 'block/dark_oak_planks',
  'dark_oak_wall_hanging_sign': 'block/dark_oak_planks',
  'mangrove_sign': 'block/mangrove_planks',
  'mangrove_wall_sign': 'block/mangrove_planks',
  'mangrove_hanging_sign': 'block/mangrove_planks',
  'mangrove_wall_hanging_sign': 'block/mangrove_planks',
  'cherry_sign': 'block/cherry_planks',
  'cherry_wall_sign': 'block/cherry_planks',
  'cherry_hanging_sign': 'block/cherry_planks',
  'cherry_wall_hanging_sign': 'block/cherry_planks',
  'bamboo_sign': 'block/bamboo_planks',
  'bamboo_wall_sign': 'block/bamboo_planks',
  'bamboo_hanging_sign': 'block/bamboo_planks',
  'bamboo_wall_hanging_sign': 'block/bamboo_planks',
  'crimson_sign': 'block/crimson_planks',
  'crimson_wall_sign': 'block/crimson_planks',
  'crimson_hanging_sign': 'block/crimson_planks',
  'crimson_wall_hanging_sign': 'block/crimson_planks',
  'warped_sign': 'block/warped_planks',
  'warped_wall_sign': 'block/warped_planks',
  'warped_hanging_sign': 'block/warped_planks',
  'warped_wall_hanging_sign': 'block/warped_planks',
  'pale_oak_sign': 'block/pale_oak_planks',
  'pale_oak_wall_sign': 'block/pale_oak_planks',
  'pale_oak_hanging_sign': 'block/pale_oak_planks',
  'pale_oak_wall_hanging_sign': 'block/pale_oak_planks',
  
  // Carpets (use wool texture)
  'white_carpet': 'block/white_wool',
  'orange_carpet': 'block/orange_wool',
  'magenta_carpet': 'block/magenta_wool',
  'light_blue_carpet': 'block/light_blue_wool',
  'yellow_carpet': 'block/yellow_wool',
  'lime_carpet': 'block/lime_wool',
  'pink_carpet': 'block/pink_wool',
  'gray_carpet': 'block/gray_wool',
  'light_gray_carpet': 'block/light_gray_wool',
  'cyan_carpet': 'block/cyan_wool',
  'purple_carpet': 'block/purple_wool',
  'blue_carpet': 'block/blue_wool',
  'brown_carpet': 'block/brown_wool',
  'green_carpet': 'block/green_wool',
  'red_carpet': 'block/red_wool',
  'black_carpet': 'block/black_wool',
  
  // Beds (entity-rendered, use wool texture as fallback)
  'white_bed': 'block/white_wool',
  'orange_bed': 'block/orange_wool',
  'magenta_bed': 'block/magenta_wool',
  'light_blue_bed': 'block/light_blue_wool',
  'yellow_bed': 'block/yellow_wool',
  'lime_bed': 'block/lime_wool',
  'pink_bed': 'block/pink_wool',
  'gray_bed': 'block/gray_wool',
  'light_gray_bed': 'block/light_gray_wool',
  'cyan_bed': 'block/cyan_wool',
  'purple_bed': 'block/purple_wool',
  'blue_bed': 'block/blue_wool',
  'brown_bed': 'block/brown_wool',
  'green_bed': 'block/green_wool',
  'red_bed': 'block/red_wool',
  'black_bed': 'block/black_wool',
  
  // Banners (entity-rendered, use wool texture as fallback)
  'white_banner': 'block/white_wool',
  'white_wall_banner': 'block/white_wool',
  'orange_banner': 'block/orange_wool',
  'orange_wall_banner': 'block/orange_wool',
  'magenta_banner': 'block/magenta_wool',
  'magenta_wall_banner': 'block/magenta_wool',
  'light_blue_banner': 'block/light_blue_wool',
  'light_blue_wall_banner': 'block/light_blue_wool',
  'yellow_banner': 'block/yellow_wool',
  'yellow_wall_banner': 'block/yellow_wool',
  'lime_banner': 'block/lime_wool',
  'lime_wall_banner': 'block/lime_wool',
  'pink_banner': 'block/pink_wool',
  'pink_wall_banner': 'block/pink_wool',
  'gray_banner': 'block/gray_wool',
  'gray_wall_banner': 'block/gray_wool',
  'light_gray_banner': 'block/light_gray_wool',
  'light_gray_wall_banner': 'block/light_gray_wool',
  'cyan_banner': 'block/cyan_wool',
  'cyan_wall_banner': 'block/cyan_wool',
  'purple_banner': 'block/purple_wool',
  'purple_wall_banner': 'block/purple_wool',
  'blue_banner': 'block/blue_wool',
  'blue_wall_banner': 'block/blue_wool',
  'brown_banner': 'block/brown_wool',
  'brown_wall_banner': 'block/brown_wool',
  'green_banner': 'block/green_wool',
  'green_wall_banner': 'block/green_wool',
  'red_banner': 'block/red_wool',
  'red_wall_banner': 'block/red_wool',
  'black_banner': 'block/black_wool',
  'black_wall_banner': 'block/black_wool',
  
  // Candle cakes (use cake texture)
  'candle_cake': 'block/cake_side',
  'white_candle_cake': 'block/cake_side',
  'orange_candle_cake': 'block/cake_side',
  'magenta_candle_cake': 'block/cake_side',
  'light_blue_candle_cake': 'block/cake_side',
  'yellow_candle_cake': 'block/cake_side',
  'lime_candle_cake': 'block/cake_side',
  'pink_candle_cake': 'block/cake_side',
  'gray_candle_cake': 'block/cake_side',
  'light_gray_candle_cake': 'block/cake_side',
  'cyan_candle_cake': 'block/cake_side',
  'purple_candle_cake': 'block/cake_side',
  'blue_candle_cake': 'block/cake_side',
  'brown_candle_cake': 'block/cake_side',
  'green_candle_cake': 'block/cake_side',
  'red_candle_cake': 'block/cake_side',
  'black_candle_cake': 'block/cake_side',
  
  // Special blocks
  'bamboo_sapling': 'block/bamboo_stage0',
  'end_portal_frame': 'block/end_portal_frame_side',
  'frosted_ice': 'block/frosted_ice_0',
  
  // Coral wall fans (use coral fan texture)
  'tube_coral_wall_fan': 'block/tube_coral_fan',
  'brain_coral_wall_fan': 'block/brain_coral_fan',
  'bubble_coral_wall_fan': 'block/bubble_coral_fan',
  'fire_coral_wall_fan': 'block/fire_coral_fan',
  'horn_coral_wall_fan': 'block/horn_coral_fan',
  'dead_tube_coral_wall_fan': 'block/dead_tube_coral_fan',
  'dead_brain_coral_wall_fan': 'block/dead_brain_coral_fan',
  'dead_bubble_coral_wall_fan': 'block/dead_bubble_coral_fan',
  'dead_fire_coral_wall_fan': 'block/dead_fire_coral_fan',
  'dead_horn_coral_wall_fan': 'block/dead_horn_coral_fan',
  
  // Coral fans (regular)
  'tube_coral_fan': 'block/tube_coral_fan',
  'brain_coral_fan': 'block/brain_coral_fan',
  'bubble_coral_fan': 'block/bubble_coral_fan',
  'fire_coral_fan': 'block/fire_coral_fan',
  'horn_coral_fan': 'block/horn_coral_fan',
  'dead_tube_coral_fan': 'block/dead_tube_coral_fan',
  'dead_brain_coral_fan': 'block/dead_brain_coral_fan',
  'dead_bubble_coral_fan': 'block/dead_bubble_coral_fan',
  'dead_fire_coral_fan': 'block/dead_fire_coral_fan',
  'dead_horn_coral_fan': 'block/dead_horn_coral_fan',
  
  // Crops
  'torchflower_crop': 'block/torchflower',
  'pitcher_crop': 'block/pitcher_crop_top',
  'cocoa': 'block/cocoa_stage2',
  
  // Kelp and aquatic
  'dried_kelp_block': 'block/dried_kelp_side',
  
  // Azalea
  'flowering_azalea': 'block/flowering_azalea_side',
  
  // Honey
  'honey_block': 'block/honey_block_side',
  
  // Dripstone
  'pointed_dripstone': 'block/pointed_dripstone_up_tip',
  
  // Sculk blocks (sculk_catalyst moved to MULTIFACE_BLOCKS)
  'sculk_sensor': 'block/sculk_sensor_side',
  'sculk_shrieker': 'block/sculk_shrieker_side',
  'calibrated_sculk_sensor': 'block/sculk_sensor_side',
  
  // Workstation blocks
  'loom': 'block/loom_front',
  'cartography_table': 'block/cartography_table_side1',
  'fletching_table': 'block/fletching_table_side',
  'smithing_table': 'block/smithing_table_side',
  'grindstone': 'block/grindstone_side',
  'stonecutter': 'block/stonecutter_side',
  
  // Anvils
  'chipped_anvil': 'block/anvil_top',
  'damaged_anvil': 'block/anvil_top',
  
  // Enchanting and utility
  'enchanting_table': 'block/enchanting_table_side',
  // Note: jukebox moved to MULTIFACE_BLOCKS (has different top texture)
  'bell': 'block/bell_side',
  // Note: lodestone and target moved to MULTIFACE_BLOCKS (have different top textures)
  'crafter': 'block/crafter_south',
  
  // Cauldrons
  'cauldron': 'block/cauldron_side',
  'water_cauldron': 'block/cauldron_side',
  'lava_cauldron': 'block/cauldron_side',
  'powder_snow_cauldron': 'block/cauldron_side',
  
  // Chests (entity-rendered)
  'chest': 'block/oak_planks',
  'trapped_chest': 'block/oak_planks',
  'ender_chest': 'block/obsidian',
  
  // Redstone components
  'redstone_wall_torch': 'block/redstone_torch',
  'daylight_detector': 'block/daylight_detector_side',
  'observer': 'block/observer_side',
  'piston': 'block/piston_side',
  'sticky_piston': 'block/piston_side',
  'piston_head': 'block/piston_top',
  
  // Command blocks
  'command_block': 'block/command_block_side',
  'chain_command_block': 'block/chain_command_block_side',
  'repeating_command_block': 'block/repeating_command_block_side',
  'jigsaw': 'block/jigsaw_side',
  
  // Trial chambers
  'trial_spawner': 'block/trial_spawner_side_inactive',
  'vault': 'block/vault_side_off',
  
  // Pressure plates
  'light_weighted_pressure_plate': 'block/gold_block',
  'heavy_weighted_pressure_plate': 'block/iron_block',
  
  // Skulls/Heads (entity-rendered, use bone block as fallback)
  'skeleton_skull': 'block/bone_block_side',
  'skeleton_wall_skull': 'block/bone_block_side',
  'wither_skeleton_skull': 'block/coal_block',
  'wither_skeleton_wall_skull': 'block/coal_block',
  'zombie_head': 'block/green_terracotta',
  'zombie_wall_head': 'block/green_terracotta',
  'player_head': 'block/oak_planks',
  'player_wall_head': 'block/oak_planks',
  'creeper_head': 'block/lime_terracotta',
  'creeper_wall_head': 'block/lime_terracotta',
  'dragon_head': 'block/purple_terracotta',
  'dragon_wall_head': 'block/purple_terracotta',
  'piglin_head': 'block/gold_block',
  'piglin_wall_head': 'block/gold_block',
  
  // Torches
  'wall_torch': 'block/torch',
  'soul_wall_torch': 'block/soul_torch',
  
  // Campfires
  'campfire': 'block/campfire_log',
  'soul_campfire': 'block/campfire_log',
  
  // Sniffer egg
  'sniffer_egg': 'block/sniffer_egg_not_cracked_top',
  
  // Potted plants (use the plant's texture)
  'potted_oak_sapling': 'block/oak_sapling',
  'potted_spruce_sapling': 'block/spruce_sapling',
  'potted_birch_sapling': 'block/birch_sapling',
  'potted_jungle_sapling': 'block/jungle_sapling',
  'potted_acacia_sapling': 'block/acacia_sapling',
  'potted_dark_oak_sapling': 'block/dark_oak_sapling',
  'potted_cherry_sapling': 'block/cherry_sapling',
  'potted_mangrove_propagule': 'block/mangrove_propagule',
  'potted_pale_oak_sapling': 'block/pale_oak_sapling',
  'potted_fern': 'block/fern',
  'potted_dead_bush': 'block/dead_bush',
  'potted_dandelion': 'block/dandelion',
  'potted_poppy': 'block/poppy',
  'potted_blue_orchid': 'block/blue_orchid',
  'potted_allium': 'block/allium',
  'potted_azure_bluet': 'block/azure_bluet',
  'potted_red_tulip': 'block/red_tulip',
  'potted_orange_tulip': 'block/orange_tulip',
  'potted_white_tulip': 'block/white_tulip',
  'potted_pink_tulip': 'block/pink_tulip',
  'potted_oxeye_daisy': 'block/oxeye_daisy',
  'potted_cornflower': 'block/cornflower',
  'potted_lily_of_the_valley': 'block/lily_of_the_valley',
  'potted_wither_rose': 'block/wither_rose',
  'potted_brown_mushroom': 'block/brown_mushroom',
  'potted_red_mushroom': 'block/red_mushroom',
  'potted_crimson_fungus': 'block/crimson_fungus',
  'potted_warped_fungus': 'block/warped_fungus',
  'potted_crimson_roots': 'block/crimson_roots',
  'potted_warped_roots': 'block/warped_roots',
  'potted_azalea_bush': 'block/potted_azalea_bush_plant',
  'potted_flowering_azalea_bush': 'block/potted_flowering_azalea_bush_plant',
  'potted_bamboo': 'block/bamboo_stalk',
  'potted_cactus': 'block/cactus_side',
  'potted_torchflower': 'block/torchflower',
  'potted_open_eyeblossom': 'block/open_eyeblossom',
  'potted_closed_eyeblossom': 'block/closed_eyeblossom',
  
  // Decorated pot (entity-rendered, use terracotta as fallback)
  'decorated_pot': 'block/terracotta',
  
  // Dried ghast (new block)
  'dried_ghast': 'block/dried_ghast_hydration_0_top',
  
  // Test block (debug/development block)
  'test_block': 'block/test_block_start',
  'test_instance_block': 'block/test_instance_block',
  
  // ============================================
  // ADDITIONAL BLOCK MAPPINGS (from debug world)
  // ============================================
  
  // Leaves
  'acacia_leaves': 'block/acacia_leaves',
  'azalea_leaves': 'block/azalea_leaves',
  'birch_leaves': 'block/birch_leaves',
  'cherry_leaves': 'block/cherry_leaves',
  'dark_oak_leaves': 'block/dark_oak_leaves',
  'flowering_azalea_leaves': 'block/flowering_azalea_leaves',
  'jungle_leaves': 'block/jungle_leaves',
  'mangrove_leaves': 'block/mangrove_leaves',
  'oak_leaves': 'block/oak_leaves',
  'pale_oak_leaves': 'block/pale_oak_leaves',
  'spruce_leaves': 'block/spruce_leaves',
  
  // Saplings
  'acacia_sapling': 'block/acacia_sapling',
  'birch_sapling': 'block/birch_sapling',
  'cherry_sapling': 'block/cherry_sapling',
  'dark_oak_sapling': 'block/dark_oak_sapling',
  'jungle_sapling': 'block/jungle_sapling',
  'mangrove_propagule': 'block/mangrove_propagule',
  'oak_sapling': 'block/oak_sapling',
  'pale_oak_sapling': 'block/pale_oak_sapling',
  'spruce_sapling': 'block/spruce_sapling',
  
  // Flowers
  'allium': 'block/allium',
  'azure_bluet': 'block/azure_bluet',
  'blue_orchid': 'block/blue_orchid',
  'cornflower': 'block/cornflower',
  'dandelion': 'block/dandelion',
  'lily_of_the_valley': 'block/lily_of_the_valley',
  'orange_tulip': 'block/orange_tulip',
  'oxeye_daisy': 'block/oxeye_daisy',
  'pink_tulip': 'block/pink_tulip',
  'poppy': 'block/poppy',
  'red_tulip': 'block/red_tulip',
  'white_tulip': 'block/white_tulip',
  'wither_rose': 'block/wither_rose',
  'wildflowers': 'block/wildflowers',
  
  // Tall flowers/plants
  'lilac': 'block/lilac_top',
  'peony': 'block/peony_top',
  'rose_bush': 'block/rose_bush_top',
  'sunflower': 'block/sunflower_front',
  'large_fern': 'block/large_fern_top',
  'tall_grass': 'block/tall_grass_top',
  'pitcher_plant': 'block/pitcher_crop_top_stage_4',
  'tall_seagrass': 'block/tall_seagrass_top',
  'short_dry_grass': 'block/short_dry_grass',
  'tall_dry_grass': 'block/tall_dry_grass',
  
  // Mushrooms
  'brown_mushroom': 'block/brown_mushroom',
  'red_mushroom': 'block/red_mushroom',
  'brown_mushroom_block': 'block/brown_mushroom_block',
  'red_mushroom_block': 'block/red_mushroom_block',
  'mushroom_stem': 'block/mushroom_stem',
  
  // Candles (all colors)
  'candle': 'block/candle',
  'white_candle': 'block/white_candle',
  'orange_candle': 'block/orange_candle',
  'magenta_candle': 'block/magenta_candle',
  'light_blue_candle': 'block/light_blue_candle',
  'yellow_candle': 'block/yellow_candle',
  'lime_candle': 'block/lime_candle',
  'pink_candle': 'block/pink_candle',
  'gray_candle': 'block/gray_candle',
  'light_gray_candle': 'block/light_gray_candle',
  'cyan_candle': 'block/cyan_candle',
  'purple_candle': 'block/purple_candle',
  'blue_candle': 'block/blue_candle',
  'brown_candle': 'block/brown_candle',
  'green_candle': 'block/green_candle',
  'red_candle': 'block/red_candle',
  'black_candle': 'block/black_candle',
  
  // Coral blocks
  'brain_coral_block': 'block/brain_coral_block',
  'bubble_coral_block': 'block/bubble_coral_block',
  'fire_coral_block': 'block/fire_coral_block',
  'horn_coral_block': 'block/horn_coral_block',
  'tube_coral_block': 'block/tube_coral_block',
  'dead_brain_coral_block': 'block/dead_brain_coral_block',
  'dead_bubble_coral_block': 'block/dead_bubble_coral_block',
  'dead_fire_coral_block': 'block/dead_fire_coral_block',
  'dead_horn_coral_block': 'block/dead_horn_coral_block',
  'dead_tube_coral_block': 'block/dead_tube_coral_block',
  
  // Coral (non-block)
  'brain_coral': 'block/brain_coral',
  'bubble_coral': 'block/bubble_coral',
  'fire_coral': 'block/fire_coral',
  'horn_coral': 'block/horn_coral',
  'tube_coral': 'block/tube_coral',
  'dead_brain_coral': 'block/dead_brain_coral',
  'dead_bubble_coral': 'block/dead_bubble_coral',
  'dead_fire_coral': 'block/dead_fire_coral',
  'dead_horn_coral': 'block/dead_horn_coral',
  'dead_tube_coral': 'block/dead_tube_coral',
  
  // Amethyst
  'amethyst_cluster': 'block/amethyst_cluster',
  'large_amethyst_bud': 'block/large_amethyst_bud',
  'medium_amethyst_bud': 'block/medium_amethyst_bud',
  'small_amethyst_bud': 'block/small_amethyst_bud',
  'budding_amethyst': 'block/budding_amethyst',
  
  // Basic blocks
  'bedrock': 'block/bedrock',
  // Note: bookshelf moved to MULTIFACE_BLOCKS (has oak_planks on top/bottom)
  'bricks': 'block/bricks',
  'clay': 'block/clay',
  'coarse_dirt': 'block/coarse_dirt',
  'dirt': 'block/dirt',
  'rooted_dirt': 'block/rooted_dirt',
  'gravel': 'block/gravel',
  'sand': 'block/sand',
  'red_sand': 'block/red_sand',
  'mud': 'block/mud',
  'packed_mud': 'block/packed_mud',
  'mud_bricks': 'block/mud_bricks',
  'moss_block': 'block/moss_block',
  'pale_moss_block': 'block/pale_moss_block',
  'calcite': 'block/calcite',
  'dripstone_block': 'block/dripstone_block',
  'tuff_bricks': 'block/tuff_bricks',
  'end_stone': 'block/end_stone',
  'end_stone_bricks': 'block/end_stone_bricks',
  'glowstone': 'block/glowstone',
  'ice': 'block/ice',
  'blue_ice': 'block/blue_ice',
  'packed_ice': 'block/packed_ice',
  'magma_block': 'block/magma',
  'netherrack': 'block/netherrack',
  'nether_wart_block': 'block/nether_wart_block',
  'warped_wart_block': 'block/warped_wart_block',
  'obsidian': 'block/obsidian',
  'crying_obsidian': 'block/crying_obsidian',
  'note_block': 'block/note_block',
  'purpur_block': 'block/purpur_block',
  'quartz_bricks': 'block/quartz_bricks',
  'sea_lantern': 'block/sea_lantern',
  'shroomlight': 'block/shroomlight',
  'slime_block': 'block/slime_block',
  'smooth_basalt': 'block/smooth_basalt',
  'smooth_stone': 'block/smooth_stone',
  'soul_sand': 'block/soul_sand',
  'soul_soil': 'block/soul_soil',
  'sponge': 'block/sponge',
  'wet_sponge': 'block/wet_sponge',
  'terracotta': 'block/terracotta',
  'honeycomb_block': 'block/honeycomb_block',
  'resin_block': 'block/resin_block',
  'resin_bricks': 'block/resin_bricks',
  'resin_clump': 'block/resin_clump',
  
  // Chiseled variants
  'chiseled_polished_blackstone': 'block/chiseled_polished_blackstone',
  'chiseled_quartz_block': 'block/chiseled_quartz_block',
  'chiseled_red_sandstone': 'block/chiseled_red_sandstone',
  'chiseled_sandstone': 'block/chiseled_sandstone',
  'chiseled_resin_bricks': 'block/chiseled_resin_bricks',
  'chiseled_tuff': 'block/chiseled_tuff',
  'chiseled_tuff_bricks': 'block/chiseled_tuff_bricks',
  'cracked_polished_blackstone_bricks': 'block/cracked_polished_blackstone_bricks',
  'polished_blackstone_bricks': 'block/polished_blackstone_bricks',
  'prismarine_bricks': 'block/prismarine_bricks',
  'gilded_blackstone': 'block/gilded_blackstone',
  'bamboo_mosaic': 'block/bamboo_mosaic',
  
  // Note: nylium moved to MULTIFACE_BLOCKS (has different top textures)
  
  // Anvil
  'anvil': 'block/anvil_top',
  
  // Brewing stand
  'brewing_stand': 'block/brewing_stand',
  
  // Flower pot (empty)
  'flower_pot': 'block/flower_pot',
  
  // Farmland
  'farmland': 'block/farmland',
  
  // Ladder
  'ladder': 'block/ladder',
  
  // Lanterns
  'lantern': 'block/lantern',
  'soul_lantern': 'block/soul_lantern',
  
  // Torches
  'torch': 'block/torch',
  'soul_torch': 'block/soul_torch',
  'redstone_torch': 'block/redstone_torch',
  
  // Lever
  'lever': 'block/lever',
  
  // Stems
  'melon_stem': 'block/melon_stem',
  'pumpkin_stem': 'block/pumpkin_stem',
  'attached_melon_stem': 'block/attached_melon_stem',
  'attached_pumpkin_stem': 'block/attached_pumpkin_stem',
  
  // Iron chain (also old name 'chain' for backwards compatibility)
  'chain': 'block/iron_chain',
  'iron_chain': 'block/iron_chain',
  
  // Kelp
  'kelp': 'block/kelp',
  'kelp_plant': 'block/kelp_plant',
  
  // Seagrass
  'seagrass': 'block/seagrass',
  
  // Sculk
  'sculk': 'block/sculk',
  
  // Redstone lamp
  'redstone_lamp': 'block/redstone_lamp',
  
  // Shelves (new blocks)
  'acacia_shelf': 'block/acacia_shelf',
  'bamboo_shelf': 'block/bamboo_shelf',
  'birch_shelf': 'block/birch_shelf',
  'cherry_shelf': 'block/cherry_shelf',
  'crimson_shelf': 'block/crimson_shelf',
  'dark_oak_shelf': 'block/dark_oak_shelf',
  'jungle_shelf': 'block/jungle_shelf',
  'mangrove_shelf': 'block/mangrove_shelf',
  'oak_shelf': 'block/oak_shelf',
  'pale_oak_shelf': 'block/pale_oak_shelf',
  'spruce_shelf': 'block/spruce_shelf',
  'warped_shelf': 'block/warped_shelf',
  
  // New 1.21+ blocks
  'bush': 'block/bush',
  'cactus_flower': 'block/cactus_flower',
  'creaking_heart': 'block/creaking_heart',
  'firefly_bush': 'block/firefly_bush',
  'frogspawn': 'block/frogspawn',
  'closed_eyeblossom': 'block/closed_eyeblossom',
  'open_eyeblossom': 'block/open_eyeblossom',
  'pale_hanging_moss': 'block/pale_hanging_moss',
  'pale_moss_carpet': 'block/pale_moss_block',
  'moss_carpet': 'block/moss_block',
  'leaf_litter': 'block/leaf_litter',
  
  // Nether fungi
  'crimson_fungus': 'block/crimson_fungus',
  'warped_fungus': 'block/warped_fungus',
  'crimson_roots': 'block/crimson_roots',
  'warped_roots': 'block/warped_roots',
  'nether_sprouts': 'block/nether_sprouts',
  
  // Vines
  'twisting_vines': 'block/twisting_vines',
  'twisting_vines_plant': 'block/twisting_vines_plant',
  'weeping_vines': 'block/weeping_vines',
  'weeping_vines_plant': 'block/weeping_vines_plant',
  'cave_vines': 'block/cave_vines',
  'cave_vines_plant': 'block/cave_vines_plant',
  'vine': 'block/vine',
  'glow_lichen': 'block/glow_lichen',
  'sculk_vein': 'block/sculk_vein',
  
  // Dripleaf
  'big_dripleaf': 'block/big_dripleaf_top',
  'big_dripleaf_stem': 'block/big_dripleaf_stem',
  'small_dripleaf': 'block/small_dripleaf_top',
  
  // Hanging roots
  'hanging_roots': 'block/hanging_roots',
  'spore_blossom': 'block/spore_blossom',
  
  // Azalea
  'azalea': 'block/azalea_side',
  
  // End blocks
  'end_rod': 'block/end_rod',
  'chorus_plant': 'block/chorus_plant',
  'chorus_flower': 'block/chorus_flower',
  'dragon_egg': 'block/dragon_egg',
  
  // Misc plants
  'dead_bush': 'block/dead_bush',
  'fern': 'block/fern',
  'short_grass': 'block/short_grass',
  'sugar_cane': 'block/sugar_cane',
  'cactus': 'block/cactus_side',
  'bamboo': 'block/bamboo_stalk',
  'lily_pad': 'block/lily_pad',
  'pink_petals': 'block/pink_petals',
  'nether_wart': 'block/nether_wart_stage2',
  'beetroots': 'block/beetroots_stage3',
  'carrots': 'block/carrots_stage3',
  'potatoes': 'block/potatoes_stage3',
  'wheat': 'block/wheat_stage7',
  'sweet_berry_bush': 'block/sweet_berry_bush_stage3',
  'torchflower': 'block/torchflower',
  
  // Comparator/Repeater
  'comparator': 'block/comparator',
  'repeater': 'block/repeater',
  
  // Scaffolding
  'scaffolding': 'block/scaffolding_side',
  
  // Rails
  'rail': 'block/rail',
  'powered_rail': 'block/powered_rail',
  'detector_rail': 'block/detector_rail',
  'activator_rail': 'block/activator_rail',
  
  // Hoppers/Composter
  'hopper': 'block/hopper_outside',
  'composter': 'block/composter_side',
  
  // Cake
  'cake': 'block/cake_side',
  
  // Tripwire
  'tripwire_hook': 'block/tripwire_hook',
  'tripwire': 'block/tripwire',
  
  // Cobweb
  'cobweb': 'block/cobweb',
  
  // Sea pickle
  'sea_pickle': 'block/sea_pickle',
  
  // Turtle egg
  'turtle_egg': 'block/turtle_egg',
  
  // Redstone wire
  'redstone_wire': 'block/redstone_dust_line0',
  
  // Barrel
  'barrel': 'block/barrel_side',
  
  // Bee nest/hive
  'bee_nest': 'block/bee_nest_front',
  'beehive': 'block/beehive_front',
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
    if (multiface.sideOverlay) textures.add(multiface.sideOverlay);
  } else if (TEXTURE_MAPPINGS[name]) {
    textures.add(TEXTURE_MAPPINGS[name]);
  } else {
    textures.add(`block/${name}`);
  }
  
  return Array.from(textures);
}

/**
 * Get the overlay texture path for a block's side faces (if any)
 * Used for blocks like grass_block that have a tinted overlay on side faces
 * @param {string} blockName - Block name (with or without minecraft: prefix)
 * @returns {string|null} Overlay texture path or null if no overlay
 */
export function getBlockSideOverlay(blockName) {
  const name = blockName.replace('minecraft:', '');
  const multiface = MULTIFACE_BLOCKS[name];
  if (multiface && multiface.sideOverlay) {
    return multiface.sideOverlay;
  }
  return null;
}

export default getBlockTexture;

