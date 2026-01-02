/**
 * E2E Navigation Performance Benchmark using Puppeteer
 * 
 * Loads region -1,-1 and measures FPS during camera movement
 * through a known problematic area with many partial blocks.
 * 
 * Usage:
 *   npm run test:nav-benchmark
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
  devServerPort: 5176,
  devServerStartTimeout: 30000,
  pageLoadTimeout: 60000,  // Increased for larger pages
  renderTimeout: 180000,
  
  // Test region
  testRegionPath: path.join(PROJECT_ROOT, 'test-regions', 'r.-1.-1.mca'),
  
  // Camera start position (problematic area with many partial blocks)
  startPosition: { x: -224.834, y: 74.628, z: -137.787 },
  startRotation: { yaw: -177.5, pitch: 18.1 },  // Facing north
  
  // Benchmark settings
  movementDurationMs: 15000,  // 15 seconds (reduced - area is very laggy)
  sampleIntervalMs: 100,
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
 * Wait for region to load
 */
async function waitForRegionLoaded(page) {
  console.log(`${colors.dim}  Waiting for region to load...${colors.reset}`);
  
  // Wait for either __chunkManagerStats (set after load) or __chunkManager (the manager itself)
  let loadStartTime = Date.now();
  
  await page.waitForFunction(
    () => {
      // Check multiple possible signals
      if (window.__chunkManagerStats && window.__chunkManagerStats.blocks > 0) return true;
      if (window.__chunkManager && window.__chunkManager.totalBlocks > 0) return true;
      // Check if loading overlay is gone
      const overlay = document.querySelector('.loading-overlay, .build-overlay');
      if (!overlay || overlay.style.display === 'none') {
        // No overlay AND we have a canvas means loading might be done
        const canvas = document.querySelector('canvas');
        if (canvas) return true;
      }
      return false;
    },
    { timeout: CONFIG.renderTimeout, polling: 1000 }
  );
  
  // Get stats from wherever available
  const stats = await page.evaluate(() => {
    if (window.__chunkManagerStats) return window.__chunkManagerStats;
    if (window.__chunkManager) {
      return {
        blocks: window.__chunkManager.totalBlocks || 0,
        triangles: 0,
      };
    }
    return { blocks: 0, triangles: 0 };
  });
  
  const loadTime = ((Date.now() - loadStartTime) / 1000).toFixed(1);
  console.log(`${colors.green}  ✓ Region loaded in ${loadTime}s: ${stats.blocks?.toLocaleString() || 0} blocks${colors.reset}`);
  
  return stats;
}

/**
 * Inject the performance profiler and start monitoring
 */
async function injectProfiler(page) {
  await page.evaluate(() => {
    window.__benchmarkData = {
      frameTimes: [],
      frameTimestamps: [],
      isRunning: false,
      lastFrameTime: 0,
      startTime: 0,
    };
    
    window.__benchmarkData.start = () => {
      window.__benchmarkData.frameTimes = [];
      window.__benchmarkData.frameTimestamps = [];
      window.__benchmarkData.isRunning = true;
      window.__benchmarkData.startTime = performance.now();
      window.__benchmarkData.lastFrameTime = performance.now();
      
      const monitor = (timestamp) => {
        if (!window.__benchmarkData.isRunning) return;
        
        const delta = timestamp - window.__benchmarkData.lastFrameTime;
        window.__benchmarkData.frameTimes.push(delta);
        window.__benchmarkData.frameTimestamps.push(timestamp - window.__benchmarkData.startTime);
        window.__benchmarkData.lastFrameTime = timestamp;
        
        requestAnimationFrame(monitor);
      };
      
      requestAnimationFrame(monitor);
    };
    
    window.__benchmarkData.stop = () => {
      window.__benchmarkData.isRunning = false;
    };
    
    window.__benchmarkData.getStats = () => {
      const times = window.__benchmarkData.frameTimes;
      if (times.length === 0) return null;
      
      const sorted = [...times].sort((a, b) => a - b);
      const sum = times.reduce((a, b) => a + b, 0);
      const avg = sum / times.length;
      
      const percentile = (p) => sorted[Math.floor(sorted.length * p)];
      
      // Get triangle counts
      let triangleCounts = null;
      if (window.__chunkManager) {
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
        triangleCounts = {
          solid: countTriangles(cm.solidMeshes),
          water: countTriangles(cm.waterMeshes),
          lava: countTriangles(cm.lavaMeshes),
          glass: countTriangles(cm.glassMeshes),
          model: countTriangles(cm.modelMeshes),
          transparentModel: countTriangles(cm.transparentModelMeshes),
          overlay: countTriangles(cm.overlayModelMeshes),
        };
      }
      
      // GPU info
      let gpuInfo = null;
      try {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
              gpuInfo = {
                vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
                renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
              };
            }
          }
        }
      } catch (e) {}
      
      return {
        frameCount: times.length,
        avgFrameTime: avg,
        avgFps: 1000 / avg,
        minFps: 1000 / sorted[sorted.length - 1],
        maxFps: 1000 / sorted[0],
        p1Fps: 1000 / percentile(0.99),
        p5Fps: 1000 / percentile(0.95),
        p50Fps: 1000 / percentile(0.50),
        p95Fps: 1000 / percentile(0.05),
        p99Fps: 1000 / percentile(0.01),
        framesUnder60Fps: times.filter(t => t > 16.67).length,
        framesUnder30Fps: times.filter(t => t > 33.33).length,
        framesUnder10Fps: times.filter(t => t > 100).length,
        framesUnder2Fps: times.filter(t => t > 500).length,
        framesUnder1Fps: times.filter(t => t > 1000).length,
        triangleCounts,
        gpuInfo,
        partialBlockDistance: window.__chunkManager?.getPartialBlockDistance?.() || 'unknown',
      };
    };
    
    console.log('[Benchmark] Profiler injected');
  });
}

