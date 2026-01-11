/**
 * Regression Test Suite
 * 
 * Loads debug_world.zip and captures screenshots at defined camera positions.
 * Compares against baseline images for visual regression testing.
 * 
 * Usage:
 *   npm run test:regression                    # Run in headless mode
 *   npm run test:regression:update             # Update baseline screenshots
 *   HEADLESS=0 npm run test:regression         # Run with visible browser
 *   npm run test:regression -- --filter=glass  # Run only tests matching 'glass'
 * 
 * Prerequisites:
 *   - test/world_files/debug_world.zip must exist
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
  setCamera,
  setCameraFOV,
  setRenderDistance,
  setChunkLoadingSpeed,
  setCloudsEnabled,
  setSmoothLighting,
  setDayNightCycle,
  waitForChunksLoaded,
  takeScreenshot,
  compareScreenshots,
  printSummary,
} from './TestRunner.js';

import { testCases, defaultSettings } from './regressionTests.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Parse command line arguments
const UPDATE_BASELINE = process.argv.includes('--update');
const HEADLESS = process.env.HEADLESS !== '0';
const FILTER = process.argv.find(arg => arg.startsWith('--filter='))?.split('=')[1];

// Configuration
const CONFIG = {
  ...DEFAULT_CONFIG,
  devServerPort: 5176,
  baselineDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'baseline', 'regression'),
  currentDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'current', 'regression'),
  diffDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'diff', 'regression'),
  worldFile: path.join(PROJECT_ROOT, 'test', 'world_files', 'debug_world.zip'),
};

/**
 * Apply default settings to the browser
 */
async function applyDefaultSettings(driver) {
  const settings = defaultSettings();
  
  await setCameraFOV(driver, settings.fov);
  await setRenderDistance(driver, settings.renderDistance);
  await setChunkLoadingSpeed(driver, settings.chunkLoadingSpeed);
  
  // Apply visual settings
  if (settings.clouds !== undefined) {
    await setCloudsEnabled(driver, settings.clouds);
  }
  if (settings.smoothLighting !== undefined) {
    await setSmoothLighting(driver, settings.smoothLighting);
  }
  if (settings.dayNightCycle !== undefined) {
    await setDayNightCycle(driver, settings.dayNightCycle);
  }
  
  console.log(`${colors.dim}  Applied default settings: FOV=${settings.fov}, renderDistance=${settings.renderDistance}, clouds=${settings.clouds}, smoothLighting=${settings.smoothLighting}${colors.reset}`);
}

/**
 * Apply test-specific settings
 */
async function applyTestSettings(driver, testCase) {
  if (!testCase.settings) return;
  
  if (testCase.settings.fov) {
    await setCameraFOV(driver, testCase.settings.fov);
  }
  if (testCase.settings.renderDistance) {
    await setRenderDistance(driver, testCase.settings.renderDistance);
  }
  if (testCase.settings.chunkLoadingSpeed) {
    await setChunkLoadingSpeed(driver, testCase.settings.chunkLoadingSpeed);
  }
  if (testCase.settings.clouds !== undefined) {
    await setCloudsEnabled(driver, testCase.settings.clouds);
  }
  if (testCase.settings.smoothLighting !== undefined) {
    await setSmoothLighting(driver, testCase.settings.smoothLighting);
  }
  if (testCase.settings.dayNightCycle !== undefined) {
    await setDayNightCycle(driver, testCase.settings.dayNightCycle);
  }
}

/**
 * Run a single screenshot test
 */
