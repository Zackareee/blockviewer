import { useEffect, useState, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { buildGreedyMeshes } from '../utils/greedyMesher';

/**
 * CulledMesh - Renders blocks using greedy meshing
 */
export default function CulledMesh({ blocks, minY, maxY, getBlockColor, maxBlocks = 2000000 }) {
  const [result, setResult] = useState(null);
  const buildIdRef = useRef(0);
  
  // Memoize materials
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

  useEffect(() => {
    if (blocks.length === 0) {
      setResult(null);
      return;
    }
    
    const currentBuildId = ++buildIdRef.current;
    
    const buildMesh = async () => {
      const startTime = performance.now();
      
      // Filter blocks by Y range
      let filteredBlocks = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.y >= minY && b.y <= maxY) {
          filteredBlocks.push(b);
          if (filteredBlocks.length >= maxBlocks) break;
        }
      }
      
      if (filteredBlocks.length === 0) {
        setResult(null);
        return;
      }
      
      // Calculate center for offset
      let bMinX = Infinity, bMaxX = -Infinity;
      let bMinY = Infinity, bMaxY = -Infinity;
      let bMinZ = Infinity, bMaxZ = -Infinity;
      
      for (let i = 0; i < filteredBlocks.length; i++) {
        const b = filteredBlocks[i];
        if (b.x < bMinX) bMinX = b.x;
        if (b.x > bMaxX) bMaxX = b.x;
        if (b.y < bMinY) bMinY = b.y;
        if (b.y > bMaxY) bMaxY = b.y;
        if (b.z < bMinZ) bMinZ = b.z;
        if (b.z > bMaxZ) bMaxZ = b.z;
      }
      
      const centerX = (bMinX + bMaxX) / 2;
      const centerY = (bMinY + bMaxY) / 2;
      const centerZ = (bMinZ + bMaxZ) / 2;
      
      // Build greedy meshes (async)
      const { solidGeometry, waterGeometry, stats } = await buildGreedyMeshes(
        filteredBlocks,
        getBlockColor,
        { x: centerX, y: centerY, z: centerZ }
      );
      
      // Check if still current build
      if (currentBuildId !== buildIdRef.current) {
        solidGeometry?.dispose();
        waterGeometry?.dispose();
        return;
      }
      
      const totalTime = performance.now() - startTime;
      
      console.log(
        `Greedy mesh: ${stats.solidBlocks.toLocaleString()} solid + ${stats.waterBlocks.toLocaleString()} water blocks → ` +
        `${stats.solidTriangles.toLocaleString()} + ${stats.waterTriangles.toLocaleString()} triangles ` +
        `in ${totalTime.toFixed(0)}ms`
      );
      
      // Dispose old geometries
      setResult(prev => {
        prev?.solidGeometry?.dispose();
        prev?.waterGeometry?.dispose();
        return { solidGeometry, waterGeometry, centerY };
      });
    };
    
    buildMesh();
    
    return () => {
      buildIdRef.current++;
    };
  }, [blocks, minY, maxY, getBlockColor, maxBlocks]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      result?.solidGeometry?.dispose();
      result?.waterGeometry?.dispose();
      solidMaterial.dispose();
      waterMaterial.dispose();
    };
  }, []);
  
  if (!result) {
    return null;
  }
  
  return (
    <group>
      {result.solidGeometry && (
        <mesh geometry={result.solidGeometry} material={solidMaterial} frustumCulled={false} />
      )}
      {result.waterGeometry && (
        <mesh geometry={result.waterGeometry} material={waterMaterial} frustumCulled={false} renderOrder={1} />
      )}
    </group>
  );
}
