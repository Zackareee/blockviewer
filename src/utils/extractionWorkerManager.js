/**
 * Extraction Worker Manager - Pool of workers for parallel chunk extraction
 * 
 * Distributes chunk extraction across multiple workers for maximum parallelism.
 * Uses transferable typed arrays for zero-copy data transfer.
 */

class ExtractionWorkerManager {
  constructor(workerCount = navigator.hardwareConcurrency || 4) {
    this.workerCount = Math.min(workerCount, 8); // Cap at 8 workers
    this.workers = [];
    this.pendingTasks = new Map();
    this.taskQueue = [];
    this.workerBusy = [];
    this.nextTaskId = 0;
    this.isInitialized = false;
    
    // Global palette merged from all workers
    this.globalPalette = ['minecraft:air'];
    this.paletteMap = new Map([['minecraft:air', 0]]);
  }

  /**
   * Initialize worker pool
   */
  async init() {
    if (this.isInitialized) return;
    
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(
        new URL('../workers/extractionWorker.js', import.meta.url),
        { type: 'module' }
      );
      
      worker.onmessage = (e) => this.handleWorkerMessage(i, e);
      worker.onerror = (e) => console.error(`Extraction worker ${i} error:`, e);
      
      this.workers.push(worker);
      this.workerBusy.push(false);
    }
    
