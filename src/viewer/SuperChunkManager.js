/**
 * SuperChunkManager - Groups individual Minecraft chunks into larger "super-chunks"
 * for more efficient meshing and rendering.
 * 
 * Benefits:
 * - Greedy meshing works across chunk boundaries (fewer triangles)
 * - Hidden faces between chunks are properly culled
 * - Fewer mesh objects = fewer draw calls
 * 
 * A super-chunk is 4x4 Minecraft chunks (64x64 blocks horizontally).
 * 
 * Worker-based meshing:
 * - FastMesher and ModelMesher run in parallel workers
 * - Main thread only handles Three.js mesh creation
 */

import * as THREE from 'three';
import { BinaryGrid } from '../mesh/BinaryGrid.js';
import { BlockStateGrid } from '../mesh/BlockStateGrid.js';
import { LightGrid } from '../mesh/LightGrid.js';
import { decodeChunk } from '../mesh/ChunkDecoder.js';
import { buildGridMeshes } from '../mesh/FastMesher.js';
import { buildModelMeshesWithInstancing } from '../mesh/ModelMesher.js';
import { propagateSkyLight } from '../mesh/LightPropagator.js';
import { propagateBlockLight } from '../mesh/BlockLightPropagator.js';
import { getMeshWorkerPool } from '../mesh/workers/MeshWorkerPool.js';

// Super-chunk is 2x2 Minecraft chunks (32x32 blocks)
// Smaller size = faster rebuilds, less jank, more responsive loading
const SUPER_CHUNK_SIZE = 2;
const BLOCKS_PER_SUPER_CHUNK = SUPER_CHUNK_SIZE * 16; // 32 blocks

/**
 * Represents a single super-chunk containing multiple Minecraft chunks
 */
class SuperChunk {
  constructor(superX, superZ) {
    this.superX = superX;
    this.superZ = superZ;
    
    // Track which chunks are loaded (local 0-3 coordinates within super-chunk)
    this.loadedChunks = new Map(); // "lx,lz" -> chunkData
    
    // Meshes for this super-chunk
    this.meshes = [];
    
    // Dirty flag for rebuild
    this.isDirty = false;
    
    // Track if we've ever been built
    this.hasBeenBuilt = false;
  }

  /**
   * Get the key for a chunk within this super-chunk
   */
  getLocalKey(chunkX, chunkZ) {
    const lx = ((chunkX % SUPER_CHUNK_SIZE) + SUPER_CHUNK_SIZE) % SUPER_CHUNK_SIZE;
    const lz = ((chunkZ % SUPER_CHUNK_SIZE) + SUPER_CHUNK_SIZE) % SUPER_CHUNK_SIZE;
    return `${lx},${lz}`;
  }

  /**
   * Add a chunk's data to this super-chunk
   */
  addChunk(chunkX, chunkZ, chunkData) {
    const key = this.getLocalKey(chunkX, chunkZ);
    this.loadedChunks.set(key, {
      chunkX,
      chunkZ,
      data: chunkData
    });
    this.isDirty = true;
  }

  /**
   * Remove a chunk from this super-chunk
   */
  removeChunk(chunkX, chunkZ) {
    const key = this.getLocalKey(chunkX, chunkZ);
    if (this.loadedChunks.has(key)) {
      this.loadedChunks.delete(key);
      this.isDirty = true;
      return true;
    }
    return false;
  }

  /**
   * Check if this super-chunk has any loaded chunks
   */
  isEmpty() {
    return this.loadedChunks.size === 0;
  }

  /**
   * Get count of loaded chunks
   */
  getChunkCount() {
    return this.loadedChunks.size;
  }

  /**
   * Dispose all meshes
   */
  dispose() {
    for (const mesh of this.meshes) {
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.parent) {
        mesh.parent.remove(mesh);
      }
    }
    this.meshes = [];
    this.hasBeenBuilt = false;
  }
}

/**
 * SuperChunkManager - Manages super-chunks for efficient streaming
 */
