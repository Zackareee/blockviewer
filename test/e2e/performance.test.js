/**
 * Performance Test Suite
 * 
 * Loads hermitcraft_map.zip and measures chunk loading performance.
 * Uses chunk streaming with maximum speed to test throughput.
 * 
 * Features:
 * - Chunk loading rate measurement (chunks/second)
 * - Process timing breakdown (decompress, parse, mesh, etc.)
 * - Bottleneck detection
 * - FPS monitoring during loading
 * 
 * Usage:
 *   npm run test:performance                    # Run in headless mode
 *   HEADLESS=0 npm run test:performance         # Run with visible browser
 * 
 * Prerequisites:
 *   - test-regions/hermitcraft_map/hermitcraft_map.zip must exist
 *   - Chrome browser installed
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import {
  colors,
  DEFAULT_CONFIG,
  ensureDirectories,
  startDevServer,
  createDriver,
  waitForAppLoaded,
  waitForCanvasRendered,
  uploadFile,
  waitForLoadingComplete,
  setRenderDistance,
  setChunkLoadingSpeed,
  enableChunkLogging,
  getChunkLoadingStats,
  getProfilerStats,
} from './TestRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Parse command line arguments
const HEADLESS = process.env.HEADLESS !== '0';
const TARGET_CHUNKS = parseInt(process.env.TARGET_CHUNKS || '100', 10);

// Configuration
const CONFIG = {
  ...DEFAULT_CONFIG,
  devServerPort: 5177,
  worldFile: path.join(PROJECT_ROOT, 'test', 'world_files', 'hermitcraft10.zip'),
  chunkLoadingSpeed: 8, // Maximum speed
  renderDistance: 8,
  targetChunks: TARGET_CHUNKS,
  performanceTimeout: 600000, // 10 minutes max
};

/**
 * Monitor chunk loading and collect performance metrics
 * Waits for the build overlay to disappear (indicates loading is complete)
 * @param {object} driver - WebDriver instance
 * @param {number} timeoutMs - Maximum time to wait
 * @param {number} uploadStartTime - Timestamp when file upload started (for E2E timing)
 */
