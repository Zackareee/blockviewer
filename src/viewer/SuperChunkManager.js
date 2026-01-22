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
import { getSharedLookupManager } from '../utils/SharedMemoryPool.js';
import { 
  initWasmMesher, 
  isWasmAvailable, 
  isUnifiedPipelineReady,
  initLookups as initWasmLookups,
  buildLookupTables,
  meshChunk as wasmMeshChunk,
  serializeGrid,
  serializeLightGrid,
  isModelRegistryV2Initialized,
  initModelRegistryV2,
  getSerializedModelGeometry,
} from '../mesh/wasm/WasmMesher.js';
import { parseNBTRaw } from '../utils/nbtParser.js';
import pako from 'pako';
import { chunkLoadLogger } from '../utils/ChunkLoadLogger.js';
import { buildFaceTintTypeLookup } from '../data/biomeTinting.js';

// Super-chunk is 2x2 Minecraft chunks (32x32 blocks)
// Smaller size = faster rebuilds, less jank, more responsive loading
const SUPER_CHUNK_SIZE = 2;
const BLOCKS_PER_SUPER_CHUNK = SUPER_CHUNK_SIZE * 16; // 32 blocks

// ============================================================================
// MODEL LOD CONFIGURATION
// Distance-based Level of Detail for model blocks (grass, flowers, stairs, etc.)
// This is the PRIMARY optimization for reducing triangle count.
// 91% of triangles come from model meshes - this culling is essential.
// ============================================================================

// LOD distance thresholds in BLOCKS from camera
// These are tuned to provide good visual quality while dramatically reducing triangles
const MODEL_LOD_DISTANCES = {
  LOD0: 0,      // Full detail: all model blocks
  LOD1: 48,     // Skip flowers, grass, small plants (cross-pattern blocks)
  LOD2: 80,     // Also skip vines, saplings, crops
  LOD3: 112,    // Only structural blocks (slabs, stairs, walls)
  HIDE: 160,    // Skip ALL model blocks (solid blocks only)
};

/**
 * Calculate the appropriate LOD level for a super-chunk based on its distance from camera
 * @param {number} superX - Super-chunk X coordinate
 * @param {number} superZ - Super-chunk Z coordinate
 * @param {THREE.Camera|null} camera - Camera to calculate distance from
 * @returns {number} LOD level (0-4, where 4 = hide all models)
 */
function calculateModelLodLevel(superX, superZ, camera) {
  if (!camera || !camera.position) {
    return 0; // Full detail if no camera
  }
  
  // Calculate super-chunk center in world coordinates
  const centerX = superX * BLOCKS_PER_SUPER_CHUNK + BLOCKS_PER_SUPER_CHUNK / 2;
  const centerZ = superZ * BLOCKS_PER_SUPER_CHUNK + BLOCKS_PER_SUPER_CHUNK / 2;
  
  // Calculate distance from camera (horizontal only, Y doesn't matter for LOD)
  const dx = camera.position.x - centerX;
  const dz = camera.position.z - centerZ;
  const distance = Math.sqrt(dx * dx + dz * dz);
  
  // Determine LOD level based on distance
  if (distance >= MODEL_LOD_DISTANCES.HIDE) return 4;  // Hide all models
  if (distance >= MODEL_LOD_DISTANCES.LOD3) return 3;  // Only structural
  if (distance >= MODEL_LOD_DISTANCES.LOD2) return 2;  // Skip more decorative
  if (distance >= MODEL_LOD_DISTANCES.LOD1) return 1;  // Skip flowers/grass
  return 0; // Full detail
}

// Debug: Track LOD usage statistics (only logged once)
let _lodStatsLogged = false;
const _lodStats = { lod0: 0, lod1: 0, lod2: 0, lod3: 0, lod4: 0 };
function trackLodUsage(lodLevel) {
  if (lodLevel === 0) _lodStats.lod0++;
  else if (lodLevel === 1) _lodStats.lod1++;
  else if (lodLevel === 2) _lodStats.lod2++;
  else if (lodLevel === 3) _lodStats.lod3++;
  else if (lodLevel >= 4) _lodStats.lod4++;
}
function logLodStats() {
  if (_lodStatsLogged) return;
  const total = _lodStats.lod0 + _lodStats.lod1 + _lodStats.lod2 + _lodStats.lod3 + _lodStats.lod4;
  if (total >= 20) { // Log after 20 chunks processed
    _lodStatsLogged = true;
    console.log(`[Model LOD] Distribution: LOD0=${_lodStats.lod0}, LOD1=${_lodStats.lod1}, LOD2=${_lodStats.lod2}, LOD3=${_lodStats.lod3}, LOD4(hidden)=${_lodStats.lod4}`);
    console.log(`[Model LOD] Triangle reduction estimate: ${((_lodStats.lod1 + _lodStats.lod2*2 + _lodStats.lod3*3 + _lodStats.lod4*4) / total * 20).toFixed(0)}%`);
  }
}

/**
 * MeshCreationQueue - Spreads mesh creation across frames to avoid frame spikes
 * 
 * When many chunks arrive at once, creating all meshes synchronously can cause
 * significant frame drops (6-8 meshes per super-chunk × 2ms each = 12-16ms spike).
 * 
 * This queue processes meshes with a per-frame time budget, ensuring smooth
 * camera movement even during heavy chunk loading.
 */
class MeshCreationQueue {
  constructor() {
    // Queue of mesh creation tasks: { meshData, material, group, superChunk, meshType, renderOrder, meshArray }
    this.queue = [];
    
    // Per-frame time budget in milliseconds
    // TUNED: Reduced from 3ms to 2ms for highly detailed worlds
    // At 60fps, each frame has ~16ms total - leaving more headroom reduces stutter
    this.frameBudgetMs = 2.0;
    
    // Movement-aware budgeting: reduce budget during camera movement
    this.movingBudgetMs = 0.5;  // Very small budget during fast movement
    this.normalBudgetMs = 2.0;  // Normal budget when stationary
    
    // Maximum meshes per frame (prevents one huge mesh from blocking)
    // For worst-case detailed worlds, limit to 2 meshes even if time allows
    this.maxMeshesPerFrame = 2;
    this.movingMaxMeshes = 1;   // Only 1 mesh during movement
    this.normalMaxMeshes = 2;   // Normal limit when stationary
    
    // Camera movement tracking
    this._cameraMovingFast = false;
    this._lastCameraPos = { x: 0, y: 0, z: 0 };
    this._movementThreshold = 2.0; // Movement speed threshold (blocks/frame)
    
    // Priority order: solid first for quick visual feedback, then models, then transparent
    this.priorityOrder = ['solid', 'modelOpaque', 'modelOverlay', 'glass', 'modelTransparent', 'water', 'lava'];
    
    // Stats
    this.processedThisFrame = 0;
    this.totalQueued = 0;
    this.isProcessing = false;
    
    // Reference to createMesh function (set during first processFrame)
    this._createMeshFn = null;
    
    // Callbacks for when chunks complete
    this._onChunkComplete = null;
  }
  
  /**
   * Update camera position to detect movement
   * Call this each frame before processFrame
   * 
   * @param {number} x - Camera X position
   * @param {number} y - Camera Y position
   * @param {number} z - Camera Z position
   */
  updateCameraPosition(x, y, z) {
    const dx = x - this._lastCameraPos.x;
    const dy = y - this._lastCameraPos.y;
    const dz = z - this._lastCameraPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    
    this._cameraMovingFast = distSq > this._movementThreshold * this._movementThreshold;
    
    this._lastCameraPos.x = x;
    this._lastCameraPos.y = y;
    this._lastCameraPos.z = z;
    
    // Dynamically adjust budget based on movement
    if (this._cameraMovingFast) {
      this.frameBudgetMs = this.movingBudgetMs;
      this.maxMeshesPerFrame = this.movingMaxMeshes;
    } else {
      this.frameBudgetMs = this.normalBudgetMs;
      this.maxMeshesPerFrame = this.normalMaxMeshes;
    }
  }
  
  /**
   * Check if camera is currently moving fast
   * @returns {boolean}
   */
  isCameraMovingFast() {
    return this._cameraMovingFast;
  }
  
  /**
   * Configure the queue for different performance scenarios
   * @param {Object} options - { frameBudgetMs, maxMeshesPerFrame, movingBudgetMs, movingMaxMeshes }
   */
  configure(options = {}) {
    if (options.frameBudgetMs !== undefined) {
      this.normalBudgetMs = options.frameBudgetMs;
      this.frameBudgetMs = options.frameBudgetMs;
    }
    if (options.maxMeshesPerFrame !== undefined) {
      this.normalMaxMeshes = options.maxMeshesPerFrame;
      this.maxMeshesPerFrame = options.maxMeshesPerFrame;
    }
    if (options.movingBudgetMs !== undefined) {
      this.movingBudgetMs = options.movingBudgetMs;
    }
    if (options.movingMaxMeshes !== undefined) {
      this.movingMaxMeshes = options.movingMaxMeshes;
    }
    if (options.movementThreshold !== undefined) {
      this._movementThreshold = options.movementThreshold;
    }
  }
  
  /**
   * Add a mesh creation task to the queue
   * @param {Object} task - { meshData, material, group, superChunk, meshType, renderOrder, meshArray }
   */
  add(task) {
    // Sort by priority when adding
    const priority = this.priorityOrder.indexOf(task.meshType);
    task.priority = priority >= 0 ? priority : 999;
    
    // Insert in priority order (lower priority value = higher priority)
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (task.priority < this.queue[i].priority) {
        this.queue.splice(i, 0, task);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.queue.push(task);
    }
    
    this.totalQueued++;
  }
  
