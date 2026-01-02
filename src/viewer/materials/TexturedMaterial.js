/**
 * TexturedMaterial - Shader material for rendering blocks with textures
 * 
 * This material supports two modes:
 * 1. Solid color mode - uses vertex colors directly (current default)
 * 2. Textured mode - samples from a texture atlas using:
 *    - texIndex attribute: atlas tile index per vertex (set by FastMesher)
 *    - World position for triplanar UV tiling within the tile
 * 
 * The texIndex approach is much more accurate than the old color-lookup method
 * because each vertex explicitly knows which texture to use for each face.
 */

import * as THREE from 'three';

const vertexShader = `
uniform float uMinY;
uniform float uMaxY;

attribute float texIndex;    // Atlas texture index (0 to tilesPerRow*tilesPerCol-1)
attribute float texRotation; // Texture rotation (0-3 for 90° increments)
attribute float tintType;    // Biome tint type (0=none, 1=grass, 2=foliage, 3=spruce, 4=birch, 5=water)
attribute float skyLight;    // Sky light level (0-15)
attribute float blockLight;  // Block light level (0-15)

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vVisible;
varying float vTexIndex;
varying float vTexRotation;
varying float vTintType;
varying vec2 vLightUV;       // Light UV for lightmap sampling (blockLight/16, skyLight/16)

void main() {
  vColor = color;
  vNormal = normal; // Pass object-space normal (will be snapped in fragment shader)
  vWorldPos = position; // World position for UV calculation
  vTexIndex = texIndex;
  vTexRotation = texRotation;
  vTintType = tintType;
  
  // Pack light values as UV for lightmap sampling
  // UV is (blockLight, skyLight) normalized to 0-1 with 0.5 texel offset for centering
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
uniform sampler2D uAtlas;        // The texture atlas
uniform sampler2D uColormap;     // Biome colormap texture (grass on top, foliage on bottom)
uniform sampler2D uLightmap;     // 16x16 lightmap texture (X=block light, Y=sky light)
uniform float uUseTextures;      // 0.0 = vertex colors only, 1.0 = use textures
uniform float uUseTinting;       // 0.0 = no biome tinting, 1.0 = apply biome tinting
uniform float uUseLightmap;      // 0.0 = fixed face shading, 1.0 = use lightmap
uniform vec2 uAtlasSize;         // Atlas dimensions in tiles (e.g., 56x56)
uniform vec2 uTileUV;            // Full tile size in UV space (includes 1px border)
uniform vec2 uTextureUV;         // Usable texture size in UV space (16x16 area)
uniform vec2 uBorderUV;          // Border offset in UV space (1px)

// Tint type constants (must match TINT_TYPE in biomeTinting.js)
#define TINT_NONE 0
#define TINT_GRASS 1
#define TINT_FOLIAGE 2
#define TINT_SPRUCE 3
#define TINT_BIRCH 4
#define TINT_WATER 5
#define TINT_REDSTONE 6
#define TINT_DRY_FOLIAGE 7
#define TINT_STEM 8

// Fixed tint colors (RGB 0-1)
const vec3 SPRUCE_TINT = vec3(0.380, 0.600, 0.380);   // #619961
const vec3 BIRCH_TINT = vec3(0.502, 0.655, 0.333);    // #80a755
const vec3 WATER_TINT = vec3(0.247, 0.463, 0.894);    // #3F76E4
const vec3 REDSTONE_TINT = vec3(0.918, 0.000, 0.000); // #EA0000 (powered redstone red)
const vec3 DRY_FOLIAGE_TINT = vec3(0.667, 0.580, 0.439); // #AB9470
const vec3 STEM_TINT = vec3(0.455, 0.698, 0.196);    // #74b232 (mature stem green)

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vVisible;
varying float vTexIndex;
varying float vTexRotation;
varying float vTintType;
varying vec2 vLightUV;

// Snap interpolated normal to nearest axis to prevent UV instability at sharp angles
// This is needed because WebGL 1.0 doesn't support 'flat' interpolation
vec3 snapNormal(vec3 n) {
  vec3 absN = abs(n);
  // Find dominant axis and return axis-aligned normal
  if (absN.y >= absN.x && absN.y >= absN.z) {
    return vec3(0.0, sign(n.y), 0.0);
  } else if (absN.x >= absN.z) {
    return vec3(sign(n.x), 0.0, 0.0);
  } else {
    return vec3(0.0, 0.0, sign(n.z));
  }
}

// Rotate UV coordinates by 90-degree increments (0=0°, 1=90°, 2=180°, 3=270°)
// Returns UV clamped to [0, 1] range
vec2 rotateUV(vec2 uv, int rot) {
  // Rotation around center (0.5, 0.5)
  vec2 centered = uv - 0.5;
  
  if (rot == 1) {
    // 90° clockwise: (x, y) -> (y, -x)
    centered = vec2(centered.y, -centered.x);
  } else if (rot == 2) {
    // 180°: (x, y) -> (-x, -y)
    centered = vec2(-centered.x, -centered.y);
  } else if (rot == 3) {
    // 270° clockwise (90° counter-clockwise): (x, y) -> (-y, x)
    centered = vec2(-centered.y, centered.x);
  }
  // rot == 0: no rotation
  
  // Clamp result to valid UV range to prevent any edge case issues
  return clamp(centered + 0.5, 0.0, 1.0);
}

// Position-based random rotation for blocks like grass, stone, dirt
// Uses a hash function that gives consistent per-block rotation values 0-3
// This allows greedy meshing to merge blocks while each pixel computes its own rotation
int getPositionRotation(vec3 worldPos) {
  // Get block position (floor to get the block the fragment is in)
  vec3 p = floor(worldPos);
  
  // Minecraft's position hash formula adapted for GLSL
  // Original: l = (x * 3129871) ^ (z * 116129781) ^ y
  // We use a simplified float-based hash that gives similar visual results
  // Using prime multipliers for good distribution
  float hash = p.x * 3129871.0 + p.z * 116129781.0 + p.y;
  hash = fract(sin(hash * 0.0000001) * 43758.5453);
  
  return int(hash * 4.0); // Returns 0, 1, 2, or 3
}

// Sample the biome colormap to get tint color
// Colormap is 256x512: grass (0-255 in source), foliage (256-511 in source)
// In our combined texture: grass at Y: 0.0-0.5, foliage at Y: 0.5-1.0
//
// Minecraft colormap sampling formula:
// adjustedTemp = clamp(temperature, 0.0, 1.0)
// adjustedDownfall = clamp(downfall, 0.0, 1.0) * adjustedTemp
// x = (1.0 - adjustedTemp) * 255
// y = (1.0 - adjustedDownfall) * 255
//
// Plains biome: temp=0.8, downfall=0.4
// adjustedTemp = 0.8, adjustedDownfall = 0.32
// x = 0.2 * 255 = 51, y = 0.68 * 255 = 173
// normalized: (0.2, 0.68)
vec3 sampleColormap(int tintType) {
  // Plains biome sampling position (temp=0.8, downfall=0.4)
  float temp = 0.8;
  float downfall = 0.4;
  float adjustedDownfall = downfall * temp;
  
  // Calculate colormap UV from biome parameters
  float u = 1.0 - temp;        // X: 0 = hot (right), 1 = cold (left)
  float v = 1.0 - adjustedDownfall; // Y: 0 = wet (bottom), 1 = dry (top)
  
  if (tintType == TINT_GRASS) {
    // Grass colormap is in top half (y: 0.0 to 0.5)
    return texture2D(uColormap, vec2(u, v * 0.5)).rgb;
  } else if (tintType == TINT_FOLIAGE) {
    // Foliage colormap is in bottom half (y: 0.5 to 1.0)
    return texture2D(uColormap, vec2(u, 0.5 + v * 0.5)).rgb;
  }
  
  return vec3(1.0);
}

// Get the biome tint color for the current fragment
vec3 getBiomeTint(int tintType) {
  if (tintType == TINT_NONE) {
    return vec3(1.0); // No tinting
  } else if (tintType == TINT_GRASS || tintType == TINT_FOLIAGE) {
    return sampleColormap(tintType);
  } else if (tintType == TINT_SPRUCE) {
    return SPRUCE_TINT;
  } else if (tintType == TINT_BIRCH) {
    return BIRCH_TINT;
  } else if (tintType == TINT_WATER) {
    return WATER_TINT;
  } else if (tintType == TINT_REDSTONE) {
    return REDSTONE_TINT;
  } else if (tintType == TINT_DRY_FOLIAGE) {
    return DRY_FOLIAGE_TINT;
  } else if (tintType == TINT_STEM) {
    return STEM_TINT;
  }
  return vec3(1.0);
}

// Get UV coordinates for a face based on world position and normal (triplanar)
// Matches Minecraft's default UV mapping for cube models exactly.
// 
// After tracing through ModelGeometry's FACE_VERTICES + FACE_UV_MAPPING:
// - NORTH (-Z): U = X, V = (1-Y)
// - SOUTH (+Z): U = X, V = (1-Y)
// - EAST (+X): U = (1-Z), V = (1-Y)
// - WEST (-X): U = (1-Z), V = (1-Y)
// - UP (+Y): U = X, V = Z
// - DOWN (-Y): U = X, V = (1-Z)
//
// Note: NORTH/SOUTH share the same UV mapping (looking through the cube),
// and EAST/WEST share the same UV mapping. This is intentional in Minecraft.
vec2 getTriplanarUV(vec3 worldPos, vec3 normal) {
  // Snap normal to nearest axis - critical for preventing smearing at sharp angles
  vec3 snapped = snapNormal(normal);
  vec3 absNormal = abs(snapped);
  
  vec2 uv;
  
  // Top/bottom faces (Y-axis dominant)
  if (absNormal.y >= absNormal.x && absNormal.y >= absNormal.z) {
    if (snapped.y > 0.0) {
      // TOP face (+Y): U = X, V = Z
      uv = vec2(worldPos.x, worldPos.z);
      uv = fract(uv);
      return clamp(uv, 0.0, 1.0);
    } else {
      // BOTTOM face (-Y): U = X, V = (1-Z)
      uv = vec2(worldPos.x, worldPos.z);
      uv = fract(uv);
      uv.y = 1.0 - uv.y;
      return clamp(uv, 0.0, 1.0);
    }
  }
  // East/West faces (X-axis dominant) - both use U = (1-Z), V = (1-Y)
  else if (absNormal.x >= absNormal.z) {
    uv = vec2(worldPos.z, worldPos.y);
    uv = fract(uv);
    uv.x = 1.0 - uv.x; // U = (1-Z)
    uv.y = 1.0 - uv.y; // V = (1-Y)
    return clamp(uv, 0.0, 1.0);
  }
  // North/South faces (Z-axis dominant) - both use U = X, V = (1-Y)
  else {
    uv = vec2(worldPos.x, worldPos.y);
    uv = fract(uv);
    uv.y = 1.0 - uv.y; // V = (1-Y)
    return clamp(uv, 0.0, 1.0);
  }
}

void main() {
  if (vVisible < 0.5) discard;
  
  vec3 finalColor;
  float alpha = 1.0;
  
  if (uUseTextures > 0.5) {
    // Get the local UV within a single block face (0-1 per block)
    vec2 localUV = getTriplanarUV(vWorldPos, vNormal);
    
    // Apply texture rotation if needed
    // Rotation values 0-3: fixed rotation
    // Rotation values 4-7: per-fragment full rotation (0°, 90°, 180°, 270°)
    // Rotation values 8-11: per-fragment half rotation (0° and 180° only, for stone/bedrock)
    int rotValue = int(vTexRotation + 0.5); // Round to nearest int
    
    if (rotValue >= 8) {
      // Half rotation mode (0° and 180° only): for blocks like stone, bedrock
      int baseRot = rotValue - 8;
      int posRot = getPositionRotation(vWorldPos);
      // Map 0,1,2,3 -> 0,2,0,2 (only 0° and 180°)
      int halfRot = (posRot / 2) * 2; // 0->0, 1->0, 2->2, 3->2
      rotValue = int(mod(float(baseRot + halfRot), 4.0));
      localUV = rotateUV(localUV, rotValue);
    } else if (rotValue >= 4) {
      // Full per-fragment rotation mode: compute rotation from block position
      int baseRot = rotValue - 4;
      int posRot = getPositionRotation(vWorldPos);
      rotValue = int(mod(float(baseRot + posRot), 4.0));
      localUV = rotateUV(localUV, rotValue);
    } else if (rotValue > 0 && rotValue < 4) {
      // Fixed rotation mode
      localUV = rotateUV(localUV, rotValue);
    }
    
    // Final safety clamp on localUV (belt and suspenders approach)
    localUV = clamp(localUV, 0.0, 1.0);
    
    // Calculate tile position from texture index
    float tilesPerRow = uAtlasSize.x;
    float col = mod(vTexIndex, tilesPerRow);
    float row = floor(vTexIndex / tilesPerRow);
    
    // Calculate atlas offset for this tile (using actual tile UV size, not 1/tilesPerRow)
    vec2 atlasOffset = vec2(col, row) * uTileUV;
    
    // Add border offset to get to the actual texture area
    // The atlas has 1-pixel borders around each tile to prevent bleeding, so we just
    // offset by the border and use the full texture area
    vec2 atlasUV = atlasOffset + uBorderUV + localUV * uTextureUV;
    
    // Sample the texture
    vec4 texColor = texture2D(uAtlas, atlasUV);
    
    // Handle transparency
    if (texColor.a < 0.1) discard;
    
    // Apply biome tinting if enabled
    int tintType = int(vTintType + 0.5); // Round to nearest int
    vec3 tintColor = vec3(1.0);
    
    if (uUseTinting > 0.5 && tintType > 0) {
      tintColor = getBiomeTint(tintType);
    }
    
    // Apply tint to texture color
    // For tinted blocks, the texture is grayscale and we multiply by tint
    finalColor = texColor.rgb * tintColor;
    alpha = texColor.a;
  } else {
    // Use vertex color fallback (solid color mode)
    finalColor = vColor;
  }
  
  // Minecraft-style face shading (fixed brightness per face direction)
  // These values match Minecraft Java Edition's block face lighting
  vec3 snappedN = snapNormal(vNormal);
  float faceShade = 1.0;
  
  if (abs(snappedN.y) > 0.5) {
    // Top face (Y+) = 1.0, Bottom face (Y-) = 0.5
    faceShade = snappedN.y > 0.0 ? 1.0 : 0.5;
  } else if (abs(snappedN.x) > 0.5) {
    // East/West faces (X±) = 0.6
    faceShade = 0.6;
  } else {
    // North/South faces (Z±) = 0.8
    faceShade = 0.8;
  }
  
  // Apply lighting: either from lightmap or fixed face shading
  vec3 lightColor = vec3(1.0);
  if (uUseLightmap > 0.5) {
    // Sample lightmap using light UV (x = block light, y = sky light)
    // The lightmap combines block and sky light into a final color
    lightColor = texture2D(uLightmap, vLightUV).rgb;
    // Apply face shading on top of lightmap
    lightColor *= faceShade;
  } else {
    // Use fixed face shading only
    lightColor = vec3(faceShade);
  }
  
  gl_FragColor = vec4(finalColor * lightColor, alpha);
}
`;

