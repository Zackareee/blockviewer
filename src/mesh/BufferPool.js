/**
 * BufferPool - Reusable typed array pool for mesh data
 * 
 * Reduces GC pressure by reusing typed arrays instead of creating new ones
 * for every mesh operation. Uses size classes to efficiently match buffers
 * to requests.
 * 
 * Phase 7.1 of the performance architecture overhaul.
 */

/**
 * Size classes for buffer pooling
 * Powers of 2 for efficient allocation
 */
const SIZE_CLASSES = [
  1024,        // 1KB
  4096,        // 4KB
  16384,       // 16KB
  65536,       // 64KB
  262144,      // 256KB
  1048576,     // 1MB
  4194304,     // 4MB
];

/**
 * Get the size class for a given length
 * Returns the smallest size class that fits the length
 */
function getSizeClass(length) {
  for (let i = 0; i < SIZE_CLASSES.length; i++) {
    if (length <= SIZE_CLASSES[i]) {
      return i;
    }
  }
  return -1; // Too large for pooling
}

/**
 * Pool for a specific typed array type
 */
class TypedArrayPool {
  /**
   * @param {Function} TypedArrayConstructor - e.g., Float32Array, Uint16Array
   * @param {number} [maxPoolSize=16] - Maximum buffers to keep per size class
   */
  constructor(TypedArrayConstructor, maxPoolSize = 16) {
    this.ArrayType = TypedArrayConstructor;
    this.maxPoolSize = maxPoolSize;
    this.bytesPerElement = TypedArrayConstructor.BYTES_PER_ELEMENT;
    
    // Pools by size class
    this.pools = SIZE_CLASSES.map(() => []);
    
    // Statistics
    this.stats = {
      allocations: 0,
      reuses: 0,
      releases: 0,
      oversized: 0,
    };
  }
  
  /**
   * Acquire a typed array of at least the given length
   * @param {number} length - Minimum number of elements needed
   * @returns {TypedArray} Typed array (may be larger than requested)
   */
  acquire(length) {
    const sizeClass = getSizeClass(length);
    
    if (sizeClass >= 0) {
      const pool = this.pools[sizeClass];
      
      if (pool.length > 0) {
        this.stats.reuses++;
        return pool.pop();
      }
      
      // Create new buffer at size class size
      this.stats.allocations++;
      return new this.ArrayType(SIZE_CLASSES[sizeClass]);
    }
    
    // Too large for pooling - allocate exact size
    this.stats.oversized++;
    return new this.ArrayType(length);
  }
  
  /**
   * Acquire a typed array and copy data into it
   * @param {TypedArray} source - Source array to copy from
   * @returns {TypedArray} New typed array with copied data
   */
  acquireWithData(source) {
    const buffer = this.acquire(source.length);
    buffer.set(source);
    return buffer;
  }
  
  /**
   * Release a typed array back to the pool
   * @param {TypedArray} buffer - Buffer to release
   */
  release(buffer) {
    if (!buffer || !(buffer instanceof this.ArrayType)) {
      return;
    }
    
    const sizeClass = getSizeClass(buffer.length);
    
    if (sizeClass >= 0) {
      const pool = this.pools[sizeClass];
      
      // Only pool if not at capacity
      if (pool.length < this.maxPoolSize) {
        pool.push(buffer);
        this.stats.releases++;
      }
    }
    // Oversized buffers are not pooled - let GC handle them
  }
  