async function monitorChunkLoading(driver, timeoutMs, uploadStartTime) {
  const samples = [];
  let lastChunkCount = 0;
  let lastSampleTime = Date.now();
  let firstChunkTime = null;
  let loadingCompleteTime = null;
  let loadingZeroSince = null; // When loading first became 0
  const STABLE_MS = 500; // Consider complete after 500ms with loading=0
  
  console.log(`${colors.dim}  Monitoring chunk loading...${colors.reset}`);
  
  const monitorStartTime = Date.now();
  
  while (Date.now() - monitorStartTime < timeoutMs) {
    const now = Date.now();
    const elapsedFromUpload = now - uploadStartTime;
    
    // Check if build overlay is visible and get stats
    const overlayState = await driver.executeScript(`
      const overlay = document.querySelector('.build-overlay');
      const isVisible = overlay && overlay.offsetParent !== null;
      
      let stats = null;
      if (window.__chunkStreamer) {
        const superChunkCount = window.__chunkStreamer.superChunkManager?.superChunks?.size || 0;
        stats = {
          loaded: window.__chunkStreamer.loadedChunks.size,
          loading: window.__chunkStreamer.loadingChunks.size,
          superChunks: superChunkCount,
        };
      }
      
      return { isVisible, stats };
    `);
    
    const { isVisible, stats } = overlayState;
    
    if (stats) {
      const sampleInterval = now - lastSampleTime;
      
      // Track first chunk time
      if (stats.loaded > 0 && firstChunkTime === null) {
        firstChunkTime = elapsedFromUpload;
        console.log(`${colors.dim}    First chunk loaded at ${(firstChunkTime / 1000).toFixed(2)}s${colors.reset}`);
      }
      
      // Calculate chunks loaded in this interval
      const chunksLoaded = stats.loaded - lastChunkCount;
      const chunksPerSecond = sampleInterval > 0 ? chunksLoaded / (sampleInterval / 1000) : 0;
      
      samples.push({
        time: elapsedFromUpload,
        loaded: stats.loaded,
        loading: stats.loading,
        superChunks: stats.superChunks,
        chunksPerSecond,
      });
      
      // Progress update every 2 seconds
      if (samples.length % 20 === 0 || (samples.length % 5 === 0 && stats.loaded < 50)) {
        const avgRate = elapsedFromUpload > 0 ? stats.superChunks / (elapsedFromUpload / 1000) : 0;
        console.log(`${colors.dim}    ${stats.superChunks} super-chunks (${stats.loaded} chunks) | ${(elapsedFromUpload / 1000).toFixed(1)}s | ${avgRate.toFixed(1)} meshes/sec${colors.reset}`);
      }
      
      lastChunkCount = stats.loaded;
      lastSampleTime = now;
    }
    
    // Loading complete when build overlay disappears
    if (!isVisible && stats && stats.loaded > 0) {
      if (loadingZeroSince === null) {
        loadingZeroSince = now;
      } else if (now - loadingZeroSince >= STABLE_MS) {
        loadingCompleteTime = elapsedFromUpload - STABLE_MS;
        console.log(`${colors.green}  ✓ Loading complete: ${stats.superChunks} super-chunks (${stats.loaded} chunks) in ${(loadingCompleteTime / 1000).toFixed(2)}s${colors.reset}`);
        break;
      }
    } else {
      loadingZeroSince = null;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100)); // Poll every 100ms for accuracy
  }
  
  const finalStats = await driver.executeScript(`
    if (window.__chunkStreamer) {
      return {
        chunks: window.__chunkStreamer.loadedChunks.size,
        superChunks: window.__chunkStreamer.superChunkManager?.superChunks?.size || 0,
      };
    }
    return { chunks: 0, superChunks: 0 };
  `);
  
  const totalE2ETime = loadingCompleteTime || (Date.now() - uploadStartTime);
  
  return {
    totalChunks: finalStats.chunks,
    totalSuperChunks: finalStats.superChunks,
    totalTimeMs: totalE2ETime,
    meshesPerSecond: totalE2ETime > 0 ? finalStats.superChunks / (totalE2ETime / 1000) : 0,
    firstChunkTimeMs: firstChunkTime,
    samples,
  };
}

/**
 * Analyze performance results and detect bottlenecks
 */
function analyzePerformance(loadingStats, chunkStats, profilerStats) {
  const bottlenecks = [];
  
  // Check overall chunk loading rate
  if (loadingStats.meshesPerSecond < 1) {
    bottlenecks.push({
      category: 'CRITICAL',
      issue: 'Low mesh throughput',
      detail: `${loadingStats.meshesPerSecond.toFixed(2)} meshes/sec (target: 1+)`,
      recommendation: 'Check worker pool utilization and meshing pipeline',
    });
  } else if (loadingStats.meshesPerSecond < 1.5) {
    bottlenecks.push({
      category: 'WARNING',
      issue: 'Below optimal mesh throughput',
      detail: `${loadingStats.meshesPerSecond.toFixed(2)} meshes/sec (optimal: 1.5+)`,
      recommendation: 'Consider increasing worker count or batch size',
    });
  }
  
  // Check process timing if available
  if (chunkStats?.processTiming) {
    const pt = chunkStats.processTiming;
    
    if (pt.meshing?.avg > 50) {
      bottlenecks.push({
        category: 'WARNING',
        issue: 'Slow meshing',
        detail: `Average ${pt.meshing.avg.toFixed(1)}ms per super-chunk`,
        recommendation: 'Meshing is the bottleneck - check greedy mesher performance',
      });
    }
    
    if (pt.decompress?.avg > 20) {
      bottlenecks.push({
        category: 'INFO',
        issue: 'Decompression overhead',
        detail: `Average ${pt.decompress.avg.toFixed(1)}ms per chunk`,
        recommendation: 'Consider native DecompressionStream if available',
      });
    }
  }
  
  return bottlenecks;
}

