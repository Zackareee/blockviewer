/**
 * ChunkStreamer - Player-centric chunk loading system
 * 
 * Features:
 * - Loads chunks closest to player first (distance-based priority)
 * - Lazy loads distant chunks for seamless exploration
 * - Caches region data to avoid re-parsing
 * - Unloads distant chunks to save memory
 * - Integrates with existing ChunkManager for rendering
 * 
 * Performance Optimizations (Minecraft-style):
 * - Load distance > Render distance: Pre-load chunks beyond view for instant visibility toggle
 * - Predictive loading: Prioritize chunks in front of player based on view direction
 * - Visibility culling: Hide loaded chunks beyond render distance (cheap to show later)
 * 
 * Architecture:
 * - Region data is cached once parsed
 * - Individual chunks are extracted and meshed on-demand
 * - Chunk meshes are managed independently for efficient add/remove
 * - Priority queue ensures nearest/forward chunks load first
 */

import * as THREE from 'three';
import { BinaryGrid } from '../mesh/BinaryGrid.js';
import { BlockStateGrid } from '../mesh/BlockStateGrid.js';
import { getBlockRegistry } from '../mesh/BlockRegistry.js';
import { decodeChunk, extractActiveBeacons, extractEntities } from '../mesh/ChunkDecoder.js';
import { buildGridMeshes } from '../mesh/FastMesher.js';
import { buildModelMeshesWithInstancing } from '../mesh/ModelMesher.js';
import { getStateRegistry } from '../assets/StateRegistry.js';
import { LightGrid } from '../mesh/LightGrid.js';
import { propagateSkyLight } from '../mesh/LightPropagator.js';
import { propagateBlockLight } from '../mesh/BlockLightPropagator.js';
import { RegionMeshBuilder } from '../mesh/RegionMeshBuilder.js';
import { parseNBTRaw } from '../utils/nbtParser.js';
import pako from 'pako';
import { SuperChunkManager } from './SuperChunkManager.js';
import { 
  isUnifiedPipelineReady, 
  initBlockRegistry,
} from '../mesh/wasm/WasmMesher.js';
import { chunkLoadLogger } from '../utils/ChunkLoadLogger.js';

// Chunk size in blocks (Minecraft standard)
const CHUNK_SIZE = 16;
const REGION_SIZE = 32; // 32x32 chunks per region
const SECTOR_SIZE = 4096;

// Loading configuration - tuned for smooth camera movement
// Smaller batches = less frame drops, slower loading
// Larger batches = faster loading, more frame drops
const DEFAULT_CONCURRENT_CHUNKS = 1; // Default: 1 chunk at a time for smoothest experience
const DEFAULT_LOAD_BATCH_SIZE = 4; // How many chunks to queue per frame
const UNLOAD_HYSTERESIS = 2; // Extra chunks beyond unload distance before removal

// Priority weights (lower = higher priority)
const PRIORITY_IMMEDIATE = 0; // Within view distance
const PRIORITY_LAZY = 10000; // Beyond view but pre-loading (scaled for distSq)

// Predictive loading configuration (Minecraft-style)
// Priority uses Euclidean distance squared, so at distance 8 chunks, distSq = 64
// These bonuses create front-to-back loading order based on view direction
const FORWARD_PRIORITY_BONUS = -20; // Bonus for chunks directly in front of player
const SIDE_PRIORITY_PENALTY = 5; // Penalty for chunks to the side  
const BEHIND_PRIORITY_PENALTY = 15; // Penalty for chunks behind player

// Load distance buffer (chunks beyond render distance to pre-load)
// Minecraft typically loads ~2-3 chunks beyond render distance
const DEFAULT_LOAD_BUFFER = 2;


/**
 * Simple min-heap priority queue for chunk loading
 */
class ChunkPriorityQueue {
  constructor() {
    this.heap = [];
    this.chunkSet = new Set(); // Fast lookup for duplicates
  }

  push(item) {
    const key = `${item.chunkX},${item.chunkZ}`;
    if (this.chunkSet.has(key)) return; // Skip duplicates
    
    this.chunkSet.add(key);
    this.heap.push(item);
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return null;
    
    const top = this.heap[0];
    const key = `${top.chunkX},${top.chunkZ}`;
    this.chunkSet.delete(key);
    
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._bubbleDown(0);
    }
    
    return top;
  }

  peek() {
    return this.heap[0] || null;
  }

  remove(chunkX, chunkZ) {
    const key = `${chunkX},${chunkZ}`;
    if (!this.chunkSet.has(key)) return;
    
    const idx = this.heap.findIndex(i => i.chunkX === chunkX && i.chunkZ === chunkZ);
    if (idx >= 0) {
      const last = this.heap.pop();
      if (idx < this.heap.length) {
        this.heap[idx] = last;
        this._bubbleDown(idx);
        this._bubbleUp(idx);
      }
      this.chunkSet.delete(key);
    }
  }

  has(chunkX, chunkZ) {
    return this.chunkSet.has(`${chunkX},${chunkZ}`);
  }

  clear() {
    this.heap = [];
    this.chunkSet.clear();
  }

  get size() {
    return this.heap.length;
  }

  _bubbleUp(idx) {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.heap[idx].priority >= this.heap[parent].priority) break;
      [this.heap[idx], this.heap[parent]] = [this.heap[parent], this.heap[idx]];
      idx = parent;
    }
  }

  _bubbleDown(idx) {
    while (true) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let smallest = idx;
      
      if (left < this.heap.length && this.heap[left].priority < this.heap[smallest].priority) {
        smallest = left;
      }
      if (right < this.heap.length && this.heap[right].priority < this.heap[smallest].priority) {
        smallest = right;
      }
      
      if (smallest === idx) break;
      [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
      idx = smallest;
    }
  }
}

/**
 * Cached region data for fast chunk extraction
 */
class RegionCache {
  constructor(maxSize = 8) { // Reduced from 32 to 8 for better memory management
    this.cache = new Map(); // regionKey -> { buffer, chunks, lastAccess, regionX, regionZ }
    this.maxSize = maxSize;
  }

  getKey(regionX, regionZ) {
    return `${regionX},${regionZ}`;
  }

  has(regionX, regionZ) {
    return this.cache.has(this.getKey(regionX, regionZ));
  }

