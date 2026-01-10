/**
 * SharedMemoryPool - Manages SharedArrayBuffers for zero-copy data transfer
 * 
 * Uses SharedArrayBuffer when available (requires COOP/COEP headers) to share
 * data between workers without copying. Falls back to regular ArrayBuffer transfer
 * when SharedArrayBuffer is not available.
 * 
 * Key use cases:
 * 1. Texture index lookups (read-only, shared across all workers)
 * 2. Tint type lookups (read-only, shared across all workers)
 * 3. Block registry data (read-only, shared across all workers)
 */

let sharedBufferSupported = null;

/**
 * Check if SharedArrayBuffer is available
 * @returns {boolean}
 */
export function isSharedBufferSupported() {
  if (sharedBufferSupported !== null) {
    return sharedBufferSupported;
  }
  
  try {
    // Check if SharedArrayBuffer exists and can be created
    if (typeof SharedArrayBuffer === 'undefined') {
      sharedBufferSupported = false;
      return false;
    }
    
    // Try to create a small test buffer
    const testBuffer = new SharedArrayBuffer(8);
    const testView = new Int32Array(testBuffer);
    testView[0] = 42;
    
    // Verify Atomics work (required for proper synchronization)
    if (typeof Atomics !== 'undefined') {
      Atomics.store(testView, 0, 123);
      sharedBufferSupported = Atomics.load(testView, 0) === 123;
    } else {
      sharedBufferSupported = true;
    }
    
    console.log('[SharedMemoryPool] SharedArrayBuffer:', sharedBufferSupported ? 'available' : 'not available');
    return sharedBufferSupported;
  } catch (e) {
    console.log('[SharedMemoryPool] SharedArrayBuffer not available:', e.message);
    sharedBufferSupported = false;
    return false;
  }
}

/**
 * Create a shared or regular buffer based on availability
 * @param {number} byteLength - Size in bytes
 * @returns {ArrayBuffer|SharedArrayBuffer}
 */
export function createBuffer(byteLength) {
  if (isSharedBufferSupported()) {
    return new SharedArrayBuffer(byteLength);
  }
  return new ArrayBuffer(byteLength);
}

/**
 * Create a shared typed array from existing data
 * If SharedArrayBuffer is available, creates a shared copy
 * Otherwise, returns a view of the original or a regular copy
 * 
 * @param {TypedArray} source - Source typed array
 * @param {boolean} [forceShared=false] - Force shared even if platform doesn't support
 * @returns {{array: TypedArray, isShared: boolean}}
 */
export function createSharedTypedArray(source, forceShared = false) {
  const TypedArrayConstructor = source.constructor;
  const bytesPerElement = source.BYTES_PER_ELEMENT;
  const byteLength = source.length * bytesPerElement;
  
  if (isSharedBufferSupported() || forceShared) {
    try {
      const sharedBuffer = new SharedArrayBuffer(byteLength);
      const sharedArray = new TypedArrayConstructor(sharedBuffer);
      sharedArray.set(source);
      return { array: sharedArray, isShared: true };
    } catch (e) {
      console.warn('[SharedMemoryPool] Failed to create shared array:', e.message);
    }
  }
  
  // Fallback: return a regular copy
  const copy = new TypedArrayConstructor(source.length);
  copy.set(source);
  return { array: copy, isShared: false };
}

/**
 * Shared lookup table manager for WASM mesher
 * Creates shared buffers for frequently accessed lookup data
 */
export class SharedLookupManager {
  constructor() {
    this.textureIndexBuffer = null;
    this.tintTypeBuffer = null;
    this.isShared = false;
    this.initialized = false;
  }
  
