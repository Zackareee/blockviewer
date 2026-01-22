/**
 * DataTextureMaterial - Shader material for DataTexture-based unified rendering
 * 
 * This material reads vertex data from DataTextures instead of vertex attributes.
 * Used for Option C: Single-draw-call rendering of all geometry.
 * 
 * The vertex shader fetches:
 * - Position from positionTexture (RGBA32F: xyz + objectID)
 * - Normals and attributes from attributeTexture (RGBA32F)
 * - UVs from uvTexture (RG32F)
 * - Per-object transform from objectMatrixTexture (RGBA32F)
 * - Visibility from visibilityTexture (R8)
 * 
 * This allows rendering millions of vertices in a single draw call.
 */

import * as THREE from 'three';

// Vertex shader that reads from DataTextures
const vertexShader = `
// DataTextures containing geometry
uniform sampler2D uPositionTex;      // xyz position + objectID
uniform sampler2D uAttributeTex;     // normal xyz + packed attrs
uniform sampler2D uUVTex;            // model UVs
uniform sampler2D uObjectMatrixTex;  // per-object transforms (4 rows per object)
uniform sampler2D uVisibilityTex;    // per-object visibility

// Texture dimensions
uniform vec2 uGeoTexSize;            // Position/attribute texture size (e.g., 4096x4096)
uniform vec2 uMatrixTexSize;         // Matrix texture size (256x1024)
uniform vec2 uVisTexSize;            // Visibility texture size (256x256)

// Standard uniforms
uniform float uMinY;
uniform float uMaxY;

// Outputs to fragment shader
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vModelUV;
varying float vTexIndex;
varying float vTexRotation;
varying float vTintType;
varying vec2 vLightUV;
varying float vVisible;
varying float vVertexDistance;

// Helper to compute texel coords from vertex index
ivec2 getTexelCoord(int idx, vec2 texSize) {
  return ivec2(idx % int(texSize.x), idx / int(texSize.x));
}

void main() {
  // Get vertex index from gl_VertexID (requires GLSL 3.0 / WebGL 2.0)
  int vertexID = gl_VertexID;
  
  // Fetch position data
  ivec2 posCoord = getTexelCoord(vertexID, uGeoTexSize);
  vec4 posData = texelFetch(uPositionTex, posCoord, 0);
  vec3 localPos = posData.xyz;
  int objectID = int(posData.w);
  
  // Check visibility
  ivec2 visCoord = ivec2(objectID % int(uVisTexSize.x), objectID / int(uVisTexSize.x));
  float visibility = texelFetch(uVisibilityTex, visCoord, 0).r;
  
  if (visibility < 0.5) {
    // Object is culled - move vertex off-screen
    gl_Position = vec4(0.0, 0.0, -1000.0, 1.0);
    vVisible = 0.0;
    return;
  }
  
  // Fetch object matrix (4 texels per object)
  int matrixBase = objectID * 4;
  ivec2 matCoord0 = ivec2(matrixBase % int(uMatrixTexSize.x), (matrixBase / int(uMatrixTexSize.x)) * 4);
  ivec2 matCoord1 = matCoord0 + ivec2(0, 1);
  ivec2 matCoord2 = matCoord0 + ivec2(0, 2);
  ivec2 matCoord3 = matCoord0 + ivec2(0, 3);
  
  vec4 matRow0 = texelFetch(uObjectMatrixTex, matCoord0, 0);
  vec4 matRow1 = texelFetch(uObjectMatrixTex, matCoord1, 0);
  vec4 matRow2 = texelFetch(uObjectMatrixTex, matCoord2, 0);
  vec4 matRow3 = texelFetch(uObjectMatrixTex, matCoord3, 0);
  
  mat4 objectMatrix = mat4(matRow0, matRow1, matRow2, matRow3);
  
  // Transform to world space
  vec4 worldPos4 = objectMatrix * vec4(localPos, 1.0);
  vWorldPos = worldPos4.xyz;
  
  // Fetch attribute data
  vec4 attrData = texelFetch(uAttributeTex, posCoord, 0);
  vNormal = attrData.xyz;
  
  // Unpack attributes from attrData.w
  int packed = floatBitsToInt(attrData.w);
  vTexIndex = float((packed >> 16) & 0xFFFF);
  vTintType = float((packed >> 12) & 0xF);
  vTexRotation = float((packed >> 10) & 0x3);
  float skyLight = float((packed >> 6) & 0xF);
  float blockLight = float((packed >> 2) & 0xF);
  vLightUV = vec2((blockLight + 0.5) / 16.0, (skyLight + 0.5) / 16.0);
  
  // Fetch UV data
  vec2 uvData = texelFetch(uUVTex, posCoord, 0).xy;
  vModelUV = uvData;
  
  // Y range visibility check
  if (vWorldPos.y < uMinY - 0.01 || vWorldPos.y > uMaxY + 1.01) {
    vVisible = 0.0;
  } else {
    vVisible = 1.0;
  }
  
  // Calculate horizontal distance for fog
  vec2 horizDiff = cameraPosition.xz - vWorldPos.xz;
  vVertexDistance = length(horizDiff);
  
  // Final position
  gl_Position = projectionMatrix * viewMatrix * worldPos4;
}
`;

