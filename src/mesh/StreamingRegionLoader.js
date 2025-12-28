/**
 * StreamingRegionLoader - Efficient region loading using unified worker pipeline
 * 
 * This loader is optimized for loading hundreds of regions efficiently by:
 * 1. Using a unified worker that handles parse → decode → mesh in one step
 * 2. Returning transferable ArrayBuffers to avoid memory copies
 * 3. Processing regions in parallel with controlled concurrency
 * 4. Supporting streaming/progressive loading for responsive UI
 * 
 * Target: 3 seconds per region for the full pipeline
 */

// Worker pool for parallel region processing
const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);
const GC_DELAY_MS = 50; // Brief pause between regions for GC

/**
 * StreamingRegionLoader class
 */
export class StreamingRegionLoader {
  constructor(options = {}) {
    this.maxWorkers = options.maxWorkers || MAX_WORKERS;
    this.gcDelay = options.gcDelay || GC_DELAY_MS;
    this.onProgress = options.onProgress || null;
    this.onRegionComplete = options.onRegionComplete || null;
    
    // Worker pool
    this.workers = [];
    this.workerBusy = [];
    this.pendingJobs = new Map();
    this.nextJobId = 0;
    
    this._initialized = false;
  }
  
  /**
   * Initialize worker pool
   */
  _initWorkers() {
    if (this._initialized) return;
    
    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new Worker(
        new URL('./workers/RegionWorker.js', import.meta.url),
        { type: 'module' }
      );
      
      worker.onmessage = (e) => this._handleWorkerMessage(i, e);
      worker.onerror = (e) => this._handleWorkerError(i, e);
      
      this.workers.push(worker);
      this.workerBusy.push(false);
    }
    
    this._initialized = true;
  }
  
  /**
   * Handle worker response
   */
  _handleWorkerMessage(workerIndex, e) {
    const { type, id, result, stats, bounds, error } = e.data;
    
    this.workerBusy[workerIndex] = false;
    
    const job = this.pendingJobs.get(id);
    if (!job) return;
    
    if (type === 'complete') {
      job.resolve({ result, stats, bounds });
    } else if (type === 'error') {
      job.reject(new Error(error));
    }
    
    this.pendingJobs.delete(id);
  }
  
  /**
   * Handle worker error
   */
  _handleWorkerError(workerIndex, e) {
    console.error(`[StreamingRegionLoader] Worker ${workerIndex} error:`, e);
    this.workerBusy[workerIndex] = false;
    
    // Reject all pending jobs for this worker
    for (const [id, job] of this.pendingJobs) {
      if (job.workerIndex === workerIndex) {
        job.reject(new Error('Worker error'));
        this.pendingJobs.delete(id);
      }
    }
  }
  
  /**
   * Get an available worker index
   */
  _getAvailableWorker() {
    return this.workerBusy.indexOf(false);
  }
  
  /**
   * Process a single region file
   * @param {File|ArrayBuffer} regionData - Region file or buffer
   * @param {number} regionX - Region X coordinate
   * @param {number} regionZ - Region Z coordinate
   * @param {Object} options - { generateLOD }
   * @returns {Promise<{result, stats, bounds}>}
   */
  async processRegion(regionData, regionX, regionZ, options = {}) {
    this._initWorkers();
    
    const { generateLOD = false } = options;
    
    // Get buffer
    let buffer;
    if (regionData instanceof ArrayBuffer) {
      buffer = regionData;
    } else if (regionData.arrayBuffer) {
      buffer = await regionData.arrayBuffer();
    } else {
      throw new Error('Invalid region data');
    }
    
    // Wait for available worker
    let workerIndex = this._getAvailableWorker();
    while (workerIndex === -1) {
      await new Promise(r => setTimeout(r, 10));
      workerIndex = this._getAvailableWorker();
    }
    
    // Create job
    const id = this.nextJobId++;
    
    return new Promise((resolve, reject) => {
      this.pendingJobs.set(id, { resolve, reject, workerIndex });
      this.workerBusy[workerIndex] = true;
      
      // Transfer buffer to worker
      this.workers[workerIndex].postMessage({
        type: 'processRegion',
        id,
        buffer,
        regionX,
        regionZ,
        generateLOD,
      }, [buffer]);
    });
  }
  
  /**
   * Process multiple regions with streaming/progressive loading
   * @param {Array<{file, regionX, regionZ}>} regions - Region files
   * @param {Object} options - { onRegionStart, onRegionComplete }
   * @returns {Promise<{results, stats}>}
   */
  async processRegions(regions, options = {}) {
    this._initWorkers();
    
    const { onRegionStart, onRegionComplete } = options;
    const results = [];
    let completedCount = 0;
    let totalBlocks = 0;
    let totalChunks = 0;
    
    const startTime = performance.now();
    
    // Process regions with controlled concurrency
    const pending = [];
    
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      
      onRegionStart?.(i, regions.length, region.file.name);
      this.onProgress?.(i, regions.length, 'processing');
      
      const promise = (async () => {
        try {
          const result = await this.processRegion(
            region.file,
            region.regionX,
            region.regionZ
          );
          
          completedCount++;
          totalBlocks += result.stats?.totalBlocks || 0;
          totalChunks += result.stats?.chunksProcessed || 0;
          
          onRegionComplete?.(i, regions.length, region.file.name, result.stats);
          this.onRegionComplete?.(result);
          
          return { ...result, regionX: region.regionX, regionZ: region.regionZ };
        } catch (error) {
          console.warn(`[StreamingRegionLoader] Failed to process ${region.file.name}:`, error.message);
          completedCount++;
          return null;
        }
      })();
      
      pending.push(promise);
      
      // Control concurrency
      if (pending.length >= this.maxWorkers) {
        const completed = await Promise.race(pending);
        if (completed) results.push(completed);
        
        // Remove completed from pending
        const idx = pending.findIndex(p => p === completed);
        if (idx !== -1) pending.splice(idx, 1);
        
        // GC pause
        await new Promise(r => setTimeout(r, this.gcDelay));
      }
    }
    
    // Wait for remaining
    const remaining = await Promise.all(pending);
    for (const r of remaining) {
      if (r) results.push(r);
    }
    
    const totalTime = performance.now() - startTime;
    
    return {
      results: results.filter(r => r !== null),
      stats: {
        regionsProcessed: completedCount,
        totalBlocks,
        totalChunks,
        totalTimeMs: totalTime,
        avgTimePerRegion: totalTime / completedCount,
      },
    };
  }
  
  /**
   * Dispose all workers
   */
  dispose() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.workerBusy = [];
    this.pendingJobs.clear();
    this._initialized = false;
  }
}

/**
 * Create a streaming region loader
 */
export function createStreamingLoader(options = {}) {
  return new StreamingRegionLoader(options);
}

export default StreamingRegionLoader;

