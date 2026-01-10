/**
 * CapabilityDetector - Detect hardware and browser capabilities
 * 
 * Provides adaptive configuration recommendations based on:
 * - CPU cores and estimated memory
 * - Browser API support (DecompressionStream, SharedArrayBuffer, etc.)
 * - Worker support and module worker availability
 * 
 * Used by SuperChunkWorkerPool to optimize worker count and batch sizes.
 */

/**
 * Detected capabilities object
 * @typedef {Object} Capabilities
 * @property {number} cores - Number of logical CPU cores
 * @property {number} memory - Estimated device memory in GB
 * @property {boolean} hasNativeDecompress - Native DecompressionStream API available
 * @property {boolean} hasTransferable - Transferable objects supported
 * @property {boolean} hasSharedArrayBuffer - SharedArrayBuffer available
 * @property {boolean} hasOffscreenCanvas - OffscreenCanvas available
 * @property {boolean} supportsModuleWorkers - ES module workers supported
 * @property {boolean} hasWebWorkers - Basic Web Worker support
 * @property {'low'|'mid'|'high'} tier - Hardware tier classification
 */

/**
 * Worker pool configuration
 * @typedef {Object} WorkerConfig
 * @property {number} workers - Recommended number of workers
 * @property {number} batchSize - Super-chunks to process per batch
 * @property {'every'|'batch'|'none'} yieldFrequency - How often to yield to main thread
 * @property {number} maxMemoryMB - Maximum memory budget for workers
 * @property {boolean} useNativeDecompress - Whether to use native decompression
 * @property {boolean} cacheNeighborData - Whether to cache decompressed neighbor chunks
 */

// Cached capabilities - detected once on first call
let cachedCapabilities = null;

/**
 * Test if ES module workers are supported
 * @returns {boolean}
 */
