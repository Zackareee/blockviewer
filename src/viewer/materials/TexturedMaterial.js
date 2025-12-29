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

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vVisible;
varying float vTexIndex;
varying float vTexRotation;

void main() {
  vColor = color;
  vNormal = normal; // Pass object-space normal (will be snapped in fragment shader)
  vWorldPos = position; // World position for UV calculation
  vTexIndex = texIndex;
  vTexRotation = texRotation;
  
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
uniform float uUseTextures;      // 0.0 = vertex colors only, 1.0 = use textures
uniform vec2 uAtlasSize;         // Atlas dimensions in tiles (e.g., 56x56)
uniform vec2 uTileUV;            // Full tile size in UV space (includes 1px border)
uniform vec2 uTextureUV;         // Usable texture size in UV space (16x16 area)
uniform vec2 uBorderUV;          // Border offset in UV space (1px)

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vVisible;
varying float vTexIndex;
varying float vTexRotation;

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
vec2 rotateUV(vec2 uv, float rotation) {
  // Rotation around center (0.5, 0.5)
  vec2 centered = uv - 0.5;
  int rot = int(mod(rotation + 0.5, 4.0)); // Add 0.5 to round to nearest int
  
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

// Get UV coordinates for a face based on world position and normal (triplanar)
// Ensures consistent texture orientation: textures appear right-side up on all faces
// Uses snapped normal to prevent interpolation artifacts at sharp viewing angles
vec2 getTriplanarUV(vec3 worldPos, vec3 normal) {
  // Snap normal to nearest axis - critical for preventing smearing at sharp angles
  vec3 snapped = snapNormal(normal);
  vec3 absNormal = abs(snapped);
  
  vec2 uv;
  bool flipV = false;
  
  // Top/bottom faces (Y-axis dominant)
  if (absNormal.y >= absNormal.x && absNormal.y >= absNormal.z) {
    // Looking down: X goes right, Z goes forward
    uv = vec2(worldPos.x, worldPos.z);
    // Flip V for bottom face
    if (snapped.y < 0.0) {
      flipV = true;
    }
  }
  // East/West faces (X-axis dominant)
  else if (absNormal.x >= absNormal.z) {
    // For X-facing faces: Z horizontal, Y vertical
    uv = vec2(worldPos.z, worldPos.y);
    // Texture needs to be flipped vertically (V=0 at top, world Y goes up)
    flipV = true;
  }
  // North/South faces (Z-axis dominant)
  else {
    // For Z-facing faces: X horizontal, Y vertical
    uv = vec2(worldPos.x, worldPos.y);
    // Texture needs to be flipped vertically
    flipV = true;
  }
  
  // Get per-block fractional UV (0-1 range per block)
  // fract() gives us a value in [0, 1) for any input
  uv = fract(uv);
  
  // Apply vertical flip for side faces and bottom face
  // Minecraft textures have V=0 at top, world Y increases upward
  // We need to invert V so the texture appears right-side up
  if (flipV) {
    // Direct subtraction: 0.0 -> 1.0, 0.5 -> 0.5, 0.999 -> 0.001
    uv.y = 1.0 - uv.y;
  }
  
  // Clamp to valid UV range [0, 1] to prevent any edge case smearing
  // This handles floating point precision issues at block boundaries
  return clamp(uv, 0.0, 1.0);
}

void main() {
  if (vVisible < 0.5) discard;
  
  vec3 finalColor;
  float alpha = 1.0;
  
  if (uUseTextures > 0.5) {
    // Get the local UV within a single block face (0-1 per block)
    vec2 localUV = getTriplanarUV(vWorldPos, vNormal);
    
    // Apply texture rotation if needed (for rotated blocks like horizontal logs)
    // Only apply rotation for valid non-zero rotation values (most blocks have rotation=0)
    // Check for valid range to avoid NaN or garbage values
    if (vTexRotation > 0.5 && vTexRotation < 3.5) {
      float safeRotation = floor(vTexRotation + 0.5); // Round to nearest integer
      localUV = rotateUV(localUV, safeRotation);
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
    // Then map localUV (0-1) to the texture area with a small inset to prevent bleeding
    vec2 inset = uTextureUV * 0.02; // 2% inset to prevent edge bleeding
    vec2 atlasUV = atlasOffset + uBorderUV + inset + localUV * (uTextureUV - inset * 2.0);
    
    // Sample the texture
    vec4 texColor = texture2D(uAtlas, atlasUV);
    
    // Handle transparency
    if (texColor.a < 0.1) discard;
    
    // Combine texture with vertex color for biome tinting
    // For most blocks: mostly texture, subtle color influence for biome variation
    // vColor is the block's characteristic color which can provide biome tinting
    finalColor = texColor.rgb * (vColor * 0.3 + 0.7);
    alpha = texColor.a;
  } else {
    // Use vertex color fallback (solid color mode)
    finalColor = vColor;
  }
  
  // Simple directional lighting using snapped normal for consistent per-face brightness
  vec3 snappedN = snapNormal(vNormal);
  vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
  float diff = max(dot(snappedN, lightDir), 0.0);
  
  // Ambient + diffuse
  vec3 ambient = finalColor * 0.4;
  vec3 diffuse = finalColor * diff * 0.6;
  
  gl_FragColor = vec4(ambient + diffuse, alpha);
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
  let size = new THREE.Vector2(32, 32);
  let tileUV = new THREE.Vector2(1/32, 1/32);     // Default: 1 tile = 1/32 of atlas
  let textureUV = new THREE.Vector2(1/32, 1/32);  // Same as tileUV for simple case
  let borderUV = new THREE.Vector2(0, 0);         // No border for simple case
  
  if (atlasData) {
    if (atlasData.atlas) {
      atlas = atlasData.atlas;
      if (atlasData.size) size.set(atlasData.size.x, atlasData.size.y);
      else if (atlasData.tilesPerRow) size.set(atlasData.tilesPerRow, atlasData.tilesPerCol || atlasData.tilesPerRow);
      
      // Use precise UV sizes if available
      if (atlasData.tileUV) tileUV.set(atlasData.tileUV.x, atlasData.tileUV.y);
      if (atlasData.textureUV) textureUV.set(atlasData.textureUV.x, atlasData.textureUV.y);
      if (atlasData.borderUV) borderUV.set(atlasData.borderUV.x, atlasData.borderUV.y);
    } else if (atlasData.isTexture) {
      // Old format: THREE.Texture
      atlas = atlasData;
    }
  }
  
  return { atlas, size, tileUV, textureUV, borderUV };
}

/**
 * Create a textured solid block material
 * @param {Object|THREE.Texture} atlasData - Material data { atlas, size, textureIndexLookup, tilesPerRow, tilesPerCol, tileUV, textureUV, borderUV } or legacy texture
 * @param {boolean} useTextures - Whether to use textures (false = vertex colors only)
 */
export function createTexturedMaterial(atlasData = null, useTextures = false) {
  const { atlas, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
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
export function createTexturedGlassMaterial(atlasData = null, useTextures = false) {
  const { atlas, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uAtlasSize: { value: size },
      uTileUV: { value: tileUV },
      uTextureUV: { value: textureUV },
      uBorderUV: { value: borderUV },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  
  return material;
}

/**
 * Update material's texture atlas
 * @param {THREE.ShaderMaterial} material - The material to update
 * @param {Object} atlasData - { atlas: THREE.Texture, size: {x, y}, tilesPerRow, tilesPerCol, tileUV, textureUV, borderUV }
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

/**
 * Create a textured material for model blocks (slabs, stairs, etc.)
 * Uses polygon offset to prevent z-fighting with full blocks
 */
export function createTexturedModelMaterial(atlasData = null, useTextures = false) {
  const { atlas, size, tileUV, textureUV, borderUV } = getAtlasUniforms(atlasData);
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uAtlas: { value: atlas },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
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
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  
  return material;
}

export default createTexturedMaterial;

