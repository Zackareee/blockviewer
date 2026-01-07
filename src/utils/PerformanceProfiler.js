/**
 * PerformanceProfiler - In-browser performance monitoring for navigation benchmarks
 * 
 * Usage (in browser console after loading a region):
 * 
 *   // Start profiling (will run for 30 seconds or until stopped)
 *   window.__profiler.start(30000);
 * 
 *   // Move around during profiling...
 * 
 *   // Stop and see results
 *   window.__profiler.stop();
 * 
 *   // Or run a specific benchmark path
 *   window.__profiler.runBenchmark();
 */

export class PerformanceProfiler {
  constructor() {
    this.frameTimes = [];
    this.frameTimestamps = [];
    this.isRunning = false;
    this.startTime = 0;
    this.duration = 0;
    this.animationFrameId = null;
    this.lastFrameTime = 0;
    
    // Expose to window for console access
    if (typeof window !== 'undefined') {
      window.__profiler = this;
      console.log('[PerformanceProfiler] Available commands:');
      console.log('  window.__profiler.start(30000)  - Start profiling for 30 seconds');
      console.log('  window.__profiler.stop()        - Stop and show results');
      console.log('  window.__profiler.printReport() - Print last results');
    }
  }
  
  /**
   * Start profiling
   * @param {number} durationMs - How long to profile (0 = until stop() is called)
   */
  start(durationMs = 0) {
    if (this.isRunning) {
      console.log('[Profiler] Already running');
      return;
    }
    
    this.frameTimes = [];
    this.frameTimestamps = [];
    this.isRunning = true;
    this.startTime = performance.now();
    this.duration = durationMs;
    this.lastFrameTime = this.startTime;
    
    console.log(`[Profiler] Started${durationMs > 0 ? ` (will stop in ${durationMs / 1000}s)` : ''}`);
    console.log('[Profiler] Move around to benchmark navigation performance...');
    
    this._monitorFrame();
  }
  
  _monitorFrame() {
    if (!this.isRunning) return;
    
    const now = performance.now();
    const delta = now - this.lastFrameTime;
    
    this.frameTimes.push(delta);
    this.frameTimestamps.push(now - this.startTime);
    this.lastFrameTime = now;
    
    // Log periodic updates
    if (this.frameTimes.length % 60 === 0) {
      const recentTimes = this.frameTimes.slice(-60);
      const avgDelta = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;
      const fps = 1000 / avgDelta;
      const elapsed = ((now - this.startTime) / 1000).toFixed(1);
      console.log(`[Profiler] ${elapsed}s elapsed | Current FPS: ${fps.toFixed(1)} | Frames: ${this.frameTimes.length}`);
    }
    
    // Auto-stop if duration reached
    if (this.duration > 0 && (now - this.startTime) >= this.duration) {
      this.stop();
      return;
    }
    
    this.animationFrameId = requestAnimationFrame(() => this._monitorFrame());
  }
  
  /**
   * Stop profiling and print results
   */
  stop() {
    if (!this.isRunning) {
      console.log('[Profiler] Not running');
      return;
    }
    
    this.isRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    console.log('[Profiler] Stopped');
    this.printReport();
  }
  