  get(regionX, regionZ) {
    const key = this.getKey(regionX, regionZ);
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccess = performance.now();
      return entry;
    }
    return null;
  }

  set(regionX, regionZ, buffer, chunks) {
    const key = this.getKey(regionX, regionZ);
    
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      let oldest = null;
      let oldestKey = null;
      for (const [k, v] of this.cache) {
        if (!oldest || v.lastAccess < oldest.lastAccess) {
          oldest = v;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    
    this.cache.set(key, {
      buffer,
      chunks,
      regionX,
      regionZ,
      lastAccess: performance.now(),
    });
  }

  /**
   * Evict regions that are too far from the player
   * @param {number} playerRegionX - Player's current region X
   * @param {number} playerRegionZ - Player's current region Z
   * @param {number} maxDistance - Max region distance to keep (default 2 = ~1024 blocks)
   */
  evictDistant(playerRegionX, playerRegionZ, maxDistance = 2) {
    const toEvict = [];
    
    for (const [key, entry] of this.cache) {
      const dx = entry.regionX - playerRegionX;
      const dz = entry.regionZ - playerRegionZ;
      const dist = Math.max(Math.abs(dx), Math.abs(dz)); // Chebyshev distance
      
      if (dist > maxDistance) {
        toEvict.push(key);
      }
    }
    
    for (const key of toEvict) {
      this.cache.delete(key);
    }
    
    return toEvict.length;
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * ChunkStreamer class
 */
export class ChunkStreamer {
  constructor(chunkManager, options = {}) {
    this.chunkManager = chunkManager;
    this.scene = chunkManager.scene;
    
    // Configuration - Minecraft-style render vs load distance
    // renderDistance: chunks that are visible (render distance setting)
    // loadDistance: chunks that are loaded/meshed (render + buffer for instant show)
    const baseRenderDistance = options.renderDistance || options.loadDistance || 8;
    this.renderDistance = baseRenderDistance; // Visible chunks
    this.loadDistance = baseRenderDistance + (options.loadBuffer || DEFAULT_LOAD_BUFFER); // Pre-loaded chunks
    this.unloadDistance = this.loadDistance + 1; // Distance to start unloading
    this.enableModelMeshes = options.enableModelMeshes !== false;
    
    // Loading performance settings - tune for smooth vs fast loading
    // concurrentChunks: higher = faster loading, may cause minor frame drops during load
    // Note: Chunk loading happens in parallel, but meshing is still throttled to avoid frame drops
    this.concurrentChunks = options.concurrentChunks ?? DEFAULT_CONCURRENT_CHUNKS;
    this.loadBatchSize = options.loadBatchSize ?? DEFAULT_LOAD_BATCH_SIZE;
    
    // Track if distances changed for dynamic updates
    this._pendingDistanceUpdate = false;
    
    // Callbacks
    this.onChunkLoaded = options.onChunkLoaded || null;
    this.onChunkUnloaded = options.onChunkUnloaded || null;
    this.onProgress = options.onProgress || null;
    this.onBiomeChange = options.onBiomeChange || null; // Called when player enters new biome
    
    // Current biome tracking
    this.currentBiome = null;
    this.lastBiomeCheckY = 0; // Last Y position for biome check
    
    // State
    this.playerChunkX = 0;
    this.playerChunkZ = 0;
    this.regionCache = new RegionCache();
    this.loadQueue = new ChunkPriorityQueue();
    this.loadedChunks = new Map(); // chunkKey -> { meshes, data, visible }
    this.loadingChunks = new Set(); // Currently processing
    this.queueGeneration = 0; // Incremented when queue is re-prioritized
    this.regionFiles = new Map(); // regionKey -> File
    this.parsedChunks = new Map(); // chunkKey -> parsed chunk data (for single-region mode)
    this.usePreParsedChunks = false; // Whether to use pre-parsed chunks instead of region files
    
    // Player direction tracking for predictive loading
    // Yaw is in radians: 0 = +Z (south), PI/2 = -X (west), PI = -Z (north), -PI/2 = +X (east)
    this.playerYaw = 0; // Player's look direction (radians)
    this.playerViewDirX = 0; // Normalized view direction X (-1 to 1)
    this.playerViewDirZ = 1; // Normalized view direction Z (-1 to 1)
    this.playerVelocityX = 0; // Movement velocity for prediction
    this.playerVelocityZ = 0;
    this.lastPlayerX = 0; // For velocity calculation
    this.lastPlayerZ = 0;
    this.lastPositionTime = 0;
    
    // Processing state
    this.isProcessing = false;
    this.initialLoadComplete = false; // Only show progress during initial load
    this.registry = getBlockRegistry();
    
    // Settings to apply when SuperChunkManager is created
    this._pendingEnableDirtyRebuild = true; // Default to enabled
    this.stateRegistry = null;
    
    // Pause flag for manual control
    this.isPaused = false;
    
    // Stats
    this.stats = {
      totalChunksLoaded: 0,
      totalChunksUnloaded: 0,
      queueSize: 0,
      cacheHits: 0,
      cacheMisses: 0,
      hiddenChunks: 0, // Chunks loaded but not visible
    };

    // Mesh builder (reused for all chunks)
    this.meshBuilder = new RegionMeshBuilder({
      textureIndexLookup: chunkManager.getTextureIndexLookup?.() || null,
    });
    
    // Super-chunk manager for batched meshing (initialized lazily after stateRegistry is ready)
    this.superChunkManager = null;
  }

  /**
   * Register region files for streaming
   * @param {Array} regions - Array of { file, regionX, regionZ }
   */
  async setRegions(regions) {
    this.regionFiles.clear();
    this.parsedChunks.clear();
    this.usePreParsedChunks = false;
    
    for (const region of regions) {
      const key = `${region.regionX},${region.regionZ}`;
      this.regionFiles.set(key, region);
    }
    
    // Initialize state registry if needed for model meshes (slabs, stairs, etc.)
    if (this.enableModelMeshes && !this.stateRegistry) {
      this.stateRegistry = getStateRegistry();
      await this.stateRegistry.init();
    }
    
    // Initialize super-chunk manager
    this._initSuperChunkManager();
    
    // Initialize WASM mesher for high-performance meshing (async, non-blocking)
    // Store the promise so region parsing can optionally wait for it
    this._wasmInitPromise = this.initializeWasm().catch(err => {
      console.warn('[ChunkStreamer] WASM init failed, using JS fallback:', err);
    });
    
    // Initialize SuperChunkWorkerPool AFTER WASM init completes
    // This ensures model geometry is pre-registered and can be sent to workers
    this._superChunkWorkerPoolPromise = this._wasmInitPromise.then(() => {
      return this.initializeSuperChunkWorkerPool();
    }).catch(err => {
      console.warn('[ChunkStreamer] SuperChunkWorkerPool init failed, using WASM/JS fallback:', err);
    });
    
    // Initialize worker pool for parallel meshing (async, non-blocking)
    // This will speed up meshing once initialized
    this.initializeWorkerPool().catch(err => {
      console.warn('[ChunkStreamer] Worker pool init failed, using main thread:', err);
    });
  }

  /**
   * Update streaming distances (called when user changes settings)
   * @param {number} renderDistance - New render distance in chunks
   * @param {number} loadBuffer - Optional buffer beyond render distance (default: 2)
   */
  setRenderDistance(renderDistance, loadBuffer = DEFAULT_LOAD_BUFFER) {
    const oldRender = this.renderDistance;
    const oldLoad = this.loadDistance;
    
    this.renderDistance = renderDistance;
    this.loadDistance = renderDistance + loadBuffer;
    this.unloadDistance = this.loadDistance + 1;
    
    // Update visibility for existing chunks
    this._updateChunkVisibility();
    
    // If load distance decreased, unload distant chunks
    if (this.loadDistance < oldLoad) {
      this._unloadDistantChunks();
    }
    
    // If load distance increased, queue new chunks
    if (this.loadDistance > oldLoad) {
      this._queueChunksAroundPlayer();
      if (!this.isProcessing) {
        this._processQueue();
      }
    }
  }

  /**
   * Legacy method for backwards compatibility
   * @param {number} loadDistance - New load distance in chunks
   */
  setLoadDistance(loadDistance) {
    // Treat as render distance with default buffer
    this.setRenderDistance(loadDistance, DEFAULT_LOAD_BUFFER);
  }

  /**
   * Set chunk loading concurrency (advanced performance tuning)
   * @param {number} concurrency - Number of chunks to process simultaneously (1-8)
   *   1 = smoothest camera movement, slowest loading
   *   4 = balanced
   *   8 = fastest loading, may cause frame drops
   */
  setConcurrentChunks(concurrency) {
    this.concurrentChunks = Math.max(1, Math.min(8, concurrency));
    console.log(`[ChunkStreamer] Concurrent chunks set to ${this.concurrentChunks}`);
  }
  
  /**
   * Get current chunk loading concurrency
   * @returns {number} Current concurrency setting
   */
  getConcurrentChunks() {
    return this.concurrentChunks;
  }
  
  /**
   * Set the meshing speed (super-chunks per idle callback)
   * Higher = faster chunk appearance, may cause frame drops
   * @param {number} speed - 1-4
   */
  setMeshingSpeed(speed) {
    if (this.superChunkManager) {
      this.superChunkManager.setMeshingSpeed(speed);
    }
  }
  
  /**
   * Enable or disable automatic dirty chunk rebuilding
   * When disabled, chunks won't be rebuilt when boundaries change (useful for debugging)
   * @param {boolean} enabled - Whether to enable dirty rebuild
   */
  setEnableDirtyRebuild(enabled) {
    // Store the setting in case SuperChunkManager isn't created yet
    this._pendingEnableDirtyRebuild = enabled;
    
    // Apply immediately if SuperChunkManager exists
    if (this.superChunkManager) {
      this.superChunkManager.setEnableDirtyRebuild(enabled);
    }
  }

  /**
   * Set pre-parsed chunks for streaming (single region mode)
   * @param {Array} chunks - Array of parsed chunk objects with { x, z, data }
   */
  async setParsedChunks(chunks) {
    this.regionFiles.clear();
    this.parsedChunks.clear();
    this.usePreParsedChunks = true;
    
    // Store chunks by their world coordinates
    for (const chunk of chunks) {
      const key = `${chunk.x},${chunk.z}`;
      this.parsedChunks.set(key, chunk);
    }
    
    // Initialize state registry if needed for model meshes (slabs, stairs, etc.)
    if (this.enableModelMeshes && !this.stateRegistry) {
      this.stateRegistry = getStateRegistry();
      await this.stateRegistry.init();
    }
    
    // Initialize super-chunk manager
    this._initSuperChunkManager();
    
    // Initialize worker pool for parallel meshing (async, non-blocking)
    this.initializeWorkerPool().catch(err => {
      console.warn('[ChunkStreamer] Worker pool init failed, using main thread:', err);
    });
  }

  /**
   * Initialize super-chunk manager (called after stateRegistry is ready)
   */
  _initSuperChunkManager() {
    if (this.superChunkManager) return;
    
    this.superChunkManager = new SuperChunkManager(this.chunkManager, {
      registry: this.registry,
      stateRegistry: this.stateRegistry,
      enableModelMeshes: this.enableModelMeshes,
      useWorkers: true, // Enable worker-based meshing
      onSuperChunkRebuilt: () => {
        this.chunkManager.invalidate?.();
      }
    });
    
    // Apply any pending settings that were set before SuperChunkManager was created
    if (this._pendingEnableDirtyRebuild !== undefined) {
      this.superChunkManager.setEnableDirtyRebuild(this._pendingEnableDirtyRebuild);
    }
    
    // Set up mesh queue processor for per-frame mesh creation
    // This spreads mesh creation across frames to avoid lag spikes
    // Also processes completed worker results (super-chunk mesh creation)
    // Camera position is passed for movement-aware budgeting (reduces work during fast camera movement)
    this.chunkManager.setMeshQueueProcessor((camX, camY, camZ, quaternion) => {
      // Update camera position AND rotation for movement-aware mesh queue budgeting
      // This automatically reduces budget during fast camera movement OR rotation for smoother frame rates
      if (camX !== undefined) {
        this.superChunkManager.updateCameraPosition(camX, camY, camZ, quaternion);
      }
      
      // Process completion queue (creates meshes for completed super-chunks)
      // This is async but we don't await - fires in background per frame
      this.superChunkManager.processCompletedChunks();
      
      // Process individual mesh queue
      return this.superChunkManager.processQueuedMeshes();
    });
  }

  /**
   * Initialize WASM mesher for high-performance meshing
   * Call this before loading chunks for best performance
   */
  async initializeWasm() {
    if (!this.superChunkManager) {
      console.warn('[ChunkStreamer] SuperChunkManager not initialized yet');
      return false;
    }
    
    try {
      const success = await this.superChunkManager.initializeWasm();
      if (success) {
        console.log('[ChunkStreamer] ✅ WASM mesher initialized - using high-performance mode');
        
        // Clear the reinit pending flag - lookup tables are now current
        this._wasmReinitPending = false;
        
        // Initialize block registry for unified pipeline (NBT parsing in WASM)
        if (this.registry && initBlockRegistry(this.registry)) {
          console.log('[ChunkStreamer] ✅ Block registry initialized - unified pipeline ready');
          
          // Model meshing uses JS StateRegistry for full state resolution
          // WASM handles greedy meshing (solid/fluid/glass), JS handles models
          console.log('[ChunkStreamer] ✅ Unified pipeline ready - WASM greedy + JS model meshing');
          
          // Clear region cache so next loads use the unified pipeline
          // This ensures chunks are parsed with raw compressed data
          if (this.regionCache) {
            const cacheSize = this.regionCache.cache?.size || 0;
            this.regionCache.clear();
            console.log(`[ChunkStreamer] Cleared ${cacheSize} cached regions to enable unified pipeline`);
          }
        }
      } else {
        console.log('[ChunkStreamer] WASM not available - using JavaScript mesher');
        this._wasmReinitPending = false; // Clear flag even on failure
      }
      return success;
    } catch (error) {
      console.error('[ChunkStreamer] Failed to initialize WASM:', error);
      this._wasmReinitPending = false; // Clear flag on error
      return false;
    }
  }

  /**
   * Initialize the SuperChunkWorkerPool for fully off-thread processing
   * This is the most efficient mode - enables 4+ chunks/sec without FPS drops
   */
  async initializeSuperChunkWorkerPool() {
    if (!this.superChunkManager) {
      console.warn('[ChunkStreamer] SuperChunkManager not initialized yet');
      return false;
    }
    
    try {
      const success = await this.superChunkManager.initializeSuperChunkWorkerPool();
      if (success) {
        console.log('[ChunkStreamer] ✅ SuperChunkWorkerPool initialized - maximum performance mode');
      }
      return success;
    } catch (error) {
      console.error('[ChunkStreamer] Failed to initialize SuperChunkWorkerPool:', error);
      return false;
    }
  }

  /**
   * Initialize the worker pool for parallel meshing
   * Call this before loading chunks for best performance
   */
  async initializeWorkerPool() {
    if (!this.superChunkManager) {
      console.warn('[ChunkStreamer] SuperChunkManager not initialized yet');
      return false;
    }
    
    try {
      await this.superChunkManager.initializeWorkerPool();
      console.log('[ChunkStreamer] Worker pool initialized successfully');
      return true;
    } catch (error) {
      console.error('[ChunkStreamer] Failed to initialize worker pool:', error);
      return false;
    }
  }

  /**
   * Update player position and trigger chunk loading/unloading
   * Also tracks velocity for predictive loading
   * @param {number} worldX - Player world X position
   * @param {number} worldZ - Player world Z position
   * @param {number} yaw - Optional player yaw in radians (view direction)
   */
  updatePlayerPosition(worldX, worldZ, yaw = null) {
    const chunkX = Math.floor(worldX / CHUNK_SIZE);
    const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
    
    // Track velocity for predictive loading
    const now = performance.now();
    const dt = (now - this.lastPositionTime) / 1000; // seconds
    if (dt > 0 && dt < 1 && this.lastPositionTime > 0) {
      // Smooth velocity calculation (exponential moving average)
      const vx = (worldX - this.lastPlayerX) / dt;
      const vz = (worldZ - this.lastPlayerZ) / dt;
      this.playerVelocityX = this.playerVelocityX * 0.7 + vx * 0.3;
      this.playerVelocityZ = this.playerVelocityZ * 0.7 + vz * 0.3;
    }
    this.lastPlayerX = worldX;
    this.lastPlayerZ = worldZ;
    this.lastPositionTime = now;
    
    // Update yaw if provided
    if (yaw !== null) {
      this.updatePlayerDirection(yaw);
    }
    
    // Only update chunks if player moved to a new chunk
    if (chunkX === this.playerChunkX && chunkZ === this.playerChunkZ) {
      // Still update visibility even without chunk change
      this._updateChunkVisibility();
      return;
    }
    
    // Calculate movement delta for optimization
    const lastChunkX = this.playerChunkX;
    const lastChunkZ = this.playerChunkZ;
    
    this.playerChunkX = chunkX;
    this.playerChunkZ = chunkZ;
    
    // Update visibility for loaded chunks
    this._updateChunkVisibility();
    
    // OPTIMIZATION: Skip expensive queue/unload operations if all chunks are already loaded
    // When initial load is complete and we're just moving around in already-loaded area,
    // we can skip the O(loadDistance²) iteration since nothing will change
    const movedX = Math.abs(chunkX - lastChunkX);
    const movedZ = Math.abs(chunkZ - lastChunkZ);
    const movedOneChunk = movedX <= 1 && movedZ <= 1;
    const movedSignificantly = movedX >= 2 || movedZ >= 2;
    
    // Track if boundary check found new chunks (set by the optimization path below)
    let hasNewBoundaryChunks = false;
    
    if (this.initialLoadComplete && movedOneChunk && this.loadQueue.size === 0 && !this.isProcessing) {
      // Quick boundary check: only need to look at chunks on the new edge
      // This is O(loadDistance) instead of O(loadDistance²)
      if (!this._hasNewChunksOnBoundary(chunkX, chunkZ, lastChunkX, lastChunkZ)) {
        // No new chunks to load, skip the expensive operations
        return;
      }
      // Boundary check found new chunks - flag for queueing
      hasNewBoundaryChunks = true;
    }
    
    // Always re-prioritize if player moved significantly (priorities are stale)
    // Or if there are chunks queued that need fresh priorities
    // Or if boundary check found new chunks to load
    const needsReprioritize = movedSignificantly || this.loadQueue.size > 0 || hasNewBoundaryChunks;
    
    // Queue chunks for loading (clears and re-adds with fresh priorities)
    if (needsReprioritize || !this.initialLoadComplete) {
      this._queueChunksAroundPlayer();
    }
    
    // Unload distant chunks
    this._unloadDistantChunks();
    
    // Start processing if not already
    if (!this.isProcessing) {
      this._processQueue();
    }
  }

  /**
   * Update player position with full 3D coordinates for biome detection
   * Call this when camera moves to detect biome changes (for sky/fog color)
   * @param {number} worldX - Player world X position
   * @param {number} worldY - Player world Y position
   * @param {number} worldZ - Player world Z position
   */
  updatePlayerPosition3D(worldX, worldY, worldZ) {
    // Update chunk loading (2D)
    this.updatePlayerPosition(worldX, worldZ);
    
    // Check biome at current position (throttled - only if moved significantly in Y)
    const yDelta = Math.abs(worldY - this.lastBiomeCheckY);
    const chunkChanged = this.playerChunkX !== Math.floor(this.lastPlayerX / CHUNK_SIZE) ||
                         this.playerChunkZ !== Math.floor(this.lastPlayerZ / CHUNK_SIZE);
    
    // Check biome if moved to new chunk or moved 8+ blocks vertically (2 biome cells)
    if (chunkChanged || yDelta >= 8) {
      this.lastBiomeCheckY = worldY;
      const biome = this.getBiomeAtPosition(worldX, worldY, worldZ);
      
      if (biome && biome !== this.currentBiome) {
        const oldBiome = this.currentBiome;
        this.currentBiome = biome;
        
        // Notify listeners of biome change
        if (this.onBiomeChange) {
          // Strip minecraft: prefix for simpler handling
          const shortBiome = biome.replace('minecraft:', '');
          this.onBiomeChange(shortBiome, oldBiome?.replace('minecraft:', '') || null);
        }
      }
    }
  }

  /**
   * Update player look direction for predictive chunk loading
   * Minecraft-style: prioritize chunks in front of the player
   * @param {number} yaw - Player yaw in radians (0 = +Z, PI/2 = -X, PI = -Z, -PI/2 = +X)
   */
  updatePlayerDirection(yaw) {
    this.playerYaw = yaw;
    // Convert yaw to normalized direction vector
    // Minecraft: yaw 0 = +Z (south), increases counterclockwise when viewed from above
    this.playerViewDirX = -Math.sin(yaw);
    this.playerViewDirZ = Math.cos(yaw);
  }

  /**
   * Update visibility of loaded chunks based on render distance
   * Chunks beyond renderDistance but within loadDistance are hidden (mesh.visible = false)
   * This is much cheaper than loading/unloading chunks
   */
  _updateChunkVisibility() {
    const { playerChunkX, playerChunkZ, renderDistance } = this;
    let hiddenCount = 0;
    
    // Update visibility of super-chunks
    if (this.superChunkManager) {
      for (const [key, superChunk] of this.superChunkManager.superChunks) {
        // Calculate distance from player to super-chunk center
        const centerChunkX = superChunk.superX * 2 + 0.5; // Super-chunk is 2x2 chunks
        const centerChunkZ = superChunk.superZ * 2 + 0.5;
        const dx = centerChunkX - playerChunkX;
        const dz = centerChunkZ - playerChunkZ;
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        
        // Should this super-chunk be visible?
        const shouldBeVisible = dist <= renderDistance + 1; // +1 for super-chunk size
        
        // Update mesh visibility
        for (const mesh of superChunk.meshes) {
          if (mesh.visible !== shouldBeVisible) {
            mesh.visible = shouldBeVisible;
            if (!shouldBeVisible) hiddenCount++;
          }
        }
      }
    }
    
    this.stats.hiddenChunks = hiddenCount;
  }


  /**
   * Force initial load of chunks around a position
   * @param {number} worldX - Center X position
   * @param {number} worldZ - Center Z position
   */
  async loadAroundPosition(worldX, worldZ) {
    this.playerChunkX = Math.floor(worldX / CHUNK_SIZE);
    this.playerChunkZ = Math.floor(worldZ / CHUNK_SIZE);
    
    // Queue chunks with immediate priority
    this._queueChunksAroundPlayer(true);
    
    // Process until all immediate chunks are loaded
    return this._processQueueUntilComplete();
  }

  /**
   * Get the surface height at world coordinates (highest non-air block + 1)
   * Uses Minecraft's MOTION_BLOCKING logic: finds highest solid/fluid block
   * @param {number} worldX - World X coordinate
   * @param {number} worldZ - World Z coordinate
   * @returns {number} Surface Y coordinate (player spawn height), or 64 if not found
   */
  getSurfaceHeight(worldX, worldZ) {
    if (!this.superChunkManager) {
      console.warn('[ChunkStreamer] getSurfaceHeight: SuperChunkManager not ready');
      return 64;
    }
    
    const chunkX = Math.floor(worldX / CHUNK_SIZE);
    const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
    const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localZ = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    // Get the super-chunk containing this chunk
    const superChunkKey = this.superChunkManager.getSuperChunkKey(chunkX, chunkZ);
    const superChunk = this.superChunkManager.superChunks.get(superChunkKey);
    
    if (!superChunk) {
      console.warn(`[ChunkStreamer] getSurfaceHeight: No super-chunk at ${chunkX}, ${chunkZ}`);
      return 64;
    }
    
    // Get chunk data from super-chunk
    const localKey = superChunk.getLocalKey(chunkX, chunkZ);
    const chunkEntry = superChunk.loadedChunks.get(localKey);
    
    if (!chunkEntry || !chunkEntry.data) {
      console.warn(`[ChunkStreamer] getSurfaceHeight: No chunk data at ${chunkX}, ${chunkZ}`);
      return 64;
    }
    
    // Parse chunk data to find surface height
    try {
      let chunkData = chunkEntry.data;
      
      // Decompress if needed
      if (chunkEntry.isRawCompressed && chunkData.compressedData) {
        const compressed = new Uint8Array(chunkData.compressedData);
        // Use gzip for type 1, zlib/inflate for type 2
        const decompressed = chunkData.compressionType === 1 
          ? pako.ungzip(compressed)
          : pako.inflate(compressed);
        chunkData = parseNBTRaw(decompressed.buffer).value;
      }
      
      // Get sections from chunk data
      const sections = chunkData.sections || chunkData.Level?.Sections || [];
      if (!sections || sections.length === 0) {
        return 64;
      }
      
      // Sort sections by Y (highest first) to scan from top down
      const sortedSections = [...sections].sort((a, b) => (b.Y ?? b.y ?? 0) - (a.Y ?? a.y ?? 0));
      
      // Scan from top to bottom for first non-air block
      for (const section of sortedSections) {
        const sectionY = section.Y ?? section.y ?? 0;
        const baseY = sectionY * 16;
        
        // Get block palette and data
        const blockStates = section.block_states || section;
        const palette = blockStates.palette || blockStates.Palette;
        const data = blockStates.data || blockStates.BlockStates;
        
        if (!palette || palette.length === 0) continue;
        
        // Check if section is all air (single-entry palette with air)
        if (palette.length === 1) {
          const blockName = palette[0].Name || palette[0];
          if (this._isAirBlock(blockName)) continue;
        }
        
        // Calculate bits per block
        const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
        
        // Scan this section from top to bottom at our column
        for (let localY = 15; localY >= 0; localY--) {
          const worldY = baseY + localY;
          
          // Get block index
          const blockIndex = localY * 256 + localZ * 16 + localX;
          let paletteIndex = 0;
          
          if (data && data.length > 0) {
            // Unpack from long array
            const blocksPerLong = Math.floor(64 / bitsPerBlock);
            const longIndex = Math.floor(blockIndex / blocksPerLong);
            const bitOffset = (blockIndex % blocksPerLong) * bitsPerBlock;
            
            if (longIndex < data.length) {
              const longValue = data[longIndex];
              // Handle both BigInt and number
              if (typeof longValue === 'bigint') {
                paletteIndex = Number((longValue >> BigInt(bitOffset)) & BigInt((1 << bitsPerBlock) - 1));
              } else {
                // For regular numbers, need to handle 64-bit unpacking carefully
                paletteIndex = (longValue >>> bitOffset) & ((1 << bitsPerBlock) - 1);
              }
            }
          }
          
          // Check if this is a solid block
          if (paletteIndex < palette.length) {
            const entry = palette[paletteIndex];
            const blockName = entry.Name || entry;
            
            if (!this._isAirBlock(blockName) && !this._isTransparentNonSolid(blockName)) {
              // Found surface! Return Y + 1 (standing on top of block)
              console.log(`[ChunkStreamer] Surface height at (${worldX}, ${worldZ}): ${worldY + 1} (${blockName})`);
              return worldY + 1;
            }
          }
        }
      }
      
      // No surface found, return sea level
      return 64;
    } catch (e) {
      console.error('[ChunkStreamer] getSurfaceHeight error:', e);
      return 64;
    }
  }
  
  /**
   * Check if a block name represents air
   */
  _isAirBlock(name) {
    if (!name) return true;
    const n = name.replace('minecraft:', '');
    return n === 'air' || n === 'cave_air' || n === 'void_air';
  }
  
  /**
   * Check if a block is transparent but not solid (shouldn't count as surface)
   * These are blocks you'd fall through
   */
  _isTransparentNonSolid(name) {
    if (!name) return true;
    const n = name.replace('minecraft:', '');
    // Blocks that don't count as surface for spawning
    const nonSolid = new Set([
      // Plants
      'grass', 'tall_grass', 'fern', 'large_fern',
      'dead_bush', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
      // Flowers
      'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
      'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 
      'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
      'sunflower', 'lilac', 'rose_bush', 'peony',
      // Other non-solid
      'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch',
      'redstone_torch', 'redstone_wall_torch',
      'sign', 'wall_sign', 'hanging_sign', 'wall_hanging_sign',
      'rail', 'powered_rail', 'detector_rail', 'activator_rail',
      'lever', 'button', 'pressure_plate',
      'redstone_wire', 'tripwire', 'tripwire_hook',
      'flower_pot', 'potted_', // All potted plants
      'fire', 'soul_fire',
      'cobweb', 'string',
    ]);
    return nonSolid.has(n) || n.startsWith('potted_') || n.endsWith('_sign') || n.endsWith('_button');
  }

  /**
   * Get the biome at a world position
   * Minecraft 1.18+ stores biomes as 4x4x4 cubes within each section (64 biomes per section)
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} worldZ - World Z coordinate
   * @returns {string|null} Biome ID (e.g., 'minecraft:plains', 'minecraft:soul_sand_valley') or null if not found
   */
  getBiomeAtPosition(worldX, worldY, worldZ) {
    if (!this.superChunkManager) {
      return null;
    }
    
    const chunkX = Math.floor(worldX / CHUNK_SIZE);
    const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
    
    // Get the super-chunk containing this chunk
    const superChunkKey = this.superChunkManager.getSuperChunkKey(chunkX, chunkZ);
    const superChunk = this.superChunkManager.superChunks.get(superChunkKey);
    
    if (!superChunk) {
      return null;
    }
    
    // Get chunk data from super-chunk
    const localKey = superChunk.getLocalKey(chunkX, chunkZ);
    const chunkEntry = superChunk.loadedChunks.get(localKey);
    
    if (!chunkEntry || !chunkEntry.data) {
      return null;
    }
    
    try {
      let chunkData = chunkEntry.data;
      
      // Decompress if needed
      if (chunkEntry.isRawCompressed && chunkData.compressedData) {
        const compressed = new Uint8Array(chunkData.compressedData);
        const decompressed = chunkData.compressionType === 1 
          ? pako.ungzip(compressed)
          : pako.inflate(compressed);
        chunkData = parseNBTRaw(decompressed.buffer).value;
      }
      
      // Get sections from chunk data
      const sections = chunkData.sections || chunkData.Level?.Sections || [];
      if (!sections || sections.length === 0) {
        return null;
      }
      
      // Find the section containing this Y level
      // Section Y is the section index (e.g., -4 for Y=-64 to -48, 0 for Y=0-15)
      const sectionY = Math.floor(worldY / 16);
      const section = sections.find(s => (s.Y ?? s.y) === sectionY);
      
      if (!section || !section.biomes) {
        // Try to find any section with biome data as fallback
        for (const s of sections) {
          if (s.biomes && s.biomes.palette && s.biomes.palette.length > 0) {
            // Return the first biome in the palette as a fallback
            return s.biomes.palette[0];
          }
        }
        return null;
      }
      
      const biomes = section.biomes;
      const palette = biomes.palette;
      
      if (!palette || palette.length === 0) {
        return null;
      }
      
      // Single biome for entire section
      if (palette.length === 1 || !biomes.data || biomes.data.length === 0) {
        return palette[0];
      }
      
      // Calculate biome index within section
      // Biomes are stored as 4x4x4 cubes, so divide by 4
      const localX = ((Math.floor(worldX) % 16) + 16) % 16;
      const localY = ((Math.floor(worldY) % 16) + 16) % 16;
      const localZ = ((Math.floor(worldZ) % 16) + 16) % 16;
      
      const biomeX = Math.floor(localX / 4);
      const biomeY = Math.floor(localY / 4);
      const biomeZ = Math.floor(localZ / 4);
      
      // 4x4x4 = 64 biome entries per section
      const biomeIndex = biomeY * 16 + biomeZ * 4 + biomeX;
      
      // Calculate bits per entry (minimum 1 bit, based on palette size)
      const bitsPerEntry = Math.max(1, Math.ceil(Math.log2(palette.length)));
      const entriesPerLong = Math.floor(64 / bitsPerEntry);
      const mask = (1 << bitsPerEntry) - 1;
      
      // Calculate which long and which bits contain our biome
      const longIndex = Math.floor(biomeIndex / entriesPerLong);
      const bitOffset = (biomeIndex % entriesPerLong) * bitsPerEntry;
      
      const data = biomes.data;
      if (longIndex >= data.length) {
        return palette[0]; // Fallback to first biome
      }
      
      let paletteIndex = 0;
      const longValue = data[longIndex];
      
      if (typeof longValue === 'bigint') {
        paletteIndex = Number((longValue >> BigInt(bitOffset)) & BigInt(mask));
      } else {
        paletteIndex = (longValue >>> bitOffset) & mask;
      }
      
      if (paletteIndex < palette.length) {
        return palette[paletteIndex];
      }
      
      return palette[0]; // Fallback
    } catch (e) {
      console.error('[ChunkStreamer] getBiomeAtPosition error:', e);
      return null;
    }
  }

  /**
   * Calculate priority adjustment based on chunk direction relative to player view
   * Minecraft-style predictive loading: chunks in front get priority
   * @param {number} dx - Chunk offset X from player
   * @param {number} dz - Chunk offset Z from player
   * @returns {number} Priority adjustment (negative = higher priority)
   */
  _getDirectionalPriorityBonus(dx, dz) {
    // Normalize the chunk direction
    const chunkDist = Math.sqrt(dx * dx + dz * dz);
    if (chunkDist < 0.5) return FORWARD_PRIORITY_BONUS; // Player's chunk gets max bonus
    
    const chunkDirX = dx / chunkDist;
    const chunkDirZ = dz / chunkDist;
    
    // Combine view direction with movement velocity for prediction
    // Weight view direction more than velocity (like Minecraft's camera-based loading)
    let predictDirX = this.playerViewDirX * 0.8;
    let predictDirZ = this.playerViewDirZ * 0.8;
    
    // Add velocity component if moving significantly
    const velMag = Math.sqrt(this.playerVelocityX ** 2 + this.playerVelocityZ ** 2);
    if (velMag > 2) { // Moving at least 2 blocks/sec
      const velNormX = this.playerVelocityX / velMag;
      const velNormZ = this.playerVelocityZ / velMag;
      predictDirX += velNormX * 0.2;
      predictDirZ += velNormZ * 0.2;
    }
    
    // Normalize prediction direction
    const predictMag = Math.sqrt(predictDirX ** 2 + predictDirZ ** 2);
    if (predictMag > 0.01) {
      predictDirX /= predictMag;
      predictDirZ /= predictMag;
    } else {
      return 0; // No direction preference
    }
    
    // Dot product: 1 = directly in front, 0 = perpendicular, -1 = behind
    const dot = chunkDirX * predictDirX + chunkDirZ * predictDirZ;
    
    // Map dot product to priority adjustment (Minecraft-style front-to-back)
    // Scale bonus by distance - closer chunks get smaller absolute adjustment
    // This ensures the closest chunk in front always loads before a farther chunk in front
    const distanceFactor = Math.min(chunkDist / 8, 1); // Normalize to 0-1 for distance up to 8
    
    if (dot > 0.5) {
      // In front: significant bonus (negative = higher priority)
      // Directly ahead (dot=1) gets full bonus, dot=0.5 gets half
      return FORWARD_PRIORITY_BONUS * dot * distanceFactor;
    } else if (dot > -0.3) {
      // Side: small penalty
      return SIDE_PRIORITY_PENALTY * (1 - dot) * distanceFactor;
    } else {
      // Behind: larger penalty (positive = lower priority)
      return BEHIND_PRIORITY_PENALTY * (1 - dot) * distanceFactor;
    }
  }

  /**
   * Queue chunks around player based on distance and view direction
   * Uses predictive loading to prioritize chunks the player is likely to see soon
   * @param {boolean} immediate - If true, all chunks get immediate priority
   */
  _queueChunksAroundPlayer(immediate = false) {
    const { playerChunkX, playerChunkZ, loadDistance, renderDistance, usePreParsedChunks } = this;
    
    // Reduce log noise during movement - uncomment for debugging
    // console.log(`[ChunkStreamer] Queueing chunks around ${playerChunkX},${playerChunkZ} (render=${renderDistance}, load=${loadDistance})`);
    
    // Clear existing queue and re-prioritize
    this.loadQueue.clear();
    this.queueGeneration++; // Signal that priorities have changed
    
    let queuedCount = 0;
    let skippedAlreadyLoaded = 0;
    let skippedNoRegion = 0;
    
    // Add chunks in spiral order for better visual loading
    for (let r = 0; r <= loadDistance; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          // Only process ring at distance r
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          
          const chunkX = playerChunkX + dx;
          const chunkZ = playerChunkZ + dz;
          const key = `${chunkX},${chunkZ}`;
          
          // Skip if already loaded or loading
          if (this.loadedChunks.has(key) || this.loadingChunks.has(key)) {
            skippedAlreadyLoaded++;
            continue;
          }
          
          // Check if chunk exists
          if (usePreParsedChunks) {
            // For pre-parsed chunks, check directly in the map
            if (!this.parsedChunks.has(key)) {
              skippedNoRegion++;
              continue;
            }
          } else {
            // For region files, check if the region exists
            const regionX = Math.floor(chunkX / REGION_SIZE);
            const regionZ = Math.floor(chunkZ / REGION_SIZE);
            const regionKey = `${regionX},${regionZ}`;
            
            if (!this.regionFiles.has(regionKey)) {
              skippedNoRegion++;
              continue;
            }
          }
          
          // Base priority is Euclidean distance squared (like Minecraft's distToCenterSqr)
          // This prioritizes chunks directly in front over diagonals
          const distSq = dx * dx + dz * dz;
          let priority = distSq;
          
          // Chunks within render distance get immediate priority
          // Chunks beyond render distance (pre-load buffer) get lazy priority
          if (r > renderDistance) {
            priority += PRIORITY_LAZY;
          }
          
          // Apply directional bonus for predictive loading (Minecraft-style)
          // Always apply when we have velocity data
          if (!immediate) {
            priority += this._getDirectionalPriorityBonus(dx, dz);
          }
          
          const regionX = Math.floor(chunkX / REGION_SIZE);
          const regionZ = Math.floor(chunkZ / REGION_SIZE);
          
          this.loadQueue.push({
            chunkX,
            chunkZ,
            regionX,
            regionZ,
            priority,
          });
          queuedCount++;
        }
      }
    }
    
    this.stats.queueSize = this.loadQueue.size;
    const peek = this.loadQueue.peek();
    // Debug: Queue result logging (uncomment if needed)
    // console.log(`[ChunkStreamer] Queue result: ${queuedCount} queued, ${skippedAlreadyLoaded} already loaded, ${skippedNoRegion} no region, top priority: ${peek?.priority?.toFixed(1) ?? 'N/A'}`);
  }

  /**
   * Quick check if there are any new chunks to load on the boundary we moved towards
   * O(loadDistance) instead of O(loadDistance²)
   * @param {number} newX - New chunk X
   * @param {number} newZ - New chunk Z
   * @param {number} oldX - Previous chunk X
   * @param {number} oldZ - Previous chunk Z
   * @returns {boolean} True if there are chunks to load
   */
  _hasNewChunksOnBoundary(newX, newZ, oldX, oldZ) {
    const { loadDistance, usePreParsedChunks } = this;
    const dxDir = newX - oldX;
    const dzDir = newZ - oldZ;
    
    // Check the new edge chunks based on movement direction
    for (let i = -loadDistance; i <= loadDistance; i++) {
      // Check X edge if moved in X direction
      if (dxDir !== 0) {
        const edgeX = newX + (dxDir > 0 ? loadDistance : -loadDistance);
        const key = `${edgeX},${newZ + i}`;
        if (!this.loadedChunks.has(key) && !this.loadingChunks.has(key)) {
          if (usePreParsedChunks) {
            if (this.parsedChunks.has(key)) return true;
          } else {
            const regionX = Math.floor(edgeX / 32);
            const regionZ = Math.floor((newZ + i) / 32);
            if (this.regionFiles.has(`${regionX},${regionZ}`)) return true;
          }
        }
      }
      
      // Check Z edge if moved in Z direction
      if (dzDir !== 0) {
        const edgeZ = newZ + (dzDir > 0 ? loadDistance : -loadDistance);
        const key = `${newX + i},${edgeZ}`;
        if (!this.loadedChunks.has(key) && !this.loadingChunks.has(key)) {
          if (usePreParsedChunks) {
            if (this.parsedChunks.has(key)) return true;
          } else {
            const regionX = Math.floor((newX + i) / 32);
            const regionZ = Math.floor(edgeZ / 32);
            if (this.regionFiles.has(`${regionX},${regionZ}`)) return true;
          }
        }
      }
    }
    
    return false;
  }

    /**
   * Unload chunks beyond unload distance
   */
  _unloadDistantChunks() {
    const { playerChunkX, playerChunkZ, unloadDistance } = this;
    // Hysteresis is already built into unloadDistance (loadDistance + 1)
    const unloadDist = unloadDistance;
    
    const toUnload = [];
    
    for (const [key, chunkData] of this.loadedChunks) {
      const [cx, cz] = key.split(',').map(Number);
      const dx = cx - playerChunkX;
      const dz = cz - playerChunkZ;
      // Use Chebyshev distance (same as Minecraft render distance)
      const dist = Math.max(Math.abs(dx), Math.abs(dz));
      
      if (dist > unloadDist) {
        toUnload.push({ key, chunkData, chunkX: cx, chunkZ: cz });
      }
    }
    
    for (const { key, chunkData, chunkX, chunkZ } of toUnload) {
      this._unloadChunk(key, chunkData, chunkX, chunkZ);
      this.stats.totalChunksUnloaded++;
      this.onChunkUnloaded?.(chunkX, chunkZ);
    }
    
    // Immediately repair boundary artifacts for remaining visible chunks
    // This fixes seams that appear when neighbor chunks are unloaded
    if (this.superChunkManager?.hasBoundaryDirtyChunks()) {
      // Don't await - let this run in background to avoid blocking camera
      this.superChunkManager.repairBoundaries(2).catch(() => {});
    }
    
    // Schedule idle rebuild for any remaining dirty chunks (non-blocking)
    if (this.superChunkManager?.hasDirtyChunks()) {
      this.superChunkManager.scheduleIdleRebuild();
    }
    
    // Also evict distant regions from cache to free memory
    // Player region is determined by chunk position
    const playerRegionX = Math.floor(playerChunkX / REGION_SIZE);
    const playerRegionZ = Math.floor(playerChunkZ / REGION_SIZE);
    this.regionCache.evictDistant(playerRegionX, playerRegionZ);
  }

  /**
   * Remove a chunk from the scene and SuperChunkManager
   */
  _unloadChunk(key, chunkData, chunkX, chunkZ) {
    // Remove from super-chunk manager (this marks the super-chunk dirty)
    if (this.superChunkManager && chunkX !== undefined && chunkZ !== undefined) {
      this.superChunkManager.removeChunk(chunkX, chunkZ);
    }
    
    // Remove any particle emitters for this chunk
    const emitterManager = this.chunkManager.particleEmitterManager;
    if (emitterManager && chunkX !== undefined && chunkZ !== undefined) {
      emitterManager.removeEmittersInChunk?.(chunkX, chunkZ);
    }
    
    this.loadedChunks.delete(key);
  }

  /**
   * Process the load queue asynchronously
   * Uses batched processing with yields to maintain responsiveness
   * Pauses during fast camera movement to prioritize smooth frame rates
   */
  async _processQueue() {
    if (this.isProcessing) {
      return;
    }
    if (this.isPaused) {
      return;
    }
    this.isProcessing = true;
    
    // Track queue generation to detect re-prioritization
    const startGeneration = this.queueGeneration;
    
    // Track how many consecutive frames we've been paused due to camera movement
    // This prevents loading from being completely blocked during continuous movement
    let cameraMovePauseCount = 0;
    const maxCameraMovePauseFrames = 10; // Resume after 10 frames even if moving
    
    try {
      while (this.loadQueue.size > 0) {
        // Check if paused
        if (this.isPaused) break;
        
        // If queue was re-prioritized, break out and let new priorities take effect
        if (this.queueGeneration !== startGeneration) {
          break;
        }
        
        // Check if camera is moving fast - use requestIdleCallback for truly idle loading
        // This ensures chunk loading only happens when the browser is genuinely idle
        if (this.superChunkManager?.isCameraMovingFast()) {
          cameraMovePauseCount++;
          if (cameraMovePauseCount < maxCameraMovePauseFrames) {
            // Use requestIdleCallback if available, otherwise fall back to rAF
            if (typeof requestIdleCallback !== 'undefined') {
              await new Promise(r => requestIdleCallback(() => r(), { timeout: 100 }));
            } else {
              await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
            }
            continue;
          }
          // Force resume after max pause frames, but use idle callback
          if (typeof requestIdleCallback !== 'undefined') {
            await new Promise(r => requestIdleCallback(() => r(), { timeout: 50 }));
          }
        } else {
          cameraMovePauseCount = 0; // Reset counter when camera stops moving
        }
        
        // Process batch of chunks concurrently (use configured concurrency)
        // Higher concurrency = faster loading but may cause frame drops
        const batch = [];
        let skippedLoaded = 0;
        for (let i = 0; i < this.concurrentChunks && this.loadQueue.size > 0; i++) {
          const item = this.loadQueue.pop();
          if (item && !this.loadedChunks.has(`${item.chunkX},${item.chunkZ}`)) {
            batch.push(item);
            this.loadingChunks.add(`${item.chunkX},${item.chunkZ}`);
          } else if (item) {
            skippedLoaded++;
          }
        }
        if (batch.length === 0) {
          break;
        }
        
        // Process batch in parallel (decode/cache)
        // Note: Meshing is still throttled separately to avoid frame drops
        await Promise.all(batch.map(item => this._loadChunk(item)));
        
        // Fix boundary seams immediately for already-visible chunks
        // This repairs water/light artifacts at chunk borders as soon as neighbor data arrives
        // Repair up to 2 boundaries per batch to keep up with fast movement
        if (this.superChunkManager?.hasBoundaryDirtyChunks()) {
          await this.superChunkManager.repairBoundaries(2);
        }
        
        // Schedule remaining super-chunk rebuilds for idle time
        // This prevents stuttering during movement while ensuring new chunks get built
        if (this.superChunkManager?.hasDirtyChunks()) {
          this.superChunkManager.scheduleIdleRebuild(true); // Low priority during streaming
        }
        
        // Yield to browser between batches - use requestAnimationFrame for better timing
        // This ensures we don't block during active rendering
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      }
      
      // Schedule any remaining dirty super-chunks for idle time rebuilding
      if (this.superChunkManager?.hasDirtyChunks()) {
        this.superChunkManager.scheduleIdleRebuild(false); // Normal priority when queue is empty
      }
    } finally {
      this.isProcessing = false;
      
      // Check if more chunks were queued while we were processing
      // If so, schedule another processing run
      if (this.loadQueue.size > 0 && !this.isPaused) {
        setTimeout(() => this._processQueue(), 16);
      }
    }
  }

  /**
   * Process queue until all immediate chunks are done
   */
  async _processQueueUntilComplete() {
    this.isProcessing = true;
    
    try {
      while (this.loadQueue.size > 0) {
        // Check if remaining items are all lazy priority
        const next = this.loadQueue.peek();
        if (next && next.priority >= PRIORITY_LAZY) {
          break; // Only lazy chunks left, stop waiting
        }
        
        // Process batch (use configured concurrency)
        const batch = [];
        for (let i = 0; i < this.concurrentChunks && this.loadQueue.size > 0; i++) {
          const item = this.loadQueue.pop();
          if (!item) break;
          
          // Stop if we hit lazy priority
          if (item.priority >= PRIORITY_LAZY) {
            this.loadQueue.push(item); // Put it back
            break;
          }
          
          if (!this.loadedChunks.has(`${item.chunkX},${item.chunkZ}`)) {
            batch.push(item);
            this.loadingChunks.add(`${item.chunkX},${item.chunkZ}`);
          }
        }
        
        if (batch.length === 0) break;
        
        // Process batch in parallel
        await Promise.all(batch.map(item => this._loadChunk(item)));
        
        // Report progress (but don't rebuild yet - wait for all chunks)
        const loaded = this.loadedChunks.size;
        const queued = this.loadQueue.size;
        this.onProgress?.({
          loaded,
          queued,
          message: `Loading chunks: ${loaded} loaded, ${queued} queued`,
        });
      }
      
      // Rebuild ALL dirty super-chunks after initial load is complete
      // This is more efficient than rebuilding after each batch
      if (this.superChunkManager) {
        const stats = this.superChunkManager.getStats();
        const totalDirty = stats.dirtyCount;
        let rebuilt = 0;
        
        // Report meshing stage start
        this.onProgress?.({
          loaded: this.loadedChunks.size,
          queued: 0, // No more chunks to load, now meshing
          message: `Building meshes: 0/${totalDirty}`,
          stage: 'meshing',
          stageProgress: 0,
        });
        
        while (this.superChunkManager.hasDirtyChunks()) {
          const beforeStats = this.superChunkManager.getStats();
          await this.superChunkManager.rebuildDirty(4);
          const afterStats = this.superChunkManager.getStats();
          rebuilt += beforeStats.dirtyCount - afterStats.dirtyCount;
          
          // Report meshing progress
          const progress = totalDirty > 0 ? Math.round((rebuilt / totalDirty) * 100) : 100;
          this.onProgress?.({
            loaded: this.loadedChunks.size,
            queued: 0,
            message: `Building meshes: ${rebuilt}/${totalDirty}`,
            stage: 'meshing',
            stageProgress: progress,
          });
        }
      }
    } finally {
      this.isProcessing = false;
      this.initialLoadComplete = true; // Mark initial load as done
      
      // Continue with lazy loading in background
      if (this.loadQueue.size > 0) {
        setTimeout(() => this._processQueue(), 100);
      }
    }
    
    return {
      chunksLoaded: this.loadedChunks.size,
    };
  }

  /**
   * Load a single chunk
   */
  async _loadChunk(item) {
    const { chunkX, chunkZ, regionX, regionZ } = item;
    const chunkKey = `${chunkX},${chunkZ}`;
    const loadStartTime = performance.now();
    
    // Log chunk load start
    chunkLoadLogger.log('loadStart', chunkX, chunkZ, { regionX, regionZ });
    
    try {
      let chunkData;
      
      if (this.usePreParsedChunks) {
        // Use pre-parsed chunk data directly
        chunkData = this.parsedChunks.get(chunkKey);
        
        if (!chunkData) {
          this.loadingChunks.delete(chunkKey);
          return;
        }
        
        this.stats.cacheHits++;
      } else {
        // Get region data (from cache or parse fresh)
        let regionData = this.regionCache.get(regionX, regionZ);
        
        if (!regionData) {
          this.stats.cacheMisses++;
          
          const regionKey = `${regionX},${regionZ}`;
          const regionInfo = this.regionFiles.get(regionKey);
          
          if (!regionInfo) {
            console.warn(`[ChunkStreamer] Region ${regionKey} not found`);
            this.loadingChunks.delete(chunkKey);
            return;
          }
          
          // Parse region file
          // Wait for WASM init if it's in progress (max 500ms)
          // This ensures we use the unified pipeline when possible
          // CRITICAL: Also wait if WASM reinit is pending (texture pack hotswap)
          // This prevents chunks from being meshed with stale lookup tables
          if (this._wasmReinitPending || (!isUnifiedPipelineReady() && this._wasmInitPromise)) {
            if (this._wasmReinitPending) {
              console.log('[ChunkStreamer] Waiting for WASM reinit after texture pack change...');
            }
            await Promise.race([
              this._wasmInitPromise,
              new Promise(r => setTimeout(r, 500))
            ]);
          }
          
          // Use unified WASM pipeline if available for better performance
          const buffer = await regionInfo.file.arrayBuffer();
          const useUnified = isUnifiedPipelineReady();
          const chunks = await this._parseRegionBuffer(buffer, regionX, regionZ, useUnified);
          
          // Cache for future use
          this.regionCache.set(regionX, regionZ, buffer, chunks);
          regionData = { buffer, chunks };
        } else {
          this.stats.cacheHits++;
        }
        
        // Find the specific chunk
        const localX = ((chunkX % REGION_SIZE) + REGION_SIZE) % REGION_SIZE;
        const localZ = ((chunkZ % REGION_SIZE) + REGION_SIZE) % REGION_SIZE;
        
        chunkData = regionData.chunks.find(c => c.x === localX && c.z === localZ);
        
        if (!chunkData) {
          // Chunk doesn't exist in this region (could be empty/ungenerated)
          this.loadingChunks.delete(chunkKey);
          return;
        }
      }
      
      // Add chunk to super-chunk manager (batched meshing)
      // The actual meshing is deferred until rebuildDirty() is called
      if (this.superChunkManager) {
        // For unified pipeline, pass the raw chunk data object (with compressedData)
        // For legacy, pass the parsed NBT data
        const dataToAdd = chunkData.isRawCompressed ? chunkData : chunkData.data;
        this.superChunkManager.addChunk(chunkX, chunkZ, dataToAdd, chunkData.isRawCompressed);
      }
      
      // Store loaded chunk (data only, meshes are in super-chunks)
      this.loadedChunks.set(chunkKey, {
        meshes: [], // Meshes are managed by SuperChunkManager now
        data: chunkData,
        chunkX,
        chunkZ,
      });
      
      this.stats.totalChunksLoaded++;
      this.onChunkLoaded?.(chunkX, chunkZ);
      
      // Log chunk load completion
      const loadDuration = performance.now() - loadStartTime;
      chunkLoadLogger.log('loadEnd', chunkX, chunkZ, { 
        duration: loadDuration,
        isRawCompressed: chunkData?.isRawCompressed || false,
      });
      chunkLoadLogger.logProcess('total', loadDuration, chunkX, chunkZ);
      
    } catch (error) {
      console.error(`[ChunkStreamer] Failed to load chunk ${chunkKey}:`, error);
      chunkLoadLogger.log('error', chunkX, chunkZ, { error: error.message });
    } finally {
      this.loadingChunks.delete(chunkKey);
    }
  }

  /**
   * Parse a region buffer into chunks
   * 
   * When useUnifiedPipeline is true, returns raw compressed data for WASM processing.
   * Otherwise, decompresses and parses NBT in JavaScript (legacy path).
   * 
   * @param {ArrayBuffer} buffer - Raw region file buffer
   * @param {number} regionX - Region X coordinate
   * @param {number} regionZ - Region Z coordinate
   * @param {boolean} useUnifiedPipeline - If true, return raw compressed bytes
   */
  async _parseRegionBuffer(buffer, regionX, regionZ, useUnifiedPipeline = false) {
    const view = new DataView(buffer);
    const chunks = [];
    
    for (let z = 0; z < REGION_SIZE; z++) {
      for (let x = 0; x < REGION_SIZE; x++) {
        const index = x + z * REGION_SIZE;
        const locationData = view.getUint32(index * 4, false);
        const offset = (locationData >> 8) * SECTOR_SIZE;
        const sectorCount = locationData & 0xFF;
        
        if (offset === 0 || sectorCount === 0) continue;
        
        try {
          const length = view.getUint32(offset, false);
          const compressionType = view.getUint8(offset + 4);
          
          if (length <= 1 || offset + 5 + length - 1 > buffer.byteLength) continue;
          
          // Extract raw compressed bytes (don't decompress in JS if using unified pipeline)
          const compressedData = new Uint8Array(buffer, offset + 5, length - 1);
          
          if (useUnifiedPipeline) {
            // Unified WASM pipeline: pass raw compressed data
            // Copy the data since the buffer may be transferred
            chunks.push({
              x,
              z,
              compressedData: new Uint8Array(compressedData), // Copy for safety
              compressionType,
              worldX: regionX * REGION_SIZE + x,
              worldZ: regionZ * REGION_SIZE + z,
              isRawCompressed: true, // Flag for SuperChunkManager
            });
          } else {
            // Legacy JS path: decompress and parse NBT here
            let decompressedData;
            if (compressionType === 1) {
              decompressedData = pako.ungzip(compressedData);
            } else if (compressionType === 2) {
              decompressedData = pako.inflate(compressedData);
            } else {
              continue;
            }
            
            // Use the same NBT parser as mcaParser for consistent chunk data format
            const nbt = parseNBTRaw(decompressedData.buffer);
            
            chunks.push({
              x,
              z,
              data: nbt.value,
              worldX: regionX * REGION_SIZE + x,
              worldZ: regionZ * REGION_SIZE + z,
            });
          }
          
        } catch (e) {
          // Skip failed chunks
        }
      }
    }
    
    return chunks;
  }

  /**
   * Build meshes for a single chunk
   */
  async _buildChunkMeshes(chunkData, worldChunkX, worldChunkZ) {
    const meshes = [];
    
    // Create grid for single chunk
    const grid = new BinaryGrid();
    const stateGrid = this.enableModelMeshes ? new BlockStateGrid() : null;
    const lightGrid = new LightGrid();
    
    // Adjust chunk coordinates to world space
    const adjustedChunk = {
      ...chunkData,
      x: worldChunkX,
      z: worldChunkZ,
    };
    
    // Decode chunk
    decodeChunk(adjustedChunk, grid, this.registry, stateGrid, this.stateRegistry, lightGrid);
    
    // Handle light propagation if no Minecraft light data
    if (lightGrid.sections.size === 0) {
      propagateSkyLight(grid, lightGrid, this.registry);
      propagateBlockLight(grid, lightGrid, this.registry);
    }
    
    // Build meshes
    const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
    // When smooth lighting is disabled, skip per-vertex light calculation
    const effectiveLightGrid = this.chunkManager.smoothLightingEnabled ? lightGrid : null;
    const mesherOptions = { textureIndexLookup, lightGrid: effectiveLightGrid };
    
    // Offset is { x: 0, y: 0, z: 0 } since chunks are already at world coordinates
    const offset = { x: 0, y: 0, z: 0 };
    const { solid, water, lava, glass } = buildGridMeshes(grid, this.registry, offset, mesherOptions);
    
    // Create Three.js geometries and meshes
    // Also add to ChunkManager's mesh arrays so visibility culling works
    if (solid && solid.positions.length > 0) {
      const mesh = this._createMesh(solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    if (water && water.positions.length > 0) {
      const mesh = this._createMesh(water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 1; // Water renders after glass/leaves
        meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    if (lava && lava.positions.length > 0) {
      const mesh = this._createMesh(lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 2; // Lava renders after water
        meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    if (glass && glass.positions.length > 0) {
      const mesh = this._createMesh(glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Build model meshes if enabled
    if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
      // Precompute geometry for all registered states before meshing
      // This is needed because getGeometrySync only works after precomputation
      await this.stateRegistry.precomputeAll();
      
      const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
      
      if (modelResult) {
        if (modelResult.opaque && modelResult.opaque.positions.length > 0) {
          const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
          if (mesh) {
            meshes.push(mesh);
            this.chunkManager.modelMeshes.push(mesh);
          }
        }
        
        if (modelResult.transparent && modelResult.transparent.positions.length > 0) {
          const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
          if (mesh) {
            mesh.renderOrder = 0.5;
            meshes.push(mesh);
            this.chunkManager.transparentModelMeshes.push(mesh);
          }
        }
        
        // Handle overlay meshes (torch glow effects, etc.)
        if (modelResult.overlay && modelResult.overlay.positions.length > 0) {
          const mesh = this._createMesh(modelResult.overlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
          if (mesh) {
            mesh.renderOrder = 4; // Render after everything
            meshes.push(mesh);
            this.chunkManager.overlayModelMeshes.push(mesh);
          }
        }
        
        // Register particle emitters (torches, candles, etc.)
        if (modelResult.particleEmitters && modelResult.particleEmitters.length > 0) {
          const emitterManager = this.chunkManager.particleEmitterManager;
          if (emitterManager) {
            for (const emitter of modelResult.particleEmitters) {
              // addEmitter expects (blockType, x, y, z, properties)
              emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
            }
          }
        }
      }
    } else if (this.enableModelMeshes && !this.stateRegistry) {
      // Log warning if stateRegistry not available
      console.warn('[ChunkStreamer] Model meshes enabled but stateRegistry not initialized');
    }
    
    return meshes;
  }

  /**
   * Create a Three.js mesh from mesh data
   * Uses same attribute names as RegionMeshBuilder.createGeometry
   */
  _createMesh(meshData, material, group) {
    // Validate required data
    if (!meshData) return null;
    if (!meshData.positions || meshData.positions.length === 0) return null;
    if (!meshData.normals || meshData.normals.length === 0) return null;
    if (!meshData.indices || meshData.indices.length === 0) return null;
    if (!material || !group) return null;
    
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    
    // Colors attribute (for solid/glass blocks) - may not be present for fluids
    if (meshData.colors && meshData.colors.length > 0) {
      geometry.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    }
    
    // UV attribute (for fluid meshes from FluidMesher)
    if (meshData.uvs && meshData.uvs.length > 0) {
      geometry.setAttribute('modelUV', new THREE.BufferAttribute(meshData.uvs, 2));
    }
    
    // Add model UV attribute if present (for non-triplanar UV mapping)
    if (meshData.modelUVs && meshData.modelUVs.length > 0) {
      geometry.setAttribute('modelUV', new THREE.BufferAttribute(meshData.modelUVs, 2));
    }
    
    // Add texture index attribute if present (for texture atlas lookup in shader)
    if (meshData.texIndices && meshData.texIndices.length > 0) {
      geometry.setAttribute('texIndex', new THREE.BufferAttribute(meshData.texIndices, 1));
    }
    
    // Add texture rotation attribute if present (for UV rotation in shader)
    if (meshData.texRotations && meshData.texRotations.length > 0) {
      geometry.setAttribute('texRotation', new THREE.BufferAttribute(meshData.texRotations, 1));
    }
    
    // Add biome tint type attribute if present (for biome tinting in shader)
    if (meshData.tintTypes && meshData.tintTypes.length > 0) {
      geometry.setAttribute('tintType', new THREE.BufferAttribute(meshData.tintTypes, 1));
    }
    
    // Add shade flag attribute if present (for face shading control in shader)
    if (meshData.shadeFlags && meshData.shadeFlags.length > 0) {
      geometry.setAttribute('shadeFlag', new THREE.BufferAttribute(meshData.shadeFlags, 1));
    }
    
    // Add single-sided flag if present (for backface culling control in shader)
    if (meshData.singleSidedFlags && meshData.singleSidedFlags.length > 0) {
      geometry.setAttribute('singleSided', new THREE.BufferAttribute(meshData.singleSidedFlags, 1));
    }
    
    // Add sky light attribute if present (for lightmap-based lighting)
    if (meshData.skyLight && meshData.skyLight.length > 0) {
      geometry.setAttribute('skyLight', new THREE.BufferAttribute(meshData.skyLight, 1));
    }
    
    // Add block light attribute if present (for lightmap-based lighting)
    if (meshData.blockLight && meshData.blockLight.length > 0) {
      geometry.setAttribute('blockLight', new THREE.BufferAttribute(meshData.blockLight, 1));
    }
    
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingSphere();
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    group.add(mesh);
    
    return mesh;
  }

  /**
   * Get current stats
   */
  getStats() {
    const superChunkStats = this.superChunkManager?.getStats() || {};
    return {
      ...this.stats,
      loadedChunks: this.loadedChunks.size,
      queueSize: this.loadQueue.size,
      loading: this.loadingChunks.size,
      cachedRegions: this.regionCache.cache.size,
      superChunks: superChunkStats.superChunkCount || 0,
      superChunkMeshes: superChunkStats.totalMeshes || 0,
      dirtySuperChunks: superChunkStats.dirtyCount || 0,
      // New stats for Minecraft-style loading
      renderDistance: this.renderDistance,
      loadDistance: this.loadDistance,
      playerViewDir: { x: this.playerViewDirX, z: this.playerViewDirZ },
      playerVelocity: { x: this.playerVelocityX, z: this.playerVelocityZ },
    };
  }

  /**
   * Clear all loaded chunks
   * @param {Object} options - Clear options
   * @param {boolean} options.invalidateWorkers - If true, invalidate worker pool for texture pack changes
   */
  clear(options = {}) {
    // If invalidateWorkers is set, invalidate the worker pool first
    // This is critical for texture pack hotswapping - workers have cached texture indices
    if (options.invalidateWorkers && this.superChunkManager) {
      console.log('[ChunkStreamer] Invalidating worker pool for texture pack change...');
      this.superChunkManager.invalidateWorkerPool();
      
      // Mark that we need to wait for WASM reinit before loading any chunks
      // This ensures chunks aren't meshed with stale lookup tables
      this._wasmReinitPending = true;
      
      // Also recreate the meshBuilder with the new texture lookup
      // This is used for fallback meshing when workers aren't available
      this.meshBuilder = new RegionMeshBuilder({
        textureIndexLookup: this.chunkManager.getTextureIndexLookup?.() || null,
      });
    }
    
    // Clear super-chunk manager (disposes all meshes)
    if (this.superChunkManager) {
      this.superChunkManager.clear();
    }
    
    // Clear particle emitters
    const emitterManager = this.chunkManager.particleEmitterManager;
    if (emitterManager) {
      emitterManager.clear?.();
    }
    
    this.loadedChunks.clear();
    this.loadQueue.clear();
    this.loadingChunks.clear();
    this.regionCache.clear();
    
    this.stats.totalChunksLoaded = 0;
    this.stats.totalChunksUnloaded = 0;
    this.stats.queueSize = 0;
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
  }

  /**
   * Flush all pending mesh creation immediately
   * Used for tests or when immediate completion is required
   * 
   * @returns {Promise<number>} Number of meshes/chunks processed
   */
  async flushMeshQueue() {
    if (!this.superChunkManager) return 0;
    
    // Wait for any pending worker jobs to complete
    let waitAttempts = 0;
    while (this.superChunkManager.hasPendingWork() && waitAttempts < 100) {
      await new Promise(resolve => setTimeout(resolve, 50));
      waitAttempts++;
    }
    
    // Flush completion queue (super-chunk mesh creation)
    await this.superChunkManager.flushCompletionQueue();
    
    // Flush model mesh queue (deferred model mesh building)
    await this.superChunkManager.flushModelMeshQueue();
    
    // Flush individual mesh queue
    return this.superChunkManager.flushMeshQueue();
  }
  
  /**
   * Get number of pending meshes in the queue
   */
  getPendingMeshCount() {
    if (this.superChunkManager) {
      return this.superChunkManager.getPendingMeshCount();
    }
    return 0;
  }
  
  /**
   * Dispose of all resources
   */
  dispose() {
    this.clear();
    this.regionFiles.clear();
    
    if (this.superChunkManager) {
      // Worker pool is terminated by SuperChunkManager.dispose()
      this.superChunkManager.dispose();
      this.superChunkManager = null;
    }
  }

  /**
   * Get worker pool statistics for debugging
   */
  getWorkerStats() {
    if (this.superChunkManager?.workerPool) {
      return this.superChunkManager.workerPool.getStats();
    }
    return null;
  }

  /**
   * Pause chunk loading temporarily
   * Useful during intense camera movement or other heavy operations
   */
  pause() {
    this.isPaused = true;
    if (this.superChunkManager) {
      this.superChunkManager.cancelIdleRebuild();
    }
  }

  /**
   * Resume chunk loading
   */
  resume() {
    this.isPaused = false;
    if (!this.isProcessing && this.loadQueue.size > 0) {
      this._processQueue();
    }
  }
}

