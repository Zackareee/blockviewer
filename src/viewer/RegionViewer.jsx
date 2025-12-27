/**
 * RegionViewer - React wrapper for ChunkManager with Performance Optimizations
 * 
 * Based on R3F performance guidelines:
 * https://r3f.docs.pmnd.rs/advanced/scaling-performance
 * https://r3f.docs.pmnd.rs/advanced/pitfalls
 * 
 * Features:
 * - Movement regression (lower DPR while camera moves)
 * - On-demand rendering (only render when needed)
 */

import { useRef, useEffect, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, AdaptiveDpr, PerformanceMonitor } from '@react-three/drei';
import { ChunkManager } from './ChunkManager';

/**
 * Adaptive pixel ratio component - reduces DPR when performance drops
 * Note: Simplified to avoid issues with demand rendering mode
 */
function AdaptivePerformance() {
  const { invalidate } = useThree();
  
  return (
    <PerformanceMonitor
      onIncline={() => {
        console.log('[Performance] Quality increasing');
        invalidate();
      }}
      onDecline={() => {
        console.log('[Performance] Quality decreasing');
        invalidate();
      }}
      flipflops={5} // More tolerance before switching
      factor={0.5} // Less aggressive changes
    >
      <AdaptiveDpr pixelated />
    </PerformanceMonitor>
  );
}

/**
 * Movement regression - lower quality while camera is moving
 * This helps maintain smooth framerates during orbit/pan
 */
function MovementRegression() {
  const { performance: perf } = useThree();
  const lastPos = useRef({ x: 0, y: 0, z: 0 });
  const framesSinceMove = useRef(0);
  
  useFrame(({ camera }) => {
    const dx = camera.position.x - lastPos.current.x;
    const dy = camera.position.y - lastPos.current.y;
    const dz = camera.position.z - lastPos.current.z;
    const moved = dx * dx + dy * dy + dz * dz > 0.1;
    
    lastPos.current.x = camera.position.x;
    lastPos.current.y = camera.position.y;
    lastPos.current.z = camera.position.z;
    
    if (moved) {
      framesSinceMove.current = 0;
      perf.regress();
    } else {
      framesSinceMove.current++;
    }
  });
  
  return null;
}

/**
 * Inner scene component that manages the ChunkManager
 */
