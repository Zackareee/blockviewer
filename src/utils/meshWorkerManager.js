import * as THREE from 'three';

/**
 * Mesh Worker Manager
 * 
 * Manages a pool of web workers for parallel mesh building.
 * Handles communication, job queuing, and geometry creation from worker results.
 * 
 * OPTIMIZED: Now supports direct typed array processing to avoid object conversion overhead.
 */

class MeshWorkerManager {
  constructor(poolSize = navigator.hardwareConcurrency || 4) {
    this.poolSize = Math.min(poolSize, 8); // Cap at 8 workers
    this.workers = [];
    this.availableWorkers = [];
    this.jobQueue = [];
    this.pendingJobs = new Map();
    this.nextJobId = 0;
    this.initialized = false;
    
    // Optimized worker pool (separate for typed array processing)
    this.optimizedWorkers = [];
    this.availableOptimizedWorkers = [];
    this.optimizedJobQueue = [];
    this.optimizedInitialized = false;
  }

  /**
   * Initialize the worker pool
   */
  init() {
    if (this.initialized) return;

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(
        new URL('../workers/meshWorker.js', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (e) => this.handleWorkerMessage(worker, e);
      worker.onerror = (e) => this.handleWorkerError(worker, e);

      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }

    this.initialized = true;
  }

  /**
   * Initialize optimized worker pool for typed array processing
   */
  initOptimized() {
    if (this.optimizedInitialized) return;

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(
        new URL('../workers/meshWorkerOptimized.js', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (e) => this.handleOptimizedWorkerMessage(worker, e);
      worker.onerror = (e) => this.handleOptimizedWorkerError(worker, e);

      this.optimizedWorkers.push(worker);
      this.availableOptimizedWorkers.push(worker);
    }

    this.optimizedInitialized = true;
  }

  /**
   * Handle message from optimized worker
   */
  handleOptimizedWorkerMessage(worker, e) {
    const { type, id, results, stats } = e.data;

    // Return worker to pool
    this.availableOptimizedWorkers.push(worker);
    this.processOptimizedQueue();

    if (type === 'typedBatchResult') {
      const job = this.pendingJobs.get(id);
      if (job) {
        this.pendingJobs.delete(id);
        // Create geometries for results
        const processedResults = results.map(r => ({
          geometry: r.geometry ? this.createGeometry(r.geometry) : null,
          subchunkY: r.subchunkY,
          subchunkKey: r.subchunkKey,
          stats: {
            blockCount: r.blockCount,
            triangleCount: r.triangleCount,
            error: r.error,
          }
        }));
        job.resolve({ results: processedResults, stats });
      }
    }

    // Also handle legacy batch results for compatibility
    if (type === 'subchunkMeshBatchResult') {
      const job = this.pendingJobs.get(id);
      if (job) {
        this.pendingJobs.delete(id);
        const processedResults = results.map(r => ({
          geometry: r.geometry ? this.createGeometry(r.geometry) : null,
          subchunkY: r.subchunkY,
          subchunkKey: r.subchunkKey,
          stats: {
            blockCount: r.blockCount,
            triangleCount: r.triangleCount,
            error: r.error,
          }
        }));
        job.resolve(processedResults);
      }
    }
  }

  /**
   * Handle optimized worker error
   */
  handleOptimizedWorkerError(worker, error) {
    console.error('Optimized mesh worker error:', error);
    if (!this.availableOptimizedWorkers.includes(worker)) {
      this.availableOptimizedWorkers.push(worker);
    }
    this.processOptimizedQueue();
  }

  /**
   * Process optimized job queue
   */
  processOptimizedQueue() {
    while (this.optimizedJobQueue && this.optimizedJobQueue.length > 0 && this.availableOptimizedWorkers.length > 0) {
      const job = this.optimizedJobQueue.shift();
      const worker = this.availableOptimizedWorkers.pop();

      this.pendingJobs.set(job.id, job);

      worker.postMessage(job.message, job.transferables || []);
    }
  }

  /**
   * Handle message from worker - defers geometry creation to prevent blocking
   */
  handleWorkerMessage(worker, e) {
    const { type, id, solid, water, stats, subchunkY, geometry, results, meshType } = e.data;

    // Return worker to pool immediately so more jobs can be dispatched
    this.availableWorkers.push(worker);
    this.processQueue();

    if (type === 'meshResult') {
      const job = this.pendingJobs.get(id);
      if (job) {
        this.pendingJobs.delete(id);
        // Create geometry synchronously to reduce latency (was setTimeout)
        const solidGeometry = solid ? this.createGeometry(solid) : null;
        const waterGeometry = water ? this.createGeometry(water) : null;
        job.resolve({ solidGeometry, waterGeometry, stats });
      }
    }
    
    // Handle subchunk mesh results
    if (type === 'subchunkMeshResult' || type === 'waterSubchunkMeshResult' || type === 'lavaSubchunkMeshResult') {
      const job = this.pendingJobs.get(id);
      if (job) {
        this.pendingJobs.delete(id);
        // Create geometry synchronously to reduce latency
        const resultGeometry = geometry ? this.createGeometry(geometry) : null;
        job.resolve({ 
          geometry: resultGeometry, 
          subchunkY, 
          stats,
          isWater: type === 'waterSubchunkMeshResult',
          isLava: type === 'lavaSubchunkMeshResult'
        });
      }
    }
    
    // Handle BATCH results - multiple subchunks per message
    if (type === 'subchunkMeshBatchResult') {
      const job = this.pendingJobs.get(id);
      if (job) {
        this.pendingJobs.delete(id);
        // Create geometries for all results
        const processedResults = results.map(r => ({
          geometry: r.geometry ? this.createGeometry(r.geometry) : null,
          subchunkY: r.subchunkY,
          subchunkKey: r.subchunkKey,
          stats: {
            blockCount: r.blockCount,
            triangleCount: r.triangleCount,
            error: r.error,
          }
        }));
        job.resolve(processedResults);
      }
    }
  }

  /**
   * Handle worker error
   */
  handleWorkerError(worker, error) {
    console.error('Mesh worker error:', error);

    // Find and reject pending job for this worker
    for (const [id, job] of this.pendingJobs) {
      // We can't easily track which worker has which job, so we'd need more tracking
      // For now, just log the error
    }

    // Return worker to pool
    if (!this.availableWorkers.includes(worker)) {
      this.availableWorkers.push(worker);
    }
    this.processQueue();
  }

  /**
   * Create THREE.js geometry from raw arrays
   */
  createGeometry(result) {
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    
    geometry.setAttribute('color', new THREE.BufferAttribute(result.colors, 3));
    
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeBoundingSphere();

    return geometry;
  }

  /**
   * Queue a mesh building job
   * Returns a Promise that resolves with { solidGeometry, waterGeometry, stats }
   */
  buildMesh(blocks, offset = { x: 0, y: 0, z: 0 }, minY = -64, maxY = 320) {
    this.init();

    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;

      this.jobQueue.push({
        id,
        data: { blocks, offset, minY, maxY },
        resolve,
        reject,
      });

      this.processQueue();
    });
  }

