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
  brightnessFactor: 0.5,       // Brightness gamma setting (0-1) - 0.5 matches typical player settings
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
      
      // Mix with slight gray to prevent pure black (from shader: mix(color, vec3(0.75), 0.04))
      r = r * 0.96 + 0.75 * 0.04;
      g = g * 0.96 + 0.75 * 0.04;
      b = b * 0.96 + 0.75 * 0.04;
      
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
      
      // Final mix with slight gray (from shader)
      r = r * 0.96 + 0.75 * 0.04;
      g = g * 0.96 + 0.75 * 0.04;
      b = b * 0.96 + 0.75 * 0.04;
      
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
 * Get lightmap parameters interpolated for a specific time of day
 * Matches Minecraft's day/night lighting cycle from day.json
 * 
 * @param {number} timeOfDay - 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
 * @returns {Object} Lightmap parameters for generateLightmap()
 */
export function getLightmapParamsForTime(timeOfDay) {
  // Calculate sun height (-1 to 1, positive = day)
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
  };
}

export default generateLightmap;

