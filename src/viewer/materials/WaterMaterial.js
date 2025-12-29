/**
 * Water Material with GPU-based Y Slicing and Transparency
 * 
 * Uses vertex shader to hide water outside Y range.
 * Renders with transparency for realistic water appearance.
 */

import * as THREE from 'three';

const vertexShader = `
uniform float uMinY;
uniform float uMaxY;

// Note: 'color' attribute is auto-injected by Three.js when vertexColors: true

varying vec3 vColor;
varying vec3 vNormal;
varying float vVisible;

void main() {
  vColor = color; // color is provided by Three.js
  vNormal = normalize(normalMatrix * normal);
  
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

varying vec3 vColor;
varying vec3 vNormal;
varying float vVisible;

// Snap interpolated normal to nearest axis for consistent per-face shading
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

void main() {
  if (vVisible < 0.5) discard;
  
  // Minecraft-style face shading (fixed brightness per face direction)
  vec3 snappedN = snapNormal(vNormal);
  float shade = 1.0;
  
  if (abs(snappedN.y) > 0.5) {
    shade = snappedN.y > 0.0 ? 1.0 : 0.5;
  } else if (abs(snappedN.x) > 0.5) {
    shade = 0.6;
  } else {
    shade = 0.8;
  }
  
  gl_FragColor = vec4(vColor * shade, uOpacity);
}
`;

export function createWaterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uOpacity: { value: 0.6 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false, // Don't write to depth - allows objects behind water to render
    depthTest: true,   // Still respect depth of opaque objects
    vertexColors: true,
  });
}

export default createWaterMaterial;