// Create a default 1x1 white texture for when no atlas is provided
function createDefaultTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1, 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const defaultTexture = createDefaultTexture();

/**
 * Extract uniform values from atlas data
 */
function getAtlasUniforms(atlasData) {
  let atlas = defaultTexture;
  let colormap = defaultTexture;
  let size = new THREE.Vector2(32, 32);
  let tileUV = new THREE.Vector2(1/32, 1/32);     // Default: 1 tile = 1/32 of atlas
  let textureUV = new THREE.Vector2(1/32, 1/32);  // Same as tileUV for simple case
  let borderUV = new THREE.Vector2(0, 0);         // No border for simple case
  let hasColormap = false;
  
  if (atlasData) {
    if (atlasData.atlas) {
      atlas = atlasData.atlas;
      if (atlasData.size) size.set(atlasData.size.x, atlasData.size.y);
      else if (atlasData.tilesPerRow) size.set(atlasData.tilesPerRow, atlasData.tilesPerCol || atlasData.tilesPerRow);
      
      // Use precise UV sizes if available
      if (atlasData.tileUV) tileUV.set(atlasData.tileUV.x, atlasData.tileUV.y);
      if (atlasData.textureUV) textureUV.set(atlasData.textureUV.x, atlasData.textureUV.y);
      if (atlasData.borderUV) borderUV.set(atlasData.borderUV.x, atlasData.borderUV.y);
      
      // Colormap for biome tinting
      if (atlasData.colormap) {
        colormap = atlasData.colormap;
        hasColormap = true;
      }
    } else if (atlasData.isTexture) {
      // Old format: THREE.Texture
      atlas = atlasData;
    }
  }
  
  return { atlas, colormap, hasColormap, size, tileUV, textureUV, borderUV };
}