export class SuperChunkManager {
  constructor(chunkManager, options = {}) {
    this.chunkManager = chunkManager;
    this.registry = options.registry;
    this.stateRegistry = options.stateRegistry;
    this.enableModelMeshes = options.enableModelMeshes !== false;
    
    // Super-chunks indexed by "sx,sz"
    this.superChunks = new Map();
    
    // Set of dirty super-chunks that need rebuild
    this.dirtySet = new Set();
    
    // Callbacks
    this.onSuperChunkRebuilt = options.onSuperChunkRebuilt || null;
    
    // Worker pool state
    this.workerPool = null;
    this.workerPoolInitialized = false;
    this.workerPoolInitPromise = null;
    
    // Use workers for meshing (can be disabled for debugging)
    // TEMPORARILY DISABLED: Worker mesher is incomplete (missing water/lava/models/tinting)
    // TODO: Complete the worker mesher implementation
    this.useWorkers = false; // options.useWorkers !== false;
  }

  /**
   * Initialize the worker pool with registry and texture data
   * Call this before building any super-chunks
   */
  async initializeWorkerPool() {
    if (this.workerPoolInitialized) return;
    if (this.workerPoolInitPromise) return this.workerPoolInitPromise;
    
    this.workerPoolInitPromise = this._doInitializeWorkerPool();
    return this.workerPoolInitPromise;
  }

  async _doInitializeWorkerPool() {
    try {
      console.log('[SuperChunkManager] Initializing worker pool...');
      
      // Export registry data
      const registryData = this.registry.export();
      
      // Ensure state registry geometries are pre-computed before export
      if (this.stateRegistry) {
        await this.stateRegistry.precomputeAll();
      }
      const stateRegistryData = this.stateRegistry ? this.stateRegistry.export() : null;
      
      // Get texture lookup data
      const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.();
      const textureIndices = textureIndexLookup?.getIndicesArray() || null;
      
      // Get atlas info
      const atlasInfo = this.chunkManager.getAtlasInfo?.() || { tilesPerRow: 64, tilesPerCol: 64 };
      
      // Additional data for workers
      const additionalData = {
        stateRegistryData,
        enableModelMeshes: this.enableModelMeshes,
      };
      
      // Get or create the worker pool
      this.workerPool = getMeshWorkerPool();
      
      // Initialize with data
      await this.workerPool.initialize(registryData, textureIndices, atlasInfo, additionalData);
      
      this.workerPoolInitialized = true;
      console.log('[SuperChunkManager] Worker pool initialized');
    } catch (error) {
      console.error('[SuperChunkManager] Failed to initialize worker pool:', error);
      this.useWorkers = false; // Fall back to main thread meshing
    }
  }

  /**
   * Get super-chunk key from world chunk coordinates
   */
  getSuperChunkKey(chunkX, chunkZ) {
    const sx = Math.floor(chunkX / SUPER_CHUNK_SIZE);
    const sz = Math.floor(chunkZ / SUPER_CHUNK_SIZE);
    return `${sx},${sz}`;
  }

  /**
   * Get or create a super-chunk
   */
  getOrCreateSuperChunk(chunkX, chunkZ) {
    const key = this.getSuperChunkKey(chunkX, chunkZ);
    if (!this.superChunks.has(key)) {
      const sx = Math.floor(chunkX / SUPER_CHUNK_SIZE);
      const sz = Math.floor(chunkZ / SUPER_CHUNK_SIZE);
      this.superChunks.set(key, new SuperChunk(sx, sz));
    }
    return this.superChunks.get(key);
  }

  /**
   * Add a chunk's data to the appropriate super-chunk
   * @param {number} chunkX - World chunk X
   * @param {number} chunkZ - World chunk Z
   * @param {Object} chunkData - Parsed chunk data with NBT
   */
  addChunk(chunkX, chunkZ, chunkData) {
    if (!chunkData) {
      console.warn(`[SuperChunkManager] No data for chunk ${chunkX},${chunkZ}`);
      return;
    }
    
    const superChunk = this.getOrCreateSuperChunk(chunkX, chunkZ);
    superChunk.addChunk(chunkX, chunkZ, chunkData);
    
    // Mark for rebuild
    const key = this.getSuperChunkKey(chunkX, chunkZ);
    this.dirtySet.add(key);
  }

