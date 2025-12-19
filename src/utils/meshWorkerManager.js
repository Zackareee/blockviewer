import * as THREE from 'three';

/**
 * Mesh Worker Manager
 * 
 * Manages a pool of web workers for parallel mesh building.
 * Handles communication, job queuing, and geometry creation from worker results.
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
    console.log(`MeshWorkerManager: Initialized ${this.poolSize} workers`);
  }

  /**
   * Handle message from worker
   */
  handleWorkerMessage(worker, e) {
    const { type, id, solid, water, stats, subchunkY, geometry } = e.data;

    if (type === 'meshResult') {
      const job = this.pendingJobs.get(id);
      if (job) {
        this.pendingJobs.delete(id);

        // Create THREE.js geometries from raw arrays
        const solidGeometry = solid ? this.createGeometry(solid) : null;
        const waterGeometry = water ? this.createGeometry(water) : null;

        job.resolve({ solidGeometry, waterGeometry, stats });
      }

      // Return worker to pool and process next job
      this.availableWorkers.push(worker);
      this.processQueue();
    }
    
    // Handle subchunk mesh results
    if (type === 'subchunkMeshResult' || type === 'waterSubchunkMeshResult') {
      const job = this.pendingJobs.get(id);
      if (job) {
        this.pendingJobs.delete(id);
        
        // Create THREE.js geometry from raw arrays
        const resultGeometry = geometry ? this.createGeometry(geometry) : null;
        
        job.resolve({ 
          geometry: resultGeometry, 
          subchunkY, 
          stats,
          isWater: type === 'waterSubchunkMeshResult'
        });
      }
      
      // Return worker to pool and process next job
      this.availableWorkers.push(worker);
      this.processQueue();
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
    while (this.jobQueue.length > 0 && this.availableWorkers.length > 0) {
      const job = this.jobQueue.shift();
      const worker = this.availableWorkers.pop();

      this.pendingJobs.set(job.id, job);

      worker.postMessage({
        type: job.messageType || 'buildMesh',
        id: job.id,
        data: job.data,
      });
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
   * @returns {Promise<{geometry, subchunkY, stats}>}
   */
  buildSubchunkMesh(solidBlocks, neighborBlocks, offset, subchunkY) {
    this.init();
    
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      
      this.jobQueue.push({
        id,
        messageType: 'buildSubchunkMesh',
        data: { solidBlocks, neighborBlocks, offset, subchunkY },
        resolve,
        reject,
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
   * @returns {Promise<{geometry, subchunkY, stats, isWater: true}>}
   */
  buildWaterSubchunkMesh(waterBlocks, neighborBlocks, offset, subchunkY) {
    this.init();
    
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      
      this.jobQueue.push({
        id,
        messageType: 'buildWaterSubchunkMesh',
        data: { waterBlocks, neighborBlocks, offset, subchunkY },
        resolve,
        reject,
      });
      
      this.processQueue();
    });
  }
  
  /**
   * Build multiple solid subchunk meshes with controlled concurrency
   * @param {Array} jobs - Array of {solidBlocks, neighborBlocks, offset, subchunkY}
   * @param {Function} onProgress - Optional callback (completed, total)
   * @returns {Promise<Array<{geometry, subchunkY, stats}>>}
   */
  async buildSubchunkMeshes(jobs, onProgress = null) {
    if (jobs.length === 0) return [];
    
    this.init();
    
    // Log job sizes to help debug memory issues
    let totalBlocks = 0;
    for (const job of jobs) {
      totalBlocks += job.solidBlocks.length + job.neighborBlocks.length;
    }
    console.log(`MeshWorkerManager: Building ${jobs.length} solid subchunks (${totalBlocks.toLocaleString()} total blocks)`);
    
    let completed = 0;
    const total = jobs.length;
    const results = [];
    
    // Process in batches to avoid memory exhaustion
    // Limit concurrent jobs to worker pool size
    const batchSize = this.poolSize;
    
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      
      const batchPromises = batch.map(job => {
        return this.buildSubchunkMesh(
          job.solidBlocks, 
          job.neighborBlocks, 
          job.offset, 
          job.subchunkY
        ).then(result => {
          completed++;
          onProgress?.(completed, total);
          return result;
        });
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
  }
  
  /**
   * Build multiple water subchunk meshes with controlled concurrency
   * @param {Array} jobs - Array of {waterBlocks, neighborBlocks, offset, subchunkY}
   * @param {Function} onProgress - Optional callback (completed, total)
   * @returns {Promise<Array<{geometry, subchunkY, stats, isWater: true}>>}
   */
  async buildWaterSubchunkMeshes(jobs, onProgress = null) {
    if (jobs.length === 0) return [];
    
    this.init();
    
    console.log(`MeshWorkerManager: Building ${jobs.length} water subchunks`);
    
    let completed = 0;
    const total = jobs.length;
    const results = [];
    
    // Process in batches to avoid memory exhaustion
    const batchSize = this.poolSize;
    
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      
      const batchPromises = batch.map(job => {
        return this.buildWaterSubchunkMesh(
          job.waterBlocks, 
          job.neighborBlocks, 
          job.offset, 
          job.subchunkY
        ).then(result => {
          completed++;
          onProgress?.(completed, total);
          return result;
        });
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
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
    };
  }

  /**
   * Terminate all workers
   */
  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.availableWorkers = [];
    this.jobQueue = [];
    this.pendingJobs.clear();
    this.initialized = false;
  }
}

// Singleton instance
export const meshWorkerManager = new MeshWorkerManager();

// Convenience function for simple usage
export async function buildMeshInWorker(blocks, offset, minY, maxY) {
  return meshWorkerManager.buildMesh(blocks, offset, minY, maxY);
}

