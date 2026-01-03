/**
 * Water Material - Accurate Minecraft Water Rendering
 * 
 * Minecraft water rendering formula (from terrain.fsh):
 *   finalColor = texture * vertexColor
 * Where vertexColor = biome_tint * lightmap (from terrain.vsh)
 * 
 * Water textures:
 *   - water_still: Used for top faces, grayscale animated
 *   - water_flow: Used for side faces, grayscale animated
 * 
 * Both are grayscale textures multiplied by biome water tint (#3F76E4 default)
 */

import * as THREE from 'three';

const vertexShader = `
uniform float uMinY;
uniform float uMaxY;

// Vertex attributes from FluidMesher
attribute vec2 modelUV;      // UV coordinates
attribute float texIndex;    // Atlas texture index (water_still or water_flow)
attribute float skyLight;    // Sky light level (0-15)
attribute float blockLight;  // Block light level (0-15)

// Note: 'color' attribute is auto-injected by Three.js when vertexColors: true
// Contains biome water tint color

varying vec3 vColor;
varying vec2 vModelUV;
varying float vTexIndex;
varying vec2 vLightUV;
varying float vVisible;
varying vec3 vNormal;

// Water face shading - more subtle than solid blocks
// In Minecraft, translucent blocks use lighter shading:
// - Top faces are fully bright (1.0)
// - Side faces have mild shading (0.9)
// - Bottom faces are slightly darker (0.7)
// This is less extreme than solid blocks (which use 1.0, 0.8, 0.6, 0.5)
float getWaterFaceShade(vec3 n) {
  vec3 norm = normalize(n);
  vec3 absN = abs(norm);
  
  float maxAxis = max(absN.x, max(absN.y, absN.z));
  if (maxAxis < 0.01) return 1.0;
  
  // Top-facing surfaces (including angled water): full brightness
  if (norm.y > 0.5) return 1.0;
  
  // Bottom face: slightly darker
  if (norm.y < -0.5) return 0.7;
  
  // Side faces: mild shading
  return 0.9;
}

void main() {
  // Apply subtle water face shading
  float faceShade = getWaterFaceShade(normal);
  vColor = color * faceShade;
  
  vModelUV = modelUV;
  vTexIndex = texIndex;
  vNormal = normal;
  
  // Pack light values as UV for lightmap sampling
  // Matches Minecraft's minecraft_sample_lightmap exactly
  vLightUV = vec2((blockLight + 0.5) / 16.0, (skyLight + 0.5) / 16.0);
  
  // Check if vertex is within Y range
  if (position.y < uMinY - 0.01 || position.y > uMaxY + 1.01) {
    gl_Position = vec4(0.0, 0.0, -1000.0, 1.0);
    vVisible = 0.0;
  } else {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vVisible = 1.0;
  }
}
`;

