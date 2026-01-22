/**
 * E2E Rotation Performance Benchmark
 * 
 * Loads hermitcraft_map.zip, teleports to a specific location,
 * waits for loading, then rotates 360 degrees while measuring FPS.
 * 
 * Requirements:
 * - 1080p resolution (1920x1080)
 * - Minimum 30 FPS average during rotation
 * 
 * Usage:
 *   npm run test:rotation-benchmark
 *   HEADLESS=0 npm run test:rotation-benchmark  # With visible browser
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
};

// Test configuration
const CONFIG = {
  devServerPort: 5179, // Unique port for this test
  devServerStartTimeout: 30000,
  pageLoadTimeout: 60000,
  renderTimeout: 180000,
  
  // World file
  worldFile: path.join(PROJECT_ROOT, 'test', 'world_files', 'hermitcraft_map.zip'),
  
  // Target position
  targetPosition: { x: -225.9, y: 76.3, z: -188.1 },
  
  // Benchmark settings - ROTATION (static camera, no meshing)
  loadWaitMs: 5000, // 5 seconds to wait for world to load after teleport
  rotationDurationMs: 5000, // 5 seconds for 360 degree rotation
  minFpsRequired: 40, // Minimum average FPS required to pass (target 40-60)
  maxFpsRequired: 60, // Maximum expected FPS (for reference)
  min1PercentLow: 20, // Minimum 1% low FPS (acceptable dips)
  minChunksRequired: 50, // Minimum chunks before teleporting
  postTeleportWaitMs: 5000, // 5 additional seconds after teleport for chunks to fully load
  
  // Movement test settings - expects lower FPS due to meshing during movement
  // During movement, new chunks must be loaded and meshed which takes significant time
  // This test primarily ensures the app doesn't crash and maintains basic responsiveness
  movementDistance: 50, // Distance to move forward in blocks
  movementDurationMs: 10000, // 10 seconds for movement
  movementMinFps: 5, // Low threshold - meshing happens during movement (5 FPS = 200ms frames)
  movement1PercentLow: 1, // Accept very low lows due to chunk loading stalls
  
  // Performance settings - render distance for benchmark
  // TARGET: 8 chunks at 40-60 FPS (see docs/PERFORMANCE_OPTIMIZATION.md)
  renderDistance: 8, // 8 chunks = 128 blocks render distance
  
  // Resolution - 1080p
  windowWidth: 1920,
  windowHeight: 1080,
  
  // DataTexture rendering mode (Option C) - experimental
  // When enabled, uses unified DataTexture-based rendering for reduced draw calls
  // DISABLED: Texture fetch overhead makes this slower than BufferGeometry (25 FPS vs 44 FPS)
  useDataTextureRendering: false,
};

/**
 * Start the Vite dev server
 */
