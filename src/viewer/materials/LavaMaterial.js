/**
 * Lava Material with GPU-based Y Slicing and Transparency
 * 
 * Uses vertex shader to hide lava outside Y range.
 * Renders with slight transparency and emissive glow.
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

void main() {
  if (vVisible < 0.5) discard;
  
  // Lava is self-illuminating, so use less directional lighting
  vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
  float diff = max(dot(vNormal, lightDir), 0.0);
  
  // Strong ambient (emissive-like) + subtle diffuse
  vec3 ambient = vColor * 0.8;
  vec3 diffuse = vColor * diff * 0.2;
  
  gl_FragColor = vec4(ambient + diffuse, uOpacity);
}
`;

export function createLavaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
      uOpacity: { value: 0.85 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
    vertexColors: true,
  });
}

export default createLavaMaterial;