  /**
   * Initialize shared buffers from lookup data
   * @param {Uint16Array} textureIndices - Texture index lookup
   * @param {Uint8Array} tintTypes - Tint type lookup
   */
  initialize(textureIndices, tintTypes) {
    if (this.initialized) {
      return;
    }
    
    this.isShared = isSharedBufferSupported();
    
    // Create texture index buffer
    if (textureIndices && textureIndices.length > 0) {
      const result = createSharedTypedArray(textureIndices);
      this.textureIndexBuffer = result.array;
      this.isShared = result.isShared;
    }
    
    // Create tint type buffer
    if (tintTypes && tintTypes.length > 0) {
      const result = createSharedTypedArray(tintTypes);
      this.tintTypeBuffer = result.array;
    }
    
    this.initialized = true;
    
    console.log('[SharedLookupManager] Initialized:', {
      isShared: this.isShared,
      textureIndices: this.textureIndexBuffer?.length || 0,
      tintTypes: this.tintTypeBuffer?.length || 0,
    });
  }
  
  /**
   * Get buffers for transfer to workers
   * If shared, workers can access directly without copying
   * If not shared, workers receive a copy
   * 
   * @returns {Object} Buffers for worker init
   */
  getWorkLookups() {
    return {
      textureIndices: this.textureIndexBuffer,
      tintTypes: this.tintTypeBuffer,
      isShared: this.isShared,
    };
  }
  
  /**
   * Dispose and release shared buffers
   */
  dispose() {
    this.textureIndexBuffer = null;
    this.tintTypeBuffer = null;
    this.initialized = false;
  }
}

// Singleton instance for the lookup manager
let lookupManagerInstance = null;

/**
 * Get the global shared lookup manager
 * @returns {SharedLookupManager}
 */
export function getSharedLookupManager() {
  if (!lookupManagerInstance) {
    lookupManagerInstance = new SharedLookupManager();
  }
  return lookupManagerInstance;
}

/**
 * Pre-allocate a pool of reusable shared buffers
 * Used for chunk grid data transfer
 */
export class SharedBufferPool {
  /**
   * @param {number} bufferSize - Size of each buffer in bytes
   * @param {number} poolSize - Number of buffers to pre-allocate
   */
  constructor(bufferSize, poolSize = 4) {
    this.bufferSize = bufferSize;
    this.pool = [];
    this.inUse = new Set();
    this.isShared = isSharedBufferSupported();
    
    // Pre-allocate buffers
    for (let i = 0; i < poolSize; i++) {
      const buffer = this.isShared
        ? new SharedArrayBuffer(bufferSize)
        : new ArrayBuffer(bufferSize);
      this.pool.push(buffer);
    }
  }
  
  /**
   * Acquire a buffer from the pool
   * @returns {ArrayBuffer|SharedArrayBuffer|null}
   */
  acquire() {
    // Try to get a free buffer
    const buffer = this.pool.pop();
    if (buffer) {
      this.inUse.add(buffer);
      return buffer;
    }
    
    // Pool exhausted, create a new buffer (will be added to pool on release)
    const newBuffer = this.isShared
      ? new SharedArrayBuffer(this.bufferSize)
      : new ArrayBuffer(this.bufferSize);
    this.inUse.add(newBuffer);
    return newBuffer;
  }
  
  /**
   * Release a buffer back to the pool
   * @param {ArrayBuffer|SharedArrayBuffer} buffer
   */
  release(buffer) {
    if (this.inUse.has(buffer)) {
      this.inUse.delete(buffer);
      this.pool.push(buffer);
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      available: this.pool.length,
      inUse: this.inUse.size,
      isShared: this.isShared,
    };
  }
  
  /**
   * Dispose all buffers
   */
  dispose() {
    this.pool = [];
    this.inUse.clear();
  }
}

// ============================================================================
// MeshBufferPool - Shared buffers for mesh output (Phase 2.1)
// ============================================================================

/**
 * Ring buffer for shared mesh output data
 * Pre-allocates shared buffers for zero-copy mesh data transfer
 */
