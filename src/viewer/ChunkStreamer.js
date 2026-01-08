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
const PRIORITY_LAZY = 100; // Beyond view but pre-loading

// Predictive loading configuration
// These values are tuned to match Minecraft's chunk loading behavior
const FORWARD_PRIORITY_BONUS = -3; // Bonus for chunks directly in front of player
const SIDE_PRIORITY_PENALTY = 1; // Penalty for chunks to the side
const BEHIND_PRIORITY_PENALTY = 2; // Penalty for chunks behind player

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
    
    // State
    this.playerChunkX = 0;
    this.playerChunkZ = 0;
    this.regionCache = new RegionCache();
    this.loadQueue = new ChunkPriorityQueue();
    this.loadedChunks = new Map(); // chunkKey -> { meshes, data, visible }
    this.loadingChunks = new Set(); // Currently processing
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
      }
      return success;
    } catch (error) {
      console.error('[ChunkStreamer] Failed to initialize WASM:', error);
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
    
    if (this.initialLoadComplete && movedOneChunk && this.loadQueue.size === 0 && !this.isProcessing) {
      // Quick boundary check: only need to look at chunks on the new edge
      // This is O(loadDistance) instead of O(loadDistance²)
      if (!this._hasNewChunksOnBoundary(chunkX, chunkZ, lastChunkX, lastChunkZ)) {
        // No new chunks to load, skip the expensive operations
        return;
      }
    }
    
    // Queue chunks for loading
    this._queueChunksAroundPlayer();
    
    // Unload distant chunks
    this._unloadDistantChunks();
    
    // Start processing if not already
    if (!this.isProcessing) {
      this._processQueue();
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
   * Calculate priority adjustment based on chunk direction relative to player view
   * Minecraft-style predictive loading: chunks in front get priority
   * @param {number} dx - Chunk offset X from player
   * @param {number} dz - Chunk offset Z from player
   * @returns {number} Priority adjustment (negative = higher priority)
   */
  _getDirectionalPriorityBonus(dx, dz) {
    // Normalize the chunk direction
    const chunkDist = Math.sqrt(dx * dx + dz * dz);
    if (chunkDist < 0.5) return FORWARD_PRIORITY_BONUS; // Player's chunk
    
    const chunkDirX = dx / chunkDist;
    const chunkDirZ = dz / chunkDist;
    
    // Combine view direction with movement velocity for prediction
    // Weight view direction more than velocity
    let predictDirX = this.playerViewDirX * 0.7;
    let predictDirZ = this.playerViewDirZ * 0.7;
    
    // Add velocity component if moving
    const velMag = Math.sqrt(this.playerVelocityX ** 2 + this.playerVelocityZ ** 2);
    if (velMag > 1) { // Moving at least 1 block/sec
      const velNormX = this.playerVelocityX / velMag;
      const velNormZ = this.playerVelocityZ / velMag;
      predictDirX += velNormX * 0.3;
      predictDirZ += velNormZ * 0.3;
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
    
    // Map dot product to priority bonus
    // In front (dot > 0.7): bonus
    // To the side (dot 0 to 0.7): small penalty
    // Behind (dot < 0): larger penalty
    if (dot > 0.7) {
      return FORWARD_PRIORITY_BONUS * dot; // Max bonus for directly ahead
    } else if (dot > 0) {
      return SIDE_PRIORITY_PENALTY * (1 - dot); // Small penalty for side
    } else {
      return BEHIND_PRIORITY_PENALTY * (1 - dot); // Larger penalty for behind
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
          if (this.loadedChunks.has(key) || this.loadingChunks.has(key)) continue;
          
          // Check if chunk exists
          if (usePreParsedChunks) {
            // For pre-parsed chunks, check directly in the map
            if (!this.parsedChunks.has(key)) continue;
          } else {
            // For region files, check if the region exists
            const regionX = Math.floor(chunkX / REGION_SIZE);
            const regionZ = Math.floor(chunkZ / REGION_SIZE);
            const regionKey = `${regionX},${regionZ}`;
            
            if (!this.regionFiles.has(regionKey)) continue;
          }
          
          // Base priority is distance (Chebyshev)
          let priority = r;
          
          // Chunks within render distance get immediate priority
          // Chunks beyond render distance (pre-load buffer) get lazy priority
          if (r > renderDistance) {
            priority += PRIORITY_LAZY;
          }
          
          // Apply directional bonus for predictive loading
          // Only apply to non-immediate chunks and when not in initial load
          if (!immediate && this.initialLoadComplete) {
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
        }
      }
    }
    
    this.stats.queueSize = this.loadQueue.size;
    // console.log(`[ChunkStreamer] Queued ${this.loadQueue.size} chunks`);
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
    
    // Schedule idle rebuild for removed chunks (non-blocking)
    if (this.superChunkManager && this.superChunkManager.dirtySet.size > 0) {
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
   */
  async _processQueue() {
    if (this.isProcessing) return;
    if (this.isPaused) return;
    this.isProcessing = true;
    
    try {
      while (this.loadQueue.size > 0) {
        // Check if paused
        if (this.isPaused) break;
        
        // Process batch of chunks concurrently (use configured concurrency)
        // Higher concurrency = faster loading but may cause frame drops
        const batch = [];
        for (let i = 0; i < this.concurrentChunks && this.loadQueue.size > 0; i++) {
          const item = this.loadQueue.pop();
          if (item && !this.loadedChunks.has(`${item.chunkX},${item.chunkZ}`)) {
            batch.push(item);
            this.loadingChunks.add(`${item.chunkX},${item.chunkZ}`);
          }
        }
        
        if (batch.length === 0) break;
        
        // Process batch in parallel (decode/cache)
        // Note: Meshing is still throttled separately to avoid frame drops
        await Promise.all(batch.map(item => this._loadChunk(item)));
        
        // Schedule super-chunk rebuilds for idle time instead of blocking
        // This prevents stuttering during movement
        if (this.superChunkManager && this.superChunkManager.dirtySet.size > 0) {
          this.superChunkManager.scheduleIdleRebuild(true); // Low priority during streaming
        }
        
        // Yield to browser between batches - use requestAnimationFrame for better timing
        // This ensures we don't block during active rendering
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      }
      
      // Schedule any remaining dirty super-chunks for idle time rebuilding
      if (this.superChunkManager && this.superChunkManager.dirtySet.size > 0) {
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
    console.log(`[ChunkStreamer] Starting initial load, queue size: ${this.loadQueue.size}`);
    
    try {
      while (this.loadQueue.size > 0) {
        // Check if remaining items are all lazy priority
        const next = this.loadQueue.peek();
        if (next && next.priority >= PRIORITY_LAZY) {
          console.log(`[ChunkStreamer] Stopping at lazy priority, remaining: ${this.loadQueue.size}`);
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
        while (this.superChunkManager.dirtySet.size > 0) {
          await this.superChunkManager.rebuildDirty(4);
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
          if (!isUnifiedPipelineReady() && this._wasmInitPromise) {
            await Promise.race([
              this._wasmInitPromise,
              new Promise(r => setTimeout(r, 500))
            ]);
          }
          
          // Use unified WASM pipeline if available for better performance
          const buffer = await regionInfo.file.arrayBuffer();
          const useUnified = isUnifiedPipelineReady();
          console.log(`[ChunkStreamer] Parsing region ${regionX},${regionZ} - unified pipeline: ${useUnified}`);
          const chunks = await this._parseRegionBuffer(buffer, regionX, regionZ, useUnified);
          
          // Cache for future use
          this.regionCache.set(regionX, regionZ, buffer, chunks);
          regionData = { buffer, chunks };
        } else {
          this.stats.cacheHits++;
          // Check if cached data has raw compressed chunks
          const hasRawCompressed = regionData.chunks.some(c => c.isRawCompressed);
          console.log(`[ChunkStreamer] Cache hit for region ${regionX},${regionZ} - hasRawCompressed: ${hasRawCompressed}`);
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
      
    } catch (error) {
      console.error(`[ChunkStreamer] Failed to load chunk ${chunkKey}:`, error);
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
    const mesherOptions = { textureIndexLookup, lightGrid };
    
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
        mesh.renderOrder = 2;
        meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    if (lava && lava.positions.length > 0) {
      const mesh = this._createMesh(lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
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
   */
  clear() {
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

