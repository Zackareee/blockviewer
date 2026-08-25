/**
 * BenchmarkRunner — timed spawn-load benchmark with FPS / memory / chunk metrics.
 *
 * Ends on chunk+mesh stabilization (quiet for STABLE_MS) or MAX_DURATION_MS, whichever first.
 * CPU % is not available in browsers; we approximate main-thread pressure via frame time
 * and optional Long Tasks API samples.
 */

export const BENCHMARK_MAX_MS = 60_000;
export const BENCHMARK_STABLE_MS = 1_500;
/** Locked look: Minecraft south, level */
export const BENCHMARK_LOCK_YAW = 0;
export const BENCHMARK_LOCK_PITCH = 0;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function deviceInfo() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const win = typeof window !== 'undefined' ? window : {};
  return {
    userAgent: nav.userAgent || null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    devicePixelRatio: win.devicePixelRatio ?? null,
    viewport: {
      width: win.innerWidth ?? null,
      height: win.innerHeight ?? null,
      cssPixelArea: (win.innerWidth || 0) * (win.innerHeight || 0),
      devicePixelArea:
        (win.innerWidth || 0) * (win.innerHeight || 0) * (win.devicePixelRatio || 1) ** 2,
    },
    platform: nav.platform || null,
    connection: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType,
          saveData: !!nav.connection.saveData,
        }
      : null,
  };
}

function readHeap() {
  const mem = typeof performance !== 'undefined' ? performance.memory : null;
  if (!mem) return null;
  return {
    usedJSHeapMB: mem.usedJSHeapSize / (1024 * 1024),
    totalJSHeapMB: mem.totalJSHeapSize / (1024 * 1024),
    jsHeapLimitMB: mem.jsHeapSizeLimit / (1024 * 1024),
  };
}

export class BenchmarkRunner {
  constructor({
    maxDurationMs = BENCHMARK_MAX_MS,
    stableMs = BENCHMARK_STABLE_MS,
  } = {}) {
    this.maxDurationMs = maxDurationMs;
    this.stableMs = stableMs;
    this.reset();
  }

  reset() {
    this.running = false;
    this.startTime = 0;
    this.endTime = 0;
    this.endReason = null;
    this.lastFrameTime = 0;
    this.frameDeltas = [];
    this.samples = []; // downsampled timeline (~10 Hz)
    this._lastSampleAt = 0;
    this._quietSince = 0;
    this._lastActivityKey = '';
    this.timeToFirstMeshMs = null;
    this.timeToInitialLoadMs = null;
    this.longTaskCount = 0;
    this.longTaskTotalMs = 0;
    this._longTaskObserver = null;
    this._rafId = null;
    this.device = deviceInfo();
    this.finalSnapshot = null;
  }

  start() {
    this.reset();
    this.running = true;
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this._attachLongTaskObserver();
    return this;
  }

