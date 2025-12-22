/**
 * ChunkManager - High-Performance Region Viewer with Progressive Loading
 * 
 * Features:
 * - Progressive region loading (parse → mesh → render pipeline)
 * - Parallel processing across regions for memory efficiency
 * - Automatic mesh splitting for WebGL index limits
 * - GPU-based Y slicing via shader uniforms
 */

import * as THREE from 'three';
import { createSolidMaterial } from './materials/SolidMaterial';
import { createWaterMaterial } from './materials/WaterMaterial';
import { createLavaMaterial } from './materials/LavaMaterial';
import { RegionMeshBuilder } from '../mesh/RegionMeshBuilder';

// WebGL has a max index count limit (~30M). Use 25M to be safe.
const MAX_INDICES_PER_DRAW = 25000000;

// Max concurrent region processing
// Keep at 1-2 to avoid memory exhaustion with large worlds
const MAX_CONCURRENT_REGIONS = 2;

// Delay between regions to allow GC
const REGION_GC_DELAY_MS = 100;

// Memory thresholds for adaptive processing
const HIGH_MEMORY_BLOCK_THRESHOLD = 50_000_000; // 50M blocks = switch to conservative mode
const CRITICAL_MEMORY_BLOCK_THRESHOLD = 200_000_000; // 200M blocks = very conservative
const LOD_MEMORY_THRESHOLD = 30_000_000; // 30M blocks = skip LOD generation

// LOD distance thresholds (blocks from camera)
// These are calculated from LOD object position to camera
const LOD_DISTANCE_1 = 500;   // LOD1: 2x sampling (~4x fewer tris)
const LOD_DISTANCE_2 = 1000;  // LOD2: 4x sampling (~16x fewer tris)
const LOD_DISTANCE_3 = 2000;  // LOD3: 8x sampling (~64x fewer tris)
const LOD_DISTANCE_4 = 4000;  // LOD4: 16x sampling (~256x fewer tris)

export class ChunkManager {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.onProgress = options.onProgress || null;
    this.onComplete = options.onComplete || null;
    
    // Three.js groups (added to scene)
    this.solidGroup = new THREE.Group();
    this.waterGroup = new THREE.Group();
    this.lavaGroup = new THREE.Group();
    this.waterGroup.renderOrder = 1;
    this.lavaGroup.renderOrder = 2;
    scene.add(this.solidGroup);
    scene.add(this.waterGroup);
    scene.add(this.lavaGroup);
    
    // Shared materials with Y-slice uniforms
    this.solidMaterial = createSolidMaterial();
    this.waterMaterial = createWaterMaterial();
    this.lavaMaterial = createLavaMaterial();
    
    // Current meshes (arrays to support split meshes)
    this.solidMeshes = [];
    this.waterMeshes = [];
    this.lavaMeshes = [];
    
    // Stats
    this.totalBlocks = 0;
    this.loadedChunks = 0;
    this.loadedRegions = 0;
    
    // Center offset
    this.centerX = 0;
    this.centerY = 0;
    this.centerZ = 0;
    