// Simplified fragment shader (ported from TexturedMaterial)
const fragmentShader = `
precision highp float;

// Texture uniforms
uniform sampler2D uAtlas;
uniform sampler2D uLightmap;
uniform sampler2D uColormap;

// Material settings
uniform float uUseTextures;
uniform float uUseLightmap;
uniform float uUseTinting;

// Atlas configuration
uniform vec2 uAtlasSize;
uniform vec2 uTileUV;
uniform vec2 uTextureUV;
uniform vec2 uBorderUV;

// Fog
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogEnabled;

// Inputs from vertex shader
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vModelUV;
varying float vTexIndex;
varying float vTexRotation;
varying float vTintType;
varying vec2 vLightUV;
varying float vVisible;
varying float vVertexDistance;

// Tint colors
const vec3 SPRUCE_TINT = vec3(0.380, 0.600, 0.380);
const vec3 BIRCH_TINT = vec3(0.502, 0.655, 0.333);
const vec3 WATER_TINT = vec3(0.247, 0.463, 0.894);

// Snap normal to axis
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

// Get UV for triplanar mapping
vec2 getTriplanarUV(vec3 worldPos, vec3 normal) {
  vec3 n = snapNormal(normal);
  vec3 p = fract(worldPos);
  
  if (abs(n.y) > 0.5) {
    return n.y > 0.0 ? vec2(p.x, 1.0 - p.z) : vec2(p.x, p.z);
  } else if (abs(n.x) > 0.5) {
    return n.x > 0.0 ? vec2(1.0 - p.z, 1.0 - p.y) : vec2(p.z, 1.0 - p.y);
  } else {
    return n.z > 0.0 ? vec2(p.x, 1.0 - p.y) : vec2(1.0 - p.x, 1.0 - p.y);
  }
}

// Rotate UV by 90 degree increments
vec2 rotateUV(vec2 uv, int rot) {
  vec2 centered = uv - 0.5;
  if (rot == 1) {
    centered = vec2(centered.y, -centered.x);
  } else if (rot == 2) {
    centered = -centered;
  } else if (rot == 3) {
    centered = vec2(-centered.y, centered.x);
  }
  return clamp(centered + 0.5, 0.0, 1.0);
}

// Sample colormap for biome tinting
vec3 sampleColormap(int tintType) {
  if (tintType == 3) return SPRUCE_TINT;
  if (tintType == 4) return BIRCH_TINT;
  if (tintType == 5) return WATER_TINT;
  
  float temp = 0.8;
  float downfall = 0.4;
  float u = 1.0 - temp;
  float v;
  
  if (tintType == 1) { // Grass
    v = (1.0 - downfall * temp) * 0.5;
  } else { // Foliage
    v = 0.5 + (1.0 - downfall * temp) * 0.5;
  }
  
  return texture2D(uColormap, vec2(u, v)).rgb;
}

// Linear fog
float linearFog(float distance, float fogStart, float fogEnd) {
  return clamp((distance - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
}

void main() {
  if (vVisible < 0.5) discard;
  
  vec3 finalColor;
  float alpha = 1.0;
  
  if (uUseTextures > 0.5) {
    // Get local UV within block face
    vec2 localUV = getTriplanarUV(vWorldPos, vNormal);
    
    // Apply rotation
    int rotValue = int(vTexRotation + 0.5);
    if (rotValue > 0 && rotValue < 4) {
      localUV = rotateUV(localUV, rotValue);
    }
    
    // Calculate atlas UV
    float tilesPerRow = uAtlasSize.x;
    float tileX = mod(vTexIndex, tilesPerRow);
    float tileY = floor(vTexIndex / tilesPerRow);
    
    vec2 tileBase = vec2(tileX, tileY) * uTileUV;
    vec2 atlasUV = tileBase + uBorderUV + localUV * uTextureUV;
    
    // Sample atlas
    vec4 texColor = texture2D(uAtlas, atlasUV);
    finalColor = texColor.rgb;
    alpha = texColor.a;
    
    if (alpha < 0.01) discard;
    
    // Apply biome tinting
    if (uUseTinting > 0.5) {
      int tintType = int(vTintType + 0.5);
      if (tintType > 0 && tintType <= 5) {
        vec3 tint = sampleColormap(tintType);
        finalColor *= tint;
      }
    }
  } else {
    finalColor = vec3(0.8);
  }
  
  // Apply lightmap
  if (uUseLightmap > 0.5) {
    vec3 light = texture2D(uLightmap, vLightUV).rgb;
    finalColor *= light;
  } else {
    // Simple directional shading
    vec3 n = snapNormal(vNormal);
    float shade = n.y > 0.5 ? 1.0 : (n.y < -0.5 ? 0.5 : (abs(n.x) > 0.5 ? 0.8 : 0.6));
    finalColor *= shade;
  }
  
  // Apply fog
  if (uFogEnabled > 0.5) {
    float fogFactor = linearFog(vVertexDistance, uFogStart, uFogEnd);
    finalColor = mix(finalColor, uFogColor, fogFactor);
  }
  
  gl_FragColor = vec4(finalColor, alpha);
}
`;

