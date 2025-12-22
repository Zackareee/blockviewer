/**
 * Collision Worker Manager - Async collision building with pre-fetching
 * 
 * OPTIMIZED VERSION v2:
 * - Uses packed integer keys instead of strings for O(1) lookup
 * - Keeps collision data as typed arrays in cache
 * - NO MERGE STEP - lookups go directly to per-chunk cached data
 * - Minimizes main-thread work by doing heavy lifting in worker
 */

/**
 * Pack x, y, z coordinates into a single 64-bit-safe integer key
 * x, z: -2^20 to 2^20 (covers Minecraft world size with margin)
 * y: -2048 to 2047 (covers Minecraft height range -64 to 320+)
 * 
 * Layout: lower 21 bits = x+1048576, next 12 bits = y+2048, next 21 bits = z+1048576
 * Total: 54 bits, safe for JS number precision
 */
function packCoord(x, y, z) {
  // Offset to make all values positive
  const px = (x + 1048576) >>> 0;
  const py = (y + 2048) >>> 0;
  const pz = (z + 1048576) >>> 0;
  // Pack into single number (safe up to 2^53)
  return px + py * 2097152 + pz * 8589934592;
}

/**
 * ChunkedCollisionSet - Zero-copy collision lookup using per-chunk data
 * Eliminates the expensive merge step by doing direct chunk lookups
 */
class ChunkedCollisionSet {
  constructor(chunkKeyCache, activeChunkKeys) {
    // Reference to the chunk cache (not a copy!)
    this.chunkKeyCache = chunkKeyCache;
    // Set of chunk keys that are active for collision
    this.activeChunkKeys = activeChunkKeys;
    // Cache the size calculation
    this._cachedSize = null;
  }
  
  has(x, y, z) {
    // Determine which chunk this coordinate is in
    const chunkX = Math.floor(x / 16);
    const chunkZ = Math.floor(z / 16);
    const chunkKey = `${chunkX},${chunkZ}`;
    
    // Check if this chunk is active
    if (!this.activeChunkKeys.has(chunkKey)) {
      return false;
    }
    
    // Get the chunk's collision data
    const chunkSet = this.chunkKeyCache.get(chunkKey);
    if (!chunkSet) return false;
    
    // Check if the coordinate exists in this chunk
    return chunkSet.has(packCoord(x, y, z));
  }
  
  get size() {
    if (this._cachedSize !== null) return this._cachedSize;
    
    let total = 0;
    for (const chunkKey of this.activeChunkKeys) {
      const chunkSet = this.chunkKeyCache.get(chunkKey);
      if (chunkSet) {
        total += chunkSet.size;
      }
    }
    this._cachedSize = total;
    return total;
  }
}

// Legacy CollisionSet for single-chunk mode (backwards compatibility)
class CollisionSet {
  constructor() {
    this.data = new Set();
  }
  
  add(x, y, z) {
    this.data.add(packCoord(x, y, z));
  }
  
  has(x, y, z) {
    return this.data.has(packCoord(x, y, z));
  }
  
  get size() {
    return this.data.size;
  }
  
  clear() {
    this.data.clear();
  }
}

class CollisionWorkerManager {
  constructor() {
    this.worker = null;
    this.isInitialized = false;
    this.pendingTasks = new Map();
    this.nextTaskId = 0;
    
    // Cache of collision data per chunk (key: "chunkX,chunkZ")
    // Value: Int32Array of packed [x1,y1,z1,x2,y2,z2,...] coordinates
    this.chunkCollisionCache = new Map();
    
    // Cache of packed keys per chunk for fast merging
    this.chunkKeyCache = new Map();
    
    // Current Y filter range (cache invalidation when changed)
    this.cachedMinY = null;
    this.cachedMaxY = null;
    
    // Pre-fetch state
    this.prefetchInProgress = false;
    
    // Current active collision set
    this.activeCollisionSet = null;
    
    // Track which chunks are currently in the collision set
    this.activeChunks = new Set();
  }

  /**
   * Initialize the worker
   */
  async init() {
    if (this.isInitialized) return;
    
    this.worker = new Worker(
      new URL('../workers/collisionWorker.js', import.meta.url),
      { type: 'module' }
    );
    
    this.worker.onmessage = (e) => this.handleWorkerMessage(e);
    this.worker.onerror = (e) => console.error('Collision worker error:', e);
    
    this.isInitialized = true;
    console.log('Collision worker initialized');
  }

  /**
   * Handle messages from worker
   */
  handleWorkerMessage(e) {
    const { type, id, result } = e.data;
    
    const task = this.pendingTasks.get(id);
    if (!task) return;
    
    this.pendingTasks.delete(id);
    
    if (type === 'collisionResult') {
      // Keep data as typed array - don't convert to Set here!
      task.resolve({
        collisionData: result.collisionData,
        blockCount: result.blockCount,
        timeMs: result.timeMs
      });
    }
  }

