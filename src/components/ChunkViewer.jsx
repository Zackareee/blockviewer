import { useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
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

// Smooth orbit controls with zoom-to-cursor
function SmoothOrbitControls({ minDistance = 5, maxDistance = 500, targetRef }) {
  const controlsRef = useRef();
  
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
      dampingFactor={0.1}
      minDistance={minDistance}
      maxDistance={maxDistance}
      zoomToCursor={true}
      zoomSpeed={1.2}
      rotateSpeed={0.8}
      panSpeed={0.8}
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
      frameloop="demand"
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
      <SmoothOrbitControls
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