function RegionScene({ 
  chunks,
  regions,
  parseRegion,
  enableLOD,
  onProgress, 
  onComplete,
  onStats 
}) {
  const { scene, camera, invalidate } = useThree();
  const managerRef = useRef(null);
  const controlsRef = useRef(null);
  
  // Create ChunkManager once
  useEffect(() => {
    const manager = new ChunkManager(scene, {
      onProgress: (loaded, total) => {
        onProgress?.(loaded, total, loaded < total, `Loading: ${loaded}/${total} regions`);
        invalidate(); // Request render on progress
      },
      onComplete: () => {
        onProgress?.(0, 0, false, '');
        const stats = manager.getStats();
        onStats?.(stats);
        onComplete?.();
        invalidate(); // Request render on complete
      },
    });
    
    managerRef.current = manager;
    
    return () => {
      manager.dispose();
      managerRef.current = null;
    };
  }, [scene, invalidate]);
  
  // Load single region chunks
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !chunks || chunks.length === 0) return;
    if (regions && regions.length > 0) return; // Multi-region takes precedence
    
    manager.clear();
    console.log(`[RegionViewer] Loading ${chunks.length} chunks...`);
    
    manager.loadChunks(chunks).then(result => {
      console.log(`[RegionViewer] Loaded ${result.chunksLoaded} chunks, ${result.totalBlocks.toLocaleString()} blocks`);
      positionCamera();
      invalidate();
    });
    
  }, [chunks, invalidate]);
  
  // Track loaded regions to detect additions
  const loadedRegionKeysRef = useRef(new Set());
  
  // Load multiple regions progressively
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !regions || regions.length === 0 || !parseRegion) return;
    
    // Compute which regions are new
    const currentKeys = new Set(regions.map(r => `${r.regionX},${r.regionZ}`));
    const loadedKeys = loadedRegionKeysRef.current;
    
    // Find regions that need to be loaded
    const newRegions = regions.filter(r => !loadedKeys.has(`${r.regionX},${r.regionZ}`));
    
    // If all current regions are new, this is a fresh load (clear existing)
    const isFreshLoad = newRegions.length === regions.length || loadedKeys.size === 0;
    
    if (newRegions.length === 0) {
      // All regions already loaded, nothing to do
      return;
    }
    
    if (isFreshLoad) {
      manager.clear();
      loadedRegionKeysRef.current = new Set();
      console.log(`[RegionViewer] Loading ${regions.length} regions progressively...`);
    } else {
      console.log(`[RegionViewer] Adding ${newRegions.length} new regions...`);
    }
    
    // Compute combined center from ALL region coordinates (including existing)
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const { regionX, regionZ } of regions) {
      const rx = regionX * 512;
      const rz = regionZ * 512;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx + 512);
      minZ = Math.min(minZ, rz);
      maxZ = Math.max(maxZ, rz + 512);
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    
    // Choose load method based on whether this is fresh or addition
    const loadMethod = isFreshLoad 
      ? manager.loadRegionsProgressive.bind(manager)
      : manager.addRegionsProgressive.bind(manager);
    
    const regionsToLoad = isFreshLoad ? regions : newRegions;
    
    loadMethod(regionsToLoad, parseRegion, {
      onRegionStart: (index, total, name) => {
        onProgress?.(index, total, true, `${isFreshLoad ? 'Loading' : 'Adding'}: ${name}`);
      },
      onRegionComplete: (index, total, name, stats) => {
        onProgress?.(index + 1, total, index + 1 < total, `Completed: ${name}`);
        invalidate(); // Render after each region completes
      },
      enableLOD, // Pass through LOD setting
    }).then(result => {
      const totalLoaded = isFreshLoad ? result.regionsLoaded : result.totalRegions;
      console.log(`[RegionViewer] ${isFreshLoad ? 'Loaded' : 'Now have'} ${totalLoaded} regions, ${result.totalBlocks?.toLocaleString() || '?'} blocks`);
      
      // Update loaded keys
      for (const r of regionsToLoad) {
        loadedRegionKeysRef.current.add(`${r.regionX},${r.regionZ}`);
      }
      
      // Only reposition camera on fresh load
      if (isFreshLoad) {
        positionCameraAt(centerX, 64, centerZ, result.chunksLoaded || result.totalChunks);
      }
      invalidate();
    });
    
  }, [regions, parseRegion, invalidate]);
  
  // Position camera at a specific target
  const positionCameraAt = useCallback((cx, cy, cz, chunkCount = 100) => {
    if (controlsRef.current) {
      controlsRef.current.target.set(cx, cy, cz);
    }
    
    const distance = Math.max(300, Math.sqrt(chunkCount) * 24);
    camera.position.set(cx + distance * 0.7, cy + distance * 0.4, cz + distance * 0.7);
    camera.lookAt(cx, cy, cz);
    invalidate();
  }, [camera, invalidate]);
  
  // Position camera based on loaded content (single region, centered at origin)
  const positionCamera = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    
    const stats = manager.getStats();
    positionCameraAt(0, 64, 0, stats.chunksLoaded || 100);
  }, [positionCameraAt]);
  
  return (
    <>
      <OrbitControls 
        ref={controlsRef}
        enableDamping={true}
        dampingFactor={0.05}
        minDistance={10}
        maxDistance={5000}
        target={[0, 64, 0]}
        onChange={() => invalidate()} // Re-render on orbit change
      />
      <ambientLight intensity={0.4} />
      <directionalLight position={[50, 100, 30]} intensity={0.8} />
      
      {/* Performance optimizations */}
      <MovementRegression />
    </>
  );
}

/**
 * RegionViewer component
 * 
 * Props:
 * - chunks: Array of parsed chunk data (single region mode)
 * - regions: Array of { file, regionX, regionZ } for multi-region progressive loading
 * - parseRegion: Async function (file) => chunks[] for parsing region files
 * - enableLOD: Enable Level of Detail for distant regions (default: true)
 * - onBuildProgress: (current, total, isBuilding, message) => void
 * - enablePerformanceMonitor: Enable adaptive DPR based on performance (default: true)
 */
export function RegionViewer({ 
  chunks, 
  regions,
  parseRegion,
  enableLOD = true,
  onBuildProgress = null,
  enablePerformanceMonitor = true,
  style = {}
}) {
  const statsRef = useRef(null);
  const handleStats = useCallback((s) => { statsRef.current = s; }, []);
  
  return (
    <Canvas
      style={{ width: '100%', height: '100%', ...style }}
      camera={{ 
        fov: 60, 
        near: 0.1, 
        far: 10000, 
        position: [500, 300, 500] 
      }}
      gl={{ 
        antialias: true,
        powerPreference: 'high-performance',
      }}
      // Always render - demand mode can cause issues with LOD updates
      frameloop="always"
      // Performance settings
      dpr={[0.5, 1.5]} // Allow DPR to scale between 0.5x and 1.5x
      performance={{ min: 0.5 }} // Minimum performance ratio before regression
    >
      <color attach="background" args={['#1a1a2e']} />
      <fog attach="fog" args={['#1a1a2e', 1000, 5000]} />
      
      {/* Adaptive performance - automatically adjusts quality */}
      {enablePerformanceMonitor && <AdaptivePerformance />}
      
      <RegionScene
        chunks={chunks}
        regions={regions}
        parseRegion={parseRegion}
        enableLOD={enableLOD}
        onProgress={onBuildProgress}
        onComplete={() => console.log('[RegionViewer] Load complete')}
        onStats={handleStats}
      />
    </Canvas>
  );
}

export default RegionViewer;