class SharedBufferRing {
  /**
   * @param {number} count - Number of buffers in the ring
   * @param {number} sizeBytes - Size of each buffer in bytes
   */
  constructor(count, sizeBytes) {
    this.count = count;
    this.sizeBytes = sizeBytes;
    this.buffers = [];
    this.available = [];
    this.inUse = new Set();
    this.isShared = isSharedBufferSupported();
    
    // Pre-allocate buffers
    for (let i = 0; i < count; i++) {
      const buffer = this.isShared
        ? new SharedArrayBuffer(sizeBytes)
        : new ArrayBuffer(sizeBytes);
      this.buffers.push(buffer);
      this.available.push(buffer);
    }
  }
  
  /**
   * Acquire a buffer from the ring
   * @returns {{ buffer: ArrayBuffer|SharedArrayBuffer, offset: number, length: number } | null}
   */
  acquire() {
    if (this.available.length === 0) {
      // Pool exhausted - create overflow buffer (will be released later)
      const buffer = this.isShared
        ? new SharedArrayBuffer(this.sizeBytes)
        : new ArrayBuffer(this.sizeBytes);
      this.inUse.add(buffer);
      return { buffer, offset: 0, length: this.sizeBytes };
    }
    
    const buffer = this.available.pop();
    this.inUse.add(buffer);
    return { buffer, offset: 0, length: this.sizeBytes };
  }
  
  /**
   * Release a buffer back to the ring
   * @param {ArrayBuffer|SharedArrayBuffer} buffer
   */
  release(buffer) {
    if (this.inUse.has(buffer)) {
      this.inUse.delete(buffer);
      // Only return to pool if it's an original buffer
      if (this.buffers.includes(buffer)) {
        this.available.push(buffer);
      }
    }
  }
  
  getStats() {
    return {
      total: this.count,
      available: this.available.length,
      inUse: this.inUse.size,
      sizeBytes: this.sizeBytes,
      isShared: this.isShared
    };
  }
  
  dispose() {
    this.buffers = [];
    this.available = [];
    this.inUse.clear();
  }
}

/**
 * Pool of shared buffers for mesh output data
 * Manages separate pools for each mesh attribute type
 */
export class MeshBufferPool {
  /**
   * @param {Object} options - Pool configuration
   * @param {number} [options.ringCount=16] - Number of buffers per ring
   * @param {number} [options.positionBufferSize=512*1024] - Size of position buffers (bytes)
   * @param {number} [options.normalBufferSize=512*1024] - Size of normal buffers (bytes)
   * @param {number} [options.indexBufferSize=256*1024] - Size of index buffers (bytes)
   * @param {number} [options.uvBufferSize=256*1024] - Size of UV buffers (bytes)
   */
  constructor(options = {}) {
    const {
      ringCount = 16,
      positionBufferSize = 512 * 1024,  // 512KB - typical super-chunk needs ~100KB
      normalBufferSize = 512 * 1024,
      indexBufferSize = 256 * 1024,
      uvBufferSize = 256 * 1024,
    } = options;
    
    // Create rings for each attribute type
    this.positionRing = new SharedBufferRing(ringCount, positionBufferSize);
    this.normalRing = new SharedBufferRing(ringCount, normalBufferSize);
    this.indexRing = new SharedBufferRing(ringCount, indexBufferSize);
    this.uvRing = new SharedBufferRing(ringCount, uvBufferSize);
    
    // Additional attribute rings (colors, texIndices, etc.)
    this.colorRing = new SharedBufferRing(ringCount, positionBufferSize);
    this.texIndexRing = new SharedBufferRing(ringCount, 64 * 1024);
    this.lightRing = new SharedBufferRing(ringCount, 128 * 1024);
    
    console.log('[MeshBufferPool] Initialized with', ringCount, 'buffers per ring, shared:', this.positionRing.isShared);
  }
  
