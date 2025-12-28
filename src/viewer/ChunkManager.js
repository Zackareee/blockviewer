/**
 * ChunkManager - High-Performance Region Viewer with Progressive Loading
 * 
 * Features:
 * - Progressive region loading (parse → mesh → render pipeline)
 * - Unified worker pipeline for fastest possible loading
 * - Parallel processing across regions for memory efficiency
 * - Automatic mesh splitting for WebGL index limits
 * - GPU-based Y slicing via shader uniforms
 * - Streaming support for hundreds of regions
 * 
 * Performance Target: 3 seconds per region for full pipeline
 */

import * as THREE from 'three';
import { createSolidMaterial, createModelMaterial } from './materials/SolidMaterial';
import { createWaterMaterial } from './materials/WaterMaterial';
import { createLavaMaterial } from './materials/LavaMaterial';
import { createGlassMaterial } from './materials/GlassMaterial';
import { RegionMeshBuilder } from '../mesh/RegionMeshBuilder';
import { StreamingRegionLoader } from '../mesh/StreamingRegionLoader';
import { BinaryGrid } from '../mesh/BinaryGrid';
import { getBlockRegistry } from '../mesh/BlockRegistry';

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
// Increased distances so full detail shows for longer
const LOD_DISTANCE_1 = 800;   // LOD1: ~8k points
const LOD_DISTANCE_2 = 1500;  // LOD2: ~4k points
const LOD_DISTANCE_3 = 2500;  // LOD3: ~2k points
const LOD_DISTANCE_4 = 4000;  // LOD4: ~1k points

export class ChunkManager {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.onProgress = options.onProgress || null;
    this.onComplete = options.onComplete || null;
    
    // Three.js groups (added to scene)
    this.solidGroup = new THREE.Group();
    this.waterGroup = new THREE.Group();
    this.lavaGroup = new THREE.Group();
    this.glassGroup = new THREE.Group(); // Glass and transparent blocks
    this.modelGroup = new THREE.Group(); // Non-cube blocks (slabs, stairs, flowers, etc.)
    this.waterGroup.renderOrder = 1;
    this.lavaGroup.renderOrder = 2;
    this.glassGroup.renderOrder = 3; // Glass renders after water/lava
    this.modelGroup.renderOrder = 0; // Same as solid
    scene.add(this.solidGroup);
    scene.add(this.waterGroup);
    scene.add(this.lavaGroup);
    scene.add(this.glassGroup);
    scene.add(this.modelGroup);
    
    // Shared materials with Y-slice uniforms
    this.solidMaterial = createSolidMaterial();
    this.waterMaterial = createWaterMaterial();
    this.lavaMaterial = createLavaMaterial();
    this.glassMaterial = createGlassMaterial();
    this.modelMaterial = createModelMaterial(); // For non-cube blocks with polygon offset
    
    // Current meshes (arrays to support split meshes)
    this.solidMeshes = [];
    this.waterMeshes = [];
    this.lavaMeshes = [];
    this.glassMeshes = []; // Glass and transparent block meshes
    this.modelMeshes = []; // Non-cube block meshes
    
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
    
    // Streaming loader for optimized region loading
    this.streamingLoader = null;
    
    // Use streaming by default (faster for most cases)
    this.useStreaming = options.useStreaming !== false;
    
