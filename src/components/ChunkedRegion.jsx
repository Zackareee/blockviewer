import { useMemo, useEffect, useState, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { extractBlocks, getBlockColor } from '../utils/mcaParser';
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

export default function ChunkedRegion({ 
  chunkRefs,
  minY, 
  maxY, 
  regionCenter,
  onProgress
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
  const { camera } = useThree();
  
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
      side: THREE.FrontSide, // Use FrontSide to prevent internal z-fighting
      transparent: true,
      opacity: 0.6,
      depthWrite: true, // Enable depth write to prevent self z-fighting
      // Polygon offset to prevent z-fighting with solid meshes
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
  
  // Extract blocks and build subchunk meshes
  useEffect(() => {
    if (!chunkRefs || chunkRefs.length === 0) {
      setSubchunkManager(null);
      setSubchunkGeometries(new Map());
      setWaterSubchunkGeometries(new Map());
      setLavaSubchunkGeometries(new Map());
      setIsBuilt(false);
      onProgress?.(0, 0, false, '');
      return;
    }
    
    if (isBuilt) return;
    
    const currentBuildId = ++buildIdRef.current;
    onProgress?.(0, chunkRefs.length, true, 'Extracting blocks...');
    
    let cancelled = false;
    
    const buildMesh = async () => {
      const startTime = performance.now();
      const manager = new SubchunkManager();
      
      // Use parallel worker extraction for large chunk sets
      const useParallelExtraction = chunkRefs.length >= 8;
      
      const totalChunks = chunkRefs.length;
      
      if (useParallelExtraction) {
        // Parallel extraction using worker pool
        const extractionManager = getExtractionWorkerManager();
        extractionManager.resetPalette(); // Reset for new region
        
        try {
          const { blocks: typedBlocks, palette, totalTime } = await extractionManager.extractChunksParallel(
            chunkRefs,
            (completed, total) => {
              if (!cancelled && currentBuildId === buildIdRef.current) {
                onProgress?.(completed, total, true, 'Extracting blocks...');
              }
            }
          );
          
          if (cancelled || currentBuildId !== buildIdRef.current) return;
          
          // Show 100% completion for extraction phase
          onProgress?.(totalChunks, totalChunks, true, 'Extracting blocks...');
          await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause to show 100%
          
          // Filter by Y range and add to manager
          onProgress?.(0, 1, true, 'Processing blocks...');
          
          const { x, y, z, blockType, level, count } = typedBlocks;
          
          // Create filtered typed arrays
          let filteredCount = 0;
          for (let i = 0; i < count; i++) {
            if (y[i] >= minY && y[i] <= maxY) filteredCount++;
          }
          
          const filteredX = new Int32Array(filteredCount);
          const filteredY = new Int16Array(filteredCount);
          const filteredZ = new Int32Array(filteredCount);
          const filteredBlockType = new Uint16Array(filteredCount);
          const filteredLevel = new Int8Array(filteredCount);
          
          let j = 0;
          for (let i = 0; i < count; i++) {
            if (y[i] >= minY && y[i] <= maxY) {
              filteredX[j] = x[i];
              filteredY[j] = y[i];
              filteredZ[j] = z[i];
              filteredBlockType[j] = blockType[i];
              filteredLevel[j] = level[i];
              j++;
            }
          }
          
          manager.addTypedBlocks(
            { x: filteredX, y: filteredY, z: filteredZ, blockType: filteredBlockType, level: filteredLevel, count: filteredCount },
            palette
          );
          
          onProgress?.(1, 1, true, 'Processing blocks...');
          
          console.log(`Parallel extraction: ${count.toLocaleString()} blocks in ${totalTime.toFixed(0)}ms using ${extractionManager.workerCount} workers`);
        } catch (e) {
          console.error('Parallel extraction failed, falling back to sequential:', e);
          // Fall back to sequential extraction
          await extractSequential(manager, chunkRefs, minY, maxY, cancelled, currentBuildId, buildIdRef, onProgress);
        }
      } else {
        // Sequential extraction for small chunk sets
        await extractSequential(manager, chunkRefs, minY, maxY, cancelled, currentBuildId, buildIdRef, onProgress);
      }
      
      if (cancelled || currentBuildId !== buildIdRef.current) return;
      
      const extractTime = performance.now() - startTime;
      console.log(`Extracted ${manager.solidBlockCount.toLocaleString()} solid + ${manager.waterBlockCount.toLocaleString()} water + ${manager.lavaBlockCount.toLocaleString()} lava blocks in ${extractTime.toFixed(0)}ms`);
      console.log(`Organized into ${manager.subchunkCount} subchunks`);
      
      setSubchunkManager(manager);
      
      // Build subchunk meshes
      const meshStartTime = performance.now();
      const subchunkYIndices = manager.getSubchunkYIndices();
      const newGeometries = new Map();
      
      // For large regions (>500k blocks), use main-thread sequential meshing
      // to avoid memory exhaustion from structured cloning to workers
      const totalBlocks = manager.solidBlockCount + manager.waterBlockCount + manager.lavaBlockCount;
      const useMainThread = totalBlocks > 500000;
      
      if (useMainThread) {
        console.log(`Using main-thread meshing for ${totalBlocks.toLocaleString()} blocks (too large for workers)`);
      }
      
      // Show 0% for mesh building phase
      onProgress?.(0, subchunkYIndices.length, true, 'Building solid meshes...');
      await new Promise(resolve => setTimeout(resolve, 0)); // Yield to show UI update
      
      if (useMainThread) {
        // Main-thread sequential meshing for large regions
        for (let i = 0; i < subchunkYIndices.length; i++) {
          if (cancelled || currentBuildId !== buildIdRef.current) return;
          
          const subchunkY = subchunkYIndices[i];
          const blocks = manager.getSubchunkBlocks(subchunkY);
          const neighborBlocks = manager.getNeighborBlocks(subchunkY);
          
          const geometry = buildSubchunkMesh(
            blocks,
            neighborBlocks,
            getBlockColor,
            { x: regionCenter.x, y: 0, z: regionCenter.z }
          );
          
          if (geometry) {
            const range = getSubchunkYRange(subchunkY);
            newGeometries.set(subchunkY, {
              geometry,
              range,
              visible: true,
              needsRemesh: false
            });
          }
          
          onProgress?.(i + 1, subchunkYIndices.length, true, 'Building solid meshes...');
          
          // Yield every few subchunks
          if (i % 4 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      } else {
        // Worker pool parallel meshing for smaller regions
        const solidJobs = subchunkYIndices.map(subchunkY => ({
          solidBlocks: manager.getSubchunkBlocks(subchunkY),
          neighborBlocks: manager.getNeighborBlocks(subchunkY),
          offset: { x: regionCenter.x, y: 0, z: regionCenter.z },
          subchunkY
        }));
        
        const solidResults = await meshWorkerManager.buildSubchunkMeshes(
          solidJobs,
          (completed, total) => {
            if (!cancelled && currentBuildId === buildIdRef.current) {
              onProgress?.(completed, total, true, 'Building solid meshes...');
            }
          }
        );
        
        if (cancelled || currentBuildId !== buildIdRef.current) {
          for (const result of solidResults) {
            result.geometry?.dispose();
          }
          return;
        }
        
        for (const result of solidResults) {
          if (result.geometry) {
            const range = getSubchunkYRange(result.subchunkY);
            newGeometries.set(result.subchunkY, {
              geometry: result.geometry,
              range,
              visible: true,
              needsRemesh: false
            });
          }
        }
      }
      
      if (cancelled || currentBuildId !== buildIdRef.current) {
        for (const data of newGeometries.values()) {
          data.geometry?.dispose();
        }
        return;
      }
      
      // Show 100% completion for solid meshes
      onProgress?.(subchunkYIndices.length, subchunkYIndices.length, true, 'Building solid meshes...');
      await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause to show 100%
      
      // Build water subchunk meshes
      const waterYIndices = manager.getWaterSubchunkYIndices();
      const newWaterGeometries = new Map();
      
      if (waterYIndices.length > 0) {
        onProgress?.(0, waterYIndices.length, true, 'Building water meshes...');
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to show UI update
        
        if (useMainThread) {
          // Main-thread sequential meshing for large regions
          for (let i = 0; i < waterYIndices.length; i++) {
            if (cancelled || currentBuildId !== buildIdRef.current) return;
            
            const subchunkY = waterYIndices[i];
            const waterBlocks = manager.getWaterSubchunkBlocks(subchunkY);
            const neighborBlocks = manager.getWaterNeighborBlocks(subchunkY);
            
            const geometry = buildWaterSubchunkMesh(
              waterBlocks,
              neighborBlocks,
              getBlockColor,
              { x: regionCenter.x, y: 0, z: regionCenter.z }
            );
            
            if (geometry) {
              const range = getSubchunkYRange(subchunkY);
              newWaterGeometries.set(subchunkY, {
                geometry,
                range,
                visible: true
              });
            }
            
            onProgress?.(i + 1, waterYIndices.length, true, 'Building water meshes...');
            
            if (i % 4 === 0) {
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        } else {
          // Worker pool parallel meshing for smaller regions
          const waterJobs = waterYIndices.map(subchunkY => ({
            waterBlocks: manager.getWaterSubchunkBlocks(subchunkY),
            neighborBlocks: manager.getWaterNeighborBlocks(subchunkY),
            offset: { x: regionCenter.x, y: 0, z: regionCenter.z },
            subchunkY
          }));
          
          const waterResults = await meshWorkerManager.buildWaterSubchunkMeshes(
            waterJobs,
            (completed, total) => {
              if (!cancelled && currentBuildId === buildIdRef.current) {
                onProgress?.(completed, total, true, 'Building water meshes...');
              }
            }
          );
          
          if (cancelled || currentBuildId !== buildIdRef.current) {
            for (const result of waterResults) {
              result.geometry?.dispose();
            }
            for (const data of newGeometries.values()) {
              data.geometry?.dispose();
            }
            return;
          }
          
          for (const result of waterResults) {
            if (result.geometry) {
              const range = getSubchunkYRange(result.subchunkY);
              newWaterGeometries.set(result.subchunkY, {
                geometry: result.geometry,
                range,
                visible: true
              });
            }
          }
        }
        
        // Show 100% completion for water meshes
        onProgress?.(waterYIndices.length, waterYIndices.length, true, 'Building water meshes...');
        await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause to show 100%
      }
      
      // Build lava subchunk meshes
      const lavaYIndices = manager.getLavaSubchunkYIndices();
      const newLavaGeometries = new Map();
      
      if (lavaYIndices.length > 0) {
        onProgress?.(0, lavaYIndices.length, true, 'Building lava meshes...');
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to show UI update
        
        if (useMainThread) {
          // Main-thread sequential meshing for large regions
          for (let i = 0; i < lavaYIndices.length; i++) {
            if (cancelled || currentBuildId !== buildIdRef.current) return;
            
            const subchunkY = lavaYIndices[i];
            const lavaBlocks = manager.getLavaSubchunkBlocks(subchunkY);
            const neighborBlocks = manager.getLavaNeighborBlocks(subchunkY);
            
            const geometry = buildLavaSubchunkMesh(
              lavaBlocks,
              neighborBlocks,
              getBlockColor,
              { x: regionCenter.x, y: 0, z: regionCenter.z }
            );
            
            if (geometry) {
              const range = getSubchunkYRange(subchunkY);
              newLavaGeometries.set(subchunkY, {
                geometry,
                range,
                visible: true
              });
            }
            
            onProgress?.(i + 1, lavaYIndices.length, true, 'Building lava meshes...');
            
            if (i % 4 === 0) {
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        } else {
          // Worker pool parallel meshing for smaller regions
          const lavaJobs = lavaYIndices.map(subchunkY => ({
            lavaBlocks: manager.getLavaSubchunkBlocks(subchunkY),
            neighborBlocks: manager.getLavaNeighborBlocks(subchunkY),
            offset: { x: regionCenter.x, y: 0, z: regionCenter.z },
            subchunkY
          }));
          
          const lavaResults = await meshWorkerManager.buildLavaSubchunkMeshes(
            lavaJobs,
            (completed, total) => {
              if (!cancelled && currentBuildId === buildIdRef.current) {
                onProgress?.(completed, total, true, 'Building lava meshes...');
              }
            }
          );
          
          if (cancelled || currentBuildId !== buildIdRef.current) {
            for (const result of lavaResults) {
              result.geometry?.dispose();
            }
            for (const data of newGeometries.values()) {
              data.geometry?.dispose();
            }
            for (const data of newWaterGeometries.values()) {
              data.geometry?.dispose();
            }
            return;
          }
          
          for (const result of lavaResults) {
            if (result.geometry) {
              const range = getSubchunkYRange(result.subchunkY);
              newLavaGeometries.set(result.subchunkY, {
                geometry: result.geometry,
                range,
                visible: true
              });
            }
          }
        }
        
        // Show 100% completion for lava meshes
        onProgress?.(lavaYIndices.length, lavaYIndices.length, true, 'Building lava meshes...');
        await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause to show 100%
      }
      
      if (cancelled || currentBuildId !== buildIdRef.current) {
        for (const data of newGeometries.values()) {
          data.geometry?.dispose();
        }
        for (const data of newWaterGeometries.values()) {
          data.geometry?.dispose();
        }
        for (const data of newLavaGeometries.values()) {
          data.geometry?.dispose();
        }
        return;
      }
      
      // Show finalizing
      onProgress?.(1, 1, true, 'Finalizing...');
      await new Promise(resolve => setTimeout(resolve, 0));
      
      const totalTime = performance.now() - startTime;
      const meshTime = performance.now() - meshStartTime;
      
      let totalTris = 0;
      for (const data of newGeometries.values()) {
        totalTris += data.geometry.index.count / 3;
      }
      let waterTris = 0;
      for (const data of newWaterGeometries.values()) {
        waterTris += data.geometry.index.count / 3;
      }
      let lavaTris = 0;
      for (const data of newLavaGeometries.values()) {
        lavaTris += data.geometry.index.count / 3;
      }
      
      console.log(
        `Region mesh: ${manager.subchunkCount} solid + ${waterYIndices.length} water + ${lavaYIndices.length} lava subchunks → ` +
        `${totalTris.toLocaleString()} solid + ${waterTris.toLocaleString()} water + ${lavaTris.toLocaleString()} lava tris ` +
        `(${meshTime.toFixed(0)}ms mesh, ${totalTime.toFixed(0)}ms total)`
      );
      
      setSubchunkGeometries(newGeometries);
      setWaterSubchunkGeometries(newWaterGeometries);
      setLavaSubchunkGeometries(newLavaGeometries);
      setIsBuilt(true);
      setLastRange({ minY, maxY });
      onProgress?.(1, 1, false, '');
    };
    
    camera.position.set(100, 80, 100);
    camera.lookAt(0, 0, 0);
    
    const timeoutId = setTimeout(() => {
      buildMesh();
    }, 100);
    
    return () => {
      cancelled = true;
      buildIdRef.current++;
      clearTimeout(timeoutId);
    };
  }, [chunkRefs, regionCenter, camera, onProgress, isBuilt, minY, maxY]);
  
  // Debounce Y range changes - will be enhanced in tasks 4 and 5
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
  
  // Handle Y range change - update visibility, remesh clipped subchunks, and rebuild water
  const handleYRangeChange = async (newMinY, newMaxY) => {
    if (!subchunkManager) return;
    
    console.log(`Y range change: [${lastRange.minY},${lastRange.maxY}] → [${newMinY},${newMaxY}]`);
    
    const updatedGeometries = new Map(subchunkGeometries);
    let visibilityChanges = 0;
    let remeshCount = 0;
    const subchunksToRemesh = [];
    
    // Determine which subchunks need visibility updates or remeshing
    for (const [subchunkY, data] of updatedGeometries) {
      const isInRange = subchunkManager.isSubchunkInRange(subchunkY, newMinY, newMaxY);
      const wasClipped = data.clippedMinY !== undefined || data.clippedMaxY !== undefined;
      const isNowClipped = subchunkManager.isSubchunkClipped(subchunkY, newMinY, newMaxY);
      const isFullyInRange = subchunkManager.isSubchunkFullyInRange(subchunkY, newMinY, newMaxY);
      
      // Check if this subchunk is at the visible boundary (needs remesh for correct top/bottom faces)
      const subchunkRange = getSubchunkYRange(subchunkY);
      const wasAtTopBoundary = data.atTopBoundary;
      const wasAtBottomBoundary = data.atBottomBoundary;
      const isAtTopBoundary = subchunkRange.maxY >= newMaxY && isInRange;
      const isAtBottomBoundary = subchunkRange.minY <= newMinY && isInRange;
      
      // Update visibility
      if (data.visible !== isInRange) {
        data.visible = isInRange;
        visibilityChanges++;
      }
      
      if (!isInRange) {
        // Not visible, no need to remesh
        continue;
      }
      
      // Check if we need to remesh this subchunk
      const needsRemesh = 
        // Was clipped but now fully visible - restore full mesh
        (wasClipped && isFullyInRange) ||
        // Newly clipped or clip boundaries changed
        (isNowClipped && (data.clippedMinY !== newMinY || data.clippedMaxY !== newMaxY)) ||
        // Now at top/bottom boundary when it wasn't before (or boundary changed)
        (isAtTopBoundary && (!wasAtTopBoundary || lastRange.maxY !== newMaxY)) ||
        (isAtBottomBoundary && (!wasAtBottomBoundary || lastRange.minY !== newMinY));
      
      if (needsRemesh) {
        subchunksToRemesh.push({
          subchunkY,
          isClipped: isNowClipped,
          clipMinY: isNowClipped ? newMinY : undefined,
          clipMaxY: isNowClipped ? newMaxY : undefined,
          isAtTopBoundary,
          isAtBottomBoundary
        });
      }
    }
    
    // Remesh subchunks that need it
    for (const { subchunkY, isClipped, clipMinY, clipMaxY, isAtTopBoundary, isAtBottomBoundary } of subchunksToRemesh) {
      const data = updatedGeometries.get(subchunkY);
      
      // Dispose old geometry
      data.geometry?.dispose();
      
      // Get blocks for this subchunk
      let blocks;
      if (isClipped) {
        // Get only blocks within the visible Y range
        blocks = subchunkManager.getSubchunkBlocksInRange(subchunkY, clipMinY, clipMaxY);
      } else {
        // Get all blocks in subchunk
        blocks = subchunkManager.getSubchunkBlocks(subchunkY);
      }
      
      // Get neighbor blocks for correct culling
      // Filter by visible Y range to ensure top/bottom faces at clip boundaries are generated
      const neighborBlocks = subchunkManager.getNeighborBlocks(subchunkY)
        .filter(b => b.y >= newMinY && b.y <= newMaxY);
      
      // Build new geometry
      const newGeometry = buildSubchunkMesh(
        blocks,
        neighborBlocks,
        getBlockColor,
        { x: regionCenter.x, y: 0, z: regionCenter.z }
      );
      
      // Update data
      data.geometry = newGeometry;
      data.clippedMinY = isClipped ? clipMinY : undefined;
      data.clippedMaxY = isClipped ? clipMaxY : undefined;
      data.atTopBoundary = isAtTopBoundary;
      data.atBottomBoundary = isAtBottomBoundary;
      
      remeshCount++;
    }
    
    if (visibilityChanges > 0 || remeshCount > 0) {
      console.log(`Updated ${visibilityChanges} visibility, remeshed ${remeshCount} solid subchunks`);
      setSubchunkGeometries(updatedGeometries);
    }
    
    // Handle water subchunks similarly
    const updatedWaterGeometries = new Map(waterSubchunkGeometries);
    let waterVisibilityChanges = 0;
    let waterRemeshCount = 0;
    const waterSubchunksToRemesh = [];
    
    for (const [subchunkY, data] of updatedWaterGeometries) {
      const isInRange = subchunkManager.isSubchunkInRange(subchunkY, newMinY, newMaxY);
      const wasClipped = data.clippedMinY !== undefined || data.clippedMaxY !== undefined;
      const isNowClipped = subchunkManager.isSubchunkClipped(subchunkY, newMinY, newMaxY);
      const isFullyInRange = subchunkManager.isSubchunkFullyInRange(subchunkY, newMinY, newMaxY);
      
      const subchunkRange = getSubchunkYRange(subchunkY);
      const wasAtTopBoundary = data.atTopBoundary;
      const wasAtBottomBoundary = data.atBottomBoundary;
      const isAtTopBoundary = subchunkRange.maxY >= newMaxY && isInRange;
      const isAtBottomBoundary = subchunkRange.minY <= newMinY && isInRange;
      
      if (data.visible !== isInRange) {
        data.visible = isInRange;
        waterVisibilityChanges++;
      }
      
      if (!isInRange) continue;
      
      const needsRemesh = 
        (wasClipped && isFullyInRange) ||
        (isNowClipped && (data.clippedMinY !== newMinY || data.clippedMaxY !== newMaxY)) ||
        (isAtTopBoundary && (!wasAtTopBoundary || lastRange.maxY !== newMaxY)) ||
        (isAtBottomBoundary && (!wasAtBottomBoundary || lastRange.minY !== newMinY));
      
      if (needsRemesh) {
        waterSubchunksToRemesh.push({
          subchunkY,
          isClipped: isNowClipped,
          clipMinY: isNowClipped ? newMinY : undefined,
          clipMaxY: isNowClipped ? newMaxY : undefined,
          isAtTopBoundary,
          isAtBottomBoundary
        });
      }
    }
    
    // Remesh water subchunks
    for (const { subchunkY, isClipped, clipMinY, clipMaxY, isAtTopBoundary, isAtBottomBoundary } of waterSubchunksToRemesh) {
      const data = updatedWaterGeometries.get(subchunkY);
      data.geometry?.dispose();
      
      let waterBlocks;
      if (isClipped) {
        waterBlocks = subchunkManager.getWaterSubchunkBlocksInRange(subchunkY, clipMinY, clipMaxY);
      } else {
        waterBlocks = subchunkManager.getWaterSubchunkBlocks(subchunkY);
      }
      
      const neighborBlocks = subchunkManager.getWaterNeighborBlocks(subchunkY)
        .filter(b => b.y >= newMinY && b.y <= newMaxY);
      
      const newGeometry = buildWaterSubchunkMesh(
        waterBlocks,
        neighborBlocks,
        getBlockColor,
        { x: regionCenter.x, y: 0, z: regionCenter.z }
      );
      
      data.geometry = newGeometry;
      data.clippedMinY = isClipped ? clipMinY : undefined;
      data.clippedMaxY = isClipped ? clipMaxY : undefined;
      data.atTopBoundary = isAtTopBoundary;
      data.atBottomBoundary = isAtBottomBoundary;
      
      waterRemeshCount++;
    }
    
    if (waterVisibilityChanges > 0 || waterRemeshCount > 0) {
      console.log(`Updated ${waterVisibilityChanges} water visibility, remeshed ${waterRemeshCount} water subchunks`);
      setWaterSubchunkGeometries(updatedWaterGeometries);
    }
    
    // Handle lava subchunks similarly
    const updatedLavaGeometries = new Map(lavaSubchunkGeometries);
    let lavaVisibilityChanges = 0;
    let lavaRemeshCount = 0;
    const lavaSubchunksToRemesh = [];
    
    for (const [subchunkY, data] of updatedLavaGeometries) {
      const isInRange = subchunkManager.isSubchunkInRange(subchunkY, newMinY, newMaxY);
      const wasClipped = data.clippedMinY !== undefined || data.clippedMaxY !== undefined;
      const isNowClipped = subchunkManager.isSubchunkClipped(subchunkY, newMinY, newMaxY);
      const isFullyInRange = subchunkManager.isSubchunkFullyInRange(subchunkY, newMinY, newMaxY);
      
      const subchunkRange = getSubchunkYRange(subchunkY);
      const wasAtTopBoundary = data.atTopBoundary;
      const wasAtBottomBoundary = data.atBottomBoundary;
      const isAtTopBoundary = subchunkRange.maxY >= newMaxY && isInRange;
      const isAtBottomBoundary = subchunkRange.minY <= newMinY && isInRange;
      
      if (data.visible !== isInRange) {
        data.visible = isInRange;
        lavaVisibilityChanges++;
      }
      
      if (!isInRange) continue;
      
      const needsRemesh = 
        (wasClipped && isFullyInRange) ||
        (isNowClipped && (data.clippedMinY !== newMinY || data.clippedMaxY !== newMaxY)) ||
        (isAtTopBoundary && (!wasAtTopBoundary || lastRange.maxY !== newMaxY)) ||
        (isAtBottomBoundary && (!wasAtBottomBoundary || lastRange.minY !== newMinY));
      
      if (needsRemesh) {
        lavaSubchunksToRemesh.push({
          subchunkY,
          isClipped: isNowClipped,
          clipMinY: isNowClipped ? newMinY : undefined,
          clipMaxY: isNowClipped ? newMaxY : undefined,
          isAtTopBoundary,
          isAtBottomBoundary
        });
      }
    }
    
    // Remesh lava subchunks
    for (const { subchunkY, isClipped, clipMinY, clipMaxY, isAtTopBoundary, isAtBottomBoundary } of lavaSubchunksToRemesh) {
      const data = updatedLavaGeometries.get(subchunkY);
      data.geometry?.dispose();
      
      let lavaBlocks;
      if (isClipped) {
        lavaBlocks = subchunkManager.getLavaSubchunkBlocksInRange(subchunkY, clipMinY, clipMaxY);
      } else {
        lavaBlocks = subchunkManager.getLavaSubchunkBlocks(subchunkY);
      }
      
      const neighborBlocks = subchunkManager.getLavaNeighborBlocks(subchunkY)
        .filter(b => b.y >= newMinY && b.y <= newMaxY);
      
      const newGeometry = buildLavaSubchunkMesh(
        lavaBlocks,
        neighborBlocks,
        getBlockColor,
        { x: regionCenter.x, y: 0, z: regionCenter.z }
      );
      
      data.geometry = newGeometry;
      data.clippedMinY = isClipped ? clipMinY : undefined;
      data.clippedMaxY = isClipped ? clipMaxY : undefined;
      data.atTopBoundary = isAtTopBoundary;
      data.atBottomBoundary = isAtBottomBoundary;
      
      lavaRemeshCount++;
    }
    
    if (lavaVisibilityChanges > 0 || lavaRemeshCount > 0) {
      console.log(`Updated ${lavaVisibilityChanges} lava visibility, remeshed ${lavaRemeshCount} lava subchunks`);
      setLavaSubchunkGeometries(updatedLavaGeometries);
    }
    
    setLastRange({ minY: newMinY, maxY: newMaxY });
  };
  
  // Cleanup
  useEffect(() => {
    return () => {
      for (const data of subchunkGeometries.values()) {
        data.geometry?.dispose();
      }
      for (const data of waterSubchunkGeometries.values()) {
        data.geometry?.dispose();
      }
      for (const data of lavaSubchunkGeometries.values()) {
        data.geometry?.dispose();
      }
    };
  }, [subchunkGeometries, waterSubchunkGeometries, lavaSubchunkGeometries]);
  
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
      
      // Convert to world coordinates and filter by Y range
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
      
      // Add to subchunk manager
      manager.addBlocks(worldBlocks);
    } catch (e) {
      console.warn(`Failed to extract chunk:`, e.message);
    }
    
    onProgress?.(i + 1, chunkRefs.length, true, 'Extracting blocks...');
    
    // Yield every few chunks
    if (i % 8 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Show 100% completion
  onProgress?.(chunkRefs.length, chunkRefs.length, true, 'Extracting blocks...');
}