/**
 * Create a textured solid block material
 * @param {Object|THREE.Texture} atlasData - Material data { atlas, colormap, lightmap, size, textureIndexLookup, tilesPerRow, tilesPerCol, tileUV, textureUV, borderUV } or legacy texture
 * @param {boolean} useTextures - Whether to use textures (false = vertex colors only)
 * @param {THREE.Texture} lightmap - Optional lightmap texture (16x16)
 */
export function createTexturedMaterial(atlasData = null, useTextures = false, lightmap = null) {
  const { atlas, colormap, hasColormap, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uColormap: { value: colormap },
      uLightmap: { value: lightmap || defaultTexture },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseTinting: { value: hasColormap ? 1.0 : 0.0 },
      uUseLightmap: { value: lightmap ? 1.0 : 0.0 },
      uAtlasSize: { value: size },
      uTileUV: { value: tileUV },
      uTextureUV: { value: textureUV },
      uBorderUV: { value: borderUV },
    },
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
    vertexColors: true,
    transparent: false,
  });
  
  return material;
}

/**
 * Create a textured material for transparent blocks (glass, ice)
 */
export function createTexturedGlassMaterial(atlasData = null, useTextures = false, lightmap = null) {
  const { atlas, colormap, hasColormap, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uColormap: { value: colormap },
      uLightmap: { value: lightmap || defaultTexture },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseTinting: { value: hasColormap ? 1.0 : 0.0 },
      uUseLightmap: { value: lightmap ? 1.0 : 0.0 },
      uAtlasSize: { value: size },
      uTileUV: { value: tileUV },
      uTextureUV: { value: textureUV },
      uBorderUV: { value: borderUV },
    },
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
    vertexColors: true,
    transparent: true,
    depthWrite: true, // Enable depth writing - alpha-tested pixels (discarded) won't write anyway
  });
  
  return material;
}

