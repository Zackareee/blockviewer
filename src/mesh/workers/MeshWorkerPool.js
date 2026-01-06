/**
 * MeshWorkerPool - Manages a pool of MeshWorker instances for parallel chunk meshing
 * 
 * Features:
 * - Automatic worker pool sizing based on hardware concurrency
 * - Priority-based job scheduling (nearest chunks first)
 * - Transferable ArrayBuffer support for zero-copy data transfer
 * - Job cancellation for outdated mesh requests
 * 
 * Usage:
 *   const pool = new MeshWorkerPool();
 *   await pool.initialize(registryData, textureIndices, atlasInfo);
 *   const meshes = await pool.meshChunk(gridData, lightGridData, offset, options);
 */

// Default number of workers (fallback if navigator.hardwareConcurrency unavailable)
const DEFAULT_WORKER_COUNT = 4;

// Maximum workers to use (even on high-core systems)
const MAX_WORKERS = 8;

/**
 * Priority queue for mesh jobs - sorts by distance (nearest first)
 */
class JobPriorityQueue {
  constructor() {
    this.jobs = [];
  }

  add(job) {
    // Insert in sorted order by priority (lower priority value = higher priority)
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
}

/**
 * MeshWorkerPool class
 */
export class MeshWorkerPool {
  constructor(options = {}) {
    // Worker configuration
    const hardwareConcurrency = typeof navigator !== 'undefined'
      ? navigator.hardwareConcurrency || DEFAULT_WORKER_COUNT
      : DEFAULT_WORKER_COUNT;
    
    this.workerCount = Math.min(
      options.workerCount || Math.max(2, Math.floor(hardwareConcurrency * 0.75)),
      MAX_WORKERS
    );

    // Worker pool state
    this.workers = [];
    this.workerBusy = [];
    this.workerReady = [];

    // Job tracking
    this.jobQueue = new JobPriorityQueue();
    this.pendingJobs = new Map(); // jobId -> { resolve, reject, job }
    this.nextJobId = 0;

    // Initialization state
    this.initialized = false;
    this.initPromise = null;
    this.initData = null;

    // Statistics
    this.stats = {
      jobsCompleted: 0,
      jobsCancelled: 0,
      totalMeshTime: 0,
      averageMeshTime: 0,
    };

    // Callbacks
    this.onJobComplete = options.onJobComplete || null;
    this.onJobError = options.onJobError || null;
  }

  /**
   * Initialize the worker pool with registry and texture data
   * 
   * @param {Object} registryData - Exported BlockRegistry data
   * @param {Float32Array} textureIndices - Texture index lookup array
   * @param {Object} atlasInfo - Atlas dimensions { tilesPerRow, tilesPerCol }
   * @param {Object} additionalData - Additional data (faceTintTypeLookup, etc.)
   */
  async initialize(registryData, textureIndices, atlasInfo, additionalData = {}) {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInitialize(registryData, textureIndices, atlasInfo, additionalData);
    return this.initPromise;
  }

  async _doInitialize(registryData, textureIndices, atlasInfo, additionalData) {
    console.log(`[MeshWorkerPool] Initializing ${this.workerCount} workers...`);

    // Store init data for late-joined workers
    this.initData = {
      registryData,
      textureIndices: textureIndices ? textureIndices.buffer.slice(0) : null,
      atlasInfo,
      ...additionalData,
    };

    // Create workers
    const initPromises = [];
    for (let i = 0; i < this.workerCount; i++) {
      initPromises.push(this._createWorker(i));
    }

    await Promise.all(initPromises);
    this.initialized = true;
    console.log(`[MeshWorkerPool] All ${this.workerCount} workers ready`);
  }

  async _createWorker(index) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL('./MeshWorker.js', import.meta.url),
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

      // Create a fresh copy of init data for this worker
      // IMPORTANT: We must NOT mutate this.initData since multiple workers share it
      const workerData = {
        ...this.initData,
        // Clone texture indices buffer for this worker (will be transferred)
        textureIndices: this.initData.textureIndices 
          ? this.initData.textureIndices.slice(0) 
          : null,
      };

      const initMessage = {
        type: 'init',
        data: workerData,
      };

      // Transfer the cloned texture indices buffer
      const transferables = [];
      if (workerData.textureIndices) {
        transferables.push(workerData.textureIndices);
      }

