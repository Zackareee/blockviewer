/**
 * Solid Block Material with GPU-based Y Slicing
 * 
 * Uses vertex shader to hide blocks outside Y range instantly.
 * No remeshing needed when Y range changes - just update uniforms.
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
  // Use a small buffer (0.5) to handle edge cases at block boundaries
  if (position.y < uMinY - 0.01 || position.y > uMaxY + 1.01) {
    // Move vertex far away (effectively culled)
    gl_Position = vec4(0.0, 0.0, -1000.0, 1.0);
    vVisible = 0.0;
  } else {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vVisible = 1.0;
  }
}
`;

const fragmentShader = `
varying vec3 vColor;
varying vec3 vNormal;
varying float vVisible;

void main() {
  if (vVisible < 0.5) discard;
  
  // Simple directional lighting
  vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
  float diff = max(dot(vNormal, lightDir), 0.0);
  
  // Ambient + diffuse
  vec3 ambient = vColor * 0.4;
  vec3 diffuse = vColor * diff * 0.6;
  
  gl_FragColor = vec4(ambient + diffuse, 1.0);
}
`;

export function createSolidMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
    vertexColors: true,
  });
}

/**
 * Create material for model blocks (slabs, stairs, flowers, etc.)
 * Uses polygon offset to prevent z-fighting with adjacent full blocks
 */
export function createModelMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMinY: { value: -64 },
      uMaxY: { value: 320 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
    vertexColors: true,
    // Polygon offset pushes fragments slightly back in depth
    // This prevents z-fighting with full blocks
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

export default createSolidMaterial;

