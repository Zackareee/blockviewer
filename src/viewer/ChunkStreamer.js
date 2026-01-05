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
 * Architecture:
 * - Region data is cached once parsed
 * - Individual chunks are extracted and meshed on-demand
 * - Chunk meshes are managed independently for efficient add/remove
 * - Priority queue ensures nearest chunks load first
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

// Chunk size in blocks (Minecraft standard)
const CHUNK_SIZE = 16;
const REGION_SIZE = 32; // 32x32 chunks per region
const SECTOR_SIZE = 4096;

// Loading configuration
const MAX_CONCURRENT_CHUNKS = 4; // How many chunks to mesh at once
const LOAD_BATCH_SIZE = 8; // How many chunks to queue per frame
const UNLOAD_HYSTERESIS = 2; // Extra chunks beyond unload distance before removal

// Priority weights
const PRIORITY_IMMEDIATE = 0; // Within view distance
const PRIORITY_LAZY = 100; // Beyond view but pre-loading

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
    
    // Configuration
    this.loadDistance = options.loadDistance || 8; // Chunks to load around player
    this.unloadDistance = options.unloadDistance || (this.loadDistance + 1); // Distance to start unloading
    this.preloadDistance = options.preloadDistance || this.loadDistance; // Same as load distance
    this.enableModelMeshes = options.enableModelMeshes !== false;
    
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
    this.loadedChunks = new Map(); // chunkKey -> { meshes, data }
    this.loadingChunks = new Set(); // Currently processing
    this.regionFiles = new Map(); // regionKey -> File
    this.parsedChunks = new Map(); // chunkKey -> parsed chunk data (for single-region mode)
    this.usePreParsedChunks = false; // Whether to use pre-parsed chunks instead of region files
    
    // Processing state
    this.isProcessing = false;
    this.initialLoadComplete = false; // Only show progress during initial load
    this.registry = getBlockRegistry();
    this.stateRegistry = null;
    
    // Stats
    this.stats = {
      totalChunksLoaded: 0,
      totalChunksUnloaded: 0,
      queueSize: 0,
      cacheHits: 0,
      cacheMisses: 0,
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
  }

  /**
   * Update streaming distances (called when user changes settings)
   * @param {number} loadDistance - New load distance in chunks
   */
  setLoadDistance(loadDistance) {
    const oldLoad = this.loadDistance;
    const oldUnload = this.unloadDistance;
    
    this.loadDistance = loadDistance;
    this.unloadDistance = loadDistance + 1; // Small hysteresis to prevent thrashing
    this.preloadDistance = loadDistance; // No longer used for lazy loading
    
    // If distance decreased, immediately unload distant chunks
    if (loadDistance < oldLoad) {
      this._unloadDistantChunks();
    }
    
    // If distance increased, queue new chunks
    if (loadDistance > oldLoad) {
      this._queueChunksAroundPlayer();
      if (!this.isProcessing) {
        this._processQueue();
      }
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
      onSuperChunkRebuilt: () => {
        this.chunkManager.invalidate?.();
      }
    });
  }

  /**
   * Update player position and trigger chunk loading/unloading
   * @param {number} worldX - Player world X position
   * @param {number} worldZ - Player world Z position
   */
  updatePlayerPosition(worldX, worldZ) {
    const chunkX = Math.floor(worldX / CHUNK_SIZE);
    const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
    
    // Only update if player moved to a new chunk
    if (chunkX === this.playerChunkX && chunkZ === this.playerChunkZ) {
      return;
    }
    
    this.playerChunkX = chunkX;
    this.playerChunkZ = chunkZ;
    
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
   * Queue chunks around player based on distance
   * @param {boolean} immediate - If true, all chunks get immediate priority
   */
  _queueChunksAroundPlayer(immediate = false) {
    const { playerChunkX, playerChunkZ, loadDistance, usePreParsedChunks } = this;
    
    console.log(`[ChunkStreamer] Queueing chunks around ${playerChunkX},${playerChunkZ} with loadDistance=${loadDistance}`);
    
    // Clear existing queue and re-prioritize
    this.loadQueue.clear();
    
    // Add chunks in spiral order for better visual loading
    // Only queue up to loadDistance (not preloadDistance) to match expected behavior
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
          
          // Priority is just the distance (lower = higher priority)
          // Chebyshev = max(|dx|, |dz|) - creates square loading area
          const priority = r;
          
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
    console.log(`[ChunkStreamer] Queued ${this.loadQueue.size} chunks`);
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
   */
  async _processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    
    try {
      while (this.loadQueue.size > 0) {
        // Process batch of chunks concurrently
        const batch = [];
        for (let i = 0; i < MAX_CONCURRENT_CHUNKS && this.loadQueue.size > 0; i++) {
          const item = this.loadQueue.pop();
          if (item && !this.loadedChunks.has(`${item.chunkX},${item.chunkZ}`)) {
            batch.push(item);
            this.loadingChunks.add(`${item.chunkX},${item.chunkZ}`);
          }
        }
        
        if (batch.length === 0) break;
        
        // Process batch in parallel
        await Promise.all(batch.map(item => this._loadChunk(item)));
        
        // Schedule idle rebuilds during continuous loading (non-blocking)
        // This allows the main thread to stay responsive
        if (this.superChunkManager && this.superChunkManager.dirtySet.size > 0) {
          this.superChunkManager.scheduleIdleRebuild();
        }
        
        // Yield to browser between batches
        await new Promise(r => setTimeout(r, 0));
      }
    } finally {
      this.isProcessing = false;
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
        
        // Process batch
        const batch = [];
        for (let i = 0; i < MAX_CONCURRENT_CHUNKS && this.loadQueue.size > 0; i++) {
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
          const buffer = await regionInfo.file.arrayBuffer();
          const chunks = await this._parseRegionBuffer(buffer, regionX, regionZ);
          
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
        this.superChunkManager.addChunk(chunkX, chunkZ, chunkData.data);
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
   */
  async _parseRegionBuffer(buffer, regionX, regionZ) {
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
          
          const compressedData = new Uint8Array(buffer, offset + 5, length - 1);
          
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
      this.superChunkManager.dispose();
      this.superChunkManager = null;
    }
  }
}

