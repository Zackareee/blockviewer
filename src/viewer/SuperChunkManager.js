/**
 * SuperChunkManager - Groups individual Minecraft chunks into larger "super-chunks"
 * for more efficient meshing and rendering.
 * 
 * Benefits:
 * - Greedy meshing works across chunk boundaries (fewer triangles)
 * - Hidden faces between chunks are properly culled
 * - Fewer mesh objects = fewer draw calls
 * 
 * A super-chunk is 4x4 Minecraft chunks (64x64 blocks horizontally).
 * 
 * Worker-based meshing:
 * - FastMesher and ModelMesher run in parallel workers
 * - Main thread only handles Three.js mesh creation
 */

import * as THREE from 'three';
import { BinaryGrid } from '../mesh/BinaryGrid.js';
import { BlockStateGrid } from '../mesh/BlockStateGrid.js';
import { LightGrid } from '../mesh/LightGrid.js';
import { decodeChunk, extractActiveBeacons, extractAllBlockEntities } from '../mesh/ChunkDecoder.js';
import { buildGridMeshes } from '../mesh/FastMesher.js';
import { buildModelMeshesWithInstancing } from '../mesh/ModelMesher.js';
import { propagateSkyLight } from '../mesh/LightPropagator.js';
import { propagateBlockLight } from '../mesh/BlockLightPropagator.js';
import { getMeshWorkerPool, resetMeshWorkerPool } from '../mesh/workers/MeshWorkerPool.js';
import { getSuperChunkWorkerPool, resetSuperChunkWorkerPool } from '../mesh/workers/SuperChunkWorkerPool.js';
import { supportsWorkerPipeline } from '../utils/CapabilityDetector.js';
import { 
  initWasmMesher, 
  isWasmAvailable, 
  isUnifiedPipelineReady,
  initLookups as initWasmLookups,
  buildLookupTables,
  meshChunk as wasmMeshChunk,
  serializeGrid,
  serializeLightGrid,
} from '../mesh/wasm/WasmMesher.js';
import { parseNBTRaw } from '../utils/nbtParser.js';
import pako from 'pako';
import { chunkLoadLogger } from '../utils/ChunkLoadLogger.js';

// Super-chunk is 2x2 Minecraft chunks (32x32 blocks)
// Smaller size = faster rebuilds, less jank, more responsive loading
const SUPER_CHUNK_SIZE = 2;
const BLOCKS_PER_SUPER_CHUNK = SUPER_CHUNK_SIZE * 16; // 32 blocks

// Note: For neighbor block data, we use the existing decodeChunk function
// which correctly handles all Minecraft format versions and unpacking

/**
 * Decode only light data from a chunk (no blocks)
 * Used to include neighbor chunk light for smooth boundary lighting
 */
function decodeLightOnly(chunk, lightGrid) {
  if (!chunk?.data?.sections) return;
  
  const chunkX = chunk.x;
  const chunkZ = chunk.z;
  
  for (const section of chunk.data.sections) {
    if (!section) continue;
    
    const sectionY = section.Y ?? section.y;
    if (sectionY === undefined) continue;
    
    // Convert to internal section Y
    const internalSectionY = sectionY - Math.floor(-64 / 16);
    
    const skyLightData = section.SkyLight || section.sky_light;
    const blockLightData = section.BlockLight || section.block_light;
    
    if (!skyLightData && !blockLightData) continue;
    
    // Mark that this light grid has actual Minecraft light data
    lightGrid.hasMinecraftLightData = true;
    
    const lightSection = lightGrid._getOrCreateSection(chunkX, chunkZ, internalSectionY);
    
    // Unpack sky light
    if (skyLightData && skyLightData.length >= 2048) {
      for (let i = 0; i < 4096; i++) {
        const byteIdx = Math.floor(i / 2);
        const nibbleIdx = i % 2;
        const sky = nibbleIdx === 0 
          ? (skyLightData[byteIdx] & 0x0F)
          : ((skyLightData[byteIdx] >> 4) & 0x0F);
        lightSection[i] = (lightSection[i] & 0xF0) | sky;
      }
    }
    
    // Unpack block light
    if (blockLightData && blockLightData.length >= 2048) {
      for (let i = 0; i < 4096; i++) {
        const byteIdx = Math.floor(i / 2);
        const nibbleIdx = i % 2;
        const block = nibbleIdx === 0 
          ? (blockLightData[byteIdx] & 0x0F)
          : ((blockLightData[byteIdx] >> 4) & 0x0F);
        lightSection[i] = (lightSection[i] & 0x0F) | (block << 4);
      }
    }
  }
}

/**
 * Represents a single super-chunk containing multiple Minecraft chunks
 */
class SuperChunk {
  constructor(superX, superZ) {
    this.superX = superX;
    this.superZ = superZ;
    
    // Track which chunks are loaded (local 0-3 coordinates within super-chunk)
    this.loadedChunks = new Map(); // "lx,lz" -> chunkData
    
    // Meshes for this super-chunk
    this.meshes = [];
    
    // Dirty flag for rebuild
    this.isDirty = false;
    
    // Track if we've ever been built
    this.hasBeenBuilt = false;
  }

  /**
   * Get the key for a chunk within this super-chunk
   */
  getLocalKey(chunkX, chunkZ) {
    const lx = ((chunkX % SUPER_CHUNK_SIZE) + SUPER_CHUNK_SIZE) % SUPER_CHUNK_SIZE;
    const lz = ((chunkZ % SUPER_CHUNK_SIZE) + SUPER_CHUNK_SIZE) % SUPER_CHUNK_SIZE;
    return `${lx},${lz}`;
  }

  /**
   * Add a chunk's data to this super-chunk
   * @param {number} chunkX - Chunk X coordinate
   * @param {number} chunkZ - Chunk Z coordinate
   * @param {Object} chunkData - Chunk data (either parsed NBT or raw compressed)
   * @param {boolean} isRawCompressed - If true, chunkData contains raw compressed bytes
   * @returns {boolean} true if chunk was added/changed, false if already present
   */
  addChunk(chunkX, chunkZ, chunkData, isRawCompressed = false) {
    const key = this.getLocalKey(chunkX, chunkZ);
    
    // Skip if chunk already loaded with same data (avoid unnecessary rebuilds)
    if (this.loadedChunks.has(key)) {
      return false; // Already loaded, don't mark dirty
    }
    
    this.loadedChunks.set(key, {
      chunkX,
      chunkZ,
      data: chunkData,
      isRawCompressed, // Flag for unified WASM pipeline
    });
    this.isDirty = true;
    return true;
  }

  /**
   * Remove a chunk from this super-chunk
   */
  removeChunk(chunkX, chunkZ) {
    const key = this.getLocalKey(chunkX, chunkZ);
    if (this.loadedChunks.has(key)) {
      this.loadedChunks.delete(key);
      this.isDirty = true;
      return true;
    }
    return false;
  }

  /**
   * Check if this super-chunk has any loaded chunks
   */
  isEmpty() {
    return this.loadedChunks.size === 0;
  }

  /**
   * Get count of loaded chunks
   */
  getChunkCount() {
    return this.loadedChunks.size;
  }

  /**
   * Dispose all meshes
   */
  dispose() {
    for (const mesh of this.meshes) {
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.parent) {
        mesh.parent.remove(mesh);
      }
    }
    this.meshes = [];
    this.hasBeenBuilt = false;
  }
}

/**
 * SuperChunkManager - Manages super-chunks for efficient streaming
 */
export class SuperChunkManager {
  constructor(chunkManager, options = {}) {
    this.chunkManager = chunkManager;
    this.registry = options.registry;
    this.stateRegistry = options.stateRegistry;
    this.enableModelMeshes = options.enableModelMeshes !== false;
    
    // Super-chunks indexed by "sx,sz"
    this.superChunks = new Map();
    
    // Set of dirty super-chunks that need rebuild
    this.dirtySet = new Set();
    
    // Set of super-chunks that need rebuild due to neighbor changes (boundary stitching)
    // These are ALREADY BUILT chunks that have visible artifacts - highest priority
    this.boundaryDirtySet = new Set();
    
    // Callbacks
    this.onSuperChunkRebuilt = options.onSuperChunkRebuilt || null;
    
    // Worker pool state (old MeshWorkerPool - deprecated)
    this.workerPool = null;
    this.workerPoolInitialized = false;
    this.workerPoolInitPromise = null;
    
    // SuperChunkWorkerPool state (new unified pipeline)
    this.superChunkWorkerPool = null;
    this.superChunkWorkerPoolInitialized = false;
    this.superChunkWorkerPoolPromise = null;
    this.useSuperChunkWorkerPool = options.useSuperChunkWorkerPool ?? supportsWorkerPipeline();
    
    // WASM mesher state
    this.wasmInitialized = false;
    this.wasmInitPromise = null;
    this.useWasm = options.useWasm !== false; // Enable WASM meshing by default
    
    // Use workers for meshing (disabled - WASM is preferred)
    this.useWorkers = false;
    
    // Meshing speed: how many super-chunks to mesh per idle callback
    // 1 = smoothest camera, higher = faster chunk appearance but may cause frame drops
    this.meshingSpeed = options.meshingSpeed ?? 1;
  }
  
  /**
   * Set the meshing speed (super-chunks per idle callback)
   * @param {number} speed - 1-4, higher = faster but may cause frame drops
   */
  setMeshingSpeed(speed) {
    this.meshingSpeed = Math.max(1, Math.min(4, speed));
  }

  /**
   * Initialize the WASM mesher module
   * Call this before building any super-chunks for best performance
   */
  async initializeWasm() {
    if (this.wasmInitialized) {
      console.log('[SuperChunkManager] initializeWasm: already initialized, skipping');
      return true;
    }
    if (this.wasmInitPromise) {
      console.log('[SuperChunkManager] initializeWasm: initialization in progress, waiting...');
      return this.wasmInitPromise;
    }
    
    console.log(`[SuperChunkManager] initializeWasm: starting fresh initialization (version ${this._textureVersion || 0})`);
    this.wasmInitPromise = this._doInitializeWasm();
    return this.wasmInitPromise;
  }

