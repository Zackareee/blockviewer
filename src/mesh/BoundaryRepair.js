/**
 * BoundaryRepair - Deferred boundary face culling for streaming chunks
 * 
 * When chunks are loaded in streaming mode, boundary faces (at chunk edges)
 * are rendered conservatively because neighbor data may not be available.
 * This system tracks which faces need repair when neighbors load.
 * 
 * Flow:
 * 1. Chunk arrives -> mesh with conservative boundaries -> display immediately
 * 2. Track boundary face info (which faces were rendered without neighbor culling)
 * 3. When neighbor chunk loads -> compute hidden faces -> patch geometry
 */

/**
 * Tracks boundary faces for a single chunk that may need culling
 */
export class ChunkBoundaryInfo {
  constructor(chunkX, chunkZ) {
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    
    // Boundary faces by direction
    // Each entry: { localY, edgePos, sectionY, blockId, indexOffset, indexCount }
    this.negX = []; // Faces at x=0 (need -X neighbor)
    this.posX = []; // Faces at x=15 (need +X neighbor)
    this.negZ = []; // Faces at z=0 (need -Z neighbor)
    this.posZ = []; // Faces at z=15 (need +Z neighbor)
    
    // Track which neighbors have been processed
    this.repairedNegX = false;
    this.repairedPosX = false;
    this.repairedNegZ = false;
    this.repairedPosZ = false;
    
    // Reference to the mesh's index buffer for patching
    this.meshRef = null;
  }
  
  /**
   * Add boundary face info from WASM result
   */
  addFromWasm(wasmResult) {
    // The WASM result contains counts of boundary faces per direction
    // The actual face data would need to be tracked during meshing
    // For now, we just track that there are faces to potentially repair
    this.negXCount = wasmResult.boundary_neg_x_count;
    this.posXCount = wasmResult.boundary_pos_x_count;
    this.negZCount = wasmResult.boundary_neg_z_count;
    this.posZCount = wasmResult.boundary_pos_z_count;
  }
  
  /**
   * Check if all boundary repairs are complete
   */
  isFullyRepaired() {
    return this.repairedNegX && this.repairedPosX && 
           this.repairedNegZ && this.repairedPosZ;
  }
  
  /**
   * Check if any repairs are pending
   */
  hasPendingRepairs() {
    return (this.negX.length > 0 && !this.repairedNegX) ||
           (this.posX.length > 0 && !this.repairedPosX) ||
           (this.negZ.length > 0 && !this.repairedNegZ) ||
           (this.posZ.length > 0 && !this.repairedPosZ);
  }
}

/**
 * Manages boundary repair for all streaming chunks
 */
export class BoundaryRepairManager {
  constructor() {
    // Map from chunk key to ChunkBoundaryInfo
    this._chunks = new Map();
    
    // Pending repairs queue
    this._repairQueue = [];
    
    // Stats
    this._stats = {
      chunksTracked: 0,
      repairsCompleted: 0,
      facesHidden: 0,
    };
  }
  
  /**
   * Generate chunk key from coordinates
   */
  _key(chunkX, chunkZ) {
    return `${chunkX},${chunkZ}`;
  }
  
  /**
   * Register a chunk with boundary face info
   * @param {number} chunkX 
   * @param {number} chunkZ 
   * @param {Object} boundaryInfo - From WASM mesh result
   * @param {THREE.Mesh} mesh - Reference to the Three.js mesh
   */
  registerChunk(chunkX, chunkZ, boundaryInfo, mesh) {
    const key = this._key(chunkX, chunkZ);
    
    const info = new ChunkBoundaryInfo(chunkX, chunkZ);
    info.addFromWasm(boundaryInfo);
    info.meshRef = mesh;
    
    this._chunks.set(key, info);
    this._stats.chunksTracked++;
    
    // Check if any neighbors already exist and queue repairs
    this._checkNeighbors(chunkX, chunkZ);
  }
  