  /**
   * Remove a chunk from its super-chunk
   */
  removeChunk(chunkX, chunkZ) {
    const key = this.getSuperChunkKey(chunkX, chunkZ);
    const superChunk = this.superChunks.get(key);
    
    if (superChunk) {
      superChunk.removeChunk(chunkX, chunkZ);
      
      if (superChunk.isEmpty()) {
        // Dispose and remove empty super-chunk
        superChunk.dispose();
        this.superChunks.delete(key);
        this.dirtySet.delete(key);
      } else {
        // Mark for rebuild
        this.dirtySet.add(key);
      }
    }
  }

  /**
   * Build meshes for a super-chunk
   * This decodes all chunks into a shared grid and runs the greedy mesher once.
   * Uses worker pool if available, falls back to main thread meshing.
   */
  async buildSuperChunk(superChunk) {
    // Dispose old meshes
    superChunk.dispose();
    
    if (superChunk.isEmpty()) {
      superChunk.isDirty = false;
      return;
    }
    
    // Create shared grids for all chunks in this super-chunk
    const grid = new BinaryGrid();
    const stateGrid = this.enableModelMeshes ? new BlockStateGrid() : null;
    const lightGrid = new LightGrid();
    
    // Decode all chunks into the shared grid
    for (const [key, chunkInfo] of superChunk.loadedChunks) {
      if (!chunkInfo.data) continue;
      const adjustedChunk = {
        x: chunkInfo.chunkX,
        z: chunkInfo.chunkZ,
        data: chunkInfo.data
      };
      decodeChunk(adjustedChunk, grid, this.registry, stateGrid, this.stateRegistry, lightGrid);
    }
    
    // Handle light propagation if no Minecraft light data
    if (lightGrid.sections.size === 0) {
      propagateSkyLight(grid, lightGrid, this.registry);
      propagateBlockLight(grid, lightGrid, this.registry);
    }
    
    const offset = { x: 0, y: 0, z: 0 };
    
    // Try to use worker pool for meshing
    if (this.useWorkers && this.workerPoolInitialized && this.workerPool) {
      await this._buildSuperChunkWithWorker(superChunk, grid, stateGrid, lightGrid, offset);
    } else {
      // Fall back to main thread meshing
      await this._buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset);
    }
    
    superChunk.isDirty = false;
    superChunk.hasBeenBuilt = true;
    
    console.log(`[SuperChunkManager] Built super-chunk ${superChunk.superX},${superChunk.superZ}: ${superChunk.meshes.length} meshes from ${superChunk.loadedChunks.size} chunks`);
    
