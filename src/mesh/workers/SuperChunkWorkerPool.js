/**
 * SuperChunkWorkerPool - Adaptive Worker Pool for Super-Chunk Processing
 * 
 * Manages a pool of SuperChunkWorker instances with:
 * - Adaptive worker count based on hardware capabilities
 * - Priority queue for distance-based job ordering
 * - Job cancellation for out-of-range chunks
 * - Memory pressure monitoring
 * 
 * Usage:
 *   const pool = new SuperChunkWorkerPool();
 *   await pool.initialize(blockRegistryData, stateRegistryData);
 *   const result = await pool.process(chunkData, neighbors, priority);
 */

import { detectCapabilities, getOptimalConfig } from '../../utils/CapabilityDetector.js';

/**
 * Priority queue for mesh jobs - sorted by priority (lower = higher priority)
 */
class JobPriorityQueue {
  constructor() {
    this.jobs = [];
  }
  
  add(job) {
    // Insert in sorted order by priority
    let inserted = false;
    for (let i = 0; i < this.jobs.length; i++) {
      if (job.priority < this.jobs[i].priority) {
        this.jobs.splice(i, 0, job);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.jobs.push(job);
    }
  }
  
  pop() {
    return this.jobs.shift();
  }
  
  remove(jobId) {
    const index = this.jobs.findIndex(j => j.jobId === jobId);
    if (index !== -1) {
      this.jobs.splice(index, 1);
      return true;
    }
    return false;
  }
  
  clear() {
    this.jobs = [];
  }
  
  get length() {
    return this.jobs.length;
  }
  
  isEmpty() {
    return this.jobs.length === 0;
  }
  
  // Get all jobs for a super-chunk key
  getJobsForKey(key) {
    return this.jobs.filter(j => j.superChunkKey === key);
  }
  
  // Remove all jobs for a super-chunk key
  removeJobsForKey(key) {
    this.jobs = this.jobs.filter(j => j.superChunkKey !== key);
  }
}

/**
 * SuperChunkWorkerPool
 */
export class SuperChunkWorkerPool {
  constructor(options = {}) {
    // Detect capabilities and get optimal config
    this.capabilities = detectCapabilities();
    this.config = getOptimalConfig(this.capabilities);
    
    // Allow overrides
    // Each worker loads its own WASM heap. 8–12 workers OOM browser tabs quickly.
    const requested = options.workerCount ?? this.config.workers;
    this.workerCount = Math.max(1, Math.min(requested, 4));
    this.batchSize = options.batchSize ?? this.config.batchSize;
    
    // Worker pool state
    this.workers = [];
    this.workerBusy = [];
    this.workerReady = [];
    
    // Job tracking
    this.jobQueue = new JobPriorityQueue();
    this.pendingJobs = new Map(); // jobId -> { resolve, reject, job, startTime }
    this.nextJobId = 0;
    
    // Initialization state
    this.initialized = false;
    this.initPromise = null;
    this.initData = null;
    
    // Statistics
    this.stats = {
      jobsCompleted: 0,
      jobsCancelled: 0,
      totalProcessTime: 0,
      averageProcessTime: 0,
    };
    
    // Callbacks
    this.onJobComplete = options.onJobComplete || null;
    this.onJobError = options.onJobError || null;
    
    console.log(`[SuperChunkWorkerPool] Configured with ${this.workerCount} workers (${this.capabilities.tier} tier)`);
  }
  
  /**
   * Initialize the worker pool with registry data
   * 
   * @param {Object} blockRegistryData - Block registry export data
   * @param {Object} stateRegistryData - State registry export data (from exportForWorker)
   * @param {Object} wasmLookups - WASM lookup tables for meshing
   * @param {Object} modelGeometryData - Serialized model geometry for WASM model meshing (V2)
   * @param {ArrayBuffer} bakedModelsData - Raw baked-models.bin data for V3 registry
   * @param {Object} manifestData - block-model-manifest.json for V3 lookup
   * @param {Uint16Array} textureRemapping - Remapping from baked texture indices to atlas indices
   * @param {ArrayBuffer} bakedBlockEntitiesData - Raw baked-block-entities.bin data for entity meshing
   */
  async initialize(blockRegistryData, stateRegistryData, wasmLookups = null, modelGeometryData = null, bakedModelsData = null, manifestData = null, textureRemapping = null, bakedBlockEntitiesData = null) {
    if (this.initPromise) {
      return this.initPromise;
    }
    
    this.initPromise = this._doInitialize(blockRegistryData, stateRegistryData, wasmLookups, modelGeometryData, bakedModelsData, manifestData, textureRemapping, bakedBlockEntitiesData);
    return this.initPromise;
  }
  