/**
 * Print performance report
 */
function printPerformanceReport(loadingStats, chunkStats, profilerStats, bottlenecks) {
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  PERFORMANCE TEST RESULTS${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
  
  // Summary
  console.log(`${colors.bold}  E2E TIMING (from file upload to load complete):${colors.reset}`);
  console.log(`    Super-chunks Meshed: ${loadingStats.totalSuperChunks} (${loadingStats.totalChunks} chunks)`);
  console.log(`    Time to First Chunk: ${loadingStats.firstChunkTimeMs ? (loadingStats.firstChunkTimeMs / 1000).toFixed(2) + 's' : 'N/A'}`);
  console.log(`    Total E2E Time: ${colors.bold}${(loadingStats.totalTimeMs / 1000).toFixed(2)}s${colors.reset}`);
  console.log(`    Average Rate: ${colors.bold}${loadingStats.meshesPerSecond.toFixed(2)} meshes/sec${colors.reset}`);
  console.log();
  
  // Process timing breakdown
  if (chunkStats?.processTiming) {
    console.log(`${colors.bold}  PROCESS TIMING BREAKDOWN:${colors.reset}`);
    const pt = chunkStats.processTiming;
    
    const formatStat = (name, stat) => {
      if (!stat || stat.count === 0) return `    ${name}: (no data)`;
      return `    ${name}: avg ${stat.avg.toFixed(1)}ms | p95 ${stat.p95.toFixed(1)}ms | max ${stat.max.toFixed(1)}ms (${stat.count} samples)`;
    };
    
    console.log(formatStat('Total per chunk', pt.total));
    console.log(formatStat('Meshing', pt.meshing));
    console.log(formatStat('Decompress', pt.decompress));
    console.log(formatStat('NBT Parse', pt.nbtParse));
    console.log(formatStat('Decode', pt.decode));
    console.log(formatStat('Mesh Creation', pt.meshCreation));
    console.log();
  }
  
  // Bottleneck analysis
  console.log(`${colors.bold}  BOTTLENECK ANALYSIS:${colors.reset}`);
  if (bottlenecks.length === 0) {
    console.log(`${colors.green}    ✓ No significant bottlenecks detected${colors.reset}`);
  } else {
    for (const b of bottlenecks) {
      const color = b.category === 'CRITICAL' ? colors.red : 
                    b.category === 'WARNING' ? colors.yellow : colors.dim;
      console.log(`${color}    ${b.category}: ${b.issue}${colors.reset}`);
      console.log(`${colors.dim}      ${b.detail}${colors.reset}`);
      console.log(`${colors.dim}      → ${b.recommendation}${colors.reset}`);
    }
  }
  console.log();
  
  // Performance grade
  let grade, gradeColor;
  // Grade based on meshes per second (super-chunks)
  if (loadingStats.meshesPerSecond >= 2) {
    grade = 'EXCELLENT';
    gradeColor = colors.green;
  } else if (loadingStats.meshesPerSecond >= 1.5) {
    grade = 'GOOD';
    gradeColor = colors.green;
  } else if (loadingStats.meshesPerSecond >= 1) {
    grade = 'ACCEPTABLE';
    gradeColor = colors.yellow;
  } else {
    grade = 'POOR';
    gradeColor = colors.red;
  }
  
  console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`  Performance Grade: ${gradeColor}${colors.bold}${grade}${colors.reset}`);
  console.log(`  ${loadingStats.meshesPerSecond.toFixed(2)} meshes/second`);
  console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
  
  return grade !== 'POOR';
}

/**
 * Main test runner
 */