    this.isInitialized = true;
    console.log(`Extraction worker pool initialized with ${this.workerCount} workers`);
  }

  /**
   * Handle messages from workers
   */
  handleWorkerMessage(workerIndex, e) {
    const { type, id, result, results, palette, timeMs } = e.data;
    
    // Merge palette from worker
    if (palette) {
      this.mergePalette(palette);
    }
    
    const task = this.pendingTasks.get(id);
    if (!task) return;
    
    this.pendingTasks.delete(id);
    this.workerBusy[workerIndex] = false;
    
    if (type === 'extractionResult') {
      task.resolve({
        ...result,
        // Remap block types to global palette indices
        blockType: this.remapBlockTypes(result.blockType, palette)
      });
    } else if (type === 'batchResult') {
      // Remap all results
      const remappedResults = results.map(r => ({
        ...r,
        blockType: this.remapBlockTypes(r.blockType, palette)
      }));
      task.resolve({ results: remappedResults, timeMs });
    }
    
    // Process next task in queue
    this.processQueue();
  }

  /**
   * Merge a worker's palette into the global palette
   */
  mergePalette(workerPalette) {
    for (const name of workerPalette) {
      if (!this.paletteMap.has(name)) {
        const idx = this.globalPalette.length;
        this.globalPalette.push(name);
        this.paletteMap.set(name, idx);
      }
    }
  }

  /**
   * Remap block type indices from worker's local palette to global palette
   */
  remapBlockTypes(blockTypes, workerPalette) {
    // If palettes match, no remapping needed
    if (workerPalette.length === this.globalPalette.length) {
      let match = true;
      for (let i = 0; i < workerPalette.length; i++) {
        if (workerPalette[i] !== this.globalPalette[i]) {
          match = false;
          break;
        }
      }
      if (match) return blockTypes;
    }
    
    // Build remapping table
    const remap = new Uint16Array(workerPalette.length);
    for (let i = 0; i < workerPalette.length; i++) {
      remap[i] = this.paletteMap.get(workerPalette[i]) ?? 0;
    }
    
    // Apply remapping
    const remapped = new Uint16Array(blockTypes.length);
    for (let i = 0; i < blockTypes.length; i++) {
      remapped[i] = remap[blockTypes[i]];
    }
    
    return remapped;
  }

  /**
   * Get an available worker index, or -1 if all busy
   */
  getAvailableWorker() {
    for (let i = 0; i < this.workerCount; i++) {
      if (!this.workerBusy[i]) return i;
    }
    return -1;
  }

  /**
   * Process the task queue
   */
  processQueue() {
    while (this.taskQueue.length > 0) {
      const workerIdx = this.getAvailableWorker();
      if (workerIdx === -1) break;
      
      const task = this.taskQueue.shift();
      this.workerBusy[workerIdx] = true;
      this.workers[workerIdx].postMessage(task.message);
    }
  }

  /**
   * Extract blocks from a single chunk
   * @param {Object} chunkData - Raw chunk NBT data
   * @param {number} chunkOffsetX - X offset in blocks (chunkX * 16)
   * @param {number} chunkOffsetZ - Z offset in blocks (chunkZ * 16)
   * @returns {Promise<{x, y, z, blockType, count}>}
   */
  async extractChunk(chunkData, chunkOffsetX = 0, chunkOffsetZ = 0) {
    if (!this.isInitialized) await this.init();
    
    const taskId = this.nextTaskId++;
    
    return new Promise((resolve, reject) => {
      const task = {
        message: {
          type: 'extractChunk',
          id: taskId,
          data: { chunkData, chunkOffsetX, chunkOffsetZ }
        },
        resolve,
        reject
      };
      
      this.pendingTasks.set(taskId, task);
      
      const workerIdx = this.getAvailableWorker();
      if (workerIdx !== -1) {
        this.workerBusy[workerIdx] = true;
        this.workers[workerIdx].postMessage(task.message);
      } else {
        this.taskQueue.push(task);
      }
    });
  }

  /**
   * Extract blocks from multiple chunks in parallel
   * Distributes chunks across all available workers
   * @param {Array} chunkRefs - Array of {rawData, chunkX, chunkZ}
   * @param {Function} onProgress - Optional progress callback (completed, total)
   * @returns {Promise<{blocks: TypedBlockArray, totalTime: number}>}
   */
  async extractChunksParallel(chunkRefs, onProgress = null) {
    if (!this.isInitialized) await this.init();
    
    const totalChunks = chunkRefs.length;
    let completed = 0;
    
    // Collect all results
    const allX = [];
    const allY = [];
    const allZ = [];
    const allBlockType = [];
    const allLevel = [];
    let totalBlocks = 0;
    
    const startTime = performance.now();
    
    // Create batches for each worker
    const batchSize = Math.ceil(totalChunks / this.workerCount);
    const batches = [];
    
    for (let i = 0; i < totalChunks; i += batchSize) {
      const batchChunks = chunkRefs.slice(i, i + batchSize).map(ref => ({
        chunkData: ref.rawData,
        chunkX: ref.chunkX,
        chunkZ: ref.chunkZ,
        chunkOffsetX: ref.chunkX * 16,
        chunkOffsetZ: ref.chunkZ * 16
      }));
      batches.push(batchChunks);
    }
    
    // Process all batches in parallel
    const batchPromises = batches.map((batchChunks, batchIdx) => {
      const taskId = this.nextTaskId++;
      
      return new Promise((resolve, reject) => {
        const task = {
          message: {
            type: 'extractBatch',
            id: taskId,
            data: { chunks: batchChunks }
          },
          resolve: (result) => {
            completed += batchChunks.length;
            onProgress?.(completed, totalChunks);
            resolve(result);
          },
          reject
        };
        
        this.pendingTasks.set(taskId, task);
        
        // Wait for worker availability
        const tryAssign = () => {
          const workerIdx = this.getAvailableWorker();
          if (workerIdx !== -1) {
            this.workerBusy[workerIdx] = true;
            this.workers[workerIdx].postMessage(task.message);
          } else {
            this.taskQueue.push(task);
          }
        };
        
        tryAssign();
      });
    });
    
    // Wait for all batches
    const batchResults = await Promise.all(batchPromises);
    
    // Merge results
    for (const batch of batchResults) {
      for (const result of batch.results) {
        allX.push(result.x);
        allY.push(result.y);
        allZ.push(result.z);
        allBlockType.push(result.blockType);
        allLevel.push(result.level);
        totalBlocks += result.count;
      }
    }
    
    // Concatenate all typed arrays
    // Note: x and z use Int32Array to support world coordinates
    const mergedX = new Int32Array(totalBlocks);
    const mergedY = new Int16Array(totalBlocks);
    const mergedZ = new Int32Array(totalBlocks);
    const mergedBlockType = new Uint16Array(totalBlocks);
    const mergedLevel = new Int8Array(totalBlocks);
    
    let offset = 0;
    for (let i = 0; i < allX.length; i++) {
      mergedX.set(allX[i], offset);
      mergedY.set(allY[i], offset);
      mergedZ.set(allZ[i], offset);
      mergedBlockType.set(allBlockType[i], offset);
      mergedLevel.set(allLevel[i], offset);
      offset += allX[i].length;
    }
    
    const totalTime = performance.now() - startTime;
    
    return {
      blocks: {
        x: mergedX,
        y: mergedY,
        z: mergedZ,
        blockType: mergedBlockType,
        level: mergedLevel,
        count: totalBlocks
      },
      palette: this.globalPalette,
      totalTime
    };
  }

  /**
   * Get block name from global palette index
   */
  getBlockName(index) {
    return this.globalPalette[index] || 'minecraft:air';
  }

  /**
   * Get the full global palette
   */
  getPalette() {
    return this.globalPalette;
  }

  /**
   * Reset the global palette (call when loading new regions)
   */
  resetPalette() {
    this.globalPalette = ['minecraft:air'];
    this.paletteMap = new Map([['minecraft:air', 0]]);
  }

  /**
   * Terminate all workers
   */
  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.workerBusy = [];
    this.pendingTasks.clear();
    this.taskQueue = [];
    this.isInitialized = false;
  }
}

// Singleton instance
let instance = null;

export function getExtractionWorkerManager() {
  if (!instance) {
    instance = new ExtractionWorkerManager();
  }
  return instance;
}

export { ExtractionWorkerManager };

