import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { extractBlocks, getBlockColor, parseMCAFile } from '../utils/mcaParser';
import { getExtractionWorkerManager } from '../utils/extractionWorkerManager';
import { meshWorkerManager } from '../utils/meshWorkerManager';
import { 
  SubchunkManager, 
  buildSubchunkMesh,
  buildWaterSubchunkMesh,
  buildLavaSubchunkMesh,
  getSubchunkYRange,
  SUBCHUNK_SIZE 
} from '../utils/subchunkManager';
import { loadRegionPipelined, prioritizeChunks } from '../utils/pipelinedLoader';

export default function ChunkedRegion({ 
  chunkRefs,
  minY, 
  maxY, 
  regionCenter,
  onProgress,
  // Streaming mode props
  isStreaming = false,
  regionFiles = null,
  minChunkX = 0,
  minChunkZ = 0,
  onStreamingProgress = null
}) {
  // Subchunk geometries: Map of subchunkY -> { geometry, visible, ... }
  const [subchunkGeometries, setSubchunkGeometries] = useState(new Map());
  // Water subchunk geometries: Map of subchunkY -> { geometry, visible, ... }
  const [waterSubchunkGeometries, setWaterSubchunkGeometries] = useState(new Map());
  // Lava subchunk geometries: Map of subchunkY -> { geometry, visible, ... }
  const [lavaSubchunkGeometries, setLavaSubchunkGeometries] = useState(new Map());
  const [subchunkManager, setSubchunkManager] = useState(null);
  const [isBuilt, setIsBuilt] = useState(false);
  const [lastRange, setLastRange] = useState({ minY: -64, maxY: 320 });
  const debounceRef = useRef(null);
  const buildIdRef = useRef(0);
  const groupRef = useRef();
  const abortControllerRef = useRef(null);
  const isBuildingRef = useRef(false); // Track if a build is in progress
  const currentChunkRefsRef = useRef(null); // Track which chunkRefs we're building
  const { camera } = useThree();
  
  // Store camera in ref to avoid triggering effect re-runs when camera reference changes
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  
  // Create materials
  const solidMaterial = useMemo(() => {
    return new THREE.MeshLambertMaterial({ 
      vertexColors: true, 
      side: THREE.FrontSide
    });
  }, []);
  
  const waterMaterial = useMemo(() => {
    return new THREE.MeshLambertMaterial({ 
      vertexColors: true, 
      side: THREE.FrontSide,
      transparent: true,
      opacity: 0.6,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });
  }, []);
  
  const lavaMaterial = useMemo(() => {
    return new THREE.MeshLambertMaterial({ 
      vertexColors: true, 
      side: THREE.FrontSide,
      transparent: true,
      opacity: 0.7,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });
  }, []);

  // Pending mesh updates - batched to reduce React re-renders
  const pendingMeshesRef = useRef({ solid: [], water: [], lava: [] });
  const flushTimeoutRef = useRef(null);
  
  // Store callbacks and props in refs to avoid effect dependency issues
  // This prevents the effect from re-running when callbacks change reference
  const onProgressRef = useRef(onProgress);
  const onStreamingProgressRef = useRef(onStreamingProgress);
  const regionCenterRef = useRef(regionCenter);
  const handleMeshReadyRef = useRef(null);
  const flushPendingMeshesRef = useRef(null);
  
  useEffect(() => {
    onProgressRef.current = onProgress;
    onStreamingProgressRef.current = onStreamingProgress;
    regionCenterRef.current = regionCenter;
  }, [onProgress, onStreamingProgress, regionCenter]);
  
  // Flush pending meshes to state (batched update)
  const flushPendingMeshes = useCallback(() => {
    const pending = pendingMeshesRef.current;
    
    if (pending.solid.length > 0) {
      const solidToAdd = [...pending.solid];
      pending.solid = [];
      setSubchunkGeometries(prev => {
        const updated = new Map(prev);
        for (const mesh of solidToAdd) {
          const existing = updated.get(mesh.subchunkY);
          if (existing?.geometry) {
            existing.geometry.dispose();
          }
          updated.set(mesh.subchunkY, {
            geometry: mesh.geometry,
            range: mesh.range,
            visible: true,
            needsRemesh: false,
          });
        }
        return updated;
      });
    }
    
    if (pending.water.length > 0) {
      const waterToAdd = [...pending.water];
      pending.water = [];
      setWaterSubchunkGeometries(prev => {
        const updated = new Map(prev);
        for (const mesh of waterToAdd) {
          const existing = updated.get(mesh.subchunkY);
          if (existing?.geometry) {
            existing.geometry.dispose();
          }
          updated.set(mesh.subchunkY, {
            geometry: mesh.geometry,
            range: mesh.range,
            visible: true,
          });
        }
        return updated;
      });
    }
    
    if (pending.lava.length > 0) {
      const lavaToAdd = [...pending.lava];
      pending.lava = [];
      setLavaSubchunkGeometries(prev => {
        const updated = new Map(prev);
        for (const mesh of lavaToAdd) {
          const existing = updated.get(mesh.subchunkY);
          if (existing?.geometry) {
            existing.geometry.dispose();
          }
          updated.set(mesh.subchunkY, {
            geometry: mesh.geometry,
            range: mesh.range,
            visible: true,
          });
        }
        return updated;
      });
    }
  }, []);
  
  // Callback to handle mesh ready events from pipelined loader
  // Batches updates to reduce React re-renders
  // Now uses subchunkKey as the identifier (format: "chunkX,chunkZ,subchunkY")
  const handleMeshReady = useCallback(({ type, subchunkY, subchunkKey, geometry, range, batchNumber }) => {
    // Use subchunkKey as the map key if available, otherwise fall back to subchunkY
    const key = subchunkKey || subchunkY;
    // Add to pending batch
    pendingMeshesRef.current[type].push({ subchunkY: key, geometry, range });
    
    // Schedule flush (debounced - flushes every 16ms for ~60fps or when batch completes)
    if (!flushTimeoutRef.current) {
      flushTimeoutRef.current = setTimeout(() => {
        flushTimeoutRef.current = null;
        flushPendingMeshes();
      }, 16);
    }
  }, [flushPendingMeshes]);
  
  // Keep refs up to date (these are used in the effect to avoid dependency issues)
  flushPendingMeshesRef.current = flushPendingMeshes;
  handleMeshReadyRef.current = handleMeshReady;
  
  // Extract blocks and build subchunk meshes - now uses pipelined loader
  useEffect(() => {
    // Handle streaming mode - process regions one at a time
    if (isStreaming && regionFiles && regionFiles.length > 0) {
      if (isBuilt) return;
      
      // If a build is already in progress, don't restart
      if (isBuildingRef.current) return;
      
      const currentBuildId = ++buildIdRef.current;
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;
      isBuildingRef.current = true;
      
      const processRegionsStreaming = async () => {
        const startTime = performance.now();
        let totalProcessedChunks = 0;
        
        // Process each region file
        for (let regionIdx = 0; regionIdx < regionFiles.length; regionIdx++) {
          if (signal.aborted || currentBuildId !== buildIdRef.current) break;
          
          const regionMeta = regionFiles[regionIdx];
          
          onStreamingProgressRef.current?.(regionIdx, regionFiles.length, regionMeta.file.name);
          onProgressRef.current?.(0, 1, true, `Parsing ${regionMeta.file.name}...`);
          
          // Parse this region file
          let parsedChunks;
          try {
            parsedChunks = await parseMCAFile(regionMeta.file);
          } catch (e) {
            console.error(`Failed to parse region:`, e);
            continue;
          }
          
          if (signal.aborted || currentBuildId !== buildIdRef.current) break;
          
          // Convert chunks to chunkRefs format
          const regionChunkRefs = parsedChunks.map(chunk => ({
            chunkX: chunk.x + regionMeta.chunkOffsetX - minChunkX,
            chunkZ: chunk.z + regionMeta.chunkOffsetZ - minChunkZ,
            rawData: chunk
          }));
          
          totalProcessedChunks += regionChunkRefs.length;
          
          // Use pipelined loader for this region - use refs for callbacks to prevent effect re-runs
          try {
            await loadRegionPipelined(regionChunkRefs, {
              regionCenter: regionCenterRef.current,
              minY,
              maxY,
              camera: cameraRef.current,
              getBlockColor,
              signal,
              onProgress: (phase, current, total, message) => {
                if (!signal.aborted && currentBuildId === buildIdRef.current) {
                  onProgressRef.current?.(current, total, true, message);
                }
              },
              onMeshReady: (meshData) => {
                if (!signal.aborted && currentBuildId === buildIdRef.current) {
                  handleMeshReadyRef.current?.({
                    ...meshData,
                    subchunkY: `${meshData.subchunkY}_r${regionIdx}`,
                  });
                }
              },
            });
          } catch (e) {
            console.error(`  Failed to process region:`, e);
          }
          
          // Clear parsed chunks to free memory
          parsedChunks = null;
          
          // Brief yield between regions
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        
        if (signal.aborted || currentBuildId !== buildIdRef.current) {
          isBuildingRef.current = false;
          onProgressRef.current?.(0, 0, false, '');
          return;
        }
        
        // Flush any remaining pending meshes
        if (flushTimeoutRef.current) {
          clearTimeout(flushTimeoutRef.current);
          flushTimeoutRef.current = null;
        }
        flushPendingMeshesRef.current?.();
        
        const totalTime = performance.now() - startTime;
        console.log(`✅ Streaming complete: ${totalProcessedChunks} chunks in ${(totalTime / 1000).toFixed(1)}s`);
        
        setIsBuilt(true);
        setLastRange({ minY, maxY });
        isBuildingRef.current = false;
        onStreamingProgressRef.current?.(regionFiles.length, regionFiles.length, 'Complete');
        onProgressRef.current?.(1, 1, false, '');
      };
      
      cameraRef.current.position.set(100, 80, 100);
      cameraRef.current.lookAt(0, 0, 0);
      
      const timeoutId = setTimeout(() => {
        processRegionsStreaming();
      }, 100);
      
      return () => {
        clearTimeout(timeoutId);
        // Note: We intentionally DON'T abort or invalidate here.
        // The streaming build continues even if the effect re-runs.
      };
    }
    
    // Non-streaming mode - use pipelined loader
    if (!chunkRefs || chunkRefs.length === 0) {
      setSubchunkManager(null);
      setSubchunkGeometries(new Map());
      setWaterSubchunkGeometries(new Map());
      setLavaSubchunkGeometries(new Map());
      setIsBuilt(false);
      onProgressRef.current?.(0, 0, false, '');
      return;
    }
    
    if (isBuilt) return;
    
    // If a build is in progress for the SAME chunkRefs, don't restart
    if (isBuildingRef.current && currentChunkRefsRef.current === chunkRefs) {
      return;
    }
    
    const currentBuildId = ++buildIdRef.current;
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    isBuildingRef.current = true;
    currentChunkRefsRef.current = chunkRefs;
    
    onProgressRef.current?.(0, chunkRefs.length, true, 'Initializing...');
    
    const buildMesh = async () => {
      // Check if already aborted before starting
      if (signal.aborted) {
        isBuildingRef.current = false;
        return;
      }
      
      const startTime = performance.now();
      
      try {
        // Use refs for callbacks to prevent effect re-runs during loading
        const { manager, stats } = await loadRegionPipelined(chunkRefs, {
          regionCenter: regionCenterRef.current,
          minY,
          maxY,
          camera: cameraRef.current,
          getBlockColor,
          signal,
          onProgress: (phase, current, total, message) => {
            if (!signal.aborted && currentBuildId === buildIdRef.current) {
              onProgressRef.current?.(current, total, true, message);
            }
          },
          onMeshReady: (meshData) => {
            if (!signal.aborted && currentBuildId === buildIdRef.current) {
              handleMeshReadyRef.current?.(meshData);
            }
          },
        });
        
        if (signal.aborted || currentBuildId !== buildIdRef.current) {
          isBuildingRef.current = false;
          onProgressRef.current?.(0, 0, false, '');
          return;
        }
        
        // Flush any remaining pending meshes
        if (flushTimeoutRef.current) {
          clearTimeout(flushTimeoutRef.current);
          flushTimeoutRef.current = null;
        }
        flushPendingMeshesRef.current?.();
        
        setSubchunkManager(manager);
        setIsBuilt(true);
        setLastRange({ minY, maxY });
        isBuildingRef.current = false;
        onProgressRef.current?.(1, 1, false, '');
        
      } catch (e) {
        isBuildingRef.current = false;
        if (e.name !== 'AbortError') {
          console.error('Build failed:', e);
        }
      }
    };
    
    cameraRef.current.position.set(100, 80, 100);
    cameraRef.current.lookAt(0, 0, 0);
    
    const timeoutId = setTimeout(() => {
      buildMesh();
    }, 100);
    
    return () => {
      clearTimeout(timeoutId);
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current);
        flushTimeoutRef.current = null;
      }
      // Note: We intentionally DON'T abort or invalidate here.
      // If the build is in progress with the same chunkRefs, let it continue.
      // The check at the start of the effect prevents duplicate builds.
      // buildIdRef is only incremented when a NEW build actually starts.
    };
    // Only re-run when actual data changes, not when callbacks change
    // Callbacks are accessed via refs to prevent unnecessary re-runs
    // Camera is stored in ref (cameraRef) to avoid triggering re-runs
  }, [chunkRefs, isBuilt, minY, maxY, isStreaming, regionFiles, minChunkX, minChunkZ]);
  
  // Debounce Y range changes
  useEffect(() => {
    if (!isBuilt || !subchunkManager) return;
    if (lastRange.minY === minY && lastRange.maxY === maxY) return;
    
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    
    debounceRef.current = setTimeout(() => {
      handleYRangeChange(minY, maxY);
    }, 400);
    
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [minY, maxY, isBuilt, subchunkManager, lastRange]);
  
  // Helper to parse subchunk key and extract numeric subchunkY
  // Keys can be: number or "num_rN" (streaming suffix)
  const parseSubchunkKey = (key) => {
    if (typeof key === 'number') return key;
    // Handle "num_rN" streaming suffix format
    return parseInt(String(key).split('_')[0], 10);
  };
  
  // Handle Y range change - update visibility, remesh clipped subchunks
  const handleYRangeChange = async (newMinY, newMaxY) => {
    if (!subchunkManager) return;
    
    
    const updatedGeometries = new Map(subchunkGeometries);
    let visibilityChanges = 0;
    let remeshCount = 0;
    const subchunksToRemesh = [];
    
    // Determine which subchunks need visibility updates or remeshing
    for (const [subchunkKey, data] of updatedGeometries) {
      // Parse the key to get numeric subchunkY
      const numericSubchunkY = parseSubchunkKey(subchunkKey);
      
      const isInRange = subchunkManager.isSubchunkInRange(numericSubchunkY, newMinY, newMaxY);
      const wasClipped = data.clippedMinY !== undefined || data.clippedMaxY !== undefined;
      const isNowClipped = subchunkManager.isSubchunkClipped(numericSubchunkY, newMinY, newMaxY);
      const isFullyInRange = subchunkManager.isSubchunkFullyInRange(numericSubchunkY, newMinY, newMaxY);
      
      const subchunkRange = getSubchunkYRange(numericSubchunkY);
      const wasAtTopBoundary = data.atTopBoundary;
      const wasAtBottomBoundary = data.atBottomBoundary;
      const isAtTopBoundary = subchunkRange.maxY >= newMaxY && isInRange;
      const isAtBottomBoundary = subchunkRange.minY <= newMinY && isInRange;
      
      if (data.visible !== isInRange) {
        data.visible = isInRange;
        visibilityChanges++;
      }
      
      if (!isInRange) continue;
      
      const needsRemesh = 
        (wasClipped && isFullyInRange) ||
        (isNowClipped && (data.clippedMinY !== newMinY || data.clippedMaxY !== newMaxY)) ||
        (isAtTopBoundary && (!wasAtTopBoundary || lastRange.maxY !== newMaxY)) ||
        (isAtBottomBoundary && (!wasAtBottomBoundary || lastRange.minY !== newMinY));
      
      if (needsRemesh) {
        subchunksToRemesh.push({
          subchunkKey,
          numericSubchunkY,
          isClipped: isNowClipped,
          clipMinY: isNowClipped ? newMinY : undefined,
          clipMaxY: isNowClipped ? newMaxY : undefined,
          isAtTopBoundary,
          isAtBottomBoundary
        });
      }
    }
    
    // Remesh subchunks
    for (const { subchunkKey, numericSubchunkY, isClipped, clipMinY, clipMaxY, isAtTopBoundary, isAtBottomBoundary } of subchunksToRemesh) {
      const data = updatedGeometries.get(subchunkKey);
      
      data.geometry?.dispose();
      
      let blocks;
      if (isClipped) {
        // Use key for range queries if manager supports it, otherwise numeric
        blocks = subchunkManager.getSubchunkBlocksInRange(subchunkKey, clipMinY, clipMaxY);
      } else {
        blocks = subchunkManager.getSubchunkBlocks(subchunkKey);
      }
      
      const neighborBlocks = subchunkManager.getNeighborBlocks(subchunkKey)
        .filter(b => b.y >= newMinY && b.y <= newMaxY);
      
      const newGeometry = buildSubchunkMesh(
        blocks,
        neighborBlocks,
        getBlockColor,
        { x: regionCenter.x, y: 0, z: regionCenter.z }
      );
      
      data.geometry = newGeometry;
      data.clippedMinY = isClipped ? clipMinY : undefined;
      data.clippedMaxY = isClipped ? clipMaxY : undefined;
      data.atTopBoundary = isAtTopBoundary;
      data.atBottomBoundary = isAtBottomBoundary;
      
      remeshCount++;
    }
    
    if (visibilityChanges > 0 || remeshCount > 0) {
      setSubchunkGeometries(updatedGeometries);
    }
    
    // Handle water subchunks
    const updatedWaterGeometries = new Map(waterSubchunkGeometries);
    let waterVisibilityChanges = 0;
    
    for (const [subchunkKey, data] of updatedWaterGeometries) {
      const numericSubchunkY = parseSubchunkKey(subchunkKey);
      const isInRange = subchunkManager.isSubchunkInRange(numericSubchunkY, newMinY, newMaxY);
      
      if (data.visible !== isInRange) {
        data.visible = isInRange;
        waterVisibilityChanges++;
      }
    }
    
    if (waterVisibilityChanges > 0) {
      setWaterSubchunkGeometries(updatedWaterGeometries);
    }
    
    // Handle lava subchunks
    const updatedLavaGeometries = new Map(lavaSubchunkGeometries);
    let lavaVisibilityChanges = 0;
    
    for (const [subchunkKey, data] of updatedLavaGeometries) {
      const numericSubchunkY = parseSubchunkKey(subchunkKey);
      const isInRange = subchunkManager.isSubchunkInRange(numericSubchunkY, newMinY, newMaxY);
      
      if (data.visible !== isInRange) {
        data.visible = isInRange;
        lavaVisibilityChanges++;
      }
    }
    
    if (lavaVisibilityChanges > 0) {
      setLavaSubchunkGeometries(updatedLavaGeometries);
    }
    
    setLastRange({ minY: newMinY, maxY: newMaxY });
  };
  
  // Store refs for cleanup to avoid stale closure issues
  const subchunkGeometriesRef = useRef(subchunkGeometries);
  const waterSubchunkGeometriesRef = useRef(waterSubchunkGeometries);
  const lavaSubchunkGeometriesRef = useRef(lavaSubchunkGeometries);
  subchunkGeometriesRef.current = subchunkGeometries;
  waterSubchunkGeometriesRef.current = waterSubchunkGeometries;
  lavaSubchunkGeometriesRef.current = lavaSubchunkGeometries;
  
  // Cleanup on unmount only - this is the ONLY place we abort the build
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      isBuildingRef.current = false;
      for (const data of subchunkGeometriesRef.current.values()) {
        data.geometry?.dispose();
      }
      for (const data of waterSubchunkGeometriesRef.current.values()) {
        data.geometry?.dispose();
      }
      for (const data of lavaSubchunkGeometriesRef.current.values()) {
        data.geometry?.dispose();
      }
    };
  }, []); // Empty deps = only run on mount/unmount
  
  // Render solid subchunk meshes
  const subchunkMeshes = useMemo(() => {
    const meshes = [];
    for (const [subchunkY, data] of subchunkGeometries) {
      if (data.visible && data.geometry) {
        meshes.push(
          <mesh 
            key={`subchunk-${subchunkY}`}
            geometry={data.geometry} 
            material={solidMaterial}
            frustumCulled={true}
          />
        );
      }
    }
    return meshes;
  }, [subchunkGeometries, solidMaterial]);
  
  // Render water subchunk meshes
  const waterMeshes = useMemo(() => {
    const meshes = [];
    for (const [subchunkY, data] of waterSubchunkGeometries) {
      if (data.visible && data.geometry) {
        meshes.push(
          <mesh 
            key={`water-subchunk-${subchunkY}`}
            geometry={data.geometry} 
            material={waterMaterial}
            frustumCulled={true}
            renderOrder={1}
          />
        );
      }
    }
    return meshes;
  }, [waterSubchunkGeometries, waterMaterial]);
  
  // Render lava subchunk meshes
  const lavaMeshes = useMemo(() => {
    const meshes = [];
    for (const [subchunkY, data] of lavaSubchunkGeometries) {
      if (data.visible && data.geometry) {
        meshes.push(
          <mesh 
            key={`lava-subchunk-${subchunkY}`}
            geometry={data.geometry} 
            material={lavaMaterial}
            frustumCulled={true}
            renderOrder={2}
          />
        );
      }
    }
    return meshes;
  }, [lavaSubchunkGeometries, lavaMaterial]);
  
  return (
    <group ref={groupRef} position={[0, -regionCenter.y, 0]}>
      {subchunkMeshes}
      {waterMeshes}
      {lavaMeshes}
    </group>
  );
}

/**
 * Sequential extraction fallback for small chunk sets or when parallel fails
 */
async function extractSequential(manager, chunkRefs, minY, maxY, cancelled, currentBuildId, buildIdRef, onProgress) {
  for (let i = 0; i < chunkRefs.length; i++) {
    if (cancelled) return;
    
    const chunkRef = chunkRefs[i];
    
    try {
      const blocks = extractBlocks(chunkRef.rawData);
      
      const worldBlocks = [];
      for (const block of blocks) {
        if (block.y >= minY && block.y <= maxY) {
          worldBlocks.push({
            ...block,
            x: block.x + chunkRef.chunkX * 16,
            z: block.z + chunkRef.chunkZ * 16
          });
        }
      }
      
      manager.addBlocks(worldBlocks);
    } catch (e) {
      console.warn(`Failed to extract chunk:`, e.message);
    }
    
    onProgress?.(i + 1, chunkRefs.length, true, 'Extracting blocks...');
    
    if (i % 8 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  onProgress?.(chunkRefs.length, chunkRefs.length, true, 'Extracting blocks...');
}