function testModuleWorkerSupport() {
  try {
    // Create a minimal test to check module worker support
    // This doesn't actually create a worker, just checks the capability
    const blob = new Blob([''], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    
    // Check if Worker constructor accepts type: 'module'
    // Most modern browsers support this, but we need to handle older ones
    const supportsModule = 'Worker' in globalThis && 
      typeof globalThis.Worker === 'function';
    
    URL.revokeObjectURL(url);
    
    // Chrome 80+, Firefox 114+, Safari 15+ support module workers
    // We'll be conservative and check for specific features
    return supportsModule && typeof import.meta !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Detect hardware and browser capabilities
 * Results are cached after first call.
 * 
 * @returns {Capabilities}
 */
export function detectCapabilities() {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }
  
  // CPU cores - default to 4 if not available
  const cores = typeof navigator !== 'undefined' 
    ? navigator.hardwareConcurrency || 4 
    : 4;
  
  // Device memory in GB - default to 4 if not available
  // Note: navigator.deviceMemory is only available in Chrome/Edge
  const memory = typeof navigator !== 'undefined' && 'deviceMemory' in navigator
    ? navigator.deviceMemory
    : 4;
  
  // Native DecompressionStream API (Chrome 80+, Firefox 113+, Safari 16.4+)
  const hasNativeDecompress = typeof DecompressionStream !== 'undefined';
  
  // Transferable objects (ArrayBuffer.transfer or structured clone with transfer)
  const hasTransferable = typeof ArrayBuffer !== 'undefined' && 
    typeof structuredClone === 'function';
  
  // SharedArrayBuffer - requires COOP/COEP headers
  // May be disabled in some contexts for security
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  
  // OffscreenCanvas for off-thread rendering
  const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  
  // ES module workers
  const supportsModuleWorkers = testModuleWorkerSupport();
  
  // Basic Web Worker support
  const hasWebWorkers = typeof Worker !== 'undefined';
  
  // WebGPU support (Phase 5.1)
  // WebGPU is available in Chrome 113+, Edge 113+, Firefox Nightly
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
  
  // Classify hardware tier
  let tier;
  if (cores <= 4 || memory < 4) {
    tier = 'low';
  } else if (cores <= 8 || memory < 8) {
    tier = 'mid';
  } else {
    tier = 'high';
  }
  
  cachedCapabilities = {
    cores,
    memory,
    hasNativeDecompress,
    hasTransferable,
    hasSharedArrayBuffer,
    hasOffscreenCanvas,
    supportsModuleWorkers,
    hasWebWorkers,
    hasWebGPU,
    tier,
  };
  
  // Log detected capabilities for debugging
  console.log('[CapabilityDetector] Detected capabilities:', {
    cores,
    memory: `${memory}GB`,
    tier,
    nativeDecompress: hasNativeDecompress,
    sharedArrayBuffer: hasSharedArrayBuffer,
    moduleWorkers: supportsModuleWorkers,
    webGPU: hasWebGPU,
  });
  
  return cachedCapabilities;
}

/**
 * Get optimal worker pool configuration based on capabilities
 * 
 * @param {Capabilities} [capabilities] - Capabilities object (auto-detected if not provided)
 * @returns {WorkerConfig}
 */
export function getOptimalConfig(capabilities) {
  const caps = capabilities || detectCapabilities();
  const { cores, memory, tier, hasNativeDecompress } = caps;
  
  // Base configuration by tier
  let config;
  
  switch (tier) {
    case 'low':
      // Conservative: prioritize FPS stability over loading speed
      config = {
        workers: Math.max(2, Math.min(2, cores - 1)),
        batchSize: 1,
        yieldFrequency: 'every',
        maxMemoryMB: 256,
        useNativeDecompress: hasNativeDecompress,
        cacheNeighborData: false, // Save memory
      };
      break;
      
    case 'mid':
      // Balanced: good performance without overwhelming the system
      config = {
        workers: Math.max(2, Math.min(4, cores - 2)),
        batchSize: 2,
        yieldFrequency: 'batch',
        maxMemoryMB: 512,
        useNativeDecompress: hasNativeDecompress,
        cacheNeighborData: true,
      };
      break;
      
    case 'high':
      // Maximum throughput - use up to 12 workers for high-end systems
      // WASM model meshing offloads work from main thread, so more workers help
      config = {
        workers: Math.max(4, Math.min(12, cores - 2)),
        batchSize: 4,
        yieldFrequency: 'none',
        maxMemoryMB: 1024,
        useNativeDecompress: hasNativeDecompress,
        cacheNeighborData: true,
      };
      break;
      
    default:
      // Fallback to mid-tier
      config = {
        workers: 3,
        batchSize: 2,
        yieldFrequency: 'batch',
        maxMemoryMB: 512,
        useNativeDecompress: hasNativeDecompress,
        cacheNeighborData: true,
      };
  }
  
  // Adjust for low memory
  if (memory < 4) {
    config.workers = Math.min(config.workers, 2);
    config.maxMemoryMB = Math.min(config.maxMemoryMB, 256);
    config.cacheNeighborData = false;
  }
  
  // Ensure at least 1 worker
  config.workers = Math.max(1, config.workers);
  
  console.log('[CapabilityDetector] Optimal config:', config);
  
  return config;
}

/**
 * Check if the browser supports the full worker pipeline
 * 
 * @returns {boolean} True if worker pipeline is supported
 */
export function supportsWorkerPipeline() {
  const caps = detectCapabilities();
  return caps.hasWebWorkers && caps.supportsModuleWorkers;
}

/**
 * Get a human-readable description of detected capabilities
 * Useful for debugging and user-facing performance info
 * 
 * @returns {string}
 */
export function getCapabilityDescription() {
  const caps = detectCapabilities();
  const config = getOptimalConfig(caps);
  
  const tierNames = {
    low: 'Low-end',
    mid: 'Mid-range',
    high: 'High-end',
  };
  
  return `${tierNames[caps.tier]} device (${caps.cores} cores, ${caps.memory}GB RAM) - ` +
    `Using ${config.workers} workers, batch size ${config.batchSize}`;
}

/**
 * Force re-detection of capabilities
 * Useful for testing or if hardware changes (e.g., power mode)
 */
export function resetCapabilities() {
  cachedCapabilities = null;
}

/**
 * Check if we should use fallback mode (single-threaded)
 * Returns true if worker pipeline is NOT supported
 * 
 * @returns {boolean} True if fallback mode should be used
 */
export function shouldUseFallback() {
  const caps = detectCapabilities();
  // Use fallback if no web workers or no module worker support
  return !caps.hasWebWorkers || !caps.supportsModuleWorkers;
}

/**
 * Get recommended render settings based on capabilities
 * Useful for setting initial quality/performance tradeoffs
 * 
 * @returns {Object} Recommended settings
 */
export function getRecommendedSettings() {
  const caps = detectCapabilities();
  const config = getOptimalConfig(caps);
  
  return {
    // Super-chunk render distance (in super-chunks, 32 blocks each)
    renderDistance: caps.tier === 'low' ? 4 : caps.tier === 'mid' ? 6 : 8,
    // Whether to enable model meshes (non-cube blocks)
    enableModelMeshes: caps.tier !== 'low',
    // Whether to enable particle effects
    enableParticles: caps.memory >= 4,
    // Whether to enable smooth lighting
    enableSmoothLighting: true,
    // Worker configuration
    ...config,
  };
}

// ============================================================================
// Phase 5.1: WebGPU Detection
// ============================================================================

// Cached WebGPU capabilities
let cachedWebGPUCapabilities = null;

/**
 * Detect WebGPU capabilities (async because it requires adapter request)
 * 
 * @returns {Promise<Object>} WebGPU capabilities
 */
export async function detectWebGPU() {
  if (cachedWebGPUCapabilities !== null) {
    return cachedWebGPUCapabilities;
  }
  
  // Check if WebGPU is available
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    cachedWebGPUCapabilities = { 
      available: false, 
      reason: 'WebGPU not supported in this browser' 
    };
    return cachedWebGPUCapabilities;
  }
  
  try {
    // Request adapter (GPU)
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      cachedWebGPUCapabilities = { 
        available: false, 
        reason: 'No GPU adapter available' 
      };
      return cachedWebGPUCapabilities;
    }
    
    // Request device
    const device = await adapter.requestDevice();
    if (!device) {
      cachedWebGPUCapabilities = { 
        available: false, 
        reason: 'Failed to get GPU device' 
      };
      return cachedWebGPUCapabilities;
    }
    
    // Get device limits
    const limits = device.limits;
    
    cachedWebGPUCapabilities = {
      available: true,
      adapter: {
        name: adapter.name || 'Unknown GPU',
        features: [...adapter.features],
        isFallbackAdapter: adapter.isFallbackAdapter,
      },
      limits: {
        maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
        maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY,
        maxComputeWorkgroupSizeZ: limits.maxComputeWorkgroupSizeZ,
        maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
        maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
      },
    };
    
    console.log('[CapabilityDetector] WebGPU available:', cachedWebGPUCapabilities.adapter.name);
    
    // Clean up - device will be recreated when actually needed
    device.destroy();
    
    return cachedWebGPUCapabilities;
  } catch (error) {
    cachedWebGPUCapabilities = { 
      available: false, 
      reason: `WebGPU initialization failed: ${error.message}` 
    };
    return cachedWebGPUCapabilities;
  }
}

