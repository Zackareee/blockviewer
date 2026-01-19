/**
 * EntityMaterial - Shader material for rendering block entities
 * 
 * This material is designed for block entities (chests, beds, signs, skulls, etc.)
 * which use the entity texture atlas instead of the block atlas.
 * 
 * Key differences from TexturedMaterial:
 * - Uses entity texture atlas with variable-size textures
 * - No biome tinting (entities have fixed colors)
 * - UVs are pre-baked per-vertex (no triplanar calculation)
 * - Simpler shader with just lighting and fog
 */

import * as THREE from 'three';

const vertexShader = `
uniform float uMinY;
uniform float uMaxY;

attribute float texIndex;    // Texture index in entity atlas
attribute float skyLight;    // Sky light level (0-15)
attribute float blockLight;  // Block light level (0-15)

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vUV;
varying float vVisible;
varying float vTexIndex;
varying vec2 vLightUV;
varying float vVertexDistance;

void main() {
  vColor = color;
  vNormal = normalize(normal);
  vWorldPos = position;
  vUV = uv;
  vTexIndex = texIndex;
  
  // Pack light values as UV for lightmap sampling
  vLightUV = vec2((blockLight + 0.5) / 16.0, (skyLight + 0.5) / 16.0);
  
  // Calculate horizontal distance from camera for fog
  vec2 horizDiff = cameraPosition.xz - position.xz;
  vVertexDistance = length(horizDiff);
  
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  
  // Y-slice visibility
  if (position.y < uMinY - 0.01 || position.y > uMaxY + 1.01) {
    vVisible = 0.0;
  } else {
    vVisible = 1.0;
  }
}
`;

const fragmentShader = `
uniform sampler2D uAtlas;        // Entity texture atlas
uniform sampler2D uLightmap;     // 16x16 lightmap texture
uniform vec2 uAtlasSize;         // Atlas dimensions in pixels
uniform float uUseLightmap;      // 0.0 = fixed face shading, 1.0 = use lightmap
uniform float uUseTextures;      // 0.0 = vertex colors only, 1.0 = use textures

// Entity texture UV data - per texture (up to 256 textures)
uniform vec4 uTextureUVs[64];    // (u, v, uSize, vSize) for each texture

// Fog uniforms
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogEnabled;

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vUV;
varying float vVisible;
varying float vTexIndex;
varying vec2 vLightUV;
varying float vVertexDistance;

// Face shading based on normal (Minecraft-style)
float getFaceShading(vec3 normal) {
  vec3 absNormal = abs(normal);
  
  // Determine dominant axis
  if (absNormal.y > absNormal.x && absNormal.y > absNormal.z) {
    // Up/Down faces
    return normal.y > 0.0 ? 1.0 : 0.5;
  } else if (absNormal.x > absNormal.z) {
    // East/West faces
    return 0.8;
  } else {
    // North/South faces
    return 0.6;
  }
}

void main() {
  // Y-slice culling
  if (vVisible < 0.5) {
    discard;
  }
  
  vec4 texColor = vec4(1.0);
  
  // Sample entity texture if enabled
  if (uUseTextures > 0.5 && vTexIndex >= 0.0) {
    int texIdx = int(vTexIndex + 0.5);
    
    // Get UV data for this texture (packed in vec4 array)
    vec4 uvData = uTextureUVs[texIdx];
    
    // Map vertex UV [0,1] to atlas UV
    vec2 atlasUV = uvData.xy + vUV * uvData.zw;
    
    texColor = texture2D(uAtlas, atlasUV);
    
    // Discard fully transparent pixels
    if (texColor.a < 0.5) {
      discard;
    }
  }
  
  // Apply vertex color if no texture or as base
  vec3 finalColor = texColor.rgb;
  if (uUseTextures < 0.5) {
    finalColor = vColor;
  }
  
  // Apply lighting
  float lightFactor = 1.0;
  
  if (uUseLightmap > 0.5) {
    // Sample lightmap
    vec4 lightSample = texture2D(uLightmap, vLightUV);
    lightFactor = lightSample.r;
  }
  
  // Apply face shading
  float faceShade = getFaceShading(vNormal);
  lightFactor *= faceShade;
  
  finalColor *= lightFactor;
  
  // Apply fog
  if (uFogEnabled > 0.5) {
    float fogFactor = clamp((vVertexDistance - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
    finalColor = mix(finalColor, uFogColor, fogFactor);
  }
  
  gl_FragColor = vec4(finalColor, texColor.a);
}
`;