    this.onSuperChunkRebuilt?.(superChunk);
  }

  /**
   * Build super-chunk meshes using worker pool (offloads meshing to worker threads)
   */
  async _buildSuperChunkWithWorker(superChunk, grid, stateGrid, lightGrid, offset) {
    // Export grids for worker transfer
    const gridData = grid.export();
    const lightGridData = lightGrid.export();
    const stateGridData = stateGrid ? stateGrid.export() : null;
    
    // Calculate priority based on distance to camera (lower = higher priority)
    const cameraPos = this.chunkManager.camera?.position || { x: 0, z: 0 };
    const superChunkCenterX = superChunk.superX * BLOCKS_PER_SUPER_CHUNK + BLOCKS_PER_SUPER_CHUNK / 2;
    const superChunkCenterZ = superChunk.superZ * BLOCKS_PER_SUPER_CHUNK + BLOCKS_PER_SUPER_CHUNK / 2;
    const dx = cameraPos.x - superChunkCenterX;
    const dz = cameraPos.z - superChunkCenterZ;
    const priority = Math.sqrt(dx * dx + dz * dz);
    
    // Options for the worker
    const options = {
      stateGridData,
      enableModelMeshes: this.enableModelMeshes,
    };
    
    try {
      // Send meshing job to worker
      const meshResult = await this.workerPool.meshChunk(gridData, lightGridData, offset, options, priority);
      
      // Create Three.js meshes from returned data
      this._createMeshesFromWorkerResult(superChunk, meshResult);
    } catch (error) {
      console.error('[SuperChunkManager] Worker meshing failed, falling back to main thread:', error);
      // Fall back to main thread on error
      await this._buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset);
    }
  }

  /**
   * Build super-chunk meshes on main thread (fallback)
   */
  async _buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset) {
    const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
    // Skip particle emitter collection when particles are off
    const collectEmitters = this.chunkManager.particleQuality !== 'off';
    const mesherOptions = { textureIndexLookup, lightGrid, collectEmitters };
    
    // Build solid/fluid/glass meshes
    const { solid, water, lava, glass } = buildGridMeshes(grid, this.registry, offset, mesherOptions);
    
    // Create and add meshes
    if (solid && solid.positions.length > 0) {
      const mesh = this._createMesh(solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    if (water && water.positions.length > 0) {
      const mesh = this._createMesh(water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    if (lava && lava.positions.length > 0) {
      const mesh = this._createMesh(lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        superChunk.meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    if (glass && glass.positions.length > 0) {
      const mesh = this._createMesh(glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        superChunk.meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Build model meshes if enabled
    if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
      await this.stateRegistry.precomputeAll();
      
      const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
      
      if (modelResult) {
        if (modelResult.opaque && modelResult.opaque.positions.length > 0) {
          const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
          if (mesh) {
            superChunk.meshes.push(mesh);
            this.chunkManager.modelMeshes.push(mesh);
          }
        }
        
        if (modelResult.transparent && modelResult.transparent.positions.length > 0) {
          const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
          if (mesh) {
            mesh.renderOrder = 0.5;
            superChunk.meshes.push(mesh);
            this.chunkManager.transparentModelMeshes.push(mesh);
          }
        }
        
        if (modelResult.overlay && modelResult.overlay.positions.length > 0) {
          const mesh = this._createMesh(modelResult.overlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
          if (mesh) {
            mesh.renderOrder = 4;
            superChunk.meshes.push(mesh);
            this.chunkManager.overlayModelMeshes.push(mesh);
          }
        }
        
        // Register particle emitters
        if (modelResult.particleEmitters && modelResult.particleEmitters.length > 0) {
          const emitterManager = this.chunkManager.particleEmitterManager;
          if (emitterManager) {
            for (const emitter of modelResult.particleEmitters) {
              emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
            }
          }
        }
      }
    }
  }

  /**
   * Create Three.js meshes from worker result data
   */
  _createMeshesFromWorkerResult(superChunk, meshResult) {
    if (!meshResult) return;
    
    // Helper to check if mesh data has vertices
    // ArrayBuffer uses byteLength, TypedArrays use length
    const hasVertices = (data) => {
      if (!data || !data.positions) return false;
      const size = data.positions.byteLength ?? data.positions.length;
      return size > 0;
    };
    
    // Process solid meshes
    if (hasVertices(meshResult.solid)) {
      const mesh = this._createMeshFromData(meshResult.solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    // Process water meshes
    if (hasVertices(meshResult.water)) {
      const mesh = this._createMeshFromData(meshResult.water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    // Process lava meshes
    if (hasVertices(meshResult.lava)) {
      const mesh = this._createMeshFromData(meshResult.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        superChunk.meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    // Process glass meshes
    if (hasVertices(meshResult.glass)) {
      const mesh = this._createMeshFromData(meshResult.glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        superChunk.meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Process model meshes
    if (meshResult.model) {
      if (hasVertices(meshResult.model.opaque)) {
        const mesh = this._createMeshFromData(meshResult.model.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
        if (mesh) {
          superChunk.meshes.push(mesh);
          this.chunkManager.modelMeshes.push(mesh);
        }
      }
      
      if (hasVertices(meshResult.model.transparent)) {
        const mesh = this._createMeshFromData(meshResult.model.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
        if (mesh) {
          mesh.renderOrder = 0.5;
          superChunk.meshes.push(mesh);
          this.chunkManager.transparentModelMeshes.push(mesh);
        }
      }
      
      if (hasVertices(meshResult.model.overlay)) {
        const mesh = this._createMeshFromData(meshResult.model.overlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
        if (mesh) {
          mesh.renderOrder = 4;
          superChunk.meshes.push(mesh);
          this.chunkManager.overlayModelMeshes.push(mesh);
        }
      }
      
      // Register particle emitters
      if (meshResult.model.particleEmitters && meshResult.model.particleEmitters.length > 0) {
        const emitterManager = this.chunkManager.particleEmitterManager;
        if (emitterManager) {
          for (const emitter of meshResult.model.particleEmitters) {
            emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
          }
        }
      }
    }
  }

  /**
   * Create a Three.js mesh from worker data (ArrayBuffer based)
   */
  _createMeshFromData(data, material, group) {
    if (!data || !material || !group) return null;
    
    // Convert ArrayBuffers back to typed arrays
    const positions = data.positions instanceof ArrayBuffer 
      ? new Float32Array(data.positions) 
      : data.positions;
    const normals = data.normals instanceof ArrayBuffer
      ? new Float32Array(data.normals)
      : data.normals;
    const indices = data.indices instanceof ArrayBuffer
      ? new Uint32Array(data.indices)
      : data.indices;
    
    if (!positions || positions.length === 0) return null;
    if (!normals || normals.length === 0) return null;
    if (!indices || indices.length === 0) return null;
    
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    
    if (data.colors) {
      const colors = data.colors instanceof ArrayBuffer
        ? new Float32Array(data.colors)
        : data.colors;
      if (colors && colors.length > 0) {
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      }
    }
    
    if (data.uvs) {
      const uvs = data.uvs instanceof ArrayBuffer
        ? new Float32Array(data.uvs)
        : data.uvs;
      if (uvs && uvs.length > 0) {
        geometry.setAttribute('modelUV', new THREE.BufferAttribute(uvs, 2));
      }
    }
    
    if (data.modelUVs) {
      const modelUVs = data.modelUVs instanceof ArrayBuffer
        ? new Float32Array(data.modelUVs)
        : data.modelUVs;
      if (modelUVs && modelUVs.length > 0) {
        geometry.setAttribute('modelUV', new THREE.BufferAttribute(modelUVs, 2));
      }
    }
    
    if (data.texIndices) {
      const texIndices = data.texIndices instanceof ArrayBuffer
        ? new Float32Array(data.texIndices)
        : data.texIndices;
      if (texIndices && texIndices.length > 0) {
        geometry.setAttribute('texIndex', new THREE.BufferAttribute(texIndices, 1));
      }
    }
    
    if (data.texRotations) {
      const texRotations = data.texRotations instanceof ArrayBuffer
        ? new Float32Array(data.texRotations)
        : data.texRotations;
      if (texRotations && texRotations.length > 0) {
        geometry.setAttribute('texRotation', new THREE.BufferAttribute(texRotations, 1));
      }
    }
    
    if (data.tintTypes) {
      const tintTypes = data.tintTypes instanceof ArrayBuffer
        ? new Float32Array(data.tintTypes)
        : data.tintTypes;
      if (tintTypes && tintTypes.length > 0) {
        geometry.setAttribute('tintType', new THREE.BufferAttribute(tintTypes, 1));
      }
    }
    
    if (data.shadeFlags) {
      const shadeFlags = data.shadeFlags instanceof ArrayBuffer
        ? new Float32Array(data.shadeFlags)
        : data.shadeFlags;
      if (shadeFlags && shadeFlags.length > 0) {
        geometry.setAttribute('shadeFlag', new THREE.BufferAttribute(shadeFlags, 1));
      }
    }
    
    if (data.singleSided) {
      const singleSided = data.singleSided instanceof ArrayBuffer
        ? new Float32Array(data.singleSided)
        : data.singleSided;
      if (singleSided && singleSided.length > 0) {
        geometry.setAttribute('singleSided', new THREE.BufferAttribute(singleSided, 1));
      }
    }
    
    if (data.skyLight) {
      const skyLight = data.skyLight instanceof ArrayBuffer
        ? new Float32Array(data.skyLight)
        : data.skyLight;
      if (skyLight && skyLight.length > 0) {
        geometry.setAttribute('skyLight', new THREE.BufferAttribute(skyLight, 1));
      }
    }
    
    if (data.blockLight) {
      const blockLight = data.blockLight instanceof ArrayBuffer
        ? new Float32Array(data.blockLight)
        : data.blockLight;
      if (blockLight && blockLight.length > 0) {
        geometry.setAttribute('blockLight', new THREE.BufferAttribute(blockLight, 1));
      }
    }
    
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    // Store super-chunk center for visibility calculations
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    mesh.userData.chunkCenterX = center.x;
    mesh.userData.chunkCenterZ = center.z;
    
    group.add(mesh);
    
    return mesh;
  }

  /**
   * Rebuild all dirty super-chunks with frame budget awareness
   * @param {number} maxRebuilds - Maximum number of super-chunks to rebuild per call
   * @param {number} budgetMs - Maximum time budget in ms (0 = no limit)
   * @returns {number} Number of super-chunks rebuilt
   */
  async rebuildDirty(maxRebuilds = 2, budgetMs = 0) {
    if (this.dirtySet.size === 0) return 0;
    
    let rebuiltCount = 0;
    const startTime = performance.now();
    const keysToRebuild = [...this.dirtySet].slice(0, maxRebuilds);
    
    for (const key of keysToRebuild) {
      // Check budget if specified
      if (budgetMs > 0 && (performance.now() - startTime) >= budgetMs) {
        break; // Exceeded time budget
      }
      
      const superChunk = this.superChunks.get(key);
      if (superChunk && superChunk.isDirty) {
        // Remove old meshes from ChunkManager arrays before rebuilding
        this._removeMeshesFromManager(superChunk);
        
        await this.buildSuperChunk(superChunk);
        rebuiltCount++;
        
        // Yield to browser between super-chunks to maintain responsiveness
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      this.dirtySet.delete(key);
    }
    
    return rebuiltCount;
  }
  
  /**
   * Schedule rebuild using requestIdleCallback for non-blocking updates
   * Used during player movement to avoid frame drops
   * @param {boolean} lowPriority - If true, use longer timeout and smaller batches
   */
  scheduleIdleRebuild(lowPriority = false) {
    if (this._idleCallbackId) return; // Already scheduled
    
    const callback = async (deadline) => {
      this._idleCallbackId = null;
      
      // Adjust work based on priority
      const minTimeRemaining = lowPriority ? 15 : 8;
      const maxRebuilds = lowPriority ? 1 : 2;
      
      // Only rebuild if we have time remaining in idle period
      // Use smaller threshold to leave room for other work
      while (this.dirtySet.size > 0 && deadline.timeRemaining() > minTimeRemaining) {
        // Use time-budgeted rebuild
        const budgetMs = Math.min(deadline.timeRemaining() - 5, 10);
        await this.rebuildDirty(maxRebuilds, budgetMs);
      }
      
      // Schedule another callback if more rebuilds needed
      if (this.dirtySet.size > 0) {
        this.scheduleIdleRebuild(lowPriority);
      }
    };
    
    // Timeout determines how long we wait before forcing the callback
    const timeout = lowPriority ? 200 : 50;
    
    if (typeof requestIdleCallback !== 'undefined') {
      this._idleCallbackId = requestIdleCallback(callback, { timeout });
    } else {
      // Fallback for browsers without requestIdleCallback
      // Use requestAnimationFrame for better frame alignment
      this._idleCallbackId = requestAnimationFrame(() => {
        callback({ timeRemaining: () => lowPriority ? 5 : 10 });
      });
    }
  }

  /**
   * Cancel any pending idle rebuilds
   * Useful when movement is detected
   */
  cancelIdleRebuild() {
    if (this._idleCallbackId) {
      if (typeof cancelIdleCallback !== 'undefined') {
        cancelIdleCallback(this._idleCallbackId);
      } else {
        cancelAnimationFrame(this._idleCallbackId);
      }
      this._idleCallbackId = null;
    }
  }

  /**
   * Remove a super-chunk's meshes from ChunkManager's tracking arrays
   */
  _removeMeshesFromManager(superChunk) {
    for (const mesh of superChunk.meshes) {
      removeFromArray(this.chunkManager.solidMeshes, mesh);
      removeFromArray(this.chunkManager.waterMeshes, mesh);
      removeFromArray(this.chunkManager.lavaMeshes, mesh);
      removeFromArray(this.chunkManager.glassMeshes, mesh);
      removeFromArray(this.chunkManager.modelMeshes, mesh);
      removeFromArray(this.chunkManager.transparentModelMeshes, mesh);
      removeFromArray(this.chunkManager.overlayModelMeshes, mesh);
    }
  }

  /**
   * Create a Three.js mesh from mesh data
   */
  _createMesh(meshData, material, group) {
    if (!meshData) return null;
    if (!meshData.positions || meshData.positions.length === 0) return null;
    if (!meshData.normals || meshData.normals.length === 0) return null;
    if (!meshData.indices || meshData.indices.length === 0) return null;
    if (!material || !group) return null;
    
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    
    if (meshData.colors && meshData.colors.length > 0) {
      geometry.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    }
    
    if (meshData.uvs && meshData.uvs.length > 0) {
      geometry.setAttribute('modelUV', new THREE.BufferAttribute(meshData.uvs, 2));
    }
    
    if (meshData.modelUVs && meshData.modelUVs.length > 0) {
      geometry.setAttribute('modelUV', new THREE.BufferAttribute(meshData.modelUVs, 2));
    }
    
    if (meshData.texIndices && meshData.texIndices.length > 0) {
      geometry.setAttribute('texIndex', new THREE.BufferAttribute(meshData.texIndices, 1));
    }
    
    if (meshData.texRotations && meshData.texRotations.length > 0) {
      geometry.setAttribute('texRotation', new THREE.BufferAttribute(meshData.texRotations, 1));
    }
    
    if (meshData.tintTypes && meshData.tintTypes.length > 0) {
      geometry.setAttribute('tintType', new THREE.BufferAttribute(meshData.tintTypes, 1));
    }
    
    if (meshData.shadeFlags && meshData.shadeFlags.length > 0) {
      geometry.setAttribute('shadeFlag', new THREE.BufferAttribute(meshData.shadeFlags, 1));
    }
    
    if (meshData.singleSided && meshData.singleSided.length > 0) {
      geometry.setAttribute('singleSided', new THREE.BufferAttribute(meshData.singleSided, 1));
    }
    
    if (meshData.skyLight && meshData.skyLight.length > 0) {
      geometry.setAttribute('skyLight', new THREE.BufferAttribute(meshData.skyLight, 1));
    }
    
    if (meshData.blockLight && meshData.blockLight.length > 0) {
      geometry.setAttribute('blockLight', new THREE.BufferAttribute(meshData.blockLight, 1));
    }
    
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingSphere();
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    // Store super-chunk center for visibility calculations
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    mesh.userData.chunkCenterX = center.x;
    mesh.userData.chunkCenterZ = center.z;
    
    group.add(mesh);
    
    return mesh;
  }

  /**
   * Get statistics about super-chunks
   */
  getStats() {
    let totalChunks = 0;
    let totalMeshes = 0;
    
    for (const [, sc] of this.superChunks) {
      totalChunks += sc.getChunkCount();
      totalMeshes += sc.meshes.length;
    }
    
    return {
      superChunkCount: this.superChunks.size,
      totalChunks,
      totalMeshes,
      dirtyCount: this.dirtySet.size
    };
  }

  /**
   * Clear all super-chunks
   */
  clear() {
    for (const [, superChunk] of this.superChunks) {
      this._removeMeshesFromManager(superChunk);
      superChunk.dispose();
    }
    this.superChunks.clear();
    this.dirtySet.clear();
  }

  /**
   * Dispose and clean up
   */
  dispose() {
    this.clear();
    
    // Terminate worker pool
    if (this.workerPool) {
      this.workerPool.terminate();
      this.workerPool = null;
      this.workerPoolInitialized = false;
      this.workerPoolInitPromise = null;
    }
  }
}

/**
 * Helper to remove an item from an array
 */
function removeFromArray(array, item) {
  const idx = array.indexOf(item);
  if (idx !== -1) {
    array.splice(idx, 1);
  }
}

export default SuperChunkManager;