  /**
   * Process queued jobs if workers available
   */
  processQueue() {
    let dispatched = 0;
    while (this.jobQueue.length > 0 && this.availableWorkers.length > 0) {
      const job = this.jobQueue.shift();
      const worker = this.availableWorkers.pop();

      this.pendingJobs.set(job.id, job);

      worker.postMessage({
        type: job.messageType || 'buildMesh',
        id: job.id,
        data: job.data,
      });
      dispatched++;
    }
  }

  /**
   * Build multiple meshes in parallel
   * Returns Promise that resolves when all are complete
   */
  async buildMeshes(jobs) {
    const promises = jobs.map(job => 
      this.buildMesh(job.blocks, job.offset, job.minY, job.maxY)
    );
    return Promise.all(promises);
  }
  
  /**
   * Build a single solid subchunk mesh
   * @param {Array} solidBlocks - Solid blocks in the subchunk
   * @param {Array} neighborBlocks - Boundary blocks for culling
   * @param {Object} offset - World offset {x, y, z}
   * @param {number} subchunkY - Subchunk Y index (for identification)
   * @param {string} subchunkKey - Subchunk key "chunkX,chunkZ,subchunkY"
   * @returns {Promise<{geometry, subchunkY, subchunkKey, stats}>}
   */
  buildSubchunkMesh(solidBlocks, neighborBlocks, offset, subchunkY, subchunkKey = null) {
    this.init();
    
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      
      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        console.error(`Solid mesh timeout for subchunk ${subchunkKey || subchunkY}`);
        this.pendingJobs.delete(id);
        resolve({ geometry: null, subchunkY, subchunkKey, stats: { error: 'timeout' } });
      }, 30000);
      
      this.jobQueue.push({
        id,
        messageType: 'buildSubchunkMesh',
        data: { solidBlocks, neighborBlocks, offset, subchunkY },
        subchunkKey, // Store for result
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve({ ...result, subchunkKey });
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
      
      this.processQueue();
    });
  }
  
  /**
   * Build a single water subchunk mesh
   * @param {Array} waterBlocks - Water blocks in the subchunk
   * @param {Array} neighborBlocks - Boundary blocks for culling (solid + water)
   * @param {Object} offset - World offset {x, y, z}
   * @param {number} subchunkY - Subchunk Y index (for identification)
   * @param {string} subchunkKey - Subchunk key
   * @returns {Promise<{geometry, subchunkY, subchunkKey, stats, isWater: true}>}
   */
  buildWaterSubchunkMesh(waterBlocks, neighborBlocks, offset, subchunkY, subchunkKey = null) {
    this.init();
    
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      
      const timeoutId = setTimeout(() => {
        console.error(`Water mesh timeout for subchunk ${subchunkKey || subchunkY}`);
        this.pendingJobs.delete(id);
        resolve({ geometry: null, subchunkY, subchunkKey, stats: { error: 'timeout' }, isWater: true });
      }, 30000);
      
      this.jobQueue.push({
        id,
        messageType: 'buildWaterSubchunkMesh',
        data: { waterBlocks, neighborBlocks, offset, subchunkY },
        subchunkKey,
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve({ ...result, subchunkKey });
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
      
      this.processQueue();
    });
  }
  
  /**
   * Build a single lava subchunk mesh
   * @param {Array} lavaBlocks - Lava blocks in the subchunk
   * @param {Array} neighborBlocks - Boundary blocks for culling (solid + lava)
   * @param {Object} offset - World offset {x, y, z}
   * @param {number} subchunkY - Subchunk Y index (for identification)
   * @param {string} subchunkKey - Subchunk key
   * @returns {Promise<{geometry, subchunkY, subchunkKey, stats, isLava: true}>}
   */
  buildLavaSubchunkMesh(lavaBlocks, neighborBlocks, offset, subchunkY, subchunkKey = null) {
    this.init();
    
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      
      const timeoutId = setTimeout(() => {
        console.error(`Lava mesh timeout for subchunk ${subchunkKey || subchunkY}`);
        this.pendingJobs.delete(id);
        resolve({ geometry: null, subchunkY, subchunkKey, stats: { error: 'timeout' }, isLava: true });
      }, 30000);
      
      this.jobQueue.push({
        id,
        messageType: 'buildLavaSubchunkMesh',
        data: { lavaBlocks, neighborBlocks, offset, subchunkY },
        subchunkKey,
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve({ ...result, subchunkKey });
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
      
      this.processQueue();
    });
  }
  
  /**
   * Build multiple solid subchunk meshes using BATCH processing
   * Sends multiple subchunks per worker message to reduce overhead
   * @param {Array} jobs - Array of {solidBlocks, neighborBlocks, offset, subchunkY, subchunkKey}
   * @param {Function} onProgress - Optional callback (completed, total)
   * @returns {Promise<Array<{geometry, subchunkY, subchunkKey, stats}>>}
   */
  async buildSubchunkMeshes(jobs, onProgress = null) {
    if (jobs.length === 0) return [];
    
    this.init();
    
    // Use batch processing - send multiple subchunks per worker message
    // This dramatically reduces communication overhead
    const JOBS_PER_BATCH = Math.max(50, Math.ceil(jobs.length / (this.poolSize * 4)));
    const batches = [];
    
    for (let i = 0; i < jobs.length; i += JOBS_PER_BATCH) {
      batches.push(jobs.slice(i, i + JOBS_PER_BATCH));
    }
    
    let completedJobs = 0;
    const total = jobs.length;
    const allResults = [];
    
    // Process batches in parallel across workers
    const batchPromises = batches.map(batch => {
      return this.buildSubchunkMeshBatch(batch, 'solid').then(results => {
        completedJobs += batch.length;
        onProgress?.(completedJobs, total);
        return results;
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    for (const results of batchResults) {
      allResults.push(...results);
    }
    
    return allResults;
  }
  
  /**
   * Build a batch of subchunk meshes in a single worker message
   * @param {Array} jobs - Array of {solidBlocks/waterBlocks/lavaBlocks, neighborBlocks, offset, subchunkY, subchunkKey}
   * @param {string} meshType - 'solid' | 'water' | 'lava'
   * @returns {Promise<Array<{geometry, subchunkY, subchunkKey}>>}
   */
  buildSubchunkMeshBatch(jobs, meshType) {
    this.init();
    
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      
      // Prepare jobs for worker - rename blocks field based on type
      const workerJobs = jobs.map(job => ({
        blocks: job.solidBlocks || job.waterBlocks || job.lavaBlocks,
        neighborBlocks: job.neighborBlocks,
        offset: job.offset,
        subchunkY: job.subchunkY,
        subchunkKey: job.subchunkKey,
      }));
      
      const timeoutId = setTimeout(() => {
        console.error(`Batch mesh timeout for ${jobs.length} jobs`);
        this.pendingJobs.delete(id);
        resolve(jobs.map(j => ({ 
          geometry: null, 
          subchunkY: j.subchunkY, 
          subchunkKey: j.subchunkKey,
          stats: { error: 'timeout' } 
        })));
      }, 60000); // 60s timeout for batches
      
      this.jobQueue.push({
        id,
        messageType: 'buildSubchunkMeshBatch',
        data: { jobs: workerJobs, meshType },
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
      
      this.processQueue();
    });
  }
  
  /**
   * Build multiple water subchunk meshes using BATCH processing
   * @param {Array} jobs - Array of {waterBlocks, neighborBlocks, offset, subchunkY, subchunkKey}
   * @param {Function} onProgress - Optional callback (completed, total)
   * @returns {Promise<Array<{geometry, subchunkY, subchunkKey, stats, isWater: true}>>}
   */
  async buildWaterSubchunkMeshes(jobs, onProgress = null) {
    if (jobs.length === 0) return [];
    
    this.init();
    
    const JOBS_PER_BATCH = Math.max(50, Math.ceil(jobs.length / (this.poolSize * 4)));
    const batches = [];
    
    for (let i = 0; i < jobs.length; i += JOBS_PER_BATCH) {
      batches.push(jobs.slice(i, i + JOBS_PER_BATCH));
    }
    
    let completedJobs = 0;
    const total = jobs.length;
    const allResults = [];
    
    const batchPromises = batches.map(batch => {
      return this.buildSubchunkMeshBatch(batch, 'water').then(results => {
        completedJobs += batch.length;
        onProgress?.(completedJobs, total);
        return results.map(r => ({ ...r, isWater: true }));
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    for (const results of batchResults) {
      allResults.push(...results);
    }
    
    return allResults;
  }
  
  /**
   * Build multiple lava subchunk meshes using BATCH processing
   * @param {Array} jobs - Array of {lavaBlocks, neighborBlocks, offset, subchunkY, subchunkKey}
   * @param {Function} onProgress - Optional callback (completed, total)
   * @returns {Promise<Array<{geometry, subchunkY, subchunkKey, stats, isLava: true}>>}
   */
  async buildLavaSubchunkMeshes(jobs, onProgress = null) {
    if (jobs.length === 0) return [];
    
    this.init();
    
    const JOBS_PER_BATCH = Math.max(50, Math.ceil(jobs.length / (this.poolSize * 4)));
    const batches = [];
    
    for (let i = 0; i < jobs.length; i += JOBS_PER_BATCH) {
      batches.push(jobs.slice(i, i + JOBS_PER_BATCH));
    }
    
    let completedJobs = 0;
    const total = jobs.length;
    const allResults = [];
    
    const batchPromises = batches.map(batch => {
      return this.buildSubchunkMeshBatch(batch, 'lava').then(results => {
        completedJobs += batch.length;
        onProgress?.(completedJobs, total);
        return results.map(r => ({ ...r, isLava: true }));
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    for (const results of batchResults) {
      allResults.push(...results);
    }
    
    return allResults;
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      poolSize: this.poolSize,
      available: this.availableWorkers.length,
      pending: this.pendingJobs.size,
      queued: this.jobQueue.length,
      optimizedAvailable: this.availableOptimizedWorkers.length,
      optimizedQueued: this.optimizedJobQueue.length,
    };
  }

  // ============================================================
  // HIGH-PERFORMANCE TYPED ARRAY API
  // ============================================================

  /**
   * Build all meshes using indexed typed arrays (no object conversion)
   * This is the fastest path for mesh building.
   * 
   * @param {Object} typedArrays - { x, y, z, blockType, level, count, palette }
   * @param {Array} solidJobs - Array of { targetIndices, neighborIndices, offset, subchunkY, meshType: 'solid' }
   * @param {Array} waterJobs - Array of { targetIndices, neighborIndices, offset, subchunkY, meshType: 'water' }
   * @param {Array} lavaJobs - Array of { targetIndices, neighborIndices, offset, subchunkY, meshType: 'lava' }
   * @param {Function} onProgress - Optional (completed, total) callback
   * @returns {Promise<{ solidResults, waterResults, lavaResults, stats }>}
   */
  async buildMeshesTyped(typedArrays, solidJobs, waterJobs, lavaJobs, onProgress = null) {
    this.initOptimized();
    
    const allJobs = [...solidJobs, ...waterJobs, ...lavaJobs];
    if (allJobs.length === 0) {
      return { solidResults: [], waterResults: [], lavaResults: [], stats: { timeMs: 0 } };
    }
    
    const startTime = performance.now();
    
    // Split jobs across workers, with each worker getting a batch
    // Larger batches = less IPC overhead
    const JOBS_PER_BATCH = Math.max(20, Math.ceil(allJobs.length / (this.poolSize * 2)));
    const batches = [];
    
    for (let i = 0; i < allJobs.length; i += JOBS_PER_BATCH) {
      batches.push(allJobs.slice(i, i + JOBS_PER_BATCH));
    }
    
    let completedJobs = 0;
    const totalJobs = allJobs.length;
    
    // Process all batches in parallel
    const batchPromises = batches.map(batch => {
      return this._buildTypedBatch(typedArrays, batch).then(result => {
        completedJobs += batch.length;
        onProgress?.(completedJobs, totalJobs);
        return result;
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    
    // Collect all results
    const solidResults = [];
    const waterResults = [];
    const lavaResults = [];
    
    for (const { results } of batchResults) {
      for (const r of results) {
        const meshType = r.meshType || 'solid';
        
        if (meshType === 'solid') solidResults.push(r);
        else if (meshType === 'water') waterResults.push({ ...r, isWater: true });
        else if (meshType === 'lava') lavaResults.push({ ...r, isLava: true });
      }
    }
    
    const elapsed = performance.now() - startTime;
    
    return {
      solidResults,
      waterResults,
      lavaResults,
      stats: {
        timeMs: elapsed,
        totalJobs: allJobs.length,
        batches: batches.length,
      }
    };
  }

  /**
   * Build a single batch of meshes using typed arrays
   * OPTIMIZED: Extract only the needed blocks per job, don't copy entire arrays
   * @private
   */
  _buildTypedBatch(typedArrays, jobs) {
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      
      const { x, y, z, blockType, palette } = typedArrays;
      
      // For each job, extract only the blocks it needs (not the entire 35M array!)
      const workerJobs = [];
      const transferables = [];
      
      for (const job of jobs) {
        const targetIndices = job.targetIndices;
        const neighborIndices = job.neighborIndices;
        const totalCount = targetIndices.length + neighborIndices.length;
        
        // Create compact arrays for just this subchunk's blocks
        const jobX = new Int32Array(totalCount);
        const jobY = new Int16Array(totalCount);
        const jobZ = new Int32Array(totalCount);
        const jobType = new Uint16Array(totalCount);
        
        // Copy target blocks
        for (let i = 0; i < targetIndices.length; i++) {
          const idx = targetIndices[i];
          jobX[i] = x[idx];
          jobY[i] = y[idx];
          jobZ[i] = z[idx];
          jobType[i] = blockType[idx];
        }
        
        // Copy neighbor blocks
        const offset = targetIndices.length;
        for (let i = 0; i < neighborIndices.length; i++) {
          const idx = neighborIndices[i];
          jobX[offset + i] = x[idx];
          jobY[offset + i] = y[idx];
          jobZ[offset + i] = z[idx];
          jobType[offset + i] = blockType[idx];
        }
        
        workerJobs.push({
          x: jobX,
          y: jobY,
          z: jobZ,
          blockType: jobType,
          targetCount: targetIndices.length,
          neighborCount: neighborIndices.length,
          offset: job.offset,
          subchunkY: job.subchunkY,
          subchunkKey: job.subchunkKey,
          meshType: job.meshType,
        });
        
        transferables.push(jobX.buffer, jobY.buffer, jobZ.buffer, jobType.buffer);
      }
      
      const message = {
        type: 'buildCompactBatch',
        id,
        data: {
          jobs: workerJobs,
          palette,
        }
      };
      
      const timeoutId = setTimeout(() => {
        console.error(`Typed batch timeout for ${jobs.length} jobs`);
        this.pendingJobs.delete(id);
        resolve({ 
          results: jobs.map(j => ({ 
            geometry: null, 
            subchunkY: j.subchunkY, 
            subchunkKey: j.subchunkKey,
            stats: { error: 'timeout' } 
          })),
          stats: { error: 'timeout' }
        });
      }, 60000);
      
      this.optimizedJobQueue.push({
        id,
        message,
        transferables,
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
      
      this.processOptimizedQueue();
    });
  }

  /**
   * Terminate all workers
   */
  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    for (const worker of this.optimizedWorkers) {
      worker.terminate();
    }
    this.workers = [];
    this.availableWorkers = [];
    this.optimizedWorkers = [];
    this.availableOptimizedWorkers = [];
    this.jobQueue = [];
    this.optimizedJobQueue = [];
    this.pendingJobs.clear();
    this.initialized = false;
    this.optimizedInitialized = false;
  }
}

// Singleton instance
export const meshWorkerManager = new MeshWorkerManager();

// Convenience function for simple usage
export async function buildMeshInWorker(blocks, offset, minY, maxY) {
  return meshWorkerManager.buildMesh(blocks, offset, minY, maxY);
}