/**
 * Check if WebGPU compute shaders are supported for meshing
 * This is a quick sync check - use detectWebGPU() for full capabilities
 * 
 * @returns {boolean}
 */
export function hasWebGPUSupport() {
  const caps = detectCapabilities();
  return caps.hasWebGPU;
}

// ============================================================================
// Meshing Path Selection
// ============================================================================

/**
 * Available meshing paths in order of preference
 */
export const MeshingPath = {
  WEBGPU: 'webgpu',     // GPU compute shaders (fastest, requires WebGPU)
  WASM_PARALLEL: 'wasm-parallel', // WASM with Rayon threading (fast, requires SAB)
  WASM: 'wasm',         // Single-threaded WASM (good, widely supported)
  JS: 'js',             // Pure JavaScript fallback (slowest, always works)
};

/**
 * Cached meshing path selection
 */
let cachedMeshingPath = null;

/**
 * Determine the optimal meshing path based on capabilities
 * 
 * Selection priority:
 * 1. WebGPU compute shaders (if available and large enough storage)
 * 2. WASM with Rayon parallelism (if SharedArrayBuffer available)
 * 3. Single-threaded WASM (default fast path)
 * 4. Pure JavaScript (fallback)
 * 
 * @param {boolean} forceRedetect - Force re-detection (skip cache)
 * @returns {Promise<string>} One of MeshingPath values
 */
