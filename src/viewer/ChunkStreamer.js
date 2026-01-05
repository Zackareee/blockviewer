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
import pako from 'pako';

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
        console.log(`[RegionCache] Evicting region ${oldestKey} (LRU)`);
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
      console.log(`[RegionCache] Evicting distant region ${key}`);
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
    this.unloadDistance = options.unloadDistance || 12; // Distance to start unloading
    this.preloadDistance = options.preloadDistance || 10; // Lazy preload distance
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
    
    // Initialize state registry if needed
    if (this.enableModelMeshes && !this.stateRegistry) {
      this.stateRegistry = getStateRegistry();
      await this.stateRegistry.init();
    }
    
    console.log(`[ChunkStreamer] Registered ${regions.length} regions for streaming`);
  }

  /**
   * Update streaming distances (called when user changes settings)
   * @param {number} loadDistance - New load distance in chunks
   */
  setLoadDistance(loadDistance) {
    const oldLoad = this.loadDistance;
    const oldUnload = this.unloadDistance;
    
    this.loadDistance = loadDistance;
    this.unloadDistance = loadDistance + 4;
    this.preloadDistance = loadDistance + 2;
    
    console.log(`[ChunkStreamer] Updated distances: load ${oldLoad}→${this.loadDistance}, unload ${oldUnload}→${this.unloadDistance}`);
    
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
    
    // Initialize state registry if needed
    if (this.enableModelMeshes && !this.stateRegistry) {
      this.stateRegistry = getStateRegistry();
      await this.stateRegistry.init();
    }
    
    console.log(`[ChunkStreamer] Registered ${chunks.length} pre-parsed chunks for streaming`);
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
    const { playerChunkX, playerChunkZ, loadDistance, preloadDistance, usePreParsedChunks } = this;
    
    // Clear existing queue and re-prioritize
    this.loadQueue.clear();
    
    // Add chunks in spiral order for better visual loading
    for (let r = 0; r <= preloadDistance; r++) {
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
          
          // Calculate priority (lower = higher priority)
          const dist = Math.sqrt(dx * dx + dz * dz);
          const priority = immediate ? dist : (
            dist <= loadDistance ? dist : PRIORITY_LAZY + dist
          );
          
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
  }

  /**
   * Unload chunks beyond unload distance
   */
  _unloadDistantChunks() {
    const { playerChunkX, playerChunkZ, unloadDistance } = this;
    const unloadDist = unloadDistance + UNLOAD_HYSTERESIS;
    
    const toUnload = [];
    
    for (const [key, chunkData] of this.loadedChunks) {
      const [cx, cz] = key.split(',').map(Number);
      const dx = cx - playerChunkX;
      const dz = cz - playerChunkZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      
      if (dist > unloadDist) {
        toUnload.push({ key, chunkData, chunkX: cx, chunkZ: cz });
      }
    }
    
    for (const { key, chunkData, chunkX, chunkZ } of toUnload) {
      this._unloadChunk(key, chunkData);
      this.stats.totalChunksUnloaded++;
      this.onChunkUnloaded?.(chunkX, chunkZ);
    }
    
    // Also evict distant regions from cache to free memory
    // Player region is determined by chunk position
    const playerRegionX = Math.floor(playerChunkX / REGION_SIZE);
    const playerRegionZ = Math.floor(playerChunkZ / REGION_SIZE);
    const evicted = this.regionCache.evictDistant(playerRegionX, playerRegionZ);
    if (evicted > 0) {
      console.log(`[ChunkStreamer] Evicted ${evicted} distant region(s) from cache`);
    }
  }

  /**
   * Remove a chunk's meshes from the scene
   */
  _unloadChunk(key, chunkData) {
    const { meshes } = chunkData;
    
    let geometryCount = 0;
    for (const mesh of meshes) {
      if (mesh.parent) {
        mesh.parent.remove(mesh);
      }
      if (mesh.geometry) {
        mesh.geometry.dispose();
        geometryCount++;
      }
    }
    
    this.loadedChunks.delete(key);
    console.log(`[ChunkStreamer] Unloaded chunk ${key} (${geometryCount} geometries disposed)`);
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
        
        // Report progress
        const loaded = this.loadedChunks.size;
        const queued = this.loadQueue.size;
        this.onProgress?.({
          loaded,
          queued,
          message: `Loading chunks: ${loaded} loaded, ${queued} queued`,
        });
        
        // Small delay to prevent frame drops
        await new Promise(r => setTimeout(r, 1));
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
    
    try {
      while (this.loadQueue.size > 0) {
        // Check if remaining items are all lazy priority
        const next = this.loadQueue.peek();
        if (next && next.priority >= PRIORITY_LAZY) {
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
        
        // Report progress
        const loaded = this.loadedChunks.size;
        const queued = this.loadQueue.size;
        this.onProgress?.({
          loaded,
          queued,
          message: `Loading chunks: ${loaded} loaded, ${queued} queued`,
        });
      }
    } finally {
      this.isProcessing = false;
      
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
      
      // Build meshes for this single chunk
      const meshes = await this._buildChunkMeshes(chunkData, chunkX, chunkZ);
      
      // Store loaded chunk
      this.loadedChunks.set(chunkKey, {
        meshes,
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
          
          const nbt = this._parseNBT(decompressedData.buffer);
          
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
   * Minimal NBT parser for worker-free parsing
   */
  _parseNBT(buffer) {
    const view = new DataView(buffer);
    let offset = 0;
    
    const TAG_END = 0, TAG_BYTE = 1, TAG_SHORT = 2, TAG_INT = 3, TAG_LONG = 4;
    const TAG_FLOAT = 5, TAG_DOUBLE = 6, TAG_BYTE_ARRAY = 7, TAG_STRING = 8;
    const TAG_LIST = 9, TAG_COMPOUND = 10, TAG_INT_ARRAY = 11, TAG_LONG_ARRAY = 12;
    
    function readByte() { return view.getInt8(offset++); }
    function readShort() { const v = view.getInt16(offset, false); offset += 2; return v; }
    function readInt() { const v = view.getInt32(offset, false); offset += 4; return v; }
    function readFloat() { const v = view.getFloat32(offset, false); offset += 4; return v; }
    function readDouble() { const v = view.getFloat64(offset, false); offset += 8; return v; }
    function readLong() {
      const high = view.getInt32(offset, false);
      const low = view.getUint32(offset + 4, false);
      offset += 8;
      return BigInt(high) * BigInt(0x100000000) + BigInt(low);
    }
    
    function readString() {
      const length = view.getUint16(offset, false);
      offset += 2;
      const bytes = new Uint8Array(buffer, offset, length);
      offset += length;
      return new TextDecoder().decode(bytes);
    }
    
    function readTag(type) {
      switch (type) {
        case TAG_END: return null;
        case TAG_BYTE: return readByte();
        case TAG_SHORT: return readShort();
        case TAG_INT: return readInt();
        case TAG_LONG: return Number(readLong());
        case TAG_FLOAT: return readFloat();
        case TAG_DOUBLE: return readDouble();
        case TAG_BYTE_ARRAY: {
          const len = readInt();
          const arr = new Int8Array(buffer, offset, len);
          offset += len;
          return Array.from(arr);
        }
        case TAG_STRING: return readString();
        case TAG_LIST: {
          const listType = view.getUint8(offset++);
          const len = readInt();
          const arr = [];
          for (let i = 0; i < len; i++) {
            arr.push(readTag(listType));
          }
          return arr;
        }
        case TAG_COMPOUND: return readCompound();
        case TAG_INT_ARRAY: {
          const len = readInt();
          const arr = new Int32Array(len);
          for (let i = 0; i < len; i++) {
            arr[i] = readInt();
          }
          return arr;
        }
        case TAG_LONG_ARRAY: {
          const len = readInt();
          const arr = [];
          for (let i = 0; i < len; i++) {
            arr.push(readLong());
          }
          return arr;
        }
        default:
          throw new Error(`Unknown NBT tag type: ${type}`);
      }
    }
    
    function readCompound() {
      const result = {};
      while (true) {
        const type = view.getUint8(offset++);
        if (type === TAG_END) break;
        const name = readString();
        result[name] = readTag(type);
      }
      return result;
    }
    
    // Read root compound
    const rootType = view.getUint8(offset++);
    if (rootType !== TAG_COMPOUND) {
      throw new Error('NBT root must be compound');
    }
    readString(); // Root name (usually empty)
    
    return { value: readCompound() };
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
    if (solid && solid.positions.length > 0) {
      const mesh = this._createMesh(solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) meshes.push(mesh);
    }
    
    if (water && water.positions.length > 0) {
      const mesh = this._createMesh(water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        meshes.push(mesh);
      }
    }
    
    if (lava && lava.positions.length > 0) {
      const mesh = this._createMesh(lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        meshes.push(mesh);
      }
    }
    
    if (glass && glass.positions.length > 0) {
      const mesh = this._createMesh(glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        meshes.push(mesh);
      }
    }
    
    // Build model meshes if enabled
    if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
      const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
      
      if (modelResult.opaque && modelResult.opaque.positions.length > 0) {
        const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
        if (mesh) meshes.push(mesh);
      }
      
      if (modelResult.transparent && modelResult.transparent.positions.length > 0) {
        const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
        if (mesh) {
          mesh.renderOrder = 0.5;
          meshes.push(mesh);
        }
      }
    }
    
    return meshes;
  }

  /**
   * Create a Three.js mesh from mesh data
   */
  _createMesh(meshData, material, group) {
    const { positions, normals, colors, uvs, indices, aoLevels, lightLevels, textureIndices } = meshData;
    
    if (!positions || positions.length === 0) return null;
    
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    
    if (uvs && uvs.length > 0) {
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    }
    
    if (aoLevels && aoLevels.length > 0) {
      geometry.setAttribute('aoLevel', new THREE.Float32BufferAttribute(aoLevels, 1));
    }
    
    if (lightLevels && lightLevels.length > 0) {
      geometry.setAttribute('lightLevel', new THREE.Float32BufferAttribute(lightLevels, 2));
    }
    
    if (textureIndices && textureIndices.length > 0) {
      geometry.setAttribute('textureIndex', new THREE.Float32BufferAttribute(textureIndices, 1));
    }
    
    geometry.setIndex(indices);
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
    return {
      ...this.stats,
      loadedChunks: this.loadedChunks.size,
      queueSize: this.loadQueue.size,
      loading: this.loadingChunks.size,
      cachedRegions: this.regionCache.cache.size,
    };
  }

  /**
   * Clear all loaded chunks
   */
  clear() {
    // Unload all chunks
    for (const [key, chunkData] of this.loadedChunks) {
      this._unloadChunk(key, chunkData);
    }
    
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
  }
}