/**
 * Update material's texture atlas
 * @param {THREE.ShaderMaterial} material - The material to update
 * @param {Object} atlasData - { atlas: THREE.Texture, colormap: THREE.Texture, size: {x, y}, tilesPerRow, tilesPerCol, tileUV, textureUV, borderUV }
 */
export function updateMaterialAtlas(material, atlasData) {
  if (!material.uniforms) return;
  
  if (atlasData && atlasData.atlas) {
    material.uniforms.uAtlas.value = atlasData.atlas;
    if (atlasData.size) {
      material.uniforms.uAtlasSize.value.set(atlasData.size.x, atlasData.size.y);
    } else if (atlasData.tilesPerRow) {
      material.uniforms.uAtlasSize.value.set(atlasData.tilesPerRow, atlasData.tilesPerCol || atlasData.tilesPerRow);
    }
    // Update UV uniforms if available
    if (atlasData.tileUV && material.uniforms.uTileUV) {
      material.uniforms.uTileUV.value.set(atlasData.tileUV.x, atlasData.tileUV.y);
    }
    if (atlasData.textureUV && material.uniforms.uTextureUV) {
      material.uniforms.uTextureUV.value.set(atlasData.textureUV.x, atlasData.textureUV.y);
    }
    if (atlasData.borderUV && material.uniforms.uBorderUV) {
      material.uniforms.uBorderUV.value.set(atlasData.borderUV.x, atlasData.borderUV.y);
    }
    // Update colormap if available
    if (atlasData.colormap && material.uniforms.uColormap) {
      material.uniforms.uColormap.value = atlasData.colormap;
      material.uniforms.uUseTinting.value = 1.0;
    }
  } else if (atlasData instanceof THREE.Texture) {
    // Simple texture update (backward compat)
    material.uniforms.uAtlas.value = atlasData;
  }
  
  material.needsUpdate = true;
}

