/**
 * BufferManager - Manages GPU buffer pools for efficient mesh uploads
 * 
 * This class provides:
 * 1. Buffer pooling to reuse WebGL buffers instead of creating new ones
 * 2. Size class buckets for efficient buffer reuse
 * 3. Direct buffer updates to avoid reallocations
 * 
 * Phase 2.2 of the performance architecture overhaul.
 */

import * as THREE from 'three';

// Size classes for buffer pooling (in bytes)
const SIZE_CLASSES = [
  64 * 1024,      // 64KB
  128 * 1024,     // 128KB
  256 * 1024,     // 256KB
  512 * 1024,     // 512KB
  1024 * 1024,    // 1MB
  2048 * 1024,    // 2MB
  4096 * 1024,    // 4MB
];

/**
 * Get the size class for a given byte length
 * @param {number} byteLength
 * @returns {number} Size class index, or -1 if too large
 */
function getSizeClass(byteLength) {
  for (let i = 0; i < SIZE_CLASSES.length; i++) {
    if (byteLength <= SIZE_CLASSES[i]) {
      return i;
    }
  }
  return -1; // Too large for pooling
}

/**
 * Buffer pool for a specific attribute type
 */
class AttributeBufferPool {
  constructor(name, type = 'float32') {
    this.name = name;
    this.type = type;
    
    // Pools by size class
    this.pools = SIZE_CLASSES.map(() => []);
    
    // Track allocations for stats
    this.stats = {
      allocations: 0,
      reuses: 0,
      releases: 0,
      pooledCount: 0,
      totalBytes: 0
    };
  }
  
  /**
   * Acquire a buffer attribute from the pool
   * @param {TypedArray} data - Data to store
   * @param {number} itemSize - Items per vertex (e.g., 3 for vec3)
   * @returns {THREE.BufferAttribute}
   */
  acquire(data, itemSize) {
    const byteLength = data.byteLength;
    const sizeClass = getSizeClass(byteLength);
    
    // Try to get from pool
    if (sizeClass >= 0 && this.pools[sizeClass].length > 0) {
      const attr = this.pools[sizeClass].pop();
      this.stats.reuses++;
      this.stats.pooledCount--;
      
      // Update the array data in place if it fits
      if (attr.array.length >= data.length) {
        attr.array.set(data);
        attr.count = data.length / itemSize;
        attr.itemSize = itemSize;
        attr.needsUpdate = true;
        return attr;
      }
      
      // Size mismatch - need to create new
      attr.array = data;
      attr.count = data.length / itemSize;
      attr.itemSize = itemSize;
      attr.needsUpdate = true;
      return attr;
    }
    
    // Create new attribute
    this.stats.allocations++;
    this.stats.totalBytes += byteLength;
    return new THREE.BufferAttribute(data, itemSize);
  }
  
  /**
   * Release a buffer attribute back to the pool
   * @param {THREE.BufferAttribute} attr
   */
  release(attr) {
    if (!attr || !attr.array) return;
    
    const byteLength = attr.array.byteLength;
    const sizeClass = getSizeClass(byteLength);
    
    if (sizeClass >= 0) {
      // Only pool if not too many buffers
      if (this.pools[sizeClass].length < 8) {
        this.pools[sizeClass].push(attr);
        this.stats.pooledCount++;
      }
    }
    
    this.stats.releases++;
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      pools: this.pools.map((p, i) => ({
        sizeClass: SIZE_CLASSES[i],
        count: p.length
      }))
    };
  }
  
  /**
   * Clear all pooled buffers
   */
  clear() {
    this.pools = SIZE_CLASSES.map(() => []);
    this.stats.pooledCount = 0;
  }
}

/**
 * Geometry pool for reusing BufferGeometry instances
 */
class GeometryPool {
  constructor() {
    this.available = [];
    this.inUse = new Set();
    this.stats = {
      created: 0,
      reused: 0,
      released: 0
    };
  }
  
