/**
 * Shared Memory Manager
 * 
 * Provides SharedArrayBuffer-based memory pools for zero-copy data transfer
 * between extraction workers and mesh workers.
 * 
 * Falls back to standard ArrayBuffer if SharedArrayBuffer is not available.
 */

// Check if SharedArrayBuffer is available (requires COOP/COEP headers)
export const isSharedMemoryAvailable = (() => {
  try {
    // Test if SharedArrayBuffer works (some browsers block it without proper headers)
    const test = new SharedArrayBuffer(8);
    return true;
  } catch (e) {
    console.log('SharedArrayBuffer not available - using standard ArrayBuffer');
    return false;
  }
})();

/**
 * Memory pool for efficient buffer reuse
 */
class MemoryPool {
  constructor(poolSizeMB = 100) {
    this.poolSizeMB = poolSizeMB;
    this.pools = new Map(); // size -> array of available buffers
    this.allocated = new Set(); // currently in-use buffers
    this.totalAllocated = 0;
    this.maxBytes = poolSizeMB * 1024 * 1024;
  }

  /**
   * Acquire a buffer of at least the specified size
   * @param {number} minBytes - Minimum size needed
   * @param {boolean} useShared - Use SharedArrayBuffer if available
   * @returns {ArrayBuffer|SharedArrayBuffer}
   */
  acquire(minBytes, useShared = true) {
    // Round up to nearest power of 2 for better reuse
    const size = this.nextPowerOf2(minBytes);
    
    // Check pool for available buffer
    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      const buffer = pool.pop();
      this.allocated.add(buffer);
      return buffer;
    }
    
    // Allocate new buffer
    const shouldUseShared = useShared && isSharedMemoryAvailable;
    const buffer = shouldUseShared 
      ? new SharedArrayBuffer(size)
      : new ArrayBuffer(size);
    
    this.allocated.add(buffer);
    this.totalAllocated += size;
    
    return buffer;
  }

  /**
   * Release a buffer back to the pool
   * @param {ArrayBuffer|SharedArrayBuffer} buffer
   */
  release(buffer) {
    if (!this.allocated.has(buffer)) return;
    
    this.allocated.delete(buffer);
    const size = buffer.byteLength;
    
    // Only pool if we're under the max and buffer is reusable
    if (this.totalAllocated < this.maxBytes) {
      if (!this.pools.has(size)) {
        this.pools.set(size, []);
      }
      this.pools.get(size).push(buffer);
    } else {
      this.totalAllocated -= size;
    }
  }

  /**
   * Clear all pooled buffers
   */
  clear() {
    this.pools.clear();
    this.allocated.clear();
    this.totalAllocated = 0;
  }

  nextPowerOf2(n) {
    n--;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    return n + 1;
  }
}

// Global memory pool instance
const memoryPool = new MemoryPool(200); // 200MB pool

/**
 * Allocate typed arrays that can be shared between workers
 * 
 * @param {number} maxBlocks - Maximum number of blocks to allocate for
 * @returns {Object} Typed arrays backed by SharedArrayBuffer if available
 */
export function allocateBlockBuffers(maxBlocks) {
  const useShared = isSharedMemoryAvailable;
  
  // Calculate sizes
  const xSize = maxBlocks * 4; // Int32Array
  const ySize = maxBlocks * 2; // Int16Array
  const zSize = maxBlocks * 4; // Int32Array
  const blockTypeSize = maxBlocks * 2; // Uint16Array
  const levelSize = maxBlocks * 1; // Int8Array
  
  // Allocate buffers
  const xBuffer = memoryPool.acquire(xSize, useShared);
  const yBuffer = memoryPool.acquire(ySize, useShared);
  const zBuffer = memoryPool.acquire(zSize, useShared);
  const blockTypeBuffer = memoryPool.acquire(blockTypeSize, useShared);
  const levelBuffer = memoryPool.acquire(levelSize, useShared);
  
  return {
    x: new Int32Array(xBuffer, 0, maxBlocks),
    y: new Int16Array(yBuffer, 0, maxBlocks),
    z: new Int32Array(zBuffer, 0, maxBlocks),
    blockType: new Uint16Array(blockTypeBuffer, 0, maxBlocks),
    level: new Int8Array(levelBuffer, 0, maxBlocks),
    maxBlocks,
    isShared: useShared,
    // Store buffers for later release
    _buffers: [xBuffer, yBuffer, zBuffer, blockTypeBuffer, levelBuffer],
  };
}

/**
 * Release block buffers back to pool
 */
export function releaseBlockBuffers(buffers) {
  if (buffers._buffers) {
    for (const buffer of buffers._buffers) {
      memoryPool.release(buffer);
    }
  }
}

/**
 * Create a view of existing shared buffers (for workers to read)
 * 
 * @param {Object} sharedData - Object containing SharedArrayBuffers and metadata
 * @returns {Object} Typed array views of the shared data
 */
export function createBufferViews(sharedData) {
  const { xBuffer, yBuffer, zBuffer, blockTypeBuffer, levelBuffer, count, maxBlocks } = sharedData;
  
  return {
    x: new Int32Array(xBuffer, 0, count),
    y: new Int16Array(yBuffer, 0, count),
    z: new Int32Array(zBuffer, 0, count),
    blockType: new Uint16Array(blockTypeBuffer, 0, count),
    level: new Int8Array(levelBuffer, 0, count),
    count,
  };
}

/**
 * Serialize block buffers for worker transfer
 * Returns either transferable ArrayBuffers or SharedArrayBuffer references
 */
export function serializeBlockBuffers(typedBlocks) {
  if (typedBlocks.isShared) {
    // SharedArrayBuffer - send buffer references (no transfer needed)
    return {
      type: 'shared',
      xBuffer: typedBlocks.x.buffer,
      yBuffer: typedBlocks.y.buffer,
      zBuffer: typedBlocks.z.buffer,
      blockTypeBuffer: typedBlocks.blockType.buffer,
      levelBuffer: typedBlocks.level.buffer,
      count: typedBlocks.count,
      maxBlocks: typedBlocks.maxBlocks,
    };
  } else {
    // Standard ArrayBuffer - needs to be transferred
    return {
      type: 'transfer',
      x: typedBlocks.x,
      y: typedBlocks.y,
      z: typedBlocks.z,
      blockType: typedBlocks.blockType,
      level: typedBlocks.level,
      count: typedBlocks.count,
    };
  }
}

/**
 * Get transferable list for postMessage
 */
export function getTransferables(serialized) {
  if (serialized.type === 'shared') {
    return []; // SharedArrayBuffer doesn't need to be transferred
  }
  return [
    serialized.x.buffer,
    serialized.y.buffer,
    serialized.z.buffer,
    serialized.blockType.buffer,
    serialized.level.buffer,
  ];
}

export { memoryPool };

