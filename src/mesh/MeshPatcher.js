/**
 * MeshPatcher - Incremental mesh updates for single-block changes
 * 
 * Instead of rebuilding an entire super-chunk when a single block changes,
 * this class patches the mesh by:
 * 1. Finding faces belonging to the changed block
 * 2. Removing those faces from the index buffer
 * 3. Adding new faces for the new block
 * 4. Updating only the changed portions of GPU buffers
 * 
 * Phase 4.2 of the performance architecture overhaul.
 */

import * as THREE from 'three';

/**
 * Maps block positions to their face indices in the mesh
 * Used for fast lookup when patching
 */
export class FaceBlockMap {
  constructor() {
    // block position "x,y,z" -> { startIndex, faceCount }
    this.mapping = new Map();
    // Free list for reusing slots
    this.freeSlots = [];
  }
  
  /**
   * Record face indices for a block
   * @param {number} x - Block X position
   * @param {number} y - Block Y position
   * @param {number} z - Block Z position
   * @param {number} startIndex - Starting index in the index buffer
   * @param {number} faceCount - Number of faces (each face = 6 indices)
   */
  add(x, y, z, startIndex, faceCount) {
    const key = `${x},${y},${z}`;
    this.mapping.set(key, { startIndex, faceCount });
  }
  
  /**
   * Get face info for a block
   * @returns {{ startIndex: number, faceCount: number } | null}
   */
  get(x, y, z) {
    const key = `${x},${y},${z}`;
    return this.mapping.get(key) || null;
  }
  
  /**
   * Remove a block's face mapping
   */
  remove(x, y, z) {
    const key = `${x},${y},${z}`;
    const info = this.mapping.get(key);
    if (info) {
      this.freeSlots.push(info);
      this.mapping.delete(key);
    }
    return info;
  }
  
  /**
   * Check if a block has face data
   */
  has(x, y, z) {
    const key = `${x},${y},${z}`;
    return this.mapping.has(key);
  }
  
  /**
   * Clear all mappings
   */
  clear() {
    this.mapping.clear();
    this.freeSlots = [];
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      blockCount: this.mapping.size,
      freeSlots: this.freeSlots.length
    };
  }
}

/**
 * MeshPatcher for incremental mesh updates
 */
export class MeshPatcher {
  constructor() {
    // Track meshes and their face maps
    this.meshFaceMaps = new WeakMap(); // mesh -> FaceBlockMap
  }
  
  /**
   * Register a mesh for patching
   * @param {THREE.Mesh} mesh - The mesh to register
   * @param {FaceBlockMap} faceMap - Pre-built face map for this mesh
   */
  registerMesh(mesh, faceMap) {
    this.meshFaceMaps.set(mesh, faceMap);
  }
  
  /**
   * Unregister a mesh
   */
  unregisterMesh(mesh) {
    this.meshFaceMaps.delete(mesh);
  }
  
  /**
   * Patch a mesh when a block changes
   * 
   * @param {THREE.Mesh} mesh - Mesh to patch
   * @param {number} x - Block X position
   * @param {number} y - Block Y position
   * @param {number} z - Block Z position
   * @param {Uint16Array|null} newFaceData - New face data (null to remove block)
   * @returns {boolean} True if patch succeeded, false if full rebuild needed
   */
  patchBlock(mesh, x, y, z, newFaceData) {
    const faceMap = this.meshFaceMaps.get(mesh);
    if (!faceMap) {
      console.warn('[MeshPatcher] Mesh not registered for patching');
      return false;
    }
    
    const geometry = mesh.geometry;
    if (!geometry) return false;
    
    const oldInfo = faceMap.get(x, y, z);
    const hasOldBlock = oldInfo !== null;
    const hasNewBlock = newFaceData !== null && newFaceData.length > 0;
    
    // Case 1: Block removed (had faces, now empty)
    if (hasOldBlock && !hasNewBlock) {
      return this._removeFaces(geometry, faceMap, x, y, z, oldInfo);
    }
    
    // Case 2: Block added (was empty, now has faces)
    if (!hasOldBlock && hasNewBlock) {
      return this._addFaces(geometry, faceMap, x, y, z, newFaceData);
    }
    
    // Case 3: Block changed (had faces, still has faces)
    if (hasOldBlock && hasNewBlock) {
      // If same face count, update in place
      const newFaceCount = newFaceData.length / 6; // 6 indices per face
      if (oldInfo.faceCount === newFaceCount) {
        return this._updateFaces(geometry, oldInfo, newFaceData);
      }
      
      // Different face count - remove and re-add
      this._removeFaces(geometry, faceMap, x, y, z, oldInfo);
      return this._addFaces(geometry, faceMap, x, y, z, newFaceData);
    }
    
    // Case 4: No change (was empty, still empty)
    return true;
  }
  
  /**
   * Remove faces for a block
   * @private
   */
  _removeFaces(geometry, faceMap, x, y, z, info) {
    const index = geometry.getIndex();
    if (!index) return false;
    
    const indices = index.array;
    const indexCount = info.faceCount * 6;
    const startIdx = info.startIndex;
    
    // Zero out the indices (degenerate triangles)
    // This is faster than compacting the buffer
    for (let i = 0; i < indexCount; i++) {
      indices[startIdx + i] = 0;
    }
    
    index.needsUpdate = true;
    faceMap.remove(x, y, z);
    
    return true;
  }
  
  /**
   * Add faces for a new block
   * @private
   */
  _addFaces(geometry, faceMap, x, y, z, faceData) {
    // For now, adding new faces requires buffer reallocation
    // A more sophisticated implementation would use a gap-filling strategy
    // or pre-allocate extra buffer space
    
    // Return false to indicate full rebuild needed
    return false;
  }
  
  /**
   * Update faces in place (same face count)
   * @private
   */
  _updateFaces(geometry, info, newFaceData) {
    const index = geometry.getIndex();
    if (!index) return false;
    
    const indices = index.array;
    const startIdx = info.startIndex;
    
    // Copy new indices
    for (let i = 0; i < newFaceData.length; i++) {
      indices[startIdx + i] = newFaceData[i];
    }
    
    index.needsUpdate = true;
    return true;
  }
  
  /**
   * Check if a mesh can be patched (vs needing full rebuild)
   */
  canPatch(mesh) {
    return this.meshFaceMaps.has(mesh);
  }
}

// Singleton instance
let instance = null;

/**
 * Get the global MeshPatcher instance
 * @returns {MeshPatcher}
 */
export function getMeshPatcher() {
  if (!instance) {
    instance = new MeshPatcher();
  }
  return instance;
}

export default MeshPatcher;