/**
 * Set whether the material uses textures or vertex colors
 */
export function setMaterialTextureMode(material, useTextures) {
  if (material.uniforms && material.uniforms.uUseTextures) {
    material.uniforms.uUseTextures.value = useTextures ? 1.0 : 0.0;
    material.needsUpdate = true;
  }
}

// ============================================================================
// Model Material - Uses model UVs instead of triplanar mapping
// For partial blocks like flowers, grass, stairs, slabs, etc.
// ============================================================================

const modelVertexShader = `
uniform float uMinY;
uniform float uMaxY;

attribute vec2 modelUV;      // Model UV coordinates (from Minecraft model data)
attribute float texIndex;    // Atlas texture index (0 to tilesPerRow*tilesPerCol-1)
attribute float texRotation; // Texture rotation (0-3 for 90° increments)
attribute float tintType;    // Biome tint type (0=none, 1=grass, 2=foliage, 3=spruce, 4=birch, 5=water)
attribute float shadeFlag;   // Face shading flag (0=no shade, 1=apply directional shading)
attribute float singleSided; // Single-sided flag (0=double-sided, 1=cull backface)
attribute float skyLight;    // Sky light level (0-15)
attribute float blockLight;  // Block light level (0-15)

varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vModelUV;
varying float vVisible;
varying float vTexIndex;
varying float vTexRotation;
varying float vTintType;
varying float vShadeFlag;
varying float vSingleSided;
varying vec2 vLightUV;

void main() {
  vColor = color;
  vNormal = normal;
  vModelUV = modelUV; // Pass model UV directly
  vTexIndex = texIndex;
  vTexRotation = texRotation;
  vTintType = tintType;
  vShadeFlag = shadeFlag;
  vSingleSided = singleSided;
  
  // Pack light values as UV for lightmap sampling
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

const modelFragmentShader = `
uniform sampler2D uAtlas;        // The texture atlas
uniform sampler2D uColormap;     // Biome colormap texture (grass on top, foliage on bottom)
uniform sampler2D uLightmap;     // 16x16 lightmap texture
uniform float uUseTextures;      // 0.0 = vertex colors only, 1.0 = use textures
uniform float uUseTinting;       // 0.0 = no biome tinting, 1.0 = apply biome tinting
uniform float uUseLightmap;      // 0.0 = fixed face shading, 1.0 = use lightmap
uniform vec2 uAtlasSize;         // Atlas dimensions in tiles (e.g., 56x56)
uniform vec2 uTileUV;            // Full tile size in UV space (includes 1px border)
uniform vec2 uTextureUV;         // Usable texture size in UV space (16x16 area)
uniform vec2 uBorderUV;          // Border offset in UV space (1px)