  async _doInitialize(blockRegistryData, stateRegistryData, wasmLookups, modelGeometryData, bakedModelsData, manifestData, textureRemapping, bakedBlockEntitiesData) {
    console.log(`[SuperChunkWorkerPool] Initializing ${this.workerCount} workers...`);
    
    // Store init data for late-joined workers
    this.initData = {
      blockRegistry: blockRegistryData,
      stateRegistry: stateRegistryData?.data || stateRegistryData,
      wasmLookups: wasmLookups,
      modelGeometry: modelGeometryData,
      bakedModels: bakedModelsData,               // V3: Raw binary for block model registry
      manifest: manifestData,                      // V3: Block model manifest for lookup
      textureRemapping: textureRemapping,          // V3: Texture index remapping
      bakedBlockEntities: bakedBlockEntitiesData,  // Block entity models for entity meshing
    };
    
    // Create workers
    const initPromises = [];
    for (let i = 0; i < this.workerCount; i++) {
      initPromises.push(this._createWorker(i));
    }
    
    await Promise.all(initPromises);
    this.initialized = true;
    console.log(`[SuperChunkWorkerPool] All ${this.workerCount} workers ready`);
  }
  
  async _createWorker(index) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL('./SuperChunkWorker.js', import.meta.url),
        { type: 'module' }
      );
      
      // Set up message handler
      worker.onmessage = (e) => this._handleWorkerMessage(index, e);
      worker.onerror = (e) => this._handleWorkerError(index, e);
      
      this.workers[index] = worker;
      this.workerBusy[index] = false;
      this.workerReady[index] = false;
      
      // Wait for ready signal after init
      const initHandler = (e) => {
        if (e.data.type === 'ready') {
          this.workerReady[index] = true;
          worker.removeEventListener('message', initHandler);
          resolve();
        } else if (e.data.type === 'error') {
          reject(new Error(e.data.error));
        }
      };
      
      worker.addEventListener('message', initHandler);
      
      // Send init message
      const initMessage = {
        type: 'init',
        id: `init-${index}`,
        data: this.initData,
      };
      
