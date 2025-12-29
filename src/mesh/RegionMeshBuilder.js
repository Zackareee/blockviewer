/**
 * RegionMeshBuilder - Optimized pipeline using FastMesher
 * 
 * Single-threaded but ultra-optimized for maximum throughput
 */

import * as THREE from 'three';
import { BinaryGrid } from './BinaryGrid.js';
import { BlockStateGrid } from './BlockStateGrid.js';
import { getBlockRegistry } from './BlockRegistry.js';
import { decodeChunk } from './ChunkDecoder.js';
import { buildGridMeshes } from './FastMesher.js';
import { buildGridMeshesParallel } from './ParallelMesher.js';
import { buildSimplifiedMesh } from './SimplifiedMesher.js';
import { buildModelMeshes } from './ModelMesher.js';
import { getStateRegistry } from '../assets/StateRegistry.js';

// Check if SharedArrayBuffer is available
const USE_PARALLEL = typeof SharedArrayBuffer !== 'undefined';

/**
 * RegionMeshBuilder class
 */
export class RegionMeshBuilder {
  constructor(options = {}) {
    this.onProgress = options.onProgress || null;
    this.registry = options.registry || getBlockRegistry();
    this.textureIndexLookup = options.textureIndexLookup || null;
  }
  
  /**
   * Set the texture index lookup for textured rendering
   * @param {TextureIndexLookup} lookup
   */
  setTextureIndexLookup(lookup) {
    this.textureIndexLookup = lookup;
  }
  