  /**
   * Process queued mesh creation with time budget
   * Call this each frame (e.g., in render loop or requestAnimationFrame)
   * 
   * @param {Function} createMeshFn - The _createMesh function to call
   * @returns {number} Number of meshes created this frame
   */
  processFrame(createMeshFn) {
    if (this.queue.length === 0) return 0;
    
    // Store createMesh function for processAll
    this._createMeshFn = createMeshFn;
    
    const startTime = performance.now();
    this.processedThisFrame = 0;
    this.isProcessing = true;
    
    while (this.queue.length > 0) {
      // Check mesh count limit first (for worst-case detailed worlds)
      if (this.processedThisFrame >= this.maxMeshesPerFrame) {
        break;
      }
      
      const elapsed = performance.now() - startTime;
      if (elapsed >= this.frameBudgetMs) {
        // Budget exhausted, continue next frame
        break;
      }
      
      this._processOne(createMeshFn);
    }
    
    this.isProcessing = false;
    return this.processedThisFrame;
  }
  
  /**
   * Process a single task from the queue
   */
  _processOne(createMeshFn) {
    const task = this.queue.shift();
    if (!task) return;
    
    const mesh = createMeshFn(task.meshData, task.material, task.group);
    
    if (mesh) {
      if (task.renderOrder !== undefined) {
        mesh.renderOrder = task.renderOrder;
      }
      
      if (task.superChunk) {
        task.superChunk.meshes.push(mesh);
      }
      
      if (task.meshArray) {
        task.meshArray.push(mesh);
      }
    }
    
    this.processedThisFrame++;
  }
  
  /**
   * Process all queued meshes immediately (no time budget)
   * Use sparingly - can cause frame drops if many meshes are queued
   * 
   * @param {Function} createMeshFn - The _createMesh function to call
   * @returns {number} Number of meshes created
   */
  processAll(createMeshFn) {
    if (this.queue.length === 0) return 0;
    
    const fn = createMeshFn || this._createMeshFn;
    if (!fn) return 0;
    
    this.processedThisFrame = 0;
    this.isProcessing = true;
    
    while (this.queue.length > 0) {
      this._processOne(fn);
    }
    
    this.isProcessing = false;
    return this.processedThisFrame;
  }
  
  /**
   * Clear all pending tasks (e.g., when unloading chunks)
   */
  clear() {
    this.queue = [];
    this.totalQueued = 0;
  }
  
  /**
   * Get queue length
   */
  get length() {
    return this.queue.length;
  }
  
  /**
   * Check if queue is empty
   */
  get isEmpty() {
    return this.queue.length === 0;
  }
}

/**
 * SuperChunkCompletionQueue - Spreads super-chunk mesh creation across frames
 * 
 * When multiple workers complete at once, we queue their results and process
 * 1 super-chunk per frame to avoid lag spikes. Each super-chunk creates
 * all its meshes together (no visual popping).
 * 
 * Supports movement-aware processing: skips processing during fast camera movement.
 */
class SuperChunkCompletionQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.maxPerFrame = 1; // Max super-chunks to process per frame (keep low - each is expensive)
    this.onComplete = null; // Callback when a super-chunk is processed
    
    // Movement-aware processing
    this._skipDuringMovement = true; // Skip processing during fast camera movement
    this._cameraMovingFast = false;
  }
  
  /**
   * Update whether camera is moving fast
   * @param {boolean} isMoving
   */
  setCameraMovingFast(isMoving) {
    this._cameraMovingFast = isMoving;
  }
  
  /**
   * Add a completed worker result to the queue
   */
  add(job, result) {
    this.queue.push({ job, result });
  }
  
  /**
   * Process queued super-chunks with a per-frame limit
   * Skips processing during fast camera movement to maintain smooth frame rates
   * @param {Function} processFn - Function to process a single result: (job, result) => Promise<void>
   * @returns {Promise<number>} Number of super-chunks processed
   */
  async process(processFn) {
    if (this.queue.length === 0) return 0;
    
    // Skip during fast camera movement to prioritize smooth frame rates
    if (this._skipDuringMovement && this._cameraMovingFast) {
      return 0;
    }
    
    this.isProcessing = true;
    let processed = 0;
    
    while (this.queue.length > 0 && processed < this.maxPerFrame) {
      const { job, result } = this.queue.shift();
      await processFn(job, result);
      processed++;
      this.onComplete?.(job, result);
    }
    
    this.isProcessing = false;
    return processed;
  }
  
  /**
   * Process all queued super-chunks immediately (no limit)
   * Use for tests or when immediate completion is needed
   */
  async processAll(processFn) {
    if (this.queue.length === 0) return 0;
    
    this.isProcessing = true;
    let processed = 0;
    
    while (this.queue.length > 0) {
      const { job, result } = this.queue.shift();
      await processFn(job, result);
      processed++;
      this.onComplete?.(job, result);
    }
    
    this.isProcessing = false;
    return processed;
  }
  
  /**
   * Get queue length
   */
  get length() {
    return this.queue.length;
  }
  
  /**
   * Check if queue is empty
   */
  get isEmpty() {
    return this.queue.length === 0;
  }
  
  /**
   * Clear the queue
   */
  clear() {
    this.queue = [];
  }
}

/**
 * VisibilityWarmupQueue - Staggers mesh visibility to spread GPU buffer uploads
 * 
 * When a mesh is first rendered, Three.js uploads its buffers to the GPU.
 * This can cause frame drops if many meshes become visible at once.
 * 
 * This queue:
 * 1. Creates meshes with visible = false (no GPU upload yet)
 * 2. Makes 1-2 meshes visible per frame (staggered GPU uploads)
 * 3. Respects camera movement (skips during fast movement)
 */
class VisibilityWarmupQueue {
  constructor() {
    this.queue = [];
    this.maxPerFrame = 2;           // Max meshes to make visible per frame
    this.movingMaxPerFrame = 0;     // Skip during fast movement
    this._cameraMovingFast = false;
  }
  
  /**
   * Add a mesh to the warmup queue
   * @param {THREE.Mesh} mesh - Mesh to make visible later
   */
  add(mesh) {
    if (!mesh) return;
    this.queue.push(mesh);
  }
  
  /**
   * Update whether camera is moving fast
   * @param {boolean} isMoving
   */
  setCameraMovingFast(isMoving) {
    this._cameraMovingFast = isMoving;
  }
  
  /**
   * Process queued meshes - make some visible this frame
   * @returns {number} Number of meshes made visible
   */
  processFrame() {
    if (this.queue.length === 0) return 0;
    
    const limit = this._cameraMovingFast ? this.movingMaxPerFrame : this.maxPerFrame;
    if (limit === 0) return 0;
    
    let processed = 0;
    while (this.queue.length > 0 && processed < limit) {
      const mesh = this.queue.shift();
      if (mesh && !mesh.visible) {
        mesh.visible = true;
        processed++;
      }
    }
    
    return processed;
  }
  
  /**
   * Make all queued meshes visible immediately
   * Use when immediate visibility is needed
   */
  processAll() {
    let processed = 0;
    while (this.queue.length > 0) {
      const mesh = this.queue.shift();
      if (mesh && !mesh.visible) {
        mesh.visible = true;
        processed++;
      }
    }
    return processed;
  }
  
  /**
   * Clear the queue without making meshes visible
   */
  clear() {
    this.queue = [];
  }
  
  /**
   * Get queue length
   */
  get length() {
    return this.queue.length;
  }
  
