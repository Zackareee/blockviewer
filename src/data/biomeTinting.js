/**
 * BiomeTinting - Minecraft biome color tinting system
 * 
 * In Minecraft, certain blocks (grass, leaves, water, etc.) are tinted based on biome.
 * The tinting uses colormap textures:
 * - grass.png: Used for grass blocks, short/tall grass, ferns, sugar cane
 * - foliage.png: Used for leaves, vines
 * 
 * The colormap is 256x256 where:
 * - X-axis: Temperature (0=hot/right, 255=cold/left in Minecraft's inverted coords)
 * - Y-axis: Downfall/humidity (0=dry/top, 255=wet/bottom)
 * 
 * Since we don't have actual biome data, we use default biome colors:
 * - Plains biome: Temperature=0.8, Downfall=0.4 → coordinates (50, 178)
 * 
 * Some blocks have fixed tint colors:
 * - Spruce leaves: #619961
 * - Birch leaves: #80a755
 * - Water: #3F76E4 (default, varies by biome in actual Minecraft)
 */

// Tint types - used to identify which colormap/color to use
export const TINT_TYPE = {
  NONE: 0,           // No tinting (default for most blocks)
  GRASS: 1,          // Use grass colormap
  FOLIAGE: 2,        // Use foliage colormap
  SPRUCE: 3,         // Fixed spruce leaves color
  BIRCH: 4,          // Fixed birch leaves color
  WATER: 5,          // Water tint
  REDSTONE: 6,       // Redstone wire (intensity-based)
  DRY_FOLIAGE: 7,    // Pale garden dead foliage
};

// Fixed tint colors for specific block types (RGB 0-1)
export const FIXED_TINT_COLORS = {
  [TINT_TYPE.SPRUCE]: { r: 0.380, g: 0.600, b: 0.380 },    // #619961
  [TINT_TYPE.BIRCH]: { r: 0.502, g: 0.655, b: 0.333 },     // #80a755
  [TINT_TYPE.WATER]: { r: 0.247, g: 0.463, b: 0.894 },     // #3F76E4
  [TINT_TYPE.DRY_FOLIAGE]: { r: 0.667, g: 0.580, b: 0.439 }, // #AB9470
};

// Default biome color sampling coordinates (Plains biome)
// Temperature: 0.8, Downfall: 0.4
// Colormap coords: x = clamp(temp) * 255, y = clamp(downfall * temp) * 255
// For plains: x = 0.8 * 255 = 204, y = (0.4 * 0.8) * 255 = 81
// In Minecraft's inverted system: x = 255 - 204 = 51, y = 255 - 81 = 174
// But in a typical colormap, we sample at (255 - temp*255, 255 - downfall*temp*255)
export const DEFAULT_BIOME_UV = {
  grass: { x: 0.5, y: 0.5 },    // Middle of colormap for nice green
  foliage: { x: 0.5, y: 0.5 },  // Middle of colormap
};

// Block names that need grass colormap tinting
const GRASS_TINTED_BLOCKS = new Set([
  'minecraft:grass_block',
  'minecraft:short_grass',
  'minecraft:tall_grass',
  'minecraft:fern',
  'minecraft:large_fern',
  'minecraft:sugar_cane',
  // Potted fern uses fern tint
  'minecraft:potted_fern',
]);

// Block names that need foliage colormap tinting
const FOLIAGE_TINTED_BLOCKS = new Set([
  // Oak leaves
  'minecraft:oak_leaves',
  // Jungle leaves
  'minecraft:jungle_leaves',
  // Acacia leaves
  'minecraft:acacia_leaves',
  // Dark oak leaves  
  'minecraft:dark_oak_leaves',
  // Mangrove leaves
  'minecraft:mangrove_leaves',
  // Vines
  'minecraft:vine',
]);

// Block names with fixed spruce tint
const SPRUCE_TINTED_BLOCKS = new Set([
  'minecraft:spruce_leaves',
]);

// Block names with fixed birch tint
const BIRCH_TINTED_BLOCKS = new Set([
  'minecraft:birch_leaves',
]);

// Block names with water tint
const WATER_TINTED_BLOCKS = new Set([
  'minecraft:water',
  'minecraft:bubble_column',
  'minecraft:water_cauldron',
]);

// Block names with dry foliage tint (pale garden)
const DRY_FOLIAGE_TINTED_BLOCKS = new Set([
  'minecraft:pale_oak_leaves',
  'minecraft:pale_moss_block',
  'minecraft:pale_moss_carpet',
  'minecraft:pale_hanging_moss',
]);

/**
 * Get the tint type for a block
 * @param {string} blockName - Full block name (e.g., 'minecraft:grass_block')
 * @returns {number} TINT_TYPE value
 */
export function getBlockTintType(blockName) {
  if (!blockName) return TINT_TYPE.NONE;
  
  // Check exact matches first
  if (GRASS_TINTED_BLOCKS.has(blockName)) return TINT_TYPE.GRASS;
  if (FOLIAGE_TINTED_BLOCKS.has(blockName)) return TINT_TYPE.FOLIAGE;
  if (SPRUCE_TINTED_BLOCKS.has(blockName)) return TINT_TYPE.SPRUCE;
  if (BIRCH_TINTED_BLOCKS.has(blockName)) return TINT_TYPE.BIRCH;
  if (WATER_TINTED_BLOCKS.has(blockName)) return TINT_TYPE.WATER;
  if (DRY_FOLIAGE_TINTED_BLOCKS.has(blockName)) return TINT_TYPE.DRY_FOLIAGE;
  
  return TINT_TYPE.NONE;
}

/**
 * Get the tint type for a block by its short name (without minecraft: prefix)
 * @param {string} shortName - Block name without prefix
 * @returns {number} TINT_TYPE value
 */
export function getBlockTintTypeByShortName(shortName) {
  return getBlockTintType(`minecraft:${shortName}`);
}

/**
 * Build a lookup array for fast tint type retrieval by block ID
 * @param {Object} registry - BlockRegistry instance
 * @returns {Uint8Array} Array indexed by block ID containing TINT_TYPE values
 */
export function buildTintTypeLookup(registry) {
  const maxId = 4096; // Match FastMesher's assumption
  const lookup = new Uint8Array(maxId);
  
  for (let id = 0; id < maxId; id++) {
    const info = registry.getBlockInfo(id);
    if (info && info.name) {
      lookup[id] = getBlockTintType(info.name);
    }
  }
  
  return lookup;
}

/**
 * Check if a block needs grass_block_top texture tinting (top face of grass)
 * The side texture (grass_block_side_overlay) is tinted, but not the dirt part
 * @param {string} blockName 
 * @returns {boolean}
 */
export function needsGrassTopTint(blockName) {
  return blockName === 'minecraft:grass_block';
}

/**
 * Get which faces should be tinted for grass_block
 * Top face: fully tinted
 * Side faces: overlay layer is tinted
 * Bottom face: not tinted (dirt)
 * @param {string} blockName 
 * @param {number} faceIndex - 0=up, 1=down, 2=north, 3=south, 4=east, 5=west
 * @returns {boolean}
 */
export function shouldTintGrassBlockFace(blockName, faceIndex) {
  if (blockName !== 'minecraft:grass_block') return false;
  // Top face (0) and side faces (2-5) are tinted, bottom (1) is not
  return faceIndex !== 1;
}

export default {
  TINT_TYPE,
  FIXED_TINT_COLORS,
  DEFAULT_BIOME_UV,
  getBlockTintType,
  getBlockTintTypeByShortName,
  buildTintTypeLookup,
};

