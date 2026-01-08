/**
 * Biome Colors Data - Extracted from Minecraft 1.21.11
 * 
 * Each biome has:
 * - skyColor: Hex color for the sky dome
 * - fogColor: Hex color for distance fog (optional, defaults to dimension default)
 * - waterFogColor: Hex color for underwater fog (optional)
 * - waterColor: Hex color for water surface (optional)
 * 
 * Colors are from minecraft/data/worldgen/biome/*.json and dimension_type/*.json
 */

// Parse hex color to RGB object (0-1 range)
export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 0.5, g: 0.5, b: 0.5 };
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255,
  };
}

// Parse hex color to THREE.Color compatible hex number
export function hexToNumber(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

// Dimension default colors (used when biome doesn't specify)
export const DIMENSION_DEFAULTS = {
  overworld: {
    skyColor: '#78a7ff',
    fogColor: '#c0d8ff',
  },
  the_nether: {
    skyColor: '#000000',  // No sky visible
    fogColor: '#330303',  // Reddish fog
  },
  the_end: {
    skyColor: '#000000',  // No sky (cube map instead)
    fogColor: '#181318',  // Dark purplish fog
  },
};

// Biome-specific colors
// Key is the biome ID (without minecraft: prefix)
export const BIOME_COLORS = {
  // === OVERWORLD BIOMES ===
  
  // Plains variants
  'plains': {
    skyColor: '#78a7ff',
  },
  'sunflower_plains': {
    skyColor: '#78a7ff',
  },
  'meadow': {
    skyColor: '#7ba4ff',
  },
  
  // Forest biomes
  'forest': {
    skyColor: '#79a6ff',
  },
  'flower_forest': {
    skyColor: '#79a6ff',
  },
  'birch_forest': {
    skyColor: '#7aa5ff',
  },
  'old_growth_birch_forest': {
    skyColor: '#7aa5ff',
  },
  'dark_forest': {
    skyColor: '#79a6ff',
  },
  'cherry_grove': {
    skyColor: '#7ba4ff',
    waterFogColor: '#5db7ef',
  },
  'pale_garden': {
    skyColor: '#b9b9b9',  // Gray/desaturated
    fogColor: '#817770',
    waterFogColor: '#556980',
  },
  
  // Taiga biomes
  'taiga': {
    skyColor: '#7da3ff',
  },
  'snowy_taiga': {
    skyColor: '#839eff',
  },
  'old_growth_pine_taiga': {
    skyColor: '#7ca3ff',
  },
  'old_growth_spruce_taiga': {
    skyColor: '#7da3ff',
  },
  
  // Jungle biomes
  'jungle': {
    skyColor: '#77a8ff',
  },
  'bamboo_jungle': {
    skyColor: '#77a8ff',
  },
  'sparse_jungle': {
    skyColor: '#77a8ff',
  },
  
  // Swamp biomes
  'swamp': {
    skyColor: '#78a7ff',
    waterFogColor: '#232317',
  },
  'mangrove_swamp': {
    skyColor: '#78a7ff',
    fogColor: '#c0d8ff',
    waterFogColor: '#4d7a60',
  },
  
  // Desert/Badlands
  'desert': {
    skyColor: '#6eb1ff',  // Brighter, more cyan
  },
  'badlands': {
    skyColor: '#6eb1ff',
  },
  'eroded_badlands': {
    skyColor: '#6eb1ff',
  },
  'wooded_badlands': {
    skyColor: '#6eb1ff',
  },
  
  // Savanna biomes
  'savanna': {
    skyColor: '#6eb1ff',
  },
  'savanna_plateau': {
    skyColor: '#6eb1ff',
  },
  'windswept_savanna': {
    skyColor: '#6eb1ff',
  },
  
  // Snowy biomes
  'snowy_plains': {
    skyColor: '#7fa1ff',
  },
  'ice_spikes': {
    skyColor: '#7fa1ff',
  },
  'snowy_beach': {
    skyColor: '#7fa1ff',
  },
  'snowy_slopes': {
    skyColor: '#829fff',
  },
  'grove': {
    skyColor: '#81a0ff',
  },
  
  // Mountain biomes
  'windswept_hills': {
    skyColor: '#7da2ff',
  },
  'windswept_gravelly_hills': {
    skyColor: '#7da2ff',
  },
  'windswept_forest': {
    skyColor: '#7da2ff',
  },
  'frozen_peaks': {
    skyColor: '#859dff',  // More purple/cold
  },
  'jagged_peaks': {
    skyColor: '#859dff',
  },
  'stony_peaks': {
    skyColor: '#76a8ff',
  },
  
  // Beach/Shore biomes
  'beach': {
    skyColor: '#78a7ff',
  },
  'stony_shore': {
    skyColor: '#7da2ff',
  },
  
  // River biomes
  'river': {
    skyColor: '#7ba4ff',
  },
  'frozen_river': {
    skyColor: '#7fa1ff',
  },
  
  // Ocean biomes
  'ocean': {
    skyColor: '#7ba4ff',
  },
  'deep_ocean': {
    skyColor: '#7ba4ff',
  },
  'cold_ocean': {
    skyColor: '#7ba4ff',
  },
  'deep_cold_ocean': {
    skyColor: '#7ba4ff',
  },
  'frozen_ocean': {
    skyColor: '#7fa1ff',
  },
  'deep_frozen_ocean': {
    skyColor: '#7ba4ff',
  },
  'lukewarm_ocean': {
    skyColor: '#7ba4ff',
    waterFogColor: '#041633',
  },
  'deep_lukewarm_ocean': {
    skyColor: '#7ba4ff',
    waterFogColor: '#041633',
  },
  'warm_ocean': {
    skyColor: '#7ba4ff',
    waterFogColor: '#041f33',
  },
  
  // Cave biomes
  'lush_caves': {
    skyColor: '#7ba4ff',
  },
  'dripstone_caves': {
    skyColor: '#78a7ff',
  },
  'deep_dark': {
    skyColor: '#78a7ff',
  },
  
  // Mushroom biome
  'mushroom_fields': {
    skyColor: '#77a8ff',
  },
  
  // Void
  'the_void': {
    skyColor: '#7ba4ff',
  },
  
  // === NETHER BIOMES ===
  // Nether biomes have fog_color instead of sky_color
  
  'nether_wastes': {
    fogColor: '#330808',  // Dark red
  },
  'soul_sand_valley': {
    fogColor: '#1b4745',  // Teal/cyan
  },
  'crimson_forest': {
    fogColor: '#330303',  // Dark crimson
  },
  'warped_forest': {
    fogColor: '#1a051a',  // Dark purple/magenta
  },
  'basalt_deltas': {
    fogColor: '#685f70',  // Gray/purple
  },
  
  // === END BIOMES ===
  // End biomes use dimension defaults (no specific colors in biome files)
  
  'the_end': {},
  'end_barrens': {},
  'end_highlands': {},
  'end_midlands': {},
  'small_end_islands': {},
};

/**
 * Get colors for a specific biome
 * @param {string} biomeId - Biome ID (e.g., 'plains', 'desert', 'minecraft:plains')
 * @param {string} dimension - Dimension ('overworld', 'the_nether', 'the_end')
 * @returns {Object} Color configuration with skyColor, fogColor as RGB objects
 */
export function getBiomeColors(biomeId, dimension = 'overworld') {
  // Strip minecraft: prefix if present
  const cleanId = biomeId.replace('minecraft:', '');
  
  // Get dimension defaults
  const dimDefaults = DIMENSION_DEFAULTS[dimension] || DIMENSION_DEFAULTS.overworld;
  
  // Get biome-specific colors (if any)
  const biomeColors = BIOME_COLORS[cleanId] || {};
  
  // Merge with defaults
  const skyColorHex = biomeColors.skyColor || dimDefaults.skyColor;
  const fogColorHex = biomeColors.fogColor || dimDefaults.fogColor;
  
  return {
    skyColor: hexToRgb(skyColorHex),
    skyColorHex,
    fogColor: hexToRgb(fogColorHex),
    fogColorHex,
    waterFogColor: biomeColors.waterFogColor ? hexToRgb(biomeColors.waterFogColor) : null,
    waterColor: biomeColors.waterColor ? hexToRgb(biomeColors.waterColor) : null,
  };
}

/**
 * Get a list of all biome IDs
 * @returns {string[]} Array of biome IDs
 */
export function getAllBiomeIds() {
  return Object.keys(BIOME_COLORS);
}

/**
 * Get biomes grouped by category for UI display
 * @returns {Object} Biomes grouped by category
 */
export function getBiomesByCategory() {
  return {
    'Plains & Meadows': ['plains', 'sunflower_plains', 'meadow'],
    'Forests': ['forest', 'flower_forest', 'birch_forest', 'old_growth_birch_forest', 'dark_forest', 'cherry_grove', 'pale_garden'],
    'Taiga': ['taiga', 'snowy_taiga', 'old_growth_pine_taiga', 'old_growth_spruce_taiga'],
    'Jungles': ['jungle', 'bamboo_jungle', 'sparse_jungle'],
    'Swamps': ['swamp', 'mangrove_swamp'],
    'Desert & Badlands': ['desert', 'badlands', 'eroded_badlands', 'wooded_badlands'],
    'Savanna': ['savanna', 'savanna_plateau', 'windswept_savanna'],
    'Snowy': ['snowy_plains', 'ice_spikes', 'snowy_beach', 'snowy_slopes', 'grove'],
    'Mountains': ['windswept_hills', 'windswept_gravelly_hills', 'windswept_forest', 'frozen_peaks', 'jagged_peaks', 'stony_peaks'],
    'Beach & Shore': ['beach', 'stony_shore'],
    'Rivers': ['river', 'frozen_river'],
    'Oceans': ['ocean', 'deep_ocean', 'cold_ocean', 'deep_cold_ocean', 'frozen_ocean', 'deep_frozen_ocean', 'lukewarm_ocean', 'deep_lukewarm_ocean', 'warm_ocean'],
    'Caves': ['lush_caves', 'dripstone_caves', 'deep_dark'],
    'Special': ['mushroom_fields', 'the_void'],
    'Nether': ['nether_wastes', 'soul_sand_valley', 'crimson_forest', 'warped_forest', 'basalt_deltas'],
    'End': ['the_end', 'end_barrens', 'end_highlands', 'end_midlands', 'small_end_islands'],
  };
}

export default BIOME_COLORS;