async function runScreenshotTest(driver, testCase) {
  console.log(`\n${colors.cyan}▶ Test: ${testCase.name}${colors.reset}`);
  if (testCase.description) {
    console.log(`${colors.dim}  ${testCase.description}${colors.reset}`);
  }
  
  // Apply test-specific settings
  await applyTestSettings(driver, testCase);
  
  // Set camera position
  await setCamera(driver, testCase.x, testCase.y, testCase.z, testCase.yaw, testCase.pitch);
  
  // Extra wait if specified
  if (testCase.waitMs) {
    console.log(`${colors.dim}  Waiting ${testCase.waitMs}ms...${colors.reset}`);
    await new Promise(resolve => setTimeout(resolve, testCase.waitMs));
  }
  
  // Wait for render stabilization
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Flush any pending mesh creation to ensure all geometry is rendered
  await driver.executeScript(`
    if (window.__chunkStreamer && window.__chunkStreamer.flushMeshQueue) {
      return window.__chunkStreamer.flushMeshQueue();
    }
    return 0;
  `);
  
  // Wait a frame for GPU to update
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Take screenshot
  const currentPath = await takeScreenshot(driver, testCase.name, CONFIG.currentDir);
  console.log(`${colors.dim}  Screenshot: ${path.basename(currentPath)}${colors.reset}`);
  
  const baselinePath = path.join(CONFIG.baselineDir, `${testCase.name}.png`);
  const diffPath = path.join(CONFIG.diffDir, `${testCase.name}-diff.png`);
  
  if (UPDATE_BASELINE) {
    // Update baseline
    fs.copyFileSync(currentPath, baselinePath);
    console.log(`${colors.green}  ✓ Baseline updated${colors.reset}`);
    return { passed: true, updated: true, name: testCase.name };
  }
  
  // Check if baseline exists
  if (!fs.existsSync(baselinePath)) {
    console.log(`${colors.yellow}  ⚠ No baseline found. Run with --update to create one.${colors.reset}`);
    return { passed: false, noBaseline: true, name: testCase.name };
  }
  
  // Compare screenshots
  const result = compareScreenshots(baselinePath, currentPath, diffPath, CONFIG);
  
  if (result.error) {
    console.log(`${colors.red}  ✗ ${result.error}${colors.reset}`);
    return { passed: false, error: result.error, name: testCase.name };
  }
  
  if (result.match) {
    console.log(`${colors.green}  ✓ Match (${result.diffPercentage.toFixed(3)}% diff)${colors.reset}`);
    // Clean up diff image on success
    if (fs.existsSync(diffPath)) {
      fs.unlinkSync(diffPath);
    }
    return { passed: true, diffPercentage: result.diffPercentage, name: testCase.name };
  } else {
    console.log(`${colors.red}  ✗ Mismatch: ${result.diffPixels.toLocaleString()} pixels (${result.diffPercentage.toFixed(3)}%)${colors.reset}`);
    console.log(`${colors.dim}    Diff saved: ${diffPath}${colors.reset}`);
    return { passed: false, diffPercentage: result.diffPercentage, diffPath, name: testCase.name };
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Regression Test Suite${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  console.log(`${colors.dim}  Mode: ${UPDATE_BASELINE ? 'UPDATE BASELINE' : 'Compare against baseline'}${colors.reset}`);
  console.log(`${colors.dim}  Browser: ${HEADLESS ? 'Headless' : 'Visible'}${colors.reset}`);
  console.log(`${colors.dim}  World file: ${path.basename(CONFIG.worldFile)}${colors.reset}`);
  
  // Filter test cases
  let cases = testCases;
  if (FILTER) {
    cases = testCases.filter(tc => tc.name.includes(FILTER));
    console.log(`${colors.dim}  Filter: "${FILTER}" (${cases.length} tests)${colors.reset}`);
  } else {
    console.log(`${colors.dim}  Tests: ${cases.length}${colors.reset}`);
  }
  
  // Ensure directories
  ensureDirectories(CONFIG);
  
  // Check if world file exists
  if (!fs.existsSync(CONFIG.worldFile)) {
    console.log(`${colors.red}  ✗ World file not found: ${CONFIG.worldFile}${colors.reset}`);
    console.log(`${colors.dim}    Please add debug_world.zip to test/world_files/${colors.reset}`);
    process.exit(1);
  }
  
  let server = null;
  let driver = null;
  const results = [];
  
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
    
    // Upload world file (only once)
    await uploadFile(driver, CONFIG.worldFile, 'world');
    await waitForCanvasRendered(driver, CONFIG);
    await waitForLoadingComplete(driver, CONFIG);
    
    // Wait for chunks to load
    console.log(`${colors.dim}  Waiting for world to load...${colors.reset}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Apply default settings
    await applyDefaultSettings(driver);
    
    // Wait for chunks to stream in
    await waitForChunksLoaded(driver, 50, CONFIG.chunkLoadTimeout);
    
    // Run all test cases (world is already loaded)
    for (const testCase of cases) {
      try {
        const result = await runScreenshotTest(driver, testCase);
        results.push(result);
      } catch (error) {
        console.log(`${colors.red}  ✗ Test error: ${error.message}${colors.reset}`);
        results.push({ passed: false, error: error.message, name: testCase.name });
      }
    }
    
  } catch (error) {
    console.log(`${colors.red}  ✗ Fatal error: ${error.message}${colors.reset}`);
    console.log(`${colors.dim}    ${error.stack}${colors.reset}`);
    
    // Try to take failure screenshot
    if (driver) {
      try {
        await takeScreenshot(driver, 'failure', CONFIG.currentDir);
      } catch {
        // Ignore
      }
    }
    
    results.push({ passed: false, error: error.message });
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
  
  // Print summary
  const success = printSummary(results, UPDATE_BASELINE ? 'update' : 'regression');
  
  console.log(`${colors.dim}  Baseline: ${CONFIG.baselineDir}${colors.reset}`);
  console.log(`${colors.dim}  Current:  ${CONFIG.currentDir}${colors.reset}`);
  console.log(`${colors.dim}  Diff:     ${CONFIG.diffDir}${colors.reset}`);
  console.log('');
  
  process.exit(success ? 0 : 1);
}

// Run tests
runTests().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});

