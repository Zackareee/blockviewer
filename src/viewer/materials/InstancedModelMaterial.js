/**
 * InstancedModelMaterial - GPU-instanced rendering for repeated partial blocks
 * 
 * For blocks like short_grass, flowers, etc. that have many instances of the same geometry,
 * this uses GPU instancing to dramatically reduce draw call overhead and vertex processing.
 * 
 * Instead of baking N copies of geometry (4*N vertices), we render 1 geometry N times
 * with per-instance attributes for position, rotation, tint, and lighting.
 */

import * as THREE from 'three';

// Vertex shader for instanced cross-pattern blocks
const instancedVertexShader = `
// Per-vertex attributes (from base geometry)
attribute vec2 modelUV;
attribute float texIndex;
attribute vec3 instanceNormal;  // Pre-computed normal for the base geometry

// Per-instance attributes
attribute vec3 instanceOffset;     // World position offset
attribute float instanceRotation;  // Y-axis rotation (0-3 for 90° increments)
attribute float instanceTintType;  // Biome tint type
attribute vec2 instanceLight;      // (blockLight, skyLight)

// Uniforms
uniform float uMinY;
uniform float uMaxY;
uniform float uMaxDistance;

// Varyings
varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vModelUV;
varying float vTexIndex;
varying float vTintType;
varying vec2 vLightUV;
varying float vVisible;

// Rotation matrices for Y-axis rotation (0, 90, 180, 270 degrees)
mat3 getRotationMatrix(float rotIndex) {
  float angle = rotIndex * 1.5707963267948966; // PI/2
  float c = cos(angle);
  float s = sin(angle);
  return mat3(
    c, 0.0, s,
    0.0, 1.0, 0.0,
    -s, 0.0, c
  );
}

void main() {
  // Apply Y-axis rotation around block center (0.5, 0.5)
  mat3 rotMat = getRotationMatrix(instanceRotation);
  vec3 centeredPos = position - vec3(0.5, 0.0, 0.5);
  vec3 rotatedPos = rotMat * centeredPos + vec3(0.5, 0.0, 0.5);
  
  // Add instance offset (world position)
  vec3 worldPos = rotatedPos + instanceOffset;
  
  // Y-range visibility check
  if (worldPos.y < uMinY - 0.01 || worldPos.y > uMaxY + 1.01) {
    vVisible = 0.0;
    gl_Position = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  
  // Distance culling
  float distToCamera = length(cameraPosition - worldPos);
  if (uMaxDistance > 0.0 && distToCamera > uMaxDistance) {
    vVisible = 0.0;
    gl_Position = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  
  vVisible = 1.0;
  
  // Transform position
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  
  // Rotate normal
  vNormal = rotMat * instanceNormal;
  
  // Pass through UV and texture info
  vModelUV = modelUV;
  vTexIndex = texIndex;
  vTintType = instanceTintType;
  
  // Light UV for lightmap sampling
  vLightUV = vec2((instanceLight.x + 0.5) / 16.0, (instanceLight.y + 0.5) / 16.0);
  
  // Default vertex color (white - textures provide color)
  vColor = vec3(1.0, 1.0, 1.0);
}
`;