  /**
   * Build region from parsed chunks
   * @param {Array} chunks - Parsed chunk data
   * @param {Object} options - { centerMesh, forceSequential, generateLOD, enableModelMeshes, returnGrid }
   *   - centerMesh: if false, don't center mesh (for multi-region)
   *   - forceSequential: if true, skip parallel mesher (for memory conservation)
   *   - generateLOD: if true, also generate lower-detail meshes for distance viewing
   *   - enableModelMeshes: if true, generate geometry for non-cube blocks (slabs, stairs, etc.)
   *   - returnGrid: if true, return the grid for debug lookups (uses more memory)
   */
  async buildRegion(chunks, options = {}) {
    const { 
      centerMesh = true, 
      forceSequential = false, 
      generateLOD = false,
      enableModelMeshes = false, // Disabled by default until fully tested
      returnGrid = false,
    } = options;
    const startTime = performance.now();
    const stats = {
      decodeTimeMs: 0,
      meshTimeMs: 0,
      modelMeshTimeMs: 0,
      totalBlocks: 0,
      chunksProcessed: 0,
      solidTriangles: 0,
      waterTriangles: 0,
      lavaTriangles: 0,
      glassTriangles: 0,
      modelTriangles: 0,
    };
    
    // Phase 1: Decode chunks into binary grid
    this.onProgress?.('decoding', 0, chunks.length, 'Decoding chunks...');
    
    const decodeStart = performance.now();
    const grid = new BinaryGrid();
    
    // Create state grid for non-cube blocks (only if model meshes enabled)
    const stateGrid = enableModelMeshes ? new BlockStateGrid() : null;
    const stateRegistry = enableModelMeshes ? getStateRegistry() : null;
    
    // Initialize state registry if using model meshes
    if (stateRegistry) {
      await stateRegistry.init();
    }
    
    for (let i = 0; i < chunks.length; i++) {
      decodeChunk(chunks[i], grid, this.registry, stateGrid, stateRegistry);
      stats.chunksProcessed++;
    }
    
    stats.decodeTimeMs = performance.now() - decodeStart;
    stats.totalBlocks = grid.totalBlocks;
    
    this.onProgress?.('decoding', chunks.length, chunks.length, 'Decode complete');
    
    // Calculate center offset (only if centerMesh is enabled)
    const bounds = grid.getBounds();
    const offset = centerMesh && bounds ? {
      x: (bounds.minX + bounds.maxX) / 2,
      y: 64,
      z: (bounds.minZ + bounds.maxZ) / 2,
    } : { x: 0, y: 0, z: 0 };
    
    // Phase 2: Build meshes
    // Try parallel first, fall back to single-threaded on memory errors
    this.onProgress?.('meshing', 0, 100, 'Building meshes...');
    const meshStart = performance.now();
    
    let solidMesh, waterMesh, lavaMesh, glassMesh;
    
    // Mesher options (including texture index lookup for textured rendering)
    const mesherOptions = {
      textureIndexLookup: this.textureIndexLookup,
    };
    
    if (this.textureIndexLookup) {
      console.log(`[RegionMeshBuilder] Using textureIndexLookup with ${this.textureIndexLookup.registeredBlocks.size} registered blocks`);
    }
    
    // Use parallel mesher for large grids, with fallback on memory errors
    // Skip parallel entirely if forceSequential is set (memory conservation mode)
    // NOTE: ParallelMesher doesn't support textureIndexLookup yet, so fall back to single-threaded when textures are enabled
    // NOTE: ParallelMesher only handles solid blocks, so we always use FastMesher for fluids/glass
    const useParallel = USE_PARALLEL && grid.sections.size > 50 && !forceSequential && !this.textureIndexLookup;
    
    if (useParallel) {
      try {
        const result = await buildGridMeshesParallel(grid, this.registry, offset);
        solidMesh = result.solid;
        
        // ParallelMesher doesn't handle fluids/glass - use FastMesher for those
        // This is fast since it only processes fluid and glass blocks
        const fluidResult = buildGridMeshes(grid, this.registry, offset, mesherOptions);
        waterMesh = fluidResult.water;
        lavaMesh = fluidResult.lava;
        glassMesh = fluidResult.glass;
      } catch (err) {
        // Memory allocation failed or worker error - fall back to single-threaded
        const errMsg = err?.message || String(err);
        const isMemoryError = errMsg.includes('allocation failed') || 
                              errMsg.includes('out of memory') ||
                              err instanceof ErrorEvent ||
                              err?.type === 'error';
        
        if (isMemoryError) {
          console.warn('[RegionMeshBuilder] Parallel meshing failed (memory), falling back to single-threaded');
          const result = buildGridMeshes(grid, this.registry, offset, mesherOptions);
          solidMesh = result.solid;
          waterMesh = result.water;
          lavaMesh = result.lava;
          glassMesh = result.glass;
        } else {
          throw err;
        }
      }
    } else {
      // Use fast single-threaded mesher for smaller grids (more memory efficient)
      const result = buildGridMeshes(grid, this.registry, offset, mesherOptions);
      solidMesh = result.solid;
      waterMesh = result.water;
      lavaMesh = result.lava;
      glassMesh = result.glass;
    }
    
    stats.meshTimeMs = performance.now() - meshStart;
    stats.solidTriangles = solidMesh?.triangleCount || 0;
    stats.waterTriangles = waterMesh?.triangleCount || 0;
    stats.lavaTriangles = lavaMesh?.triangleCount || 0;
    stats.glassTriangles = glassMesh?.triangleCount || 0;
    
    // Phase 2b: Build model meshes for non-cube blocks (if enabled)
    let modelMesh = null;
    if (enableModelMeshes && stateGrid && stateGrid.stateCount > 0) {
      this.onProgress?.('modelMeshing', 0, 100, 'Building model meshes...');
      const modelStart = performance.now();
      
      try {
        // Precompute geometry for all registered block states
        await stateRegistry.precomputeAll();
        
        // Build model meshes using pre-computed geometry
        const modelOptions = {
          textureIndexLookup: this.textureIndexLookup,
        };
        modelMesh = buildModelMeshes(grid, stateGrid, this.registry, stateRegistry, offset, modelOptions);
        
        stats.modelMeshTimeMs = performance.now() - modelStart;
        stats.modelTriangles = modelMesh?.triangleCount || 0;
        
        if (stats.modelTriangles > 0) {
          console.log(`[RegionMeshBuilder] Model meshes: ${stats.modelTriangles.toLocaleString()} triangles in ${stats.modelMeshTimeMs.toFixed(0)}ms`);
        }
      } catch (err) {
        console.warn('[RegionMeshBuilder] Model mesh generation failed:', err.message);
      }
    }
    
    // Generate LOD meshes if requested - 4 levels of detail
    let lodMeshes = null;
    if (generateLOD && solidMesh) {
      this.onProgress?.('lod', 0, 4, 'Generating LOD meshes...');
      
      try {
        // LOD 1: 2x sampling = ~4x fewer triangles
        const lod1 = buildSimplifiedMesh(grid, this.registry, offset, 1);
        
        // LOD 2: 4x sampling = ~16x fewer triangles  
        const lod2 = buildSimplifiedMesh(grid, this.registry, offset, 2);
        
        // LOD 3: 8x sampling = ~64x fewer triangles
        const lod3 = buildSimplifiedMesh(grid, this.registry, offset, 3);
        
        // LOD 4: 16x sampling = ~256x fewer triangles (very coarse for extreme distance)
        const lod4 = buildSimplifiedMesh(grid, this.registry, offset, 4);
        
        lodMeshes = { lod1, lod2, lod3, lod4 };
        
        stats.lod1Triangles = lod1?.triangleCount || 0;
        stats.lod2Triangles = lod2?.triangleCount || 0;
        stats.lod3Triangles = lod3?.triangleCount || 0;
        stats.lod4Triangles = lod4?.triangleCount || 0;
        
        console.log(
          `  LOD: L1=${stats.lod1Triangles.toLocaleString()}, L2=${stats.lod2Triangles.toLocaleString()}, ` +
          `L3=${stats.lod3Triangles.toLocaleString()}, L4=${stats.lod4Triangles.toLocaleString()}`
        );
      } catch (err) {
        console.warn('[RegionMeshBuilder] LOD generation failed:', err.message);
      }
    }
    
    stats.totalTimeMs = performance.now() - startTime;
    
    this.onProgress?.('complete', 100, 100, 'Complete');
    
    const totalTriangles = stats.solidTriangles + stats.waterTriangles + stats.lavaTriangles + stats.glassTriangles + stats.modelTriangles;
    console.log(
      `✅ Region built: ${stats.totalBlocks.toLocaleString()} blocks, ` +
      `${totalTriangles.toLocaleString()} triangles ` +
      `in ${(stats.totalTimeMs / 1000).toFixed(2)}s` +
      (stats.glassTriangles > 0 ? ` (${stats.glassTriangles.toLocaleString()} glass)` : '') +
      (stats.modelTriangles > 0 ? ` (${stats.modelTriangles.toLocaleString()} model)` : '')
    );
    
    return {
      solidMesh,
      waterMesh,
      lavaMesh,
      glassMesh, // Glass and transparent block geometry
      modelMesh, // Non-cube block geometry (slabs, stairs, flowers, etc.)
      lodMeshes,
      offset,
      bounds,
      stats,
      // Keep grid reference for debug lookups or LOD generation
      _grid: returnGrid ? grid : (generateLOD ? null : grid),
    };
  }
  