      worker.postMessage(initMessage, transferables);
    });
  }

  _handleWorkerMessage(workerIndex, e) {
    const { type, data } = e.data;

    switch (type) {
      case 'result': {
        const { jobId, meshes } = data;
        const pending = this.pendingJobs.get(jobId);
        
        if (pending) {
          // Calculate timing
          const elapsed = performance.now() - pending.startTime;
          this.stats.jobsCompleted++;
          this.stats.totalMeshTime += elapsed;
          this.stats.averageMeshTime = this.stats.totalMeshTime / this.stats.jobsCompleted;

          pending.resolve(meshes);
          this.pendingJobs.delete(jobId);

          if (this.onJobComplete) {
            this.onJobComplete(jobId, meshes, elapsed);
          }
        }

        // Mark worker as available and process next job
        this.workerBusy[workerIndex] = false;
        this._processNextJob();
        break;
      }

      case 'error': {
        const { jobId, error } = e.data;
        const pending = this.pendingJobs.get(jobId);
        
        if (pending) {
          pending.reject(new Error(error));
          this.pendingJobs.delete(jobId);

          if (this.onJobError) {
            this.onJobError(jobId, error);
          }
        }

        // Mark worker as available
        this.workerBusy[workerIndex] = false;
        this._processNextJob();
        break;
      }
    }
  }

  _handleWorkerError(workerIndex, e) {
    console.error(`[MeshWorkerPool] Worker ${workerIndex} error:`, e.message);
    
    // Mark worker as not ready (it crashed)
    this.workerReady[workerIndex] = false;
    this.workerBusy[workerIndex] = false;

    // Attempt to recreate the worker
    this._createWorker(workerIndex).catch(err => {
      console.error(`[MeshWorkerPool] Failed to recreate worker ${workerIndex}:`, err);
    });
  }

  /**
   * Queue a chunk meshing job
   * 
   * @param {Object} gridData - Exported BinaryGrid data
   * @param {Object} lightGridData - Exported LightGrid data (optional)
   * @param {Object} offset - World offset { x, y, z }
   * @param {Object} options - Meshing options
   * @param {number} priority - Job priority (lower = higher priority)
   * @returns {Promise<Object>} - Mesh data
   */
  async meshChunk(gridData, lightGridData, offset, options = {}, priority = 0) {
    if (!this.initialized) {
      throw new Error('MeshWorkerPool not initialized');
    }

    const jobId = this.nextJobId++;

    return new Promise((resolve, reject) => {
      const job = {
        jobId,
        gridData,
        lightGridData,
        offset,
        options,
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
   * Process the next job in the queue using an available worker
   */
  _processNextJob() {
    if (this.jobQueue.isEmpty()) return;

    // Find an available worker
    const workerIndex = this._getAvailableWorker();
    if (workerIndex === -1) return;

    // Get the next job
    const job = this.jobQueue.pop();
    if (!job) return;

    // Mark worker as busy
    this.workerBusy[workerIndex] = true;

    // Prepare message
    const message = {
      type: 'mesh',
      data: {
        jobId: job.jobId,
        gridData: job.gridData,
        lightGridData: job.lightGridData,
        offset: job.offset,
        options: job.options,
      },
    };

    // Collect transferables from grid data
    const transferables = [];
    if (job.gridData && job.gridData.sections) {
      for (const section of job.gridData.sections) {
        if (section.data instanceof ArrayBuffer) {
          transferables.push(section.data);
        }
      }
    }
    if (job.lightGridData && job.lightGridData.sections) {
      for (const section of job.lightGridData.sections) {
        if (section.data instanceof ArrayBuffer) {
          transferables.push(section.data);
        }
      }
    }

    // Send to worker
    this.workers[workerIndex].postMessage(message, transferables);
  }

  /**
   * Find an available worker
   * @returns {number} Worker index or -1 if none available
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
   * @param {number} jobId - Job ID to cancel
   * @returns {boolean} True if job was cancelled
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
   * Cancel all pending jobs
   */
  cancelAllJobs() {
    // Clear the queue
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
   * Get the number of active (busy) workers
   */
  getActiveWorkerCount() {
    return this.workerBusy.filter(busy => busy).length;
  }

  /**
   * Get the number of pending jobs
   */
  getPendingJobCount() {
    return this.jobQueue.length + this.pendingJobs.size;
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
    };
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

    console.log('[MeshWorkerPool] Terminated all workers');
  }

  /**
   * Wait for all pending jobs to complete
   */
  async flush() {
    const pendingPromises = Array.from(this.pendingJobs.values()).map(p => 
      p.resolve.catch ? Promise.resolve() : new Promise((resolve) => {
        const originalResolve = p.resolve;
        p.resolve = (data) => {
          originalResolve(data);
          resolve();
        };
      })
    );
    
    await Promise.all(pendingPromises);
  }
}

// Singleton instance
let poolInstance = null;

/**
 * Get or create the global MeshWorkerPool instance
 */
export function getMeshWorkerPool() {
  if (!poolInstance) {
    poolInstance = new MeshWorkerPool();
  }
  return poolInstance;
}

/**
 * Reset the global pool instance
 */
export function resetMeshWorkerPool() {
  if (poolInstance) {
    poolInstance.terminate();
    poolInstance = null;
  }
}

export default MeshWorkerPool;