  /**
   * Acquire a set of buffers for mesh output
   * @returns {Object} Buffer set with all attribute buffers
   */
  acquireBufferSet() {
    return {
      positions: this.positionRing.acquire(),
      normals: this.normalRing.acquire(),
      indices: this.indexRing.acquire(),
      uvs: this.uvRing.acquire(),
      colors: this.colorRing.acquire(),
      texIndices: this.texIndexRing.acquire(),
      lights: this.lightRing.acquire(),
      isShared: this.positionRing.isShared
    };
  }
  
  /**
   * Release a buffer set back to the pool
   * @param {Object} bufferSet - Previously acquired buffer set
   */
  releaseBufferSet(bufferSet) {
    if (bufferSet.positions) this.positionRing.release(bufferSet.positions.buffer);
    if (bufferSet.normals) this.normalRing.release(bufferSet.normals.buffer);
    if (bufferSet.indices) this.indexRing.release(bufferSet.indices.buffer);
    if (bufferSet.uvs) this.uvRing.release(bufferSet.uvs.buffer);
    if (bufferSet.colors) this.colorRing.release(bufferSet.colors.buffer);
    if (bufferSet.texIndices) this.texIndexRing.release(bufferSet.texIndices.buffer);
    if (bufferSet.lights) this.lightRing.release(bufferSet.lights.buffer);
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      positions: this.positionRing.getStats(),
      normals: this.normalRing.getStats(),
      indices: this.indexRing.getStats(),
      uvs: this.uvRing.getStats(),
      colors: this.colorRing.getStats(),
      texIndices: this.texIndexRing.getStats(),
      lights: this.lightRing.getStats()
    };
  }
  
  /**
   * Dispose all buffers
   */
  dispose() {
    this.positionRing.dispose();
    this.normalRing.dispose();
    this.indexRing.dispose();
    this.uvRing.dispose();
    this.colorRing.dispose();
    this.texIndexRing.dispose();
    this.lightRing.dispose();
  }
}

// Singleton instance for mesh buffer pool
let meshBufferPoolInstance = null;

/**
 * Get the global mesh buffer pool
 * @param {Object} [options] - Pool configuration (only used on first call)
 * @returns {MeshBufferPool}
 */
export function getMeshBufferPool(options) {
  if (!meshBufferPoolInstance) {
    meshBufferPoolInstance = new MeshBufferPool(options);
  }
  return meshBufferPoolInstance;
}

// ============================================================================
// ZeroCopyMeshAllocator - Pre-sized buffer allocation for WASM mesh output
// ============================================================================

/**
 * Allocates typed arrays for zero-copy mesh output from WASM.
 * Uses SharedArrayBuffer when available for true zero-copy between workers.
 */
export class ZeroCopyMeshAllocator {
  constructor() {
    this.isShared = isSharedBufferSupported();
  }
  
  /**
   * Allocate buffers for a solid/glass mesh based on sizes from compute_mesh_sizes
   * @param {number} positionCount - Number of position floats (vertex_count * 3)
   * @param {number} vertexCount - Number of vertices
   * @param {number} indexCount - Number of indices
   * @returns {Object} Allocated buffers
   */
  allocateSolidMesh(positionCount, vertexCount, indexCount) {
    const BufferType = this.isShared ? SharedArrayBuffer : ArrayBuffer;
    
    return {
      positions: new Float32Array(new BufferType(positionCount * 4)),
      normals: new Float32Array(new BufferType(positionCount * 4)),
      colors: new Float32Array(new BufferType(positionCount * 4)),
      texIndices: new Float32Array(new BufferType(vertexCount * 4)),
      texRotations: new Float32Array(new BufferType(vertexCount * 4)),
      tintTypes: new Float32Array(new BufferType(vertexCount * 4)),
      packedLight: new Uint8Array(new BufferType(vertexCount)),
      indices: new Uint32Array(new BufferType(indexCount * 4)),
      vertexCount,
      isShared: this.isShared,
    };
  }
  
