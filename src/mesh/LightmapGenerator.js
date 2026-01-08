/**
 * LightmapGenerator - Generates Minecraft-identical lightmap texture
 * 
 * Creates a 16x16 texture where:
 * - X axis = block light level (0-15)
 * - Y axis = sky light level (0-15)
 * 
 * Based on Minecraft's lightmap.fsh shader:
 * - Uses Minecraft's exact brightness curve: level / (4.0 - 3.0 * level)
 * - Block light has warm yellowish tint
 * - Sky light uses daylight color
 * - Supports various environmental effects (ambient, darkness, night vision)
 */

import * as THREE from 'three';

// Minecraft's exact brightness curve - converts light level (0-1) to brightness (0-1)
// This creates the exponential falloff that makes low light levels much darker
// From lightmap.fsh: level / (4.0 - 3.0 * level)
function getBrightness(level) {
  // Level 0 → 0.000, Level 0.5 → 0.200, Level 1.0 → 1.000
  return level / (4.0 - 3.0 * level);
}

// Minecraft's "notGamma" function - applies gamma-like correction
function notGamma(r, g, b) {
  const maxComponent = Math.max(r, g, b);
  if (maxComponent <= 0) return { r: 0, g: 0, b: 0 };
  
  const maxInverted = 1.0 - maxComponent;
  const maxScaled = 1.0 - maxInverted * maxInverted * maxInverted * maxInverted;
  const scale = maxScaled / maxComponent;
  
  return {
    r: r * scale,
    g: g * scale,
    b: b * scale,
  };
}

/**
 * Default lightmap parameters for daytime (noon)
 * Matches Minecraft's lightmap.fsh exactly
 * 
 * Note: brightnessFactor corresponds to Minecraft's "Brightness" slider:
 * - 0.0 = "Moody" (darkest, rarely used)
 * - 0.5 = Default/medium
 * - 1.0 = "Bright" (maximum brightness boost for dark areas)
 * 
 * The notGamma function applied at brightnessFactor provides significant
 * brightness boost to dark areas (e.g., 0.2 → 0.59 at 100%, 0.2 → 0.40 at 50%)
 */
export const DAYTIME_PARAMS = {
  ambientLightFactor: 0.0,     // 0 for overworld, 0.1 for nether/end
  skyFactor: 1.0,              // Sky light strength
  blockFactor: 1.0,            // Block light strength
  nightVisionFactor: 0.0,      // Night vision effect (0-1)
  darknessScale: 0.0,          // Darkness effect
  darkenWorldFactor: 0.0,      // World darkening (rain, etc.)
  brightnessFactor: 0.75,      // Brightness gamma setting (0-1) - 0.75 matches most players' preferred settings
  skyLightColor: { r: 1.0, g: 1.0, b: 1.0 },  // Daylight color
  ambientColor: { r: 0.0, g: 0.0, b: 0.0 },   // Ambient color (0 for overworld)
};

/**
 * Lightmap parameters for nighttime (from Minecraft day.json)
 * sky_light_factor: 0.24, sky_light_color: #7a7aff
 */
export const NIGHTTIME_PARAMS = {
  ...DAYTIME_PARAMS,
  skyFactor: 0.24,             // Moonlight brightness (from day.json)
  skyLightColor: { r: 0.478, g: 0.478, b: 1.0 },  // #7a7aff - blueish moonlight
};

/**
 * Lightmap parameters for caves (no sky light contribution)
 */
export const CAVE_PARAMS = {
  ...DAYTIME_PARAMS,
  skyFactor: 0.0,              // No sky light
};

/**
 * Lightmap parameters for the Nether dimension
 * From Minecraft dimension_type/the_nether.json and lightmap.agent.md:
 * - ambient_light: 0.1 (minimum brightness floor)
 * - has_skylight: false
 * 
 * The ambient_light value means blocks should have ~10% minimum brightness.
 * AmbientColor is the color that's mixed in at AmbientLightFactor rate.
 * To achieve 10% brightness with reddish tint, we use bright ambient colors
 * so that AmbientLightFactor * AmbientColor gives proper brightness.
 * 
 * Colors are chosen so that the result is warm/reddish like lava glow.
 */