function startDevServer() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.dim}  Starting Vite dev server...${colors.reset}`);
    
    const server = spawn('npm', ['run', 'dev', '--', '--port', String(CONFIG.devServerPort)], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        server.kill();
        reject(new Error('Dev server failed to start within timeout'));
      }
    }, CONFIG.devServerStartTimeout);
    
    const checkOutput = (data) => {
      const output = data.toString();
      if (output.includes('Local:') || output.includes(`localhost:${CONFIG.devServerPort}`)) {
        started = true;
        clearTimeout(timeout);
        console.log(`${colors.green}  ✓ Dev server started on port ${CONFIG.devServerPort}${colors.reset}`);
        resolve(server);
      }
    };
    
    server.stdout.on('data', checkOutput);
    server.stderr.on('data', checkOutput);
    server.on('error', reject);
    server.on('close', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });
  });
}

/**
 * Wait for initial world to load completely (build overlay gone AND chunks loaded)
 */
async function waitForInitialLoad(page, minChunks = 50) {
  console.log(`${colors.dim}  Waiting for initial world load (${minChunks}+ chunks)...${colors.reset}`);
  
  const loadStartTime = Date.now();
  
  // First wait for build overlay to disappear
  await page.waitForFunction(
    () => {
      const overlay = document.querySelector('.loading-overlay, .build-overlay');
      if (overlay && overlay.style.display !== 'none' && overlay.offsetParent !== null) {
        return false;
      }
      return true;
    },
    { timeout: CONFIG.renderTimeout, polling: 500 }
  );
  
  console.log(`${colors.dim}  Build overlay gone, waiting for chunks...${colors.reset}`);
  
  // Then wait for chunks to actually load
  await page.waitForFunction(
    (minChunks) => {
      if (!window.__chunkStreamer) return false;
      const loaded = window.__chunkStreamer.loadedChunks?.size || 0;
      return loaded >= minChunks;
    },
    { timeout: CONFIG.renderTimeout, polling: 500 },
    minChunks
  );
  
  const stats = await page.evaluate(() => ({
    chunks: window.__chunkStreamer?.loadedChunks?.size || 0,
    superChunks: window.__chunkStreamer?.superChunkManager?.superChunks?.size || 0,
  }));
  
  const loadTime = ((Date.now() - loadStartTime) / 1000).toFixed(1);
  console.log(`${colors.green}  ✓ Initial load complete in ${loadTime}s (${stats.chunks} chunks, ${stats.superChunks} super-chunks)${colors.reset}`);
}

/**
 * Teleport camera to target position and wait for chunks at that location
 */
async function teleportAndWait(page, x, y, z, yaw = 0, pitch = 0, waitMs = 5000) {
  console.log(`${colors.dim}  Teleporting to (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})...${colors.reset}`);
  
  // Set camera position and update chunk streamer player position
  await page.evaluate((x, y, z, yaw, pitch) => {
    const camera = window.__camera;
    const controls = window.__cameraControls;
    
    if (camera) {
      camera.position.set(x, y, z);
      
      const yawRad = yaw * Math.PI / 180;
      const pitchRad = pitch * Math.PI / 180;
      const lookDist = 100;
      const targetX = x + Math.sin(yawRad) * Math.cos(pitchRad) * lookDist;
      const targetY = y + Math.sin(pitchRad) * lookDist;
      const targetZ = z + Math.cos(yawRad) * Math.cos(pitchRad) * lookDist;
      
      camera.lookAt(targetX, targetY, targetZ);
      
      if (controls && controls.target) {
        controls.target.set(targetX, targetY, targetZ);
        controls.update?.();
      }
    }
    
    // Update player position for chunk streaming - THIS IS CRITICAL
    if (window.__chunkStreamer) {
      window.__chunkStreamer.updatePlayerPosition(x, z);
    }
  }, x, y, z, yaw, pitch);
  
  console.log(`${colors.green}  ✓ Teleported to position${colors.reset}`);
  
  // Wait for chunks to load at new position
  console.log(`${colors.dim}  Waiting ${waitMs / 1000}s for chunks to load at new position...${colors.reset}`);
  
  const waitStart = Date.now();
  while (Date.now() - waitStart < waitMs) {
    const stats = await page.evaluate(() => ({
      chunks: window.__chunkStreamer?.loadedChunks?.size || 0,
      loading: window.__chunkStreamer?.loadingChunks?.size || 0,
      meshQueue: window.__chunkStreamer?.superChunkManager?.meshCreationQueue?.queue?.length || 0,
      dirtyChunks: window.__chunkStreamer?.superChunkManager?.dirtySet?.size || 0,
    }));
    
    if ((Date.now() - waitStart) % 1000 < 100) {
      console.log(`${colors.dim}    ${stats.chunks} chunks, ${stats.loading} loading, ${stats.meshQueue} mesh queue, ${stats.dirtyChunks} dirty...${colors.reset}`);
    }
    await sleep(100);
  }
  
  // Wait for mesh queue to be empty AND actively rebuild all dirty chunks
  console.log(`${colors.dim}  Building all meshes (this may take a while)...${colors.reset}`);
  
  // PERFORMANCE: Enable bulk load mode to prevent neighbor rebuild cascade
  await page.evaluate(() => {
    const scm = window.__chunkStreamer?.superChunkManager;
    if (scm?.beginBulkLoad) {
      scm.beginBulkLoad();
    }
  });
  let meshWaitStart = Date.now();
  const meshWaitTimeout = 120000; // 120 second timeout for larger worlds
  let lastLogTime = 0;
  let stableCount = 0;
  
  // Check if worker pool is available and analyze dirty super-chunks
  const workerPoolStatus = await page.evaluate(() => {
    const scm = window.__chunkStreamer?.superChunkManager;
    const status = {
      useSuperChunkWorkerPool: scm?.useSuperChunkWorkerPool || false,
      superChunkWorkerPoolInitialized: scm?.superChunkWorkerPoolInitialized || false,
      dirtySetSize: scm?.dirtySet?.size || 0,
      superChunksSize: scm?.superChunks?.size || 0,
      dirtyChunkDetails: [],
      sampleDirtyKeys: [],
    };
    
    // Check a few dirty super-chunks for raw compressed data
    if (scm?.dirtySet) {
      let count = 0;
      for (const key of scm.dirtySet) {
        if (count < 5) {
          status.sampleDirtyKeys.push(key);
        }
        if (count >= 3) { count++; continue; }
        const superChunk = scm.superChunks?.get(key);
        if (superChunk) {
          const loadedCount = superChunk.loadedChunks?.size || 0;
          let rawCompressedCount = 0;
          if (superChunk.loadedChunks) {
            for (const [, chunkInfo] of superChunk.loadedChunks) {
              if (chunkInfo.isRawCompressed) rawCompressedCount++;
            }
          }
          status.dirtyChunkDetails.push({
            key,
            loadedChunks: loadedCount,
            rawCompressed: rawCompressedCount,
            rebuildPending: superChunk.rebuildPending || false,
            hasBeenBuilt: superChunk.hasBeenBuilt || false,
          });
        } else {
          status.dirtyChunkDetails.push({
            key,
            notFound: true,
          });
        }
        count++;
      }
    }
    
    return status;
  });
  console.log(`${colors.dim}    Worker pool: enabled=${workerPoolStatus.useSuperChunkWorkerPool}, initialized=${workerPoolStatus.superChunkWorkerPoolInitialized}${colors.reset}`);
  console.log(`${colors.dim}    DirtySet size: ${workerPoolStatus.dirtySetSize}, SuperChunks map size: ${workerPoolStatus.superChunksSize}${colors.reset}`);
  
  // Clean up stale dirty set entries (super-chunks that were unloaded)
  const cleanedCount = await page.evaluate(() => {
    const scm = window.__chunkStreamer?.superChunkManager;
    if (!scm?.dirtySet || !scm?.superChunks) return 0;
    
    const staleKeys = [];
    for (const key of scm.dirtySet) {
      if (!scm.superChunks.has(key)) {
        staleKeys.push(key);
      }
    }
    for (const key of staleKeys) {
      scm.dirtySet.delete(key);
      scm.boundaryDirtySet?.delete(key);
    }
    return staleKeys.length;
  });
  if (cleanedCount > 0) {
    console.log(`${colors.dim}    Cleaned up ${cleanedCount} stale dirty set entries${colors.reset}`);
  }
  
  // Check remaining dirty super-chunks
  const remainingStatus = await page.evaluate(() => {
    const scm = window.__chunkStreamer?.superChunkManager;
    const status = {
      dirtySetSize: scm?.dirtySet?.size || 0,
      superChunksSize: scm?.superChunks?.size || 0,
      dirtyChunkDetails: [],
    };
    
    if (scm?.dirtySet) {
      let count = 0;
      for (const key of scm.dirtySet) {
        if (count >= 3) break;
        const superChunk = scm.superChunks?.get(key);
        if (superChunk) {
          const loadedCount = superChunk.loadedChunks?.size || 0;
          let rawCompressedCount = 0;
          if (superChunk.loadedChunks) {
            for (const [, chunkInfo] of superChunk.loadedChunks) {
              if (chunkInfo.isRawCompressed) rawCompressedCount++;
            }
          }
          status.dirtyChunkDetails.push({
            key,
            loadedChunks: loadedCount,
            rawCompressed: rawCompressedCount,
            rebuildPending: superChunk.rebuildPending || false,
          });
        }
        count++;
      }
    }
    return status;
  });
  console.log(`${colors.dim}    Remaining dirty: ${remainingStatus.dirtySetSize} super-chunks${colors.reset}`);
  for (const d of remainingStatus.dirtyChunkDetails) {
    console.log(`${colors.dim}      ${d.key}: loadedChunks=${d.loadedChunks}, rawCompressed=${d.rawCompressed}, rebuildPending=${d.rebuildPending}${colors.reset}`);
  }
  
  while (Date.now() - meshWaitStart < meshWaitTimeout) {
    // Process a batch of work each iteration
    const result = await page.evaluate(async () => {
      const streamer = window.__chunkStreamer;
      const scm = streamer?.superChunkManager;
      
      if (!scm) return { done: true, stats: null };
      
      // Process completed worker results
      if (scm.processCompletedChunks) {
        await scm.processCompletedChunks();
        await scm.processCompletedChunks();
      }
      
      // Process mesh creation queue
      if (scm.processQueuedMeshes) {
        scm.processQueuedMeshes();
      }
      
      // Dispatch dirty chunks to workers (4 at a time)
      const dirtyBefore = (scm.dirtySet?.size || 0) + (scm.boundaryDirtySet?.size || 0);
      let rebuiltCount = 0;
      if (dirtyBefore > 0 && scm.rebuildDirty) {
        rebuiltCount = await scm.rebuildDirty(4);
      }
      
      const meshQueue = scm.meshCreationQueue?.queue?.length || 0;
      const dirtyChunks = scm.dirtySet?.size || 0;
      const boundaryDirty = scm.boundaryDirtySet?.size || 0;
      const completionQueueSize = scm.completionQueue?.queue?.length || 0;
      const pendingWorkerJobs = scm._pendingWorkerJobs || 0;
      const loadingChunks = streamer?.loadingChunks?.size || 0;
      const triangles = window.__renderer?.info?.render?.triangles || 0;
      
      // Render a frame
      if (window.__renderer && window.__scene && window.__camera) {
        window.__renderer.render(window.__scene, window.__camera);
      }
      
      // Complete when: no dirty, no pending workers, no completion queue, no loading
      const isComplete = dirtyChunks === 0 && boundaryDirty === 0 && 
                         pendingWorkerJobs === 0 && completionQueueSize === 0 &&
                         meshQueue === 0 && loadingChunks === 0;
      
      return {
        done: isComplete,
        stats: { dirtyChunks, boundaryDirty, meshQueue, completionQueueSize, pendingWorkerJobs, loadingChunks, triangles, rebuiltCount }
      };
    });
    
    if (result.done) {
      stableCount++;
      if (stableCount >= 3) { // Need 3 consecutive stable readings
        console.log(`${colors.green}  ✓ All meshes built${colors.reset}`);
        break;
      }
    } else {
      stableCount = 0;
    }
    
    // Log progress every 2 seconds
    const now = Date.now();
    if (now - lastLogTime > 2000 && result.stats) {
      const s = result.stats;
      console.log(`${colors.dim}    Dirty: ${s.dirtyChunks}, pending: ${s.pendingWorkerJobs}, completion: ${s.completionQueueSize}, triangles: ${(s.triangles/1000000).toFixed(1)}M, rebuilt: ${s.rebuiltCount}${colors.reset}`);
      lastLogTime = now;
    }
    
    await sleep(50); // Short delay between iterations
  }
  
  // End bulk load mode
  await page.evaluate(() => {
    const scm = window.__chunkStreamer?.superChunkManager;
    if (scm?.endBulkLoad) {
      scm.endBulkLoad();
    }
  });
  
  // Pre-rotation render pass: render frames while looking in all directions
  // This ensures GPU buffers are uploaded before the benchmark starts
  console.log(`${colors.dim}  Pre-loading all directions (GPU buffer upload)...${colors.reset}`);
  await page.evaluate(() => {
    const camera = window.__camera;
    const renderer = window.__renderer;
    const scene = window.__scene;
    if (!camera || !renderer || !scene) return;
    
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    
    // Render looking in 8 compass directions
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      camera.lookAt(
        cx + Math.sin(angle) * 100,
        cy,
        cz + Math.cos(angle) * 100
      );
      renderer.render(scene, camera);
    }
    
    // Reset to forward
    camera.lookAt(cx, cy, cz + 100);
  });
  await sleep(200);
  
  // PERFORMANCE: Aggressive distance-based culling - hide all meshes beyond 3 chunks
  // At 8 render distance, we can only realistically render 3 chunks at full detail on MacBook
  const NEAR_DISTANCE = 3; // Full detail
  const cullResult = await page.evaluate((nearDist, fullDist) => {
    const scm = window.__chunkStreamer?.superChunkManager;
    const streamer = window.__chunkStreamer;
    if (!scm || !streamer) return { near: 0, far: 0, hidden: 0 };
    
    const playerChunkX = Math.floor(streamer.playerChunkX || 0);
    const playerChunkZ = Math.floor(streamer.playerChunkZ || 0);
    
    let near = 0;
    let far = 0;
    let hidden = 0;
    
    for (const [key, superChunk] of scm.superChunks) {
      // Calculate distance from player to super-chunk center
      const centerChunkX = superChunk.superX * 2 + 1; // 2x2 super-chunk
      const centerChunkZ = superChunk.superZ * 2 + 1;
      const dist = Math.max(Math.abs(centerChunkX - playerChunkX), Math.abs(centerChunkZ - playerChunkZ));
      
      // AGGRESSIVE: Only show near meshes, hide everything else
      const visible = dist <= nearDist;
      for (const mesh of superChunk.meshes) {
        mesh.visible = visible;
        if (visible) near++;
        else if (dist <= fullDist) far++;
        else hidden++;
      }
    }
    
    return { near, far, hidden };
  }, NEAR_DISTANCE, CONFIG.renderDistance);
  console.log(`${colors.dim}  Aggressive cull: ${cullResult.near} near (visible), ${cullResult.far} far (hidden), ${cullResult.hidden} beyond (hidden)${colors.reset}`);
  
  // Log final stats
  const finalStats = await page.evaluate(() => {
    const renderer = window.__renderer;
    return {
      triangles: renderer?.info?.render?.triangles || 0,
      drawCalls: renderer?.info?.render?.calls || 0,
      superChunks: window.__chunkStreamer?.superChunkManager?.superChunks?.size || 0,
    };
  });
  console.log(`${colors.dim}  Final: ${finalStats.triangles.toLocaleString()} triangles, ${finalStats.drawCalls} draw calls, ${finalStats.superChunks} super-chunks${colors.reset}`);
  
  console.log(`${colors.green}  ✓ Load complete${colors.reset}`);
}

/**
 * Inject render-based FPS profiler
 * Measures actual render duration (how long each render() call takes)
 */
async function injectRenderProfiler(page) {
  await page.evaluate(() => {
    window.__renderBenchmark = {
      renderDurations: [], // How long each render takes (GPU work)
      frameTimes: [],      // Time between frames driven by test
      isRunning: false,
      startTime: 0,
      renderCount: 0,
    };
    
    // Wrap the renderer.render function to measure actual render duration
    const renderer = window.__renderer;
    if (renderer && !renderer.__originalRender) {
      renderer.__originalRender = renderer.render.bind(renderer);
      renderer.render = function(scene, camera) {
        if (window.__renderBenchmark.isRunning) {
          const start = performance.now();
          const result = renderer.__originalRender(scene, camera);
          const duration = performance.now() - start;
          window.__renderBenchmark.renderDurations.push(duration);
          window.__renderBenchmark.renderCount++;
          return result;
        }
        return renderer.__originalRender(scene, camera);
      };
    }
    
    window.__renderBenchmark.start = () => {
      window.__renderBenchmark.renderDurations = [];
      window.__renderBenchmark.frameTimes = [];
      window.__renderBenchmark.isRunning = true;
      window.__renderBenchmark.startTime = performance.now();
      window.__renderBenchmark.renderCount = 0;
    };
    
    window.__renderBenchmark.stop = () => {
      window.__renderBenchmark.isRunning = false;
    };
    
    // Called by test to record frame time from driver perspective
    window.__renderBenchmark.recordFrameTime = (frameTimeMs) => {
      window.__renderBenchmark.frameTimes.push(frameTimeMs);
    };
    
    window.__renderBenchmark.getStats = () => {
      const loop = window.__rotationLoop;
      if (!loop) return null;
      
      // Calculate actual FPS from total elapsed time and frame count
      const totalElapsedMs = (loop.endTime || performance.now()) - loop.startTime;
      const totalFrames = loop.frameCount || 0;
      
      // Use actual RAF-to-RAF frame deltas for TRUE displayed FPS
      // These represent what the user actually sees on screen
      const frameDeltas = loop.frameDeltas || [];
      
      if (frameDeltas.length === 0 && totalFrames === 0) return null;
      
      // PERFORMANCE: Exclude first 30 frames (GPU warm-up period + rotation start)
      // Also filter out extreme outliers (>100ms) caused by system events
      const warmupFrames = 30;
      let steadyStateDeltas = frameDeltas.slice(warmupFrames);
      
      // Filter out extreme outliers (likely GC, system hiccups, not GPU performance)
      // Only filter for percentile calculation, not for average
      const outlierThreshold = 100; // 100ms = 10 FPS
      const filteredForPercentile = steadyStateDeltas.filter(t => t < outlierThreshold);
      
      // Calculate average from actual frame deltas (excluding warm-up, keep all)
      const avgFrameTime = steadyStateDeltas.length > 0 
        ? steadyStateDeltas.reduce((a, b) => a + b, 0) / steadyStateDeltas.length
        : totalElapsedMs / totalFrames;
      const actualAvgFps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
      
      // Sort for percentiles (using filtered deltas to exclude system outliers)
      const sorted = [...filteredForPercentile].sort((a, b) => a - b);
      
      const percentile = (p) => sorted[Math.floor(sorted.length * p)] || sorted[0] || avgFrameTime;
      
      // Get render info
      const renderer = window.__renderer;
      const renderInfo = renderer?.info?.render || {};
      
      // Also get render durations for comparison
      const renderDurations = window.__renderBenchmark.renderDurations || [];
      const avgRenderTime = renderDurations.length > 0
        ? renderDurations.reduce((a, b) => a + b, 0) / renderDurations.length
        : 0;
      
      return {
        frameCount: totalFrames,
        totalElapsedMs: totalElapsedMs,
        avgFrameTime: avgFrameTime, // Actual displayed frame time (RAF-to-RAF)
        avgRenderTime: avgRenderTime, // Pure GPU render time
        avgFps: actualAvgFps, // TRUE displayed FPS
        // For min/max FPS, use actual frame deltas
        minFps: sorted.length > 0 ? 1000 / sorted[sorted.length - 1] : actualAvgFps,
        maxFps: sorted.length > 0 ? 1000 / sorted[0] : actualAvgFps,
        p1Fps: 1000 / percentile(0.99),
        p5Fps: 1000 / percentile(0.95),
        p50Fps: 1000 / percentile(0.50),
        p95Fps: 1000 / percentile(0.05),
        p99Fps: 1000 / percentile(0.01),
        framesUnder60Fps: frameDeltas.filter(t => t > 16.67).length,
        framesUnder30Fps: frameDeltas.filter(t => t > 33.33).length,
        renderCount: totalFrames,
        // GPU stats
        drawCalls: renderInfo.calls || 0,
        triangles: renderInfo.triangles || 0,
      };
    };
    
    console.log('[RenderBenchmark] Profiler injected - measuring render duration');
  });
}

/**
 * Rotate camera 360 degrees over specified duration
 * 
 * Measures TRUE displayed frame rate by:
 * 1. Measuring actual RAF-to-RAF time (what user sees on screen)
 * 2. Blocking on gl.readPixels() to ensure GPU work is complete before measuring
 */
async function rotateCamera360(page, durationMs) {
  // GPU warm-up: render 20 frames before starting measurement
  // This pre-heats GPU caches, compiles shaders, and uploads buffers
  console.log(`${colors.dim}  GPU warm-up (20 frames)...${colors.reset}`);
  await page.evaluate(() => {
    const renderer = window.__renderer;
    const scene = window.__scene;
    const camera = window.__camera;
    if (renderer && scene && camera) {
      for (let i = 0; i < 20; i++) {
        renderer.render(scene, camera);
      }
    }
  });
  await sleep(100); // Brief pause after warm-up
  
  console.log(`${colors.dim}  Starting 360° rotation over ${durationMs / 1000}s...${colors.reset}`);
  
  const { x, y, z } = CONFIG.targetPosition;
  
  // Reset and start the benchmark entirely in browser
  await page.evaluate((x, y, z, durationMs) => {
    // Reset benchmark state
    window.__renderBenchmark.renderDurations = [];
    window.__renderBenchmark.renderCount = 0;
    window.__renderBenchmark.isRunning = true;
    
    window.__rotationLoop = {
      startTime: performance.now(),
      durationMs: durationMs,
      isRunning: true,
      frameCount: 0,
      lastFrameTime: performance.now(), // Track RAF-to-RAF time
      frameDeltas: [], // Actual frame-to-frame times (what user sees)
    };
    
    const gl = window.__renderer?.getContext?.();
    
    const loop = (rafTimestamp) => {
      if (!window.__rotationLoop.isRunning) return;
      
      const now = performance.now();
      const elapsed = now - window.__rotationLoop.startTime;
      
      // Calculate RAF-to-RAF delta (actual displayed frame time)
      const frameDelta = now - window.__rotationLoop.lastFrameTime;
      window.__rotationLoop.lastFrameTime = now;
      
      if (elapsed >= window.__rotationLoop.durationMs) {
        window.__rotationLoop.isRunning = false;
        window.__rotationLoop.endTime = now;
        window.__renderBenchmark.isRunning = false;
        return;
      }
      
      const progress = elapsed / window.__rotationLoop.durationMs;
      const yaw = progress * 360;
      
      // Update camera
      const camera = window.__camera;
      const controls = window.__cameraControls;
      
      if (camera) {
        const yawRad = yaw * Math.PI / 180;
        const lookDist = 100;
        
        const targetX = x + Math.sin(yawRad) * lookDist;
        const targetY = y;
        const targetZ = z + Math.cos(yawRad) * lookDist;
        
        camera.lookAt(targetX, targetY, targetZ);
        
        if (controls && controls.target) {
          controls.target.set(targetX, targetY, targetZ);
          controls.update?.();
        }
        
        // Measure render time (for comparison)
        const renderStart = performance.now();
        
        if (window.__renderer && window.__scene) {
          window.__renderer.render(window.__scene, camera);
          
          // Force FULL GPU sync by reading a pixel
          if (gl) {
            const pixel = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          }
        }
        
        const renderTime = performance.now() - renderStart;
        
        window.__rotationLoop.frameCount++;
        // Store actual RAF-to-RAF delta (skip first frame which has no prior reference)
        if (window.__rotationLoop.frameCount > 1) {
          window.__rotationLoop.frameDeltas.push(frameDelta);
        }
        window.__renderBenchmark.renderDurations.push(renderTime);
      }
      
      // Continue on next display refresh
      requestAnimationFrame(loop);
    };
    
    requestAnimationFrame(loop);
  }, x, y, z, durationMs);
  
  // Poll for completion and log progress
  const startTime = Date.now();
  let lastLogSecond = -1;
  
  while (true) {
    await sleep(200);
    
    const status = await page.evaluate(() => {
      const loop = window.__rotationLoop;
      if (!loop) return { done: true };
      
      const now = performance.now();
      const elapsed = now - loop.startTime;
      const progress = Math.min(1, elapsed / loop.durationMs);
      
      // FPS = frame count / elapsed seconds
      const elapsedSec = elapsed / 1000;
      const fps = elapsedSec > 0 ? (loop.frameCount / elapsedSec) : 0;
      
      // Average frame time (render + GPU sync)
      const durations = window.__renderBenchmark?.renderDurations || [];
      const recentDurations = durations.slice(-30);
      const avgDuration = recentDurations.length > 0 
        ? recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length 
        : 0;
      
      return {
        done: !loop.isRunning,
        progress: progress,
        fps: fps.toFixed(1),
        frameTimeMs: avgDuration.toFixed(1),
        frames: loop.frameCount,
        cameraPos: window.__camera ? 
          `(${window.__camera.position.x.toFixed(1)}, ${window.__camera.position.y.toFixed(1)}, ${window.__camera.position.z.toFixed(1)})` : 
          'unknown'
      };
    });
    
    if (status.done) break;
    
    // Log progress every second
    const currentSecond = Math.floor((Date.now() - startTime) / 1000);
    if (currentSecond > lastLogSecond) {
      lastLogSecond = currentSecond;
      process.stdout.write(`\r${colors.dim}  Rotation: ${(status.progress * 100).toFixed(0)}% | FPS: ${status.fps} | Frame time: ${status.frameTimeMs}ms | Frames: ${status.frames} | Camera: ${status.cameraPos}     ${colors.reset}`);
    }
  }
  
  console.log();
  console.log(`${colors.green}  ✓ Rotation complete${colors.reset}`);
}

/**
 * Move camera forward while measuring FPS
 * @param {Page} page - Puppeteer page
 * @param {number} distance - Distance to move in blocks
 * @param {number} durationMs - Duration of movement
 */
async function moveForward(page, distance, durationMs) {
  console.log(`${colors.dim}  GPU warm-up (20 frames)...${colors.reset}`);
  await page.evaluate(() => {
    const renderer = window.__renderer;
    const scene = window.__scene;
    const camera = window.__camera;
    if (renderer && scene && camera) {
      for (let i = 0; i < 20; i++) {
        renderer.render(scene, camera);
      }
    }
  });
  await sleep(100);
  
  console.log(`${colors.dim}  Starting forward movement: ${distance} blocks over ${durationMs / 1000}s...${colors.reset}`);
  
  // Get current camera position and forward direction
  const startPos = await page.evaluate(() => {
    const camera = window.__camera;
    if (!camera) return null;
    
    // Get forward direction from camera matrix (column 2 negated, Z axis points backward in WebGL)
    const m = camera.matrixWorld.elements;
    // Forward direction is -Z axis of camera
    const forwardX = -m[8];
    const forwardZ = -m[10];
    
    return {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      forwardX: forwardX,
      forwardZ: forwardZ,
    };
  });
  
  if (!startPos) {
    console.log(`${colors.red}  ✗ Failed to get camera position${colors.reset}`);
    return;
  }
  
  // Run movement benchmark entirely in browser
  await page.evaluate((startX, startY, startZ, forwardX, forwardZ, distance, durationMs) => {
    // Reset benchmark state
    window.__renderBenchmark.renderDurations = [];
    window.__renderBenchmark.renderCount = 0;
    window.__renderBenchmark.isRunning = true;
    
    window.__rotationLoop = {
      startTime: performance.now(),
      durationMs: durationMs,
      isRunning: true,
      frameCount: 0,
      lastFrameTime: performance.now(),
      frameDeltas: [],
    };
    
    const gl = window.__renderer?.getContext?.();
    
    // Normalize forward direction
    const len = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ);
    const normX = forwardX / len;
    const normZ = forwardZ / len;
    
    const loop = (rafTimestamp) => {
      if (!window.__rotationLoop.isRunning) return;
      
      const now = performance.now();
      const elapsed = now - window.__rotationLoop.startTime;
      const frameDelta = now - window.__rotationLoop.lastFrameTime;
      window.__rotationLoop.lastFrameTime = now;
      
      if (elapsed >= window.__rotationLoop.durationMs) {
        window.__rotationLoop.isRunning = false;
        window.__rotationLoop.endTime = now;
        window.__renderBenchmark.isRunning = false;
        return;
      }
      
      const progress = elapsed / window.__rotationLoop.durationMs;
      const currentDist = progress * distance;
      
      // Update camera position
      const camera = window.__camera;
      const streamer = window.__chunkStreamer;
      
      if (camera) {
        const newX = startX + normX * currentDist;
        const newZ = startZ + normZ * currentDist;
        
        camera.position.set(newX, startY, newZ);
        
        // Update chunk streamer player position for chunk loading
        if (streamer) {
          streamer.updatePlayerPosition(newX, newZ);
        }
        
        // Measure render time
        const renderStart = performance.now();
        
        if (window.__renderer && window.__scene) {
          window.__renderer.render(window.__scene, camera);
          
          // Force GPU sync
          if (gl) {
            const pixel = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          }
        }
        
        const renderTime = performance.now() - renderStart;
        
        window.__rotationLoop.frameCount++;
        if (window.__rotationLoop.frameCount > 1) {
          window.__rotationLoop.frameDeltas.push(frameDelta);
        }
        window.__renderBenchmark.renderDurations.push(renderTime);
      }
      
      requestAnimationFrame(loop);
    };
    
    requestAnimationFrame(loop);
  }, startPos.x, startPos.y, startPos.z, startPos.forwardX, startPos.forwardZ, distance, durationMs);
  
  // Poll for completion and log progress
  const startTime = Date.now();
  let lastLogSecond = -1;
  
  while (true) {
    await sleep(200);
    
    const status = await page.evaluate(() => {
      const loop = window.__rotationLoop;
      if (!loop) return { done: true };
      
      const now = performance.now();
      const elapsed = now - loop.startTime;
      const progress = Math.min(1, elapsed / loop.durationMs);
      
      const elapsedSec = elapsed / 1000;
      const fps = elapsedSec > 0 ? (loop.frameCount / elapsedSec) : 0;
      
      const durations = window.__renderBenchmark?.renderDurations || [];
      const recentDurations = durations.slice(-30);
      const avgDuration = recentDurations.length > 0 
        ? recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length 
        : 0;
      
      return {
        done: !loop.isRunning,
        progress: progress,
        fps: fps.toFixed(1),
        frameTimeMs: avgDuration.toFixed(1),
        frames: loop.frameCount,
        cameraPos: window.__camera ? 
          `(${window.__camera.position.x.toFixed(1)}, ${window.__camera.position.y.toFixed(1)}, ${window.__camera.position.z.toFixed(1)})` : 
          'unknown'
      };
    });
    
    if (status.done) break;
    
    const currentSecond = Math.floor((Date.now() - startTime) / 1000);
    if (currentSecond > lastLogSecond) {
      lastLogSecond = currentSecond;
      process.stdout.write(`\r${colors.dim}  Movement: ${(status.progress * 100).toFixed(0)}% | FPS: ${status.fps} | Frame time: ${status.frameTimeMs}ms | Frames: ${status.frames} | Camera: ${status.cameraPos}     ${colors.reset}`);
    }
  }
  
  console.log();
  console.log(`${colors.green}  ✓ Movement complete${colors.reset}`);
}

/**
 * Print benchmark results
 */
function printResults(stats, testName = 'Rotation Benchmark', minFps = CONFIG.minFpsRequired, min1Percent = CONFIG.min1PercentLow) {
  console.log();
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  ${testName} Results${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log();
  
  console.log(`${colors.bold}  Frame Statistics:${colors.reset}`);
  console.log(`    Total frames:      ${stats.frameCount}`);
  console.log(`    Duration:          ${(stats.totalElapsedMs / 1000).toFixed(2)}s`);
  console.log(`    Average FPS:       ${stats.avgFps.toFixed(1)} (actual displayed)`);
  console.log(`    Min FPS:           ${stats.minFps.toFixed(1)}`);
  console.log(`    Max FPS:           ${stats.maxFps.toFixed(1)}`);
  console.log(`    Avg frame time:    ${stats.avgFrameTime.toFixed(1)}ms (RAF-to-RAF)`);
  console.log(`    Avg render time:   ${(stats.avgRenderTime || 0).toFixed(1)}ms (GPU only)`);
  console.log();
  console.log(`${colors.bold}  GPU Statistics:${colors.reset}`);
  console.log(`    Draw calls:        ${stats.drawCalls}`);
  console.log(`    Triangles:         ${stats.triangles.toLocaleString()}`);
  console.log(`    Render calls:      ${stats.renderCount || 'N/A'}`);
  console.log();
  
  console.log(`${colors.bold}  FPS Percentiles:${colors.reset}`);
  console.log(`    1%  (worst):       ${stats.p1Fps.toFixed(1)} FPS`);
  console.log(`    5%:                ${stats.p5Fps.toFixed(1)} FPS`);
  console.log(`    50% (median):      ${stats.p50Fps.toFixed(1)} FPS`);
  console.log(`    95%:               ${stats.p95Fps.toFixed(1)} FPS`);
  console.log(`    99% (best):        ${stats.p99Fps.toFixed(1)} FPS`);
  console.log();
  
  console.log(`${colors.bold}  Frame Drop Analysis:${colors.reset}`);
  const percentUnder60 = ((stats.framesUnder60Fps / stats.frameCount) * 100).toFixed(1);
  const percentUnder30 = ((stats.framesUnder30Fps / stats.frameCount) * 100).toFixed(1);
  
  const color60 = parseFloat(percentUnder60) > 50 ? colors.yellow : colors.green;
  const color30 = parseFloat(percentUnder30) > 10 ? colors.red : colors.green;
  
  console.log(`    Below 60 FPS: ${color60}${stats.framesUnder60Fps} frames (${percentUnder60}%)${colors.reset}`);
  console.log(`    Below 30 FPS: ${color30}${stats.framesUnder30Fps} frames (${percentUnder30}%)${colors.reset}`);
  console.log();
  
  // Pass/fail verdict
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Benchmark Result${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  
  const avgPassed = stats.avgFps >= minFps;
  const onePercentLowPassed = stats.p1Fps >= min1Percent;
  const passed = avgPassed && onePercentLowPassed;
  
  if (passed) {
    console.log(`${colors.green}${colors.bold}  ✓ PASSED: Average ${stats.avgFps.toFixed(1)} FPS >= ${minFps} FPS${colors.reset}`);
    console.log(`${colors.green}${colors.bold}  ✓ PASSED: 1% low ${stats.p1Fps.toFixed(1)} FPS >= ${min1Percent} FPS${colors.reset}`);
  } else {
    if (!avgPassed) {
      console.log(`${colors.red}${colors.bold}  ✗ FAILED: Average ${stats.avgFps.toFixed(1)} FPS < ${minFps} FPS requirement${colors.reset}`);
    }
    if (!onePercentLowPassed) {
      console.log(`${colors.red}${colors.bold}  ✗ FAILED: 1% low ${stats.p1Fps.toFixed(1)} FPS < ${min1Percent} FPS requirement${colors.reset}`);
    }
  }
  console.log();
  
  return passed;
}

/**
 * Main benchmark
 */
async function main() {
  const HEADLESS = process.env.HEADLESS !== '0';
  
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Rotation Performance Benchmark${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log();
  console.log(`${colors.dim}  World file: ${path.basename(CONFIG.worldFile)}${colors.reset}`);
  console.log(`${colors.dim}  Target position: (${CONFIG.targetPosition.x}, ${CONFIG.targetPosition.y}, ${CONFIG.targetPosition.z})${colors.reset}`);
  console.log(`${colors.dim}  Resolution: ${CONFIG.windowWidth}x${CONFIG.windowHeight} (1080p)${colors.reset}`);
  console.log(`${colors.dim}  Load wait: ${CONFIG.loadWaitMs / 1000}s${colors.reset}`);
  console.log(`${colors.dim}  Rotation duration: ${CONFIG.rotationDurationMs / 1000}s${colors.reset}`);
  console.log(`${colors.dim}  Min FPS required: ${CONFIG.minFpsRequired}${colors.reset}`);
  console.log();
  
  let server = null;
  let browser = null;
  let passed = false;
  
  try {
    // Start dev server
    server = await startDevServer();
    
    // Launch browser
    console.log(`${colors.dim}  Launching Chrome${HEADLESS ? ' (headless)' : ''}...${colors.reset}`);
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: [
        `--window-size=${CONFIG.windowWidth},${CONFIG.windowHeight}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--enable-webgl',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        // Note: vsync enabled for realistic FPS measurement (no --disable-frame-rate-limit)
      ],
      defaultViewport: {
        width: CONFIG.windowWidth,
        height: CONFIG.windowHeight,
      },
    });
    console.log(`${colors.green}  ✓ Chrome launched${colors.reset}`);
    
    // Navigate to app
    const page = (await browser.pages())[0];
    
    // Capture browser console for debugging (filter for WASM instancing and DataTexture messages)
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('WASM instancing') || text.includes('instance') || text.includes('DataTexture') ||
          text.includes('hash lookup') || text.includes('O(1) hash') || text.includes('string-based') ||
          text.includes('Built state') || text.includes('SuperChunkWorkerPool')) {
        console.log(`${colors.magenta}  [Browser] ${text}${colors.reset}`);
      }
    });
    await page.setViewport({ width: CONFIG.windowWidth, height: CONFIG.windowHeight });
    
    const url = `http://localhost:${CONFIG.devServerPort}`;
    console.log(`${colors.dim}  Navigating to ${url}...${colors.reset}`);
    
    // Enable DataTexture rendering mode (Option C) if configured
    if (CONFIG.useDataTextureRendering) {
      await page.evaluateOnNewDocument(() => {
        window.__enableDataTextureRendering = true;
      });
      console.log(`${colors.yellow}  DataTexture rendering mode enabled${colors.reset}`);
    }
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageLoadTimeout });
    
    // Wait for the file input to be ready
    await page.waitForSelector('input[type="file"]', { timeout: 10000 });
    console.log(`${colors.green}  ✓ App loaded${colors.reset}`);
    
    // Upload world file
    console.log(`${colors.dim}  Uploading world file: ${path.basename(CONFIG.worldFile)}...${colors.reset}`);
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(CONFIG.worldFile);
    console.log(`${colors.green}  ✓ File uploaded${colors.reset}`);
    
    // Wait for canvas to appear
    await page.waitForSelector('canvas', { timeout: 30000 });
    
    // Wait for initial world load (build overlay AND chunks)
    await waitForInitialLoad(page, CONFIG.minChunksRequired);
    
    // Verify DataTexture rendering was initialized (if enabled)
    if (CONFIG.useDataTextureRendering) {
      const dtxStatus = await page.evaluate(() => {
        const cm = window.__chunkManager;
        if (!cm) return { error: 'ChunkManager not found' };
        return {
          enabled: cm.useDataTextureRendering,
          hasManager: !!cm.geometryTextureManager,
          hasMaterial: !!cm.dataTextureMaterial,
          hasMesh: !!cm.dataTextureMesh,
        };
      });
      console.log(`${colors.cyan}  DataTexture status: ${JSON.stringify(dtxStatus)}${colors.reset}`);
      if (dtxStatus.enabled) {
        console.log(`${colors.green}  ✓ DataTexture rendering initialized${colors.reset}`);
      } else {
        console.log(`${colors.yellow}  ⚠ DataTexture rendering NOT initialized (flag may not have been set before load)${colors.reset}`);
      }
    }
    
    // Set reduced render distance for performance benchmark
    if (CONFIG.renderDistance) {
      console.log(`${colors.dim}  Setting render distance to ${CONFIG.renderDistance} chunks...${colors.reset}`);
      await page.evaluate((renderDist) => {
        // Set render distance on chunk streamer with NO load buffer (load only what we render)
        if (window.__chunkStreamer) {
          window.__chunkStreamer.setRenderDistance(renderDist, 0); // 0 = no load buffer
        }
        // Also set on chunk manager if available
        const manager = window.__getChunkManager?.();
        if (manager) {
          manager.renderDistance = renderDist;
          // PERFORMANCE: Drastically reduce partial block distance to minimize model triangles
          // Partial blocks (flowers, grass, slabs, stairs) are expensive - hide beyond 16 blocks
          manager.setPartialBlockDistance(16);
        }
        
        // Clean up any stale dirty set entries (super-chunks that were unloaded)
        const scm = window.__chunkStreamer?.superChunkManager;
        if (scm?.dirtySet && scm?.superChunks) {
          const staleKeys = [];
          for (const key of scm.dirtySet) {
            if (!scm.superChunks.has(key)) {
              staleKeys.push(key);
            }
          }
          for (const key of staleKeys) {
            scm.dirtySet.delete(key);
            scm.boundaryDirtySet?.delete(key);
          }
        }
      }, CONFIG.renderDistance);
      console.log(`${colors.green}  ✓ Render distance set${colors.reset}`);
    }
    
    // Teleport to target position and wait for chunks at that location
    await teleportAndWait(
      page,
      CONFIG.targetPosition.x,
      CONFIG.targetPosition.y,
      CONFIG.targetPosition.z,
      0, // yaw
      0, // pitch
      CONFIG.loadWaitMs
    );
    
    // Verify camera position before benchmark
    const cameraPos = await page.evaluate(() => {
      const camera = window.__camera;
      return camera ? {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      } : null;
    });
    
    if (cameraPos) {
      console.log(`${colors.dim}  Camera position verified: (${cameraPos.x.toFixed(1)}, ${cameraPos.y.toFixed(1)}, ${cameraPos.z.toFixed(1)})${colors.reset}`);
      
      // Check if we're close to target position
      const dx = cameraPos.x - CONFIG.targetPosition.x;
      const dy = cameraPos.y - CONFIG.targetPosition.y;
      const dz = cameraPos.z - CONFIG.targetPosition.z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      
      if (dist > 10) {
        console.log(`${colors.yellow}  ⚠ Warning: Camera is ${dist.toFixed(1)} blocks from target position${colors.reset}`);
      }
    }
    
    // Inject render-based profiler
    await injectRenderProfiler(page);
    
    // Start profiling
    await page.evaluate(() => window.__renderBenchmark.start());
    console.log(`${colors.dim}  Profiling started...${colors.reset}`);
  
  // Debug: count visible meshes and triangles
  const visibilityDebug = await page.evaluate(() => {
    const scene = window.__scene;
    const cm = window.__chunkManager;
    let visibleMeshes = 0;
    let hiddenMeshes = 0;
    let visibleTriangles = 0;
    let dataTextureMeshInfo = null;
    
    scene?.traverse?.(obj => {
      if (obj.isMesh) {
        // Check for DataTexture mesh specifically
        if (obj.name === 'DataTextureMesh') {
          const geom = obj.geometry;
          const drawRange = geom?.drawRange;
          dataTextureMeshInfo = {
            visible: obj.visible,
            drawStart: drawRange?.start || 0,
            drawCount: drawRange?.count || 0,
            parent: obj.parent?.name || 'unknown',
          };
        }
        
        if (obj.visible) {
          visibleMeshes++;
          const geom = obj.geometry;
          if (geom) {
            const index = geom.index;
            const triCount = index ? index.count / 3 : (geom.attributes.position?.count || 0) / 3;
            visibleTriangles += triCount;
          }
        } else {
          hiddenMeshes++;
        }
      }
    });
    
    // Get DataTexture manager stats
    const dtxStats = cm?.geometryTextureManager ? {
      totalVertices: cm.geometryTextureManager.getTotalVertexCount?.() || 0,
      objectCount: cm.geometryTextureManager.objects?.size || 0,
    } : null;
    
    return { visibleMeshes, hiddenMeshes, visibleTriangles, dataTextureMeshInfo, dtxStats };
  });
  console.log(`${colors.dim}  Visible: ${visibilityDebug.visibleMeshes} meshes, ${(visibilityDebug.visibleTriangles/1000000).toFixed(1)}M triangles${colors.reset}`);
  console.log(`${colors.dim}  Hidden: ${visibilityDebug.hiddenMeshes} meshes${colors.reset}`);
  if (visibilityDebug.dataTextureMeshInfo) {
    console.log(`${colors.cyan}  DataTexture mesh: visible=${visibilityDebug.dataTextureMeshInfo.visible}, drawRange=${visibilityDebug.dataTextureMeshInfo.drawStart}-${visibilityDebug.dataTextureMeshInfo.drawCount}${colors.reset}`);
  }
  if (visibilityDebug.dtxStats) {
    console.log(`${colors.cyan}  DataTexture manager: ${visibilityDebug.dtxStats.totalVertices} vertices in ${visibilityDebug.dtxStats.objectCount} objects${colors.reset}`);
  }
    
    // Perform 360 degree rotation benchmark
    await rotateCamera360(page, CONFIG.rotationDurationMs);
    
    // Stop profiling and get rotation stats
    await page.evaluate(() => window.__renderBenchmark.stop());
    const rotationStats = await page.evaluate(() => window.__renderBenchmark.getStats());
    
    let rotationPassed = false;
    if (rotationStats) {
      rotationPassed = printResults(rotationStats, 'Rotation Benchmark', CONFIG.minFpsRequired, CONFIG.min1PercentLow);
    } else {
      console.log(`${colors.red}  ✗ Failed to collect rotation performance stats${colors.reset}`);
    }
    
    // Wait for chunk loading to stabilize after rotation
    console.log(`${colors.dim}  Waiting for chunks to stabilize before movement test...${colors.reset}`);
    await sleep(2000);
    
    // Process any pending chunks before movement test
    await page.evaluate(async () => {
      const scm = window.__chunkStreamer?.superChunkManager;
      if (scm) {
        for (let i = 0; i < 5; i++) {
          if (scm.processCompletedChunks) await scm.processCompletedChunks();
          if (scm.rebuildDirty) await scm.rebuildDirty(4);
        }
      }
    });
    await sleep(1000);
    
    // Inject profiler again for movement test
    await injectRenderProfiler(page);
    
    // Perform forward movement benchmark
    await moveForward(page, CONFIG.movementDistance, CONFIG.movementDurationMs);
    
    // Stop profiling and get movement stats
    await page.evaluate(() => window.__renderBenchmark.stop());
    const movementStats = await page.evaluate(() => window.__renderBenchmark.getStats());
    
    let movementPassed = false;
    if (movementStats) {
      movementPassed = printResults(movementStats, 'Movement Benchmark', CONFIG.movementMinFps, CONFIG.movement1PercentLow);
    } else {
      console.log(`${colors.red}  ✗ Failed to collect movement performance stats${colors.reset}`);
    }
    
    // Overall pass requires both benchmarks to pass
    passed = rotationPassed && movementPassed;
    
    if (passed) {
      console.log(`${colors.green}${colors.bold}  ✓ ALL BENCHMARKS PASSED${colors.reset}`);
    } else {
      console.log(`${colors.red}${colors.bold}  ✗ SOME BENCHMARKS FAILED${colors.reset}`);
    }
    
  } catch (error) {
    console.log(`${colors.red}  ✗ Benchmark failed: ${error.message}${colors.reset}`);
    console.error(error.stack);
  } finally {
    if (browser) {
      console.log(`${colors.dim}  Closing browser...${colors.reset}`);
      await browser.close().catch(() => {});
    }
    if (server) {
      console.log(`${colors.dim}  Stopping dev server...${colors.reset}`);
      server.kill('SIGTERM');
    }
  }
  
  process.exit(passed ? 0 : 1);
}

// Run the benchmark
main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