  /**
   * Calculate and print performance report
   */
  printReport() {
    const times = this.frameTimes;
    if (times.length === 0) {
      console.log('[Profiler] No data collected');
      return;
    }
    
    // Calculate statistics
    const sorted = [...times].sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    const avg = sum / times.length;
    
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    
    // Percentiles
    const percentile = (p) => sorted[Math.floor(sorted.length * p)];
    const p1 = percentile(0.01);
    const p5 = percentile(0.05);
    const p50 = percentile(0.50);
    const p95 = percentile(0.95);
    const p99 = percentile(0.99);
    
    // Frame budget analysis
    const under60fps = times.filter(t => t > 16.67).length;
    const under30fps = times.filter(t => t > 33.33).length;
    const under10fps = times.filter(t => t > 100).length;
    const under2fps = times.filter(t => t > 500).length;
    const under1fps = times.filter(t => t > 1000).length;
    
    // Detect lag spikes (frames > 200ms)
    const lagSpikes = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i] > 200) {
        lagSpikes.push({
          frame: i,
          time: this.frameTimestamps[i],
          duration: times[i]
        });
      }
    }
    
    // Print report
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  PERFORMANCE BENCHMARK RESULTS');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    // Get triangle counts from ChunkManager
    if (window.__chunkManager) {
      console.log('  TRIANGLE COUNTS:');
      try {
        const countTriangles = (meshArray) => {
          let count = 0;
          for (const mesh of meshArray || []) {
            if (mesh.isLOD) {
              const geom = mesh.levels?.[0]?.object?.geometry;
              const idx = geom?.getIndex();
              if (idx) count += idx.count / 3;
            } else {
              const idx = mesh.geometry?.getIndex();
              if (idx) count += idx.count / 3;
            }
          }
          return count;
        };
        
        const cm = window.__chunkManager;
        const solid = countTriangles(cm.solidMeshes);
        const water = countTriangles(cm.waterMeshes);
        const lava = countTriangles(cm.lavaMeshes);
        const glass = countTriangles(cm.glassMeshes);
        const model = countTriangles(cm.modelMeshes);
        const transparentModel = countTriangles(cm.transparentModelMeshes);
        const overlay = countTriangles(cm.overlayModelMeshes);
        const total = solid + water + lava + glass + model + transparentModel + overlay;
        
        console.log(`    Solid blocks:      ${solid.toLocaleString()}`);
        console.log(`    Water:             ${water.toLocaleString()}`);
        console.log(`    Glass/Leaves:      ${glass.toLocaleString()}`);
        console.log(`    Model blocks:      ${model.toLocaleString()}`);
        console.log(`    Transparent model: ${transparentModel.toLocaleString()}`);
        console.log(`    TOTAL:             ${total.toLocaleString()}`);
        console.log(`    Partial block distance: ${cm.getPartialBlockDistance()} blocks`);
      } catch (e) {
        console.log('    (Could not read triangle counts)');
      }
      console.log();
    }
    
    console.log('  FPS STATISTICS:');
    console.log(`    Total frames:    ${times.length}`);
    console.log(`    Duration:        ${((times.length > 0 ? this.frameTimestamps[times.length - 1] : 0) / 1000).toFixed(1)}s`);
    console.log(`    Average FPS:     ${(1000 / avg).toFixed(1)}`);
    console.log(`    Min FPS:         ${(1000 / max).toFixed(1)}`);
    console.log(`    Max FPS:         ${(1000 / min).toFixed(1)}`);
    console.log();
    
    console.log('  FPS PERCENTILES:');
    console.log(`    1%  (worst):     ${(1000 / p99).toFixed(1)} FPS`);
    console.log(`    5%:              ${(1000 / p95).toFixed(1)} FPS`);
    console.log(`    50% (median):    ${(1000 / p50).toFixed(1)} FPS`);
    console.log(`    95%:             ${(1000 / p5).toFixed(1)} FPS`);
    console.log(`    99% (best):      ${(1000 / p1).toFixed(1)} FPS`);
    console.log();
    
    console.log('  FRAME BUDGET ANALYSIS:');
    console.log(`    Under 60 FPS:    ${under60fps} frames (${(under60fps / times.length * 100).toFixed(1)}%)`);
    console.log(`    Under 30 FPS:    ${under30fps} frames (${(under30fps / times.length * 100).toFixed(1)}%)`);
    console.log(`    Under 10 FPS:    ${under10fps} frames (${(under10fps / times.length * 100).toFixed(1)}%)`);
    if (under2fps > 0) {
      console.log(`    Under 2 FPS:     ${under2fps} frames (SEVERE LAG)`);
    }
    if (under1fps > 0) {
      console.log(`    Under 1 FPS:     ${under1fps} frames (FREEZES)`);
    }
    console.log();
    
    // Lag spike details
    if (lagSpikes.length > 0) {
      console.log('  LAG SPIKES (> 200ms):');
      for (const spike of lagSpikes.slice(0, 10)) {
        console.log(`    Frame ${spike.frame} at ${(spike.time / 1000).toFixed(2)}s: ${spike.duration.toFixed(0)}ms (${(1000 / spike.duration).toFixed(1)} FPS)`);
      }
      if (lagSpikes.length > 10) {
        console.log(`    ... and ${lagSpikes.length - 10} more`);
      }
      console.log();
    }
    
    // Summary
    console.log('═══════════════════════════════════════════════════════════════');
    const avgFps = 1000 / avg;
    if (avgFps >= 30 && under10fps / times.length < 0.05) {
      console.log('  ✓ Performance: ACCEPTABLE');
    } else if (avgFps >= 15) {
      console.log('  ⚠ Performance: POOR');
    } else {
      console.log('  ✗ Performance: UNACCEPTABLE');
    }
    console.log(`  Average: ${avgFps.toFixed(1)} FPS | 1% low: ${(1000 / p99).toFixed(1)} FPS`);
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    // Recommendations
    if (avgFps < 30 || under10fps > 0) {
      console.log('  RECOMMENDATIONS:');
      console.log('    Try reducing partial block distance:');
      console.log('      window.__chunkManager.setPartialBlockDistance(32)');
      console.log('    Or hide model blocks to test impact:');
      console.log('      window.__chunkManager.setGroupVisible("model", false)');
      console.log();
    }
    
    return {
      frameCount: times.length,
      avgFps: 1000 / avg,
      minFps: 1000 / max,
      maxFps: 1000 / min,
      p1Fps: 1000 / p99,
      p5Fps: 1000 / p95,
      p50Fps: 1000 / p50,
      p95Fps: 1000 / p5,
      p99Fps: 1000 / p1,
      under60fps,
      under30fps,
      under10fps,
      under2fps,
      under1fps,
      lagSpikes,
    };
  }
}

// Auto-instantiate
export const profiler = new PerformanceProfiler();