/**
 * Create a material for block entities
 * @param {THREE.Texture} atlasTexture - Entity atlas texture
 * @param {THREE.Texture} lightmapTexture - Lightmap texture
 * @param {Array} textureUVs - UV data for each texture [ [u, v, uSize, vSize], ... ]
 * @param {Object} options - Additional options
 * @returns {THREE.ShaderMaterial}
 */
export function createEntityMaterial(atlasTexture, lightmapTexture, textureUVs = [], options = {}) {
  const {
    fogColor = new THREE.Color(0x87CEEB),
    fogStart = 100,
    fogEnd = 200,
    fogEnabled = false,
    useLightmap = true,
    minY = -64,
    maxY = 320,
    atlasSize = [1024, 1024],
  } = options;
  
  // Prepare UV uniform array (max 64 textures in uniform array)
  const uvArray = new Float32Array(64 * 4);
  for (let i = 0; i < Math.min(textureUVs.length, 64); i++) {
    const uv = textureUVs[i];
    if (!uv) continue;
    // Handle both array format [u, v, uSize, vSize] and object format {u, v, uSize, vSize}
    if (Array.isArray(uv)) {
      uvArray[i * 4 + 0] = uv[0]; // u
      uvArray[i * 4 + 1] = uv[1]; // v
      uvArray[i * 4 + 2] = uv[2]; // uSize
      uvArray[i * 4 + 3] = uv[3]; // vSize
    } else {
      uvArray[i * 4 + 0] = uv.u ?? 0;
      uvArray[i * 4 + 1] = uv.v ?? 0;
      uvArray[i * 4 + 2] = uv.uSize ?? 1;
      uvArray[i * 4 + 3] = uv.vSize ?? 1;
    }
  }
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlasTexture },
      uLightmap: { value: lightmapTexture },
      uAtlasSize: { value: new THREE.Vector2(atlasSize[0], atlasSize[1]) },
      uTextureUVs: { value: uvArray },
      uUseTextures: { value: atlasTexture ? 1.0 : 0.0 },
      uUseLightmap: { value: useLightmap ? 1.0 : 0.0 },
      uMinY: { value: minY },
      uMaxY: { value: maxY },
      uFogColor: { value: fogColor },
      uFogStart: { value: fogStart },
      uFogEnd: { value: fogEnd },
      uFogEnabled: { value: fogEnabled ? 1.0 : 0.0 },
    },
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: false,
    side: THREE.FrontSide,
    depthWrite: true,
    depthTest: true,
  });
  
  return material;
}

/**
 * Update Y-slice uniforms for entity material
 * @param {THREE.ShaderMaterial} material
 * @param {number} minY
 * @param {number} maxY
 */
export function updateEntityMaterialYSlice(material, minY, maxY) {
  if (material && material.uniforms) {
    material.uniforms.uMinY.value = minY;
    material.uniforms.uMaxY.value = maxY;
  }
}

/**
 * Update fog uniforms for entity material
 * @param {THREE.ShaderMaterial} material
 * @param {THREE.Color} color
 * @param {number} start
 * @param {number} end
 * @param {boolean} enabled
 */
export function updateEntityMaterialFog(material, color, start, end, enabled) {
  if (material && material.uniforms) {
    material.uniforms.uFogColor.value.copy(color);
    material.uniforms.uFogStart.value = start;
    material.uniforms.uFogEnd.value = end;
    material.uniforms.uFogEnabled.value = enabled ? 1.0 : 0.0;
  }
}

export default {
  createEntityMaterial,
  updateEntityMaterialYSlice,
  updateEntityMaterialFog,
};