// Tint type constants
#define TINT_NONE 0
#define TINT_GRASS 1
#define TINT_FOLIAGE 2
#define TINT_SPRUCE 3
#define TINT_BIRCH 4
#define TINT_WATER 5
#define TINT_REDSTONE 6
#define TINT_DRY_FOLIAGE 7
#define TINT_STEM 8

// Fixed tint colors
const vec3 SPRUCE_TINT = vec3(0.380, 0.600, 0.380);
const vec3 BIRCH_TINT = vec3(0.502, 0.655, 0.333);
const vec3 WATER_TINT = vec3(0.247, 0.463, 0.894);
const vec3 REDSTONE_TINT = vec3(0.918, 0.000, 0.000);
const vec3 DRY_FOLIAGE_TINT = vec3(0.667, 0.580, 0.439);
const vec3 STEM_TINT = vec3(0.455, 0.698, 0.196);

varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vModelUV;
varying float vVisible;
varying vec2 vLightUV;
varying float vTexIndex;
varying float vTexRotation;
varying float vTintType;
varying float vShadeFlag;
varying float vSingleSided;

// Snap normal for face shading
vec3 snapNormal(vec3 n) {
  vec3 absN = abs(n);
  if (absN.y >= absN.x && absN.y >= absN.z) {
    return vec3(0.0, sign(n.y), 0.0);
  } else if (absN.x >= absN.z) {
    return vec3(sign(n.x), 0.0, 0.0);
  } else {
    return vec3(0.0, 0.0, sign(n.z));
  }
}

// Rotate UV by 90-degree increments
vec2 rotateUV(vec2 uv, int rot) {
  vec2 centered = uv - 0.5;
  
  if (rot == 1) {
    centered = vec2(centered.y, -centered.x);
  } else if (rot == 2) {
    centered = vec2(-centered.x, -centered.y);
  } else if (rot == 3) {
    centered = vec2(-centered.y, centered.x);
  }
  
  return clamp(centered + 0.5, 0.0, 1.0);
}