export async function selectMeshingPath(forceRedetect = false) {
  if (cachedMeshingPath && !forceRedetect) {
    return cachedMeshingPath;
  }
  
  const caps = detectCapabilities();
  
  // Check WebGPU first
  if (caps.hasWebGPU) {
    const webgpuCaps = await detectWebGPU();
    if (webgpuCaps.available) {
      // Ensure sufficient storage buffer size for chunk data
      const minStorageSize = 32 * 1024 * 1024; // 32MB minimum
      if (webgpuCaps.limits.maxStorageBufferBindingSize >= minStorageSize) {
        cachedMeshingPath = MeshingPath.WEBGPU;
        console.log('[CapabilityDetector] Selected WebGPU meshing path');
        return cachedMeshingPath;
      }
    }
  }
  
  // Check WASM availability (assume WASM is available if we got this far)
  const hasWasm = typeof WebAssembly !== 'undefined';
  
  if (hasWasm) {
    // Check for parallel WASM support (requires SharedArrayBuffer + atomics)
    if (caps.hasSharedArrayBuffer && typeof Atomics !== 'undefined') {
      // Check if cross-origin isolation is enabled (required for SAB)
      const isIsolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      
      if (isIsolated) {
        cachedMeshingPath = MeshingPath.WASM_PARALLEL;
        console.log('[CapabilityDetector] Selected WASM parallel meshing path');
        return cachedMeshingPath;
      }
    }
    
    // Single-threaded WASM
    cachedMeshingPath = MeshingPath.WASM;
    console.log('[CapabilityDetector] Selected WASM meshing path');
    return cachedMeshingPath;
  }
  
  // JavaScript fallback
  cachedMeshingPath = MeshingPath.JS;
  console.log('[CapabilityDetector] Selected JavaScript meshing path (fallback)');
  return cachedMeshingPath;
}

/**
 * Get the currently selected meshing path (sync, uses cached value)
 * Call selectMeshingPath() first to ensure detection has run
 * 
 * @returns {string|null} One of MeshingPath values, or null if not yet detected
 */
export function getCurrentMeshingPath() {
  return cachedMeshingPath;
}

/**
 * Force a specific meshing path (for testing or debugging)
 * @param {string} path - One of MeshingPath values
 */
export function setMeshingPath(path) {
  if (!Object.values(MeshingPath).includes(path)) {
    console.warn(`[CapabilityDetector] Invalid meshing path: ${path}`);
    return;
  }
  cachedMeshingPath = path;
  console.log(`[CapabilityDetector] Meshing path manually set to: ${path}`);
}

export default {
  detectCapabilities,
  getOptimalConfig,
  supportsWorkerPipeline,
  getCapabilityDescription,
  resetCapabilities,
  shouldUseFallback,
  getRecommendedSettings,
  detectWebGPU,
  hasWebGPUSupport,
  MeshingPath,
  selectMeshingPath,
  getCurrentMeshingPath,
  setMeshingPath,
};

