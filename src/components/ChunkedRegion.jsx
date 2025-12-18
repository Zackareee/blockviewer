import { useMemo, useEffect, useState, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { extractBlocks } from '../utils/mcaParser';
import { buildGreedyMeshes } from '../utils/greedyMesher';
import { getBlockColor } from '../utils/mcaParser';

export default function ChunkedRegion({ 
  chunkRefs,
  minY, 
  maxY, 
  regionCenter,
  onProgress
}) {
  const [solidGeometry, setSolidGeometry] = useState(null);
  const [waterGeometry, setWaterGeometry] = useState(null);
  const [allBlocks, setAllBlocks] = useState([]);
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
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthWrite: false
    });
  }, []);
  
  // Extract and build mesh
  useEffect(() => {
    if (!chunkRefs || chunkRefs.length === 0) {
      setAllBlocks([]);
      setSolidGeometry(null);
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
      const collectedBlocks = [];
      
      // Extract blocks from each chunk
      for (let i = 0; i < chunkRefs.length; i++) {
        if (cancelled) return;
        
        const chunkRef = chunkRefs[i];
        
        try {
          const blocks = extractBlocks(chunkRef.rawData);
          
          // Convert to world coordinates
          for (const block of blocks) {
            if (block.y >= minY && block.y <= maxY) {
              collectedBlocks.push({
                ...block,
                x: block.x + chunkRef.chunkX * 16,
                z: block.z + chunkRef.chunkZ * 16
              });
            }
          }
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
      console.log(`Extracted ${collectedBlocks.length.toLocaleString()} blocks in ${extractTime.toFixed(0)}ms`);
      
      setAllBlocks(collectedBlocks);
      
      // Mark extraction complete
      onProgress?.(chunkRefs.length, chunkRefs.length, true, 'Extraction complete');
      await new Promise(resolve => setTimeout(resolve, 0));
      
      // Build mesh on main thread with progress reporting
      const meshStartTime = performance.now();
      const { solidGeometry: solid, waterGeometry: water, stats } = await buildGreedyMeshes(
        collectedBlocks,
        getBlockColor,
        { x: regionCenter.x, y: 0, z: regionCenter.z },
        onProgress // Pass through directly - greedyMesher handles its own phases
      );
      
      if (cancelled || currentBuildId !== buildIdRef.current) {
        solid?.dispose();
        water?.dispose();
        return;
      }
      
      const totalTime = performance.now() - startTime;
      const meshTime = performance.now() - meshStartTime;
      
      console.log(
        `Region mesh: ${stats.solidBlocks.toLocaleString()} solid + ` +
        `${stats.waterBlocks.toLocaleString()} water → ` +
        `${stats.solidTriangles.toLocaleString()} + ${stats.waterTriangles.toLocaleString()} tris ` +
        `(${meshTime.toFixed(0)}ms mesh, ${totalTime.toFixed(0)}ms total)`
      );
      
      setSolidGeometry(solid);
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
  
  // Debounce Y range changes
  useEffect(() => {
    if (!isBuilt || allBlocks.length === 0) return;
    if (lastRange.minY === minY && lastRange.maxY === maxY) return;
    
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    
    debounceRef.current = setTimeout(() => {
      rebuildForRange(minY, maxY);
    }, 400);
    
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [minY, maxY, isBuilt, allBlocks.length, lastRange]);
  
  // Rebuild mesh for new Y range
  const rebuildForRange = async (newMinY, newMaxY) => {
    console.log(`Rebuilding for Y range: [${lastRange.minY},${lastRange.maxY}] → [${newMinY},${newMaxY}]`);
    
    // Filter blocks to new range
    const filteredBlocks = allBlocks.filter(b => b.y >= newMinY && b.y <= newMaxY);
    
    const { solidGeometry: solid, waterGeometry: water, stats } = await buildGreedyMeshes(
      filteredBlocks,
      getBlockColor,
      { x: regionCenter.x, y: 0, z: regionCenter.z },
      onProgress // Pass through directly
    );
    
    // Dispose old geometries
    solidGeometry?.dispose();
    waterGeometry?.dispose();
    
    setSolidGeometry(solid);
    setWaterGeometry(water);
    setLastRange({ minY: newMinY, maxY: newMaxY });
    
    console.log(`Rebuilt: ${stats.solidTriangles + stats.waterTriangles} triangles`);
    
    setTimeout(() => {
      onProgress?.(1, 1, false, '');
    }, 100);
  };
  
  // Cleanup
  useEffect(() => {
    return () => {
      solidGeometry?.dispose();
      waterGeometry?.dispose();
    };
  }, [solidGeometry, waterGeometry]);
  
  return (
    <group ref={groupRef} position={[0, -regionCenter.y, 0]}>
      {solidGeometry && (
        <mesh 
          geometry={solidGeometry} 
          material={solidMaterial}
          frustumCulled={true}
        />
      )}
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