  async _doInitializeWasm() {
    if (!this.useWasm) {
      console.log('[SuperChunkManager] WASM meshing disabled');
      return false;
    }

    try {
      console.log('[SuperChunkManager] Initializing WASM mesher...');
      
      // Initialize the WASM module
      const wasmLoaded = await initWasmMesher();
      if (!wasmLoaded) {
        console.warn('[SuperChunkManager] WASM mesher not available, using JavaScript fallback');
        this.useWasm = false;
        return false;
      }
      
      // Build lookup tables from registry
      // IMPORTANT: Get the CURRENT textureIndexLookup from ChunkManager
      // This is critical for texture pack hotswapping - must use the NEW lookup
      const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
      console.log('[SuperChunkManager] Building lookup tables with textureIndexLookup:', 
        textureIndexLookup ? `${textureIndexLookup.registeredBlocks?.size || 0} blocks registered` : 'null');
      
      // Debug: log specific block texture indices to verify they're from the new pack
      if (textureIndexLookup) {
        const stoneId = this.registry.getBlockId('stone') || this.registry.getBlockId('minecraft:stone');
        const dirtId = this.registry.getBlockId('dirt') || this.registry.getBlockId('minecraft:dirt');
        const grassId = this.registry.getBlockId('grass_block') || this.registry.getBlockId('minecraft:grass_block');
        console.log('[SuperChunkManager] Sample texture indices (should change with new pack):');
        console.log(`  stone (id=${stoneId}): up=${textureIndexLookup.getIndex(stoneId, 0)}`);
        console.log(`  dirt (id=${dirtId}): up=${textureIndexLookup.getIndex(dirtId, 0)}`);
        console.log(`  grass_block (id=${grassId}): up=${textureIndexLookup.getIndex(grassId, 0)}, side=${textureIndexLookup.getIndex(grassId, 2)}`);
      }
      
      const lookups = buildLookupTables(this.registry, textureIndexLookup);
      
      // Initialize lookups in WASM memory
      // This OVERWRITES any previous lookup data (essential for texture pack changes)
      initWasmLookups(lookups);
      
      this.wasmInitialized = true;
      console.log('[SuperChunkManager] WASM mesher initialized successfully');
      return true;
    } catch (error) {
      console.error('[SuperChunkManager] Failed to initialize WASM mesher:', error);
      this.useWasm = false;
      return false;
    }
  }

  /**
   * Initialize the worker pool with registry and texture data
   * Call this before building any super-chunks
   */
  async initializeWorkerPool() {
    if (this.workerPoolInitialized) return;
    if (this.workerPoolInitPromise) return this.workerPoolInitPromise;
    
    this.workerPoolInitPromise = this._doInitializeWorkerPool();
    return this.workerPoolInitPromise;
  }

  async _doInitializeWorkerPool() {
    try {
      console.log('[SuperChunkManager] Initializing worker pool...');
      
      // Export registry data
      const registryData = this.registry.export();
      
      // Ensure state registry geometries are pre-computed before export
      if (this.stateRegistry) {
        await this.stateRegistry.precomputeAll();
      }
      const stateRegistryData = this.stateRegistry ? this.stateRegistry.export() : null;
      
      // Get texture lookup data
      const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.();
      const textureIndices = textureIndexLookup?.getIndicesArray() || null;
      
      // Get atlas info
      const atlasInfo = this.chunkManager.getAtlasInfo?.() || { tilesPerRow: 64, tilesPerCol: 64 };
      
      // Additional data for workers
      const additionalData = {
        stateRegistryData,
        enableModelMeshes: this.enableModelMeshes,
      };
      
      // Get or create the worker pool
      this.workerPool = getMeshWorkerPool();
      
      // Initialize with data
      await this.workerPool.initialize(registryData, textureIndices, atlasInfo, additionalData);
      
      this.workerPoolInitialized = true;
      console.log('[SuperChunkManager] Worker pool initialized');
    } catch (error) {
      console.error('[SuperChunkManager] Failed to initialize worker pool:', error);
      this.useWorkers = false; // Fall back to main thread meshing
    }
  }

  /**
   * Initialize the SuperChunkWorkerPool (new unified pipeline)
   * This moves ALL processing to workers for maximum performance
   */
  async initializeSuperChunkWorkerPool() {
    if (this.superChunkWorkerPoolInitialized) return true;
    if (this.superChunkWorkerPoolPromise) return this.superChunkWorkerPoolPromise;
    
    this.superChunkWorkerPoolPromise = this._doInitializeSuperChunkWorkerPool();
    return this.superChunkWorkerPoolPromise;
  }

  async _doInitializeSuperChunkWorkerPool() {
    if (!this.useSuperChunkWorkerPool) {
      console.log('[SuperChunkManager] SuperChunkWorkerPool disabled');
      return false;
    }

    try {
      console.log('[SuperChunkManager] Initializing SuperChunkWorkerPool...');
      
      // Export block registry data for workers
      const blockRegistryData = this._exportBlockRegistryForWorker();
      
      // Ensure state registry geometries are pre-computed before export
      let stateRegistryData = null;
      if (this.stateRegistry) {
        await this.stateRegistry.precomputeAll();
        const exported = this.stateRegistry.exportForWorker();
        stateRegistryData = exported.data;
      }
      
      // Get or create the worker pool
      this.superChunkWorkerPool = getSuperChunkWorkerPool();
      
      // Initialize with registry data
      await this.superChunkWorkerPool.initialize(blockRegistryData, stateRegistryData);
      
      this.superChunkWorkerPoolInitialized = true;
      console.log('[SuperChunkManager] SuperChunkWorkerPool initialized successfully');
      return true;
    } catch (error) {
      console.error('[SuperChunkManager] Failed to initialize SuperChunkWorkerPool:', error);
      this.useSuperChunkWorkerPool = false;
      return false;
    }
  }

  /**
   * Export block registry data for worker initialization
   */
  _exportBlockRegistryForWorker() {
    const blocks = [];
    
    for (let id = 0; id < 4096; id++) {
      const info = this.registry.getBlockInfo(id);
      if (!info || !info.name) continue;
      
      blocks.push({
        name: info.name,
        color: info.color || 0x707070,
        isOpaque: info.isOpaque ?? true,
        isFluid: info.isFluid ?? false,
        isNonCube: this.registry.isNonCube?.(id) ?? false,
      });
    }
    
    return { blocks };
  }

  /**
   * Get super-chunk key from world chunk coordinates
   */
  getSuperChunkKey(chunkX, chunkZ) {
    const sx = Math.floor(chunkX / SUPER_CHUNK_SIZE);
    const sz = Math.floor(chunkZ / SUPER_CHUNK_SIZE);
    return `${sx},${sz}`;
  }

  /**
   * Get or create a super-chunk
   */
  getOrCreateSuperChunk(chunkX, chunkZ) {
    const key = this.getSuperChunkKey(chunkX, chunkZ);
    if (!this.superChunks.has(key)) {
      const sx = Math.floor(chunkX / SUPER_CHUNK_SIZE);
      const sz = Math.floor(chunkZ / SUPER_CHUNK_SIZE);
      this.superChunks.set(key, new SuperChunk(sx, sz));
    }
    return this.superChunks.get(key);
  }

  /**
   * Add a chunk's data to the appropriate super-chunk
   * @param {number} chunkX - World chunk X
   * @param {number} chunkZ - World chunk Z
   * @param {Object} chunkData - Chunk data (either parsed NBT or raw compressed)
   * @param {boolean} isRawCompressed - If true, chunkData contains raw compressed bytes for unified WASM pipeline
   * @returns {boolean} true if chunk was added (new), false if already present
   */
  addChunk(chunkX, chunkZ, chunkData, isRawCompressed = false) {
    if (!chunkData) {
      console.warn(`[SuperChunkManager] No data for chunk ${chunkX},${chunkZ}`);
      return false;
    }
    
    const superChunk = this.getOrCreateSuperChunk(chunkX, chunkZ);
    const wasAdded = superChunk.addChunk(chunkX, chunkZ, chunkData, isRawCompressed);
    
    // Only mark for rebuild if chunk was actually added (not already present)
    if (wasAdded) {
      const key = this.getSuperChunkKey(chunkX, chunkZ);
      this.dirtySet.add(key);
      
      // Note: We DON'T mark adjacent super-chunks dirty here anymore.
      // Instead, we mark them after THIS super-chunk is built (in buildSuperChunk).
      // This ensures neighbors rebuild with complete data, not partial data.
    }
    
    return wasAdded;
  }

  /**
   * Remove a chunk from its super-chunk
   */
  removeChunk(chunkX, chunkZ) {
    const key = this.getSuperChunkKey(chunkX, chunkZ);
    const superChunk = this.superChunks.get(key);
    
    if (superChunk) {
      superChunk.removeChunk(chunkX, chunkZ);
      
      if (superChunk.isEmpty()) {
        // Dispose and remove empty super-chunk
        superChunk.dispose();
        this.superChunks.delete(key);
        this.dirtySet.delete(key);
      } else {
        // Mark for rebuild
        this.dirtySet.add(key);
      }
    }
  }