const fragmentShader = `
uniform float uOpacity;
uniform sampler2D uAtlas;          // Texture atlas
uniform sampler2D uLightmap;       // 16x16 lightmap texture
uniform sampler2D uAnimationData;  // Animation metadata
uniform sampler2D uFrameSequence;  // Frame sequence texture
uniform float uTime;               // Animation time
uniform float uTotalTiles;         // Total tiles in atlas
uniform float uSequenceLength;     // Length of frame sequence
uniform vec2 uAtlasSize;           // Atlas size in tiles
uniform vec2 uTileUV;              // Tile size in UV
uniform vec2 uTextureUV;           // Usable texture area in UV
uniform vec2 uBorderUV;            // Border size in UV
uniform float uUseTextures;        // 1.0 = use textures, 0.0 = solid color
uniform float uUseLightmap;        // 1.0 = use lightmap, 0.0 = fixed lighting

varying vec3 vColor;
varying vec2 vModelUV;
varying float vTexIndex;
varying vec2 vLightUV;
varying float vVisible;
varying vec3 vNormal;

// Animation result structure (matches TexturedMaterial)
struct AnimResult {
  float currentIndex;
  float nextIndex;
  float blend;
};

// Calculate animated texture index (matches TexturedMaterial exactly)
AnimResult getAnimatedTexData(float texIndex) {
  AnimResult result;
  result.currentIndex = texIndex;
  result.nextIndex = texIndex;
  result.blend = 0.0;
  
  if (uTotalTiles <= 0.0) return result;
  
  // Sample animation data: (sequenceStart, cycleLength, frametime, interpolate)
  float u = (texIndex + 0.5) / uTotalTiles;
  vec4 animData = texture2D(uAnimationData, vec2(u, 0.5));
  
  float sequenceStart = animData.r;
  float cycleLength = animData.g;
  float frametime = animData.b;
  float interpolate = animData.a;
  
  if (cycleLength <= 1.0) return result;
  
  // Convert time to Minecraft ticks (20 ticks per second)
  float ticks = uTime * 20.0;
  
  // Calculate current position in animation cycle
  float ticksPerCycle = frametime * cycleLength;
  float cycleTicks = mod(ticks, ticksPerCycle);
  float exactFrame = cycleTicks / frametime;
  float currentCycleFrame = floor(exactFrame);
  float nextCycleFrame = mod(currentCycleFrame + 1.0, cycleLength);
  
  // Look up actual atlas indices from frame sequence
  float seqU1 = (sequenceStart + currentCycleFrame + 0.5) / uSequenceLength;
  float seqU2 = (sequenceStart + nextCycleFrame + 0.5) / uSequenceLength;
  
  result.currentIndex = texture2D(uFrameSequence, vec2(seqU1, 0.5)).r;
  result.nextIndex = texture2D(uFrameSequence, vec2(seqU2, 0.5)).r;
  result.blend = interpolate > 0.5 ? fract(exactFrame) : 0.0;
  
  return result;
}

// Sample texture at given atlas index (matches TexturedMaterial)
vec4 sampleAtlas(float atlasIndex, vec2 modelUV) {
  float tilesPerRow = uAtlasSize.x;
  float tileX = mod(atlasIndex, tilesPerRow);
  float tileY = floor(atlasIndex / tilesPerRow);
  
  // Wrap model UV and scale to usable texture area
  vec2 wrappedUV = fract(modelUV);
  vec2 textureOffset = wrappedUV * uTextureUV;
  
  // Calculate tile base position with border offset
  vec2 tileBase = vec2(tileX, tileY) * uTileUV + uBorderUV;
  vec2 finalUV = tileBase + textureOffset;
  
  return texture2D(uAtlas, finalUV);
}

void main() {
  if (vVisible < 0.5) discard;
  
  vec3 color;
  float alpha = uOpacity;
  
  // Check if we have valid texture setup
  bool hasValidAtlas = uTotalTiles > 1.0 && uTileUV.x > 0.0 && uTileUV.x < 0.5;
  
  if (uUseTextures > 0.5 && hasValidAtlas && vTexIndex >= 0.0) {
    // Get animated texture frame
    AnimResult anim = getAnimatedTexData(vTexIndex);
    
    // Sample current and next frames
    vec4 texColor1 = sampleAtlas(anim.currentIndex, vModelUV);
    vec4 texColor2 = sampleAtlas(anim.nextIndex, vModelUV);
    
    // Interpolate between frames (water has interpolate=true by default)
    vec4 texColor = mix(texColor1, texColor2, anim.blend);
    
    // Water texture is grayscale - multiply by biome tint
    // This is Minecraft's formula: finalColor = texture * vertexColor
    color = texColor.rgb * vColor;
    alpha *= texColor.a;
  } else {
    // Fallback: solid biome tint color (for meshes without texture data)
    color = vColor;
  }
  
  // Apply lighting from lightmap only
  // Water in Minecraft doesn't use directional face shading like solid blocks
  // It's uniformly lit based on the lightmap (sky + block light)
  if (uUseLightmap > 0.5) {
    vec3 lightColor = texture2D(uLightmap, vLightUV).rgb;
    color *= lightColor;
  }
  
  if (alpha < 0.01) discard;
  
  gl_FragColor = vec4(color, alpha);
}
`;

