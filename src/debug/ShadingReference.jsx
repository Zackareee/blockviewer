/**
 * ShadingReference - Visual reference for Minecraft face shading values
 * 
 * Displays a 3D block with labeled faces showing the exact shading multipliers
 * used by Minecraft Java Edition for block rendering.
 * 
 * Minecraft face shading values:
 * - Top (Y+): 1.0 (100%)
 * - Bottom (Y-): 0.5 (50%)
 * - North/South (Z±): 0.8 (80%)
 * - East/West (X±): 0.6 (60%)
 */

import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';

// Minecraft's exact face shading values
const FACE_SHADING = {
  top: 1.0,      // Y+ face
  bottom: 0.5,   // Y- face
  north: 0.8,    // Z- face
  south: 0.8,    // Z+ face
  east: 0.6,     // X+ face
  west: 0.6,     // X- face
};

function ShadedBlock({ baseColor = '#7a7a7a' }) {
  const meshRef = useRef();
  
  // Create a box geometry and apply per-face colors based on Minecraft shading
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const colors = [];
  
  // Box geometry face order: +X, -X, +Y, -Y, +Z, -Z
  const faceShades = [
    FACE_SHADING.east,   // +X (East)
    FACE_SHADING.west,   // -X (West)
    FACE_SHADING.top,    // +Y (Top)
    FACE_SHADING.bottom, // -Y (Bottom)
    FACE_SHADING.south,  // +Z (South)
    FACE_SHADING.north,  // -Z (North)
  ];
  
  // Each face has 4 vertices, 6 faces total = 24 vertices
  // BoxGeometry groups vertices by face
  const baseRgb = new THREE.Color(baseColor);
  for (let face = 0; face < 6; face++) {
    const shade = faceShades[face];
    for (let v = 0; v < 4; v++) {
      colors.push(baseRgb.r * shade, baseRgb.g * shade, baseRgb.b * shade);
    }
  }
  
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  
  return (
    <mesh ref={meshRef} geometry={geometry}>
      <meshBasicMaterial vertexColors />
    </mesh>
  );
}

function FaceLabels() {
  const labelStyle = { fontSize: 0.3, color: 'white', anchorX: 'center', anchorY: 'middle' };
  
  return (
    <>
      <Text position={[0, 1.5, 0]} {...labelStyle}>Top: 1.0 (100%)</Text>
      <Text position={[0, -1.5, 0]} rotation={[Math.PI, 0, 0]} {...labelStyle}>Bottom: 0.5 (50%)</Text>
      <Text position={[1.5, 0, 0]} rotation={[0, Math.PI/2, 0]} {...labelStyle}>East: 0.6 (60%)</Text>
      <Text position={[-1.5, 0, 0]} rotation={[0, -Math.PI/2, 0]} {...labelStyle}>West: 0.6 (60%)</Text>
      <Text position={[0, 0, 1.5]} {...labelStyle}>South: 0.8 (80%)</Text>
      <Text position={[0, 0, -1.5]} rotation={[0, Math.PI, 0]} {...labelStyle}>North: 0.8 (80%)</Text>
    </>
  );
}

function RotatingBlock() {
  const groupRef = useRef();
  
  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = state.clock.elapsedTime * 0.3;
    }
  });
  
  return (
    <group ref={groupRef}>
      <ShadedBlock />
      <FaceLabels />
    </group>
  );
}

export default function ShadingReference() {
  return (
    <div style={{ width: '100%', height: '400px', background: '#1a1a2e' }}>
      <Canvas camera={{ position: [4, 3, 4], fov: 50 }}>
        <color attach="background" args={['#1a1a2e']} />
        <ambientLight intensity={1} />
        <RotatingBlock />
        <OrbitControls enablePan={false} />
      </Canvas>
      
      <div style={{ 
        position: 'absolute', 
        bottom: '10px', 
        left: '10px', 
        color: 'white',
        fontFamily: 'monospace',
        fontSize: '12px',
        background: 'rgba(0,0,0,0.7)',
        padding: '10px',
        borderRadius: '4px'
      }}>
        <strong>Minecraft Java Edition Face Shading</strong><br/>
        Top (Y+): 1.0 | Bottom (Y-): 0.5<br/>
        North/South (Z±): 0.8 | East/West (X±): 0.6
      </div>
    </div>
  );
}