  /**
   * Create Three.js geometries from mesh data
   */
  static createGeometry(meshData) {
    if (!meshData) return null;
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    
    // Add texture index attribute if present (for texture atlas lookup in shader)
    if (meshData.texIndices) {
      geometry.setAttribute('texIndex', new THREE.BufferAttribute(meshData.texIndices, 1));
    }
    
    // Add texture rotation attribute if present (for UV rotation in shader)
    if (meshData.texRotations) {
      geometry.setAttribute('texRotation', new THREE.BufferAttribute(meshData.texRotations, 1));
    }
    
    // Add biome tint type attribute if present (for biome tinting in shader)
    if (meshData.tintTypes) {
      geometry.setAttribute('tintType', new THREE.BufferAttribute(meshData.tintTypes, 1));
    }
    
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingSphere();
    
    return geometry;
  }
  
  /**
   * Create Three.js mesh objects from build result
   */
  static createMeshes(buildResult, materials) {
    const meshes = { solid: null, water: null, lava: null, glass: null };
    
    if (buildResult.solidMesh) {
      const geom = RegionMeshBuilder.createGeometry(buildResult.solidMesh);
      if (geom) {
        meshes.solid = new THREE.Mesh(geom, materials.solid);
        meshes.solid.frustumCulled = true;
      }
    }
    
    if (buildResult.waterMesh) {
      const geom = RegionMeshBuilder.createGeometry(buildResult.waterMesh);
      if (geom) {
        meshes.water = new THREE.Mesh(geom, materials.water);
        meshes.water.frustumCulled = true;
        meshes.water.renderOrder = 1;
      }
    }
    
    if (buildResult.lavaMesh) {
      const geom = RegionMeshBuilder.createGeometry(buildResult.lavaMesh);
      if (geom) {
        meshes.lava = new THREE.Mesh(geom, materials.lava);
        meshes.lava.frustumCulled = true;
        meshes.lava.renderOrder = 2;
      }
    }
    
    if (buildResult.glassMesh) {
      const geom = RegionMeshBuilder.createGeometry(buildResult.glassMesh);
      if (geom) {
        meshes.glass = new THREE.Mesh(geom, materials.glass);
        meshes.glass.frustumCulled = true;
        meshes.glass.renderOrder = 3; // Render after lava but still transparent
      }
    }
    
    return meshes;
  }
  
  dispose() {
    // Nothing to dispose in this version
  }
}

/**
 * Quick helper to build a region from chunks
 */
export async function buildRegionMeshes(chunks, options = {}) {
  const builder = new RegionMeshBuilder(options);
  return builder.buildRegion(chunks, options);
}

export default RegionMeshBuilder;