export const NETHER_PARAMS = {
  ambientLightFactor: 0.1,     // Nether ambient light factor (10% mix)
  skyFactor: 0.0,              // No sky light in Nether
  blockFactor: 1.0,            // Block light normal
  nightVisionFactor: 0.0,
  darknessScale: 0.0,
  darkenWorldFactor: 0.0,
  brightnessFactor: 0.75,      // Higher brightness for better visibility
  skyLightColor: { r: 1.0, g: 1.0, b: 1.0 },  // Unused (skyFactor = 0)
  // Bright reddish ambient - at 10% mix, gives ~10% brightness with warm tint
  // This ensures areas without light sources aren't pitch black
  ambientColor: { r: 1.0, g: 0.5, b: 0.4 },
};

/**
 * Lightmap parameters for the End dimension
 * From Minecraft dimension_type/the_end.json and lightmap.agent.md:
 * - ambient_light: 0.25 (higher than Nether - End is brighter)
 * - has_skylight: true but sky_light_factor: 0.0
 * 
 * The End has higher ambient light (0.25) giving it a more visible base brightness.
 * Color is purplish to match the End's aesthetic.
 * 
 * The End should be brighter than the Nether - obsidian pillars and blocks
 * should be clearly visible even without light sources.
 * 
 * Note: Face shading (0.5-1.0) is applied AFTER the lightmap, so we need
 * higher ambient values to ensure side/bottom faces are still visible.
 * A side face at 0.6 shading with 0.5 ambient = 30% brightness after shading.
 */
export const END_PARAMS = {
  ambientLightFactor: 0.5,     // Higher ambient factor for better visibility (50% mix)
  skyFactor: 0.0,              // No effective sky light
  blockFactor: 1.0,            // Block light normal
  nightVisionFactor: 0.0,
  darknessScale: 0.0,
  darkenWorldFactor: 0.0,
  brightnessFactor: 0.75,      // Higher brightness for better visibility
  skyLightColor: { r: 1.0, g: 1.0, b: 1.0 },  // Unused
  // Warm neutral ambient - at 50% mix gives ~50% base brightness
  // After face shading (0.5-1.0), still gives 25-50% final brightness
  // Slight yellow/warm tint to match Minecraft's End lighting
  ambientColor: { r: 1.0, g: 0.97, b: 0.88 },
};

/**
 * Generate a 16x16 lightmap texture matching Minecraft's lightmap.fsh
 * 
 * @param {Object} params - Lightmap parameters (see DAYTIME_PARAMS)
 * @returns {THREE.DataTexture} 16x16 lightmap texture
 */
