/**
 * UnifiedMeshPipeline - Selects and uses the optimal meshing path
 * 
 * This module provides a unified interface for chunk meshing, automatically
 * selecting the best available path based on hardware capabilities:
 * 
 * 1. WebGPU compute shaders (fastest, requires WebGPU)
 * 2. WASM with Rayon parallelism (fast, requires SharedArrayBuffer)
 * 3. Single-threaded WASM (good, widely supported)
 * 4. Pure JavaScript (fallback)
 * 
 * Usage:
 *   const pipeline = new UnifiedMeshPipeline();
 *   await pipeline.initialize();
 *   const result = await pipeline.meshSuperChunk(grid, lightGrid, stateGrid, bounds);
 */

import { 
  MeshingPath, 
  selectMeshingPath, 
  getCurrentMeshingPath,
  detectWebGPU,
} from '../utils/CapabilityDetector.js';
import { WebGPUMesher } from './gpu/WebGPUMesher.js';
import { getGPUMeshAdapter } from './gpu/GPUMeshAdapter.js';

/**
 * Configuration for unified pipeline
 */
const CONFIG = {
  // Whether to auto-detect the best path (vs using explicit setting)
  autoDetect: true,
  // Fallback path if detection fails
  fallbackPath: MeshingPath.WASM,
  // Enable path switching on failure
  enableFallback: true,
  // Log path selection and timing
  debug: false,
};

/**
 * Unified meshing pipeline with automatic path selection
 */
export class UnifiedMeshPipeline {
  constructor(options = {}) {
    this.options = { ...CONFIG, ...options };
    this.initialized = false;
    this.currentPath = null;
    
    // Path-specific meshers
    this.webgpuMesher = null;
    this.gpuAdapter = null;
    
    // Stats
    this.stats = {
      meshCount: 0,
      totalTime: 0,
      pathUsage: {},
    };
  }
  
  /**
   * Initialize the pipeline and detect optimal path
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this.initialized) return true;
    
    try {
      // Detect and select the optimal path
      this.currentPath = await selectMeshingPath();
      
      // Initialize path-specific resources
      switch (this.currentPath) {
        case MeshingPath.WEBGPU:
          await this._initializeWebGPU();
          break;
        case MeshingPath.WASM_PARALLEL:
          await this._initializeWasmParallel();
          break;
        case MeshingPath.WASM:
          // WASM meshing is handled by worker pool, no special init needed
          break;
        case MeshingPath.JS:
          // JavaScript fallback needs no special init
          break;
      }
      
      this.initialized = true;
      console.log(`[UnifiedMeshPipeline] Initialized with path: ${this.currentPath}`);
      return true;
    } catch (error) {
      console.error('[UnifiedMeshPipeline] Initialization failed:', error);
      return false;
    }
  }
  
  /**
   * Initialize WebGPU meshing resources
   * @private
   */
  async _initializeWebGPU() {
    this.webgpuMesher = new WebGPUMesher();
    const success = await this.webgpuMesher.initialize();
    
    if (!success) {
      console.warn('[UnifiedMeshPipeline] WebGPU init failed, falling back to WASM');
      this.currentPath = MeshingPath.WASM;
      return;
    }
    
    // Initialize GPU mesh adapter
    this.gpuAdapter = getGPUMeshAdapter();
    this.gpuAdapter.initialize(this.webgpuMesher.device);
  }
  
  /**
   * Initialize WASM parallel meshing
   * @private
   */
  async _initializeWasmParallel() {
    // The worker will handle Rayon thread pool initialization
    // This is called when the worker is created
  }
  
  /**
   * Mesh a super-chunk using the selected path
   * 
   * @param {BinaryGrid} grid - Block grid
   * @param {LightGrid} lightGrid - Light data
   * @param {BlockStateGrid} stateGrid - Block state grid
   * @param {Object} bounds - Mesh bounds
   * @returns {Promise<Object>} Mesh result
   */
  async meshSuperChunk(grid, lightGrid, stateGrid, bounds) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const startTime = performance.now();
    let result;
    
    try {
      switch (this.currentPath) {
        case MeshingPath.WEBGPU:
          result = await this._meshWithWebGPU(grid, lightGrid, stateGrid, bounds);
          break;
        case MeshingPath.WASM_PARALLEL:
        case MeshingPath.WASM:
          // WASM meshing is handled by the worker pool
          // This function is for cases where we need to mesh on main thread
          result = await this._meshWithWasm(grid, lightGrid, stateGrid, bounds);
          break;
        case MeshingPath.JS:
          result = await this._meshWithJS(grid, lightGrid, stateGrid, bounds);
          break;
        default:
          throw new Error(`Unknown meshing path: ${this.currentPath}`);
      }
    } catch (error) {
      console.error(`[UnifiedMeshPipeline] ${this.currentPath} meshing failed:`, error);
      
      if (this.options.enableFallback) {
        // Try fallback path
        result = await this._meshWithFallback(grid, lightGrid, stateGrid, bounds);
      } else {
        throw error;
      }
    }
    