  /**
   * Acquire a geometry from the pool
   * @returns {THREE.BufferGeometry}
   */
  acquire() {
    if (this.available.length > 0) {
      const geom = this.available.pop();
      this.inUse.add(geom);
      this.stats.reused++;
      return geom;
    }
    
    const geom = new THREE.BufferGeometry();
    this.inUse.add(geom);
    this.stats.created++;
    return geom;
  }
  
  /**
   * Release a geometry back to the pool
   * @param {THREE.BufferGeometry} geom
   */
  release(geom) {
    if (!geom) return;
    
    if (this.inUse.has(geom)) {
      this.inUse.delete(geom);
      
      // Clear attributes but keep geometry object
      const attrs = Object.keys(geom.attributes);
      for (const name of attrs) {
        geom.deleteAttribute(name);
      }
      geom.setIndex(null);
      
      // Only pool if not too many
      if (this.available.length < 32) {
        this.available.push(geom);
      } else {
        geom.dispose();
      }
      
      this.stats.released++;
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      available: this.available.length,
      inUse: this.inUse.size
    };
  }
  
  dispose() {
    for (const geom of this.available) {
      geom.dispose();
    }
    for (const geom of this.inUse) {
      geom.dispose();
    }
    this.available = [];
    this.inUse.clear();
  }
}

/**
 * Main BufferManager class
 * Manages all buffer pools for efficient GPU memory usage
 */
export class BufferManager {
  constructor() {
    // Attribute pools by name
    this.attributePools = {
      position: new AttributeBufferPool('position', 'float32'),
      normal: new AttributeBufferPool('normal', 'float32'),
      uv: new AttributeBufferPool('uv', 'float32'),
      color: new AttributeBufferPool('color', 'float32'),
      texIndex: new AttributeBufferPool('texIndex', 'float32'),
      tintType: new AttributeBufferPool('tintType', 'float32'),
      ao: new AttributeBufferPool('ao', 'float32'),
      skyLight: new AttributeBufferPool('skyLight', 'float32'),
      blockLight: new AttributeBufferPool('blockLight', 'float32'),
    };
    
    // Index buffer pool (separate because it uses Uint16/Uint32)
    this.indexPool = new AttributeBufferPool('index', 'uint32');
    
    // Geometry pool
    this.geometryPool = new GeometryPool();
  }
  
  /**
   * Create or reuse a BufferGeometry with the given attributes
   * @param {Object} data - Mesh data with typed arrays
   * @returns {THREE.BufferGeometry}
   */
  createGeometry(data) {
    const geometry = this.geometryPool.acquire();
    
    // Set position attribute
    if (data.positions && data.positions.length > 0) {
      const attr = this.attributePools.position.acquire(data.positions, 3);
      geometry.setAttribute('position', attr);
    }
    
    // Set normal attribute
    if (data.normals && data.normals.length > 0) {
      const attr = this.attributePools.normal.acquire(data.normals, 3);
      geometry.setAttribute('normal', attr);
    }
    
    // Set UV attribute
    if (data.uvs && data.uvs.length > 0) {
      const attr = this.attributePools.uv.acquire(data.uvs, 2);
      geometry.setAttribute('uv', attr);
    }
    
    // Set color attribute
    if (data.colors && data.colors.length > 0) {
      const attr = this.attributePools.color.acquire(data.colors, 3);
      geometry.setAttribute('color', attr);
    }
    
    // Set texture index attribute
    if (data.texIndices && data.texIndices.length > 0) {
      const attr = this.attributePools.texIndex.acquire(data.texIndices, 1);
      geometry.setAttribute('texIndex', attr);
    }
    
    // Set tint type attribute
    if (data.tintTypes && data.tintTypes.length > 0) {
      const attr = this.attributePools.tintType.acquire(data.tintTypes, 1);
      geometry.setAttribute('tintType', attr);
    }
    
    // Set AO attribute
    if (data.ao && data.ao.length > 0) {
      const attr = this.attributePools.ao.acquire(data.ao, 1);
      geometry.setAttribute('ao', attr);
    }
    
    // Set light attributes
    if (data.skyLight && data.skyLight.length > 0) {
      const attr = this.attributePools.skyLight.acquire(data.skyLight, 1);
      geometry.setAttribute('skyLight', attr);
    }
    
    if (data.blockLight && data.blockLight.length > 0) {
      const attr = this.attributePools.blockLight.acquire(data.blockLight, 1);
      geometry.setAttribute('blockLight', attr);
    }
    
    // Set index buffer
    if (data.indices && data.indices.length > 0) {
      const attr = this.indexPool.acquire(data.indices, 1);
      geometry.setIndex(attr);
    }
    
    // Compute bounding sphere for frustum culling
    geometry.computeBoundingSphere();
    
    return geometry;
  }
  
