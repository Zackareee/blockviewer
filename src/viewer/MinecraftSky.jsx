/**
 * MinecraftSky - Accurate Minecraft sky rendering
 * 
 * Components:
 * 1. Sky Dome - Gradient from horizon to zenith (biome-based color)
 * 2. Sun - Textured quad that rotates with time
 * 3. Clouds - Drifting cloud layer at fixed altitude
 * 
 * Based on Minecraft source:
 * - assets/minecraft/textures/environment/celestial/sun.png
 * - assets/minecraft/textures/environment/clouds.png
 * - data/minecraft/timeline/day.json (sun_angle, sky_color tracks)
 * - shaders/core/sky.vsh/fsh
 * - shaders/core/rendertype_clouds.fsh
 */

import { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Paths to Minecraft textures in public folder
// Using original Minecraft textures for accurate rendering
const SUN_TEXTURE_PATH = '/textures/sun_original.png';
const MOON_TEXTURE_PATH = '/textures/moon_full.png';
const CLOUDS_TEXTURE_PATH = '/textures/clouds_original.png';

// Minecraft sky constants
const SKY_RADIUS = 1000; // Size of sky dome
// Minecraft renders sun/moon at distance 100 with size 30
// Scaled up proportionally: 900/100 = 9x, so size = 30*9 = 270
const SUN_DISTANCE = 900; // Distance from camera to sun
const SUN_SIZE = 270; // Size of sun quad (matches Minecraft's angular size)
const MOON_DISTANCE = 900; // Distance from camera to moon (same as sun)
const MOON_SIZE = 270; // Size of moon quad (same size as sun in Minecraft)

// Minecraft cloud constants (from rendertype_clouds.vsh)
const CLOUD_HEIGHT = 192; // Y level for clouds (Minecraft default)
const CLOUD_CELL_SIZE = 12; // Each cloud "pixel" = 12 blocks in world
const CLOUD_SPEED = 0.4; // Blocks per second cloud drift (east direction)

// Cloud face colors from Minecraft shader (rendertype_clouds.vsh faceColors array)
const CLOUD_FACE_COLORS = {
  bottom: [0.7, 0.7, 0.7],   // Darker underside
  top: [1.0, 1.0, 1.0],     // Bright top
  north: [0.8, 0.8, 0.8],   // Side shading
  south: [0.8, 0.8, 0.8],
  west: [0.9, 0.9, 0.9],
  east: [0.9, 0.9, 0.9],
};

// Minecraft day cycle constants (from data/minecraft/timeline/day.json)
// Tick 0 = sunrise (6:00 AM), Tick 6000 = noon, Tick 12000 = sunset, Tick 18000 = midnight
const TICKS_PER_DAY = 24000;

// Base biome sky color (plains biome)
const BASE_SKY_COLOR = new THREE.Color('#78a7ff');
const BASE_HORIZON_COLOR = new THREE.Color('#c8d8ff');

/**
 * Dimension configurations for sky and fog rendering
 * Based on data/minecraft/dimension_type/*.json and worldgen/biome/*.json
 * 
 * Each dimension has:
 * - skybox: 'normal' (sun/moon/stars/clouds), 'end' (cube skybox), or 'none' (no sky)
 * - hasCeiling: whether the dimension has a ceiling (affects sky visibility)
 * - fogStart/fogEnd: fog distance in blocks (Nether has very short fog)
 * - fogColor: default fog color (can be overridden by biome)
 * - skyColor: base sky color (only used if skybox === 'normal')
 * - ambientLight: base ambient light level
 */
export const DIMENSION_CONFIG = {
  overworld: {
    skybox: 'normal',
    hasCeiling: false,
    fogStart: null,  // Uses render distance-based fog
    fogEnd: null,
    fogColor: '#c0d8ff',
    skyColor: '#78a7ff',
    horizonColor: '#c8d8ff',
    ambientLight: 0.0,
    hasTimeOfDay: true,
  },
  the_nether: {
    skybox: 'none',
    hasCeiling: true,
    fogStart: 10,     // Nether has very short fog
    fogEnd: 96,
    fogColor: '#330808',  // Nether Wastes default (dark red)
    skyColor: '#330808',  // Used for sky dome if visible
    horizonColor: '#330808',
    ambientLight: 0.1,
    hasTimeOfDay: false,  // Fixed time (always "dark")
    // Biome-specific fog colors for future use
    biomeFogColors: {
      'nether_wastes': '#330808',
      'crimson_forest': '#330303',
      'warped_forest': '#1a051a',
      'soul_sand_valley': '#1b4745',
      'basalt_deltas': '#685f70',
    },
  },
  the_end: {
    skybox: 'end',
    hasCeiling: false,
    fogStart: null,
    fogEnd: null,
    fogColor: '#181318',  // Dark purple-black
    skyColor: '#000000',
    horizonColor: '#181318',
    ambientLight: 0.25,
    hasTimeOfDay: false,  // Fixed time
  },
};

// Default to overworld for unknown dimensions
export function getDimensionConfig(dimensionId) {
  return DIMENSION_CONFIG[dimensionId] || DIMENSION_CONFIG.overworld;
}

/**
 * Convert timeOfDay (0-1) to Minecraft ticks (0-24000)
 * timeOfDay: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
 * Minecraft: tick 0 = sunrise, 6000 = noon, 12000 = sunset, 18000 = midnight
 */
function timeOfDayToTicks(timeOfDay) {
  // Convert: our 0.25 (sunrise) should map to tick 0
  // Offset by -0.25 and wrap, then scale to 24000
  const adjusted = ((timeOfDay - 0.25) + 1) % 1;
  return adjusted * TICKS_PER_DAY;
}

/**
 * Interpolate between keyframes based on tick value
 * Keyframes format: [{ tick, value }, ...]
 */
function interpolateKeyframes(ticks, keyframes) {
  // Handle wrapping (find the two keyframes we're between)
  let prevKf = keyframes[keyframes.length - 1];
  let nextKf = keyframes[0];
  
  for (let i = 0; i < keyframes.length; i++) {
    if (ticks <= keyframes[i].tick) {
      nextKf = keyframes[i];
      prevKf = i > 0 ? keyframes[i - 1] : keyframes[keyframes.length - 1];
      break;
    }
    prevKf = keyframes[i];
    nextKf = keyframes[(i + 1) % keyframes.length];
  }
  
  // Calculate interpolation factor
  let range = nextKf.tick - prevKf.tick;
  if (range < 0) range += TICKS_PER_DAY; // Handle wrap around midnight
  
  let progress = ticks - prevKf.tick;
  if (progress < 0) progress += TICKS_PER_DAY;
  
  const t = range > 0 ? progress / range : 0;
  
  return { prevValue: prevKf.value, nextValue: nextKf.value, t };
}

/**
 * Parse hex color with alpha (#RRGGBBAA) to { r, g, b, a }
 */
function parseHexColorWithAlpha(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const a = hex.length >= 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
  return { r, g, b, a };
}

/**
 * Get sunrise/sunset glow color based on time (from day.json sunrise_sunset_color track)
 * Returns { color: THREE.Color, alpha: number }
 */
function getSunriseSunsetColor(ticks) {
  // Keyframes from day.json minecraft:visual/sunrise_sunset_color
  // Format: #RRGGBBAA where AA is alpha
  const keyframes = [
    { tick: 71, value: '#5fefa333' },
    { tick: 310, value: '#29f5ba33' },
    { tick: 565, value: '#06fbd433' },
    { tick: 730, value: '#00ffe533' },      // Day - cyan tint
    { tick: 11270, value: '#00ffe533' },    // Day continues
    { tick: 11397, value: '#04fcd833' },    // Sunset begins
    { tick: 11522, value: '#0ff9cb33' },
    { tick: 11690, value: '#29f5ba33' },
    { tick: 11929, value: '#5fefa333' },
    { tick: 12243, value: '#b1e78733' },    // Yellow-green
    { tick: 12358, value: '#cce47e33' },
    { tick: 12512, value: '#e9e07233' },
    { tick: 12613, value: '#f6dd6b33' },
    { tick: 12732, value: '#feda6333' },    // Orange
    { tick: 12841, value: '#fed75c33' },
    { tick: 13035, value: '#ecd25133' },
    { tick: 13252, value: '#c1cc4733' },
    { tick: 13775, value: '#36be3733' },
    { tick: 13888, value: '#1fbb3533' },
    { tick: 14039, value: '#09b73333' },
    { tick: 14192, value: '#00b33333' },    // Night - darker teal
    { tick: 21807, value: '#00b23333' },    // Night continues
    { tick: 21961, value: '#09b73333' },    // Sunrise begins
    { tick: 22112, value: '#1fbb3533' },
    { tick: 22225, value: '#36be3733' },
    { tick: 22748, value: '#c1cc4733' },
    { tick: 22965, value: '#ecd25133' },
    { tick: 23159, value: '#fed75c33' },    // Orange
    { tick: 23272, value: '#feda6333' },
    { tick: 23488, value: '#e9e07233' },
    { tick: 23642, value: '#cce47e33' },
    { tick: 23757, value: '#b1e78733' },
  ];
  
  const { prevValue, nextValue, t } = interpolateKeyframes(ticks, keyframes);
  
  const prevColor = parseHexColorWithAlpha(prevValue);
  const nextColor = parseHexColorWithAlpha(nextValue);
  
  // Interpolate RGB and alpha
  const r = prevColor.r + (nextColor.r - prevColor.r) * t;
  const g = prevColor.g + (nextColor.g - prevColor.g) * t;
  const b = prevColor.b + (nextColor.b - prevColor.b) * t;
  const a = prevColor.a + (nextColor.a - prevColor.a) * t;
  
  return {
    color: new THREE.Color(r, g, b),
    alpha: a
  };
}

/**
 * Get sky color multiplier based on time (from day.json sky_color track)
 * Returns a value 0-1 to multiply base sky color
 */
function getSkyBrightness(ticks) {
  // Keyframes from day.json minecraft:visual/sky_color
  // Day: #ffffff (1.0), Night: #000000 (0.0)
  const keyframes = [
    { tick: 133, value: 1.0 },     // Dawn ends
    { tick: 11867, value: 1.0 },   // Dusk starts
    { tick: 13670, value: 0.0 },   // Night starts
    { tick: 22330, value: 0.0 },   // Dawn starts
  ];
  
  const { prevValue, nextValue, t } = interpolateKeyframes(ticks, keyframes);
  return prevValue + (nextValue - prevValue) * t;
}

/**
 * Get fog color multiplier (from day.json fog_color track)
 */
function getFogMultiplier(ticks) {
  // Day: #ffffff, Night: #0f0f16
  const keyframes = [
    { tick: 133, value: { r: 1, g: 1, b: 1 } },
    { tick: 11867, value: { r: 1, g: 1, b: 1 } },
    { tick: 13670, value: { r: 0.059, g: 0.059, b: 0.086 } },
    { tick: 22330, value: { r: 0.059, g: 0.059, b: 0.086 } },
  ];
  
  const { prevValue, nextValue, t } = interpolateKeyframes(ticks, keyframes);
  return {
    r: prevValue.r + (nextValue.r - prevValue.r) * t,
    g: prevValue.g + (nextValue.g - prevValue.g) * t,
    b: prevValue.b + (nextValue.b - prevValue.b) * t,
  };
}

/**
 * Get cloud color multiplier based on time of day
 * Similar to fog color but clouds stay slightly brighter at night (moonlight)
 * Follows the same keyframes as fog color with adjusted night values
 */
function getCloudColorMultiplier(ticks) {
  // Day: white clouds, Night: dark gray-blue tinted (similar to fog but slightly brighter)
  // Night value ~0.15-0.2 keeps clouds visible against the night sky
  const keyframes = [
    { tick: 133, value: { r: 1, g: 1, b: 1 } },      // Dawn ends - full brightness
    { tick: 11867, value: { r: 1, g: 1, b: 1 } },    // Dusk starts - still bright
    { tick: 13670, value: { r: 0.15, g: 0.15, b: 0.2 } },  // Night - dark blue-gray
    { tick: 22330, value: { r: 0.15, g: 0.15, b: 0.2 } },  // Pre-dawn - still dark
  ];
  
  const { prevValue, nextValue, t } = interpolateKeyframes(ticks, keyframes);
  return {
    r: prevValue.r + (nextValue.r - prevValue.r) * t,
    g: prevValue.g + (nextValue.g - prevValue.g) * t,
    b: prevValue.b + (nextValue.b - prevValue.b) * t,
  };
}

/**
 * Get star brightness based on time (from day.json star_brightness track)
 * Returns 0-1 value (0 = invisible, 0.5 = full night brightness)
 */
function getStarBrightness(ticks) {
  // Keyframes from day.json minecraft:visual/star_brightness
  const keyframes = [
    { tick: 92, value: 0.037 },
    { tick: 627, value: 0.0 },      // Dawn - stars fade out
    { tick: 11373, value: 0.0 },    // Day - no stars
    { tick: 11732, value: 0.016 },  // Dusk begins
    { tick: 11959, value: 0.044 },
    { tick: 12399, value: 0.143 },
    { tick: 12729, value: 0.258 },
    { tick: 13228, value: 0.5 },    // Night - full brightness
    { tick: 22772, value: 0.5 },    // Night continues
    { tick: 23032, value: 0.364 },  // Dawn begins
    { tick: 23356, value: 0.225 },
    { tick: 23758, value: 0.101 },
  ];
  
  const { prevValue, nextValue, t } = interpolateKeyframes(ticks, keyframes);
  return prevValue + (nextValue - prevValue) * t;
}

/**
 * Calculate sky colors based on time of day
 * Returns { skyColor, horizonColor, fogColor, cloudColor } as THREE.Color objects
 */
function calculateSkyColors(timeOfDay) {
  const ticks = timeOfDayToTicks(timeOfDay);
  const brightness = getSkyBrightness(ticks);
  const fogMult = getFogMultiplier(ticks);
  const cloudMult = getCloudColorMultiplier(ticks);
  
  // Apply brightness to base colors
  const skyColor = BASE_SKY_COLOR.clone().multiplyScalar(brightness);
  const horizonColor = BASE_HORIZON_COLOR.clone().multiplyScalar(brightness);
  
  // Night sky has a slight blue tint rather than pure black
  if (brightness < 0.1) {
    skyColor.setRGB(
      Math.max(skyColor.r, 0.01),
      Math.max(skyColor.g, 0.01),
      Math.max(skyColor.b, 0.03)
    );
    horizonColor.setRGB(
      Math.max(horizonColor.r, 0.02),
      Math.max(horizonColor.g, 0.02),
      Math.max(horizonColor.b, 0.04)
    );
  }
  
  // Fog color based on horizon (for seamless blending)
  const fogColor = new THREE.Color(
    horizonColor.r * fogMult.r,
    horizonColor.g * fogMult.g,
    horizonColor.b * fogMult.b
  );
  
  // Cloud color - tinted based on time of day (darker at night)
  const cloudColor = new THREE.Color(cloudMult.r, cloudMult.g, cloudMult.b);
  
  return { skyColor, horizonColor, fogColor, cloudColor, brightness };
}

/**
 * Sky Dome - Large sphere with gradient from horizon to zenith
 * Uses a custom shader for smooth color blending
 * Always follows camera so it appears infinite
 */
function SkyDome({ skyColor, horizonColor, sunDirection = null, glowColor = null, glowIntensity = 0 }) {
  const meshRef = useRef();
  const { camera } = useThree();
  
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSkyColor: { value: new THREE.Color(skyColor) },
        uHorizonColor: { value: new THREE.Color(horizonColor) },
        uSunDirection: { value: new THREE.Vector3(0, 0, -1) },
        uGlowColor: { value: new THREE.Color(1, 0.5, 0.2) },
        uGlowIntensity: { value: 0.0 },
      },
      vertexShader: `
        varying vec3 vLocalPosition;
        void main() {
          vLocalPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uSkyColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunDirection;
        uniform vec3 uGlowColor;
        uniform float uGlowIntensity;
        varying vec3 vLocalPosition;
        
        void main() {
          // Calculate view direction
          vec3 dir = normalize(vLocalPosition);
          float heightFactor = max(0.0, dir.y);
          
          // Base sky gradient (horizon to zenith)
          float t = pow(heightFactor, 0.5);
          vec3 color = mix(uHorizonColor, uSkyColor, t);
          
          // Sunrise/sunset glow calculation
          if (uGlowIntensity > 0.01) {
            // How close is this pixel to the sun's horizontal direction?
            vec3 sunHorizon = normalize(vec3(uSunDirection.x, 0.0, uSunDirection.z));
            vec3 viewHorizon = normalize(vec3(dir.x, 0.0, dir.z));
            
            // Dot product gives alignment (-1 to 1, 1 = facing sun)
            float sunAlignment = dot(viewHorizon, sunHorizon);
            
            // Glow is strongest when looking toward sun and near horizon
            float horizonProximity = 1.0 - abs(dir.y); // 1 at horizon, 0 at zenith/nadir
            horizonProximity = pow(horizonProximity, 0.5); // Soften falloff
            
            // Combine: glow when facing sun AND near horizon
            float glowFactor = max(0.0, sunAlignment);
            glowFactor = pow(glowFactor, 2.0); // Concentrate toward sun direction
            glowFactor *= horizonProximity;
            glowFactor *= uGlowIntensity;
            
            // Blend glow color additively
            color += uGlowColor * glowFactor;
          }
          
          gl_FragColor = vec4(color, 1.0);
        }
      `,
      side: THREE.BackSide, // Render inside of sphere
      depthWrite: false,
      depthTest: false, // Don't test depth - always render as background
    });
  }, []);

  // Update colors and glow when props change
  useEffect(() => {
    material.uniforms.uSkyColor.value.set(skyColor);
    material.uniforms.uHorizonColor.value.set(horizonColor);
    if (sunDirection) {
      material.uniforms.uSunDirection.value.copy(sunDirection);
    }
    if (glowColor) {
      material.uniforms.uGlowColor.value.copy(glowColor);
    }
    material.uniforms.uGlowIntensity.value = glowIntensity;
  }, [material, skyColor, horizonColor, sunDirection, glowColor, glowIntensity]);

  // Follow camera position so sky dome always surrounds the player
  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.position.copy(camera.position);
    }
  });

  return (
    <mesh ref={meshRef} material={material} renderOrder={-1000}>
      <sphereGeometry args={[SKY_RADIUS, 32, 32]} />
    </mesh>
  );
}