// Create a default 1x1 texture
function createDefaultTexture() {
  const data = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Create water material with full texture atlas and animation support
 * @param {Object} atlasData - Texture atlas data from TextureAtlas
 * @param {boolean} useTextures - Whether to use textures
 * @param {THREE.Texture} lightmap - Lightmap texture
 */
export function createWaterMaterial(atlasData = null, useTextures = true, lightmap = null) {
  const defaultTex = createDefaultTexture();
  
  const atlas = atlasData?.atlas || defaultTex;
  const animationData = atlasData?.animationData || defaultTex;
  const frameSequence = atlasData?.frameSequence || defaultTex;
  const totalTiles = atlasData?.totalTiles || 1;
  const sequenceLength = atlasData?.sequenceLength || 1;
  const size = atlasData?.size || { x: 1, y: 1 };
  const tileUV = atlasData?.tileUV || { x: 1, y: 1 };
  const textureUV = atlasData?.textureUV || { x: 1, y: 1 };
  const borderUV = atlasData?.borderUV || { x: 0, y: 0 };
  
  return new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uOpacity: { value: 0.8 },
      uAtlas: { value: atlas },
      uLightmap: { value: lightmap || defaultTex },
      uAnimationData: { value: animationData },
      uFrameSequence: { value: frameSequence },
      uTime: { value: 0.0 },
      uTotalTiles: { value: totalTiles },
      uSequenceLength: { value: sequenceLength },
      uAtlasSize: { value: new THREE.Vector2(size.x, size.y) },
      uTileUV: { value: new THREE.Vector2(tileUV.x, tileUV.y) },
      uTextureUV: { value: new THREE.Vector2(textureUV.x, textureUV.y) },
      uBorderUV: { value: new THREE.Vector2(borderUV.x, borderUV.y) },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseLightmap: { value: lightmap ? 1.0 : 0.0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    vertexColors: true,
  });
}

/**
 * Update water material's texture atlas
 */
export function updateWaterMaterialAtlas(material, atlasData) {
  if (!material?.uniforms || !atlasData) return;
  
  if (atlasData.atlas) material.uniforms.uAtlas.value = atlasData.atlas;
  if (atlasData.animationData) material.uniforms.uAnimationData.value = atlasData.animationData;
  if (atlasData.frameSequence) material.uniforms.uFrameSequence.value = atlasData.frameSequence;
  if (atlasData.totalTiles) material.uniforms.uTotalTiles.value = atlasData.totalTiles;
  if (atlasData.sequenceLength) material.uniforms.uSequenceLength.value = atlasData.sequenceLength;
  if (atlasData.size) material.uniforms.uAtlasSize.value.set(atlasData.size.x, atlasData.size.y);
  if (atlasData.tileUV) material.uniforms.uTileUV.value.set(atlasData.tileUV.x, atlasData.tileUV.y);
  if (atlasData.textureUV) material.uniforms.uTextureUV.value.set(atlasData.textureUV.x, atlasData.textureUV.y);
  if (atlasData.borderUV) material.uniforms.uBorderUV.value.set(atlasData.borderUV.x, atlasData.borderUV.y);
  
  material.uniforms.uUseTextures.value = 1.0;
}

/**
 * Update water material's lightmap texture
 */
export function updateWaterMaterialLightmap(material, lightmap) {
  if (material?.uniforms?.uLightmap) {
    material.uniforms.uLightmap.value = lightmap;
    material.uniforms.uUseLightmap.value = lightmap ? 1.0 : 0.0;
  }
}

export default createWaterMaterial;
