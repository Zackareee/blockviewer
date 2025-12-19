import { useMemo, useEffect, useState, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { extractBlocks } from '../utils/mcaParser';
import { buildGreedyMeshes } from '../utils/greedyMesher';
import { getBlockColor } from '../utils/mcaParser';
import { 
  SubchunkManager, 
  buildSubchunkMesh, 
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
  // Subchunk geometries: Map of subchunkY -> { geometry, visible }
  const [subchunkGeometries, setSubchunkGeometries] = useState(new Map());
  const [waterGeometry, setWaterGeometry] = useState(null);
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
  
  // Extract blocks and build subchunk meshes
  useEffect(() => {
    if (!chunkRefs || chunkRefs.length === 0) {
      setSubchunkManager(null);
      setSubchunkGeometries(new Map());
      setWaterGeometry(null);
      setIsBuilt(false);
      onProgress?.(0, 0, false, '');
      return;
    }
    
    if (isBuilt) return;
    
    const currentBuildId = ++buildIdRef.current;
    onProgress?.(0, chunkRefs.length + 1, true, 'Extracting blocks...');
    
    let cancelled = false;
    
    const buildMesh = async () => {
      const startTime = performance.now();
      const manager = new SubchunkManager();
      
      // Extract blocks from each chunk
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
        
        onProgress?.(i + 1, chunkRefs.length + 1, true, 'Extracting blocks...');
        
        // Yield every few chunks
        if (i % 8 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      
      if (cancelled || currentBuildId !== buildIdRef.current) return;
      
      const extractTime = performance.now() - startTime;
      console.log(`Extracted ${manager.solidBlockCount.toLocaleString()} solid + ${manager.waterBlockCount.toLocaleString()} water blocks in ${extractTime.toFixed(0)}ms`);
      console.log(`Organized into ${manager.subchunkCount} subchunks`);
      
      setSubchunkManager(manager);
      
      // Build subchunk meshes
      const meshStartTime = performance.now();
      const subchunkYIndices = manager.getSubchunkYIndices();
      const newGeometries = new Map();
      
      onProgress?.(0, subchunkYIndices.length, true, 'Building subchunk meshes...');
      
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
            visible: true, // Will be updated based on Y range
            needsRemesh: false
          });
        }
        
        onProgress?.(i + 1, subchunkYIndices.length, true, 'Building subchunk meshes...');
        
        // Yield every few subchunks
        if (i % 4 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      
      if (cancelled || currentBuildId !== buildIdRef.current) {
        // Dispose geometries if cancelled
        for (const data of newGeometries.values()) {
          data.geometry?.dispose();
        }
        return;
      }
      
      // Build water mesh (single mesh, unchanged logic)
      onProgress?.(0, 1, true, 'Building water mesh...');
      await new Promise(resolve => setTimeout(resolve, 0));
      
      let water = null;
      if (manager.waterBlockCount > 0) {
        const { waterGeometry: waterGeo } = await buildGreedyMeshes(
          [...manager.waterBlocks], // Only water blocks
          getBlockColor,
          { x: regionCenter.x, y: 0, z: regionCenter.z },
          null // No progress for water mesh
        );
        water = waterGeo;
      }
      
      if (cancelled || currentBuildId !== buildIdRef.current) {
        for (const data of newGeometries.values()) {
          data.geometry?.dispose();
        }
        water?.dispose();
        return;
      }
      
      const totalTime = performance.now() - startTime;
      const meshTime = performance.now() - meshStartTime;
      
      let totalTris = 0;
      for (const data of newGeometries.values()) {
        totalTris += data.geometry.index.count / 3;
      }
      const waterTris = water ? water.index.count / 3 : 0;
      
      console.log(
        `Region mesh: ${manager.subchunkCount} subchunks → ` +
        `${totalTris.toLocaleString()} solid + ${waterTris.toLocaleString()} water tris ` +
        `(${meshTime.toFixed(0)}ms mesh, ${totalTime.toFixed(0)}ms total)`
      );
      
      setSubchunkGeometries(newGeometries);
      setWaterGeometry(water);
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
      console.log(`Updated ${visibilityChanges} visibility, remeshed ${remeshCount} subchunks`);
      setSubchunkGeometries(updatedGeometries);
    }
    
    // Rebuild water mesh with filtered blocks
    if (subchunkManager.waterBlockCount > 0) {
      // Filter water blocks by Y range
      const filteredWaterBlocks = subchunkManager.waterBlocks.filter(
        b => b.y >= newMinY && b.y <= newMaxY
      );
      
      console.log(`Rebuilding water mesh: ${filteredWaterBlocks.length}/${subchunkManager.waterBlockCount} water blocks in range`);
      
      // Dispose old water geometry
      waterGeometry?.dispose();
      
      if (filteredWaterBlocks.length > 0) {
        const { waterGeometry: newWaterGeo } = await buildGreedyMeshes(
          filteredWaterBlocks,
          getBlockColor,
          { x: regionCenter.x, y: 0, z: regionCenter.z },
          null
        );
        setWaterGeometry(newWaterGeo);
      } else {
        setWaterGeometry(null);
      }
    }
    
    setLastRange({ minY: newMinY, maxY: newMaxY });
  };
  
  // Cleanup
  useEffect(() => {
    return () => {
      for (const data of subchunkGeometries.values()) {
        data.geometry?.dispose();
      }
      waterGeometry?.dispose();
    };
  }, [subchunkGeometries, waterGeometry]);
  
  // Render subchunk meshes
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
  
  return (
    <group ref={groupRef} position={[0, -regionCenter.y, 0]}>
      {subchunkMeshes}
      {waterGeometry && (
        <mesh 
          geometry={waterGeometry} 
          material={waterMaterial}
          frustumCulled={true}
          renderOrder={1}
        />
      )}
    </group>
  );
}