// Sample biome colormap using Minecraft's formula
// Plains biome: temp=0.8, downfall=0.4
vec3 sampleColormap(int tintType) {
  float temp = 0.8;
  float downfall = 0.4;
  float adjustedDownfall = downfall * temp;
  
  float u = 1.0 - temp;
  float v = 1.0 - adjustedDownfall;
  
  if (tintType == TINT_GRASS) {
    return texture2D(uColormap, vec2(u, v * 0.5)).rgb;
  } else if (tintType == TINT_FOLIAGE) {
    return texture2D(uColormap, vec2(u, 0.5 + v * 0.5)).rgb;
  }
  return vec3(1.0);
}

// Get biome tint color
vec3 getBiomeTint(int tintType) {
  if (tintType == TINT_NONE) {
    return vec3(1.0);
  } else if (tintType == TINT_GRASS || tintType == TINT_FOLIAGE) {
    return sampleColormap(tintType);
  } else if (tintType == TINT_SPRUCE) {
    return SPRUCE_TINT;
  } else if (tintType == TINT_BIRCH) {
    return BIRCH_TINT;
  } else if (tintType == TINT_WATER) {
    return WATER_TINT;
  } else if (tintType == TINT_REDSTONE) {
    return REDSTONE_TINT;
  } else if (tintType == TINT_DRY_FOLIAGE) {
    return DRY_FOLIAGE_TINT;
  } else if (tintType == TINT_STEM) {
    return STEM_TINT;
  }
  return vec3(1.0);
}

