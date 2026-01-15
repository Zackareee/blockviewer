/**
 * EndPortalMaterial - Minecraft End Portal Shader Effect
 * 
 * Exact 1:1 recreation of Minecraft's end portal effect using:
 * - Sampler0: end_sky.png (purple noise) for base layer
 * - Sampler1: end_portal.png (dark starfield) for 15 animated layers
 * 
 * Reference: minecraft_versions/1.21.11_unobfuscated/assets/minecraft/shaders/core/rendertype_end_portal.fsh
 */

import * as THREE from 'three';

// Number of portal layers (from Minecraft - end_gateway uses 15, end_portal uses 16)
const PORTAL_LAYERS = 15;

const vertexShader = `
uniform float uMinY;
uniform float uMaxY;

varying vec4 vTexProj;
varying float vVisible;

// Minecraft's projection_from_position function (from projection.glsl)
// Converts clip-space position to texture projection coordinates
vec4 projection_from_position(vec4 position) {
  vec4 projection = position * 0.5;
  projection.xy = vec2(projection.x + projection.w, projection.y + projection.w);
  projection.zw = position.zw;
  return projection;
}

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  
  // Create texture projection coordinates for screen-space sampling
  vTexProj = projection_from_position(gl_Position);
  
  // Y range culling
  if (position.y < uMinY - 0.01 || position.y > uMaxY + 1.01) {
    vVisible = 0.0;
  } else {
    vVisible = 1.0;
  }
}
`;