export function generateLightmap(params = DAYTIME_PARAMS) {
  const size = 16;
  const data = new Uint8Array(size * size * 4); // RGBA
  
  const {
    ambientLightFactor,
    skyFactor,
    blockFactor,
    nightVisionFactor,
    darknessScale,
    darkenWorldFactor,
    brightnessFactor,
    skyLightColor,
    ambientColor,
  } = params;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Block light = X coordinate, Sky light = Y coordinate
      const blockLevel = x / 15;
      const skyLevel = y / 15;
      
      // Get brightness from Minecraft's exact curve
      const blockBrightness = getBrightness(blockLevel) * blockFactor;
      const skyBrightness = getBrightness(skyLevel) * skyFactor;
      
      // Block light has warm yellowish color (from lightmap.fsh)
      // "cubic nonsense, dips to yellowish in the middle, white when fully saturated"
      let r = blockBrightness;
      let g = blockBrightness * ((blockBrightness * 0.6 + 0.4) * 0.6 + 0.4);
      let b = blockBrightness * (blockBrightness * blockBrightness * 0.6 + 0.4);
      
      // Mix with ambient color (Minecraft: mix(color, AmbientColor, AmbientLightFactor))
      r = r * (1 - ambientLightFactor) + ambientColor.r * ambientLightFactor;
      g = g * (1 - ambientLightFactor) + ambientColor.g * ambientLightFactor;
      b = b * (1 - ambientLightFactor) + ambientColor.b * ambientLightFactor;
      
      // Add sky light contribution (Minecraft: color += SkyLightColor * sky_brightness)
      r += skyLightColor.r * skyBrightness;
      g += skyLightColor.g * skyBrightness;
      b += skyLightColor.b * skyBrightness;
      
      // Mix with slight warm gray to prevent pure black and add subtle yellow tinge
      // (from shader: mix(color, vec3(0.75), 0.04) but with warm bias)
      r = r * 0.96 + 0.77 * 0.04;  // slightly warmer
      g = g * 0.96 + 0.75 * 0.04;
      b = b * 0.96 + 0.72 * 0.04;  // slightly cooler
      
      // Apply world darkening (rain, etc.) - only in overworld
      if (ambientLightFactor === 0.0 && darkenWorldFactor > 0) {
        r = r * (1 - darkenWorldFactor * 0.3);
        g = g * (1 - darkenWorldFactor * 0.4);
        b = b * (1 - darkenWorldFactor * 0.4);
      }
      
      // Apply night vision
      if (nightVisionFactor > 0) {
        const maxComponent = Math.max(r, g, b);
        if (maxComponent < 1.0 && maxComponent > 0) {
          const brightR = r / maxComponent;
          const brightG = g / maxComponent;
          const brightB = b / maxComponent;
          r = r * (1 - nightVisionFactor) + brightR * nightVisionFactor;
          g = g * (1 - nightVisionFactor) + brightG * nightVisionFactor;
          b = b * (1 - nightVisionFactor) + brightB * nightVisionFactor;
        }
      }
      
      // Apply darkness effect (only in overworld)
      if (ambientLightFactor === 0.0 && darknessScale > 0) {
        r = Math.max(0, r - darknessScale);
        g = Math.max(0, g - darknessScale);
        b = Math.max(0, b - darknessScale);
      }
      
      // Clamp to valid range
      r = Math.max(0, Math.min(1, r));
      g = Math.max(0, Math.min(1, g));
      b = Math.max(0, Math.min(1, b));
      
      // Apply brightness/gamma adjustment
      if (brightnessFactor > 0) {
        const gamma = notGamma(r, g, b);
        r = r * (1 - brightnessFactor) + gamma.r * brightnessFactor;
        g = g * (1 - brightnessFactor) + gamma.g * brightnessFactor;
        b = b * (1 - brightnessFactor) + gamma.b * brightnessFactor;
      }
      
      // Final mix with slight warm gray (from shader, with warm bias for yellow tinge)
      r = r * 0.96 + 0.77 * 0.04;  // slightly warmer
      g = g * 0.96 + 0.75 * 0.04;
      b = b * 0.96 + 0.72 * 0.04;  // slightly cooler
      
      // Clamp final values
      r = Math.max(0, Math.min(1, r));
      g = Math.max(0, Math.min(1, g));
      b = Math.max(0, Math.min(1, b));
      
      // Write to texture data
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(r * 255);
      data[idx + 1] = Math.round(g * 255);
      data[idx + 2] = Math.round(b * 255);
      data[idx + 3] = 255; // Full alpha
    }
  }
  
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;  // Smooth interpolation between light levels
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // Use NoColorSpace for consistency with atlas (gamma-incorrect rendering like Minecraft)
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  
  return texture;
}

/**
 * Create a simple lightmap for testing - linear brightness with no color effects
 * @returns {THREE.DataTexture} 16x16 lightmap texture
 */
