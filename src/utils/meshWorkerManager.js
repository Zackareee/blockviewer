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
    const { type, id, solid, water, stats } = e.data;

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
        type: 'buildMesh',
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