    // Y range for filtering
    this.minY = -64;
    this.maxY = 320;
  }

  /**
   * Set Y range for slicing - uses GPU shader uniforms (instant)
   */
  setYRange(minY, maxY) {
    if (this.minY === minY && this.maxY === maxY) return;
    
    this.minY = minY;
    this.maxY = maxY;
    
    this.solidMaterial.uniforms.uMinY.value = minY;
    this.solidMaterial.uniforms.uMaxY.value = maxY;
    this.waterMaterial.uniforms.uMinY.value = minY;
    this.waterMaterial.uniforms.uMaxY.value = maxY;
    this.lavaMaterial.uniforms.uMinY.value = minY;
    this.lavaMaterial.uniforms.uMaxY.value = maxY;
  }

  /**
   * Split mesh data into chunks that fit within WebGL limits
   */
  _splitMeshData(meshData) {
    if (!meshData || meshData.indices.length <= MAX_INDICES_PER_DRAW) {
      return meshData ? [meshData] : [];
    }
    
    const { positions, normals, colors, indices } = meshData;
    const chunks = [];
    const indicesPerChunk = Math.floor(MAX_INDICES_PER_DRAW / 6) * 6;
    
    let indexOffset = 0;
    while (indexOffset < indices.length) {
      const chunkIndices = [];
      const chunkPositions = [];
      const chunkNormals = [];
      const chunkColors = [];
      const vertexMap = new Map();
      let newVertexIndex = 0;
      
      const endIndex = Math.min(indexOffset + indicesPerChunk, indices.length);
      
      for (let i = indexOffset; i < endIndex; i++) {
        const oldIdx = indices[i];
        
        if (!vertexMap.has(oldIdx)) {
          const pos = oldIdx * 3;
          chunkPositions.push(positions[pos], positions[pos + 1], positions[pos + 2]);
          chunkNormals.push(normals[pos], normals[pos + 1], normals[pos + 2]);
          chunkColors.push(colors[pos], colors[pos + 1], colors[pos + 2]);
          vertexMap.set(oldIdx, newVertexIndex++);
        }
        
        chunkIndices.push(vertexMap.get(oldIdx));
      }
      
      chunks.push({
        positions: new Float32Array(chunkPositions),
        normals: new Float32Array(chunkNormals),
        colors: new Float32Array(chunkColors),
        indices: new Uint32Array(chunkIndices),
        vertexCount: newVertexIndex,
        triangleCount: chunkIndices.length / 3,
      });
      
      indexOffset = endIndex;
    }
    
    return chunks;
  }

  /**
   * Add meshes to scene from mesh data
   */
  _addMeshesToScene(meshData, material, group, meshArray) {
    const splitData = this._splitMeshData(meshData);
    
    for (const data of splitData) {
      const geom = RegionMeshBuilder.createGeometry(data);
      if (geom) {
        const mesh = new THREE.Mesh(geom, material);
        mesh.frustumCulled = true;
        group.add(mesh);
        meshArray.push(mesh);
      }
    }
    
    return splitData.length;
  }

  /**
   * Add meshes with LOD (Level of Detail) support
   * Creates a single THREE.LOD object with multiple detail levels
   * 
   * IMPORTANT: LOD uses a single mesh per level - we cannot split the full-detail
   * mesh because the LOD meshes are for the entire region. If the full mesh needs
   * splitting, we skip LOD and just use regular meshes.
   */
  _addMeshesWithLOD(meshData, lodMeshes, material, group, meshArray) {
    // If no LOD meshes, fall back to regular mesh
    if (!lodMeshes || (!lodMeshes.lod1 && !lodMeshes.lod2)) {
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Check if full-detail mesh needs splitting - if so, we can't use LOD properly
    // because LOD meshes are for the whole region, not split chunks
    if (meshData.indices.length > MAX_INDICES_PER_DRAW) {
      console.log('[ChunkManager] Mesh too large for LOD, using split meshes without LOD');
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Create single LOD object with all detail levels
    const lod = new THREE.LOD();
    
    // Compute center of the mesh for proper LOD distance calculation
    // THREE.LOD measures distance from its position to the camera
    let meshCenter = null;
    
    // LOD 0: Full detail (closest)
    const geom0 = RegionMeshBuilder.createGeometry(meshData);
    if (geom0) {
      geom0.computeBoundingBox();
      meshCenter = new THREE.Vector3();
      geom0.boundingBox.getCenter(meshCenter);
      
      // Translate geometry so it's centered at origin
      // Then we'll position the LOD object at the original center
      geom0.translate(-meshCenter.x, -meshCenter.y, -meshCenter.z);
      
      const mesh0 = new THREE.Mesh(geom0, material);
      mesh0.frustumCulled = true;
      lod.addLevel(mesh0, 0);
    }
    
    // If we have a mesh center, translate all LOD geometries the same way
    const translateGeom = (geom) => {
      if (meshCenter && geom) {
        geom.translate(-meshCenter.x, -meshCenter.y, -meshCenter.z);
      }
      return geom;
    };
    
    // LOD 1: 2x sampling
    if (lodMeshes.lod1) {
      const geom1 = translateGeom(RegionMeshBuilder.createGeometry(lodMeshes.lod1));
      if (geom1) {
        const mesh1 = new THREE.Mesh(geom1, material);
        mesh1.frustumCulled = true;
        lod.addLevel(mesh1, LOD_DISTANCE_1);
      }
    }
    
    // LOD 2: 4x sampling
    if (lodMeshes.lod2) {
      const geom2 = translateGeom(RegionMeshBuilder.createGeometry(lodMeshes.lod2));
      if (geom2) {
        const mesh2 = new THREE.Mesh(geom2, material);
        mesh2.frustumCulled = true;
        lod.addLevel(mesh2, LOD_DISTANCE_2);
      }
    }
    
    // LOD 3: 8x sampling
    if (lodMeshes.lod3) {
      const geom3 = translateGeom(RegionMeshBuilder.createGeometry(lodMeshes.lod3));
      if (geom3) {
        const mesh3 = new THREE.Mesh(geom3, material);
        mesh3.frustumCulled = true;
        lod.addLevel(mesh3, LOD_DISTANCE_3);
      }
    }
    
    // LOD 4: 16x sampling
    if (lodMeshes.lod4) {
      const geom4 = translateGeom(RegionMeshBuilder.createGeometry(lodMeshes.lod4));
      if (geom4) {
        const mesh4 = new THREE.Mesh(geom4, material);
        mesh4.frustumCulled = true;
        lod.addLevel(mesh4, LOD_DISTANCE_4);
      }
    }
    
    // Position LOD object at the mesh center so distance calculation works correctly
    if (meshCenter) {
      lod.position.copy(meshCenter);
    }
    
    lod.autoUpdate = true;
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }

  /**
   * Load chunks from parsed MCA data (single region, simple mode)
   */
  async loadChunks(chunks, options = {}) {
    const startTime = performance.now();
    this.clear();
    
    console.log(`[ChunkManager] Loading ${chunks.length} chunks...`);
    
    const meshBuilder = new RegionMeshBuilder();
    
    try {
      const result = await meshBuilder.buildRegion(chunks, {});
      const { solidMesh, waterMesh, lavaMesh, stats } = result;
      
      if (solidMesh) this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
      if (waterMesh) this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes);
      if (lavaMesh) this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
      
      this.totalBlocks = stats.totalBlocks;
      this.loadedChunks = stats.chunksProcessed;
      this.loadedRegions = 1;
      
      const totalTime = performance.now() - startTime;
      const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
      
      console.log(
        `[ChunkManager] Loaded ${chunks.length} chunks, ` +
        `${this.totalBlocks.toLocaleString()} blocks, ` +
        `${meshCount} draw calls in ${(totalTime / 1000).toFixed(2)}s`
      );
      
      meshBuilder.dispose();
      this.onComplete?.();
      
      return {
        chunksLoaded: this.loadedChunks,
        totalBlocks: this.totalBlocks,
      };
      
    } catch (error) {
      console.error('[ChunkManager] Failed to load chunks:', error);
      meshBuilder.dispose();
      throw error;
    }
  }

  /**
   * Progressive loading: Process regions in a streaming pipeline
   * 
   * Each region goes through: Parse → Mesh → Render
   * Multiple regions process in parallel (limited concurrency)
   * Memory is freed as each region completes its pipeline stage
   * 
   * @param {Array} regionFiles - Array of { file, regionX, regionZ } objects
   * @param {Function} parseRegion - Async function (file) => chunks array
   * @param {Object} options - { onRegionStart, onRegionComplete, enableLOD }
   */
  async loadRegionsProgressive(regionFiles, parseRegion, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, enableLOD = false } = options;
    
    this.clear();
    
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let totalChunks = 0;
    let totalBlocks = 0;
    let totalTriangles = 0;
    
    // Reduce concurrency for large region counts to save memory
    const effectiveConcurrency = totalRegions > 10 ? 1 : MAX_CONCURRENT_REGIONS;
    const effectiveGcDelay = totalRegions > 10 ? 200 : REGION_GC_DELAY_MS;
    
    console.log(`[ChunkManager] Progressive loading ${totalRegions} regions (concurrency: ${effectiveConcurrency})...`);
    
    // Process a single region through the full pipeline
    const processRegion = async (regionInfo, index) => {
      const { file, regionX, regionZ } = regionInfo;
      const regionName = file.name || `Region ${regionX},${regionZ}`;
      
      onRegionStart?.(index, totalRegions, regionName);
      
      try {
        // Step 1: Parse the region file
        const parseStart = performance.now();
        const chunks = await parseRegion(file);
        const parseTime = performance.now() - parseStart;
        
        if (!chunks || chunks.length === 0) {
          console.warn(`[ChunkManager] No chunks in ${regionName}`);
          return null;
        }
        
        // Apply world offset to chunks (region coords * 32 chunks * 16 blocks)
        // The chunk x/z from parser are local (0-31), we need world coordinates
        const offsetChunks = chunks.map(chunk => ({
          ...chunk,
          x: chunk.x + regionX * 32,
          z: chunk.z + regionZ * 32,
        }));
        
        // Step 2: Build meshes (this region's builder is independent)
        // Don't center meshes - keep at world coordinates for proper multi-region positioning
        // Always generate LOD for multi-region loads - it's essential for performance
        const shouldGenerateLOD = enableLOD && totalRegions > 1;
        
        const meshBuilder = new RegionMeshBuilder();
        const meshStart = performance.now();
        const result = await meshBuilder.buildRegion(offsetChunks, { 
          centerMesh: false,
          generateLOD: shouldGenerateLOD,
        });
        const meshTime = performance.now() - meshStart;
        
        // Step 3: Add to scene immediately (user sees progress)
        const { solidMesh, waterMesh, lavaMesh, lodMeshes, stats } = result;

        let drawCalls = 0;
        if (solidMesh) {
          if (shouldGenerateLOD && lodMeshes) {
            drawCalls += this._addMeshesWithLOD(solidMesh, lodMeshes, this.solidMaterial, this.solidGroup, this.solidMeshes);
          } else {
            drawCalls += this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        if (waterMesh) drawCalls += this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes);
        if (lavaMesh) drawCalls += this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
        
        // Clean up builder immediately to free memory
        meshBuilder.dispose();
        
        // Update stats
        totalChunks += stats.chunksProcessed;
        totalBlocks += stats.totalBlocks;
        const triangles = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0);
        totalTriangles += triangles;
        
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        
        console.log(
          `[ChunkManager] ✓ ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `(parse: ${(parseTime/1000).toFixed(1)}s, mesh: ${(meshTime/1000).toFixed(1)}s)`
        );
        
        onRegionComplete?.(index, totalRegions, regionName, stats);
        
        return stats;
        
      } catch (error) {
        // Log error but continue with other regions
        const errMsg = error?.message || String(error);
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed: ${errMsg.slice(0, 100)}`);
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        
        // Brief pause to help with memory recovery
        await new Promise(r => setTimeout(r, 200));
        return null;
      }
    };
    
    // Process regions with adaptive concurrency and GC pauses
    const results = [];
    const pending = [];
    
    for (let i = 0; i < regionFiles.length; i++) {
      // Start processing this region
      const promise = processRegion(regionFiles[i], i).then(result => {
        // Remove from pending when done
        const idx = pending.indexOf(promise);
        if (idx !== -1) pending.splice(idx, 1);
        return result;
      });
      
      pending.push(promise);
      results.push(promise);
      
      // Wait if we've hit the concurrency limit
      if (pending.length >= effectiveConcurrency) {
        await Promise.race(pending);
        // GC pause
        await new Promise(r => setTimeout(r, effectiveGcDelay));
      }
    }
    
    // Wait for all remaining regions
    await Promise.all(results);
    
    // Update final stats
    this.totalBlocks = totalBlocks;
    this.loadedChunks = totalChunks;
    this.loadedRegions = completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    
    console.log(
      `[ChunkManager] ✅ Complete: ${completedRegions} regions, ` +
      `${totalChunks.toLocaleString()} chunks, ${totalBlocks.toLocaleString()} blocks, ` +
      `${totalTriangles.toLocaleString()} triangles, ${meshCount} draw calls ` +
      `in ${(totalTime / 1000).toFixed(1)}s`
    );
    
    this.onComplete?.();
    
    return {
      regionsLoaded: completedRegions,
      chunksLoaded: totalChunks,
      totalBlocks,
      totalTriangles,
      meshCount,
      timeMs: totalTime,
    };
  }

  /**
   * Add more regions to existing scene (without clearing)
   */
  async addRegionsProgressive(regionFiles, parseRegion, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, enableLOD = false } = options;
    
    // Don't clear - keep existing meshes
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let totalChunks = 0;
    let totalBlocks = 0;
    let totalTriangles = 0;
    
    // Adaptive processing based on current memory pressure
    const currentBlocks = this.totalBlocks;
    const isHighMemory = currentBlocks > HIGH_MEMORY_BLOCK_THRESHOLD;
    const isCriticalMemory = currentBlocks > CRITICAL_MEMORY_BLOCK_THRESHOLD;
    
    // Reduce concurrency and increase GC time under memory pressure
    const effectiveConcurrency = isCriticalMemory ? 1 : (isHighMemory ? 1 : MAX_CONCURRENT_REGIONS);
    const effectiveGcDelay = isCriticalMemory ? 500 : (isHighMemory ? 300 : REGION_GC_DELAY_MS);
    
    console.log(`[ChunkManager] Adding ${totalRegions} more regions...` + 
      (isHighMemory ? ` (memory-conservative mode: ${(currentBlocks / 1_000_000).toFixed(0)}M blocks loaded)` : ''));
    
    // Process a single region through the full pipeline
    const processRegion = async (regionInfo, index) => {
      const { file, regionX, regionZ } = regionInfo;
      const regionName = file.name || `Region ${regionX},${regionZ}`;
      
      onRegionStart?.(index, totalRegions, regionName);
      
      try {
        const parseStart = performance.now();
        const chunks = await parseRegion(file);
        const parseTime = performance.now() - parseStart;
        
        if (!chunks || chunks.length === 0) {
          console.warn(`[ChunkManager] No chunks in ${regionName}`);
          return null;
        }
        
        const offsetChunks = chunks.map(chunk => ({
          ...chunk,
          x: chunk.x + regionX * 32,
          z: chunk.z + regionZ * 32,
        }));
        
        const meshBuilder = new RegionMeshBuilder();
        const meshStart = performance.now();
        
        // Force single-threaded mode when memory is high to avoid parallel allocation failures
        // Generate LOD for added regions too (essential for performance with many regions)
        const shouldGenerateLOD = enableLOD && !isCriticalMemory;
        
        const result = await meshBuilder.buildRegion(offsetChunks, { 
          centerMesh: false,
          forceSequential: isHighMemory, // Skip parallel mesher
          generateLOD: shouldGenerateLOD,
        });
        const meshTime = performance.now() - meshStart;
        
        const { solidMesh, waterMesh, lavaMesh, lodMeshes, stats } = result;
        
        let drawCalls = 0;
        if (solidMesh) {
          if (shouldGenerateLOD && lodMeshes) {
            drawCalls += this._addMeshesWithLOD(solidMesh, lodMeshes, this.solidMaterial, this.solidGroup, this.solidMeshes);
          } else {
            drawCalls += this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        if (waterMesh) drawCalls += this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes);
        if (lavaMesh) drawCalls += this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
        
        meshBuilder.dispose();
        
        totalChunks += stats.chunksProcessed;
        totalBlocks += stats.totalBlocks;
        const triangles = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0);
        totalTriangles += triangles;
        
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        
        console.log(
          `[ChunkManager] ✓ Added ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `(parse: ${(parseTime/1000).toFixed(1)}s, mesh: ${(meshTime/1000).toFixed(1)}s)`
        );
        
        onRegionComplete?.(index, totalRegions, regionName, stats);
        
        return stats;
        
      } catch (error) {
        const errMsg = error?.message || String(error);
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed: ${errMsg.slice(0, 100)}`);
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        await new Promise(r => setTimeout(r, effectiveGcDelay * 2)); // Longer delay on error
        return null;
      }
    };
    
    // Process with adaptive concurrency based on memory pressure
    const results = [];
    const pending = [];
    
    for (let i = 0; i < regionFiles.length; i++) {
      const promise = processRegion(regionFiles[i], i).then(result => {
        const idx = pending.indexOf(promise);
        if (idx !== -1) pending.splice(idx, 1);
        return result;
      });
      
      pending.push(promise);
      results.push(promise);
      
      if (pending.length >= effectiveConcurrency) {
        await Promise.race(pending);
        // GC pause - longer when memory is high
        await new Promise(r => setTimeout(r, effectiveGcDelay));
      }
    }
    
    await Promise.all(results);
    
    // Update totals (add to existing)
    this.totalBlocks += totalBlocks;
    this.loadedChunks += totalChunks;
    this.loadedRegions += completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    
    console.log(
      `[ChunkManager] ✅ Added ${completedRegions} regions ` +
      `(total: ${this.loadedRegions} regions, ${this.loadedChunks.toLocaleString()} chunks, ` +
      `${this.totalBlocks.toLocaleString()} blocks) in ${(totalTime / 1000).toFixed(1)}s`
    );
    
    this.onComplete?.();
    
    return {
      regionsAdded: completedRegions,
      totalRegions: this.loadedRegions,
      totalChunks: this.loadedChunks,
      totalBlocks: this.totalBlocks,
      meshCount,
      timeMs: totalTime,
    };
  }

  /**
   * Dispose a mesh or LOD object and all its geometries
   */
  _disposeMeshOrLOD(obj) {
    if (obj.isLOD) {
      // LOD object - dispose all levels
      obj.levels.forEach(level => {
        if (level.object?.geometry) {
          level.object.geometry.dispose();
        }
      });
    } else if (obj.geometry) {
      obj.geometry.dispose();
    }
  }

  /**
   * Clear all meshes
   */
  clear() {
    for (const mesh of this.solidMeshes) {
      this.solidGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.solidMeshes = [];
    
    for (const mesh of this.waterMeshes) {
      this.waterGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.waterMeshes = [];
    
    for (const mesh of this.lavaMeshes) {
      this.lavaGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.lavaMeshes = [];
    
    this.totalBlocks = 0;
    this.loadedChunks = 0;
    this.loadedRegions = 0;
  }

  /**
   * Dispose all resources
   */
  dispose() {
    this.clear();
    
    this.solidMaterial.dispose();
    this.waterMaterial.dispose();
    this.lavaMaterial.dispose();
    
    this.scene.remove(this.solidGroup);
    this.scene.remove(this.waterGroup);
    this.scene.remove(this.lavaGroup);
  }

  /**
   * Get current stats
   */
  getStats() {
    let triangleCount = 0;
    
    for (const mesh of this.solidMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    for (const mesh of this.waterMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    for (const mesh of this.lavaMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    
    return {
      regionsLoaded: this.loadedRegions,
      chunksLoaded: this.loadedChunks,
      totalBlocks: this.totalBlocks,
      triangleCount,
      meshCount: this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length,
    };
  }
}

export default ChunkManager;