/**
 * Sun - Textured quad that follows camera and rotates with time
 * In Minecraft, sun rises in the east and sets in the west
 * 
 * Based on Minecraft's rendering:
 * - Uses position_tex shader (simple textured quad)
 * - Standard alpha blending with discard for alpha=0
 * - ColorModulator applied (white for sun)
 * - 32x32 pixel texture with nearest-neighbor filtering
 */
function Sun({ timeOfDay = 0.25 }) {
  const meshRef = useRef();
  const { camera } = useThree();
  const [texture, setTexture] = useState(null);

  // Load the actual Minecraft sun texture
  useEffect(() => {
    const loader = new THREE.TextureLoader();
    loader.load(SUN_TEXTURE_PATH, (tex) => {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      setTexture(tex);
    }, undefined, (err) => {
      console.warn('[MinecraftSky] Failed to load sun texture:', err);
      setTexture(createFallbackSunTexture());
    });
  }, []);

  // Create sun material with additive blending for glow effect
  // With additive blending, transparent (black) areas add nothing to the scene
  // This allows the semi-transparent glow region of the sun texture to show
  const material = useMemo(() => {
    if (!texture) return null;
    
    return new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,  // Test depth so terrain blocks the sun
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,  // Black+transparent adds nothing, glow shows
      fog: false,  // Don't apply scene fog to celestial bodies
    });
  }, [texture]);

  useFrame(() => {
    if (!meshRef.current) return;

    // Calculate sun position based on time of day
    // timeOfDay: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
    // Minecraft uses 24000 ticks per day, with noon at tick 6000
    // Convert to angle: noon (0.5 in our system) = sun at zenith
    const angle = (timeOfDay - 0.25) * Math.PI * 2;

    // Sun rotates around X axis (east-west arc)
    const sunX = camera.position.x;
    const sunY = camera.position.y + Math.sin(angle) * SUN_DISTANCE;
    const sunZ = camera.position.z - Math.cos(angle) * SUN_DISTANCE;

    meshRef.current.position.set(sunX, sunY, sunZ);

    // Always face camera
    meshRef.current.lookAt(camera.position);
  });

  // Hide sun when below horizon (night time)
  const sunAngle = (timeOfDay - 0.25) * Math.PI * 2;
  const isVisible = Math.sin(sunAngle) > -0.1; // Slight buffer for sunrise/sunset

  if (!isVisible || !material) return null;

  return (
    <mesh ref={meshRef} material={material} renderOrder={-999}>
      <planeGeometry args={[SUN_SIZE, SUN_SIZE]} />
    </mesh>
  );
}

