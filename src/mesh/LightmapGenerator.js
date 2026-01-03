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

// Minecraft's brightness curve - converts light level (0-1) to brightness (0-1)
// This creates the exponential falloff that makes low light levels much darker
function getBrightness(level) {
  // level is normalized 0-1 (light level / 15)
  // Original Minecraft: level / (4.0 - 3.0 * level)
  // This is very aggressive - level 0.5 gives only 0.2 brightness
  // We use a softer curve for outdoor daytime rendering
  const minecraftCurve = level / (4.0 - 3.0 * level);
  // Blend with linear for softer shadows in outdoor lighting
  // This gives: level 0.5 → ~0.35 instead of 0.2
  return minecraftCurve * 0.7 + level * 0.3;
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
 */
export const DAYTIME_PARAMS = {
  ambientLightFactor: 0.0,     // 0 for overworld, 1 for nether/end
  skyFactor: 1.0,              // Sky light strength
  blockFactor: 1.0,            // Block light strength
  nightVisionFactor: 0.0,      // Night vision effect (0-1)
  darknessScale: 0.0,          // Darkness effect
  darkenWorldFactor: 0.0,      // World darkening (rain, etc.)
  brightnessFactor: 0.0,       // Brightness gamma setting
  skyLightColor: { r: 1.0, g: 1.0, b: 1.0 },  // Daylight color
  ambientColor: { r: 0.1, g: 0.1, b: 0.1 },   // Ambient color
  minimumBrightness: 0.15,     // Minimum ambient floor for outdoor lighting
};

/**
 * Lightmap parameters for nighttime
 */
export const NIGHTTIME_PARAMS = {
  ...DAYTIME_PARAMS,
  skyFactor: 0.2,              // Moonlight is dimmer
  skyLightColor: { r: 0.6, g: 0.7, b: 1.0 },  // Moonlight is blueish
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
    minimumBrightness = 0.1,  // Default minimum ambient floor
  } = params;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Block light = X coordinate, Sky light = Y coordinate
      const blockLevel = x / 15;
      const skyLevel = y / 15;
      
      // Get brightness from Minecraft's curve
      const blockBrightness = getBrightness(blockLevel) * blockFactor;
      const skyBrightness = getBrightness(skyLevel) * skyFactor;
      
      // Block light has warm yellowish color (from lightmap.fsh)
      // "cubic nonsense, dips to yellowish in the middle, white when fully saturated"
      let r = blockBrightness;
      let g = blockBrightness * ((blockBrightness * 0.6 + 0.4) * 0.6 + 0.4);
      let b = blockBrightness * (blockBrightness * blockBrightness * 0.6 + 0.4);
      
      // Mix with ambient color
      r = r * (1 - ambientLightFactor) + ambientColor.r * ambientLightFactor;
      g = g * (1 - ambientLightFactor) + ambientColor.g * ambientLightFactor;
      b = b * (1 - ambientLightFactor) + ambientColor.b * ambientLightFactor;
      
      // Add sky light contribution
      r += skyLightColor.r * skyBrightness;
      g += skyLightColor.g * skyBrightness;
      b += skyLightColor.b * skyBrightness;
      
      // Apply minimum brightness floor for outdoor areas with sky light
      // This ensures shaded outdoor areas don't become pitch black
      if (skyLevel > 0 && minimumBrightness > 0) {
        const minFloor = minimumBrightness * skyLevel;  // Scale with sky level
        r = Math.max(r, minFloor);
        g = Math.max(g, minFloor);
        b = Math.max(b, minFloor);
      }
      
      // Mix with slight gray (from shader: mix(color, vec3(0.75), 0.04))
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
 * Matches Minecraft's day/night lighting cycle
 * 
 * @param {number} timeOfDay - 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
 * @returns {Object} Lightmap parameters for generateLightmap()
 */
export function getLightmapParamsForTime(timeOfDay) {
  // Calculate sun height (-1 to 1, positive = day)
  // timeOfDay: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
  const sunAngle = (timeOfDay - 0.25) * Math.PI * 2;
  const sunHeight = Math.sin(sunAngle);
  
  // Interpolate skyFactor: 1.0 at noon, ~0.2 at midnight
  // Using max(0, sunHeight) means we transition at sunrise/sunset
  const dayBlend = Math.max(0, sunHeight);
  const skyFactor = 0.2 + 0.8 * dayBlend;
  
  // Interpolate sky light color: white (day) -> blueish (night)
  // Minecraft's moonlight has a cool blue tint
  const skyLightColor = {
    r: 0.6 + 0.4 * dayBlend,  // 0.6 at night, 1.0 at day
    g: 0.7 + 0.3 * dayBlend,  // 0.7 at night, 1.0 at day
    b: 1.0,                   // Always 1.0 (blue stays constant)
  };
  
  // Slightly reduce minimum brightness at night
  const minimumBrightness = 0.05 + 0.10 * dayBlend; // 0.05 at night, 0.15 at day
  
  return {
    ...DAYTIME_PARAMS,
    skyFactor,
    skyLightColor,
    minimumBrightness,
  };
}

export default generateLightmap;