// Fragment shader - similar to regular model shader
const instancedFragmentShader = `
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uColormap;
uniform sampler2D uLightmap;
uniform sampler2D uAnimationData;
uniform sampler2D uFrameSequence;
uniform float uUseTextures;
uniform float uUseTinting;
uniform float uUseLighting;
uniform float uTime;
uniform float uTotalTiles;
uniform float uSequenceLength;

// Atlas info - matching TexturedMaterial format
uniform float uTilesPerRow;
uniform float uTileFullSize;  // Full tile size in UV (includes border)
uniform float uTextureSize;   // Usable texture size in UV (16px)
uniform float uBorderSize;    // Border offset in UV (1px)

varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vModelUV;
varying float vTexIndex;
varying float vTintType;
varying vec2 vLightUV;
varying float vVisible;

// Calculate animated texture index based on time
// Uses frame sequence texture to support custom frame orders
float getAnimatedTexIndex(float texIndex) {
  if (uTotalTiles <= 0.0) return texIndex;
  
  // Sample animation data: (sequenceStart, cycleLength, frametime, interpolate)
  float u = (texIndex + 0.5) / uTotalTiles;
  vec4 animData = texture2D(uAnimationData, vec2(u, 0.5));
  
  float sequenceStart = animData.r;
  float cycleLength = animData.g;
  float frametime = animData.b;
  
  if (cycleLength <= 1.0) return texIndex;
  
  float ticks = uTime * 20.0;
  float ticksPerCycle = frametime * cycleLength;
  float cycleTicks = mod(ticks, ticksPerCycle);
  float currentCycleFrame = floor(cycleTicks / frametime);
  
  // Look up actual atlas index from frame sequence texture
  float seqIndex = sequenceStart + currentCycleFrame;
  float seqU = (seqIndex + 0.5) / uSequenceLength;
  float atlasIndex = texture2D(uFrameSequence, vec2(seqU, 0.5)).r;
  
  return atlasIndex;
}

vec3 getBiomeTint(int tintType) {
  // Sample from colormap for biome-tinted blocks
  // Use plains biome coords: temp=0.8, downfall=0.4
  float temp = 0.8;
  float downfall = 0.4;
  float adjustedDownfall = downfall * temp;
  float u = 1.0 - temp;
  float v = 1.0 - adjustedDownfall;
  
  if (tintType == 1) {
    // Grass tint - top half of colormap
    return texture2D(uColormap, vec2(u, v * 0.5)).rgb;
  } else if (tintType == 2) {
    // Foliage tint - bottom half of colormap
    return texture2D(uColormap, vec2(u, 0.5 + v * 0.5)).rgb;
  }
  return vec3(1.0);
}

void main() {
  if (vVisible < 0.5) discard;
  
  vec3 finalColor;
  float alpha = 1.0;
  
  if (uUseTextures > 0.5) {
    // Get animated texture index (returns original if not animated)
    float tileIndex = getAnimatedTexIndex(floor(vTexIndex + 0.5));
    float col = mod(tileIndex, uTilesPerRow);
    float row = floor(tileIndex / uTilesPerRow);
    
    // Calculate atlas UV: offset to tile + border + UV within texture
    vec2 atlasOffset = vec2(col, row) * uTileFullSize;
    vec2 atlasUV = atlasOffset + uBorderSize + vModelUV * uTextureSize;
    
    vec4 texColor = texture2D(uAtlas, atlasUV);
    
    // Alpha test
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
    finalColor = vColor;
  }
  
  // Sample lightmap
  vec3 lightColor = vec3(1.0);
  if (uUseLighting > 0.5) {
    lightColor = texture2D(uLightmap, vLightUV).rgb;
  }
  
  gl_FragColor = vec4(finalColor * lightColor, alpha);
}
`;

/**
 * Create an instanced material for cross-pattern blocks
 */
export function createInstancedModelMaterial(atlasData = null, useTextures = false, lightmap = null) {
  // Extract atlas data - match the format used by TexturedMaterial
  const atlas = atlasData?.atlas || null;
  const colormap = atlasData?.colormap || null;
  const animationData = atlasData?.animationData || null;
  const frameSequence = atlasData?.frameSequence || null;
  const totalTiles = atlasData?.totalTiles || 0;
  const sequenceLength = atlasData?.sequenceLength || 1;
  
  // Calculate UV sizes matching TexturedMaterial's getAtlasUniforms
  const tilesPerRow = atlasData?.tilesPerRow || 32;
  const atlasWidth = atlasData?.atlasWidth || (tilesPerRow * 18); // 16px + 2px border
  const tileFullSize = 18 / atlasWidth; // Full tile size in UV (includes 1px border each side)
  const textureSize = 16 / atlasWidth; // Usable texture size in UV
  const borderSize = 1 / atlasWidth; // Border offset in UV
  
  const defaultTexture = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1, 1,
    THREE.RGBAFormat
  );
  defaultTexture.needsUpdate = true;
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uMaxDistance: { value: 48.0 },
      uAtlas: { value: atlas || defaultTexture },
      uColormap: { value: colormap || defaultTexture },
      uLightmap: { value: lightmap || defaultTexture },
      uAnimationData: { value: animationData || defaultTexture },
      uFrameSequence: { value: frameSequence || defaultTexture },
      uUseTextures: { value: useTextures ? 1.0 : 0.0 },
      uUseTinting: { value: colormap ? 1.0 : 0.0 },
      uUseLighting: { value: lightmap ? 1.0 : 0.0 },
      uTime: { value: 0.0 },
      uTotalTiles: { value: totalTiles },
      uSequenceLength: { value: sequenceLength },
      uTilesPerRow: { value: tilesPerRow },
      uTileFullSize: { value: tileFullSize },
      uTextureSize: { value: textureSize },
      uBorderSize: { value: borderSize },
    },
    vertexShader: instancedVertexShader,
    fragmentShader: instancedFragmentShader,
    side: THREE.DoubleSide,  // Cross patterns need double-sided
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  
  return material;
}

