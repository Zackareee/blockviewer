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

export default {
  isSharedBufferSupported,
  createBuffer,
  createSharedTypedArray,
  SharedLookupManager,
  getSharedLookupManager,
  SharedBufferPool,
};

