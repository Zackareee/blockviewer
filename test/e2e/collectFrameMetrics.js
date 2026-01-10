/**
 * Collect Frame Metrics - Measures per-frame GPU costs after loading
 * 
 * Usage:
 *   node test/e2e/collectFrameMetrics.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import {
  colors,
  DEFAULT_CONFIG,
  startDevServer,
  createDriver,
  waitForAppLoaded,
  uploadFile,
} from './TestRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const CONFIG = {
  ...DEFAULT_CONFIG,
  devServerPort: 5178,
  worldFile: path.join(PROJECT_ROOT, 'test', 'world_files', 'hermitcraft10.zip'),
  chunkLoadingSpeed: 8,
  renderDistance: 8,
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Frame Metrics Collection${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  let server = null;
  let driver = null;
  
  try {
    // Start dev server
    server = await startDevServer(CONFIG);
    
    // Create browser
    driver = await createDriver(false); // visible browser
    
    // Navigate to app
    const url = `http://localhost:${CONFIG.devServerPort}`;
    console.log(`${colors.dim}  Navigating to ${url}...${colors.reset}`);
    await driver.get(url);
    
    // Wait for app
    await waitForAppLoaded(driver);
    console.log(`${colors.green}  ✓ App loaded${colors.reset}`);
    
    // Upload file
    console.log(`${colors.dim}  Uploading world file...${colors.reset}`);
    await uploadFile(driver, CONFIG.worldFile);
    console.log(`${colors.green}  ✓ File uploaded${colors.reset}`);
    
    // Wait for loading to complete (build overlay disappears)
    console.log(`${colors.dim}  Waiting for loading to complete...${colors.reset}`);
    let loadComplete = false;
    const startTime = Date.now();
    while (!loadComplete && Date.now() - startTime < 120000) {
      const isLoading = await driver.executeScript(`
        const overlay = document.querySelector('.build-overlay');
        return overlay && overlay.offsetParent !== null;
      `);
      if (!isLoading) {
        // Wait a bit more for stability
        await sleep(2000);
        loadComplete = true;
      }
      await sleep(500);
    }
    console.log(`${colors.green}  ✓ Loading complete (${((Date.now() - startTime) / 1000).toFixed(1)}s)${colors.reset}`);
    
    // Wait for build overlay to disappear and scene to fully stabilize
    console.log(`${colors.dim}  Waiting for meshing to complete...${colors.reset}`);
    
    // Wait until no dirty chunks remain
    let lastMeshCount = 0;
    let stableFrames = 0;
    while (stableFrames < 10) {
      await sleep(1000);
      const currentMeshCount = await driver.executeScript(`
        return window.__chunkManager?.getStats()?.meshCount || 0;
      `);
      if (currentMeshCount === lastMeshCount && currentMeshCount > 0) {
        stableFrames++;
      } else {
        stableFrames = 0;
        lastMeshCount = currentMeshCount;
      }
      if (stableFrames === 0) {
        console.log(`${colors.dim}    Meshes: ${currentMeshCount}...${colors.reset}`);
      }
    }
    
    console.log(`${colors.green}  ✓ Scene stabilized (${lastMeshCount} meshes)${colors.reset}`);
    
    // Extra wait for any background tasks to finish
    await sleep(3000);
    
    // Collect metrics
    console.log(`${colors.dim}  Collecting metrics (5 second sample)...${colors.reset}`);
    
    const metrics = await driver.executeScript(`
      return new Promise(async (resolve) => {
        // Get initial render info
        const gl = window.__renderer;
        const initialInfo = gl.info;
        
        // Reset render info counters
        gl.info.reset();
        
        // Wait for frames to accumulate
        const frameTimes = [];
        let lastTime = performance.now();
        
        const sampleDuration = 5000; // 5 seconds
        const startTime = performance.now();
        
        function sampleFrame() {
          const now = performance.now();
          frameTimes.push(now - lastTime);
          lastTime = now;
          
          if (now - startTime < sampleDuration) {
            requestAnimationFrame(sampleFrame);
          } else {
            // Collect final metrics
            const info = gl.info;
            const stats = window.__chunkManager?.getStats() || {};
            
            // Calculate FPS stats
            const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
            const sorted = [...frameTimes].sort((a, b) => a - b);
            const p99FrameTime = sorted[Math.floor(sorted.length * 0.99)];
            
            resolve({
              // Frame stats
              frameCount: frameTimes.length,
              avgFps: (1000 / avgFrameTime).toFixed(1),
              avgFrameTime: avgFrameTime.toFixed(2),
              p99FrameTime: p99FrameTime.toFixed(2),
              minFps: (1000 / sorted[sorted.length - 1]).toFixed(1),
              
              // Render stats (per frame)
              drawCalls: info.render.calls,
              triangles: info.render.triangles,
              points: info.render.points,
              lines: info.render.lines,
              
              // Memory stats
              textures: info.memory.textures,
              geometries: info.memory.geometries,
              
              // Scene stats
              meshCount: stats.meshCount || 0,
              triangleCount: stats.triangleCount || 0,
              particleCount: stats.particleCount || 0,
              particleEmitters: stats.particleEmitters || 0,
              totalBlocks: stats.totalBlocks || 0,
            });
          }
        }
        
        requestAnimationFrame(sampleFrame);
      });
    `);
    
    // Print results
    console.log();
    console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}  FRAME METRICS RESULTS (Static Scene)${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log();
    
    console.log(`${colors.bold}  FRAME PERFORMANCE:${colors.reset}`);
    console.log(`    Frames sampled:    ${metrics.frameCount}`);
    console.log(`    Average FPS:       ${metrics.avgFps}`);
    console.log(`    Min FPS (1% low):  ${metrics.minFps}`);
    console.log(`    Avg frame time:    ${metrics.avgFrameTime}ms`);
    console.log(`    P99 frame time:    ${metrics.p99FrameTime}ms`);
    console.log();
    
    console.log(`${colors.bold}  GPU STATS (per frame):${colors.reset}`);
    console.log(`    Draw calls:        ${metrics.drawCalls}`);
    console.log(`    Triangles:         ${metrics.triangles.toLocaleString()}`);
    console.log(`    Points:            ${metrics.points}`);
    console.log(`    Lines:             ${metrics.lines}`);
    console.log();
    
    console.log(`${colors.bold}  MEMORY:${colors.reset}`);
    console.log(`    Textures:          ${metrics.textures}`);
    console.log(`    Geometries:        ${metrics.geometries}`);
    console.log();
    
    console.log(`${colors.bold}  SCENE:${colors.reset}`);
    console.log(`    Mesh count:        ${metrics.meshCount}`);
    console.log(`    Total triangles:   ${metrics.triangleCount.toLocaleString()}`);
    console.log(`    Total blocks:      ${metrics.totalBlocks.toLocaleString()}`);
    console.log(`    Particles:         ${metrics.particleCount}`);
    console.log(`    Emitters:          ${metrics.particleEmitters}`);
    console.log();
    
    // Analysis
    console.log(`${colors.bold}  ANALYSIS:${colors.reset}`);
    
    const fps = parseFloat(metrics.avgFps);
    const drawCalls = metrics.drawCalls;
    const triangles = metrics.triangles;
    
    if (fps < 30) {
      console.log(`${colors.red}    ⚠ LOW FPS (${fps}): Scene is too complex or GPU-bound${colors.reset}`);
    } else if (fps < 55) {
      console.log(`${colors.yellow}    ⚠ MODERATE FPS (${fps}): Some optimization may help${colors.reset}`);
    } else {
      console.log(`${colors.green}    ✓ Good FPS (${fps})${colors.reset}`);
    }
    
    if (drawCalls > 500) {
      console.log(`${colors.yellow}    ⚠ HIGH DRAW CALLS (${drawCalls}): Consider merging more geometry${colors.reset}`);
    }
    
    if (metrics.particleCount > 0) {
      console.log(`${colors.yellow}    ℹ PARTICLES ACTIVE: ${metrics.particleCount} particles updating every frame${colors.reset}`);
    }
    
    if (triangles > 2000000) {
      console.log(`${colors.yellow}    ⚠ HIGH TRIANGLE COUNT (${triangles.toLocaleString()}): GPU-intensive scene${colors.reset}`);
    }
    
    console.log();
    console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    
    // Exit after collecting metrics
    console.log(`${colors.dim}  Metrics collection complete.${colors.reset}`);
    
  } catch (error) {
    console.error(`${colors.red}  Error: ${error.message}${colors.reset}`);
    console.error(error.stack);
  } finally {
    if (driver) await driver.quit().catch(() => {});
    if (server) server.kill('SIGTERM');
  }
}

main();