  /**
   * Allocate buffers for a fluid mesh (water/lava)
   * @param {number} positionCount - Number of position floats (vertex_count * 3)
   * @param {number} vertexCount - Number of vertices
   * @param {number} indexCount - Number of indices
   * @returns {Object} Allocated buffers
   */
  allocateFluidMesh(positionCount, vertexCount, indexCount) {
    const BufferType = this.isShared ? SharedArrayBuffer : ArrayBuffer;
    
    return {
      positions: new Float32Array(new BufferType(positionCount * 4)),
      normals: new Float32Array(new BufferType(positionCount * 4)),
      colors: new Float32Array(new BufferType(positionCount * 4)),
      uvs: new Float32Array(new BufferType(vertexCount * 2 * 4)), // 2 floats per vertex
      texIndices: new Float32Array(new BufferType(vertexCount * 4)),
      packedLight: new Uint8Array(new BufferType(vertexCount)),
      indices: new Uint32Array(new BufferType(indexCount * 4)),
      vertexCount,
      isShared: this.isShared,
    };
  }
  
  /**
   * Allocate buffers for a model mesh
   * @param {number} positionCount - Number of position floats (vertex_count * 3)
   * @param {number} vertexCount - Number of vertices
   * @param {number} indexCount - Number of indices
   * @returns {Object} Allocated buffers
   */
  allocateModelMesh(positionCount, vertexCount, indexCount) {
    const BufferType = this.isShared ? SharedArrayBuffer : ArrayBuffer;
    
    return {
      positions: new Float32Array(new BufferType(positionCount * 4)),
      normals: new Float32Array(new BufferType(positionCount * 4)),
      colors: new Float32Array(new BufferType(positionCount * 4)),
      uvs: new Float32Array(new BufferType(vertexCount * 2 * 4)),
      texIndices: new Float32Array(new BufferType(vertexCount * 4)),
      packedLight: new Uint8Array(new BufferType(vertexCount)),
      indices: new Uint32Array(new BufferType(indexCount * 4)),
      vertexCount,
      isShared: this.isShared,
    };
  }
  
  /**
   * Allocate all buffers for a complete mesh result
   * @param {Object} sizes - MeshSizes from WASM compute_mesh_sizes
   * @returns {Object} All allocated buffer sets
   */
  allocateAll(sizes) {
    return {
      solid: this.allocateSolidMesh(
        sizes.solid_position_count,
        sizes.solid_vertex_count,
        sizes.solid_index_count
      ),
      water: this.allocateFluidMesh(
        sizes.water_position_count,
        sizes.water_vertex_count,
        sizes.water_index_count
      ),
      lava: this.allocateFluidMesh(
        sizes.lava_position_count,
        sizes.lava_vertex_count,
        sizes.lava_index_count
      ),
      glass: this.allocateSolidMesh(
        sizes.glass_position_count,
        sizes.glass_vertex_count,
        sizes.glass_index_count
      ),
      modelOpaque: this.allocateModelMesh(
        sizes.model_opaque_position_count,
        sizes.model_opaque_vertex_count,
        sizes.model_opaque_index_count
      ),
      modelTransparent: this.allocateModelMesh(
        sizes.model_transparent_position_count,
        sizes.model_transparent_vertex_count,
        sizes.model_transparent_index_count
      ),
      isShared: this.isShared,
    };
  }
}

// Singleton allocator
let zeroCopyAllocatorInstance = null;

/**
 * Get the global zero-copy mesh allocator
 * @returns {ZeroCopyMeshAllocator}
 */
export function getZeroCopyAllocator() {
  if (!zeroCopyAllocatorInstance) {
    zeroCopyAllocatorInstance = new ZeroCopyMeshAllocator();
  }
  return zeroCopyAllocatorInstance;
}

export default {
  isSharedBufferSupported,
  createBuffer,
  createSharedTypedArray,
  SharedLookupManager,
  getSharedLookupManager,
  SharedBufferPool,
  SharedBufferRing,
  MeshBufferPool,
  getMeshBufferPool,
  ZeroCopyMeshAllocator,
  getZeroCopyAllocator,
};