  _attachLongTaskObserver() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this._longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTaskCount++;
          this.longTaskTotalMs += entry.duration;
        }
      });
      this._longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      this._longTaskObserver = null;
    }
  }

  _detachLongTaskObserver() {
    try {
      this._longTaskObserver?.disconnect();
    } catch {
      /* ignore */
    }
    this._longTaskObserver = null;
  }

  /**
   * Feed a world/streamer snapshot each animation frame (from BenchmarkController).
   * @param {object} snap
   */
  observe(snap) {
    if (!this.running) return null;

    const now = performance.now();
    const elapsed = now - this.startTime;
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    if (dt > 0 && dt < 5000) {
      this.frameDeltas.push(dt);
    }

    if (this.timeToFirstMeshMs == null && (snap.totalMeshes || 0) > 0) {
      this.timeToFirstMeshMs = elapsed;
    }
    if (this.timeToInitialLoadMs == null && snap.initialLoadComplete) {
      this.timeToInitialLoadMs = elapsed;
    }

    // ~10 Hz timeline samples
    if (now - this._lastSampleAt >= 100) {
      this._lastSampleAt = now;
      const heap = readHeap();
      this.samples.push({
        t: elapsed,
        fps: dt > 0 ? 1000 / dt : 0,
        dt,
        heapUsedMB: heap?.usedJSHeapMB ?? null,
        loadedChunks: snap.loadedChunks ?? 0,
        queuedChunks: snap.queuedChunks ?? 0,
        totalMeshes: snap.totalMeshes ?? 0,
        dirtyCount: snap.dirtyCount ?? 0,
        pendingWork: !!snap.pendingWork,
        initialLoadComplete: !!snap.initialLoadComplete,
        stage: snap.stage || null,
      });
    }

    const activityKey = [
      snap.loadedChunks,
      snap.queuedChunks,
      snap.totalMeshes,
      snap.dirtyCount,
      snap.pendingWork ? 1 : 0,
      snap.initialLoadComplete ? 1 : 0,
    ].join('|');

    const quiet =
      !!snap.initialLoadComplete &&
      (snap.queuedChunks || 0) === 0 &&
      !snap.pendingWork &&
      (snap.dirtyCount || 0) === 0 &&
      !snap.isProcessing;

    if (quiet && activityKey === this._lastActivityKey) {
      if (!this._quietSince) this._quietSince = now;
    } else {
      this._quietSince = 0;
      this._lastActivityKey = activityKey;
    }

    let endReason = null;
    if (this._quietSince && now - this._quietSince >= this.stableMs) {
      endReason = 'stable';
    } else if (elapsed >= this.maxDurationMs) {
      endReason = 'timeout';
    }

    if (endReason) {
      this.finalSnapshot = { ...snap, heap: readHeap(), elapsedMs: elapsed };
      this.stop(endReason);
      return this.getReport();
    }

    return null;
  }

  _tick() {
    // Driven externally via observe() from the render loop
  }

  stop(reason = 'manual') {
    if (!this.running && this.endReason) return this.getReport();
    this.running = false;
    this.endReason = reason;
    this.endTime = performance.now();
    this._detachLongTaskObserver();
    return this.getReport();
  }

  getLive() {
    const now = performance.now();
    const elapsed = this.running ? now - this.startTime : this.endTime - this.startTime;
    const recent = this.frameDeltas.slice(-60);
    const avgDt = recent.length
      ? recent.reduce((a, b) => a + b, 0) / recent.length
      : 0;
    const last = this.samples[this.samples.length - 1];
    return {
      running: this.running,
      elapsedMs: elapsed,
      remainingMs: Math.max(0, this.maxDurationMs - elapsed),
      fps: avgDt > 0 ? 1000 / avgDt : 0,
      quietMs: this._quietSince ? now - this._quietSince : 0,
      stableMsNeeded: this.stableMs,
      lastSample: last || null,
      heap: readHeap(),
      endReason: this.endReason,
    };
  }

  getReport() {
    const times = this.frameDeltas;
    const sorted = [...times].sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    const avg = times.length ? sum / times.length : 0;
    const durationMs = (this.endTime || performance.now()) - this.startTime;

    const fpsFrom = (dt) => (dt > 0 ? 1000 / dt : 0);

    return {
      version: 1,
      endReason: this.endReason,
      durationMs,
      maxDurationMs: this.maxDurationMs,
      stableMs: this.stableMs,
      lock: { yaw: BENCHMARK_LOCK_YAW, pitch: BENCHMARK_LOCK_PITCH },
      device: this.device,
      timing: {
        timeToFirstMeshMs: this.timeToFirstMeshMs,
        timeToInitialLoadMs: this.timeToInitialLoadMs,
        timeToStableMs: this.endReason === 'stable' ? durationMs : null,
      },
      fps: {
        avg: fpsFrom(avg),
        min: fpsFrom(sorted[sorted.length - 1] || 0),
        max: fpsFrom(sorted[0] || 0),
        p1: fpsFrom(percentile(sorted, 0.99)),
        p50: fpsFrom(percentile(sorted, 0.5)),
        p99: fpsFrom(percentile(sorted, 0.01)),
        frames: times.length,
      },
      frames: {
        avgMs: avg,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted[sorted.length - 1] || 0,
        over33ms: times.filter((t) => t > 33.33).length,
        over50ms: times.filter((t) => t > 50).length,
        over100ms: times.filter((t) => t > 100).length,
        over200ms: times.filter((t) => t > 200).length,
      },
      memory: {
        final: this.finalSnapshot?.heap || readHeap(),
        peakUsedMB: this.samples.reduce(
          (m, s) => (s.heapUsedMB != null ? Math.max(m, s.heapUsedMB) : m),
          0
        ),
        note: 'Chrome performance.memory only; not true process RSS. CPU% unavailable in web.',
      },
      longTasks: {
        count: this.longTaskCount,
        totalMs: this.longTaskTotalMs,
      },
      world: this.finalSnapshot
        ? {
            loadedChunks: this.finalSnapshot.loadedChunks,
            queuedChunks: this.finalSnapshot.queuedChunks,
            totalMeshes: this.finalSnapshot.totalMeshes,
            superChunkCount: this.finalSnapshot.superChunkCount,
            dirtyCount: this.finalSnapshot.dirtyCount,
            initialLoadComplete: this.finalSnapshot.initialLoadComplete,
            renderDistance: this.finalSnapshot.renderDistance,
            chunkLoadingSpeed: this.finalSnapshot.chunkLoadingSpeed,
            dpr: this.finalSnapshot.dpr,
            targetResolution: this.finalSnapshot.targetResolution,
          }
        : null,
      samples: this.samples,
    };
  }
}