async function runTests() {
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Performance Test Suite${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  console.log(`${colors.dim}  Browser: ${HEADLESS ? 'Headless' : 'Visible'}${colors.reset}`);
  console.log(`${colors.dim}  World file: ${path.basename(CONFIG.worldFile)}${colors.reset}`);
  console.log(`${colors.dim}  Chunk loading speed: ${CONFIG.chunkLoadingSpeed} (maximum)${colors.reset}`);
  console.log(`${colors.dim}  Target chunks: ${CONFIG.targetChunks}${colors.reset}`);
  
  // Ensure directories
  ensureDirectories(CONFIG);
  
  // Check if world file exists
  if (!fs.existsSync(CONFIG.worldFile)) {
    console.log(`${colors.red}  ✗ World file not found: ${CONFIG.worldFile}${colors.reset}`);
    process.exit(1);
  }
  
  let server = null;
  let driver = null;
  let success = false;
  
  try {
    // Start dev server
    server = await startDevServer(CONFIG);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Create WebDriver
    console.log(`${colors.dim}  Launching Chrome (${HEADLESS ? 'headless' : 'visible'})...${colors.reset}`);
    driver = await createDriver(HEADLESS, CONFIG);
    console.log(`${colors.green}  ✓ Chrome launched${colors.reset}`);
    
    // Navigate to app
    const url = `http://localhost:${CONFIG.devServerPort}`;
    console.log(`${colors.dim}  Navigating to ${url}...${colors.reset}`);
    await driver.get(url);
    
    // Wait for app to load
    await waitForAppLoaded(driver, CONFIG);
    
    // Enable chunk logging before loading world
    await enableChunkLogging(driver);
    
    // Set chunk loading speed to maximum (8)
    await setChunkLoadingSpeed(driver, CONFIG.chunkLoadingSpeed);
    await setRenderDistance(driver, CONFIG.renderDistance);
    
    console.log(`${colors.green}  ✓ Settings applied: speed=${CONFIG.chunkLoadingSpeed}, renderDistance=${CONFIG.renderDistance}${colors.reset}`);
    
    // Start E2E timer before uploading
    const uploadStartTime = Date.now();
    console.log(`${colors.dim}  Starting E2E timer...${colors.reset}`);
    
    // Upload world file
    await uploadFile(driver, CONFIG.worldFile, 'world');
    
    // Wait for canvas to appear (indicates world is being processed)
    await waitForCanvasRendered(driver, CONFIG);
    
    // Monitor chunk loading until build overlay disappears (loading complete)
    const loadingStats = await monitorChunkLoading(
      driver,
      CONFIG.performanceTimeout,
      uploadStartTime
    );
    
    // Get chunk loading stats from browser
    const chunkStats = await getChunkLoadingStats(driver);
    
    // Get profiler stats
    const profilerStats = await getProfilerStats(driver);
    
    // Analyze performance
    const bottlenecks = analyzePerformance(loadingStats, chunkStats, profilerStats);
    
    // Print report
    success = printPerformanceReport(loadingStats, chunkStats, profilerStats, bottlenecks);
    
    // Export results to JSON
    const results = {
      timestamp: new Date().toISOString(),
      config: {
        worldFile: path.basename(CONFIG.worldFile),
        chunkLoadingSpeed: CONFIG.chunkLoadingSpeed,
        renderDistance: CONFIG.renderDistance,
        headless: HEADLESS,
      },
      loadingStats,
      chunkStats,
      profilerStats,
      bottlenecks,
      success,
    };
    
    const resultsPath = path.join(PROJECT_ROOT, 'test', 'e2e', 'performance-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`${colors.dim}  Results saved to: ${resultsPath}${colors.reset}`);
    
  } catch (error) {
    console.log(`${colors.red}  ✗ Fatal error: ${error.message}${colors.reset}`);
    console.log(`${colors.dim}    ${error.stack}${colors.reset}`);
  } finally {
    // Cleanup
    if (driver) {
      console.log(`${colors.dim}  Closing browser...${colors.reset}`);
      await driver.quit();
    }
    
    if (server) {
      console.log(`${colors.dim}  Stopping dev server...${colors.reset}`);
      server.kill('SIGTERM');
    }
  }
  
  process.exit(success ? 0 : 1);
}

// Run tests
runTests().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});