/**
 * Moon - Textured quad opposite the sun
 * 
 * Based on Minecraft's rendering:
 * - 8 moon phases that cycle every 8 in-game days
 * - Position is 180° opposite from sun
 * - Uses same rotation arc as sun (east-west)
 * - Visible at night, fades during day
 */
function Moon({ timeOfDay = 0.25 }) {
  const meshRef = useRef();
  const { camera } = useThree();
  const [texture, setTexture] = useState(null);

  // Load the actual Minecraft moon texture
  useEffect(() => {
    const loader = new THREE.TextureLoader();
    loader.load(MOON_TEXTURE_PATH, (tex) => {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      setTexture(tex);
    }, undefined, (err) => {
      console.warn('[MinecraftSky] Failed to load moon texture:', err);
      setTexture(createFallbackMoonTexture());
    });
  }, []);

  // Create moon material - additive blending to show against dark sky
  const material = useMemo(() => {
    if (!texture) return null;
    
    return new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,  // Test depth so terrain blocks the moon
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, // Additive to glow against dark sky
      fog: false,  // Don't apply scene fog to celestial bodies
    });
  }, [texture]);

  useFrame(() => {
    if (!meshRef.current) return;

    // Calculate moon position - 180° (π) offset from sun
    // timeOfDay: 0 = midnight (moon at zenith), 0.5 = noon (moon below horizon)
    const angle = (timeOfDay - 0.25) * Math.PI * 2 + Math.PI; // +π for opposite side

    // Moon rotates around X axis (east-west arc), opposite to sun
    const moonX = camera.position.x;
    const moonY = camera.position.y + Math.sin(angle) * MOON_DISTANCE;
    const moonZ = camera.position.z - Math.cos(angle) * MOON_DISTANCE;

    meshRef.current.position.set(moonX, moonY, moonZ);

    // Always face camera
    meshRef.current.lookAt(camera.position);
  });

  // Hide moon when below horizon (day time)
  // Moon angle is offset by π from sun
  const moonAngle = (timeOfDay - 0.25) * Math.PI * 2 + Math.PI;
  const isVisible = Math.sin(moonAngle) > -0.1; // Slight buffer for moonrise/moonset

  if (!isVisible || !material) return null;

  return (
    <mesh ref={meshRef} material={material} renderOrder={-998}>
      <planeGeometry args={[MOON_SIZE, MOON_SIZE]} />
    </mesh>
  );
}