/**
 * Create a DataTextureMaterial for unified rendering
 */
export function createDataTextureMaterial(options = {}) {
  const {
    geometryTextureManager,
    atlas,
    lightmap,
    colormap,
    atlasSize = { width: 56, height: 56 },
    tileSize = 18,
    textureSize = 16,
    borderSize = 1,
    fogColor = new THREE.Color(0x87CEEB),
    fogStart = 80,
    fogEnd = 160,
    fogEnabled = true,
    useTextures = true,
    useLightmap = true,
    useTinting = true,
    minY = -64,
    maxY = 320,
  } = options;

  const textures = geometryTextureManager.getTextures();
  const tileUV = 1.0 / atlasSize.width * (tileSize / textureSize);
  const textureUV = 1.0 / atlasSize.width;
  const borderUV = 1.0 / atlasSize.width * (borderSize / textureSize);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      // Geometry textures
      uPositionTex: { value: textures.positionTexture },
      uAttributeTex: { value: textures.attributeTexture },
      uUVTex: { value: textures.uvTexture },
      uObjectMatrixTex: { value: textures.objectMatrixTexture },
      uVisibilityTex: { value: textures.visibilityTexture },
      
      // Texture sizes
      uGeoTexSize: { value: new THREE.Vector2(geometryTextureManager.textureWidth, geometryTextureManager.textureHeight) },
      uMatrixTexSize: { value: new THREE.Vector2(256, 256 * 4) },
      uVisTexSize: { value: new THREE.Vector2(256, 256) },
      
      // Atlas textures
      uAtlas: { value: atlas },
      uLightmap: { value: lightmap },
      uColormap: { value: colormap },
      
      // Atlas settings
      uAtlasSize: { value: new THREE.Vector2(atlasSize.width, atlasSize.height) },
      uTileUV: { value: new THREE.Vector2(tileUV, tileUV) },
      uTextureUV: { value: new THREE.Vector2(textureUV, textureUV) },
      uBorderUV: { value: new THREE.Vector2(borderUV, borderUV) },
      
      // Material settings
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseLightmap: { value: useLightmap ? 1.0 : 0.0 },
      uUseTinting: { value: useTinting ? 1.0 : 0.0 },
      
      // Y range
      uMinY: { value: minY },
      uMaxY: { value: maxY },
      
      // Fog
      uFogColor: { value: fogColor },
      uFogStart: { value: fogStart },
      uFogEnd: { value: fogEnd },
      uFogEnabled: { value: fogEnabled ? 1.0 : 0.0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    // Enable GLSL 3.0 for gl_VertexID
    glslVersion: THREE.GLSL3,
  });

  return material;
}

/**
 * Create a dummy geometry for DataTexture rendering
 * The geometry just needs enough vertices - actual positions come from textures
 */
export function createDummyGeometry(vertexCount) {
  const geometry = new THREE.BufferGeometry();
  
  // Create a position attribute with dummy data
  // The vertex shader ignores this and reads from textures instead
  const positions = new Float32Array(vertexCount * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  
  // Set draw range
  geometry.setDrawRange(0, vertexCount);
  
  // Disable frustum culling (we do our own via visibility texture)
  return geometry;
}

/**
 * DataTextureMaterial class for easier management
 */
export class DataTextureMaterial extends THREE.ShaderMaterial {
  constructor(options = {}) {
    const material = createDataTextureMaterial(options);
    super({
      uniforms: material.uniforms,
      vertexShader: material.vertexShader,
      fragmentShader: material.fragmentShader,
      side: material.side,
      transparent: material.transparent,
      depthWrite: material.depthWrite,
      depthTest: material.depthTest,
      glslVersion: material.glslVersion,
    });
    
    this.geometryTextureManager = options.geometryTextureManager;
  }
  
  /**
   * Update draw range based on current vertex count
   */
  updateDrawRange(geometry) {
    const count = this.geometryTextureManager.getTotalVertexCount();
    geometry.setDrawRange(0, count);
  }
  
  /**
   * Update fog settings
   */
  setFog(color, start, end, enabled = true) {
    this.uniforms.uFogColor.value.copy(color);
    this.uniforms.uFogStart.value = start;
    this.uniforms.uFogEnd.value = end;
    this.uniforms.uFogEnabled.value = enabled ? 1.0 : 0.0;
  }
  
  /**
   * Update Y range
   */
  setYRange(minY, maxY) {
    this.uniforms.uMinY.value = minY;
    this.uniforms.uMaxY.value = maxY;
  }
}
