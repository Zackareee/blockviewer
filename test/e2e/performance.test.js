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
  worldFile: path.join(PROJECT_ROOT, 'test-regions', 'hermitcraft_map', 'hermitcraft_map.zip'),
  chunkLoadingSpeed: 8, // Maximum speed
  renderDistance: 8,
  targetChunks: TARGET_CHUNKS,
  performanceTimeout: 600000, // 10 minutes max
};

/**
 * Monitor chunk loading and collect performance metrics
 */
async function monitorChunkLoading(driver, targetChunks, timeoutMs) {
  const startTime = Date.now();
  const samples = [];
  let lastChunkCount = 0;
  let lastSampleTime = startTime;
  
  console.log(`${colors.dim}  Monitoring chunk loading (target: ${targetChunks} chunks)...${colors.reset}`);
  
  while (Date.now() - startTime < timeoutMs) {
    // Get current chunk count
    const stats = await driver.executeScript(`
      if (window.__chunkStreamer) {
        return {
          loaded: window.__chunkStreamer.loadedChunks.size,
          loading: window.__chunkStreamer.loadingChunks.size,
          queued: window.__chunkStreamer.loadQueue?.size() || 0,
        };
      }
      return null;
    `);
    
    if (!stats) {
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    
    const now = Date.now();
    const elapsed = now - startTime;
    const sampleInterval = now - lastSampleTime;
    
    // Calculate chunks loaded in this interval
    const chunksLoaded = stats.loaded - lastChunkCount;
    const chunksPerSecond = chunksLoaded / (sampleInterval / 1000);
    
    samples.push({
      time: elapsed,
      loaded: stats.loaded,
      loading: stats.loading,
      queued: stats.queued,
      chunksPerSecond,
    });
    
    // Progress update
    if (samples.length % 10 === 0) {
      const avgRate = stats.loaded / (elapsed / 1000);
      console.log(`${colors.dim}    ${stats.loaded}/${targetChunks} chunks | ${avgRate.toFixed(2)} chunks/sec avg | ${stats.loading} loading | ${stats.queued} queued${colors.reset}`);
    }
    
    // Check if target reached
    if (stats.loaded >= targetChunks) {
      console.log(`${colors.green}  ✓ Target reached: ${stats.loaded} chunks in ${(elapsed / 1000).toFixed(1)}s${colors.reset}`);
      break;
    }
    
    // Check if loading stalled
    if (stats.loading === 0 && stats.queued === 0 && stats.loaded > 0) {
      console.log(`${colors.yellow}  ⚠ Loading complete (no more chunks available): ${stats.loaded} chunks${colors.reset}`);
      break;
    }
    
    lastChunkCount = stats.loaded;
    lastSampleTime = now;
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  const totalTime = Date.now() - startTime;
  const finalStats = await driver.executeScript(`
    if (window.__chunkStreamer) {
      return window.__chunkStreamer.loadedChunks.size;
    }
    return 0;
  `);
  
  return {
    totalChunks: finalStats,
    totalTimeMs: totalTime,
    chunksPerSecond: finalStats / (totalTime / 1000),
    samples,
  };
}

/**
 * Analyze performance results and detect bottlenecks
 */
function analyzePerformance(loadingStats, chunkStats, profilerStats) {
  const bottlenecks = [];
  
  // Check overall chunk loading rate
  if (loadingStats.chunksPerSecond < 4) {
    bottlenecks.push({
      category: 'CRITICAL',
      issue: 'Low chunk throughput',
      detail: `${loadingStats.chunksPerSecond.toFixed(2)} chunks/sec (target: 4+)`,
      recommendation: 'Check worker pool utilization and meshing pipeline',
    });
  } else if (loadingStats.chunksPerSecond < 6) {
    bottlenecks.push({
      category: 'WARNING',
      issue: 'Below optimal chunk throughput',
      detail: `${loadingStats.chunksPerSecond.toFixed(2)} chunks/sec (optimal: 6+)`,
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
  console.log(`${colors.bold}  SUMMARY:${colors.reset}`);
  console.log(`    Total Chunks Loaded: ${loadingStats.totalChunks}`);
  console.log(`    Total Time: ${(loadingStats.totalTimeMs / 1000).toFixed(2)}s`);
  console.log(`    Average Rate: ${colors.bold}${loadingStats.chunksPerSecond.toFixed(2)} chunks/sec${colors.reset}`);
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
  if (loadingStats.chunksPerSecond >= 6) {
    grade = 'EXCELLENT';
    gradeColor = colors.green;
  } else if (loadingStats.chunksPerSecond >= 4) {
    grade = 'GOOD';
    gradeColor = colors.green;
  } else if (loadingStats.chunksPerSecond >= 2) {
    grade = 'ACCEPTABLE';
    gradeColor = colors.yellow;
  } else {
    grade = 'POOR';
    gradeColor = colors.red;
  }
  
  console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`  Performance Grade: ${gradeColor}${colors.bold}${grade}${colors.reset}`);
  console.log(`  ${loadingStats.chunksPerSecond.toFixed(2)} chunks/second`);
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
    
    // Upload world file
    await uploadFile(driver, CONFIG.worldFile, 'world');
    await waitForCanvasRendered(driver, CONFIG);
    
    // Wait for initial loading overlay to clear
    await waitForLoadingComplete(driver, CONFIG);
    
    // Monitor chunk loading performance
    const loadingStats = await monitorChunkLoading(
      driver,
      CONFIG.targetChunks,
      CONFIG.performanceTimeout
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