/**
 * Create a fallback moon texture if loading fails
 */
function createFallbackMoonTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Dark transparent background
  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillRect(0, 0, size, size);

  // Draw a simple moon circle
  const centerX = size / 2;
  const centerY = size / 2;
  const radius = size * 0.4;

  // Moon body - slightly warm gray
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#e8e8d8';
  ctx.fill();

  // Add some crater-like darker spots
  ctx.fillStyle = 'rgba(180, 180, 170, 0.6)';
  ctx.beginPath();
  ctx.arc(centerX - 8, centerY - 5, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(centerX + 10, centerY + 8, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(centerX + 5, centerY - 10, 3, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

/**
 * Stars - Minecraft-accurate star rendering
 * 
 * Based on Minecraft's stars rendering (from minecraft.wiki):
 * - Uses fixed seed 10842 for deterministic pattern
 * - 1500 stars attempted
 * - Each star is a small quad (square), not a point
 * - Brightness controlled by star_brightness timeline track
 * - Rotate with time (star_angle track)
 */
const STAR_COUNT = 1500; // Number of stars (same as Minecraft)
const STAR_RADIUS = 900; // Distance from camera (same as sun/moon to avoid depth issues)
const STAR_SEED = 10842; // Minecraft's fixed seed for stars
// Minecraft star size: base 0.15 + random * 0.1 at radius 100
// Scale factor to maintain angular size at radius 900: 900/100 = 9
const STAR_SCALE = 9;

// Seeded random number generator (simple LCG)
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function Stars({ timeOfDay = 0.5 }) {
  const meshRef = useRef();
  const { camera } = useThree();
  
  // Generate star geometry once using seeded random
  const { geometry, material } = useMemo(() => {
    const random = seededRandom(STAR_SEED);
    
    // Each star is a quad (4 vertices, 2 triangles)
    const positions = [];
    const indices = [];
    let vertexIndex = 0;
    
    for (let i = 0; i < STAR_COUNT; i++) {
      // Random position on sphere using Minecraft's method
      // Stars are placed on FULL sphere (not just upper hemisphere)
      const d0 = random() * 2.0 - 1.0;
      const d1 = random() * 2.0 - 1.0;
      const d2 = random() * 2.0 - 1.0;
      const d3 = 0.15 + random() * 0.1; // Star size variation
      
      // Calculate distance from origin
      const d4 = d0 * d0 + d1 * d1 + d2 * d2;
      
      // Skip if too close to center (normalize would explode) or outside unit sphere
      // Minecraft places stars on the full sphere, visibility is controlled by rotation
      if (d4 < 1.0 && d4 > 0.01) {
        // Normalize and scale to sphere radius
        const dist = 1.0 / Math.sqrt(d4);
        const x = d0 * dist * STAR_RADIUS;
        const y = d1 * dist * STAR_RADIUS;
        const z = d2 * dist * STAR_RADIUS;
        
        // Create quad facing the origin (camera)
        // Star size: Minecraft uses 0.15 + random * 0.1, scaled for our radius
        const starSize = d3 * STAR_SCALE;
        
        // Simple quad perpendicular to view direction
        const toCenter = new THREE.Vector3(-x, -y, -z).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(up, toCenter).normalize();
        const quadUp = new THREE.Vector3().crossVectors(toCenter, right).normalize();
        
        // Handle edge case when toCenter is parallel to up vector
        if (right.lengthSq() < 0.001) {
          right.set(1, 0, 0);
          quadUp.crossVectors(toCenter, right).normalize();
        }
        
        // Four corners of the star quad
        const corners = [
          [-1, -1], [1, -1], [1, 1], [-1, 1]
        ];
        
        for (const [cx, cy] of corners) {
          positions.push(
            x + right.x * cx * starSize + quadUp.x * cy * starSize,
            y + right.y * cx * starSize + quadUp.y * cy * starSize,
            z + right.z * cx * starSize + quadUp.z * cy * starSize
          );
        }
        
        // Two triangles for the quad
        indices.push(
          vertexIndex, vertexIndex + 1, vertexIndex + 2,
          vertexIndex, vertexIndex + 2, vertexIndex + 3
        );
        vertexIndex += 4;
      }
    }
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      depthTest: true, // Test depth so terrain blocks stars
      fog: false, // Not affected by fog
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    
    return { geometry: geom, material: mat };
  }, []);
  
  // Update star brightness and position based on time
  useFrame(() => {
    if (!meshRef.current || !material) return;
    
    // Calculate star brightness from timeline
    const ticks = timeOfDayToTicks(timeOfDay);
    const brightness = getStarBrightness(ticks);
    
    // Update material opacity
    material.opacity = brightness;
    
    // Stars follow camera position (they're at infinity)
    meshRef.current.position.copy(camera.position);
    
    // Stars rotate with time (star_angle track - opposite to sun)
    const starAngle = (timeOfDay - 0.25) * Math.PI * 2;
    meshRef.current.rotation.x = starAngle;
  });
  
  // Don't render if brightness is 0
  const ticks = timeOfDayToTicks(timeOfDay);
  const brightness = getStarBrightness(ticks);
  if (brightness < 0.01) return null;
  
  return (
    <mesh ref={meshRef} geometry={geometry} material={material} renderOrder={-999} />
  );
}

/**
 * Clouds - Minecraft-accurate 3D volumetric cloud rendering
 * 
 * Based on Minecraft's rendertype_clouds shader:
 * - clouds.png is a 256x256 1-bit grayscale texture (binary cloud/no-cloud)
 * - Each pixel represents a 12x12x4 block cell in world space (12 wide, 4 tall)
 * - Minecraft renders clouds as 3D voxels with different face shading:
 *   - Top face: 1.0 (brightest)
 *   - Bottom face: 0.7 (darkest)
 *   - North/South: 0.8
 *   - East/West: 0.9
 * - Clouds fade with distance using linear_fog_value(distance, 0, FogCloudsEnd)
 * - Clouds drift slowly eastward
 */
function Clouds({ opacity = 0.8, fogEnd = 800, skyColor = null, cloudColor = null }) {
  const groupRef = useRef();
  const { camera } = useThree();
  const offsetRef = useRef(0);
  const [cloudMap, setCloudMap] = useState(null);
  const materialRef = useRef(null);

  // Load and parse the cloud texture into a binary map
  useEffect(() => {
    let mounted = true;
    let loaded = false;
    
    // Set fallback after a short timeout if texture doesn't load
    const fallbackTimer = setTimeout(() => {
      if (mounted && !loaded) {
        console.log('[MinecraftSky] Using fallback cloud map (timeout)');
        setCloudMap(createFallbackCloudMap());
      }
    }, 500);
    
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    img.onload = () => {
      clearTimeout(fallbackTimer);
      loaded = true;
      if (!mounted) return;
      
      console.log('[MinecraftSky] Cloud image loaded:', img.width, 'x', img.height);
      
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      
      // Fill with black first (no clouds)
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 256, 256);
      
      // Draw the image
      ctx.drawImage(img, 0, 0, 256, 256);
      const imageData = ctx.getImageData(0, 0, 256, 256);
      
      // Create binary cloud map (true = cloud, false = no cloud)
      const map = new Array(256 * 256);
      let cloudCount = 0;
      for (let i = 0; i < 256 * 256; i++) {
        const r = imageData.data[i * 4];
        map[i] = r > 128;
        if (map[i]) cloudCount++;
      }
      
      console.log('[MinecraftSky] Cloud map:', cloudCount, 'cells');
      setCloudMap(cloudCount > 0 ? map : createFallbackCloudMap());
    };
    
    img.onerror = () => {
      clearTimeout(fallbackTimer);
      loaded = true;
      if (!mounted) return;
      console.warn('[MinecraftSky] Cloud texture failed, using fallback');
      setCloudMap(createFallbackCloudMap());
    };
    
    img.src = CLOUDS_TEXTURE_PATH;
    
    return () => {
      mounted = false;
      clearTimeout(fallbackTimer);
    };
  }, []);

  // Build 3D cloud geometry with face-specific vertex colors
  const { geometry, material } = useMemo(() => {
    if (!cloudMap) return { geometry: null, material: null };

    // Generate full 256x256 cloud tile (the pattern repeats every 256 cells = 3072 blocks)
    // This ensures complete coverage of the tiling pattern
    const MAP_SIZE = 256;
    const cellWidth = CLOUD_CELL_SIZE; // 12 blocks
    const cellHeight = 4; // 4 blocks tall
    
    const positions = [];
    const colors = [];
    const indices = [];
    let vertexIndex = 0;
    
    // Helper to check if cloud exists (with wrapping)
    const hasCloud = (x, z) => {
      const wx = ((x % 256) + 256) % 256;
      const wz = ((z % 256) + 256) % 256;
      return cloudMap[wz * 256 + wx];
    };
    
    // Add a face with vertex colors
    // Vertices should be in counter-clockwise order when viewed from outside
    const addFace = (verts, brightness) => {
      for (const v of verts) {
        positions.push(...v);
        colors.push(...brightness);
      }
      // Standard CCW triangulation: [0,1,2] and [0,2,3]
      indices.push(
        vertexIndex, vertexIndex + 1, vertexIndex + 2,
        vertexIndex, vertexIndex + 2, vertexIndex + 3
      );
      vertexIndex += 4;
    };
    
    // Generate cloud cells for the full 256x256 tile
    // Centered on origin so clouds span -1536 to +1536 in X and Z
    const HALF = MAP_SIZE / 2; // 128
    for (let cz = -HALF; cz < HALF; cz++) {
      for (let cx = -HALF; cx < HALF; cx++) {
        if (!hasCloud(cx, cz)) continue;
        
        const x0 = cx * cellWidth;
        const x1 = x0 + cellWidth;
        const y0 = 0;
        const y1 = cellHeight;
        const z0 = cz * cellWidth;
        const z1 = z0 + cellWidth;
        
        // Top face (+Y) - CCW when viewed from above
        addFace([
          [x0, y1, z0],
          [x0, y1, z1],
          [x1, y1, z1],
          [x1, y1, z0]
        ], CLOUD_FACE_COLORS.top);
        
        // Bottom face (-Y) - CCW when viewed from below
        addFace([
          [x0, y0, z1],
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y0, z1]
        ], CLOUD_FACE_COLORS.bottom);
        
        // North face (-Z) - CCW when viewed from -Z
        if (!hasCloud(cx, cz - 1)) {
          addFace([
            [x1, y0, z0],
            [x0, y0, z0],
            [x0, y1, z0],
            [x1, y1, z0]
          ], CLOUD_FACE_COLORS.north);
        }
        
        // South face (+Z) - CCW when viewed from +Z
        if (!hasCloud(cx, cz + 1)) {
          addFace([
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1]
          ], CLOUD_FACE_COLORS.south);
        }
        
        // West face (-X) - CCW when viewed from -X
        if (!hasCloud(cx - 1, cz)) {
          addFace([
            [x0, y0, z0],
            [x0, y0, z1],
            [x0, y1, z1],
            [x0, y1, z0]
          ], CLOUD_FACE_COLORS.west);
        }
        
        // East face (+X) - CCW when viewed from +X
        if (!hasCloud(cx + 1, cz)) {
          addFace([
            [x1, y0, z1],
            [x1, y0, z0],
            [x1, y1, z0],
            [x1, y1, z1]
          ], CLOUD_FACE_COLORS.east);
        }
      }
    }
    
    console.log('[MinecraftSky] Cloud geometry: vertices=', positions.length / 3, 
                'triangles=', indices.length / 3, 'colors=', colors.length / 3);
    
    if (positions.length === 0) {
      console.warn('[MinecraftSky] No cloud geometry generated!');
      return { geometry: null, material: null };
    }
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);
    
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCloudColor: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        uCameraPos: { value: new THREE.Vector3(0, 0, 0) },
        uFogCloudsEnd: { value: fogEnd },
        uSkyColor: { value: new THREE.Vector3(0.47, 0.65, 1.0) }, // Sky color to fade into
        uOpacity: { value: opacity },
      },
      vertexShader: `
        // 'color' attribute is auto-injected by Three.js when vertexColors: true
        varying vec3 vColor;
        varying vec3 vWorldPos;
        
        void main() {
          vColor = color;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uCloudColor;
        uniform vec3 uCameraPos;
        uniform float uFogCloudsEnd;
        uniform vec3 uSkyColor;
        uniform float uOpacity;
        
        varying vec3 vColor;
        varying vec3 vWorldPos;
        
        float linearFogValue(float dist, float fogStart, float fogEnd) {
          if (dist <= fogStart) return 0.0;
          if (dist >= fogEnd) return 1.0;
          return (dist - fogStart) / (fogEnd - fogStart);
        }
        
        void main() {
          float dist = length(vWorldPos - uCameraPos);
          float fogValue = linearFogValue(dist, 0.0, uFogCloudsEnd);
          
          // Cloud base color with face shading
          vec3 cloudColor = vColor * uCloudColor;
          
          // Blend towards sky color with distance (like Minecraft fog)
          vec3 finalColor = mix(cloudColor, uSkyColor, fogValue);
          
          // Output as opaque - fog blends to sky, not transparent
          gl_FragColor = vec4(finalColor, uOpacity);
        }
      `,
      transparent: true,
      depthWrite: true,  // Enable depth writing for proper face occlusion
      depthTest: true,
      side: THREE.FrontSide,
      vertexColors: true,
    });
    
    return { geometry: geom, material: mat };
  }, [cloudMap, opacity, fogEnd]);

  // Animate cloud drift - fixed world position with slow eastward drift
  useFrame((_, delta) => {
    if (!groupRef.current || !material) return;

    // Slow eastward drift (positive X direction)
    offsetRef.current += delta * CLOUD_SPEED;
    
    // Clouds stay fixed at world origin, only drift affects X position
    // The cloud pattern is fixed in world space - cell at world (x, z) 
    // always shows the same cloud pattern
    groupRef.current.position.set(
      offsetRef.current,
      CLOUD_HEIGHT,
      0
    );

    material.uniforms.uCameraPos.value.set(
      camera.position.x,
      camera.position.y,
      camera.position.z
    );
    
    // Update sky color for fog blending if provided
    if (skyColor && material.uniforms.uSkyColor) {
      material.uniforms.uSkyColor.value.set(skyColor.r, skyColor.g, skyColor.b);
    }
    
    // Update cloud color based on time of day (tinting for night)
    if (cloudColor && material.uniforms.uCloudColor) {
      material.uniforms.uCloudColor.value.set(cloudColor.r, cloudColor.g, cloudColor.b);
    }
  });

  if (!geometry || !material) return null;

  return (
    <group ref={groupRef}>
      <mesh geometry={geometry} material={material} renderOrder={-998} />
    </group>
  );
}