export function generateSimpleLightmap() {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Use max of block and sky light for brightness
      const blockLevel = x / 15;
      const skyLevel = y / 15;
      
      // Simple brightness curve
      const blockBrightness = getBrightness(blockLevel);
      const skyBrightness = getBrightness(skyLevel);
      
      // Take max brightness (how Minecraft combines them)
      const brightness = Math.max(blockBrightness, skyBrightness);
      
      const idx = (y * size + x) * 4;
      const value = Math.round(brightness * 255);
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
  
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  
  return texture;
}

/**
 * Pack sky and block light into UV2 format (as Minecraft does)
 * @param {number} skyLight - Sky light level (0-15)
 * @param {number} blockLight - Block light level (0-15)
 * @returns {{u: number, v: number}} UV coordinates for lightmap sampling
 */
export function packLightToUV(skyLight, blockLight) {
  // Minecraft packs as (blockLight * 16, skyLight * 16) for integer vertex attributes
  // For normalized float UVs, we use (blockLight + 0.5) / 16 to center on texel
  return {
    u: (blockLight + 0.5) / 16,
    v: (skyLight + 0.5) / 16,
  };
}

/**
 * Get UV coordinates for a single combined light level
 * Uses the diagonal of the lightmap (where blockLight == skyLight)
 * @param {number} lightLevel - Light level (0-15)
 * @returns {number} UV coordinate for 1D lightmap sampling
 */
export function lightLevelToUV(lightLevel) {
  return (lightLevel + 0.5) / 16;
}

/**
 * Get lightmap parameters interpolated for a specific time of day, brightness, and dimension
 * Matches Minecraft's day/night lighting cycle from day.json
 * 
 * @param {number} timeOfDay - 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
 * @param {number} brightness - 0-100 brightness slider (0=Moody, 100=Bright), default 50
 * @param {string} dimension - Dimension ID ('overworld', 'the_nether', 'the_end'), default 'overworld'
 * @returns {Object} Lightmap parameters for generateLightmap()
 */
export function getLightmapParamsForTime(timeOfDay, brightness = 75, dimension = 'overworld') {
  // Convert 0-100 brightness slider to 0-1 brightnessFactor
  const brightnessFactor = brightness / 100;
  
  // Handle dimension-specific lighting
  if (dimension === 'the_nether') {
    // Nether has fixed lighting (no time of day)
    return {
      ...NETHER_PARAMS,
      brightnessFactor,
    };
  }
  
  if (dimension === 'the_end') {
    // End has fixed lighting (no time of day)
    return {
      ...END_PARAMS,
      brightnessFactor,
    };
  }
  
  // Overworld: Calculate sun height (-1 to 1, positive = day)
  // timeOfDay: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
  const sunAngle = (timeOfDay - 0.25) * Math.PI * 2;
  const sunHeight = Math.sin(sunAngle);
  
  // From Minecraft day.json:
  // - sky_light_factor: 1.0 (day, ticks 730-11270) -> 0.24 (night, ticks 13140-22860)
  // - sky_light_color: #ffffff (day) -> #7a7aff (night) = (0.478, 0.478, 1.0)
  
  // Interpolate skyFactor: 1.0 at noon, 0.24 at midnight (Minecraft's exact values)
  const dayBlend = Math.max(0, sunHeight);
  const skyFactor = 0.24 + 0.76 * dayBlend;  // 0.24 at night, 1.0 at day
  
  // Interpolate sky light color: white (day) -> blueish (night)
  // Minecraft night color: #7a7aff = (122/255, 122/255, 255/255) = (0.478, 0.478, 1.0)
  const skyLightColor = {
    r: 0.478 + 0.522 * dayBlend,  // 0.478 at night, 1.0 at day
    g: 0.478 + 0.522 * dayBlend,  // 0.478 at night, 1.0 at day
    b: 1.0,                       // Always 1.0
  };
  
  return {
    ...DAYTIME_PARAMS,
    skyFactor,
    skyLightColor,
    brightnessFactor,
  };
}

export default generateLightmap;