  /**
   * Build meshes for a super-chunk
   * This decodes all chunks into a shared grid and runs the greedy mesher once.
   * 
   * Priority order:
   * 1. SuperChunkWorkerPool (new unified off-thread pipeline) - best performance
   * 2. Unified WASM pipeline (main thread but fast)
   * 3. Main thread JavaScript (fallback)
   */
  async buildSuperChunk(superChunk, keepOldMeshes = false) {
    const meshStartTime = performance.now();
    
    // Dispose old meshes (unless caller will handle cleanup)
    if (!keepOldMeshes) {
      superChunk.dispose();
    } else {
      // Clear the meshes array but don't dispose - caller will do it
      superChunk.meshes = [];
    }
    
    if (superChunk.isEmpty()) {
      superChunk.isDirty = false;
      return;
    }
    
    const hasRawCompressed = [...superChunk.loadedChunks.values()].some(c => c.isRawCompressed);
    const superChunkKey = `${superChunk.superX},${superChunk.superZ}`;
    
    // Priority 1: Try SuperChunkWorkerPool (fully off-thread pipeline)
    if (this.useSuperChunkWorkerPool && this.superChunkWorkerPoolInitialized && hasRawCompressed) {
      try {
        await this._buildSuperChunkWithWorkerPool(superChunk);
        const meshDuration = performance.now() - meshStartTime;
        chunkLoadLogger.logProcess('meshing', meshDuration, superChunk.superX, superChunk.superZ);
        return;
      } catch (error) {
        console.warn('[SuperChunkManager] SuperChunkWorkerPool failed, falling back:', error.message);
        // Fall through to other methods
      }
    }
    
    // Priority 2: Check if we should use unified WASM pipeline (main thread)
    // IMPORTANT: Also check this.wasmInitialized to ensure lookup tables are current
    // (invalidateWorkerPool sets wasmInitialized=false to force reinit with new texture indices)
    const pipelineReady = isUnifiedPipelineReady() && this.wasmInitialized;
    const useUnifiedPipeline = pipelineReady && hasRawCompressed;
    
    if (useUnifiedPipeline) {
      await this._buildSuperChunkUnified(superChunk);
      const meshDuration = performance.now() - meshStartTime;
      chunkLoadLogger.logProcess('meshing', meshDuration, superChunk.superX, superChunk.superZ);
      return;
    }
    
    // Create shared grids for all chunks in this super-chunk
    const grid = new BinaryGrid();
    const stateGrid = this.enableModelMeshes ? new BlockStateGrid() : null;
    const lightGrid = new LightGrid();
    
    // Build chunks array for extractActiveBeacons (needs raw chunk data)
    const chunks = [];
    
    // Decode all chunks into the shared grid
    for (const [key, chunkInfo] of superChunk.loadedChunks) {
      if (!chunkInfo.data) continue;
      const adjustedChunk = {
        x: chunkInfo.chunkX,
        z: chunkInfo.chunkZ,
        data: chunkInfo.data
      };
      chunks.push(adjustedChunk);
      decodeChunk(adjustedChunk, grid, this.registry, stateGrid, this.stateRegistry, lightGrid);
    }
    
    // Extract active beacons from block entities (beacons with Levels > 0)
    const beaconResult = extractActiveBeacons(chunks);
    
    // Extract all block entities for debug inspector (furnaces, chests, signs, etc.)
    const blockEntities = extractAllBlockEntities(chunks);
    
    // Include data from adjacent chunks (from neighboring super-chunks)
    // This prevents hard light cutoffs and enables correct fluid rendering at boundaries
    this._includeNeighborData(superChunk, grid, lightGrid);
    
    // Handle light propagation if no Minecraft light data
    if (lightGrid.sections.size === 0) {
      propagateSkyLight(grid, lightGrid, this.registry);
      propagateBlockLight(grid, lightGrid, this.registry);
    }
    
    // Merge grid into debugGrid for block lookups (beacon color tinting, particle collision)
    if (this.chunkManager?.debugGrid) {
      this.chunkManager._mergeDebugGrid(grid);
    }
    
    // Merge block entities into ChunkManager for block inspector
    if (this.chunkManager && blockEntities.size > 0) {
      this.chunkManager._mergeBlockEntities(blockEntities);
    }
    
    // Store stateGrid and stateRegistry for block state lookups
    if (this.chunkManager && stateGrid) {
      this.chunkManager.debugStateGrid = stateGrid;
      this.chunkManager.debugStateRegistry = this.stateRegistry;
    }
    
    const offset = { x: 0, y: 0, z: 0 };
    
    // Try WASM mesher first (fastest)
    if (this.useWasm && this.wasmInitialized && isWasmAvailable()) {
      await this._buildSuperChunkWithWasm(superChunk, grid, stateGrid, lightGrid, offset, beaconResult);
    }
    // Try worker pool for meshing (if WASM unavailable)
    else if (this.useWorkers && this.workerPoolInitialized && this.workerPool) {
      await this._buildSuperChunkWithWorker(superChunk, grid, stateGrid, lightGrid, offset);
    } else {
      // Fall back to main thread JavaScript meshing
      await this._buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset, beaconResult);
    }
    
    // Track if this is the first build (before we set hasBeenBuilt)
    const isFirstBuild = !superChunk.hasBeenBuilt;
    
    superChunk.isDirty = false;
    superChunk.hasBeenBuilt = true;
    
    // NOW mark adjacent super-chunks as needing rebuild
    // This happens AFTER we're built, so neighbors will have our complete data
    // Only on first build - rebuilds shouldn't cascade to neighbors
    this._markNeighborsDirtyAfterBuild(superChunk, isFirstBuild);
    
    // Log meshing time for performance profiling
    const meshDuration = performance.now() - meshStartTime;
    chunkLoadLogger.logProcess('meshing', meshDuration, superChunk.superX, superChunk.superZ);
    
