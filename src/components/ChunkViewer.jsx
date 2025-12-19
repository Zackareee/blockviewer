import { useMemo, useRef, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { getBlockColor } from '../utils/mcaParser';
import CulledMesh from './CulledMesh';
import ChunkedRegion from './ChunkedRegion';

// Helper to set initial camera target
function CameraTargetSetter({ target, controlsRef }) {
  const hasSet = useRef(false);
  
  useFrame(() => {
    if (!hasSet.current && controlsRef.current) {
      controlsRef.current.target.set(...target);
      controlsRef.current.update();
      hasSet.current = true;
    }
  });
  
  // Reset when target changes
  useEffect(() => {
    hasSet.current = false;
  }, [target[0], target[1], target[2]]);
  
  return null;
}

// Custom zoom-to-cursor controls
function ZoomToPointerControls({ minDistance = 5, maxDistance = 500, targetRef }) {
  const { camera, gl, raycaster, scene } = useThree();
  const controlsRef = useRef();
  const pointer = useRef(new THREE.Vector2());
  
  const handleWheel = useCallback((event) => {
    event.preventDefault();
    
    const controls = controlsRef.current;
    if (!controls) return;
    
    // Get normalized mouse position (-1 to 1)
    const rect = gl.domElement.getBoundingClientRect();
    pointer.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    // Zoom parameters
    const zoomSpeed = 0.1;
    const zoomingIn = event.deltaY < 0;
    const scaleFactor = zoomingIn ? (1 - zoomSpeed) : (1 + zoomSpeed);
    
    // Current state
    const currentTarget = controls.target.clone();
    const currentDistance = camera.position.distanceTo(currentTarget);
    const newDistance = Math.max(minDistance, Math.min(maxDistance, currentDistance * scaleFactor));
    
    // If we hit the distance limits, do normal zoom
    if (Math.abs(newDistance - currentDistance) < 0.01) return;
    
    // Set up raycaster from mouse position
    raycaster.setFromCamera(pointer.current, camera);
    
    // Try to find what we're pointing at - ONLY use actual scene objects
    const intersects = raycaster.intersectObjects(scene.children, true);
    
    if (intersects.length > 0) {
      // We hit something! Zoom towards/away from this point
      const hitPoint = intersects[0].point.clone();
      
      // How much to shift (proportion of zoom)
      const zoomRatio = zoomingIn ? zoomSpeed : -zoomSpeed;
      
      // Move the target towards the hit point (when zooming in) or away (when zooming out)
      const targetToHit = hitPoint.clone().sub(currentTarget);
      const newTarget = currentTarget.clone().add(targetToHit.multiplyScalar(zoomRatio));
      
      // Move camera towards/away from hit point, maintaining the new distance from target
      const cameraToHit = hitPoint.clone().sub(camera.position);
      const newCameraPos = camera.position.clone().add(cameraToHit.multiplyScalar(zoomRatio));
      
      // Now adjust camera position to maintain proper distance from new target
      const direction = newCameraPos.clone().sub(newTarget).normalize();
      const finalCameraPos = newTarget.clone().add(direction.multiplyScalar(newDistance));
      
      // Apply changes
      camera.position.copy(finalCameraPos);
      controls.target.copy(newTarget);
      controls.update();
    } else {
      // No hit - just do standard zoom towards the current target
      const direction = camera.position.clone().sub(currentTarget).normalize();
      const newCameraPos = currentTarget.clone().add(direction.multiplyScalar(newDistance));
      camera.position.copy(newCameraPos);
      controls.update();
    }
  }, [camera, gl, raycaster, scene, minDistance, maxDistance]);
  
  useEffect(() => {
    const domElement = gl.domElement;
    domElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => domElement.removeEventListener('wheel', handleWheel);
  }, [gl, handleWheel]);
  
  // Store ref for external access
  useEffect(() => {
    if (controlsRef.current && targetRef) {
      targetRef.current = controlsRef.current;
    }
  }, [targetRef]);
  
  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.05}
      minDistance={minDistance}
      maxDistance={maxDistance}
      enableZoom={false}  // Disable built-in zoom, we handle it
    />
  );
}

// Container for single chunk with optional rotation
function ChunkContainer({ blocks, minY, maxY, autoRotate }) {
  const groupRef = useRef();
  
  useFrame((state, delta) => {
    if (autoRotate && groupRef.current) {
      groupRef.current.rotation.y += delta * 0.1;
    }
  });

  return (
    <group ref={groupRef}>
      <CulledMesh 
        blocks={blocks} 
        minY={minY} 
        maxY={maxY}
        getBlockColor={getBlockColor}
        maxBlocks={Infinity}
      />
    </group>
  );
}

// Container for region with optional rotation
function RegionContainer({ regionChunkData, minY, maxY, autoRotate, onProgress }) {
  const groupRef = useRef();
  
  useFrame((state, delta) => {
    if (autoRotate && groupRef.current) {
      groupRef.current.rotation.y += delta * 0.05;
    }
  });

  if (!regionChunkData) return null;

  return (
    <group ref={groupRef}>
      <ChunkedRegion 
        chunkRefs={regionChunkData.chunkRefs}
        minY={minY}
        maxY={maxY}
        getBlockColor={getBlockColor}
        regionCenter={regionChunkData.center}
        onProgress={onProgress}
      />
    </group>
  );
}

