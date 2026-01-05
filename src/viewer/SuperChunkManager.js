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
    
    // Build meshes with offset { x: 0, y: 0, z: 0 } to keep world coordinates
    const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
    const mesherOptions = { textureIndexLookup, lightGrid };
    const offset = { x: 0, y: 0, z: 0 };
    
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
    
    superChunk.isDirty = false;
    superChunk.hasBeenBuilt = true;
    
    this.onSuperChunkRebuilt?.(superChunk);
  }

  /**
   * Rebuild all dirty super-chunks
   * @param {number} maxRebuilds - Maximum number of super-chunks to rebuild per call (for frame budgeting)
   * @returns {number} Number of super-chunks rebuilt
   */
  async rebuildDirty(maxRebuilds = 2) {
    if (this.dirtySet.size === 0) return 0;
    
    let rebuiltCount = 0;
    const keysToRebuild = [...this.dirtySet].slice(0, maxRebuilds);
    
    for (const key of keysToRebuild) {
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
   */
  scheduleIdleRebuild() {
    if (this._idleCallbackId) return; // Already scheduled
    
    const callback = async (deadline) => {
      this._idleCallbackId = null;
      
      // Only rebuild if we have time remaining in idle period
      while (this.dirtySet.size > 0 && deadline.timeRemaining() > 10) {
        await this.rebuildDirty(1);
      }
      
      // Schedule another callback if more rebuilds needed
      if (this.dirtySet.size > 0) {
        this.scheduleIdleRebuild();
      }
    };
    
    if (typeof requestIdleCallback !== 'undefined') {
      this._idleCallbackId = requestIdleCallback(callback, { timeout: 100 });
    } else {
      // Fallback for browsers without requestIdleCallback
      this._idleCallbackId = setTimeout(() => callback({ timeRemaining: () => 50 }), 16);
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