    // Debug mode: block lookup grid (stores block IDs for position lookup)
    // Only populated when enableDebugLookup is true
    this.debugGrid = null;
    this.blockRegistry = getBlockRegistry();
  }
  
  /**
   * Enable debug block lookup (stores block data for coordinate queries)
   * Call this before loading regions if you need block info at coordinates
   */
  enableDebugLookup() {
    if (!this.debugGrid) {
      this.debugGrid = new BinaryGrid();
    }
  }
  
  /**
   * Get block info at world coordinates (for debug mode)
   * @returns {Object|null} { id, name, category } or null if no block
   */
  getBlockAt(worldX, worldY, worldZ) {
    if (!this.debugGrid) return null;
    
    const blockData = this.debugGrid.getBlock(worldX, worldY, worldZ);
    if (!blockData || blockData.blockId === 0) return null;
    
    const info = this.blockRegistry.getBlockInfo(blockData.blockId);
    if (!info) return null;
    
    return {
      id: blockData.blockId,
      name: info.name,
      category: info.category,
    };
  }
  
  /**
   * Merge a source grid into the debug grid
   * @param {BinaryGrid} sourceGrid - Grid to merge from
   */
  _mergeDebugGrid(sourceGrid) {
    if (!this.debugGrid || !sourceGrid) return;
    
    // Iterate all sections in source grid and merge into debug grid
    for (const [key, section] of sourceGrid.sections) {
      // Parse key to get chunk coords
      const [chunkX, chunkZ, sectionY] = key.split(',').map(Number);
      
      // Copy non-air blocks to debug grid
      for (let i = 0; i < section.length; i++) {
        if (section[i] !== 0) {
          const localX = i % 16;
          const localZ = Math.floor(i / 16) % 16;
          const localY = Math.floor(i / 256);
          
          const blockId = section[i] & 0x0FFF;
          const level = (section[i] >> 12) & 0xF;
          
          // Calculate world Y from section Y index
          const worldY = (sectionY - 4) * 16 + localY; // sectionY is 0-based from MIN_Y=-64
          
          this.debugGrid.setBlockLocal(chunkX, chunkZ, localX, worldY, localZ, blockId, level);
        }
      }
    }
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
    this.glassMaterial.uniforms.uMinY.value = minY;
    this.glassMaterial.uniforms.uMaxY.value = maxY;
    this.modelMaterial.uniforms.uMinY.value = minY;
    this.modelMaterial.uniforms.uMaxY.value = maxY;
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
   * Meshes are kept in their original world coordinates (no translation).
   * LOD object is positioned at mesh center for distance calculation only.
   */
  _addMeshesWithLOD(meshData, lodMeshes, material, group, meshArray) {
    // If no LOD meshes, fall back to regular mesh
    if (!lodMeshes || (!lodMeshes.lod1 && !lodMeshes.lod2)) {
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Check if full-detail mesh needs splitting - if so, we can't use LOD properly
    if (meshData.indices.length > MAX_INDICES_PER_DRAW) {
      console.log('[ChunkManager] Mesh too large for LOD, using split meshes without LOD');
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Create geometries WITHOUT any translation - they stay in world coords
    const geom0 = RegionMeshBuilder.createGeometry(meshData);
    if (!geom0) {
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Compute center from full-detail mesh for LOD distance calculation
    geom0.computeBoundingBox();
    const meshCenter = new THREE.Vector3();
    geom0.boundingBox.getCenter(meshCenter);
    
    // Create LOD object
    const lod = new THREE.LOD();
    
    // Add full detail mesh
    const mesh0 = new THREE.Mesh(geom0, material);
    mesh0.frustumCulled = true;
    // Offset mesh position so it renders at correct world position
    // when LOD is at meshCenter
    mesh0.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    lod.addLevel(mesh0, 0);
    
    // Helper to add LOD level with proper positioning
    let lodLevelsAdded = 1; // Start at 1 for LOD0
    const addLodLevel = (lodData, distance, levelName) => {
      if (!lodData) {
        console.log(`[LOD] ${levelName} skipped - no data`);
        return;
      }
      const geom = RegionMeshBuilder.createGeometry(lodData);
      if (!geom) {
        console.log(`[LOD] ${levelName} skipped - no geometry`);
        return;
      }
      const mesh = new THREE.Mesh(geom, material);
      mesh.frustumCulled = true;
      mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
      lod.addLevel(mesh, distance);
      lodLevelsAdded++;
      console.log(`[LOD] ${levelName} added at distance ${distance}, ${lodData.triangleCount} tris`);
    };
    
    addLodLevel(lodMeshes.lod1, LOD_DISTANCE_1, 'LOD1');
    addLodLevel(lodMeshes.lod2, LOD_DISTANCE_2, 'LOD2');
    addLodLevel(lodMeshes.lod3, LOD_DISTANCE_3, 'LOD3');
    addLodLevel(lodMeshes.lod4, LOD_DISTANCE_4, 'LOD4');
    
    console.log(`[LOD] Total ${lodLevelsAdded} levels added to LOD object`);
    
    // Position LOD at mesh center for distance calculation
    lod.position.copy(meshCenter);
    
    lod.autoUpdate = true;
    lod.frustumCulled = false; // Disable culling for LOD itself - children handle their own
    
    // Track LOD level changes for debugging
    lod.userData.currentLevel = -1;
    lod.userData.levelDistances = [0, LOD_DISTANCE_1, LOD_DISTANCE_2, LOD_DISTANCE_3, LOD_DISTANCE_4];
    const originalUpdate = lod.update.bind(lod);
    lod.update = function(camera) {
      const oldLevel = this.userData.currentLevel;
      originalUpdate(camera);
      // Find which level is now visible
      let newLevel = -1;
      for (let i = 0; i < this.levels.length; i++) {
        if (this.levels[i].object.visible) {
          newLevel = i;
          break;
        }
      }
      if (newLevel !== oldLevel) {
        const dist = this.position.distanceTo(camera.position).toFixed(0);
        console.log(`[LOD] Level changed: ${oldLevel} → ${newLevel} (distance: ${dist} blocks)`);
        this.userData.currentLevel = newLevel;
      }
    };
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }

  /**
   * Add fluid mesh (water/lava) with LOD that hides it at distance
   * At close range: show full detail fluid mesh
   * At LOD distance: hide completely (fluids are baked into LOD surface mesh)
   */
  _addFluidMeshWithLOD(meshData, material, group, meshArray, meshCenter) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    // Check if mesh needs splitting - if so, fall back to regular (always visible)
    if (meshData.indices.length > MAX_INDICES_PER_DRAW) {
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    const geom = RegionMeshBuilder.createGeometry(meshData);
    if (!geom) return 0;
    
    // Create LOD object
    const lod = new THREE.LOD();
    
    // Level 0: Full detail fluid mesh
    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = true;
    mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    lod.addLevel(mesh, 0);
    
    // Level 1: Empty mesh (invisible) at LOD_DISTANCE_1
    // Create minimal empty geometry to hide fluids when LOD kicks in
    const emptyGeom = new THREE.BufferGeometry();
    emptyGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const emptyMesh = new THREE.Mesh(emptyGeom, material);
    lod.addLevel(emptyMesh, LOD_DISTANCE_1);
    
    // Position LOD at same center as solid mesh
    lod.position.copy(meshCenter);
    lod.autoUpdate = true;
    lod.frustumCulled = false;
    
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
      const result = await meshBuilder.buildRegion(chunks, { 
        enableModelMeshes: true,
        returnGrid: !!this.debugGrid,
      });
      const { solidMesh, waterMesh, lavaMesh, glassMesh, modelMesh, stats, _grid } = result;
      
      // Merge grid for debug lookups
      if (_grid && this.debugGrid) {
        this._mergeDebugGrid(_grid);
      }
      
      if (solidMesh) this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
      if (waterMesh) this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes);
      if (lavaMesh) this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
      if (glassMesh) this._addMeshesToScene(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes);
      if (modelMesh) this._addMeshesToScene(modelMesh, this.modelMaterial, this.modelGroup, this.modelMeshes);
      
      this.totalBlocks = stats.totalBlocks;
      this.loadedChunks = stats.chunksProcessed;
      this.loadedRegions = 1;
      
      const totalTime = performance.now() - startTime;
      const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length + this.glassMeshes.length + this.modelMeshes.length;
      
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
    const { onRegionStart, onRegionComplete, enableLOD = false, enableModelMeshes = false } = options;
    
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
          enableModelMeshes,
          returnGrid: !!this.debugGrid,
        });
        const meshTime = performance.now() - meshStart;
        
        // Merge grid for debug lookups
        if (result._grid && this.debugGrid) {
          this._mergeDebugGrid(result._grid);
        }
        
        // Step 3: Add to scene immediately (user sees progress)
        const { solidMesh, waterMesh, lavaMesh, glassMesh, modelMesh, lodMeshes, stats } = result;

        let drawCalls = 0;
        let meshCenter = null;
        
        if (solidMesh) {
          if (shouldGenerateLOD && lodMeshes) {
            // Compute mesh center for LOD positioning (used by fluids too)
            const geom = RegionMeshBuilder.createGeometry(solidMesh);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose(); // We'll recreate in _addMeshesWithLOD
            }
            drawCalls += this._addMeshesWithLOD(solidMesh, lodMeshes, this.solidMaterial, this.solidGroup, this.solidMeshes);
          } else {
            drawCalls += this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        
        // For water/lava/glass: use LOD to hide at distance (fluids baked into LOD surface)
        if (waterMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes);
          }
        }
        if (lavaMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
          }
        }
        if (glassMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes);
          }
        }
        
        // Add model meshes (non-cube blocks like slabs, stairs, flowers)
        if (modelMesh) {
          drawCalls += this._addMeshesToScene(modelMesh, this.modelMaterial, this.modelGroup, this.modelMeshes);
        }
        
        // Clean up builder immediately to free memory
        meshBuilder.dispose();
        
        // Update stats
        totalChunks += stats.chunksProcessed;
        totalBlocks += stats.totalBlocks;
        const triangles = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
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
    const { onRegionStart, onRegionComplete, enableLOD = false, enableModelMeshes = false } = options;
    
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
          enableModelMeshes,
          returnGrid: !!this.debugGrid,
        });
        const meshTime = performance.now() - meshStart;
        
        // Merge grid for debug lookups
        if (result._grid && this.debugGrid) {
          this._mergeDebugGrid(result._grid);
        }
        
        const { solidMesh, waterMesh, lavaMesh, glassMesh, modelMesh, lodMeshes, stats } = result;
        
        let drawCalls = 0;
        let meshCenter = null;
        
        if (solidMesh) {
          if (shouldGenerateLOD && lodMeshes) {
            // Compute mesh center for LOD positioning (used by fluids too)
            const geom = RegionMeshBuilder.createGeometry(solidMesh);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose();
            }
            drawCalls += this._addMeshesWithLOD(solidMesh, lodMeshes, this.solidMaterial, this.solidGroup, this.solidMeshes);
          } else {
            drawCalls += this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        
        // For water/lava/glass: use LOD to hide at distance (fluids baked into LOD surface)
        if (waterMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes);
          }
        }
        if (lavaMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
          }
        }
        if (glassMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes);
          }
        }
        
        // Add model meshes (non-cube blocks like slabs, stairs, flowers)
        if (modelMesh) {
          drawCalls += this._addMeshesToScene(modelMesh, this.modelMaterial, this.modelGroup, this.modelMeshes);
        }
        
        meshBuilder.dispose();
        
        totalChunks += stats.chunksProcessed;
        totalBlocks += stats.totalBlocks;
        const triangles = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
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
   * Fast streaming loading using unified worker pipeline
   * 
   * This method uses the new StreamingRegionLoader which handles the entire
   * pipeline (parse → decode → mesh) in a worker, returning transferable buffers.
   * 
   * This is the fastest method for loading regions:
   * - No main thread blocking during processing
   * - Transferable buffers avoid memory copies
   * - Target: 3 seconds per region
   * 
   * @param {Array} regionFiles - Array of { file, regionX, regionZ } objects
   * @param {Object} options - { onRegionStart, onRegionComplete }
   */
  async loadRegionsStreaming(regionFiles, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, enableLOD = true } = options;
    
    this.clear();
    
    if (!this.streamingLoader) {
      this.streamingLoader = new StreamingRegionLoader({
        maxWorkers: Math.min(navigator.hardwareConcurrency || 4, 4),
        gcDelay: 50,
      });
    }
    
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let totalBlocks = 0;
    let totalChunks = 0;
    let totalTriangles = 0;
    
    // Generate LOD for multi-region loads (essential for performance)
    const shouldGenerateLOD = enableLOD && totalRegions >= 1;
    
    console.log(`[ChunkManager] 🚀 Fast streaming ${totalRegions} regions (LOD: ${shouldGenerateLOD})...`);
    
    // Process all regions using the streaming loader
    for (let i = 0; i < regionFiles.length; i++) {
      const region = regionFiles[i];
      const regionName = region.file.name || `r.${region.regionX}.${region.regionZ}.mca`;
      
      onRegionStart?.(i, totalRegions, regionName);
      this.onProgress?.(i, totalRegions);
      
      try {
        const regionStart = performance.now();
        const { result, stats } = await this.streamingLoader.processRegion(
          region.file,
          region.regionX,
          region.regionZ,
          { generateLOD: shouldGenerateLOD }
        );
        const regionTime = performance.now() - regionStart;
        
        // Add meshes to scene
        let drawCalls = 0;
        let meshCenter = null;
        
        // Handle solid mesh with LOD
        if (result.solid) {
          if (shouldGenerateLOD && result.lodMeshes) {
            // Compute mesh center for LOD positioning
            const geom = this._createGeometryFromBuffers(result.solid);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose();
            }
            drawCalls += this._addMeshWithLODFromBuffers(
              result.solid, 
              result.lodMeshes, 
              this.solidMaterial, 
              this.solidGroup, 
              this.solidMeshes
            );
          } else {
            drawCalls += this._addMeshFromBuffers(result.solid, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        
        // Handle water/lava with LOD (hide at distance)
        if (result.water) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes);
          }
        }
        if (result.lava) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
          }
        }
        if (result.glass) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes);
          }
        }
        
        // Update stats
        totalBlocks += stats.totalBlocks || 0;
        totalChunks += stats.chunksProcessed || 0;
        const tris = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
        totalTriangles += tris;
        completedRegions++;
        
        const lodInfo = shouldGenerateLOD ? `, LOD: ${(stats.lodTimeMs || 0).toFixed(0)}ms` : '';
        console.log(
          `[ChunkManager] ✓ ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `in ${(regionTime / 1000).toFixed(2)}s${lodInfo}`
        );
        
        onRegionComplete?.(i, totalRegions, regionName, stats);
        this.onProgress?.(completedRegions, totalRegions);
        
      } catch (error) {
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed:`, error.message);
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
      }
    }
    
    // Update final stats
    this.totalBlocks = totalBlocks;
    this.loadedChunks = totalChunks;
    this.loadedRegions = completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    const avgTime = completedRegions > 0 ? totalTime / completedRegions : 0;
    
    console.log(
      `[ChunkManager] ✅ Streaming complete: ${completedRegions} regions, ` +
      `${totalChunks.toLocaleString()} chunks, ${totalBlocks.toLocaleString()} blocks, ` +
      `${totalTriangles.toLocaleString()} triangles in ${(totalTime / 1000).toFixed(1)}s ` +
      `(avg ${(avgTime / 1000).toFixed(2)}s/region)`
    );
    
    this.onComplete?.();
    
    return {
      regionsLoaded: completedRegions,
      chunksLoaded: totalChunks,
      totalBlocks,
      totalTriangles,
      meshCount,
      timeMs: totalTime,
      avgTimePerRegion: avgTime,
    };
  }
  
  /**
   * Add more regions using streaming loader (without clearing existing)
   */
  async addRegionsStreaming(regionFiles, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, enableLOD = true } = options;
    
    // Don't clear - keep existing meshes
    
    if (!this.streamingLoader) {
      this.streamingLoader = new StreamingRegionLoader({
        maxWorkers: Math.min(navigator.hardwareConcurrency || 4, 4),
        gcDelay: 50,
      });
    }
    
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let addedBlocks = 0;
    let addedChunks = 0;
    let addedTriangles = 0;
    
    // Generate LOD for added regions too
    const shouldGenerateLOD = enableLOD;
    
    console.log(`[ChunkManager] 🚀 Adding ${totalRegions} regions via streaming (LOD: ${shouldGenerateLOD})...`);
    
    // Process all regions using the streaming loader
    for (let i = 0; i < regionFiles.length; i++) {
      const region = regionFiles[i];
      const regionName = region.file.name || `r.${region.regionX}.${region.regionZ}.mca`;
      
      onRegionStart?.(i, totalRegions, regionName);
      this.onProgress?.(this.loadedRegions + i, this.loadedRegions + totalRegions);
      
      try {
        const regionStart = performance.now();
        const { result, stats } = await this.streamingLoader.processRegion(
          region.file,
          region.regionX,
          region.regionZ,
          { generateLOD: shouldGenerateLOD }
        );
        const regionTime = performance.now() - regionStart;
        
        // Add meshes to scene
        let drawCalls = 0;
        let meshCenter = null;
        
        // Handle solid mesh with LOD
        if (result.solid) {
          if (shouldGenerateLOD && result.lodMeshes) {
            const geom = this._createGeometryFromBuffers(result.solid);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose();
            }
            drawCalls += this._addMeshWithLODFromBuffers(
              result.solid, 
              result.lodMeshes, 
              this.solidMaterial, 
              this.solidGroup, 
              this.solidMeshes
            );
          } else {
            drawCalls += this._addMeshFromBuffers(result.solid, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        
        // Handle water/lava/glass with LOD (hide at distance)
        if (result.water) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes);
          }
        }
        if (result.lava) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes);
          }
        }
        if (result.glass) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes);
          }
        }
        
        // Update stats
        addedBlocks += stats.totalBlocks || 0;
        addedChunks += stats.chunksProcessed || 0;
        const tris = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
        addedTriangles += tris;
        completedRegions++;
        
        const lodInfo = shouldGenerateLOD ? `, LOD: ${(stats.lodTimeMs || 0).toFixed(0)}ms` : '';
        console.log(
          `[ChunkManager] ✓ Added ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `in ${(regionTime / 1000).toFixed(2)}s${lodInfo}`
        );
        
        onRegionComplete?.(i, totalRegions, regionName, stats);
        this.onProgress?.(this.loadedRegions + completedRegions, this.loadedRegions + totalRegions);
        
      } catch (error) {
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed:`, error.message);
        completedRegions++;
        this.onProgress?.(this.loadedRegions + completedRegions, this.loadedRegions + totalRegions);
      }
    }
    
    // Update cumulative stats
    this.totalBlocks += addedBlocks;
    this.loadedChunks += addedChunks;
    this.loadedRegions += completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    const avgTime = completedRegions > 0 ? totalTime / completedRegions : 0;
    
    console.log(
      `[ChunkManager] ✅ Added ${completedRegions} regions, ` +
      `now have ${this.loadedRegions} total regions, ${this.totalBlocks.toLocaleString()} blocks ` +
      `in ${(totalTime / 1000).toFixed(1)}s`
    );
    
    this.onComplete?.();
    
    return {
      regionsAdded: completedRegions,
      totalRegions: this.loadedRegions,
      chunksAdded: addedChunks,
      totalChunks: this.loadedChunks,
      blocksAdded: addedBlocks,
      totalBlocks: this.totalBlocks,
      trianglesAdded: addedTriangles,
      meshCount,
      timeMs: totalTime,
      avgTimePerRegion: avgTime,
    };
  }
  
  /**
   * Add mesh from raw buffers (used by streaming loader)
   */
  _addMeshFromBuffers(meshData, material, group, meshArray) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    const geometry = this._createGeometryFromBuffers(meshData);
    if (!geometry) return 0;
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    group.add(mesh);
    meshArray.push(mesh);
    
    return 1;
  }
  
  /**
   * Create a THREE.BufferGeometry from raw buffer data
   */
  _createGeometryFromBuffers(meshData) {
    if (!meshData || meshData.vertexCount === 0) return null;
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingSphere();
    
    return geometry;
  }
  
  /**
   * Add mesh with LOD levels from raw buffers (used by streaming loader)
   */
  _addMeshWithLODFromBuffers(solidData, lodMeshes, material, group, meshArray) {
    if (!solidData || solidData.vertexCount === 0) return 0;
    if (!lodMeshes || (!lodMeshes.lod1 && !lodMeshes.lod2)) {
      return this._addMeshFromBuffers(solidData, material, group, meshArray);
    }
    
    // Check if full-detail mesh is too large for LOD
    if (solidData.indices.length > MAX_INDICES_PER_DRAW) {
      console.log('[ChunkManager] Mesh too large for LOD, using regular mesh');
      return this._addMeshFromBuffers(solidData, material, group, meshArray);
    }
    
    // Create full-detail geometry
    const geom0 = this._createGeometryFromBuffers(solidData);
    if (!geom0) return 0;
    
    // Compute center for LOD distance calculation
    geom0.computeBoundingBox();
    const meshCenter = new THREE.Vector3();
    geom0.boundingBox.getCenter(meshCenter);
    
    // Create LOD object
    const lod = new THREE.LOD();
    
    // Add full detail mesh
    const mesh0 = new THREE.Mesh(geom0, material);
    mesh0.frustumCulled = true;
    mesh0.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    lod.addLevel(mesh0, 0);
    
    // Add LOD levels
    let lodLevelsAdded = 1;
    const addLodLevel = (lodData, distance, levelName) => {
      if (!lodData) return;
      const geom = this._createGeometryFromBuffers(lodData);
      if (!geom) return;
      const mesh = new THREE.Mesh(geom, material);
      mesh.frustumCulled = true;
      mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
      lod.addLevel(mesh, distance);
      lodLevelsAdded++;
      console.log(`[LOD] ${levelName} added at distance ${distance}, ${lodData.triangleCount} tris`);
    };
    
    addLodLevel(lodMeshes.lod1, LOD_DISTANCE_1, 'LOD1');
    addLodLevel(lodMeshes.lod2, LOD_DISTANCE_2, 'LOD2');
    addLodLevel(lodMeshes.lod3, LOD_DISTANCE_3, 'LOD3');
    addLodLevel(lodMeshes.lod4, LOD_DISTANCE_4, 'LOD4');
    
    console.log(`[LOD] Total ${lodLevelsAdded} levels added to LOD object`);
    
    // Position LOD at mesh center for distance calculation
    lod.position.copy(meshCenter);
    lod.autoUpdate = true;
    lod.frustumCulled = false;
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }
  
  /**
   * Add fluid mesh with LOD that hides it at distance (from raw buffers)
   */
  _addFluidMeshWithLODFromBuffers(meshData, material, group, meshArray, meshCenter) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    // Check if mesh is too large
    if (meshData.indices.length > MAX_INDICES_PER_DRAW) {
      return this._addMeshFromBuffers(meshData, material, group, meshArray);
    }
    
    const geom = this._createGeometryFromBuffers(meshData);
    if (!geom) return 0;
    
    // Create LOD object
    const lod = new THREE.LOD();
    
    // Level 0: Full detail fluid mesh
    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = true;
    mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    lod.addLevel(mesh, 0);
    
    // Level 1: Empty mesh (invisible) at LOD_DISTANCE_1
    const emptyGeom = new THREE.BufferGeometry();
    emptyGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const emptyMesh = new THREE.Mesh(emptyGeom, material);
    lod.addLevel(emptyMesh, LOD_DISTANCE_1);
    
    // Position LOD at same center as solid mesh
    lod.position.copy(meshCenter);
    lod.autoUpdate = true;
    lod.frustumCulled = false;
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
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
    
    for (const mesh of this.glassMeshes) {
      this.glassGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.glassMeshes = [];
    
    for (const mesh of this.modelMeshes) {
      this.modelGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.modelMeshes = [];
    
    this.totalBlocks = 0;
    this.loadedChunks = 0;
    this.loadedRegions = 0;
    
    // Clear debug grid
    if (this.debugGrid) {
      this.debugGrid.clear();
    }
  }

  /**
   * Dispose all resources
   */
  dispose() {
    this.clear();
    
    // Dispose streaming loader
    if (this.streamingLoader) {
      this.streamingLoader.dispose();
      this.streamingLoader = null;
    }
    
    this.solidMaterial.dispose();
    this.waterMaterial.dispose();
    this.lavaMaterial.dispose();
    this.modelMaterial.dispose();
    
    this.scene.remove(this.solidGroup);
    this.scene.remove(this.waterGroup);
    this.scene.remove(this.lavaGroup);
    this.scene.remove(this.modelGroup);
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
    for (const mesh of this.modelMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    
    return {
      regionsLoaded: this.loadedRegions,
      chunksLoaded: this.loadedChunks,
      totalBlocks: this.totalBlocks,
      triangleCount,
      meshCount: this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length + this.modelMeshes.length,
    };
  }
}

export default ChunkManager;