void main() {
  if (vVisible < 0.5) discard;
  
  // For single-sided elements (torch bulb panels, etc.), cull backfaces
  // These elements have inward-facing normals and should not be visible from outside
  // Note: Check singleSided is valid (>= 0) to handle missing attribute gracefully
  if (vSingleSided > 0.5 && vSingleSided < 1.5 && !gl_FrontFacing) discard;
  
  vec3 finalColor;
  float alpha = 1.0;
  
  if (uUseTextures > 0.5) {
    // Use model UV directly (not triplanar)
    vec2 localUV = vModelUV;
    
    // Apply texture rotation if needed
    // Note: Model blocks currently don't use per-fragment rotation (values 4-7)
    // but we support it for consistency
    int rotValue = int(vTexRotation + 0.5);
    if (rotValue > 0 && rotValue < 4) {
      localUV = rotateUV(localUV, rotValue);
    }
    
    // Clamp UV to valid range
    localUV = clamp(localUV, 0.0, 1.0);
    
    // Calculate tile position from texture index
    float tilesPerRow = uAtlasSize.x;
    float col = mod(vTexIndex, tilesPerRow);
    float row = floor(vTexIndex / tilesPerRow);
    
    // Calculate atlas UV
    // The atlas has 1-pixel borders around each tile to prevent bleeding
    vec2 atlasOffset = vec2(col, row) * uTileUV;
    vec2 atlasUV = atlasOffset + uBorderUV + localUV * uTextureUV;
    
    // Sample texture
    vec4 texColor = texture2D(uAtlas, atlasUV);
    
    // Handle transparency
    if (texColor.a < 0.1) discard;
    
    // Apply biome tinting
    int tintType = int(vTintType + 0.5);
    vec3 tintColor = vec3(1.0);
    
    if (uUseTinting > 0.5 && tintType > 0) {
      tintColor = getBiomeTint(tintType);
    }
    
    finalColor = texColor.rgb * tintColor;
    alpha = texColor.a;
  } else {
    // Use vertex color fallback
    finalColor = vColor;
  }
  
  // Minecraft-style face shading (only applied if shadeFlag is 1.0)
  // Cross-model plants like grass and ferns have shade: false in their model
  float faceShade = 1.0;
  
  if (vShadeFlag > 0.5) {
    vec3 snappedN = snapNormal(vNormal);
    if (abs(snappedN.y) > 0.5) {
      faceShade = snappedN.y > 0.0 ? 1.0 : 0.5;
    } else if (abs(snappedN.x) > 0.5) {
      faceShade = 0.6;
    } else {
      faceShade = 0.8;
    }
  }
  
  // Apply lighting: either from lightmap or fixed face shading
  vec3 lightColor = vec3(1.0);
  if (uUseLightmap > 0.5) {
    // Sample lightmap using light UV
    lightColor = texture2D(uLightmap, vLightUV).rgb;
    // Apply face shading on top of lightmap
    lightColor *= faceShade;
  } else {
    // Use fixed face shading only
    lightColor = vec3(faceShade);
  }
  
  gl_FragColor = vec4(finalColor * lightColor, alpha);
}
`;

/**
 * Create a textured material for model blocks (slabs, stairs, etc.)
 * Uses model UVs instead of triplanar mapping for correct texture on diagonal faces
 * Uses polygon offset to prevent z-fighting with full blocks
 */
export function createTexturedModelMaterial(atlasData = null, useTextures = false, lightmap = null) {
  const { atlas, colormap, hasColormap, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uColormap: { value: colormap },
      uLightmap: { value: lightmap || defaultTexture },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseTinting: { value: hasColormap ? 1.0 : 0.0 },
      uUseLightmap: { value: lightmap ? 1.0 : 0.0 },
      uAtlasSize: { value: size },
      uTileUV: { value: tileUV },
      uTextureUV: { value: textureUV },
      uBorderUV: { value: borderUV },
    },
    vertexShader: modelVertexShader,
    fragmentShader: modelFragmentShader,
    side: THREE.FrontSide, // Use FrontSide for performance - double-sided faces have geometry duplicated with reversed winding
    vertexColors: true,
    transparent: false,    // Opaque models don't need transparency
    depthWrite: true,
  });
  
  return material;
}

/**
 * Create a textured material for transparent model blocks (glass panes, iron bars)
 * Uses single-sided rendering (FrontSide) to prevent back faces from being visible
 * through the transparent surfaces
 */
export function createTransparentModelMaterial(atlasData = null, useTextures = false, lightmap = null) {
  const { atlas, colormap, hasColormap, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uColormap: { value: colormap },
      uLightmap: { value: lightmap || defaultTexture },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseTinting: { value: hasColormap ? 1.0 : 0.0 },
      uUseLightmap: { value: lightmap ? 1.0 : 0.0 },
      uAtlasSize: { value: size },
      uTileUV: { value: tileUV },
      uTextureUV: { value: textureUV },
      uBorderUV: { value: borderUV },
    },
    vertexShader: modelVertexShader,
    fragmentShader: modelFragmentShader,
    side: THREE.FrontSide, // Single-sided to hide back faces through transparent surfaces
    vertexColors: true,
    transparent: true,     // Enable transparency/alpha blending
    depthWrite: true,      // Still write to depth buffer to maintain proper ordering
  });
  
  return material;
}

/**
 * Create a textured material for overlay model blocks (torch bulb glow panels, etc.)
 * Uses depthWrite: false so overlays don't occlude geometry behind them
 * This creates the effect of "glow" faces that appear behind solid geometry
 */
export function createOverlayModelMaterial(atlasData = null, useTextures = false, lightmap = null) {
  const { atlas, colormap, hasColormap, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uColormap: { value: colormap },
      uLightmap: { value: lightmap || defaultTexture },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseTinting: { value: hasColormap ? 1.0 : 0.0 },
      uUseLightmap: { value: lightmap ? 1.0 : 0.0 },
      uAtlasSize: { value: size },
      uTileUV: { value: tileUV },
      uTextureUV: { value: textureUV },
      uBorderUV: { value: borderUV },
    },
    vertexShader: modelVertexShader,
    fragmentShader: modelFragmentShader,
    side: THREE.FrontSide,   // Use FrontSide for performance - overlay elements are single-sided
    vertexColors: true,
    transparent: true,       // Enable transparency for proper blending
    depthWrite: false,       // DON'T write to depth buffer - allows geometry to show through
    depthTest: true,         // Still test against depth so overlays are hidden by blocks in front
  });
  
  return material;
}

/**
 * Toggle lightmap usage on a material
 * @param {THREE.ShaderMaterial} material - The material to update
 * @param {boolean} enabled - Whether to use lightmap (true) or fixed face shading (false)
 */
export function setMaterialLightingEnabled(material, enabled) {
  if (material && material.uniforms && material.uniforms.uUseLightmap) {
    material.uniforms.uUseLightmap.value = enabled ? 1.0 : 0.0;
    material.needsUpdate = true;
  }
}

export default createTexturedMaterial;
