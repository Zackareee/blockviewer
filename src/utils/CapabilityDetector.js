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
      // Maximum throughput
      config = {
        workers: Math.max(4, Math.min(8, cores - 2)),
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

export default {
  detectCapabilities,
  getOptimalConfig,
  supportsWorkerPipeline,
  getCapabilityDescription,
  resetCapabilities,
  shouldUseFallback,
  getRecommendedSettings,
};