/**
 * Creates a fallback binary cloud map (256x256 array of booleans)
 */
function createFallbackCloudMap() {
  const map = new Array(256 * 256);
  let cloudCount = 0;
  
  const noise = (x, y, scale) => {
    const nx = Math.floor(x / scale);
    const ny = Math.floor(y / scale);
    const n = Math.sin(nx * 12.9898 + ny * 78.233) * 43758.5453;
    return n - Math.floor(n);
  };
  
  for (let z = 0; z < 256; z++) {
    for (let x = 0; x < 256; x++) {
      const n1 = noise(x, z, 8);
      const n2 = noise(x, z, 16) * 0.5;
      const n3 = noise(x, z, 32) * 0.25;
      const value = (n1 + n2 + n3) / 1.75;
      // Lower threshold for more clouds (0.4 instead of 0.5)
      map[z * 256 + x] = value > 0.4;
      if (map[z * 256 + x]) cloudCount++;
    }
  }
  
  console.log('[MinecraftSky] Fallback cloud map generated:', cloudCount, 'cells');
  return map;
}

/**
 * Fallback textures when actual textures aren't available
 * 
 * Minecraft's sun.png is a 32x32 image with:
 * - A bright yellow/white center core
 * - A semi-transparent glow region around it
 */
function createFallbackSunTexture() {
  const size = 32; // Minecraft sun is 32x32
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  
  // Clear to transparent
  ctx.clearRect(0, 0, size, size);

  // Create radial gradient for sun with glow
  const centerX = size / 2;
  const centerY = size / 2;
  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, size / 2);
  
  // Bright white/yellow center
  gradient.addColorStop(0, 'rgba(255, 255, 240, 1.0)');    // Bright center
  gradient.addColorStop(0.3, 'rgba(255, 255, 200, 1.0)');  // Yellow core
  gradient.addColorStop(0.5, 'rgba(255, 245, 150, 0.8)');  // Glow start
  gradient.addColorStop(0.7, 'rgba(255, 230, 100, 0.4)');  // Outer glow
  gradient.addColorStop(1.0, 'rgba(255, 200, 50, 0.0)');   // Fade to transparent
  
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.LinearFilter;  // Smooth for glow
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}