      worker.postMessage(initMessage);
    });
  }
  
  _handleWorkerMessage(workerIndex, e) {
    const { type, id, result, stats, error } = e.data;
    
    switch (type) {
      case 'complete': {
        const pending = this.pendingJobs.get(id);
        
        if (pending) {
          const elapsed = performance.now() - pending.startTime;
          this.stats.jobsCompleted++;
          this.stats.totalProcessTime += elapsed;
          this.stats.averageProcessTime = this.stats.totalProcessTime / this.stats.jobsCompleted;
          
          pending.resolve({ result, stats });
          this.pendingJobs.delete(id);
          
          if (this.onJobComplete) {
            this.onJobComplete(id, result, stats, elapsed);
          }
        }
        
        // Mark worker as available and process next job
        this.workerBusy[workerIndex] = false;
        this._processNextJob();
        break;
      }
      
      case 'error': {
        const pending = this.pendingJobs.get(id);
        
        if (pending) {
          pending.reject(new Error(error));
          this.pendingJobs.delete(id);
          
          if (this.onJobError) {
            this.onJobError(id, error);
          }
        }
        
        // Mark worker as available
        this.workerBusy[workerIndex] = false;
        this._processNextJob();
        break;
      }
      
      case 'registryUpdated': {
        // Registry update acknowledged
        break;
      }
    }
  }
  
  _handleWorkerError(workerIndex, e) {
    console.error(`[SuperChunkWorkerPool] Worker ${workerIndex} error:`, e.message);
    
    // Mark worker as not ready
    this.workerReady[workerIndex] = false;
    this.workerBusy[workerIndex] = false;
    
    // Attempt to recreate the worker
    this._createWorker(workerIndex).catch(err => {
      console.error(`[SuperChunkWorkerPool] Failed to recreate worker ${workerIndex}:`, err);
    });
  }
  
  /**
   * Process a super-chunk
   * 
   * @param {Object} options - Processing options
   * @param {Array} options.chunks - Array of chunk data with compressedData, compressionType, chunkX, chunkZ
   * @param {Array} options.neighbors - Optional neighbor chunk data for boundaries
   * @param {Object} options.bounds - Super-chunk bounds { minChunkX, minChunkZ, maxChunkX, maxChunkZ }
   * @param {number} options.priority - Job priority (lower = higher priority)
   * @param {string} options.superChunkKey - Unique key for this super-chunk
   * @returns {Promise<Object>} - Mesh data
   */
  async process(options) {
    if (!this.initialized) {
      throw new Error('SuperChunkWorkerPool not initialized');
    }
    
    const { chunks, neighbors, bounds, priority = 0, superChunkKey } = options;
    const jobId = this.nextJobId++;
    
    return new Promise((resolve, reject) => {
      const job = {
        jobId,
        superChunkKey,
        data: { chunks, neighbors, bounds },
        priority,
      };
      
      this.pendingJobs.set(jobId, {
        resolve,
        reject,
        job,
        startTime: performance.now(),
      });
      
      this.jobQueue.add(job);
      this._processNextJob();
    });
  }
  
  /**
   * Process the next job in the queue
   * Now dispatches to ALL available workers for maximum parallelism
   */
  _processNextJob() {
    // Dispatch to all available workers at once
    this._dispatchPendingJobs();
  }

  /**
   * Dispatch pending jobs to all available workers
   * This maximizes worker utilization
   */
  _dispatchPendingJobs() {
    while (!this.jobQueue.isEmpty()) {
      const workerIndex = this._getAvailableWorker();
      if (workerIndex === -1) break; // No workers available
      
      const job = this.jobQueue.pop();
      if (!job) break;
      
      // Check if job was cancelled
      if (!this.pendingJobs.has(job.jobId)) {
        continue; // Skip cancelled jobs
      }
      
      this._dispatchJobToWorker(workerIndex, job);
    }
  }

  /**
   * Dispatch a single job to a specific worker
   */
  _dispatchJobToWorker(workerIndex, job) {
    // Mark worker as busy
    this.workerBusy[workerIndex] = true;
    
    // Prepare message
    const message = {
      type: 'process',
      id: job.jobId,
      data: job.data,
    };
    
    // Collect transferables - transfer directly without cloning when possible
    const transferables = [];
    
    for (const chunk of job.data.chunks) {
      if (chunk.compressedData instanceof ArrayBuffer) {
        transferables.push(chunk.compressedData);
      } else if (chunk.compressedData?.buffer instanceof ArrayBuffer) {
        // Transfer the underlying buffer directly
        transferables.push(chunk.compressedData.buffer);
        chunk.compressedData = chunk.compressedData.buffer;
      }
    }
    
    if (job.data.neighbors) {
      for (const neighbor of job.data.neighbors) {
        if (neighbor.compressedData instanceof ArrayBuffer) {
          transferables.push(neighbor.compressedData);
        } else if (neighbor.compressedData?.buffer instanceof ArrayBuffer) {
          transferables.push(neighbor.compressedData.buffer);
          neighbor.compressedData = neighbor.compressedData.buffer;
        }
      }
    }
    
    // Send to worker
    this.workers[workerIndex].postMessage(message, transferables);
  }
  
  /**
   * Find an available worker
   */
  _getAvailableWorker() {
    for (let i = 0; i < this.workerCount; i++) {
      if (this.workerReady[i] && !this.workerBusy[i]) {
        return i;
      }
    }
    return -1;
  }
  
  /**
   * Cancel a pending job
   */
  cancelJob(jobId) {
    // Remove from queue if not yet started
    if (this.jobQueue.remove(jobId)) {
      const pending = this.pendingJobs.get(jobId);
      if (pending) {
        pending.reject(new Error('Job cancelled'));
        this.pendingJobs.delete(jobId);
      }
      this.stats.jobsCancelled++;
      return true;
    }
    return false;
  }
  
  /**
   * Cancel all jobs for a super-chunk
   */
  cancelJobsForSuperChunk(superChunkKey) {
    const jobs = this.jobQueue.getJobsForKey(superChunkKey);
    for (const job of jobs) {
      const pending = this.pendingJobs.get(job.jobId);
      if (pending) {
        pending.reject(new Error('Job cancelled'));
        this.pendingJobs.delete(job.jobId);
      }
      this.stats.jobsCancelled++;
    }
    this.jobQueue.removeJobsForKey(superChunkKey);
  }
  
  /**
   * Cancel all pending jobs
   */
  cancelAllJobs() {
    while (!this.jobQueue.isEmpty()) {
      const job = this.jobQueue.pop();
      const pending = this.pendingJobs.get(job.jobId);
      if (pending) {
        pending.reject(new Error('Job cancelled'));
        this.pendingJobs.delete(job.jobId);
      }
      this.stats.jobsCancelled++;
    }
  }
  
  /**
   * Update registry data in all workers
   */
  updateRegistry(blockRegistryData, stateRegistryData) {
    const message = {
      type: 'updateRegistry',
      id: `update-${Date.now()}`,
      data: {
        blockRegistry: blockRegistryData,
        stateRegistry: stateRegistryData?.data || stateRegistryData,
      },
    };
    
    for (const worker of this.workers) {
      if (worker) {
        worker.postMessage(message);
      }
    }
    
    // Update stored init data
    this.initData = {
      blockRegistry: blockRegistryData,
      stateRegistry: stateRegistryData?.data || stateRegistryData,
    };
  }
  
  /**
   * Get the number of active (busy) workers
   */
  getActiveWorkerCount() {
    return this.workerBusy.filter(busy => busy).length;
  }
  
  /**
   * Get the number of pending jobs
   */
  getPendingJobCount() {
    return this.jobQueue.length + this.getActiveWorkerCount();
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      workerCount: this.workerCount,
      activeWorkers: this.getActiveWorkerCount(),
      pendingJobs: this.getPendingJobCount(),
      queuedJobs: this.jobQueue.length,
      capabilities: this.capabilities,
      config: this.config,
    };
  }
  
  /**
   * Reduce worker count (for memory pressure)
   */
  reduceWorkers(count = 1) {
    const toRemove = Math.min(count, this.workerCount - 1); // Keep at least 1
    
    for (let i = 0; i < toRemove; i++) {
      const idx = this.workerCount - 1 - i;
      if (this.workers[idx] && !this.workerBusy[idx]) {
        this.workers[idx].terminate();
        this.workers.splice(idx, 1);
        this.workerBusy.splice(idx, 1);
        this.workerReady.splice(idx, 1);
        this.workerCount--;
      }
    }
    
    console.log(`[SuperChunkWorkerPool] Reduced to ${this.workerCount} workers`);
  }
  
  /**
   * Terminate all workers
   */
  terminate() {
    // Cancel all pending jobs
    this.cancelAllJobs();
    
    // Terminate workers
    for (const worker of this.workers) {
      if (worker) {
        worker.terminate();
      }
    }
    
    this.workers = [];
    this.workerBusy = [];
    this.workerReady = [];
    this.initialized = false;
    this.initPromise = null;
    
    console.log('[SuperChunkWorkerPool] Terminated all workers');
  }
  
  /**
   * Wait for all pending jobs to complete
   */
  async flush() {
    const promises = [];
    for (const [, pending] of this.pendingJobs) {
      promises.push(
        new Promise((resolve) => {
          const originalResolve = pending.resolve;
          pending.resolve = (data) => {
            originalResolve(data);
            resolve();
          };
        })
      );
    }
    
    await Promise.all(promises);
  }
}

// Singleton instance
let poolInstance = null;

/**
 * Get or create the global SuperChunkWorkerPool instance
 */
export function getSuperChunkWorkerPool() {
  if (!poolInstance) {
    poolInstance = new SuperChunkWorkerPool();
  }
  return poolInstance;
}

/**
 * Reset the global pool instance
 */
export function resetSuperChunkWorkerPool() {
  if (poolInstance) {
    poolInstance.terminate();
    poolInstance = null;
  }
}

export default SuperChunkWorkerPool;