  /**
   * Update an existing geometry with new data (in-place update)
   * More efficient than creating new geometry when sizes match
   * 
   * @param {THREE.BufferGeometry} geometry - Existing geometry to update
   * @param {Object} data - New mesh data
   * @returns {boolean} True if update succeeded (sizes matched)
   */
  updateGeometry(geometry, data) {
    if (!geometry) return false;
    
    let sizeMatch = true;
    
    // Update position
    const posAttr = geometry.getAttribute('position');
    if (posAttr && data.positions) {
      if (posAttr.array.length === data.positions.length) {
        posAttr.array.set(data.positions);
        posAttr.needsUpdate = true;
      } else {
        sizeMatch = false;
      }
    }
    
    // Update normal
    const normAttr = geometry.getAttribute('normal');
    if (normAttr && data.normals) {
      if (normAttr.array.length === data.normals.length) {
        normAttr.array.set(data.normals);
        normAttr.needsUpdate = true;
      } else {
        sizeMatch = false;
      }
    }
    
    // Update UV
    const uvAttr = geometry.getAttribute('uv');
    if (uvAttr && data.uvs) {
      if (uvAttr.array.length === data.uvs.length) {
        uvAttr.array.set(data.uvs);
        uvAttr.needsUpdate = true;
      } else {
        sizeMatch = false;
      }
    }
    
    // Update index
    const idxAttr = geometry.getIndex();
    if (idxAttr && data.indices) {
      if (idxAttr.array.length === data.indices.length) {
        idxAttr.array.set(data.indices);
        idxAttr.needsUpdate = true;
      } else {
        sizeMatch = false;
      }
    }
    
    if (sizeMatch) {
      geometry.computeBoundingSphere();
    }
    
    return sizeMatch;
  }
  
  /**
   * Release a geometry and its attributes back to pools
   * @param {THREE.BufferGeometry} geometry
   */
  releaseGeometry(geometry) {
    if (!geometry) return;
    
    // Release attributes back to pools
    for (const [name, pool] of Object.entries(this.attributePools)) {
      const attr = geometry.getAttribute(name);
      if (attr) {
        pool.release(attr);
      }
    }
    
    // Release index buffer
    const index = geometry.getIndex();
    if (index) {
      this.indexPool.release(index);
    }
    
    // Release geometry
    this.geometryPool.release(geometry);
  }
  
  /**
   * Get statistics about buffer usage
   */
  getStats() {
    const stats = {
      geometry: this.geometryPool.getStats(),
      index: this.indexPool.getStats(),
      attributes: {}
    };
    
    for (const [name, pool] of Object.entries(this.attributePools)) {
      stats.attributes[name] = pool.getStats();
    }
    
    return stats;
  }
  
  /**
   * Clear all pools
   */
  clear() {
    for (const pool of Object.values(this.attributePools)) {
      pool.clear();
    }
    this.indexPool.clear();
    this.geometryPool.dispose();
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    this.clear();
  }
}

// Singleton instance
let instance = null;

/**
 * Get the global BufferManager instance
 * @returns {BufferManager}
 */
export function getBufferManager() {
  if (!instance) {
    instance = new BufferManager();
  }
  return instance;
}

export default BufferManager;
