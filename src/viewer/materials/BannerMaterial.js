/**
 * BannerMaterial - Custom material for banner pattern compositing
 * 
 * Banners in Minecraft can have up to 6 pattern layers on top of a base color.
 * This material composites patterns in the fragment shader using:
 * - Base banner texture from entity atlas
 * - Pattern mask atlas containing all 43 pattern types
 * - Per-instance pattern data (up to 6 layers)
 * 
 * Each pattern layer has:
 * - Pattern type index (which mask to use)
 * - Color index (0-15 for the 16 dye colors)
 */

import * as THREE from 'three';

// Minecraft dye colors (sRGB)
const DYE_COLORS = [
  [0.949, 0.949, 0.949], // 0: white
  [0.949, 0.494, 0.200], // 1: orange
  [0.784, 0.306, 0.741], // 2: magenta
  [0.227, 0.643, 0.925], // 3: light_blue
  [0.996, 0.859, 0.153], // 4: yellow
  [0.502, 0.776, 0.102], // 5: lime
  [0.949, 0.510, 0.631], // 6: pink
  [0.294, 0.294, 0.294], // 7: gray
  [0.600, 0.600, 0.565], // 8: light_gray
  [0.086, 0.525, 0.592], // 9: cyan
  [0.502, 0.247, 0.678], // 10: purple
  [0.200, 0.298, 0.678], // 11: blue
  [0.502, 0.325, 0.196], // 12: brown
  [0.333, 0.447, 0.169], // 13: green
  [0.678, 0.220, 0.220], // 14: red
  [0.153, 0.125, 0.125], // 15: black
];

// Banner pattern name to atlas index mapping
const PATTERN_INDICES = {
  'base': 0,
  'border': 1,
  'bricks': 2,
  'circle': 3,
  'creeper': 4,
  'cross': 5,
  'curly_border': 6,
  'diagonal_left': 7,
  'diagonal_right': 8,
  'diagonal_up_left': 9,
  'diagonal_up_right': 10,
  'flow': 11,
  'flower': 12,
  'globe': 13,
  'gradient': 14,
  'gradient_up': 15,
  'guster': 16,
  'half_horizontal': 17,
  'half_horizontal_bottom': 18,
  'half_vertical': 19,
  'half_vertical_right': 20,
  'mojang': 21,
  'piglin': 22,
  'rhombus': 23,
  'skull': 24,
  'small_stripes': 25,
  'square_bottom_left': 26,
  'square_bottom_right': 27,
  'square_top_left': 28,
  'square_top_right': 29,
  'straight_cross': 30,
  'stripe_bottom': 31,
  'stripe_center': 32,
  'stripe_downleft': 33,
  'stripe_downright': 34,
  'stripe_left': 35,
  'stripe_middle': 36,
  'stripe_right': 37,
  'stripe_top': 38,
  'triangle_bottom': 39,
  'triangle_top': 40,
  'triangles_bottom': 41,
  'triangles_top': 42,
};

// Vertex shader
const vertexShader = /* glsl */`
  precision highp float;
  
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec2 uv;
  attribute vec3 color;
  attribute float skyLight;
  attribute float blockLight;
  
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vSkyLight;
  varying float vBlockLight;
  
  void main() {
    vUv = uv;
    vNormal = normalMatrix * normal;
    vColor = color;
    vSkyLight = skyLight;
    vBlockLight = blockLight;
    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Fragment shader with pattern compositing
const fragmentShader = /* glsl */`
  precision highp float;
  
  uniform sampler2D uBannerBase;
  uniform sampler2D uPatternAtlas;
  uniform sampler2D uLightmap;
  uniform vec4 uPatterns[6]; // (patternIndex, colorR, colorG, colorB) per layer
  uniform int uPatternCount;
  uniform float uAmbientLight;
  uniform float uBaseColor[3]; // Base banner color
  
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vSkyLight;
  varying float vBlockLight;
  
  // Get UV coordinates for a pattern in the atlas
  vec2 getPatternUV(vec2 baseUv, int patternIndex) {
    // Atlas layout: patterns arranged in a grid
    // Assuming 8 columns, each pattern is 64x128 pixels in a 512x1024 atlas
    float col = mod(float(patternIndex), 8.0);
    float row = floor(float(patternIndex) / 8.0);
    
    float uScale = 1.0 / 8.0;
    float vScale = 1.0 / 8.0;
    
    return vec2(
      col * uScale + baseUv.x * uScale,
      row * vScale + baseUv.y * vScale
    );
  }
  
  // Lightmap lookup matching Minecraft's brightness curve
  float getBrightness(float level) {
    return level / (4.0 - 3.0 * level);
  }
  
  void main() {
    // Start with base banner texture
    vec4 baseTexture = texture2D(uBannerBase, vUv);
    
    // Apply base color
    vec3 color = baseTexture.rgb * vec3(uBaseColor[0], uBaseColor[1], uBaseColor[2]);
    
    // Composite pattern layers
    for (int i = 0; i < 6; i++) {
      if (i >= uPatternCount) break;
      
      vec4 patternData = uPatterns[i];
      int patternIndex = int(patternData.x);
      vec3 patternColor = patternData.yzw;
      
      // Sample pattern mask from atlas
      vec2 patternUV = getPatternUV(vUv, patternIndex);
      float mask = texture2D(uPatternAtlas, patternUV).r;
      
      // Blend pattern color using mask
      color = mix(color, patternColor, mask);
    }
    
    // Apply lighting
    float skyBrightness = getBrightness(vSkyLight);
    float blockBrightness = getBrightness(vBlockLight);
    float brightness = max(skyBrightness, blockBrightness);
    brightness = mix(uAmbientLight, 1.0, brightness);
    
    // Apply face shading based on normal
    vec3 absNormal = abs(vNormal);
    float shadeFactor = 1.0;
    if (absNormal.y > 0.5) {
      shadeFactor = vNormal.y > 0.0 ? 1.0 : 0.5; // Top/bottom
    } else if (absNormal.z > 0.5) {
      shadeFactor = 0.8; // North/south
    } else {
      shadeFactor = 0.6; // East/west
    }
    
    color *= brightness * shadeFactor;
    
    gl_FragColor = vec4(color, baseTexture.a);
  }