/**
 * Main MinecraftSky component
 * 
 * Props:
 * - enabled: Whether to render sky elements (default: true)
 * - timeOfDay: Time of day from 0-1 (0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset)
 * - cloudOpacity: Cloud opacity 0-1 (default: 0.8)
 * - onColorsChange: Callback when sky colors change (for fog sync)
 * - dimension: Current dimension ID ('overworld', 'the_nether', 'the_end')
 */
export function MinecraftSky({
  enabled = true,
  timeOfDay = 0.35, // Default to mid-morning (pleasant lighting)
  cloudOpacity = 0.8,
  onColorsChange = null,
  dimension = 'overworld',
}) {
  const { scene } = useThree();
  
  // Get dimension-specific configuration
  const dimConfig = useMemo(() => getDimensionConfig(dimension), [dimension]);
  
  // Calculate dynamic sky colors based on time of day and dimension
  const colors = useMemo(() => {
    // For dimensions with fixed time (Nether, End), use static colors
    if (!dimConfig.hasTimeOfDay) {
      return {
        skyColor: new THREE.Color(dimConfig.skyColor),
        horizonColor: new THREE.Color(dimConfig.horizonColor),
        fogColor: new THREE.Color(dimConfig.fogColor),
        cloudColor: new THREE.Color(dimConfig.fogColor), // Use fog color for cloud tinting
        brightness: dimConfig.ambientLight,
      };
    }
    // Overworld uses time-based colors
    return calculateSkyColors(timeOfDay);
  }, [timeOfDay, dimConfig]);
  
  // Calculate sunrise/sunset glow parameters
  const glowParams = useMemo(() => {
    // Calculate sun angle (same formula as Sun component)
    const angle = (timeOfDay - 0.25) * Math.PI * 2;
    const sunY = Math.sin(angle); // -1 to 1, 0 at horizon
    
    // Calculate sun direction vector
    const sunDirection = new THREE.Vector3(
      0,
      sunY,
      -Math.cos(angle)
    ).normalize();
    
    // Glow intensity based on how close sun is to horizon
    // Sun at horizon: sunY ≈ 0, glow strongest
    // Sun high/low: sunY far from 0, no glow
    const horizonProximity = 1.0 - Math.abs(sunY);
    const glowIntensity = Math.pow(Math.max(0, horizonProximity - 0.3) / 0.7, 2);
    
    // Warm sunset/sunrise colors (orange-red gradient based on sun height)
    // When sun is just above horizon: orange
    // When sun is at horizon: deep orange/red
    let glowColor;
    if (sunY > 0) {
      // Sunrise/daytime side - more yellow/orange
      glowColor = new THREE.Color(1.0, 0.6, 0.2);
    } else {
      // Sunset/nighttime side - more orange/red  
      glowColor = new THREE.Color(1.0, 0.4, 0.1);
    }
    
    return {
      sunDirection,
      glowColor,
      glowIntensity: glowIntensity * 0.35, // Subtle glow, not overpowering
    };
  }, [timeOfDay]);
  
  // Convert to hex strings for components that need them
  const skyColorHex = '#' + colors.skyColor.getHexString();
  const horizonColorHex = '#' + colors.horizonColor.getHexString();
  const fogColorHex = '#' + colors.fogColor.getHexString();

  // Notify parent of color changes (for fog synchronization and particle brightness)
  useEffect(() => {
    if (onColorsChange) {
      onColorsChange({
        skyColor: skyColorHex,
        horizonColor: horizonColorHex,
        fogColor: fogColorHex,
        brightness: colors.brightness,
        // Cloud color multiplier - used for particle ambient brightness
        cloudColor: {
          r: colors.cloudColor.r,
          g: colors.cloudColor.g,
          b: colors.cloudColor.b,
        },
        // Dimension-specific fog settings
        dimension: {
          id: dimension,
          skybox: dimConfig.skybox,
          fogStart: dimConfig.fogStart,
          fogEnd: dimConfig.fogEnd,
        },
      });
    }
  }, [onColorsChange, skyColorHex, horizonColorHex, fogColorHex, colors.brightness, colors.cloudColor, dimension, dimConfig]);

  // Set scene background to null so our sky dome is visible
  useEffect(() => {
    if (enabled) {
      scene.background = null;
    }
    return () => {
      scene.background = new THREE.Color(horizonColorHex);
    };
  }, [enabled, scene, horizonColorHex]);

  if (!enabled) return null;

  // Nether: solid colored dome, no celestial objects
  if (dimConfig.skybox === 'none') {
    return (
      <group name="minecraft-sky-nether">
        {/* Solid colored sky dome for Nether */}
        <SkyDome 
          skyColor={skyColorHex} 
          horizonColor={horizonColorHex}
          sunDirection={null}
          glowColor={null}
          glowIntensity={0}
        />
      </group>
    );
  }

  // End: TODO - implement end sky with purple cube skybox
  if (dimConfig.skybox === 'end') {
    return (
      <group name="minecraft-sky-end">
        {/* For now, just show a dark dome - End cube skybox to be implemented */}
        <SkyDome 
          skyColor={skyColorHex} 
          horizonColor={horizonColorHex}
          sunDirection={null}
          glowColor={null}
          glowIntensity={0}
        />
      </group>
    );
  }

  // Overworld: full sky with sun, moon, stars, clouds
  return (
    <group name="minecraft-sky">
      {/* Sky dome with gradient and sunrise/sunset glow */}
      <SkyDome 
        skyColor={skyColorHex} 
        horizonColor={horizonColorHex}
        sunDirection={glowParams.sunDirection}
        glowColor={glowParams.glowColor}
        glowIntensity={glowParams.glowIntensity}
      />

      {/* Sun - loads actual Minecraft texture */}
      <Sun timeOfDay={timeOfDay} />

      {/* Moon - opposite side of sky from sun */}
      <Moon timeOfDay={timeOfDay} />

      {/* Stars - visible at night */}
      <Stars timeOfDay={timeOfDay} />

      {/* Clouds - loads actual Minecraft texture, tinted by time of day */}
      {cloudOpacity > 0 && <Clouds opacity={cloudOpacity} skyColor={colors.horizonColor} cloudColor={colors.cloudColor} />}
    </group>
  );
}

export default MinecraftSky;

