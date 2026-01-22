/**
 * PerformanceMetrics - Tracks rendering and loading performance
 * 
 * Provides:
 * - FPS tracking (rolling average)
 * - Frame time histogram
 * - Memory usage monitoring
 * - Mesh/triangle counts
 * - Draw call estimates
 */

export class PerformanceMetrics {
  constructor(options = {}) {
    // Rolling window for FPS calculation
    this.frameTimes = [];
    this.maxFrames = options.maxFrames || 60;
    
    // Frame time histogram (buckets in ms)
    this.histogram = {
      '<8ms': 0,   // 120+ FPS
      '8-16ms': 0, // 60-120 FPS
      '16-33ms': 0, // 30-60 FPS
      '>33ms': 0,  // <30 FPS (problematic)
    };
    
    // Stats
    this.totalFrames = 0;
    this.lastFrameTime = performance.now();
    this.startTime = performance.now();
    
    // Mesh tracking
    this.meshCount = 0;
    this.triangleCount = 0;
    
    // Memory tracking (Chrome only)
    this.memorySupported = typeof performance !== 'undefined' && 
                           'memory' in performance;
  }
  
  /**
   * Record a frame render
   * Call this at the end of each frame
   */
  recordFrame() {
    const now = performance.now();
    const delta = now - this.lastFrameTime;
    this.lastFrameTime = now;
    
    // Add to rolling window
    this.frameTimes.push(delta);
    if (this.frameTimes.length > this.maxFrames) {
      this.frameTimes.shift();
    }
    
    // Update histogram
    if (delta < 8) {
      this.histogram['<8ms']++;
    } else if (delta < 16) {
      this.histogram['8-16ms']++;
    } else if (delta < 33) {
      this.histogram['16-33ms']++;
    } else {
      this.histogram['>33ms']++;
    }
    
    this.totalFrames++;
  }
  
  /**
   * Update mesh counts from ChunkManager
   * @param {Object} stats - { meshCount, triangleCount }
   */
  updateMeshStats(stats) {
    this.meshCount = stats.meshCount || 0;
    this.triangleCount = stats.triangleCount || 0;
  }
  
  /**
   * Get current FPS (rolling average)
   */
  getFPS() {
    if (this.frameTimes.length === 0) return 0;
    const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
  }
  
  /**
   * Get average frame time in ms
   */
  getAverageFrameTime() {
    if (this.frameTimes.length === 0) return 0;
    return this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
  }
  
  /**
   * Get memory usage in MB (Chrome only)
   */
  getMemoryUsage() {
    if (!this.memorySupported) return null;
    
    const memory = performance.memory;
    return {
      usedHeap: Math.round(memory.usedJSHeapSize / (1024 * 1024)),
      totalHeap: Math.round(memory.totalJSHeapSize / (1024 * 1024)),
      heapLimit: Math.round(memory.jsHeapSizeLimit / (1024 * 1024)),
    };
  }
  
  /**
   * Get percentage of frames that dropped below 30fps
   */
  getDroppedFramePercent() {
    if (this.totalFrames === 0) return 0;
    return (this.histogram['>33ms'] / this.totalFrames) * 100;
  }
  
  /**
   * Get comprehensive performance report
   */
  getReport() {
    const uptime = (performance.now() - this.startTime) / 1000;
    
    return {
      fps: Math.round(this.getFPS() * 10) / 10,
      avgFrameTime: Math.round(this.getAverageFrameTime() * 100) / 100,
      totalFrames: this.totalFrames,
      droppedFramePercent: Math.round(this.getDroppedFramePercent() * 10) / 10,
      histogram: { ...this.histogram },
      meshCount: this.meshCount,
      triangleCount: this.triangleCount,
      memory: this.getMemoryUsage(),
      uptimeSeconds: Math.round(uptime),
    };
  }
  
  /**
   * Log performance summary to console
   */
  logSummary() {
    const report = this.getReport();
    console.log('[PerformanceMetrics] Summary:');
    console.log(`  FPS: ${report.fps} (avg frame time: ${report.avgFrameTime}ms)`);
    console.log(`  Total frames: ${report.totalFrames}, dropped: ${report.droppedFramePercent}%`);
    console.log(`  Meshes: ${report.meshCount}, triangles: ${report.triangleCount.toLocaleString()}`);
    if (report.memory) {
      console.log(`  Memory: ${report.memory.usedHeap}MB / ${report.memory.totalHeap}MB`);
    }
    console.log(`  Histogram:`, report.histogram);
  }
  
  /**
   * Reset all metrics
   */
  reset() {
    this.frameTimes = [];
    this.histogram = {
      '<8ms': 0,
      '8-16ms': 0,
      '16-33ms': 0,
      '>33ms': 0,
    };
    this.totalFrames = 0;
    this.lastFrameTime = performance.now();
    this.startTime = performance.now();
  }
}

// Singleton instance for global access
let globalMetrics = null;

export function getPerformanceMetrics() {
  if (!globalMetrics) {
    globalMetrics = new PerformanceMetrics();
  }
  return globalMetrics;
}

export function resetPerformanceMetrics() {
  if (globalMetrics) {
    globalMetrics.reset();
  }
}

export default PerformanceMetrics;