  /**
   * Notify that a chunk has loaded - trigger repairs for adjacent chunks
   * @param {number} chunkX 
   * @param {number} chunkZ 
   */
  notifyChunkLoaded(chunkX, chunkZ) {
    // Check all 4 neighbors
    const neighbors = [
      [chunkX - 1, chunkZ, 'posX'], // Our -X neighbor's +X boundary
      [chunkX + 1, chunkZ, 'negX'], // Our +X neighbor's -X boundary
      [chunkX, chunkZ - 1, 'posZ'], // Our -Z neighbor's +Z boundary
      [chunkX, chunkZ + 1, 'negZ'], // Our +Z neighbor's -Z boundary
    ];
    
    for (const [nx, nz, direction] of neighbors) {
      const key = this._key(nx, nz);
      const info = this._chunks.get(key);
      
      if (info && !info[`repaired${direction.charAt(0).toUpperCase()}${direction.slice(1)}`]) {
        // Queue repair for this boundary
        this._repairQueue.push({
          chunkX: nx,
          chunkZ: nz,
          direction,
          neighborX: chunkX,
          neighborZ: chunkZ,
        });
      }
    }
  }
  
  /**
   * Check if neighbors exist and queue repairs
   */
  _checkNeighbors(chunkX, chunkZ) {
    const neighbors = [
      [chunkX - 1, chunkZ, 'negX'],
      [chunkX + 1, chunkZ, 'posX'],
      [chunkX, chunkZ - 1, 'negZ'],
      [chunkX, chunkZ + 1, 'posZ'],
    ];
    
    for (const [nx, nz, direction] of neighbors) {
      const neighborKey = this._key(nx, nz);
      if (this._chunks.has(neighborKey)) {
        // Neighbor exists - queue repair for our boundary facing it
        this._repairQueue.push({
          chunkX,
          chunkZ,
          direction,
          neighborX: nx,
          neighborZ: nz,
        });
      }
    }
  }
  
  /**
   * Process pending repairs (call once per frame)
   * @param {number} maxRepairs - Maximum repairs to process this frame
   * @returns {number} Number of repairs processed
   */
  processRepairs(maxRepairs = 4) {
    let processed = 0;
    
    while (processed < maxRepairs && this._repairQueue.length > 0) {
      const repair = this._repairQueue.shift();
      this._performRepair(repair);
      processed++;
    }
    
    return processed;
  }
  
  /**
   * Perform a single boundary repair
   * @param {Object} repair - Repair info from queue
   */
  _performRepair(repair) {
    const { chunkX, chunkZ, direction } = repair;
    const key = this._key(chunkX, chunkZ);
    const info = this._chunks.get(key);
    
    if (!info || !info.meshRef) {
      return;
    }
    
    // Mark this direction as repaired
    const repairedKey = `repaired${direction.charAt(0).toUpperCase() + direction.slice(1)}`;
    info[repairedKey] = true;
    
    this._stats.repairsCompleted++;
    
    // In a full implementation, we would:
    // 1. Get the neighbor's block data
    // 2. For each boundary face, check if neighbor block occludes it
    // 3. If occluded, zero out the face's indices in the mesh
    // 4. Call mesh.geometry.setIndex() to update
    
    // For now, we just track that the repair was done
    // The actual face culling will be added in Phase 1.4
    
    // If all repairs are complete, we can potentially remove from tracking
    if (info.isFullyRepaired()) {
      // Keep in map for now - might need for incremental updates
    }
  }
  
  /**
   * Remove a chunk from tracking (when unloaded)
   * @param {number} chunkX 
   * @param {number} chunkZ 
   */
  unregisterChunk(chunkX, chunkZ) {
    const key = this._key(chunkX, chunkZ);
    this._chunks.delete(key);
  }
  
  /**
   * Clear all tracking data
   */
  clear() {
    this._chunks.clear();
    this._repairQueue = [];
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this._stats,
      pendingRepairs: this._repairQueue.length,
    };
  }
}

// Singleton instance
let boundaryRepairManagerInstance = null;

/**
 * Get the global boundary repair manager
 * @returns {BoundaryRepairManager}
 */
export function getBoundaryRepairManager() {
  if (!boundaryRepairManagerInstance) {
    boundaryRepairManagerInstance = new BoundaryRepairManager();
  }
  return boundaryRepairManagerInstance;
}

export default {
  ChunkBoundaryInfo,
  BoundaryRepairManager,
  getBoundaryRepairManager,
};