export default function ChunkViewer({ blocks, minY, maxY, autoRotate, isRegion, regionChunkData, chunkViewData, onBuildProgress }) {
  // Determine if we're in multi-chunk mode
  const isMultiChunk = !isRegion && chunkViewData && chunkViewData.chunkRefs?.length > 1;
  const controlsRef = useRef();
  
  // Calculate camera distance and orbit target based on content size
  const cameraConfig = useMemo(() => {
    if (isRegion && regionChunkData) {
      // For region, the mesh is centered around [0, 0, 0] in XZ
      // and shifted by -regionCenter.y in Y (so Minecraft Y=64 is at world Y=0)
      // Orbit target should be at the center of the region
      const targetY = 0; // This corresponds to ~Y=64 in Minecraft coords
      
      return { 
        position: [100, 80, 100],
        target: [0, targetY, 0], // Exact center of region in X and Z
        distance: 500,
        maxDistance: 2000,
        fogNear: 800,
        fogFar: 2500
      };
    }
    
    if (isMultiChunk && chunkViewData) {
      // Multi-chunk view - similar to region but smaller scale
      const numChunks = chunkViewData.chunkRefs.length;
      const distance = Math.max(50, numChunks * 8);
      
      return { 
        position: [distance, distance * 0.8, distance],
        target: [0, 0, 0],
        distance: distance * 2,
        maxDistance: distance * 4,
        fogNear: distance * 2,
        fogFar: distance * 5
      };
    }
    
    if (blocks.length === 0) {
      return { position: [40, 30, 40], target: [0, 0, 0], distance: 50, maxDistance: 200, fogNear: 100, fogFar: 300 };
    }
    
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let minYBlock = Infinity, maxYBlock = -Infinity;
    
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.x < minX) minX = b.x;
      if (b.x > maxX) maxX = b.x;
      if (b.z < minZ) minZ = b.z;
      if (b.z > maxZ) maxZ = b.z;
      if (b.y < minYBlock) minYBlock = b.y;
      if (b.y > maxYBlock) maxYBlock = b.y;
    }
    
    const width = maxX - minX + 1;
    const depth = maxZ - minZ + 1;
    const maxDimension = Math.max(width, depth, 32);
    const distance = maxDimension * 2;
    
    // Center the orbit target on the chunk
    const centerX = (minX + maxX) / 2;
    const centerY = (minYBlock + maxYBlock) / 2;
    const centerZ = (minZ + maxZ) / 2;
    
    return { 
      position: [centerX + distance, centerY + distance * 0.6, centerZ + distance],
      target: [centerX, centerY, centerZ],
      distance: distance * 2,
      maxDistance: distance * 4,
      fogNear: distance * 2,
      fogFar: distance * 5
    };
  }, [blocks, isRegion, regionChunkData, isMultiChunk, chunkViewData]);
  
  // Use key to force remount when switching between chunk/region
  // NOTE: Do NOT include minY/maxY - components handle range changes internally
  const key = useMemo(() => {
    if (isRegion) {
      return `region-${regionChunkData?.chunkRefs?.length || 0}`;
    }
    if (isMultiChunk) {
      return `multi-chunk-${chunkViewData?.chunkRefs?.length || 0}`;
    }
    return `chunk-${blocks.length}`;
  }, [blocks.length, isRegion, regionChunkData, isMultiChunk, chunkViewData]);
  
  return (
    <Canvas 
      className="chunk-canvas"
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={['#0a0a0f']} />
      <fog attach="fog" args={['#0a0a0f', cameraConfig.fogNear || 500, cameraConfig.fogFar || 2000]} />
      
      <PerspectiveCamera 
        makeDefault 
        position={cameraConfig.position} 
        fov={50} 
      />
      <ZoomToPointerControls
        minDistance={5}
        maxDistance={cameraConfig.maxDistance || 500}
        targetRef={controlsRef}
      />
      <CameraTargetSetter 
        target={cameraConfig.target || [0, 0, 0]} 
        controlsRef={controlsRef}
      />
      
      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[50, 100, 50]} intensity={1} color="#ffffff" />
      <directionalLight position={[-50, 50, -50]} intensity={0.3} color="#aaccff" />
      <hemisphereLight args={['#87CEEB', '#362312', 0.3]} />
      
      {/* Render appropriate view */}
      {isRegion && regionChunkData ? (
        <RegionContainer 
          key={key}
          regionChunkData={regionChunkData}
          minY={minY} 
          maxY={maxY} 
          autoRotate={autoRotate}
          onProgress={onBuildProgress}
        />
      ) : isMultiChunk && chunkViewData ? (
        <RegionContainer 
          key={key}
          regionChunkData={chunkViewData}
          minY={minY} 
          maxY={maxY} 
          autoRotate={autoRotate}
          onProgress={onBuildProgress}
        />
      ) : blocks && blocks.length > 0 ? (
        <ChunkContainer 
          key={key}
          blocks={blocks} 
          minY={minY} 
          maxY={maxY} 
          autoRotate={autoRotate}
        />
      ) : null}
    </Canvas>
  );
}