const fragmentShader = `
uniform sampler2D uEndSky;    // Sampler0: end_sky.png (purple noise)
uniform sampler2D uEndPortal; // Sampler1: end_portal.png (starfield)
uniform float uGameTime;      // Minecraft's GameTime (0-1 over 20 minutes)
uniform int uPortalLayers;

varying vec4 vTexProj;
varying float vVisible;

// Minecraft's exact portal layer colors (from rendertype_end_portal.fsh)
const vec3 COLORS[16] = vec3[](
  vec3(0.022087, 0.098399, 0.110818),
  vec3(0.011892, 0.095924, 0.089485),
  vec3(0.027636, 0.101689, 0.100326),
  vec3(0.046564, 0.109883, 0.114838),
  vec3(0.064901, 0.117696, 0.097189),
  vec3(0.063761, 0.086895, 0.123646),
  vec3(0.084817, 0.111994, 0.166380),
  vec3(0.097489, 0.154120, 0.091064),
  vec3(0.106152, 0.131144, 0.195191),
  vec3(0.097721, 0.110188, 0.187229),
  vec3(0.133516, 0.138278, 0.148582),
  vec3(0.070006, 0.243332, 0.235792),
  vec3(0.196766, 0.142899, 0.214696),
  vec3(0.047281, 0.315338, 0.321970),
  vec3(0.204675, 0.390010, 0.302066),
  vec3(0.080955, 0.314821, 0.661491)
);

// Minecraft's SCALE_TRANSLATE constant (column-major order for GLSL)
// Original: mat4(0.5, 0.0, 0.0, 0.25, 0.0, 0.5, 0.0, 0.25, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
const mat4 SCALE_TRANSLATE = mat4(
  0.5, 0.0, 0.0, 0.0,
  0.0, 0.5, 0.0, 0.0,
  0.0, 0.0, 1.0, 0.0,
  0.25, 0.25, 0.0, 1.0
);

// Minecraft's mat2_rotate_z function (from matrix.glsl)
mat2 mat2_rotate_z(float radians) {
  return mat2(
    cos(radians), -sin(radians),
    sin(radians), cos(radians)
  );
}

// Minecraft's end_portal_layer function - creates transform for each layer
mat4 end_portal_layer(float layer) {
  // Translation matrix (column-major for GLSL)
  // Original row-major: 1,0,0,17/layer | 0,1,0,(2+layer/1.5)*(GameTime*1.5) | 0,0,1,0 | 0,0,0,1
  mat4 translate = mat4(
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    17.0 / layer, (2.0 + layer / 1.5) * (uGameTime * 1.5), 0.0, 1.0
  );
  
  // Rotation angle (unique per layer)
  mat2 rotate = mat2_rotate_z(radians((layer * layer * 4321.0 + layer * 9.0) * 2.0));
  
  // Scale factor (higher layers = more zoomed out = smaller pattern)
  // mat2(scalar) creates a diagonal matrix
  float s = (4.5 - layer / 4.0) * 2.0;
  mat2 scale = mat2(s, 0.0, 0.0, s);
  
  // Combine scale and rotation
  mat2 scaleRotate = scale * rotate;
  
  // Build 4x4 matrix from 2x2 (mat4(mat2) in Minecraft)
  mat4 sr = mat4(
    scaleRotate[0][0], scaleRotate[0][1], 0.0, 0.0,
    scaleRotate[1][0], scaleRotate[1][1], 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0
  );
  
  return sr * translate * SCALE_TRANSLATE;
}

void main() {
  if (vVisible < 0.5) discard;
  
  // Sample base layer using end_sky.png (Sampler0) with COLORS[0]
  // textureProj divides xy by w automatically
  vec2 baseUV = vTexProj.xy / vTexProj.w;
  vec3 color = texture2D(uEndSky, baseUV).rgb * COLORS[0];
  
  // Add each portal layer using end_portal.png (Sampler1)
  for (int i = 0; i < 15; i++) {
    if (i >= uPortalLayers) break;
    
    float layer = float(i + 1);
    
    // Transform the projection coordinates for this layer
    mat4 layerMat = end_portal_layer(layer);
    vec4 layerProj = layerMat * vTexProj;
    
    // Sample with transformed coordinates using COLORS[i] (not i+1!)
    vec2 layerUV = layerProj.xy / layerProj.w;
    vec3 layerColor = texture2D(uEndPortal, layerUV).rgb * COLORS[i];
    color += layerColor;
  }
  
  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * Create the end portal material
 * @param {number} portalLayers - Number of layers (15 for gateway, 16 for portal)
 */
export function createEndPortalMaterial(portalLayers = PORTAL_LAYERS) {
  // Create placeholder textures (will be replaced when real textures load)
  // Dark gray placeholder
  const placeholderData = new Uint8Array([16, 16, 16, 255]);
  const placeholderTexture = new THREE.DataTexture(placeholderData, 1, 1, THREE.RGBAFormat);
  placeholderTexture.needsUpdate = true;
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uEndSky: { value: placeholderTexture },    // Sampler0: end_sky.png
      uEndPortal: { value: placeholderTexture }, // Sampler1: end_portal.png
      uGameTime: { value: 0.0 },                 // Minecraft GameTime (0-1 over 20 min)
      uPortalLayers: { value: portalLayers },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  
  return material;
}

/**
 * Update the end portal textures
 * @param {THREE.ShaderMaterial} material - The end portal material
 * @param {THREE.Texture} endSkyTexture - end_sky.png texture
 * @param {THREE.Texture} endPortalTexture - end_portal.png texture
 */
export function updateEndPortalTextures(material, endSkyTexture, endPortalTexture) {
  if (!material?.uniforms) return;
  
  // Configure both textures for tiling
  [endSkyTexture, endPortalTexture].forEach(texture => {
    if (texture) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      // Use linear color space (don't apply sRGB conversion)
      texture.colorSpace = THREE.LinearSRGBColorSpace;
    }
  });
  
  if (endSkyTexture && material.uniforms.uEndSky) {
    material.uniforms.uEndSky.value = endSkyTexture;
  }
  if (endPortalTexture && material.uniforms.uEndPortal) {
    material.uniforms.uEndPortal.value = endPortalTexture;
  }
  
  material.needsUpdate = true;
}

// Legacy function for backwards compatibility
export function updateEndPortalTexture(material, texture) {
  if (material?.uniforms?.uEndSky) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    material.uniforms.uEndSky.value = texture;
    material.needsUpdate = true;
  }
}

/**
 * Set Y range for the material
 */
export function setEndPortalYRange(material, minY, maxY) {
  if (material?.uniforms) {
    if (material.uniforms.uMinY) material.uniforms.uMinY.value = minY;
    if (material.uniforms.uMaxY) material.uniforms.uMaxY.value = maxY;
  }
}

export default createEndPortalMaterial;
