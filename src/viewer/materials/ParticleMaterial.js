/**
 * ParticleMaterial - Custom Three.js shader material for GPU-instanced particles
 * 
 * Features:
 * - Billboard transformation (particles always face camera)
 * - Particle atlas sampling
 * - Fog support
 * - Alpha blending (normal and additive modes)
 * - Per-instance attributes: position, size, age, sprite index, color, alpha
 */

import * as THREE from 'three';

// Vertex shader for billboarded particles
const particleVertexShader = `
precision highp float;

// Instance attributes
attribute vec3 instancePosition;  // World position of particle center
attribute float instanceSize;     // Particle size (world units)
attribute float instanceAge;      // Age as 0-1 (0 = just spawned, 1 = end of life)
attribute float instanceSpriteIndex; // Atlas sprite index
attribute vec3 instanceColor;     // Particle color tint
attribute float instanceAlpha;    // Particle alpha

// Uniforms
uniform float uTime;
uniform vec2 uAtlasSize;         // Atlas dimensions in tiles (e.g., 8x8)
uniform vec2 uTileUV;            // Full tile size in UV space
uniform vec2 uTextureUV;         // Usable texture size in UV space
uniform vec2 uBorderUV;          // Border offset in UV space

// Varyings to pass to fragment shader
varying vec2 vUV;
varying vec3 vColor;
varying float vAlpha;
varying float vDistance;

void main() {
  // Billboard: expand quad vertices in camera space
  // position is the local quad vertex (-0.5 to 0.5 in x/y, 0 in z)
  vec3 quadVertex = position;
  
  // Transform instance position to view space
  vec4 viewCenter = modelViewMatrix * vec4(instancePosition, 1.0);
  
  // Expand the quad in view space (billboard effect)
  vec3 viewPos = viewCenter.xyz + vec3(quadVertex.xy * instanceSize, 0.0);
  
  // Project to clip space
  gl_Position = projectionMatrix * vec4(viewPos, 1.0);
  
  // Calculate atlas UV coordinates
  float tilesPerRow = uAtlasSize.x;
  float spriteCol = mod(instanceSpriteIndex, tilesPerRow);
  float spriteRow = floor(instanceSpriteIndex / tilesPerRow);
  
  // Local UV (0-1 within this tile)
  // Flip Y because canvas draws top-down but WebGL UVs are bottom-up
  vec2 localUV = vec2(quadVertex.x + 0.5, 0.5 - quadVertex.y);
  
  // Calculate atlas UV with border
  vec2 atlasOffset = vec2(spriteCol, spriteRow) * uTileUV;
  vUV = atlasOffset + uBorderUV + localUV * uTextureUV;
  
  // Pass color and alpha to fragment
  vColor = instanceColor;
  vAlpha = instanceAlpha;
  
  // Distance for fog
  vDistance = length(viewCenter.xyz);
}
`;