/**
 * Create an InstancedMesh from base geometry and instance data
 * 
 * @param {THREE.BufferGeometry} baseGeometry - The base cross-pattern geometry
 * @param {THREE.Material} material - The instanced material
 * @param {Object} instanceData - Instance data arrays
 * @param {Float32Array} instanceData.offsets - World positions (3 floats per instance)
 * @param {Float32Array} instanceData.rotations - Y-axis rotations (1 float per instance, 0-3)
 * @param {Float32Array} instanceData.tintTypes - Biome tint types (1 float per instance)
 * @param {Float32Array} instanceData.lights - Light levels (2 floats per instance: block, sky)
 * @returns {THREE.InstancedMesh}
 */
export function createInstancedMesh(baseGeometry, material, instanceData) {
  const instanceCount = instanceData.offsets.length / 3;
  
  // Create instanced mesh
  const mesh = new THREE.InstancedMesh(baseGeometry, material, instanceCount);
  
  // Add per-instance attributes
  const offsetAttr = new THREE.InstancedBufferAttribute(instanceData.offsets, 3);
  const rotationAttr = new THREE.InstancedBufferAttribute(instanceData.rotations, 1);
  const tintAttr = new THREE.InstancedBufferAttribute(instanceData.tintTypes, 1);
  const lightAttr = new THREE.InstancedBufferAttribute(instanceData.lights, 2);
  
  mesh.geometry.setAttribute('instanceOffset', offsetAttr);
  mesh.geometry.setAttribute('instanceRotation', rotationAttr);
  mesh.geometry.setAttribute('instanceTintType', tintAttr);
  mesh.geometry.setAttribute('instanceLight', lightAttr);
  
  // Set identity matrices (we handle transformation in shader)
  const identityMatrix = new THREE.Matrix4();
  for (let i = 0; i < instanceCount; i++) {
    mesh.setMatrixAt(i, identityMatrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  
  mesh.frustumCulled = false;  // We do our own culling in shader
  
  return mesh;
}

/**
 * Create base geometry for a cross-pattern block (like short_grass)
 * Returns a BufferGeometry with the X-shaped cross pattern
 */
export function createCrossGeometry(textureIndex = 0) {
  // Cross pattern: two quads at 45° angles
  // Each quad is 0 to 1 in X/Z, 0 to 1 in Y
  
  const sqrt2 = Math.SQRT2;
  const halfSqrt2 = sqrt2 / 2;
  
  // First diagonal (from corner 0,0 to 1,1)
  const positions = new Float32Array([
    // Quad 1: diagonal from (0,0) to (1,1)
    0.5 - halfSqrt2/2, 0, 0.5 - halfSqrt2/2,  // bottom-left
    0.5 + halfSqrt2/2, 0, 0.5 + halfSqrt2/2,  // bottom-right
    0.5 + halfSqrt2/2, 1, 0.5 + halfSqrt2/2,  // top-right
    0.5 - halfSqrt2/2, 1, 0.5 - halfSqrt2/2,  // top-left
    
    // Quad 2: diagonal from (1,0) to (0,1)
    0.5 + halfSqrt2/2, 0, 0.5 - halfSqrt2/2,  // bottom-left
    0.5 - halfSqrt2/2, 0, 0.5 + halfSqrt2/2,  // bottom-right
    0.5 - halfSqrt2/2, 1, 0.5 + halfSqrt2/2,  // top-right
    0.5 + halfSqrt2/2, 1, 0.5 - halfSqrt2/2,  // top-left
  ]);
  
  // UVs (standard 0-1 mapping)
  const modelUVs = new Float32Array([
    0, 1,  1, 1,  1, 0,  0, 0,  // Quad 1
    0, 1,  1, 1,  1, 0,  0, 0,  // Quad 2
  ]);
  
  // Texture indices (same for all vertices)
  const texIndices = new Float32Array(8).fill(textureIndex);
  
  // Normals (perpendicular to each quad face)
  const n1 = new THREE.Vector3(1, 0, -1).normalize();
  const n2 = new THREE.Vector3(-1, 0, -1).normalize();
  
  const normals = new Float32Array([
    n1.x, n1.y, n1.z,  n1.x, n1.y, n1.z,  n1.x, n1.y, n1.z,  n1.x, n1.y, n1.z,
    n2.x, n2.y, n2.z,  n2.x, n2.y, n2.z,  n2.x, n2.y, n2.z,  n2.x, n2.y, n2.z,
  ]);
  
  // Indices (two quads = 4 triangles = 12 indices)
  const indices = new Uint16Array([
    0, 1, 2,  0, 2, 3,  // Quad 1
    4, 5, 6,  4, 6, 7,  // Quad 2
  ]);
  
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('modelUV', new THREE.BufferAttribute(modelUVs, 2));
  geometry.setAttribute('texIndex', new THREE.BufferAttribute(texIndices, 1));
  geometry.setAttribute('instanceNormal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  
  return geometry;
}