    const elapsed = performance.now() - startTime;
    this._recordStats(elapsed);
    
    return result;
  }
  
  /**
   * Mesh using WebGPU compute shaders
   * @private
   */
  async _meshWithWebGPU(grid, lightGrid, stateGrid, bounds) {
    if (!this.webgpuMesher) {
      throw new Error('WebGPU mesher not initialized');
    }
    
    // WebGPU meshing implementation
    const gpuResult = await this.webgpuMesher.meshSuperChunk(grid, lightGrid, stateGrid, bounds);
    
    // Convert GPU buffers to Three.js geometry
    const geometry = await this.gpuAdapter.createGeometry(
      gpuResult.vertexBuffer,
      gpuResult.indexBuffer,
      gpuResult.vertexCount,
      gpuResult.indexCount
    );
    
    return {
      solid: { geometry, vertexCount: gpuResult.vertexCount },
      water: { geometry: null, vertexCount: 0 },
      lava: { geometry: null, vertexCount: 0 },
      glass: { geometry: null, vertexCount: 0 },
    };
  }
  
  /**
   * Mesh using WASM (single-threaded or parallel)
   * @private
   */
  async _meshWithWasm(grid, lightGrid, stateGrid, bounds) {
    // This is typically handled by the worker pool
    // For main-thread usage, we'd need to load the WASM module directly
    throw new Error('Main thread WASM meshing should use worker pool');
  }
  
  /**
   * Mesh using pure JavaScript (slowest, always works)
   * @private
   */
  async _meshWithJS(grid, lightGrid, stateGrid, bounds) {
    // Import JavaScript mesher dynamically
    const { buildGridMeshes } = await import('./FastMesher.js');
    const { buildModelMeshesWithInstancing } = await import('./ModelMesher.js');
    
    const result = await buildGridMeshes(grid, lightGrid, stateGrid, {
      bounds,
    });
    
    return result;
  }
  
  /**
   * Fallback meshing when primary path fails
   * @private
   */
  async _meshWithFallback(grid, lightGrid, stateGrid, bounds) {
    console.warn('[UnifiedMeshPipeline] Using JavaScript fallback');
    return this._meshWithJS(grid, lightGrid, stateGrid, bounds);
  }
  
  /**
   * Record timing stats
   * @private
   */
  _recordStats(elapsed) {
    this.stats.meshCount++;
    this.stats.totalTime += elapsed;
    
    if (!this.stats.pathUsage[this.currentPath]) {
      this.stats.pathUsage[this.currentPath] = { count: 0, time: 0 };
    }
    this.stats.pathUsage[this.currentPath].count++;
    this.stats.pathUsage[this.currentPath].time += elapsed;
  }
  
  /**
   * Get current statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      averageTime: this.stats.meshCount > 0 
        ? this.stats.totalTime / this.stats.meshCount 
        : 0,
      currentPath: this.currentPath,
    };
  }
  
  /**
   * Get the currently active meshing path
   * @returns {string}
   */
  getCurrentPath() {
    return this.currentPath;
  }
  
  /**
   * Force a specific meshing path
   * @param {string} path - One of MeshingPath values
   */
  async setPath(path) {
    if (this.currentPath === path) return;
    
    this.currentPath = path;
    this.initialized = false;
    
    // Re-initialize with new path
    await this.initialize();
  }
  
  /**
   * Clean up resources
   */
  dispose() {
    if (this.webgpuMesher) {
      this.webgpuMesher.dispose();
      this.webgpuMesher = null;
    }
    if (this.gpuAdapter) {
      this.gpuAdapter.dispose();
      this.gpuAdapter = null;
    }
    
    this.initialized = false;
  }
}

// Singleton instance
let pipelineInstance = null;

/**
 * Get the global unified mesh pipeline
 * @returns {UnifiedMeshPipeline}
 */
export function getUnifiedMeshPipeline() {
  if (!pipelineInstance) {
    pipelineInstance = new UnifiedMeshPipeline();
  }
  return pipelineInstance;
}

export default {
  UnifiedMeshPipeline,
  getUnifiedMeshPipeline,
  CONFIG,
};