`;

/**
 * Create a BannerMaterial instance
 * @param {Object} options
 * @param {THREE.Texture} options.bannerBaseTexture - Base banner texture
 * @param {THREE.Texture} options.patternAtlasTexture - Pattern mask atlas
 * @param {THREE.Texture} options.lightmapTexture - Lightmap texture
 * @param {number} options.baseColorIndex - Base color index (0-15)
 * @param {Array} options.patterns - Array of { pattern: string, colorIndex: number }
 */
export function createBannerMaterial(options = {}) {
  const {
    bannerBaseTexture,
    patternAtlasTexture,
    lightmapTexture,
    baseColorIndex = 0,
    patterns = [],
  } = options;
  
  // Build pattern uniform array
  const patternData = new Float32Array(24); // 6 patterns × 4 components
  
  for (let i = 0; i < Math.min(patterns.length, 6); i++) {
    const pattern = patterns[i];
    const patternIndex = PATTERN_INDICES[pattern.pattern] || 0;
    const color = DYE_COLORS[pattern.colorIndex] || DYE_COLORS[0];
    
    patternData[i * 4 + 0] = patternIndex;
    patternData[i * 4 + 1] = color[0];
    patternData[i * 4 + 2] = color[1];
    patternData[i * 4 + 3] = color[2];
  }
  
  // Convert to array of vec4
  const patternUniforms = [];
  for (let i = 0; i < 6; i++) {
    patternUniforms.push(new THREE.Vector4(
      patternData[i * 4 + 0],
      patternData[i * 4 + 1],
      patternData[i * 4 + 2],
      patternData[i * 4 + 3]
    ));
  }
  
  const baseColor = DYE_COLORS[baseColorIndex] || DYE_COLORS[0];
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uBannerBase: { value: bannerBaseTexture },
      uPatternAtlas: { value: patternAtlasTexture },
      uLightmap: { value: lightmapTexture },
      uPatterns: { value: patternUniforms },
      uPatternCount: { value: patterns.length },
      uBaseColor: { value: baseColor },
      uAmbientLight: { value: 0.03 },
    },
    vertexShader,
    fragmentShader,
    transparent: false,
    side: THREE.DoubleSide,
  });
  
  return material;
}

/**
 * Update banner patterns on an existing material
 * @param {THREE.ShaderMaterial} material
 * @param {number} baseColorIndex
 * @param {Array} patterns
 */
export function updateBannerPatterns(material, baseColorIndex, patterns) {
  const patternUniforms = material.uniforms.uPatterns.value;
  
  for (let i = 0; i < 6; i++) {
    if (i < patterns.length) {
      const pattern = patterns[i];
      const patternIndex = PATTERN_INDICES[pattern.pattern] || 0;
      const color = DYE_COLORS[pattern.colorIndex] || DYE_COLORS[0];
      
      patternUniforms[i].set(patternIndex, color[0], color[1], color[2]);
    } else {
      patternUniforms[i].set(0, 0, 0, 0);
    }
  }
  
  material.uniforms.uPatternCount.value = patterns.length;
  material.uniforms.uBaseColor.value = DYE_COLORS[baseColorIndex] || DYE_COLORS[0];
}

/**
 * Get pattern index by name
 * @param {string} patternName
 * @returns {number}
 */
export function getPatternIndex(patternName) {
  return PATTERN_INDICES[patternName] ?? 0;
}

/**
 * Get dye color by index
 * @param {number} colorIndex
 * @returns {number[]} RGB values 0-1
 */
export function getDyeColor(colorIndex) {
  return DYE_COLORS[colorIndex] || DYE_COLORS[0];
}

export { DYE_COLORS, PATTERN_INDICES };
export default createBannerMaterial;