/**
 * Run the navigation benchmark
 */
async function runNavigationBenchmark(page) {
  console.log(`${colors.cyan}${colors.bold}  Starting Navigation Benchmark${colors.reset}`);
  console.log(`${colors.dim}  Duration: ${CONFIG.movementDurationMs / 1000}s${colors.reset}`);
  console.log();
  
  // Inject profiler
  await injectProfiler(page);
  
  // Start profiling
  await page.evaluate(() => window.__benchmarkData.start());
  console.log(`${colors.dim}  Profiling started...${colors.reset}`);
  
  // Click on canvas to focus it
  const canvas = await page.$('canvas');
  if (canvas) {
    await canvas.click();
    await sleep(500);
  }
  
  // Hold W key to move forward
  await page.keyboard.down('w');
  console.log(`${colors.dim}  Moving forward (W key held)...${colors.reset}`);
  
  // Wait and log progress - with error handling for page crashes
  const startTime = Date.now();
  const endTime = startTime + CONFIG.movementDurationMs;
  let lastStats = null;
  let crashed = false;
  
  try {
    while (Date.now() < endTime) {
      const elapsed = Date.now() - startTime;
      const progress = ((elapsed / CONFIG.movementDurationMs) * 100).toFixed(0);
      
      // Get current FPS
      try {
        const currentStats = await page.evaluate(() => {
          const times = window.__benchmarkData.frameTimes.slice(-30);
          if (times.length === 0) return null;
          const avg = times.reduce((a, b) => a + b, 0) / times.length;
          return { 
            fps: (1000 / avg).toFixed(1), 
            frames: window.__benchmarkData.frameTimes.length 
          };
        });
        
        if (currentStats) {
          lastStats = currentStats;
          process.stdout.write(`\r${colors.dim}  Progress: ${progress}% | Current FPS: ${currentStats.fps} | Frames: ${currentStats.frames}     ${colors.reset}`);
        }
      } catch (evalError) {
        // Page might have crashed due to severe lag
        console.log(`\n${colors.yellow}  ⚠ Page became unresponsive (severe lag detected)${colors.reset}`);
        crashed = true;
        break;
      }
      
      await sleep(1000);
    }
  } catch (loopError) {
    console.log(`\n${colors.yellow}  ⚠ Benchmark interrupted: ${loopError.message}${colors.reset}`);
    crashed = true;
  }
  
  // Release W key
  try {
    await page.keyboard.up('w');
  } catch (e) {}
  console.log();
  
  // Stop profiling and get results
  let stats = null;
  try {
    await page.evaluate(() => window.__benchmarkData.stop());
    stats = await page.evaluate(() => window.__benchmarkData.getStats());
  } catch (e) {
    console.log(`${colors.yellow}  ⚠ Could not retrieve full stats (page crashed)${colors.reset}`);
    if (crashed && lastStats) {
      console.log(`${colors.dim}  Last recorded: ${lastStats.frames} frames, ~${lastStats.fps} FPS${colors.reset}`);
    }
  }
  
  return stats;
}

/**
 * Print benchmark results
 */