    this.onSuperChunkRebuilt?.(superChunk);
  }

  /**
   * Build super-chunk using SuperChunkWorkerPool (fully off-thread pipeline)
   * 
   * This is the most efficient approach:
   * - ALL processing happens in workers (decompress, decode, mesh)
   * - Main thread only creates Three.js BufferGeometry (~2ms)
   * - Enables 4+ chunks/second without FPS drops
   */
  async _buildSuperChunkWithWorkerPool(superChunk) {
    const key = `${superChunk.superX},${superChunk.superZ}`;
    
    // Collect raw compressed chunk data
    const chunks = [];
    for (const [, chunkInfo] of superChunk.loadedChunks) {
      if (!chunkInfo.isRawCompressed || !chunkInfo.data) continue;
      
      chunks.push({
        chunkX: chunkInfo.chunkX,
        chunkZ: chunkInfo.chunkZ,
        compressedData: chunkInfo.data.compressedData,
        compressionType: chunkInfo.data.compressionType,
      });
    }
    
    if (chunks.length === 0) {
      throw new Error('No raw compressed chunks available');
    }
    
    // Collect neighbor chunks for boundary handling
    const neighbors = this._collectNeighborDataForWorker(superChunk);
    
    // Calculate bounds
    const bounds = {
      minChunkX: superChunk.superX * SUPER_CHUNK_SIZE,
      minChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE,
      maxChunkX: superChunk.superX * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
      maxChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
    };
    
    // Process in worker
    const { result, stats } = await this.superChunkWorkerPool.process({
      chunks,
      neighbors,
      bounds,
      priority: 0,
      superChunkKey: key,
    });
    
    // Create Three.js meshes from worker result (main thread only, ~2ms total)
    this._createMeshesFromWorkerResult(superChunk, result);
    
    // Track stats
    if (stats) {
      // Log first successful build
      if (!this._workerPoolLoggedOnce) {
        console.log(`[SuperChunkManager] 🚀 SuperChunkWorkerPool active: ${stats.totalTimeMs.toFixed(1)}ms per super-chunk`);
        this._workerPoolLoggedOnce = true;
      }
    }
    
    // Mark as built
    const isFirstBuild = !superChunk.hasBeenBuilt;
    superChunk.isDirty = false;
    superChunk.hasBeenBuilt = true;
    
    // Mark neighbors that need updating
    this._markNeighborsDirtyAfterBuild(superChunk, isFirstBuild);
    
    this.onSuperChunkRebuilt?.(superChunk);
  }

  /**
   * Collect neighbor chunk data for worker (raw compressed)
   */
  _collectNeighborDataForWorker(superChunk) {
    const neighbors = [];
    const superX = superChunk.superX;
    const superZ = superChunk.superZ;
    
    // Check all 8 neighboring super-chunks
    const neighborOffsets = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],          [0, 1],
      [1, -1], [1, 0], [1, 1],
    ];
    
    for (const [dx, dz] of neighborOffsets) {
      const neighborKey = `${superX + dx},${superZ + dz}`;
      const neighborSuperChunk = this.superChunks.get(neighborKey);
      if (!neighborSuperChunk) continue;
      
      for (const [, chunkInfo] of neighborSuperChunk.loadedChunks) {
        if (!chunkInfo.isRawCompressed || !chunkInfo.data) continue;
        
        // Only include chunks that are adjacent to this super-chunk's boundary
        const isAdjacent = this._isChunkAdjacentToBoundary(
          chunkInfo.chunkX, chunkInfo.chunkZ,
          superChunk.superX, superChunk.superZ
        );
        
        if (isAdjacent) {
          neighbors.push({
            chunkX: chunkInfo.chunkX,
            chunkZ: chunkInfo.chunkZ,
            compressedData: chunkInfo.data.compressedData,
            compressionType: chunkInfo.data.compressionType,
          });
        }
      }
    }
    
    return neighbors;
  }

  /**
   * Check if a chunk is adjacent to a super-chunk boundary
   */
  _isChunkAdjacentToBoundary(chunkX, chunkZ, superX, superZ) {
    const minChunkX = superX * SUPER_CHUNK_SIZE;
    const minChunkZ = superZ * SUPER_CHUNK_SIZE;
    const maxChunkX = minChunkX + SUPER_CHUNK_SIZE - 1;
    const maxChunkZ = minChunkZ + SUPER_CHUNK_SIZE - 1;
    
    // Check if chunk is directly adjacent to any edge
    const isAdjacentX = (chunkX === minChunkX - 1 || chunkX === maxChunkX + 1);
    const isAdjacentZ = (chunkZ === minChunkZ - 1 || chunkZ === maxChunkZ + 1);
    const isWithinX = chunkX >= minChunkX - 1 && chunkX <= maxChunkX + 1;
    const isWithinZ = chunkZ >= minChunkZ - 1 && chunkZ <= maxChunkZ + 1;
    
    return (isAdjacentX && isWithinZ) || (isAdjacentZ && isWithinX);
  }

  /**
   * Create Three.js meshes from worker result
   * This is the only work done on the main thread (~2ms total)
   */
  _createMeshesFromWorkerResult(superChunk, result) {
    // Solid mesh
    if (result.solid && result.solid.positions.length > 0) {
      const mesh = this._createMesh(result.solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    // Water mesh
    if (result.water && result.water.positions.length > 0) {
      const mesh = this._createMesh(result.water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    // Lava mesh
    if (result.lava && result.lava.positions.length > 0) {
      const mesh = this._createMesh(result.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        superChunk.meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    // Glass mesh
    if (result.glass && result.glass.positions.length > 0) {
      const mesh = this._createMesh(result.glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        superChunk.meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Model meshes
    if (result.models) {
      if (result.models.opaque && result.models.opaque.positions.length > 0) {
        const mesh = this._createMesh(result.models.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
        if (mesh) {
          superChunk.meshes.push(mesh);
          this.chunkManager.modelMeshes.push(mesh);
        }
      }
      
      if (result.models.transparent && result.models.transparent.positions.length > 0) {
        const mesh = this._createMesh(result.models.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
        if (mesh) {
          mesh.renderOrder = 0.5;
          superChunk.meshes.push(mesh);
          this.chunkManager.transparentModelMeshes.push(mesh);
        }
      }
    }
  }

  /**
   * Build super-chunk using unified WASM pipeline with time-slicing
   * 
   * Time-sliced approach to avoid frame drops:
   * - Decompress and decode chunks with yields between each chunk
   * - Solid meshes are created first for quick visual feedback
   * - Model meshes are deferred to avoid blocking
   * 
   * This ensures smooth camera movement even during chunk loading.
   */
  async _buildSuperChunkUnified(superChunk) {
    // Create shared grids for all chunks - enables proper boundary handling
    const chunks = [];
    const grid = new BinaryGrid();
    const stateGrid = this.enableModelMeshes ? new BlockStateGrid() : null;
    const lightGrid = new LightGrid();
    
    // Step 1: Decode ALL chunks to shared grids with yielding
    const chunkEntries = [...superChunk.loadedChunks.entries()];
    for (let i = 0; i < chunkEntries.length; i++) {
      const [key, chunkInfo] = chunkEntries[i];
      
      if (chunkInfo.isRawCompressed && chunkInfo.data) {
        const chunkData = chunkInfo.data;
        
        // Decompress and decode to shared grid
        try {
          const decompressed = chunkData.compressionType === 1 
            ? pako.ungzip(chunkData.compressedData)
            : pako.inflate(chunkData.compressedData);
          const nbt = parseNBTRaw(decompressed.buffer);
          
          const adjustedChunk = {
            x: chunkInfo.chunkX,
            z: chunkInfo.chunkZ,
            data: nbt.value
          };
          chunks.push(adjustedChunk);
          
          // Decode to shared grids (enables proper boundary handling)
          decodeChunk(adjustedChunk, grid, this.registry, stateGrid, this.stateRegistry, lightGrid);
        } catch (e) {
          console.warn(`[SuperChunkManager] ⚠️ Decode failed for chunk ${chunkInfo.chunkX},${chunkInfo.chunkZ}:`, e.message);
        }
      } else if (chunkInfo.data) {
        // Pre-parsed chunk
        const adjustedChunk = {
          x: chunkInfo.chunkX,
          z: chunkInfo.chunkZ,
          data: chunkInfo.data
        };
        chunks.push(adjustedChunk);
        decodeChunk(adjustedChunk, grid, this.registry, stateGrid, this.stateRegistry, lightGrid);
      }
      
      // Yield after each chunk to maintain responsiveness
      if (i < chunkEntries.length - 1) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    
    // Extract active beacons from block entities
    const beaconResult = extractActiveBeacons(chunks);
    
    // Extract all block entities for debug inspector (furnaces, chests, signs, etc.)
    const blockEntities = extractAllBlockEntities(chunks);
    
    // Step 2: Include data from adjacent super-chunks for proper boundary handling
    // This is CRITICAL for water face culling and smooth lighting at boundaries
    this._includeNeighborData(superChunk, grid, lightGrid);
    
    // Yield before light propagation (can be expensive)
    await new Promise(r => setTimeout(r, 0));
    
    // Handle light propagation if no Minecraft light data
    if (lightGrid.sections.size === 0) {
      propagateSkyLight(grid, lightGrid, this.registry);
      propagateBlockLight(grid, lightGrid, this.registry);
    }
    
    // Merge grid into debugGrid for block lookups (beacon color tinting, particle collision)
    if (this.chunkManager?.debugGrid) {
      this.chunkManager._mergeDebugGrid(grid);
    }
    
    // Merge block entities into ChunkManager for block inspector
    if (this.chunkManager && blockEntities.size > 0) {
      this.chunkManager._mergeBlockEntities(blockEntities);
    }
    
    // Store stateGrid and stateRegistry for block state lookups
    if (this.chunkManager && stateGrid) {
      this.chunkManager.debugStateGrid = stateGrid;
      this.chunkManager.debugStateRegistry = this.stateRegistry;
    }
    
    // Yield before meshing
    await new Promise(r => setTimeout(r, 0));
    
    // Step 3: Use WASM to mesh the combined grid (with proper boundary handling)
    const offset = { x: 0, y: 0, z: 0 };
    const bounds = {
      minChunkX: superChunk.superX * SUPER_CHUNK_SIZE,
      minChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE,
      maxChunkX: superChunk.superX * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
      maxChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
    };
    
    // Mesh solid/fluid/glass using WASM on the combined grid
    const meshResult = wasmMeshChunk(grid, lightGrid, stateGrid, bounds);
    
    // Create Three.js meshes - solid first for quick visual feedback
    if (meshResult.solid && meshResult.solid.positions.length > 0) {
      const mesh = this._createMesh(meshResult.solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    // Yield after solid mesh to allow rendering
    await new Promise(r => setTimeout(r, 0));
    
    if (meshResult.water && meshResult.water.positions.length > 0) {
      const mesh = this._createMesh(meshResult.water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    if (meshResult.lava && meshResult.lava.positions.length > 0) {
      const mesh = this._createMesh(meshResult.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        superChunk.meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    if (meshResult.glass && meshResult.glass.positions.length > 0) {
      const mesh = this._createMesh(meshResult.glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        superChunk.meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Track if this is the first build (before we set hasBeenBuilt)
    const isFirstBuild = !superChunk.hasBeenBuilt;
    
    // Mark as built early so solid geometry is visible immediately
    // Model meshes will be added below but terrain is already visible
    superChunk.isDirty = false;
    superChunk.hasBeenBuilt = true;
    
    // Mark neighbors that need updating now that we have complete data
    // Only on first build - rebuilds shouldn't cascade to neighbors
    this._markNeighborsDirtyAfterBuild(superChunk, isFirstBuild);
    
    // Yield to allow solid meshes to render before building model meshes
    await new Promise(r => setTimeout(r, 0));
    
    // Build model meshes using JS (requires full state resolution)
    // This is deferred so solid geometry is visible first
    if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
      await this.stateRegistry.precomputeAll();
      
      // Yield after precompute
      await new Promise(r => setTimeout(r, 0));
      
      const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
      const collectEmitters = this.chunkManager.particleQuality !== 'off';
      // When smooth lighting is disabled, pass null to skip per-vertex light calculation
      const effectiveLightGrid = this.chunkManager.smoothLightingEnabled ? lightGrid : null;
      const mesherOptions = { textureIndexLookup, lightGrid: effectiveLightGrid, collectEmitters };
      
      const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
      
      if (modelResult) {
        if (modelResult.opaque && modelResult.opaque.positions.length > 0) {
          const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
          if (mesh) {
            superChunk.meshes.push(mesh);
            this.chunkManager.modelMeshes.push(mesh);
          }
        }
        
        if (modelResult.transparent && modelResult.transparent.positions.length > 0) {
          const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
          if (mesh) {
            mesh.renderOrder = 0.5;
            superChunk.meshes.push(mesh);
            this.chunkManager.transparentModelMeshes.push(mesh);
          }
        }
        
        if (modelResult.overlay && modelResult.overlay.positions.length > 0) {
          const mesh = this._createMesh(modelResult.overlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
          if (mesh) {
            mesh.renderOrder = 4;
            superChunk.meshes.push(mesh);
            this.chunkManager.overlayModelMeshes.push(mesh);
          }
        }
        
        // Register beacon positions
        if (modelResult.beaconPositions && modelResult.beaconPositions.length > 0) {
          const beaconsToRegister = modelResult.beaconPositions.filter(pos => {
            const key = `${pos.x},${pos.y},${pos.z}`;
            if (beaconResult?.inactive?.has(key)) return false;
            return true;
          });
          
          const beaconBeamManager = this.chunkManager.beaconBeamManager;
          if (beaconBeamManager && beaconsToRegister.length > 0) {
            for (const pos of beaconsToRegister) {
              beaconBeamManager.addBeacon(pos.x, pos.y, pos.z);
            }
          }
        }
        
        // Register particle emitters from JS ModelMesher (includes full properties)
        // This is more complete than WASM emitters as it has facing, lit, candles, etc.
        if (modelResult.particleEmitters && modelResult.particleEmitters.length > 0) {
          const emitterManager = this.chunkManager.particleEmitterManager;
          if (emitterManager) {
            for (const emitter of modelResult.particleEmitters) {
              emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
            }
          }
        }
      }
    }
    
    this.onSuperChunkRebuilt?.(superChunk);
  }

  /**
   * Merge mesh data arrays, adjusting indices for the vertex offset
   */
  _mergeMeshData(target, source) {
    if (!source || source.vertexCount === 0) return;
    
    const vertexOffset = target.vertexCount;
    
    // Append position/normal/color data
    target.positions.push(...source.positions);
    target.normals.push(...source.normals);
    target.colors.push(...source.colors);
    
    // Optional arrays (may not exist on all mesh types)
    if (source.texIndices) target.texIndices.push(...source.texIndices);
    if (source.texRotations) target.texRotations.push(...source.texRotations);
    if (source.tintTypes) target.tintTypes.push(...source.tintTypes);
    if (source.uvs) target.uvs.push(...source.uvs);
    if (source.skyLight) target.skyLight.push(...source.skyLight);
    if (source.blockLight) target.blockLight.push(...source.blockLight);
    
    // Adjust and append indices
    for (let i = 0; i < source.indices.length; i++) {
      target.indices.push(source.indices[i] + vertexOffset);
    }
    
    target.vertexCount += source.vertexCount;
  }

  /**
   * Create Three.js meshes from mesh data produced by unified WASM pipeline
   */
  _createMeshesFromData(superChunk, meshData, offset, beaconResult) {
    // Solid mesh
    if (meshData.solid && meshData.solid.positions.length > 0) {
      const data = this._convertArraysToTypedArrays(meshData.solid);
      const mesh = this._createMesh(data, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    // Water mesh
    if (meshData.water && meshData.water.positions.length > 0) {
      const data = this._convertArraysToTypedArrays(meshData.water);
      const mesh = this._createMesh(data, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    // Lava mesh
    if (meshData.lava && meshData.lava.positions.length > 0) {
      const data = this._convertArraysToTypedArrays(meshData.lava);
      const mesh = this._createMesh(data, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        superChunk.meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    // Glass mesh
    if (meshData.glass && meshData.glass.positions.length > 0) {
      const data = this._convertArraysToTypedArrays(meshData.glass);
      const mesh = this._createMesh(data, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        superChunk.meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Note: Model meshes are not yet supported in unified pipeline
    // They require block state data which isn't decoded by WASM yet
  }

  /**
   * Convert regular arrays to typed arrays for Three.js
   */
  _convertArraysToTypedArrays(data) {
    return {
      positions: data.positions instanceof Float32Array ? data.positions : new Float32Array(data.positions),
      normals: data.normals instanceof Float32Array ? data.normals : new Float32Array(data.normals),
      colors: data.colors instanceof Float32Array ? data.colors : new Float32Array(data.colors),
      texIndices: data.texIndices ? (data.texIndices instanceof Float32Array ? data.texIndices : new Float32Array(data.texIndices)) : null,
      texRotations: data.texRotations ? (data.texRotations instanceof Float32Array ? data.texRotations : new Float32Array(data.texRotations)) : null,
      tintTypes: data.tintTypes ? (data.tintTypes instanceof Float32Array ? data.tintTypes : new Float32Array(data.tintTypes)) : null,
      uvs: data.uvs ? (data.uvs instanceof Float32Array ? data.uvs : new Float32Array(data.uvs)) : null,
      skyLight: data.skyLight ? (data.skyLight instanceof Float32Array ? data.skyLight : new Float32Array(data.skyLight)) : null,
      blockLight: data.blockLight ? (data.blockLight instanceof Float32Array ? data.blockLight : new Float32Array(data.blockLight)) : null,
      indices: data.indices instanceof Uint32Array ? data.indices : new Uint32Array(data.indices),
      vertexCount: data.vertexCount,
    };
  }

  /**
   * Include data from adjacent chunks to prevent issues at boundaries.
   * This decodes light AND blocks from chunks that border this super-chunk.
   * - Light: prevents hard lighting cutoffs
   * - Blocks: enables correct fluid height calculation and face culling
   */
  _includeNeighborData(superChunk, grid, lightGrid) {
    const sx = superChunk.superX;
    const sz = superChunk.superZ;
    
    // Calculate the chunk coordinate ranges for this super-chunk
    const minChunkX = sx * SUPER_CHUNK_SIZE;
    const maxChunkX = minChunkX + SUPER_CHUNK_SIZE - 1;
    const minChunkZ = sz * SUPER_CHUNK_SIZE;
    const maxChunkZ = minChunkZ + SUPER_CHUNK_SIZE - 1;
    
    // Check 8 adjacent super-chunks (N, S, E, W, NE, NW, SE, SW)
    const neighborOffsets = [
      { dx: -1, dz: 0 },  // West
      { dx: 1, dz: 0 },   // East
      { dx: 0, dz: -1 },  // North
      { dx: 0, dz: 1 },   // South
      { dx: -1, dz: -1 }, // Northwest
      { dx: 1, dz: -1 },  // Northeast
      { dx: -1, dz: 1 },  // Southwest
      { dx: 1, dz: 1 },   // Southeast
    ];
    
    for (const { dx, dz } of neighborOffsets) {
      const neighborKey = `${sx + dx},${sz + dz}`;
      const neighborSuperChunk = this.superChunks.get(neighborKey);
      
      if (!neighborSuperChunk) continue;
      
      // Get the border chunks from the neighbor super-chunk
      // We only need chunks that are adjacent to our border
      for (const [key, chunkInfo] of neighborSuperChunk.loadedChunks) {
        if (!chunkInfo.data) continue;
        
        const cx = chunkInfo.chunkX;
        const cz = chunkInfo.chunkZ;
        
        // Check if this chunk is adjacent to our super-chunk border
        const isAdjacentX = (dx === -1 && cx === minChunkX - 1) || 
                           (dx === 1 && cx === maxChunkX + 1);
        const isAdjacentZ = (dz === -1 && cz === minChunkZ - 1) || 
                           (dz === 1 && cz === maxChunkZ + 1);
        const isInRangeX = cx >= minChunkX - 1 && cx <= maxChunkX + 1;
        const isInRangeZ = cz >= minChunkZ - 1 && cz <= maxChunkZ + 1;
        
        // Include if chunk borders our super-chunk
        const shouldInclude = (isAdjacentX && isInRangeZ) || (isAdjacentZ && isInRangeX);
        
        if (shouldInclude) {
          // Handle both pre-parsed NBT and raw compressed data
          let chunkData = chunkInfo.data;
          
          // Check if this is raw compressed data (from unified pipeline)
          if (chunkInfo.isRawCompressed && chunkData.compressedData) {
            try {
              const decompressed = chunkData.compressionType === 1 
                ? pako.ungzip(chunkData.compressedData)
                : pako.inflate(chunkData.compressedData);
              const nbt = parseNBTRaw(decompressed.buffer);
              chunkData = nbt.value;
            } catch (e) {
              // Skip this neighbor chunk if decompression fails
              continue;
            }
          }
          
          const adjustedChunk = {
            x: cx,
            z: cz,
            data: chunkData
          };
          // Decode blocks and light from neighbor chunk using the standard decoder
          // This ensures correct handling of all Minecraft formats
          decodeChunk(adjustedChunk, grid, this.registry, null, null, lightGrid);
        }
      }
    }
  }
  
  /**
   * Mark all adjacent super-chunks as needing rebuild after THIS super-chunk is built.
   * 
   * This is called AFTER buildSuperChunk completes, ensuring that when neighbors
   * rebuild, they will have access to our complete data via _includeNeighborData.
   * 
   * Only marks neighbors that:
   * 1. Exist (have been created)
   * 2. Have been built BEFORE us (are visible, so artifacts would be visible)
   * 3. Haven't already seen our data (tracked via neighbor set)
   * 
   * @param {SuperChunk} superChunk - The super-chunk that was just built
   * @param {boolean} isFirstBuild - True if this is the first build (not a rebuild)
   */
  _markNeighborsDirtyAfterBuild(superChunk, isFirstBuild) {
    // Only mark neighbors on first build - not on rebuilds
    // Rebuilds happen BECAUSE neighbor data changed, so marking neighbors
    // would cause an infinite loop
    if (!isFirstBuild) return;
    
    const sx = superChunk.superX;
    const sz = superChunk.superZ;
    
    // Check all 8 adjacent super-chunks
    const neighborOffsets = [
      { dx: -1, dz: 0 },  // West
      { dx: 1, dz: 0 },   // East
      { dx: 0, dz: -1 },  // North
      { dx: 0, dz: 1 },   // South
      { dx: -1, dz: -1 }, // Northwest
      { dx: 1, dz: -1 },  // Northeast
      { dx: -1, dz: 1 },  // Southwest
      { dx: 1, dz: 1 },   // Southeast
    ];
    
    for (const { dx, dz } of neighborOffsets) {
      const key = `${sx + dx},${sz + dz}`;
      const neighbor = this.superChunks.get(key);
      
      if (neighbor && neighbor.hasBeenBuilt) {
        // Neighbor was built before us, so it doesn't have our data
        // Mark it for rebuild so it can include our blocks/light
        this.boundaryDirtySet.add(key);
        this.dirtySet.add(key);
      }
    }
  }


  /**
   * Build super-chunk meshes using worker pool (offloads meshing to worker threads)
   */
  async _buildSuperChunkWithWorker(superChunk, grid, stateGrid, lightGrid, offset) {
    // Export grids for worker transfer
    const gridData = grid.export();
    const lightGridData = lightGrid.export();
    const stateGridData = stateGrid ? stateGrid.export() : null;
    
    // Calculate priority based on distance to camera (lower = higher priority)
    const cameraPos = this.chunkManager.camera?.position || { x: 0, z: 0 };
    const superChunkCenterX = superChunk.superX * BLOCKS_PER_SUPER_CHUNK + BLOCKS_PER_SUPER_CHUNK / 2;
    const superChunkCenterZ = superChunk.superZ * BLOCKS_PER_SUPER_CHUNK + BLOCKS_PER_SUPER_CHUNK / 2;
    const dx = cameraPos.x - superChunkCenterX;
    const dz = cameraPos.z - superChunkCenterZ;
    const priority = Math.sqrt(dx * dx + dz * dz);
    
    // Options for the worker
    const options = {
      stateGridData,
      enableModelMeshes: this.enableModelMeshes,
    };
    
    try {
      // Send meshing job to worker
      const meshResult = await this.workerPool.meshChunk(gridData, lightGridData, offset, options, priority);
      
      // Create Three.js meshes from returned data
      this._createMeshesFromWorkerResult(superChunk, meshResult);
    } catch (error) {
      console.error('[SuperChunkManager] Worker meshing failed, falling back to main thread:', error);
      // Fall back to main thread on error
      await this._buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset);
    }
  }

  /**
   * Build super-chunk meshes using WASM mesher (fastest)
   */
  async _buildSuperChunkWithWasm(superChunk, grid, stateGrid, lightGrid, offset, beaconResult = null) {
    try {
      const startTime = performance.now();
      
      // Log first use of WASM meshing
      if (!this._wasmLoggedOnce) {
        console.log('[SuperChunkManager] 🚀 Using WASM mesher for chunk generation');
        this._wasmLoggedOnce = true;
      }
      
      // Calculate bounds for this super-chunk (only render blocks within these chunks)
      // Neighbor chunk data is included for boundary lookups but won't generate geometry
      const bounds = {
        minChunkX: superChunk.superX * SUPER_CHUNK_SIZE,
        minChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE,
        maxChunkX: superChunk.superX * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
        maxChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
      };
      
      // Run WASM mesher for solid/fluid/glass with bounds
      // When smooth lighting is disabled, pass null to skip per-vertex light calculation
      const effectiveLightGrid = this.chunkManager.smoothLightingEnabled ? lightGrid : null;
      const meshResult = wasmMeshChunk(grid, effectiveLightGrid, stateGrid, bounds);
      
      const wasmTime = performance.now() - startTime;
      
      // Create Three.js meshes from WASM results
      if (meshResult.solid && meshResult.solid.positions.length > 0) {
        const mesh = this._createMesh(meshResult.solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
        if (mesh) {
          superChunk.meshes.push(mesh);
          this.chunkManager.solidMeshes.push(mesh);
        }
      }
      
      if (meshResult.water && meshResult.water.positions.length > 0) {
        const mesh = this._createMesh(meshResult.water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
        if (mesh) {
          mesh.renderOrder = 2;
          superChunk.meshes.push(mesh);
          this.chunkManager.waterMeshes.push(mesh);
        }
      }
      
      if (meshResult.lava && meshResult.lava.positions.length > 0) {
        const mesh = this._createMesh(meshResult.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
        if (mesh) {
          mesh.renderOrder = 3;
          superChunk.meshes.push(mesh);
          this.chunkManager.lavaMeshes.push(mesh);
        }
      }
      
      if (meshResult.glass && meshResult.glass.positions.length > 0) {
        const mesh = this._createMesh(meshResult.glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
        if (mesh) {
          mesh.renderOrder = 1;
          superChunk.meshes.push(mesh);
          this.chunkManager.glassMeshes.push(mesh);
        }
      }
      
      // Model meshes still use JS (WASM model meshing is a placeholder)
      // This is because model geometry requires complex JSON data
      if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
        await this.stateRegistry.precomputeAll();
        
        const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
        const collectEmitters = this.chunkManager.particleQuality !== 'off';
        // Use effectiveLightGrid to skip smooth lighting when disabled
        const mesherOptions = { textureIndexLookup, lightGrid: effectiveLightGrid, collectEmitters };
        
        const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
        
        if (modelResult) {
          if (modelResult.opaque && modelResult.opaque.positions.length > 0) {
            const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
            if (mesh) {
              superChunk.meshes.push(mesh);
              this.chunkManager.modelMeshes.push(mesh);
            }
          }
          
          if (modelResult.transparent && modelResult.transparent.positions.length > 0) {
            const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
            if (mesh) {
              mesh.renderOrder = 0.5;
              superChunk.meshes.push(mesh);
              this.chunkManager.transparentModelMeshes.push(mesh);
            }
          }
          
          if (modelResult.overlay && modelResult.overlay.positions.length > 0) {
            const mesh = this._createMesh(modelResult.overlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
            if (mesh) {
              mesh.renderOrder = 4;
              superChunk.meshes.push(mesh);
              this.chunkManager.overlayModelMeshes.push(mesh);
            }
          }
          
          // Register particle emitters if collected
          if (modelResult.particleEmitters && modelResult.particleEmitters.length > 0) {
            this.chunkManager._registerParticleEmitters?.(modelResult.particleEmitters);
          }
          
          // Register beacon positions for beam rendering (filtered by block entity data)
          if (modelResult.beaconPositions && modelResult.beaconPositions.length > 0) {
            // Filter beacons:
            // - Show if in active set (Levels > 0)
            // - Hide if in inactive set (Levels = 0) 
            // - Show if no block entity data (fallback for old worlds)
            const beaconsToRegister = modelResult.beaconPositions.filter(pos => {
              const key = `${pos.x},${pos.y},${pos.z}`;
              
              // If explicitly marked as inactive (Levels = 0), don't show
              if (beaconResult?.inactive?.has(key)) {
                return false;
              }
              
              // Show if active OR if no block entity data exists for this beacon
              return true;
            });
            
            if (beaconsToRegister.length > 0) {
              this.chunkManager._registerBeacons?.(beaconsToRegister);
            }
          }
        }
      }
      
      // Debug timing (uncomment for profiling)
      // console.log(`[WASM] Meshed super-chunk in ${wasmTime.toFixed(1)}ms`);
      
    } catch (error) {
      console.error('[SuperChunkManager] WASM meshing failed, falling back to JS:', error);
      // Fall back to JavaScript meshing on error
      await this._buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset, beaconResult);
    }
  }

  /**
   * Build super-chunk meshes on main thread (fallback)
   */
  async _buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset, beaconResult = null) {
    const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
    // Skip particle emitter collection when particles are off
    const collectEmitters = this.chunkManager.particleQuality !== 'off';
    // When smooth lighting is disabled, pass null to skip per-vertex light calculation
    const effectiveLightGrid = this.chunkManager.smoothLightingEnabled ? lightGrid : null;
    const mesherOptions = { textureIndexLookup, lightGrid: effectiveLightGrid, collectEmitters };
    
    // Build solid/fluid/glass meshes
    const { solid, water, lava, glass } = buildGridMeshes(grid, this.registry, offset, mesherOptions);
    
    // Create and add meshes
    if (solid && solid.positions.length > 0) {
      const mesh = this._createMesh(solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    if (water && water.positions.length > 0) {
      const mesh = this._createMesh(water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    if (lava && lava.positions.length > 0) {
      const mesh = this._createMesh(lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        superChunk.meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    if (glass && glass.positions.length > 0) {
      const mesh = this._createMesh(glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        superChunk.meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Build model meshes if enabled
    if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
      await this.stateRegistry.precomputeAll();
      
      const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
      
      if (modelResult) {
        if (modelResult.opaque && modelResult.opaque.positions.length > 0) {
          const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
          if (mesh) {
            superChunk.meshes.push(mesh);
            this.chunkManager.modelMeshes.push(mesh);
          }
        }
        
        if (modelResult.transparent && modelResult.transparent.positions.length > 0) {
          const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
          if (mesh) {
            mesh.renderOrder = 0.5;
            superChunk.meshes.push(mesh);
            this.chunkManager.transparentModelMeshes.push(mesh);
          }
        }
        
        if (modelResult.overlay && modelResult.overlay.positions.length > 0) {
          const mesh = this._createMesh(modelResult.overlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
          if (mesh) {
            mesh.renderOrder = 4;
            superChunk.meshes.push(mesh);
            this.chunkManager.overlayModelMeshes.push(mesh);
          }
        }
        
        // Register particle emitters
        if (modelResult.particleEmitters && modelResult.particleEmitters.length > 0) {
          const emitterManager = this.chunkManager.particleEmitterManager;
          if (emitterManager) {
            for (const emitter of modelResult.particleEmitters) {
              emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
            }
          }
        }
        
        // Register beacon positions for beam rendering (filtered by block entity data)
        if (modelResult.beaconPositions && modelResult.beaconPositions.length > 0) {
          // Filter beacons:
          // - Show if in active set (Levels > 0)
          // - Hide if in inactive set (Levels = 0) 
          // - Show if no block entity data (fallback for old worlds)
          const beaconsToRegister = modelResult.beaconPositions.filter(pos => {
            const key = `${pos.x},${pos.y},${pos.z}`;
            
            // If explicitly marked as inactive (Levels = 0), don't show
            if (beaconResult?.inactive?.has(key)) {
              return false;
            }
            
            // Show if active OR if no block entity data exists for this beacon
            return true;
          });
          
          if (beaconsToRegister.length > 0) {
            this.chunkManager._registerBeacons?.(beaconsToRegister);
          }
        }
      }
    }
  }
    
  /**
   * Create Three.js meshes from worker result data
   */
  _createMeshesFromWorkerResult(superChunk, meshResult) {
    if (!meshResult) return;
    
    // Helper to check if mesh data has vertices
    // ArrayBuffer uses byteLength, TypedArrays use length
    const hasVertices = (data) => {
      if (!data || !data.positions) return false;
      const size = data.positions.byteLength ?? data.positions.length;
      return size > 0;
    };
    
    // Process solid meshes
    if (hasVertices(meshResult.solid)) {
      const mesh = this._createMeshFromData(meshResult.solid, this.chunkManager.solidMaterial, this.chunkManager.solidGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.solidMeshes.push(mesh);
      }
    }
    
    // Process water meshes
    if (hasVertices(meshResult.water)) {
      const mesh = this._createMeshFromData(meshResult.water, this.chunkManager.waterMaterial, this.chunkManager.waterGroup);
      if (mesh) {
        mesh.renderOrder = 2;
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    // Process lava meshes
    if (hasVertices(meshResult.lava)) {
      const mesh = this._createMeshFromData(meshResult.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 3;
        superChunk.meshes.push(mesh);
        this.chunkManager.lavaMeshes.push(mesh);
      }
    }
    
    // Process glass meshes
    if (hasVertices(meshResult.glass)) {
      const mesh = this._createMeshFromData(meshResult.glass, this.chunkManager.glassMaterial, this.chunkManager.glassGroup);
      if (mesh) {
        mesh.renderOrder = 1;
        superChunk.meshes.push(mesh);
        this.chunkManager.glassMeshes.push(mesh);
      }
    }
    
    // Process model meshes
    if (meshResult.model) {
      if (hasVertices(meshResult.model.opaque)) {
        const mesh = this._createMeshFromData(meshResult.model.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
        if (mesh) {
          superChunk.meshes.push(mesh);
          this.chunkManager.modelMeshes.push(mesh);
        }
      }
      
      if (hasVertices(meshResult.model.transparent)) {
        const mesh = this._createMeshFromData(meshResult.model.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
        if (mesh) {
          mesh.renderOrder = 0.5;
          superChunk.meshes.push(mesh);
          this.chunkManager.transparentModelMeshes.push(mesh);
        }
      }
      
      if (hasVertices(meshResult.model.overlay)) {
        const mesh = this._createMeshFromData(meshResult.model.overlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
        if (mesh) {
          mesh.renderOrder = 4;
          superChunk.meshes.push(mesh);
          this.chunkManager.overlayModelMeshes.push(mesh);
        }
      }
      
      // Register particle emitters
      if (meshResult.model.particleEmitters && meshResult.model.particleEmitters.length > 0) {
        const emitterManager = this.chunkManager.particleEmitterManager;
        if (emitterManager) {
          for (const emitter of meshResult.model.particleEmitters) {
            emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
          }
        }
      }
    }
  }

  /**
   * Create a Three.js mesh from worker data (ArrayBuffer based)
   */
  _createMeshFromData(data, material, group) {
    if (!data || !material || !group) return null;
    
    // Convert ArrayBuffers back to typed arrays
    const positions = data.positions instanceof ArrayBuffer 
      ? new Float32Array(data.positions) 
      : data.positions;
    const normals = data.normals instanceof ArrayBuffer
      ? new Float32Array(data.normals)
      : data.normals;
    const indices = data.indices instanceof ArrayBuffer
      ? new Uint32Array(data.indices)
      : data.indices;
    
    if (!positions || positions.length === 0) return null;
    if (!normals || normals.length === 0) return null;
    if (!indices || indices.length === 0) return null;
    
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    
    if (data.colors) {
      const colors = data.colors instanceof ArrayBuffer
        ? new Float32Array(data.colors)
        : data.colors;
      if (colors && colors.length > 0) {
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      }
    }
    
    if (data.uvs) {
      const uvs = data.uvs instanceof ArrayBuffer
        ? new Float32Array(data.uvs)
        : data.uvs;
      if (uvs && uvs.length > 0) {
        geometry.setAttribute('modelUV', new THREE.BufferAttribute(uvs, 2));
      }
    }
    
    if (data.modelUVs) {
      const modelUVs = data.modelUVs instanceof ArrayBuffer
        ? new Float32Array(data.modelUVs)
        : data.modelUVs;
      if (modelUVs && modelUVs.length > 0) {
        geometry.setAttribute('modelUV', new THREE.BufferAttribute(modelUVs, 2));
      }
    }
    
    if (data.texIndices) {
      const texIndices = data.texIndices instanceof ArrayBuffer
        ? new Float32Array(data.texIndices)
        : data.texIndices;
      if (texIndices && texIndices.length > 0) {
        geometry.setAttribute('texIndex', new THREE.BufferAttribute(texIndices, 1));
      }
    }
    
    if (data.texRotations) {
      const texRotations = data.texRotations instanceof ArrayBuffer
        ? new Float32Array(data.texRotations)
        : data.texRotations;
      if (texRotations && texRotations.length > 0) {
        geometry.setAttribute('texRotation', new THREE.BufferAttribute(texRotations, 1));
      }
    }
    
    if (data.tintTypes) {
      const tintTypes = data.tintTypes instanceof ArrayBuffer
        ? new Float32Array(data.tintTypes)
        : data.tintTypes;
      if (tintTypes && tintTypes.length > 0) {
        geometry.setAttribute('tintType', new THREE.BufferAttribute(tintTypes, 1));
      }
    }
    
    if (data.shadeFlags) {
      const shadeFlags = data.shadeFlags instanceof ArrayBuffer
        ? new Float32Array(data.shadeFlags)
        : data.shadeFlags;
      if (shadeFlags && shadeFlags.length > 0) {
        geometry.setAttribute('shadeFlag', new THREE.BufferAttribute(shadeFlags, 1));
      }
    }
    
    if (data.singleSided) {
      const singleSided = data.singleSided instanceof ArrayBuffer
        ? new Float32Array(data.singleSided)
        : data.singleSided;
      if (singleSided && singleSided.length > 0) {
        geometry.setAttribute('singleSided', new THREE.BufferAttribute(singleSided, 1));
      }
    }
    
    if (data.skyLight) {
      const skyLight = data.skyLight instanceof ArrayBuffer
        ? new Float32Array(data.skyLight)
        : data.skyLight;
      if (skyLight && skyLight.length > 0) {
        geometry.setAttribute('skyLight', new THREE.BufferAttribute(skyLight, 1));
      }
    }
    
    if (data.blockLight) {
      const blockLight = data.blockLight instanceof ArrayBuffer
        ? new Float32Array(data.blockLight)
        : data.blockLight;
      if (blockLight && blockLight.length > 0) {
        geometry.setAttribute('blockLight', new THREE.BufferAttribute(blockLight, 1));
      }
    }
    
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    // Store super-chunk center for visibility calculations
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    mesh.userData.chunkCenterX = center.x;
    mesh.userData.chunkCenterZ = center.z;
    
    group.add(mesh);
    
    return mesh;
  }

  /**
   * Rebuild all dirty super-chunks with frame budget awareness
   * 
   * PRIORITY ORDER:
   * 1. Boundary-dirty chunks (already built, have visible artifacts) - HIGHEST
   * 2. Regular dirty chunks (new chunks needing initial build)
   * 
   * @param {number} maxRebuilds - Maximum number of super-chunks to rebuild per call
   * @param {number} budgetMs - Maximum time budget in ms (0 = no limit)
   * @returns {number} Number of super-chunks rebuilt
   */
  async rebuildDirty(maxRebuilds = 2, budgetMs = 0) {
    const totalDirty = this.dirtySet.size + this.boundaryDirtySet.size;
    if (totalDirty === 0) return 0;
    
    // Prioritize boundary-dirty chunks (visible artifacts) over new chunks
    // Build the list: boundary-dirty first, then regular dirty
    const keysToRebuild = [];
    
    // First add boundary-dirty (already visible, have artifacts)
    for (const key of this.boundaryDirtySet) {
      if (keysToRebuild.length >= maxRebuilds) break;
      keysToRebuild.push(key);
    }
    
    // Then add regular dirty (new chunks, not yet visible)
    if (keysToRebuild.length < maxRebuilds) {
      for (const key of this.dirtySet) {
        if (keysToRebuild.length >= maxRebuilds) break;
        // Skip if already in the list (boundary-dirty are also in dirtySet)
        if (!this.boundaryDirtySet.has(key)) {
          keysToRebuild.push(key);
        }
      }
    }
    
    if (keysToRebuild.length === 0) return 0;
    
    // Check if we can use parallel worker pool dispatch
    const canUseParallel = this.useSuperChunkWorkerPool && this.superChunkWorkerPoolInitialized;
    
    if (canUseParallel) {
      // PARALLEL PATH: Dispatch all jobs to workers at once, await all results
      return await this._rebuildDirtyParallel(keysToRebuild);
    }
    
    // SEQUENTIAL PATH: Fallback for non-worker builds
    let rebuiltCount = 0;
    const startTime = performance.now();
    
    for (const key of keysToRebuild) {
      // Check budget if specified
      if (budgetMs > 0 && (performance.now() - startTime) >= budgetMs) {
        break; // Exceeded time budget
      }
      
      const superChunk = this.superChunks.get(key);
      if (superChunk) {
        const oldMeshes = [...superChunk.meshes];
        await this.buildSuperChunk(superChunk, true);
        this._disposeOldMeshes(oldMeshes);
        rebuiltCount++;
      }
      this.dirtySet.delete(key);
      this.boundaryDirtySet.delete(key);
    }
    
    return rebuiltCount;
  }

  /**
   * Parallel rebuild using worker pool - dispatches all jobs at once
   * This maximizes worker utilization for much higher throughput
   */
  async _rebuildDirtyParallel(keysToRebuild) {
    // Collect all super-chunks and their old meshes
    const buildJobs = [];
    
    for (const key of keysToRebuild) {
      const superChunk = this.superChunks.get(key);
      if (!superChunk) continue;
      
      // Check if we can use worker pool for this chunk
      const hasRawCompressed = [...superChunk.loadedChunks.values()].some(c => c.isRawCompressed);
      if (!hasRawCompressed) continue;
      
      // Store old meshes to dispose after new ones are ready
      const oldMeshes = [...superChunk.meshes];
      superChunk.meshes = [];
      
      // Collect job data
      const chunks = [];
      for (const [, chunkInfo] of superChunk.loadedChunks) {
        if (!chunkInfo.isRawCompressed || !chunkInfo.data) continue;
        chunks.push({
          chunkX: chunkInfo.chunkX,
          chunkZ: chunkInfo.chunkZ,
          compressedData: chunkInfo.data.compressedData,
          compressionType: chunkInfo.data.compressionType,
        });
      }
      
      if (chunks.length === 0) continue;
      
      const neighbors = this._collectNeighborDataForWorker(superChunk);
      const bounds = {
        minChunkX: superChunk.superX * SUPER_CHUNK_SIZE,
        minChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE,
        maxChunkX: superChunk.superX * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
        maxChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
      };
      
      buildJobs.push({
        key,
        superChunk,
        oldMeshes,
        jobData: { chunks, neighbors, bounds, priority: 0, superChunkKey: key },
      });
      
      // Mark as no longer dirty immediately (prevents re-queuing)
      this.dirtySet.delete(key);
      this.boundaryDirtySet.delete(key);
    }
    
    if (buildJobs.length === 0) return 0;
    
    // Dispatch ALL jobs to worker pool in parallel
    const jobPromises = buildJobs.map(job => 
      this.superChunkWorkerPool.process(job.jobData)
        .then(result => ({ job, result }))
        .catch(error => ({ job, error }))
    );
    
    // Wait for all jobs to complete
    const results = await Promise.all(jobPromises);
    
    // Process all results - create meshes and dispose old ones
    let rebuiltCount = 0;
    for (const { job, result, error } of results) {
      if (error) {
        console.warn(`[SuperChunkManager] Parallel build failed for ${job.key}:`, error.message);
        // Re-add to dirty set for retry
        this.dirtySet.add(job.key);
        continue;
      }
      
      // Create meshes from worker result
      this._createMeshesFromWorkerResult(job.superChunk, result.result);
      
      // Dispose old meshes
      this._disposeOldMeshes(job.oldMeshes);
      
      // Mark as built
      job.superChunk.isDirty = false;
      job.superChunk.hasBeenBuilt = true;
      
      rebuiltCount++;
    }
    
    // Single yield after all work is done
    if (rebuiltCount > 0) {
      this.onSuperChunkRebuilt?.();
    }
    
    return rebuiltCount;
  }

  /**
   * Helper to dispose old meshes
   */
  _disposeOldMeshes(oldMeshes) {
    for (const mesh of oldMeshes) {
      if (this.chunkManager.solidMeshes) removeFromArray(this.chunkManager.solidMeshes, mesh);
      if (this.chunkManager.waterMeshes) removeFromArray(this.chunkManager.waterMeshes, mesh);
      if (this.chunkManager.lavaMeshes) removeFromArray(this.chunkManager.lavaMeshes, mesh);
      if (this.chunkManager.glassMeshes) removeFromArray(this.chunkManager.glassMeshes, mesh);
      if (this.chunkManager.modelMeshes) removeFromArray(this.chunkManager.modelMeshes, mesh);
      if (this.chunkManager.beaconMeshes) removeFromArray(this.chunkManager.beaconMeshes, mesh);
      if (this.chunkManager.transparentModelMeshes) removeFromArray(this.chunkManager.transparentModelMeshes, mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.parent) mesh.parent.remove(mesh);
    }
  }
  
  /**
   * Schedule rebuild using requestIdleCallback for non-blocking updates
   * Used during player movement to avoid frame drops
   * 
   * IMPORTANT: Boundary-dirty chunks (visible artifacts) get higher priority
   * even during movement to fix stitching issues quickly.
   * 
   * @param {boolean} lowPriority - If true, use longer timeout and smaller batches
   */
  scheduleIdleRebuild(lowPriority = false) {
    if (this._idleCallbackId) return; // Already scheduled
    
    const callback = async (deadline) => {
      this._idleCallbackId = null;
      
      const totalDirty = this.dirtySet.size + this.boundaryDirtySet.size;
      if (totalDirty === 0) return;
      
      // Boundary-dirty chunks (visible artifacts) should be processed faster
      // even during movement - these are the "seam" artifacts users see
      const hasBoundaryDirty = this.boundaryDirtySet.size > 0;
      
      // When we have boundary artifacts, be more aggressive:
      // - Use higher time budget
      // - Process more chunks per callback
      // - Use shorter delays between callbacks
      let budgetMs, chunksToMesh, nextDelay;
      
      // When using parallel worker pool, we can process many more chunks at once
      // since the main thread just dispatches and waits
      const canUseParallel = this.useSuperChunkWorkerPool && this.superChunkWorkerPoolInitialized;
      const parallelMultiplier = canUseParallel ? 4 : 1; // Process 4x more with parallel
      
      if (hasBoundaryDirty) {
        // High priority for visible artifacts - fix seams quickly
        budgetMs = 0; // No budget limit when parallel
        chunksToMesh = Math.max(4, this.meshingSpeed * parallelMultiplier);
        nextDelay = 4;  // Fast follow-up
      } else if (lowPriority) {
        // Low priority during streaming - but still batch multiple with parallel
        budgetMs = canUseParallel ? 0 : 8;
        chunksToMesh = canUseParallel ? Math.max(4, this.meshingSpeed * 2) : 1;
        nextDelay = canUseParallel ? 8 : 24;
      } else {
        // Normal priority when queue is stable
        budgetMs = canUseParallel ? 0 : 12;
        chunksToMesh = this.meshingSpeed * parallelMultiplier;
        nextDelay = canUseParallel ? 4 : 16;
      }
      
      await this.rebuildDirty(chunksToMesh, budgetMs);
      
      // Schedule another callback if more rebuilds needed
      if (this.dirtySet.size > 0 || this.boundaryDirtySet.size > 0) {
        // Use setTimeout for consistent scheduling - rIC has variable delays
        setTimeout(() => this.scheduleIdleRebuild(lowPriority), nextDelay);
      }
    };
    
    // When boundary artifacts exist, schedule more urgently
    const hasBoundaryDirty = this.boundaryDirtySet.size > 0;
    const timeout = hasBoundaryDirty ? 16 : (lowPriority ? 100 : 32);
    
    if (typeof requestIdleCallback !== 'undefined') {
      this._idleCallbackId = requestIdleCallback(callback, { timeout });
    } else {
      // Fallback: use setTimeout with small delay
      const fallbackDelay = hasBoundaryDirty ? 4 : (lowPriority ? 32 : 16);
      this._idleCallbackId = setTimeout(
        () => callback({ timeRemaining: () => hasBoundaryDirty ? 16 : (lowPriority ? 8 : 12) }),
        fallbackDelay
      );
    }
  }

  /**
   * Cancel any pending idle rebuilds
   * Useful when movement is detected
   */
  cancelIdleRebuild() {
    if (this._idleCallbackId) {
      if (typeof cancelIdleCallback !== 'undefined') {
        cancelIdleCallback(this._idleCallbackId);
      }
      // Also clear timeout in case we're using the fallback
      clearTimeout(this._idleCallbackId);
      this._idleCallbackId = null;
    }
  }

  /**
   * Remove a super-chunk's meshes from ChunkManager's tracking arrays
   */
  _removeMeshesFromManager(superChunk) {
    for (const mesh of superChunk.meshes) {
      removeFromArray(this.chunkManager.solidMeshes, mesh);
      removeFromArray(this.chunkManager.waterMeshes, mesh);
      removeFromArray(this.chunkManager.lavaMeshes, mesh);
      removeFromArray(this.chunkManager.glassMeshes, mesh);
      removeFromArray(this.chunkManager.modelMeshes, mesh);
      removeFromArray(this.chunkManager.transparentModelMeshes, mesh);
      removeFromArray(this.chunkManager.overlayModelMeshes, mesh);
    }
  }

  /**
   * Create a Three.js mesh from mesh data
   */
  _createMesh(meshData, material, group) {
    if (!meshData) return null;
    if (!meshData.positions || meshData.positions.length === 0) return null;
    if (!meshData.normals || meshData.normals.length === 0) return null;
    if (!meshData.indices || meshData.indices.length === 0) return null;
    if (!material || !group) return null;
    
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    
    if (meshData.colors && meshData.colors.length > 0) {
      geometry.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    }
    
    if (meshData.uvs && meshData.uvs.length > 0) {
      geometry.setAttribute('modelUV', new THREE.BufferAttribute(meshData.uvs, 2));
    }
    
    if (meshData.modelUVs && meshData.modelUVs.length > 0) {
      geometry.setAttribute('modelUV', new THREE.BufferAttribute(meshData.modelUVs, 2));
    }
    
    if (meshData.texIndices && meshData.texIndices.length > 0) {
      geometry.setAttribute('texIndex', new THREE.BufferAttribute(meshData.texIndices, 1));
    }
    
    if (meshData.texRotations && meshData.texRotations.length > 0) {
      geometry.setAttribute('texRotation', new THREE.BufferAttribute(meshData.texRotations, 1));
    }
    
    if (meshData.tintTypes && meshData.tintTypes.length > 0) {
      geometry.setAttribute('tintType', new THREE.BufferAttribute(meshData.tintTypes, 1));
    }
    
    if (meshData.shadeFlags && meshData.shadeFlags.length > 0) {
      geometry.setAttribute('shadeFlag', new THREE.BufferAttribute(meshData.shadeFlags, 1));
    }
    
    if (meshData.singleSided && meshData.singleSided.length > 0) {
      geometry.setAttribute('singleSided', new THREE.BufferAttribute(meshData.singleSided, 1));
    }
    
    if (meshData.skyLight && meshData.skyLight.length > 0) {
      geometry.setAttribute('skyLight', new THREE.BufferAttribute(meshData.skyLight, 1));
    }
    
    if (meshData.blockLight && meshData.blockLight.length > 0) {
      geometry.setAttribute('blockLight', new THREE.BufferAttribute(meshData.blockLight, 1));
    }
    
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingSphere();
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    // Store super-chunk center for visibility calculations
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    mesh.userData.chunkCenterX = center.x;
    mesh.userData.chunkCenterZ = center.z;
    
    group.add(mesh);
    
    return mesh;
  }

  /**
   * Check if there are any dirty super-chunks needing rebuild
   * @returns {boolean} true if any chunks need rebuilding
   */
  hasDirtyChunks() {
    return this.dirtySet.size > 0 || this.boundaryDirtySet.size > 0;
  }
  
  /**
   * Check if there are boundary-dirty super-chunks (visible artifacts)
   * @returns {boolean} true if any built chunks have boundary artifacts
   */
  hasBoundaryDirtyChunks() {
    return this.boundaryDirtySet.size > 0;
  }
  
  /**
   * Force immediate rebuild of boundary-dirty super-chunks (visible artifacts)
   * 
   * This bypasses the idle callback system to fix seams immediately.
   * Should be called after chunk batches during streaming to ensure
   * visible artifacts are fixed quickly.
   * 
   * @param {number} maxRebuilds - Maximum number to rebuild (default 1 to avoid frame drops)
   * @returns {Promise<number>} Number of super-chunks rebuilt
   */
  async repairBoundaries(maxRebuilds = 1) {
    if (this.boundaryDirtySet.size === 0) return 0;
    
    // Only rebuild boundary-dirty chunks (the ones with visible artifacts)
    const keysToRebuild = [...this.boundaryDirtySet].slice(0, maxRebuilds);
    let rebuiltCount = 0;
    
    for (const key of keysToRebuild) {
      const superChunk = this.superChunks.get(key);
      // Rebuild if super-chunk exists - it's in boundaryDirtySet so needs fixing
      if (superChunk) {
        // Store old meshes to remove AFTER new ones are ready
        const oldMeshes = [...superChunk.meshes];
        
        // Build new meshes
        await this.buildSuperChunk(superChunk, true /* keepOldMeshes */);
        
        // Remove old meshes from manager arrays and scene
        for (const mesh of oldMeshes) {
          if (this.chunkManager.solidMeshes) removeFromArray(this.chunkManager.solidMeshes, mesh);
          if (this.chunkManager.waterMeshes) removeFromArray(this.chunkManager.waterMeshes, mesh);
          if (this.chunkManager.lavaMeshes) removeFromArray(this.chunkManager.lavaMeshes, mesh);
          if (this.chunkManager.glassMeshes) removeFromArray(this.chunkManager.glassMeshes, mesh);
          if (this.chunkManager.modelMeshes) removeFromArray(this.chunkManager.modelMeshes, mesh);
          if (this.chunkManager.beaconMeshes) removeFromArray(this.chunkManager.beaconMeshes, mesh);
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.parent) mesh.parent.remove(mesh);
        }
        
        rebuiltCount++;
      }
      // Remove from both sets
      this.dirtySet.delete(key);
      this.boundaryDirtySet.delete(key);
    }
    
    return rebuiltCount;
  }

  /**
   * Get statistics about super-chunks
   */
  getStats() {
    let totalChunks = 0;
    let totalMeshes = 0;
    
    for (const [, sc] of this.superChunks) {
      totalChunks += sc.getChunkCount();
      totalMeshes += sc.meshes.length;
    }
    
    return {
      superChunkCount: this.superChunks.size,
      totalChunks,
      totalMeshes,
      dirtyCount: this.dirtySet.size,
      boundaryDirtyCount: this.boundaryDirtySet.size
    };
  }

  /**
   * Clear all super-chunks
   */
  clear() {
    for (const [, superChunk] of this.superChunks) {
      this._removeMeshesFromManager(superChunk);
      superChunk.dispose();
    }
    this.superChunks.clear();
    this.dirtySet.clear();
    this.boundaryDirtySet.clear();
  }

  /**
   * Invalidate worker pool so it re-initializes with new texture data
   * Call this when the texture pack changes to ensure workers use new indices
   */
  invalidateWorkerPool() {
    // Increment version to track texture pack changes
    this._textureVersion = (this._textureVersion || 0) + 1;
    console.log(`[SuperChunkManager] Invalidating worker pool for texture pack change (version ${this._textureVersion})...`);
    
    // Terminate existing worker pool AND reset the singleton
    // This is critical - just calling terminate() leaves a dead pool in the singleton
    if (this.workerPool) {
      this.workerPool.terminate();
      this.workerPool = null;
    }
    resetMeshWorkerPool(); // Clear the singleton so getMeshWorkerPool() creates a fresh pool
    
    // Reset initialization state so next mesh operation will re-initialize
    this.workerPoolInitialized = false;
    this.workerPoolInitPromise = null;
    
    // Also reset WASM state if used
    this.wasmInitialized = false;
    this.wasmInitPromise = null;
  }

  /**
   * Dispose and clean up
   */
  dispose() {
    this.clear();
    
    // Terminate worker pool
    if (this.workerPool) {
      this.workerPool.terminate();
      this.workerPool = null;
      this.workerPoolInitialized = false;
      this.workerPoolInitPromise = null;
    }
  }
}

/**
 * Helper to remove an item from an array
 */
function removeFromArray(array, item) {
  const idx = array.indexOf(item);
  if (idx !== -1) {
    array.splice(idx, 1);
  }
}

export default SuperChunkManager;