  /**
   * Build collision for specified chunks (async, off main thread)
   * @param {Array} chunkRefs - Array of {rawData, chunkX, chunkZ}
   * @param {number} filterMinY - Minimum Y to include
   * @param {number} filterMaxY - Maximum Y to include
   * @returns {Promise<{collisionData: Int32Array, blockCount: number}>}
   */
  async buildCollision(chunkRefs, filterMinY, filterMaxY) {
    if (!this.isInitialized) await this.init();
    
    const taskId = this.nextTaskId++;
    
    // Prepare chunk data for transfer
    const chunks = chunkRefs.map(ref => ({
      rawData: ref.rawData,
      chunkX: ref.chunkX,
      chunkZ: ref.chunkZ
    }));
    
    return new Promise((resolve, reject) => {
      this.pendingTasks.set(taskId, { resolve, reject });
      
      this.worker.postMessage({
        type: 'buildCollision',
        id: taskId,
        data: {
          chunks,
          filterMinY,
          filterMaxY
        }
      });
    });
  }

  /**
   * Get chunks within radius of a position
   */
  getChunksInRadius(allChunkRefs, centerChunkX, centerChunkZ, radius) {
    return allChunkRefs.filter(ref => {
      const dx = Math.abs(ref.chunkX - centerChunkX);
      const dz = Math.abs(ref.chunkZ - centerChunkZ);
      return dx <= radius && dz <= radius;
    });
  }

  /**
   * Cache collision data for a chunk (stores as typed array + pre-computed keys)
   */
  cacheChunkCollision(chunkKey, collisionData) {
    // Store the raw typed array
    this.chunkCollisionCache.set(chunkKey, collisionData);
    
    // Pre-compute packed keys for fast merging
    const keys = new Set();
    for (let i = 0; i < collisionData.length; i += 3) {
      keys.add(packCoord(collisionData[i], collisionData[i + 1], collisionData[i + 2]));
    }
    this.chunkKeyCache.set(chunkKey, keys);
  }

  /**
   * Build localized collision around player position
   * OPTIMIZED v2: Zero-copy - returns a view that references cached data directly
   * 
   * @param {Array} allChunkRefs - All available chunk references
   * @param {Object} center - Region center {x, y, z}
   * @param {number} playerMeshX - Player X in mesh coordinates
   * @param {number} playerMeshZ - Player Z in mesh coordinates
   * @param {number} filterMinY - Min Y filter
   * @param {number} filterMaxY - Max Y filter
   * @param {number} radius - Collision radius in chunks (default 4)
   * @returns {Promise<ChunkedCollisionSet>} - Zero-copy collision lookup
   */
  async buildLocalCollision(allChunkRefs, center, playerMeshX, playerMeshZ, filterMinY, filterMaxY, radius = 4) {
    if (!this.isInitialized) await this.init();
    
    const startTime = performance.now();
    
    // Check if Y range changed (invalidates cache)
    if (this.cachedMinY !== filterMinY || this.cachedMaxY !== filterMaxY) {
      this.chunkCollisionCache.clear();
      this.chunkKeyCache.clear();
      this.activeChunks.clear();
      this.cachedMinY = filterMinY;
      this.cachedMaxY = filterMaxY;
    }
    
    // Calculate player's chunk position
    const playerBlockX = playerMeshX + center.x;
    const playerBlockZ = playerMeshZ + center.z;
    const playerChunkX = Math.floor(playerBlockX / 16);
    const playerChunkZ = Math.floor(playerBlockZ / 16);
    
    // Get nearby chunks
    const nearbyChunks = this.getChunksInRadius(allChunkRefs, playerChunkX, playerChunkZ, radius);
    const nearbyChunkKeys = new Set(nearbyChunks.map(c => `${c.chunkX},${c.chunkZ}`));
    
    // Find chunks that need to be fetched (not in cache)
    const uncachedChunks = [];
    for (const chunk of nearbyChunks) {
      const key = `${chunk.chunkX},${chunk.chunkZ}`;
      if (!this.chunkKeyCache.has(key)) {
        uncachedChunks.push(chunk);
      }
    }
    
    // Build collision for uncached chunks in worker
    if (uncachedChunks.length > 0) {
      const { collisionData, timeMs } = await this.buildCollision(uncachedChunks, filterMinY, filterMaxY);
      
      // Group collision data by chunk and cache
      const chunkBuckets = new Map();
      
      for (let i = 0; i < collisionData.length; i += 3) {
        const x = collisionData[i];
        const y = collisionData[i + 1];
        const z = collisionData[i + 2];
        const chunkX = Math.floor(x / 16);
        const chunkZ = Math.floor(z / 16);
        const chunkKey = `${chunkX},${chunkZ}`;
        
        if (!chunkBuckets.has(chunkKey)) {
          chunkBuckets.set(chunkKey, []);
        }
        chunkBuckets.get(chunkKey).push(x, y, z);
      }
      
      // Store each chunk's data in cache
      for (const [chunkKey, blocks] of chunkBuckets) {
        this.cacheChunkCollision(chunkKey, new Int32Array(blocks));
      }
      
      // Also cache empty chunks
      for (const chunk of uncachedChunks) {
        const key = `${chunk.chunkX},${chunk.chunkZ}`;
        if (!this.chunkKeyCache.has(key)) {
          this.cacheChunkCollision(key, new Int32Array(0));
        }
      }
      
      console.log(`Collision: ${uncachedChunks.length} chunks extracted in ${timeMs.toFixed(1)}ms`);
    }
    
    // Create a zero-copy collision set that references cached data directly
    // NO MERGE STEP - lookups go directly to per-chunk cache
    const collisionSet = new ChunkedCollisionSet(this.chunkKeyCache, nearbyChunkKeys);
    
    const totalTime = performance.now() - startTime;
    console.log(`Collision ready: ${collisionSet.size} blocks (${nearbyChunks.length} chunks) in ${totalTime.toFixed(1)}ms`);
    
    this.activeChunks = nearbyChunkKeys;
    return collisionSet;
  }