  /**
   * Check if queue is empty
   */
  get isEmpty() {
    return this.queue.length === 0;
  }
}

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
    
    // Prevent concurrent rebuilds (race condition fix)
    // When true, a rebuild is in progress - skip new rebuild requests
    this.rebuildPending = false;
    
    // Build version counter - incremented each time the super chunk is rebuilt
    // Used to detect stale queued operations (e.g., model mesh builds)
    this.buildVersion = 0;
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
   * @param {SuperChunkManager} manager - Optional manager to remove from ChunkManager arrays
   */
  dispose(manager = null) {
    if (manager) {
      // Use manager's _disposeOldMeshes for complete cleanup including ChunkManager arrays
      manager._disposeOldMeshes(this.meshes);
    } else {
      // Basic cleanup without ChunkManager array removal
    for (const mesh of this.meshes) {
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.parent) {
        mesh.parent.remove(mesh);
        }
      }
    }
    this.meshes = [];
    this.hasBeenBuilt = false;
    // Increment build version to invalidate any pending queued operations
    this.buildVersion++;
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
    // Enable SuperChunkWorkerPool for parallel off-thread meshing
    // Workers now use WASM mesher which includes all required attributes
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
    
    // Mesh creation queue - spreads mesh creation across frames to avoid spikes
    this.meshCreationQueue = new MeshCreationQueue();
    
    // Super-chunk completion queue - spreads worker result processing across frames
    // When multiple workers complete at once, we queue results and process 1-2 per frame
    this.completionQueue = new SuperChunkCompletionQueue();
    this._pendingWorkerJobs = 0;
    
    // Visibility warmup queue - staggers GPU buffer uploads
    // Meshes are created invisible and made visible 1-2 per frame
    this.visibilityWarmupQueue = new VisibilityWarmupQueue();
    
    // Enable/disable visibility staggering (can be toggled for debugging)
    this._staggerVisibility = options.staggerVisibility ?? true;
    
    // Disable neighbor rebuilds to improve performance
    // The race condition fix (rebuildPending flag) prevents duplicate meshes,
    // so neighbor rebuilds are optional for visual polish (water levels, lighting)
    // Set to true to disable rebuilds entirely (fastest, slight visual artifacts at edges)
    this._disableNeighborRebuilds = options.disableNeighborRebuilds ?? false;
  }
  
  /**
   * Set the meshing speed (super-chunks per idle callback)
   * @param {number} speed - 1-4, higher = faster but may cause frame drops
   */
  setMeshingSpeed(speed) {
    this.meshingSpeed = Math.max(1, Math.min(4, speed));
  }
  
  /**
   * Configure mesh creation queue for detailed worlds
   * Call this before loading large/detailed worlds to reduce stutter
   * 
   * @param {Object} options
   * @param {number} options.frameBudgetMs - Max ms per frame for mesh creation (default: 2)
   * @param {number} options.maxMeshesPerFrame - Max meshes to create per frame (default: 2)
   */
  configureMeshQueue(options = {}) {
    this.meshCreationQueue.configure(options);
  }
  
  /**
   * Update camera position for movement-aware mesh queue budgeting
   * Call this each frame before processQueuedMeshes
   * 
   * @param {number} x - Camera X position
   * @param {number} y - Camera Y position
   * @param {number} z - Camera Z position
   */
  updateCameraPosition(x, y, z) {
    this.meshCreationQueue.updateCameraPosition(x, y, z);
    const isMovingFast = this.meshCreationQueue.isCameraMovingFast();
    // Also update completion queue and visibility queue with movement status
    this.completionQueue.setCameraMovingFast(isMovingFast);
    this.visibilityWarmupQueue.setCameraMovingFast(isMovingFast);
  }
  
  /**
   * Check if camera is moving fast (useful for disabling other operations)
   * @returns {boolean}
   */
  isCameraMovingFast() {
    return this.meshCreationQueue.isCameraMovingFast();
  }
  
  /**
   * Process queued mesh creation with per-frame budget
   * Call this each frame in the render loop for smooth chunk loading
   * Budget is automatically reduced during camera movement
   * 
   * Also processes visibility warmup queue for staggered GPU uploads
   * 
   * @returns {number} Number of meshes created this frame
   */
  processQueuedMeshes() {
    let count = 0;
    
    // Process mesh creation queue
    if (!this.meshCreationQueue.isEmpty) {
      count = this.meshCreationQueue.processFrame(
        (meshData, material, group) => this._createMesh(meshData, material, group)
      );
    }
    
    // Process visibility warmup queue (staggers GPU uploads)
    if (!this.visibilityWarmupQueue.isEmpty) {
      this.visibilityWarmupQueue.processFrame();
    }
    
    return count;
  }
  
  /**
   * Get number of meshes waiting to be created
   */
  getPendingMeshCount() {
    return this.meshCreationQueue.length;
  }
  
  /**
   * Flush all pending meshes immediately (no time budget)
   * Use for tests or when immediate completion is required
   * Also makes all queued meshes visible immediately
   * 
   * @returns {number} Number of meshes created
   */
  flushMeshQueue() {
    const count = this.meshCreationQueue.processAll(
      (meshData, material, group) => this._createMesh(meshData, material, group)
    );
    // Also flush visibility warmup queue
    this.visibilityWarmupQueue.processAll();
    return count;
  }
  
  /**
   * Process completed worker results with per-frame limit
   * Call this each frame to spread super-chunk mesh creation across frames
   * 
   * @returns {Promise<number>} Number of super-chunks processed
   */
  async processCompletedChunks() {
    if (this.completionQueue.isEmpty) return 0;
    
    return await this.completionQueue.process(async (job, result) => {
      await this._finalizeWorkerResult(job, result);
    });
  }
  
  /**
   * Process all completed worker results immediately (no limit)
   * Use for tests or when immediate completion is required
   * 
   * @returns {Promise<number>} Number of super-chunks processed
   */
  async flushCompletionQueue() {
    if (this.completionQueue.isEmpty) return 0;
    
    return await this.completionQueue.processAll(async (job, result) => {
      await this._finalizeWorkerResult(job, result);
    });
  }
  
  /**
   * Flush all pending model mesh builds immediately
   * Used for tests to ensure all model meshes are created
   */
  async flushModelMeshQueue() {
    if (!this._modelMeshQueue || this._modelMeshQueue.length === 0) return 0;
    
    let processed = 0;
    while (this._modelMeshQueue.length > 0) {
      const { superChunk, gridsData, buildVersion, bounds } = this._modelMeshQueue.shift();
      
      // Skip stale queue items from previous builds
      if (buildVersion !== superChunk.buildVersion) {
        continue;
      }
      
      // OPTIMIZATION: Calculate LOD level based on distance from camera
      const camera = this.chunkManager?.camera;
      const lodLevel = calculateModelLodLevel(superChunk.superX, superChunk.superZ, camera);
      
      // LOD 4 = skip all model meshes entirely
      if (lodLevel >= 4) {
        continue;
      }
      
      try {
        const modelResult = await this._buildModelMeshesFromWorkerGrids(gridsData, bounds, lodLevel);
        if (modelResult) {
          if (modelResult.opaque?.positions?.length > 0) {
            const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
            if (mesh) {
              superChunk.meshes.push(mesh);
              this.chunkManager.modelMeshes.push(mesh);
            }
          }
          if (modelResult.transparent?.positions?.length > 0) {
            const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
            if (mesh) {
              mesh.renderOrder = 0.5;
              superChunk.meshes.push(mesh);
              this.chunkManager.transparentModelMeshes.push(mesh);
            }
          }
          if (modelResult.overlay?.positions?.length > 0) {
            const mesh = this._createMesh(modelResult.overlay, this.chunkManager.overlayMaterial, this.chunkManager.overlayGroup);
            if (mesh) {
              mesh.renderOrder = 0.1;
              superChunk.meshes.push(mesh);
              this.chunkManager.overlayMeshes?.push(mesh);
            }
          }
          if (modelResult.particleEmitters?.length > 0) {
            const emitterManager = this.chunkManager.particleEmitterManager;
            if (emitterManager) {
              for (const emitter of modelResult.particleEmitters) {
                emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
              }
            }
          }
        }
        processed++;
      } catch (error) {
        console.warn('[SuperChunkManager] Model mesh build failed:', error.message);
      }
    }
    this._modelMeshScheduled = false;
    return processed;
  }
  
  /**
   * Finalize a worker result - create meshes, dispose old, mark as built
   * @private
   */
  async _finalizeWorkerResult(job, result) {
    // Skip stale jobs from previous builds - this can happen if a super chunk
    // was rebuilt while its previous job was still queued
    if (job.buildVersion !== undefined && job.buildVersion !== job.superChunk.buildVersion) {
      // Dispose old meshes even for stale jobs to prevent memory leaks
      this._disposeOldMeshes(job.oldMeshes);
      this._pendingWorkerJobs--;
      return;
    }
    
    // Hide old meshes BEFORE creating new ones to prevent transparent overlap
    // (which causes flickering/darkness during rebuilds)
    this._hideOldMeshes(job.oldMeshes);
    
    // Create meshes from worker result
    await this._createMeshesFromWorkerResult(job.superChunk, result.result);
    
    // Dispose old meshes
    this._disposeOldMeshes(job.oldMeshes);
    
    // Mark as built and handle neighbor marking
    const isFirstBuild = !job.superChunk.hasBeenBuilt;
    job.superChunk.isDirty = false;
    job.superChunk.hasBeenBuilt = true;
    
    // Clear rebuild pending flag (allows future rebuilds)
    job.superChunk.rebuildPending = false;
    
    // Mark neighbors for rebuild on first build
    this._markNeighborsDirtyAfterBuild(job.superChunk, isFirstBuild);
    
    this._pendingWorkerJobs--;
    this.onSuperChunkRebuilt?.(job.superChunk);
  }
  
  /**
   * Check if there are pending worker jobs or queued completions
   */
  hasPendingWork() {
    return this._pendingWorkerJobs > 0 || !this.completionQueue.isEmpty;
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
      
      // Initialize model registry V2 for WASM model meshing
      // Pre-register all non-cube blocks to populate the StateRegistry BEFORE chunk loading
      if (this.stateRegistry && this.registry && !isModelRegistryV2Initialized()) {
        try {
          // Pre-register all non-cube blocks (slabs, stairs, plants, etc.)
          // This populates the StateRegistry so WASM can use it for model meshing
          const preregCount = await this.stateRegistry.preregisterNonCubeBlocks(this.registry);
          console.log(`[SuperChunkManager] Pre-registered ${preregCount} non-cube block states for WASM`);
          
          const success = initModelRegistryV2(this.stateRegistry);
          if (success) {
            console.log('[SuperChunkManager] WASM model registry V2 initialized - model meshing moved to WASM');
          }
        } catch (err) {
          console.warn('[SuperChunkManager] Failed to initialize model registry V2, using JS fallback:', err);
        }
      }
      
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
      
      // Build WASM lookup tables for workers
      const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
      const wasmLookups = this._buildWasmLookupsForWorker(textureIndexLookup);
      
      // Get serialized model geometry for worker WASM model registry (V2 - legacy)
      const modelGeometryData = getSerializedModelGeometry(this.stateRegistry);
      
      // Load V3 baked models, manifest, and texture mapping for worker model meshing
      let bakedModelsData = null;
      let manifestData = null;
      let textureRemapping = null;
      try {
        const [bakedResponse, manifestResponse, texturesResponse] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}assets/baked-models.bin`),
          fetch(`${import.meta.env.BASE_URL}assets/block-model-manifest.json`),
          fetch(`${import.meta.env.BASE_URL}assets/baked-models-textures.json`),
        ]);
        
        if (bakedResponse.ok && manifestResponse.ok) {
          bakedModelsData = await bakedResponse.arrayBuffer();
          manifestData = await manifestResponse.json();
          console.log(`[SuperChunkManager] V3 baked models loaded: ${(bakedModelsData.byteLength / 1024).toFixed(1)} KB, manifest has ${Object.keys(manifestData.blocks || {}).length} blocks`);
          
          // Build texture remapping from baked indices to atlas indices
          if (texturesResponse.ok) {
            const bakedTextures = await texturesResponse.json();
            textureRemapping = this._buildTextureRemapping(bakedTextures, textureIndexLookup);
            console.log(`[SuperChunkManager] Built texture remapping: ${textureRemapping.length} entries`);
          } else {
            console.warn('[SuperChunkManager] baked-models-textures.json not found, texture mapping may be incorrect');
          }
        } else {
          console.warn('[SuperChunkManager] Failed to load V3 baked models, falling back to main-thread model meshing');
        }
      } catch (e) {
        console.warn('[SuperChunkManager] Failed to load V3 assets:', e.message);
      }
      
      // Get or create the worker pool
      this.superChunkWorkerPool = getSuperChunkWorkerPool();
      
      // Initialize with registry data including WASM lookups, model geometry, and V3 data
      await this.superChunkWorkerPool.initialize(
        blockRegistryData, 
        stateRegistryData, 
        wasmLookups, 
        modelGeometryData,
        bakedModelsData,
        manifestData,
        textureRemapping
      );
      
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
   * Build texture remapping from baked model indices to atlas indices
   * @param {Object} bakedTextures - Map of texture name to baked index (from baked-models-textures.json)
   * @param {TextureIndexLookup} textureIndexLookup - Browser's texture index lookup
   * @returns {Uint16Array|null} Remapping array where remapping[bakedIndex] = atlasIndex
   */
  _buildTextureRemapping(bakedTextures, textureIndexLookup) {
    if (!bakedTextures || !textureIndexLookup) {
      console.warn('[SuperChunkManager] Cannot build texture remapping - missing data');
      return null;
    }
    
    // Get the atlas's texture path to index mapping
    const atlasPathToIndex = textureIndexLookup.texturePathToIndex;
    if (!atlasPathToIndex) {
      console.warn('[SuperChunkManager] TextureIndexLookup has no texturePathToIndex');
      return null;
    }
    
    // Find max baked index to size the array
    let maxBakedIndex = 0;
    for (const bakedIndex of Object.values(bakedTextures)) {
      if (bakedIndex > maxBakedIndex) maxBakedIndex = bakedIndex;
    }
    
    // Create remapping array
    const remapping = new Uint16Array(maxBakedIndex + 1);
    let matched = 0;
    let unmatched = 0;
    const defaultIndex = textureIndexLookup.defaultIndex || 0;
    
    // Fill with default first
    remapping.fill(defaultIndex);
    
    // Build the remapping
    for (const [textureName, bakedIndex] of Object.entries(bakedTextures)) {
      // Try multiple path formats to find the atlas texture
      const pathsToTry = [
        `block/${textureName}`,           // Most textures
        textureName,                       // Already has path
        `item/${textureName}`,             // Some items
      ];
      
      let atlasIndex = undefined;
      for (const path of pathsToTry) {
        atlasIndex = atlasPathToIndex.get(path);
        if (atlasIndex !== undefined) break;
      }
      
      if (atlasIndex !== undefined) {
        remapping[bakedIndex] = atlasIndex;
        matched++;
      } else {
        unmatched++;
        // Keep default index for unmatched
      }
    }
    
    console.log(`[SuperChunkManager] Texture remapping: ${matched} matched, ${unmatched} unmatched (using default ${defaultIndex})`);
    
    // Debug: show a few mappings
    const sampleMappings = ['stone', 'dirt', 'oak_planks', 'glass'];
    for (const name of sampleMappings) {
      const bakedIdx = bakedTextures[name];
      if (bakedIdx !== undefined) {
        const atlasIdx = remapping[bakedIdx];
        console.log(`  ${name}: baked=${bakedIdx} -> atlas=${atlasIdx}`);
      }
    }
    
    return remapping;
  }
  
  /**
   * Build WASM lookup tables for worker initialization
   * Uses SharedArrayBuffer when available for zero-copy sharing with workers
   */
  _buildWasmLookupsForWorker(textureIndexLookup) {
    const MAX_BLOCKS = 4096;
    
    // Use SharedArrayBuffer if available for zero-copy sharing
    const sharedManager = getSharedLookupManager();
    const useShared = typeof SharedArrayBuffer !== 'undefined';
    
    // Create buffers - SharedArrayBuffer for larger arrays, regular for small ones
    const createBuffer = (TypedArray, size) => {
      if (useShared) {
        try {
          const buffer = new SharedArrayBuffer(size * TypedArray.BYTES_PER_ELEMENT);
          return new TypedArray(buffer);
        } catch (e) {
          // Fallback to regular ArrayBuffer
        }
      }
      return new TypedArray(size);
    };
    
    const isOpaque = new Uint8Array(MAX_BLOCKS);
    const isNonCube = new Uint8Array(MAX_BLOCKS);
    const isSlab = new Uint8Array(MAX_BLOCKS);
    const isFluid = new Uint8Array(MAX_BLOCKS);
    const isGlass = new Uint8Array(MAX_BLOCKS);
    const isAOTransparent = new Uint8Array(MAX_BLOCKS);
    const isRotatable = new Uint8Array(MAX_BLOCKS);
    const isDirectional = new Uint8Array(MAX_BLOCKS);
    // Larger arrays use SharedArrayBuffer for zero-copy
    const colorR = createBuffer(Float32Array, MAX_BLOCKS);
    const colorG = createBuffer(Float32Array, MAX_BLOCKS);
    const colorB = createBuffer(Float32Array, MAX_BLOCKS);
    const textureIndices = createBuffer(Float32Array, MAX_BLOCKS * 6);
    
    // Build face tint type lookup using the existing function
    const faceTintTypesSource = buildFaceTintTypeLookup(this.registry);
    const faceTintTypes = new Uint8Array(faceTintTypesSource);
    
    colorR.fill(1.0);
    colorG.fill(1.0);
    colorB.fill(1.0);
    
    for (let id = 0; id < MAX_BLOCKS; id++) {
      const info = this.registry.getBlockInfo(id);
      if (!info) continue;
      
      isOpaque[id] = this.registry.isOpaque(id) ? 1 : 0;
      isNonCube[id] = this.registry.isNonCube?.(id) ? 1 : 0;
      
      const col = this.registry.getColor(id);
      colorR[id] = col.r;
      colorG[id] = col.g;
      colorB[id] = col.b;
      
      if (info.name) {
        const name = info.name;
        const isCauldron = name.includes('cauldron');
        if (name.includes('water') && !isCauldron) isFluid[id] = 1;
        else if (name.includes('lava') && !isCauldron) isFluid[id] = 2;
        
        if ((name.includes('glass') && !name.includes('_pane')) ||
            name.includes('ice') || name.includes('leaves')) {
          isGlass[id] = 1;
        }
        
        if (name.includes('_slab')) isSlab[id] = 1;
        
        if (name.includes('glass') || name.includes('ice') ||
            name.includes('leaves') || name.includes('slime') ||
            name.includes('honey') || name.includes('water') ||
            name.includes('lava') || name.includes('barrier') ||
            name.includes('light') || this.registry.isNonCube?.(id)) {
          isAOTransparent[id] = 1;
        }
        
        // Rotatable blocks (logs, pillars)
        if (name.includes('_log') || name.includes('_wood') ||
            name.includes('_stem') || name.includes('_hyphae') ||
            name.includes('bone_block') || name.includes('hay_block') ||
            name.includes('quartz_pillar') || name.includes('purpur_pillar') ||
            name.includes('basalt') ||
            (name.includes('deepslate') && !name.includes('tiles') && !name.includes('bricks')) ||
            name.includes('chain') ||
            name.includes('muddy_mangrove_roots') ||
            name.includes('bamboo_block') ||
            name.includes('froglight')) {
          isRotatable[id] = 1;
        }
        
        // Directional blocks (furnace, loom, etc.)
        const DIRECTIONAL = ['furnace', 'blast_furnace', 'smoker', 'loom', 'carved_pumpkin', 'jack_o_lantern'];
        if (DIRECTIONAL.some(b => name === b || name === `minecraft:${b}`)) {
          isDirectional[id] = 1;
        }
      }
      
      // Texture indices
      if (textureIndexLookup) {
        for (let face = 0; face < 6; face++) {
          textureIndices[id * 6 + face] = textureIndexLookup.getIndex(id, face);
        }
      }
    }
    
    // Fluid texture indices
    let waterStillIdx = 0, waterFlowIdx = 0, lavaStillIdx = 0, lavaFlowIdx = 0;
    if (textureIndexLookup) {
      waterStillIdx = textureIndexLookup.getIndexByPath?.('block/water_still') || 0;
      waterFlowIdx = textureIndexLookup.getIndexByPath?.('block/water_flow') || waterStillIdx;
      lavaStillIdx = textureIndexLookup.getIndexByPath?.('block/lava_still') || 0;
      lavaFlowIdx = textureIndexLookup.getIndexByPath?.('block/lava_flow') || lavaStillIdx;
    }
    
    const isShared = useShared && colorR.buffer instanceof SharedArrayBuffer;
    
    if (isShared) {
      console.log('[SuperChunkManager] Using SharedArrayBuffer for WASM lookups (zero-copy transfer)');
    }
    
    return {
      isOpaque,
      isNonCube,
      isSlab,
      isFluid,
      isGlass,
      isAOTransparent,
      isRotatable,
      isDirectional,
      colorR,
      colorG,
      colorB,
      faceTintTypes,
      textureIndices,
      waterStillIdx,
      waterFlowIdx,
      lavaStillIdx,
      lavaFlowIdx,
      isShared,  // Indicates if buffers are SharedArrayBuffer (no copy needed)
    };
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
        superChunk.dispose(this);
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
      superChunk.dispose(this);
    } else {
      // Clear the meshes array but don't dispose - caller will do it
      superChunk.meshes = [];
      // Increment build version to invalidate any pending queued operations
      superChunk.buildVersion++;
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
    
    // Collect raw compressed chunk data - clone buffers to preserve originals
    // After transfer to worker, ArrayBuffers become detached, so we must clone
    // to allow future rebuilds (e.g., boundary repairs) to work
    const chunks = [];
    for (const [, chunkInfo] of superChunk.loadedChunks) {
      if (!chunkInfo.isRawCompressed || !chunkInfo.data) continue;
      
      const originalBuffer = chunkInfo.data.compressedData;
      chunks.push({
        chunkX: chunkInfo.chunkX,
        chunkZ: chunkInfo.chunkZ,
        compressedData: originalBuffer.slice(0),
        compressionType: chunkInfo.data.compressionType,
      });
    }
    
    if (chunks.length === 0) {
      throw new Error('No raw compressed chunks available');
    }
    
    // Collect neighbor chunks for boundary handling - clone buffers too
    const neighbors = this._collectNeighborDataForWorker(superChunk, true /* cloneBuffers */);
    
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
    await this._createMeshesFromWorkerResult(superChunk, result);
    
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
   * @param {SuperChunk} superChunk - The super-chunk to collect neighbors for
   * @param {boolean} cloneBuffers - If true, clone ArrayBuffers to allow safe parallel transfer
   */
  _collectNeighborDataForWorker(superChunk, cloneBuffers = false) {
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
        if (!chunkInfo.data) continue;
        
        // Only include chunks that are adjacent to this super-chunk's boundary
        const isAdjacent = this._isChunkAdjacentToBoundary(
          chunkInfo.chunkX, chunkInfo.chunkZ,
          superChunk.superX, superChunk.superZ
        );
        
        if (isAdjacent) {
          // Handle raw compressed data (preferred - worker can decompress)
          if (chunkInfo.isRawCompressed && chunkInfo.data.compressedData) {
            const originalBuffer = chunkInfo.data.compressedData;
            neighbors.push({
              chunkX: chunkInfo.chunkX,
              chunkZ: chunkInfo.chunkZ,
              // Clone buffer when needed for parallel dispatch to avoid detached buffer errors
              compressedData: cloneBuffers ? originalBuffer.slice(0) : originalBuffer,
              compressionType: chunkInfo.data.compressionType,
            });
          }
          // Handle pre-parsed NBT data - re-compress for worker
          // This ensures neighbors from main-thread-built super-chunks are included
          else if (chunkInfo.data && !chunkInfo.isRawCompressed) {
            try {
              // The data is already parsed NBT, encode it as JSON for the worker
              // Worker will detect this and handle accordingly
              neighbors.push({
                chunkX: chunkInfo.chunkX,
                chunkZ: chunkInfo.chunkZ,
                parsedData: chunkInfo.data, // Worker will handle parsed NBT directly
                isParsed: true,
              });
            } catch (e) {
              // Skip this neighbor if serialization fails
              console.warn(`[SuperChunkManager] Failed to serialize neighbor ${chunkInfo.chunkX},${chunkInfo.chunkZ}:`, e.message);
            }
          }
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
   * Solid/water/lava/glass meshes come from worker
   * Model meshes are built on main thread using serialized grids
   * 
   * All meshes for a super-chunk are created together to avoid visual popping.
   */
  async _createMeshesFromWorkerResult(superChunk, result) {
    // Debug logging disabled for performance
    // if (result.v3Debug) {
    //   console.log(`[V3 Debug] Worker result:`, result.v3Debug);
    // }
    
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
        mesh.renderOrder = 1; // Water renders after glass/leaves
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    // Lava mesh
    if (result.lava && result.lava.positions.length > 0) {
      const mesh = this._createMesh(result.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 2; // Lava renders after water
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
    
    // V3: Model meshes come directly from worker WASM
    // Track if V3 produced any model meshes to skip legacy fallback
    let v3ProducedModels = false;
    
    if (result.modelOpaque && result.modelOpaque.positions?.length > 0) {
      const mesh = this._createMesh(result.modelOpaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.modelMeshes.push(mesh);
        v3ProducedModels = true;
      }
    }
    
    if (result.modelTransparent && result.modelTransparent.positions?.length > 0) {
      const mesh = this._createMesh(result.modelTransparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
      if (mesh) {
        mesh.renderOrder = 0.5;
        superChunk.meshes.push(mesh);
        this.chunkManager.transparentModelMeshes.push(mesh);
        v3ProducedModels = true;
      }
    }
    
    if (result.modelOverlay && result.modelOverlay.positions?.length > 0) {
      const mesh = this._createMesh(result.modelOverlay, this.chunkManager.overlayMaterial, this.chunkManager.overlayGroup);
      if (mesh) {
        mesh.renderOrder = 0.1;
        superChunk.meshes.push(mesh);
        this.chunkManager.overlayMeshes?.push(mesh);
        v3ProducedModels = true;
      }
    }
    
    // End portal mesh (end_portal and end_gateway blocks with special shader effect)
    if (result.endPortal && result.endPortal.positions?.length > 0) {
      const mesh = this._createEndPortalMesh(result.endPortal);
      if (mesh) {
        superChunk.meshes.push(mesh);
        this.chunkManager.endPortalMeshes.push(mesh);
      }
    }
    
    // Register beacon positions (filtered by activation status)
    // Beacons with Levels = 0 (no valid pyramid) are excluded
    if (result.beaconPositions && result.beaconPositions.length > 0) {
      const beaconManager = this.chunkManager.beaconBeamManager;
      if (beaconManager) {
        // Build inactive set from worker result
        const inactiveSet = result.inactiveBeacons 
          ? new Set(result.inactiveBeacons) 
          : new Set();
        
        for (let i = 0; i < result.beaconPositions.length; i += 3) {
          const x = result.beaconPositions[i];
          const y = result.beaconPositions[i + 1];
          const z = result.beaconPositions[i + 2];
          
          // Skip inactive beacons (Levels = 0, no valid pyramid)
          const key = `${x},${y},${z}`;
          if (inactiveSet.has(key)) {
            continue;
          }
          
          beaconManager.addBeacon(x, y, z);
        }
      }
    }
    
    // Register particle emitters from worker (multipart meshing)
    if (result.particleEmitters && result.particleEmitters.length > 0) {
      const emitterManager = this.chunkManager.particleEmitterManager;
      if (emitterManager) {
        for (const emitter of result.particleEmitters) {
          emitterManager.addEmitter(emitter.blockType, emitter.x, emitter.y, emitter.z, emitter.properties);
        }
      }
    }
    
    // OPTIMIZED: Merge grid data into debugGrid for block lookups
    // Only merge sections - skip expensive bounds updates (computed lazily if needed)
    if (result.grids && result.grids.grid && this.chunkManager) {
      if (!this.chunkManager.debugGrid) {
        this.chunkManager.debugGrid = new BinaryGrid();
      }
      const gridData = result.grids.grid;
      if (gridData.sections) {
        // Fast path: just set sections, skip bounds checks
        for (const { key, data } of gridData.sections) {
          this.chunkManager.debugGrid.sections.set(key, data);
        }
        // Mark bounds as dirty - will be recomputed on first access if needed
        this.chunkManager.debugGrid._boundsDirty = true;
      }
    }
    
    // DEFERRED: Store raw state grid data for lazy remapping
    // State remapping is expensive (~1-3ms for detailed worlds) and only needed for block inspector
    // Store raw data and remap on-demand when getBlockDetails() is called
    if (result.grids && result.grids.stateGrid && this.chunkManager) {
      if (!this.chunkManager._pendingStateGrids) {
        this.chunkManager._pendingStateGrids = [];
      }
      // Store raw grid data with state mappings for later remapping
      this.chunkManager._pendingStateGrids.push({
        stateGrid: result.grids.stateGrid,
        states: result.grids.states,
      });
      this.chunkManager.debugStateRegistry = this.stateRegistry;
    }
    
    // Legacy fallback: Build model meshes from grids for multipart blocks
    // Only needed if worker didn't handle multipart meshing (fallback case)
    // When multipartMeshed is true, worker already built multipart meshes
    const workerHandledMultipart = result.v3Debug?.multipartMeshed === true;
    if (result.grids && !workerHandledMultipart) {
      // Queue model mesh building for next idle callback to avoid blocking this frame
      this._queueModelMeshBuild(superChunk, result.grids);
    }
  }
  
  /**
   * Queue model mesh building to happen in idle time
   * This prevents model meshing from blocking chunk appearance
   */
  _queueModelMeshBuild(superChunk, gridsData) {
    if (!this._modelMeshQueue) {
      this._modelMeshQueue = [];
    }
    
    // Compute bounds for this super-chunk to filter out neighbor data during meshing
    // Neighbor data is included in the grid for lighting/culling but shouldn't be meshed
    const bounds = {
      minChunkX: superChunk.superX * SUPER_CHUNK_SIZE,
      minChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE,
      maxChunkX: superChunk.superX * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
      maxChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
    };
    
    // Store the current build version to detect stale queue items
    this._modelMeshQueue.push({ 
      superChunk, 
      gridsData,
      bounds,
      buildVersion: superChunk.buildVersion,
    });
    
    // Schedule processing if not already scheduled
    if (!this._modelMeshScheduled) {
      this._modelMeshScheduled = true;
      // Use setTimeout with 0 to defer to next tick
      setTimeout(() => this._processModelMeshQueue(), 0);
    }
  }
  
  /**
   * Process queued model mesh builds in idle time
   * Processes one at a time to avoid frame spikes
   * 
   * OPTIMIZATION: Uses distance-based LOD to skip model blocks at distance.
   * This is the PRIMARY optimization for reducing triangle count.
   */
  async _processModelMeshQueue() {
    this._modelMeshScheduled = false;
    
    if (!this._modelMeshQueue || this._modelMeshQueue.length === 0) return;
    
    // Process one model mesh per idle callback
    const { superChunk, gridsData, bounds, buildVersion } = this._modelMeshQueue.shift();
    
    // Skip if this is stale data from an old build
    // The super chunk may have been rebuilt since this was queued
    if (buildVersion !== superChunk.buildVersion) {
      // Schedule next immediately - this one was stale
      if (this._modelMeshQueue.length > 0) {
        this._modelMeshScheduled = true;
        setTimeout(() => this._processModelMeshQueue(), 0);
      }
      return;
    }
    
    // OPTIMIZATION: Calculate LOD level based on distance from camera
    // This dramatically reduces triangle count for distant chunks
    const camera = this.chunkManager?.camera;
    const lodLevel = calculateModelLodLevel(superChunk.superX, superChunk.superZ, camera);
    trackLodUsage(lodLevel);
    logLodStats();
    
    // LOD 4 = skip all model meshes entirely
    if (lodLevel >= 4) {
      // Schedule next if more in queue
      if (this._modelMeshQueue.length > 0) {
        this._modelMeshScheduled = true;
        setTimeout(() => this._processModelMeshQueue(), 16);
      }
      return;
    }
    
    try {
      const modelResult = await this._buildModelMeshesFromWorkerGrids(gridsData, bounds, lodLevel);
      if (modelResult) {
        // Opaque models
        if (modelResult.opaque && modelResult.opaque.positions?.length > 0) {
          const mesh = this._createMesh(modelResult.opaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
          if (mesh) {
            superChunk.meshes.push(mesh);
            this.chunkManager.modelMeshes.push(mesh);
          }
        }
        
        // Transparent models
        if (modelResult.transparent && modelResult.transparent.positions?.length > 0) {
          const mesh = this._createMesh(modelResult.transparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
          if (mesh) {
            mesh.renderOrder = 0.5;
            superChunk.meshes.push(mesh);
            this.chunkManager.transparentModelMeshes.push(mesh);
          }
        }
        
        // Overlay models (grass side overlays)
        if (modelResult.overlay && modelResult.overlay.positions?.length > 0) {
          const mesh = this._createMesh(modelResult.overlay, this.chunkManager.overlayMaterial, this.chunkManager.overlayGroup);
          if (mesh) {
            mesh.renderOrder = 0.1;
            superChunk.meshes.push(mesh);
            this.chunkManager.overlayMeshes?.push(mesh);
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
      }
    } catch (error) {
      console.warn('[SuperChunkManager] Model mesh build failed:', error.message);
    }
    
    // Schedule next if more in queue
    if (this._modelMeshQueue.length > 0) {
      this._modelMeshScheduled = true;
      setTimeout(() => this._processModelMeshQueue(), 16); // ~60fps timing
    }
  }
  
  /**
   * Deserialize grids from worker and build model meshes on main thread
   * @param {Object} gridsData - Serialized grid data from worker
   * @param {Object} bounds - Optional chunk bounds to filter sections { minChunkX, minChunkZ, maxChunkX, maxChunkZ }
   * @param {number} lodLevel - LOD level for distance-based culling (0=full, 1-3=reduced, 4=skip all)
   */
  async _buildModelMeshesFromWorkerGrids(gridsData, bounds = null, lodLevel = 0) {
    if (!gridsData) return null;
    
    // Reconstruct BinaryGrid
    const grid = new BinaryGrid();
    if (gridsData.grid && gridsData.grid.sections) {
      for (const { key, data } of gridsData.grid.sections) {
        grid.sections.set(key, data);
      }
      grid.totalBlocks = gridsData.grid.totalBlocks;
      grid.minChunkX = gridsData.grid.minChunkX;
      grid.maxChunkX = gridsData.grid.maxChunkX;
      grid.minChunkZ = gridsData.grid.minChunkZ;
      grid.maxChunkZ = gridsData.grid.maxChunkZ;
      grid.minSectionY = gridsData.grid.minSectionY;
      grid.maxSectionY = gridsData.grid.maxSectionY;
    }
    
    // Build worker-to-main state ID mapping
    // Worker registers states during decoding with its own IDs
    // We need to re-register in main thread's stateRegistry to get correct IDs
    const workerToMainStateId = new Map();
    if (gridsData.states) {
      for (const { workerStateId, blockName, properties } of gridsData.states) {
        // Re-register in main thread's stateRegistry to get consistent ID
        const mainStateId = this.stateRegistry.register(blockName, properties);
        workerToMainStateId.set(workerStateId, mainStateId);
      }
    }
    
    // Reconstruct BlockStateGrid with remapped state IDs
    const stateGrid = new BlockStateGrid();
    if (gridsData.stateGrid) {
      for (const { key, data } of gridsData.stateGrid) {
        // Remap worker state IDs to main thread state IDs
        const remappedData = new Uint16Array(data.length);
        for (let i = 0; i < data.length; i++) {
          const workerStateId = data[i];
          if (workerStateId !== 0) {
            remappedData[i] = workerToMainStateId.get(workerStateId) || 0;
          }
        }
        stateGrid.sections.set(key, remappedData);
      }
    }
    
    // Reconstruct LightGrid
    const lightGrid = new LightGrid();
    if (gridsData.lightGrid && gridsData.lightGrid.sections) {
      for (const { key, data } of gridsData.lightGrid.sections) {
        lightGrid.sections.set(key, data);
      }
      lightGrid.hasMinecraftLightData = gridsData.lightGrid.hasMinecraftLightData;
    }
    
    // CRITICAL: Precompute geometry for all registered states before building meshes
    // This is what the working path (_buildSuperChunkWithWasm) does
    if (this.stateRegistry?.precomputeAll) {
      await this.stateRegistry.precomputeAll();
    }
    
    // Build model meshes using full ModelMesher
    // multipartOnly=true because V3 handles non-multipart model blocks (stairs, slabs, etc.)
    // Legacy mesher only needs to render multipart blocks (fences, walls, panes, redstone_wire)
    // bounds filters out neighbor chunk data that was included for lighting/culling lookups
    // lodLevel enables distance-based culling (0=full, 1=skip flowers/grass, 2=skip more, 3=structural only)
    const offset = { x: 0, y: 0, z: 0 };
    const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
    const collectEmitters = this.chunkManager.particleQuality !== 'off';
    const effectiveLightGrid = this.chunkManager.smoothLightingEnabled ? lightGrid : null;
    const mesherOptions = { 
      textureIndexLookup, 
      lightGrid: effectiveLightGrid, 
      collectEmitters, 
      multipartOnly: true, 
      bounds,
      lodLevel, // OPTIMIZATION: Distance-based model culling
    };
    
    const result = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
    
    // Debug result
    if (!this._modelResultLogged) {
      this._modelResultLogged = true;
      console.log('[SuperChunkManager] Model mesh result:', {
        hasOpaque: !!result?.opaque,
        opaqueVerts: result?.opaque?.vertexCount || 0,
        hasTransparent: !!result?.transparent,
        transparentVerts: result?.transparent?.vertexCount || 0,
        hasParticles: !!result?.particleEmitters?.length,
      });
    }
    
    return result;
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
        mesh.renderOrder = 1; // Water renders after glass/leaves
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    if (meshResult.lava && meshResult.lava.positions.length > 0) {
      const mesh = this._createMesh(meshResult.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 2; // Lava renders after water
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
      
      // OPTIMIZATION: Calculate LOD level based on distance from camera
      const camera = this.chunkManager?.camera;
      const lodLevel = calculateModelLodLevel(superChunk.superX, superChunk.superZ, camera);
      
      // LOD 4 = skip all model meshes entirely
      if (lodLevel >= 4) {
        // Skip model meshing for distant chunks
      } else {
        const mesherOptions = { textureIndexLookup, lightGrid: effectiveLightGrid, collectEmitters, lodLevel };
      
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
      } // End of else block for LOD 4 check
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
        mesh.renderOrder = 1; // Water renders after glass/leaves
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    // Lava mesh
    if (meshData.lava && meshData.lava.positions.length > 0) {
      const data = this._convertArraysToTypedArrays(meshData.lava);
      const mesh = this._createMesh(data, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 2; // Lava renders after water
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
    
    // Skip neighbor marking entirely if disabled
    // The race condition fix (rebuildPending flag) prevents duplicate meshes,
    // so neighbor rebuilds are optional for visual polish only
    if (this._disableNeighborRebuilds) return;
    
    const sx = superChunk.superX;
    const sz = superChunk.superZ;
    
    // Only mark cardinal neighbors (N, S, E, W) - corners rarely have visible artifacts
    // This reduces rebuild overhead by 50% (4 instead of 8 neighbors)
    const neighborOffsets = [
      { dx: -1, dz: 0 },  // West
      { dx: 1, dz: 0 },   // East
      { dx: 0, dz: -1 },  // North
      { dx: 0, dz: 1 },   // South
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
      await this._createMeshesFromWorkerResult(superChunk, meshResult);
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
      
      // Try to lazy-init model registry V2 if we have states but registry isn't initialized yet
      // This handles edge cases where preregisterNonCubeBlocks wasn't called
      if (this.stateRegistry && !isModelRegistryV2Initialized() && !this._modelRegistryV2InitAttempted) {
        this._modelRegistryV2InitAttempted = true;
        try {
          await this.stateRegistry.precomputeAll();
          const success = initModelRegistryV2(this.stateRegistry);
          if (success) {
            console.log('[SuperChunkManager] WASM model registry V2 lazy-initialized');
          }
        } catch (err) {
          // Silent - will use JS fallback
        }
      }
      
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
          mesh.renderOrder = 1; // Water renders after glass/leaves
          superChunk.meshes.push(mesh);
          this.chunkManager.waterMeshes.push(mesh);
        }
      }
      
      if (meshResult.lava && meshResult.lava.positions.length > 0) {
        const mesh = this._createMesh(meshResult.lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
        if (mesh) {
          mesh.renderOrder = 2; // Lava renders after water
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
      
      // Try WASM model meshing first if model registry V2 is initialized
      const useWasmModels = isModelRegistryV2Initialized() && 
        meshResult.modelOpaque && meshResult.modelOpaque.vertexCount > 0;
      
      if (useWasmModels) {
        // Use WASM model mesh results
        if (meshResult.modelOpaque && meshResult.modelOpaque.positions.length > 0) {
          const mesh = this._createMesh(meshResult.modelOpaque, this.chunkManager.modelMaterial, this.chunkManager.modelGroup);
          if (mesh) {
            superChunk.meshes.push(mesh);
            this.chunkManager.modelMeshes.push(mesh);
          }
        }
        
        if (meshResult.modelTransparent && meshResult.modelTransparent.positions.length > 0) {
          const mesh = this._createMesh(meshResult.modelTransparent, this.chunkManager.transparentModelMaterial, this.chunkManager.transparentModelGroup);
          if (mesh) {
            mesh.renderOrder = 0.5;
            superChunk.meshes.push(mesh);
            this.chunkManager.transparentModelMeshes.push(mesh);
          }
        }
        
        if (meshResult.modelOverlay && meshResult.modelOverlay.positions.length > 0) {
          const mesh = this._createMesh(meshResult.modelOverlay, this.chunkManager.overlayModelMaterial, this.chunkManager.overlayModelGroup);
          if (mesh) {
            mesh.renderOrder = 4;
            superChunk.meshes.push(mesh);
            this.chunkManager.overlayModelMeshes.push(mesh);
          }
        }
      } else if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
        // Fall back to JS model meshing
        await this.stateRegistry.precomputeAll();
        
        const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
        const collectEmitters = this.chunkManager.particleQuality !== 'off';
        
        // OPTIMIZATION: Calculate LOD level based on distance from camera
        const camera = this.chunkManager?.camera;
        const lodLevel = calculateModelLodLevel(superChunk.superX, superChunk.superZ, camera);
        
        // LOD 4 = skip all model meshes entirely
        let modelResult = null;
        if (lodLevel < 4) {
          // Use effectiveLightGrid to skip smooth lighting when disabled
          const mesherOptions = { textureIndexLookup, lightGrid: effectiveLightGrid, collectEmitters, lodLevel };
          modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, mesherOptions);
        }
        
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
        mesh.renderOrder = 1; // Water renders after glass/leaves
        superChunk.meshes.push(mesh);
        this.chunkManager.waterMeshes.push(mesh);
      }
    }
    
    if (lava && lava.positions.length > 0) {
      const mesh = this._createMesh(lava, this.chunkManager.lavaMaterial, this.chunkManager.lavaGroup);
      if (mesh) {
        mesh.renderOrder = 2; // Lava renders after water
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
      
      // OPTIMIZATION: Calculate LOD level based on distance from camera
      const camera = this.chunkManager?.camera;
      const lodLevel = calculateModelLodLevel(superChunk.superX, superChunk.superZ, camera);
      
      // LOD 4 = skip all model meshes entirely
      let modelResult = null;
      if (lodLevel < 4) {
        const modelMesherOptions = { ...mesherOptions, lodLevel };
        modelResult = buildModelMeshesWithInstancing(grid, stateGrid, this.registry, this.stateRegistry, offset, modelMesherOptions);
      }
      
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
    
    // Use pre-computed bounds from worker if available (avoids main thread computation)
    // This is a significant performance win as computeBoundingSphere iterates all vertices
    if (data.boundingSphere) {
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(
          data.boundingSphere.center.x,
          data.boundingSphere.center.y,
          data.boundingSphere.center.z
        ),
        data.boundingSphere.radius
      );
    } else {
      // Fallback for meshes without pre-computed bounds
      geometry.computeBoundingSphere();
    }
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    // PERFORMANCE: Disable matrix auto-update since meshes are static
    // This saves CPU time as Three.js won't recalculate matrices every frame
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();  // Compute once
    mesh.updateMatrixWorld(true);  // Ensure world matrix is up-to-date
    
    // Use pre-computed bounding box from worker if available
    if (data.boundingBox) {
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(
          data.boundingBox.min.x,
          data.boundingBox.min.y,
          data.boundingBox.min.z
        ),
        new THREE.Vector3(
          data.boundingBox.max.x,
          data.boundingBox.max.y,
          data.boundingBox.max.z
        )
      );
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      mesh.userData.chunkCenterX = center.x;
      mesh.userData.chunkCenterZ = center.z;
    } else {
      // Fallback: compute bounding box for visibility calculations
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      mesh.userData.chunkCenterX = center.x;
      mesh.userData.chunkCenterZ = center.z;
    }
    
    // Stagger visibility: start invisible, queue for warmup
    // This spreads GPU buffer uploads across frames
    if (this._staggerVisibility) {
      mesh.visible = false;
      this.visibilityWarmupQueue.add(mesh);
    }
    
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
        // Skip if a rebuild is already in progress (race condition prevention)
        if (superChunk.rebuildPending) {
          continue;
        }
        superChunk.rebuildPending = true;
        
        const oldMeshes = [...superChunk.meshes];
        this._hideOldMeshes(oldMeshes);
        await this.buildSuperChunk(superChunk, true);
        this._disposeOldMeshes(oldMeshes);
        
        superChunk.rebuildPending = false;
        rebuiltCount++;
      }
      this.dirtySet.delete(key);
      this.boundaryDirtySet.delete(key);
    }
    
    return rebuiltCount;
  }

  /**
   * Parallel rebuild using worker pool - dispatches all jobs at once
   * 
   * Jobs are dispatched to workers in parallel. As results arrive, they are
   * queued to the completion queue which processes 1-2 super-chunks per frame.
   * This spreads mesh creation across frames to avoid lag spikes.
   */
  async _rebuildDirtyParallel(keysToRebuild) {
    // Collect all super-chunks and their old meshes
    const buildJobs = [];
    
    for (const key of keysToRebuild) {
      const superChunk = this.superChunks.get(key);
      if (!superChunk) continue;
      
      // Skip if a rebuild is already in progress (race condition prevention)
      if (superChunk.rebuildPending) {
        continue;
      }
      
      // Check if we can use worker pool for this chunk
      const hasRawCompressed = [...superChunk.loadedChunks.values()].some(c => c.isRawCompressed);
      if (!hasRawCompressed) continue;
      
      // Mark as rebuild pending to prevent concurrent rebuilds
      superChunk.rebuildPending = true;
      
      // CRITICAL: Increment build version FIRST to invalidate any pending queued
      // operations BEFORE we capture oldMeshes or clear the meshes array.
      // This prevents race conditions where a model mesh queue item could:
      // 1. Process after meshes = [] but before version++
      // 2. Pass the version check (version not changed yet)
      // 3. Add a mesh that's NOT in oldMeshes
      // 4. Result in orphaned duplicate meshes that never get disposed
      superChunk.buildVersion++;
      const buildVersion = superChunk.buildVersion;
      
      // Store old meshes to dispose after new ones are ready
      const oldMeshes = [...superChunk.meshes];
      console.log('[DEBUG PARALLEL] Captured oldMeshes for', superChunk.superX, superChunk.superZ,
        'buildVersion:', buildVersion, 'meshCount:', oldMeshes.length);
      superChunk.meshes = [];
      
      // Collect job data - IMPORTANT: clone ArrayBuffers for parallel dispatch
      const chunks = [];
      for (const [, chunkInfo] of superChunk.loadedChunks) {
        if (!chunkInfo.isRawCompressed || !chunkInfo.data) continue;
        const originalBuffer = chunkInfo.data.compressedData;
        chunks.push({
          chunkX: chunkInfo.chunkX,
          chunkZ: chunkInfo.chunkZ,
          compressedData: originalBuffer.slice(0),
          compressionType: chunkInfo.data.compressionType,
        });
      }
      
      if (chunks.length === 0) continue;
      
      // Clone neighbor buffers too
      const neighbors = this._collectNeighborDataForWorker(superChunk, true);
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
        buildVersion,
        jobData: { chunks, neighbors, bounds, priority: 0, superChunkKey: key },
      });
      
      // Mark as no longer dirty immediately (prevents re-queuing)
      this.dirtySet.delete(key);
      this.boundaryDirtySet.delete(key);
    }
    
    if (buildJobs.length === 0) return 0;
    
    // Track pending jobs
    this._pendingWorkerJobs += buildJobs.length;
    
    // Dispatch ALL jobs to workers in parallel, queue results as they complete
    for (const job of buildJobs) {
      this.superChunkWorkerPool.process(job.jobData)
        .then(result => {
          // Queue successful result for processing across frames
          this.completionQueue.add(job, result);
        })
        .catch(error => {
          console.warn(`[SuperChunkManager] Worker failed for ${job.key}:`, error.message);
          // Clear rebuild pending flag on error
          job.superChunk.rebuildPending = false;
          // Re-add to dirty set for retry
          this.dirtySet.add(job.key);
          this._pendingWorkerJobs--;
        });
    }
    
    // Return number of jobs dispatched (not yet completed)
    return buildJobs.length;
  }
  
  /**
   * Immediately process boundary repairs to minimize visible artifacts
   * @param {number} maxRepairs - Maximum number of repairs to process
   */
  async _processBoundaryRepairsImmediate(maxRepairs) {
    const keysToRepair = [...this.boundaryDirtySet].slice(0, maxRepairs);
    
    for (const key of keysToRepair) {
      const superChunk = this.superChunks.get(key);
      if (!superChunk || !superChunk.hasBeenBuilt) {
        this.boundaryDirtySet.delete(key);
        this.dirtySet.delete(key);
        continue;
      }
      
      // Skip if a rebuild is already in progress (race condition prevention)
      if (superChunk.rebuildPending) {
        continue;
      }
      
      // Check if we can use worker pool
      const hasRawCompressed = [...superChunk.loadedChunks.values()].some(c => c.isRawCompressed);
      if (!hasRawCompressed || !this.useSuperChunkWorkerPool) {
        continue; // Skip - let normal rebuild handle it
      }
      
      superChunk.rebuildPending = true;
      
      // Collect chunks and neighbors
      const chunks = [];
      for (const [, chunkInfo] of superChunk.loadedChunks) {
        if (!chunkInfo.isRawCompressed || !chunkInfo.data) continue;
        chunks.push({
          chunkX: chunkInfo.chunkX,
          chunkZ: chunkInfo.chunkZ,
          compressedData: chunkInfo.data.compressedData.slice(0),
          compressionType: chunkInfo.data.compressionType,
        });
      }
      
      if (chunks.length === 0) {
        superChunk.rebuildPending = false;
        continue;
      }
      
      const neighbors = this._collectNeighborDataForWorker(superChunk, true);
      const bounds = {
        minChunkX: superChunk.superX * SUPER_CHUNK_SIZE,
        minChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE,
        maxChunkX: superChunk.superX * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
        maxChunkZ: superChunk.superZ * SUPER_CHUNK_SIZE + SUPER_CHUNK_SIZE - 1,
      };
      
      const oldMeshes = [...superChunk.meshes];
      this._hideOldMeshes(oldMeshes);
      
      try {
        const { result } = await this.superChunkWorkerPool.process({
          chunks, neighbors, bounds,
          priority: 100, // High priority for boundary repairs
          superChunkKey: key,
        });
        
        await this._createMeshesFromWorkerResult(superChunk, result);
        this._disposeOldMeshes(oldMeshes);
        
        superChunk.isDirty = false;
        // Don't mark neighbors dirty again - this is a repair, not first build
      } catch (error) {
        console.warn(`[SuperChunkManager] Boundary repair failed for ${key}:`, error.message);
      }
      
      superChunk.rebuildPending = false;
      this.boundaryDirtySet.delete(key);
      this.dirtySet.delete(key);
    }
  }

  /**
   * Helper to dispose old meshes
   */
  _disposeOldMeshes(oldMeshes) {
    console.log('[DEBUG DISPOSE] Disposing', oldMeshes.length, 'old meshes',
      'transparentModelMeshes before:', this.chunkManager.transparentModelMeshes?.length || 0);
    
    // Debug: Check for duplicate meshes in the scene
    if (oldMeshes.length > 0 && !globalThis._checkedDuplicates) {
      globalThis._checkedDuplicates = true;
      const tmm = this.chunkManager.transparentModelMeshes;
      if (tmm) {
        const uniqueIds = new Set(tmm.map(m => m.id));
        if (uniqueIds.size !== tmm.length) {
          console.warn('[DEBUG] DUPLICATE MESHES DETECTED!', 
            'total:', tmm.length, 'unique:', uniqueIds.size);
        }
      }
    }
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
   * Helper to hide old meshes BEFORE creating new ones.
   * This prevents transparent mesh overlap during rebuilds which causes
   * incorrect alpha blending (flickering/darkness).
   */
  _hideOldMeshes(oldMeshes) {
    for (const mesh of oldMeshes) {
      mesh.visible = false;
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
    
    // Use pre-computed bounds from worker if available (avoids main thread computation)
    if (meshData.boundingSphere) {
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(
          meshData.boundingSphere.center.x,
          meshData.boundingSphere.center.y,
          meshData.boundingSphere.center.z
        ),
        meshData.boundingSphere.radius
      );
    } else {
      geometry.computeBoundingSphere();
    }
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    // Use pre-computed bounding box from worker if available
    if (meshData.boundingBox) {
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(
          meshData.boundingBox.min.x,
          meshData.boundingBox.min.y,
          meshData.boundingBox.min.z
        ),
        new THREE.Vector3(
          meshData.boundingBox.max.x,
          meshData.boundingBox.max.y,
          meshData.boundingBox.max.z
        )
      );
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      mesh.userData.chunkCenterX = center.x;
      mesh.userData.chunkCenterZ = center.z;
    } else {
      // Fallback: compute bounding box for visibility calculations
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      mesh.userData.chunkCenterX = center.x;
      mesh.userData.chunkCenterZ = center.z;
    }
    
    // Stagger visibility: start invisible, queue for warmup
    // This spreads GPU buffer uploads across frames
    if (this._staggerVisibility) {
      mesh.visible = false;
      this.visibilityWarmupQueue.add(mesh);
    }
    
    group.add(mesh);
    
    return mesh;
  }
  
  /**
   * Create a mesh specifically for end portal blocks (end_portal and end_gateway)
   * Uses the end portal material with its special shader effect
   * 
   * @param {Object} meshData - Mesh data with positions, normals, indices
   * @returns {THREE.Mesh|null} The created mesh or null if invalid
   */
  _createEndPortalMesh(meshData) {
    if (!meshData) return null;
    if (!meshData.positions || meshData.positions.length === 0) return null;
    if (!meshData.normals || meshData.normals.length === 0) return null;
    if (!meshData.indices || meshData.indices.length === 0) return null;
    
    const material = this.chunkManager.endPortalMaterial;
    const group = this.chunkManager.endPortalGroup;
    if (!material || !group) return null;
    
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    
    // Use pre-computed bounds from worker if available
    if (meshData.boundingSphere) {
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(
          meshData.boundingSphere.center.x,
          meshData.boundingSphere.center.y,
          meshData.boundingSphere.center.z
        ),
        meshData.boundingSphere.radius
      );
    } else {
      geometry.computeBoundingSphere();
    }
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    
    // Use pre-computed bounding box from worker if available
    if (meshData.boundingBox) {
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(
          meshData.boundingBox.min.x,
          meshData.boundingBox.min.y,
          meshData.boundingBox.min.z
        ),
        new THREE.Vector3(
          meshData.boundingBox.max.x,
          meshData.boundingBox.max.y,
          meshData.boundingBox.max.z
        )
      );
    } else {
      geometry.computeBoundingBox();
    }
    
    // Stagger visibility like other meshes
    if (this._staggerVisibility) {
      mesh.visible = false;
      this.visibilityWarmupQueue.add(mesh);
    }
    
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
        // Skip if a rebuild is already in progress (race condition prevention)
        if (superChunk.rebuildPending) {
          continue;
        }
        superChunk.rebuildPending = true;
        
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
        
        superChunk.rebuildPending = false;
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
      superChunk.dispose(this);
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
   * DEBUG: Log mesh statistics to identify overlapping meshes
   * Call from console: window.superChunkManager?.debugMeshStats()
   */
  debugMeshStats() {
    const tmm = this.chunkManager.transparentModelMeshes || [];
    console.log('=== TRANSPARENT MODEL MESH STATS ===');
    console.log('Total meshes:', tmm.length);
    
    // Count meshes by checking their bounding box centers
    const byRegion = new Map();
    for (const mesh of tmm) {
      if (!mesh.geometry?.boundingBox) {
        mesh.geometry?.computeBoundingBox();
      }
      const bb = mesh.geometry?.boundingBox;
      if (bb) {
        const cx = Math.floor((bb.min.x + bb.max.x) / 2 / 32);
        const cz = Math.floor((bb.min.z + bb.max.z) / 2 / 32);
        const key = `${cx},${cz}`;
        if (!byRegion.has(key)) byRegion.set(key, []);
        byRegion.get(key).push(mesh);
      }
    }
    
    // Log regions with multiple meshes (potential duplicates)
    for (const [key, meshes] of byRegion) {
      if (meshes.length > 1) {
        console.log(`Region ${key}: ${meshes.length} transparent model meshes (POTENTIAL OVERLAP)`);
        for (const m of meshes) {
          console.log(`  mesh id=${m.id} visible=${m.visible} parent=${!!m.parent}`);
        }
      }
    }
    
    // Also check for hidden but not removed meshes
    const hidden = tmm.filter(m => !m.visible);
    if (hidden.length > 0) {
      console.log(`WARNING: ${hidden.length} hidden but not removed meshes!`);
    }
    
    // Check for meshes without parent (orphaned)
    const orphaned = tmm.filter(m => !m.parent);
    if (orphaned.length > 0) {
      console.log(`WARNING: ${orphaned.length} orphaned meshes (no parent)!`);
    }
    
    console.log('===================================');
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