function printResults(stats) {
  console.log();
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Navigation Benchmark Results${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log();
  
  // GPU Info
  if (stats.gpuInfo) {
    console.log(`${colors.bold}  GPU:${colors.reset}`);
    console.log(`    Vendor:   ${stats.gpuInfo.vendor}`);
    console.log(`    Renderer: ${stats.gpuInfo.renderer}`);
    console.log();
  }
  
  // Settings
  console.log(`${colors.bold}  Settings:${colors.reset}`);
  console.log(`    Partial block distance: ${stats.partialBlockDistance} blocks`);
  console.log();
  
  // Triangle counts
  if (stats.triangleCounts) {
    console.log(`${colors.bold}  Triangle Counts:${colors.reset}`);
    const tc = stats.triangleCounts;
    console.log(`    Solid blocks:      ${tc.solid?.toLocaleString() || 0}`);
    console.log(`    Water:             ${tc.water?.toLocaleString() || 0}`);
    console.log(`    Glass/Leaves:      ${tc.glass?.toLocaleString() || 0}`);
    console.log(`    Model blocks:      ${tc.model?.toLocaleString() || 0}`);
    console.log(`    Transparent model: ${tc.transparentModel?.toLocaleString() || 0}`);
    console.log(`    Overlay:           ${tc.overlay?.toLocaleString() || 0}`);
    const total = Object.values(tc).reduce((a, b) => a + (b || 0), 0);
    console.log(`    ${colors.bold}Total:             ${total.toLocaleString()}${colors.reset}`);
    console.log();
  }
  
  // FPS Statistics
  console.log(`${colors.bold}  FPS Statistics:${colors.reset}`);
  console.log(`    Total frames:      ${stats.frameCount}`);
  console.log(`    Average FPS:       ${stats.avgFps.toFixed(1)}`);
  console.log(`    Min FPS:           ${stats.minFps.toFixed(1)}`);
  console.log(`    Max FPS:           ${stats.maxFps.toFixed(1)}`);
  console.log();
  
  // Percentiles
  console.log(`${colors.bold}  FPS Percentiles:${colors.reset}`);
  console.log(`    1%  (worst):       ${stats.p1Fps.toFixed(1)} FPS`);
  console.log(`    5%:                ${stats.p5Fps.toFixed(1)} FPS`);
  console.log(`    50% (median):      ${stats.p50Fps.toFixed(1)} FPS`);
  console.log(`    95%:               ${stats.p95Fps.toFixed(1)} FPS`);
  console.log(`    99% (best):        ${stats.p99Fps.toFixed(1)} FPS`);
  console.log();
  
  // Frame drop analysis
  console.log(`${colors.bold}  Frame Drop Analysis:${colors.reset}`);
  const percent = (count) => ((count / stats.frameCount) * 100).toFixed(1);
  
  const printDrop = (label, count, pct, warnThreshold, errorThreshold) => {
    let color = colors.green;
    if (parseFloat(pct) > errorThreshold) color = colors.red;
    else if (parseFloat(pct) > warnThreshold) color = colors.yellow;
    console.log(`    ${label}: ${color}${count} frames (${pct}%)${colors.reset}`);
  };
  
  printDrop('Below 60 FPS', stats.framesUnder60Fps, percent(stats.framesUnder60Fps), 30, 70);
  printDrop('Below 30 FPS', stats.framesUnder30Fps, percent(stats.framesUnder30Fps), 10, 30);
  printDrop('Below 10 FPS', stats.framesUnder10Fps, percent(stats.framesUnder10Fps), 1, 5);
  
  if (stats.framesUnder2Fps > 0) {
    console.log(`    ${colors.red}${colors.bold}Below 2 FPS:   ${stats.framesUnder2Fps} frames (SEVERE LAG)${colors.reset}`);
  }
  if (stats.framesUnder1Fps > 0) {
    console.log(`    ${colors.red}${colors.bold}Below 1 FPS:   ${stats.framesUnder1Fps} frames (FREEZES)${colors.reset}`);
  }
  console.log();
  
  // Summary
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Summary${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  
  const avgFps = stats.avgFps;
  const p1 = stats.p1Fps;
  
  if (avgFps >= 30 && p1 >= 10) {
    console.log(`${colors.green}  ✓ Performance: GOOD${colors.reset}`);
    console.log(`${colors.green}    Average ${avgFps.toFixed(0)} FPS, 1% low ${p1.toFixed(0)} FPS${colors.reset}`);
  } else if (avgFps >= 15 && p1 >= 5) {
    console.log(`${colors.yellow}  ⚠ Performance: POOR${colors.reset}`);
    console.log(`${colors.yellow}    Average ${avgFps.toFixed(0)} FPS, 1% low ${p1.toFixed(0)} FPS${colors.reset}`);
  } else {
    console.log(`${colors.red}  ✗ Performance: UNACCEPTABLE${colors.reset}`);
    console.log(`${colors.red}    Average ${avgFps.toFixed(0)} FPS, 1% low ${p1.toFixed(0)} FPS${colors.reset}`);
  }
  
  if (stats.framesUnder1Fps > 0) {
    console.log(`${colors.red}  ✗ Detected ${stats.framesUnder1Fps} freeze(s) (frames < 1 FPS)${colors.reset}`);
  }
  
  console.log();
  
  // Recommendations
  if (avgFps < 30 || p1 < 10) {
    console.log(`${colors.magenta}${colors.bold}  Recommendations:${colors.reset}`);
    
    if (stats.triangleCounts) {
      const modelTris = (stats.triangleCounts.model || 0) + 
                        (stats.triangleCounts.transparentModel || 0);
      if (modelTris > 500000) {
        console.log(`${colors.magenta}    - Model blocks (${modelTris.toLocaleString()} triangles) may be causing lag${colors.reset}`);
        console.log(`${colors.dim}      Try: window.__chunkManager.setPartialBlockDistance(32)${colors.reset}`);
        console.log(`${colors.dim}      Or:  window.__chunkManager.setGroupVisible("model", false)${colors.reset}`);
      }
    }
    
    console.log();
  }
}

/**
 * Main benchmark
 */
async function main() {
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Navigation Performance Benchmark${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log();
  console.log(`${colors.dim}  Region: r.-1.-1.mca${colors.reset}`);
  console.log(`${colors.dim}  Duration: ${CONFIG.movementDurationMs / 1000} seconds${colors.reset}`);
  console.log();
  
  let server = null;
  let browser = null;
  
  try {
    // Start dev server
    server = await startDevServer();
    
    // Launch browser
    console.log(`${colors.dim}  Launching Chrome...${colors.reset}`);
    browser = await puppeteer.launch({
      headless: false,  // Need real GPU for accurate metrics
      args: [
        '--window-size=1920,1080',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--enable-webgl',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--disable-frame-rate-limit',
        '--disable-gpu-vsync',
      ],
      defaultViewport: null,
    });
    console.log(`${colors.green}  ✓ Chrome launched${colors.reset}`);
    
    // Navigate to app
    const page = (await browser.pages())[0];
    const url = `http://localhost:${CONFIG.devServerPort}`;
    console.log(`${colors.dim}  Navigating to ${url}...${colors.reset}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageLoadTimeout });
    
    // Wait for the file input to be ready
    await page.waitForSelector('input[type="file"]', { timeout: 10000 });
    console.log(`${colors.green}  ✓ App loaded${colors.reset}`);
    
    // Enable Default Texture Pack
    console.log(`${colors.dim}  Enabling default texture pack...${colors.reset}`);
    try {
      // Click the Default Pack radio button
      await page.click('input[value="default"]');
      // Wait for texture pack to load (look for the loaded state)
      await sleep(3000);  // Give time for texture pack to load
      console.log(`${colors.green}  ✓ Default texture pack enabled${colors.reset}`);
    } catch (e) {
      console.log(`${colors.yellow}  ⚠ Could not enable default texture pack: ${e.message}${colors.reset}`);
    }
    
    // Upload region file
    console.log(`${colors.dim}  Uploading region file...${colors.reset}`);
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(CONFIG.testRegionPath);
    console.log(`${colors.green}  ✓ File uploaded${colors.reset}`);
    
    // Wait for region to load - check for canvas and stats
    console.log(`${colors.dim}  Waiting for region to load...${colors.reset}`);
    await page.waitForSelector('canvas', { timeout: 30000 });
    await waitForRegionLoaded(page);
    
    // Additional wait for scene to fully render
    console.log(`${colors.dim}  Waiting for scene to stabilize...${colors.reset}`);
    await sleep(5000);
    
    // Teleport to the problematic area using the command input in top right
    console.log(`${colors.dim}  Teleporting to problematic area...${colors.reset}`);
    const { x, y, z } = CONFIG.startPosition;
    const { yaw, pitch } = CONFIG.startRotation;
    const teleportCmd = `/teleport ${x} ${y} ${z} ${yaw} ${pitch}`;
    
    // Find the command input by its class
    const commandInput = await page.$('.command-input');
    if (commandInput) {
      // Click to focus, clear, and type the command
      await commandInput.click();
      await sleep(100);
      // Select all and delete existing text
      await page.keyboard.down('Meta');  // Cmd on Mac
      await page.keyboard.press('a');
      await page.keyboard.up('Meta');
      await page.keyboard.press('Backspace');
      // Type the teleport command
      await page.keyboard.type(teleportCmd, { delay: 10 });
      await page.keyboard.press('Enter');
      console.log(`${colors.green}  ✓ Teleported to (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) facing yaw=${yaw}° pitch=${pitch}°${colors.reset}`);
      await sleep(3000);  // Wait for teleport and scene update
    } else {
      console.log(`${colors.yellow}  ⚠ Could not find command input (.command-input)${colors.reset}`);
    }
    
    // Click on the canvas to give it focus for keyboard controls
    const canvas = await page.$('canvas');
    if (canvas) {
      await canvas.click();
      await sleep(500);
    }
    
    // Run the benchmark
    const stats = await runNavigationBenchmark(page);
    
    if (stats) {
      printResults(stats);
    } else {
      console.log(`${colors.red}  ✗ Failed to collect performance stats${colors.reset}`);
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
}

// Run the benchmark
main().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