  /**
   * Clear all pools
   */
  clear() {
    for (const pool of this.pools) {
      pool.length = 0;
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const pooledCount = this.pools.reduce((sum, pool) => sum + pool.length, 0);
    const pooledBytes = this.pools.reduce((sum, pool, i) => 
      sum + pool.length * SIZE_CLASSES[i] * this.bytesPerElement, 0);
    
    return {
      ...this.stats,
      pooledCount,
      pooledBytes,
      hitRate: this.stats.allocations + this.stats.reuses > 0
        ? this.stats.reuses / (this.stats.allocations + this.stats.reuses)
        : 0,
    };
  }
}

/**
 * Main BufferPool class
 * Manages typed array pools for all mesh data types
 */
export class BufferPool {
  constructor(options = {}) {
    const { maxPoolSize = 16 } = options;
    
    // Create pools for each typed array type
    this.float32Pool = new TypedArrayPool(Float32Array, maxPoolSize);
    this.uint16Pool = new TypedArrayPool(Uint16Array, maxPoolSize);
    this.uint32Pool = new TypedArrayPool(Uint32Array, maxPoolSize);
    this.uint8Pool = new TypedArrayPool(Uint8Array, maxPoolSize);
    this.int8Pool = new TypedArrayPool(Int8Array, maxPoolSize);
  }
  
  /**
   * Get pool for a specific type
   * @param {string} type - 'float32', 'uint16', 'uint32', 'uint8', 'int8'
   * @returns {TypedArrayPool}
   */
  getPool(type) {
    switch (type) {
      case 'float32': return this.float32Pool;
      case 'uint16': return this.uint16Pool;
      case 'uint32': return this.uint32Pool;
      case 'uint8': return this.uint8Pool;
      case 'int8': return this.int8Pool;
      default: throw new Error(`Unknown buffer type: ${type}`);
    }
  }
  
  /**
   * Acquire a Float32Array
   * @param {number} length - Minimum length
   * @returns {Float32Array}
   */
  acquireFloat32(length) {
    return this.float32Pool.acquire(length);
  }
  
  /**
   * Acquire a Uint16Array
   * @param {number} length - Minimum length
   * @returns {Uint16Array}
   */
  acquireUint16(length) {
    return this.uint16Pool.acquire(length);
  }
  
  /**
   * Acquire a Uint32Array
   * @param {number} length - Minimum length
   * @returns {Uint32Array}
   */
  acquireUint32(length) {
    return this.uint32Pool.acquire(length);
  }
  
  /**
   * Acquire a Uint8Array
   * @param {number} length - Minimum length
   * @returns {Uint8Array}
   */
  acquireUint8(length) {
    return this.uint8Pool.acquire(length);
  }
  
  /**
   * Release a buffer back to the appropriate pool
   * @param {TypedArray} buffer - Buffer to release
   */
  release(buffer) {
    if (buffer instanceof Float32Array) {
      this.float32Pool.release(buffer);
    } else if (buffer instanceof Uint16Array) {
      this.uint16Pool.release(buffer);
    } else if (buffer instanceof Uint32Array) {
      this.uint32Pool.release(buffer);
    } else if (buffer instanceof Uint8Array) {
      this.uint8Pool.release(buffer);
    } else if (buffer instanceof Int8Array) {
      this.int8Pool.release(buffer);
    }
  }
  
  /**
   * Release multiple buffers
   * @param {Object} buffers - Object with buffer properties
   */
  releaseAll(buffers) {
    if (!buffers) return;
    
    for (const key in buffers) {
      const buffer = buffers[key];
      if (buffer && buffer.buffer) {
        this.release(buffer);
      }
    }
  }
  
  /**
   * Clear all pools
   */
  clear() {
    this.float32Pool.clear();
    this.uint16Pool.clear();
    this.uint32Pool.clear();
    this.uint8Pool.clear();
    this.int8Pool.clear();
  }
  
  /**
   * Get statistics for all pools
   */
  getStats() {
    return {
      float32: this.float32Pool.getStats(),
      uint16: this.uint16Pool.getStats(),
      uint32: this.uint32Pool.getStats(),
      uint8: this.uint8Pool.getStats(),
      int8: this.int8Pool.getStats(),
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get the global BufferPool instance
 * @returns {BufferPool}
 */
export function getBufferPool() {
  if (!instance) {
    instance = new BufferPool();
  }
  return instance;
}

export default BufferPool;
