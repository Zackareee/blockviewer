/**
 * ChunkLoadLogger - Tracks chunk loading events with detailed timing
 * 
 * Usage:
 *   import { chunkLoadLogger } from './utils/ChunkLoadLogger.js';
 *   
 *   // Enable logging
 *   chunkLoadLogger.enable();
 *   
 *   // After loading
 *   chunkLoadLogger.printSummary();
 *   chunkLoadLogger.getStats();
 */

export class ChunkLoadLogger {
  constructor() {
    this.enabled = false;
    this.events = [];
    this.chunkTimes = new Map(); // chunkKey -> { startTime, events[] }
    this.sessionStart = 0;
    this.listeners = [];
    
    // Process timing
    this.processTiming = {
      decompress: [],
      nbtParse: [],
      decode: [],
      meshing: [],
      meshCreation: [],
      total: [],
    };
    
    // Expose to window for console access
    if (typeof window !== 'undefined') {
      window.__chunkLogger = this;
    }
  }
  
  /**
   * Enable chunk load logging
   */
  enable() {
    this.enabled = true;
    this.sessionStart = performance.now();
    this.events = [];
    this.chunkTimes.clear();
    this.processTiming = {
      decompress: [],
      nbtParse: [],
      decode: [],
      meshing: [],
      meshCreation: [],
      total: [],
    };
    console.log('[ChunkLoadLogger] Logging enabled');
  }
  
  /**
   * Disable logging
   */
  disable() {
    this.enabled = false;
    console.log('[ChunkLoadLogger] Logging disabled');
  }
  
  /**
   * Clear all logged data
   */
  clear() {
    this.events = [];
    this.chunkTimes.clear();
    Object.keys(this.processTiming).forEach(k => {
      this.processTiming[k] = [];
    });
    this.sessionStart = performance.now();
  }
  
  /**
   * Log a chunk event
   * @param {string} type - Event type: 'queued', 'loadStart', 'decompressed', 'parsed', 'decoded', 'meshed', 'loadEnd'
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {object} data - Additional data
   */
  log(type, chunkX, chunkZ, data = {}) {
    if (!this.enabled) return;
    
    const now = performance.now();
    const elapsed = now - this.sessionStart;
    const key = `${chunkX},${chunkZ}`;
    
    const event = {
      type,
      chunkX,
      chunkZ,
      timestamp: now,
      elapsed,
      ...data,
    };
    
    this.events.push(event);
    
    // Track per-chunk timing
    if (!this.chunkTimes.has(key)) {
      this.chunkTimes.set(key, { startTime: now, events: [] });
    }
    this.chunkTimes.get(key).events.push(event);
    
    // Emit to listeners
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[ChunkLoadLogger] Listener error:', e);
      }
    }
    
    // Console output based on log level
    if (type === 'loadStart') {
      console.log(`[Chunk] ⏳ Loading (${chunkX}, ${chunkZ}) at ${elapsed.toFixed(0)}ms`);
    } else if (type === 'loadEnd') {
      const chunkData = this.chunkTimes.get(key);
      const loadTime = now - chunkData.startTime;
      console.log(`[Chunk] ✅ Loaded (${chunkX}, ${chunkZ}) in ${loadTime.toFixed(0)}ms`);
      
      // Track total time
      this.processTiming.total.push(loadTime);
    } else if (type === 'error') {
      console.error(`[Chunk] ❌ Error (${chunkX}, ${chunkZ}):`, data.error);
    }
    
    return event;
  }
  
  /**
   * Log process timing (decompress, parse, mesh, etc.)
   * @param {string} process - Process name
   * @param {number} durationMs
   * @param {number} chunkX
   * @param {number} chunkZ
   */
  logProcess(process, durationMs, chunkX, chunkZ) {
    if (!this.enabled) return;
    
    if (this.processTiming[process]) {
      this.processTiming[process].push(durationMs);
    }
    
    // Log only if significant (> 10ms)
    if (durationMs > 10) {
      console.log(`[Chunk] ${process} (${chunkX}, ${chunkZ}): ${durationMs.toFixed(1)}ms`);
    }
  }
  
  /**
   * Add event listener
   * @param {function} callback - Called with each event
   * @returns {function} Unsubscribe function
   */
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const totalChunks = this.chunkTimes.size;
    const totalTime = performance.now() - this.sessionStart;
    
    const calcStats = (arr) => {
      if (arr.length === 0) return { count: 0, avg: 0, min: 0, max: 0, p95: 0 };
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        count: arr.length,
        avg: arr.reduce((a, b) => a + b, 0) / arr.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p95: sorted[Math.floor(sorted.length * 0.95)],
      };
    };
    
    return {
      totalChunks,
      totalTimeMs: totalTime,
      chunksPerSecond: totalChunks / (totalTime / 1000),
      processTiming: {
        decompress: calcStats(this.processTiming.decompress),
        nbtParse: calcStats(this.processTiming.nbtParse),
        decode: calcStats(this.processTiming.decode),
        meshing: calcStats(this.processTiming.meshing),
        meshCreation: calcStats(this.processTiming.meshCreation),
        total: calcStats(this.processTiming.total),
      },
      events: this.events.length,
    };
  }
  
  /**
   * Print summary to console
   */
  printSummary() {
    const stats = this.getStats();
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  CHUNK LOADING SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    console.log(`  Total Chunks Loaded: ${stats.totalChunks}`);
    console.log(`  Total Time: ${(stats.totalTimeMs / 1000).toFixed(2)}s`);
    console.log(`  Chunks/Second: ${stats.chunksPerSecond.toFixed(2)}`);
    console.log();
    
    console.log('  PROCESS TIMING BREAKDOWN:');
    const formatStat = (name, stat) => {
      if (stat.count === 0) return `    ${name}: (no data)`;
      return `    ${name}: avg ${stat.avg.toFixed(1)}ms | min ${stat.min.toFixed(1)}ms | max ${stat.max.toFixed(1)}ms | p95 ${stat.p95.toFixed(1)}ms (${stat.count} samples)`;
    };
    
    Object.entries(stats.processTiming).forEach(([name, stat]) => {
      console.log(formatStat(name, stat));
    });
    
    console.log('\n═══════════════════════════════════════════════════════════════\n');
    
    return stats;
  }
  
  /**
   * Export events as JSON
   */
  exportJSON() {
    return JSON.stringify({
      sessionStart: this.sessionStart,
      stats: this.getStats(),
      events: this.events,
    }, null, 2);
  }
}

// Singleton instance
export const chunkLoadLogger = new ChunkLoadLogger();