// Fragment shader for particles
const particleFragmentShader = `
precision highp float;

uniform sampler2D uAtlas;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogEnabled;
uniform float uAdditiveBlending; // 1.0 for additive, 0.0 for normal
uniform vec3 uAmbientBrightness; // RGB brightness multiplier based on time of day (1.0 = day, ~0.15 = night)

varying vec2 vUV;
varying vec3 vColor;
varying float vAlpha;
varying float vDistance;

// Linear fog calculation
float linearFog(float distance, float fogStart, float fogEnd) {
  if (distance <= fogStart) return 0.0;
  if (distance >= fogEnd) return 1.0;
  return (distance - fogStart) / (fogEnd - fogStart);
}

void main() {
  // Sample particle texture
  vec4 texColor = texture2D(uAtlas, vUV);
  
  // Discard fully transparent pixels
  if (texColor.a < 0.01) discard;
  
  // Apply color tint
  vec3 color = texColor.rgb * vColor;
  float alpha = texColor.a * vAlpha;
  
  // For additive blending, premultiply alpha
  if (uAdditiveBlending > 0.5) {
    color = color * alpha;
  } else {
    // For non-additive particles, apply ambient brightness (darkness at night)
    // Clamp minimum to 40% so particles stay visible at night (less extreme than clouds)
    vec3 adjustedBrightness = max(uAmbientBrightness, vec3(0.4));
    color = color * adjustedBrightness;
  }
  
  // Apply fog
  if (uFogEnabled > 0.5) {
    float fogValue = linearFog(vDistance, uFogStart, uFogEnd);
    if (uAdditiveBlending > 0.5) {
      // For additive particles, fade out in fog instead of blending to fog color
      color = color * (1.0 - fogValue);
    } else {
      // Normal particles blend to fog color
      color = mix(color, uFogColor, fogValue);
    }
  }
  
  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * Create a particle material for normal alpha blending (smoke, drips, etc.)
 * @param {ParticleAtlas} particleAtlas - The particle texture atlas
 * @returns {THREE.ShaderMaterial}
 */
export function createParticleMaterial(particleAtlas) {
  const materialData = particleAtlas ? particleAtlas.getMaterialData() : null;
  
  // Ensure nearest neighbor filtering for pixel art look
  if (materialData?.atlas) {
    materialData.atlas.magFilter = THREE.NearestFilter;
    materialData.atlas.minFilter = THREE.NearestFilter;
    materialData.atlas.generateMipmaps = false;
    materialData.atlas.needsUpdate = true;
  }
  
  const material = new THREE.ShaderMaterial({
    vertexShader: particleVertexShader,
    fragmentShader: particleFragmentShader,
    uniforms: {
      uAtlas: { value: materialData?.atlas || null },
      uTime: { value: 0 },
      uAtlasSize: { value: new THREE.Vector2(materialData?.tilesPerRow || 1, materialData?.tilesPerCol || 1) },
      uTileUV: { value: new THREE.Vector2(materialData?.tileUV?.x || 1, materialData?.tileUV?.y || 1) },
      uTextureUV: { value: new THREE.Vector2(materialData?.textureUV?.x || 1, materialData?.textureUV?.y || 1) },
      uBorderUV: { value: new THREE.Vector2(materialData?.borderUV?.x || 0, materialData?.borderUV?.y || 0) },
      uFogColor: { value: new THREE.Color(0xc8d8ff) },
      uFogStart: { value: 200 },
      uFogEnd: { value: 256 },
      uFogEnabled: { value: 1.0 },
      uAdditiveBlending: { value: 0.0 },
      uAmbientBrightness: { value: new THREE.Vector3(1.0, 1.0, 1.0) }, // Default to full brightness
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  
  return material;
}

/**
 * Create a particle material for additive blending (flames, sparks, etc.)
 * @param {ParticleAtlas} particleAtlas - The particle texture atlas
 * @returns {THREE.ShaderMaterial}
 */
export function createAdditiveParticleMaterial(particleAtlas) {
  const materialData = particleAtlas ? particleAtlas.getMaterialData() : null;
  console.log('[ParticleMaterial] Creating additive material, atlas:', !!materialData?.atlas, 'tilesPerRow:', materialData?.tilesPerRow);
  
  // Ensure nearest neighbor filtering for pixel art look
  if (materialData?.atlas) {
    materialData.atlas.magFilter = THREE.NearestFilter;
    materialData.atlas.minFilter = THREE.NearestFilter;
    materialData.atlas.generateMipmaps = false;
    materialData.atlas.needsUpdate = true;
  }
  
  const material = new THREE.ShaderMaterial({
    vertexShader: particleVertexShader,
    fragmentShader: particleFragmentShader,
    uniforms: {
      uAtlas: { value: materialData?.atlas || null },
      uTime: { value: 0 },
      uAtlasSize: { value: new THREE.Vector2(materialData?.tilesPerRow || 1, materialData?.tilesPerCol || 1) },
      uTileUV: { value: new THREE.Vector2(materialData?.tileUV?.x || 1, materialData?.tileUV?.y || 1) },
      uTextureUV: { value: new THREE.Vector2(materialData?.textureUV?.x || 1, materialData?.textureUV?.y || 1) },
      uBorderUV: { value: new THREE.Vector2(materialData?.borderUV?.x || 0, materialData?.borderUV?.y || 0) },
      uFogColor: { value: new THREE.Color(0xc8d8ff) },
      uFogStart: { value: 200 },
      uFogEnd: { value: 256 },
      uFogEnabled: { value: 1.0 },
      uAdditiveBlending: { value: 1.0 },
      uAmbientBrightness: { value: new THREE.Vector3(1.0, 1.0, 1.0) }, // Not used for additive but uniform must exist
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  
  return material;
}

/**
 * Update fog uniforms for a particle material
 * @param {THREE.ShaderMaterial} material
 * @param {Object} fogParams - { color, start, end, enabled }
 */
export function updateParticleFog(material, fogParams) {
  if (!material?.uniforms) return;
  
  if (fogParams.color !== undefined) {
    material.uniforms.uFogColor.value.set(fogParams.color);
  }
  if (fogParams.start !== undefined) {
    material.uniforms.uFogStart.value = fogParams.start;
  }
  if (fogParams.end !== undefined) {
    material.uniforms.uFogEnd.value = fogParams.end;
  }
  if (fogParams.enabled !== undefined) {
    material.uniforms.uFogEnabled.value = fogParams.enabled ? 1.0 : 0.0;
  }
}

/**
 * Update time uniform for particle animation
 * @param {THREE.ShaderMaterial} material
 * @param {number} time - Current time in seconds
 */
export function updateParticleTime(material, time) {
  if (material?.uniforms?.uTime) {
    material.uniforms.uTime.value = time;
  }
}

/**
 * Update ambient brightness for particles (affects non-additive particles)
 * @param {THREE.ShaderMaterial} material
 * @param {Object} brightness - { r, g, b } values 0-1
 */
export function updateParticleAmbientBrightness(material, brightness) {
  if (material?.uniforms?.uAmbientBrightness) {
    material.uniforms.uAmbientBrightness.value.set(brightness.r, brightness.g, brightness.b);
  }
}

/**
 * Update particle material with a new atlas
 * @param {THREE.ShaderMaterial} material - The particle material to update
 * @param {ParticleAtlas} particleAtlas - The new particle texture atlas
 */
export function updateParticleMaterialAtlas(material, particleAtlas) {
  if (!material?.uniforms) return;
  
  const materialData = particleAtlas ? particleAtlas.getMaterialData() : null;
  
  if (!materialData) {
    console.warn('[ParticleMaterial] updateParticleMaterialAtlas called with no material data');
    return;
  }
  
  // Ensure nearest neighbor filtering for pixel art look
  if (materialData.atlas) {
    materialData.atlas.magFilter = THREE.NearestFilter;
    materialData.atlas.minFilter = THREE.NearestFilter;
    materialData.atlas.generateMipmaps = false;
    materialData.atlas.needsUpdate = true;
  }
  
  // Update uniforms
  material.uniforms.uAtlas.value = materialData.atlas;
  material.uniforms.uAtlasSize.value.set(materialData.tilesPerRow || 1, materialData.tilesPerCol || 1);
  material.uniforms.uTileUV.value.set(materialData.tileUV?.x || 1, materialData.tileUV?.y || 1);
  material.uniforms.uTextureUV.value.set(materialData.textureUV?.x || 1, materialData.textureUV?.y || 1);
  material.uniforms.uBorderUV.value.set(materialData.borderUV?.x || 0, materialData.borderUV?.y || 0);
  
  console.log(`[ParticleMaterial] Updated atlas: ${materialData.atlasWidth}x${materialData.atlasHeight}, ` +
    `${materialData.tilesPerRow}x${materialData.tilesPerCol} tiles, ` +
    `${materialData.textureSize}x${materialData.textureSize} resolution`);
}

export {
  particleVertexShader,
  particleFragmentShader,
};