  /**
   * Pre-fetch collision for chunks in a direction
   * Non-blocking, updates cache in background
   */
  prefetchInDirection(allChunkRefs, center, playerMeshX, playerMeshZ, velocityX, velocityZ, filterMinY, filterMaxY, lookAheadChunks = 2) {
    // Skip if already prefetching or no movement
    if (this.prefetchInProgress) return;
    if (Math.abs(velocityX) < 0.1 && Math.abs(velocityZ) < 0.1) return;
    
    // Calculate player's chunk and direction
    const playerBlockX = playerMeshX + center.x;
    const playerBlockZ = playerMeshZ + center.z;
    const playerChunkX = Math.floor(playerBlockX / 16);
    const playerChunkZ = Math.floor(playerBlockZ / 16);
    
    // Determine prefetch direction
    const dirX = velocityX > 0.1 ? 1 : velocityX < -0.1 ? -1 : 0;
    const dirZ = velocityZ > 0.1 ? 1 : velocityZ < -0.1 ? -1 : 0;
    
    if (dirX === 0 && dirZ === 0) return;
    
    // Find chunks ahead that aren't cached
    const chunksToFetch = [];
    
    for (let ahead = 1; ahead <= lookAheadChunks; ahead++) {
      const targetChunkX = playerChunkX + dirX * ahead;
      const targetChunkZ = playerChunkZ + dirZ * ahead;
      
      // Check surrounding chunks at that distance too
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const checkX = targetChunkX + dx;
          const checkZ = targetChunkZ + dz;
          const key = `${checkX},${checkZ}`;
          
          if (!this.chunkKeyCache.has(key)) {
            // Find chunk ref
            const chunkRef = allChunkRefs.find(c => c.chunkX === checkX && c.chunkZ === checkZ);
            if (chunkRef && !chunksToFetch.some(c => c.chunkX === checkX && c.chunkZ === checkZ)) {
              chunksToFetch.push(chunkRef);
            }
          }
        }
      }
    }
    
    if (chunksToFetch.length === 0) return;
    
    // Start async prefetch
    this.prefetchInProgress = true;
    
    this.buildCollision(chunksToFetch, filterMinY, filterMaxY)
      .then(({ collisionData }) => {
        // Group by chunk and cache
        const chunkBuckets = new Map();
        
        for (let i = 0; i < collisionData.length; i += 3) {
          const x = collisionData[i];
          const z = collisionData[i + 2];
          const chunkX = Math.floor(x / 16);
          const chunkZ = Math.floor(z / 16);
          const chunkKey = `${chunkX},${chunkZ}`;
          
          if (!chunkBuckets.has(chunkKey)) {
            chunkBuckets.set(chunkKey, []);
          }
          chunkBuckets.get(chunkKey).push(collisionData[i], collisionData[i + 1], collisionData[i + 2]);
        }
        
        for (const [chunkKey, blocks] of chunkBuckets) {
          this.cacheChunkCollision(chunkKey, new Int32Array(blocks));
        }
        
        // Mark empty chunks as cached too
        for (const chunk of chunksToFetch) {
          const key = `${chunk.chunkX},${chunk.chunkZ}`;
          if (!this.chunkKeyCache.has(key)) {
            this.cacheChunkCollision(key, new Int32Array(0));
          }
        }
        
        console.log(`Prefetched ${chunksToFetch.length} chunks`);
      })
      .catch(e => console.warn('Prefetch failed:', e))
      .finally(() => {
        this.prefetchInProgress = false;
      });
  }

  /**
   * Clear the chunk collision cache
   */
  clearCache() {
    this.chunkCollisionCache.clear();
    this.chunkKeyCache.clear();
    this.activeChunks.clear();
    this.cachedMinY = null;
    this.cachedMaxY = null;
  }

  /**
   * Terminate the worker
   */
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isInitialized = false;
    this.pendingTasks.clear();
    this.clearCache();
  }
}

// Singleton instance
let instance = null;

export function getCollisionWorkerManager() {
  if (!instance) {
    instance = new CollisionWorkerManager();
  }
  return instance;
}

export { CollisionWorkerManager, CollisionSet, ChunkedCollisionSet, packCoord };
