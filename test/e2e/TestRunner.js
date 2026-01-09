/**
 * E2E Test Runner - Base framework for regression and performance testing
 * 
 * Features:
 * - Headless and non-headless browser modes
 * - Screenshot comparison for regression testing
 * - Performance profiling integration
 * - Camera position API for deterministic screenshots
 * - World file loading (zip and mca)
 */

import { Builder, By, until, logging } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Colors for terminal output
export const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
};

// Default configuration
export const DEFAULT_CONFIG = {
  // Server
  devServerPort: 5175,
  devServerStartTimeout: 30000,
  
  // Timeouts
  pageLoadTimeout: 10000,
  renderTimeout: 180000, // 3 minutes for large worlds
  chunkLoadTimeout: 300000, // 5 minutes for streaming
  
  // Screenshot
  windowWidth: 1280,
  windowHeight: 900,
  pixelThreshold: 0.1,
  maxDiffPercentage: 1.0,
  
  // Directories
  baselineDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'baseline'),
  currentDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'current'),
  diffDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'diff'),
  
  // World files
  debugWorldPath: path.join(PROJECT_ROOT, 'test', 'world_files', 'debug_world.zip'),
  hermitcraftPath: path.join(PROJECT_ROOT, 'test-regions', 'hermitcraft10', 'hermitcraft10.zip'),
};

/**
 * Ensure test directories exist
 */
export function ensureDirectories(config = DEFAULT_CONFIG) {
  [config.baselineDir, config.currentDir, config.diffDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

/**
 * Start the Vite dev server
 */
export function startDevServer(config = DEFAULT_CONFIG) {
  return new Promise((resolve, reject) => {
    console.log(`${colors.dim}  Starting Vite dev server on port ${config.devServerPort}...${colors.reset}`);
    
    const server = spawn('npm', ['run', 'dev', '--', '--port', String(config.devServerPort)], {
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
    }, config.devServerStartTimeout);
    
    const checkOutput = (data) => {
      const output = data.toString();
      if (output.includes('Local:') || output.includes(`localhost:${config.devServerPort}`)) {
        started = true;
        clearTimeout(timeout);
        console.log(`${colors.green}  ✓ Dev server started on port ${config.devServerPort}${colors.reset}`);
        resolve(server);
      }
    };
    
    server.stdout.on('data', checkOutput);
    server.stderr.on('data', checkOutput);
    
    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    
    server.on('close', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });
  });
}

/**
 * Create a Chrome WebDriver instance
 * @param {boolean} headless - Run in headless mode
 * @param {object} config - Configuration
 */
export async function createDriver(headless = true, config = DEFAULT_CONFIG) {
  const options = new chrome.Options();
  
  if (headless) {
    options.addArguments('--headless=new');
  }
  
  // Chrome flags for WebGL support
  options.addArguments('--no-sandbox');
  options.addArguments('--disable-dev-shm-usage');
  options.addArguments('--disable-gpu-sandbox');
  options.addArguments('--enable-webgl');
  options.addArguments('--ignore-gpu-blocklist');
  options.addArguments(`--window-size=${config.windowWidth},${config.windowHeight}`);
  options.addArguments('--enable-gpu');
  options.addArguments('--use-gl=angle');
  options.addArguments('--use-angle=metal');
  
  // Enable logging
  const loggingPrefs = new logging.Preferences();
  loggingPrefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
  options.setLoggingPrefs(loggingPrefs);
  
  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();
  
  return driver;
}

/**
 * Wait for the app to load
 */
export async function waitForAppLoaded(driver, config = DEFAULT_CONFIG) {
  console.log(`${colors.dim}  Waiting for app to load...${colors.reset}`);
  
  await driver.wait(
    until.elementLocated(By.css('.app')),
    config.pageLoadTimeout,
    'App container not found'
  );
  
  await driver.wait(async () => {
    const emptyState = await driver.findElements(By.css('.empty-state'));
    const canvas = await driver.findElements(By.css('canvas'));
    return emptyState.length > 0 || canvas.length > 0;
  }, config.pageLoadTimeout, 'Neither empty state nor canvas found');
  
  console.log(`${colors.green}  ✓ App loaded${colors.reset}`);
}

/**
 * Wait for WebGL canvas to be present and sized
 */
export async function waitForCanvasRendered(driver, config = DEFAULT_CONFIG) {
  console.log(`${colors.dim}  Waiting for WebGL canvas...${colors.reset}`);
  
  const canvas = await driver.wait(
    until.elementLocated(By.css('canvas')),
    config.renderTimeout,
    'Canvas element not found'
  );
  
  await driver.wait(async () => {
    const width = await canvas.getAttribute('width');
    const height = await canvas.getAttribute('height');
    return parseInt(width) > 0 && parseInt(height) > 0;
  }, config.pageLoadTimeout, 'Canvas has zero dimensions');
  
  return canvas;
}

/**
 * Upload a file (region or world zip)
 * @param {object} driver - WebDriver instance
 * @param {string} filePath - Path to file
 * @param {string} fileType - 'region' (.mca/.mcr) or 'world' (.zip)
 */
export async function uploadFile(driver, filePath, fileType = 'auto') {
  const fileName = path.basename(filePath);
  console.log(`${colors.dim}  Uploading file: ${fileName}${colors.reset}`);
  
  // Determine file type
  if (fileType === 'auto') {
    if (filePath.endsWith('.zip')) {
      fileType = 'world';
    } else if (filePath.endsWith('.mca') || filePath.endsWith('.mcr')) {
      fileType = 'region';
    }
  }
  
  // Find the appropriate file input
  // World files use accept=".mca,.mcr,.zip", region files also use the same input
  let fileInput;
  if (fileType === 'world' || fileType === 'region') {
    fileInput = await driver.findElement(By.css('input[type="file"][accept=".mca,.mcr,.zip"]'));
  } else {
    // Fallback for other file types
    fileInput = await driver.findElement(By.css('input[type="file"][accept=".mca,.mcr,.zip"]'));
  }
  
  await fileInput.sendKeys(filePath);
  console.log(`${colors.green}  ✓ File uploaded${colors.reset}`);
}

/**
 * Select a dimension from the dimension picker modal
 * @param {object} driver - WebDriver instance
 * @param {string} dimensionId - Dimension to select: 'overworld', 'the_nether', 'the_end'
 * @param {number} timeout - Max time to wait for picker
 */
export async function selectDimension(driver, dimensionId = 'overworld', timeout = 30000) {
  console.log(`${colors.dim}  Waiting for dimension picker (up to ${timeout/1000}s)...${colors.reset}`);
  
  try {
    // Wait for dimension picker modal to appear
    const modal = await driver.wait(
      until.elementLocated(By.css('.dimension-picker-modal')),
      timeout,
      'Dimension picker not found'
    );
    
    // Wait for modal to be visible
    await driver.wait(until.elementIsVisible(modal), 5000);
    
    console.log(`${colors.dim}  Dimension picker detected, selecting ${dimensionId}...${colors.reset}`);
    
    // Find all dimension option buttons
    const dimensionButtons = await driver.findElements(By.css('.dimension-option'));
    console.log(`${colors.dim}  Found ${dimensionButtons.length} dimension options${colors.reset}`);
    
    for (const button of dimensionButtons) {
      // Get the dimension name text from the button
      const text = await button.getText();
      console.log(`${colors.dim}    - Option: "${text.replace(/\n/g, ' ')}"${colors.reset}`);
      
      // Match by dimension name (case insensitive)
      const textLower = text.toLowerCase();
      const isMatch = (
        (dimensionId === 'overworld' && textLower.includes('overworld')) ||
        (dimensionId === 'the_nether' && (textLower.includes('nether') || textLower.includes('dim-1'))) ||
        (dimensionId === 'the_end' && (textLower.includes('the end') || textLower.includes('dim1'))) ||
        textLower.includes(dimensionId.replace('_', ' '))
      );
      
      if (isMatch) {
        await button.click();
        console.log(`${colors.green}  ✓ Selected dimension: ${dimensionId}${colors.reset}`);
        // Wait a moment for the selection to process
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
      }
    }
    
    // If no match found, click the first option (usually overworld)
    if (dimensionButtons.length > 0) {
      await dimensionButtons[0].click();
      console.log(`${colors.yellow}  ⚠ Dimension ${dimensionId} not found, selected first option${colors.reset}`);
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    }
    
    console.log(`${colors.red}  ✗ No dimensions found in picker${colors.reset}`);
    return false;
  } catch (error) {
    // No dimension picker appeared - single dimension world or error
    console.log(`${colors.dim}  No dimension picker appeared (${error.message})${colors.reset}`);
    return false;
  }
}

/**
 * Wait for loading overlays to disappear
 */
export async function waitForLoadingComplete(driver, config = DEFAULT_CONFIG) {
  console.log(`${colors.dim}  Waiting for loading to complete...${colors.reset}`);
  
  // Wait for loading overlay to appear then disappear
  try {
    await driver.wait(async () => {
      const overlays = await driver.findElements(By.css('.loading-overlay, .build-overlay'));
      for (const overlay of overlays) {
        const displayed = await overlay.isDisplayed().catch(() => false);
        if (displayed) return true;
      }
      return false;
    }, 5000, 'Loading overlay never appeared');
  } catch {
    // Loading may have completed very fast
  }
  
  // Wait for loading overlay to disappear
  await driver.wait(async () => {
    const overlays = await driver.findElements(By.css('.loading-overlay, .build-overlay'));
    if (overlays.length === 0) return true;
    
    for (const overlay of overlays) {
      const displayed = await overlay.isDisplayed().catch(() => false);
      if (displayed) return false;
    }
    return true;
  }, config.renderTimeout, 'Loading overlay did not disappear');
  
  console.log(`${colors.green}  ✓ Loading complete${colors.reset}`);
}

/**
 * Enable chunk load logging in the browser
 */
export async function enableChunkLogging(driver) {
  await driver.executeScript(`
    if (window.__chunkLogger) {
      window.__chunkLogger.enable();
    }
  `);
}

/**
 * Get chunk loading stats from browser
 */
export async function getChunkLoadingStats(driver) {
  return await driver.executeScript(`
    if (window.__chunkLogger) {
      return window.__chunkLogger.getStats();
    }
    return null;
  `);
}

/**
 * Get performance profiler stats from browser
 */
export async function getProfilerStats(driver) {
  return await driver.executeScript(`
    if (window.__profiler) {
      return window.__profiler.getProcessBreakdown();
    }
    return null;
  `);
}

/**
 * Set camera position and rotation
 * @param {object} driver - WebDriver instance
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} z - Z position
 * @param {number} yaw - Yaw rotation in degrees
 * @param {number} pitch - Pitch rotation in degrees
 */
export async function setCamera(driver, x, y, z, yaw, pitch) {
  console.log(`${colors.dim}  Setting camera: (${x}, ${y}, ${z}) yaw=${yaw} pitch=${pitch}${colors.reset}`);
  
  await driver.executeScript(`
    const x = arguments[0], y = arguments[1], z = arguments[2];
    const yaw = arguments[3], pitch = arguments[4];
    
    // Access camera controls
    const controls = window.__cameraControls;
    const camera = window.__camera;
    
    if (!camera) {
      console.error('[Test] Camera not found');
      return false;
    }
    
    // Set position
    camera.position.set(x, y, z);
    
    // Set rotation (convert degrees to radians)
    const yawRad = yaw * Math.PI / 180;
    const pitchRad = pitch * Math.PI / 180;
    
    // Calculate look target from yaw and pitch
    const lookDist = 100;
    const targetX = x + Math.sin(yawRad) * Math.cos(pitchRad) * lookDist;
    const targetY = y + Math.sin(pitchRad) * lookDist;
    const targetZ = z + Math.cos(yawRad) * Math.cos(pitchRad) * lookDist;
    
    camera.lookAt(targetX, targetY, targetZ);
    
    // If using OrbitControls, update target
    if (controls && controls.target) {
      controls.target.set(targetX, targetY, targetZ);
      controls.update?.();
    }
    
    // Force render update
    if (window.__renderer) {
      window.__renderer.render(window.__scene, camera);
    }
    
    return true;
  `, x, y, z, yaw, pitch);
  
  // Wait for render to stabilize
  await new Promise(resolve => setTimeout(resolve, 500));
}

/**
 * Set camera field of view
 */
export async function setCameraFOV(driver, fov) {
  await driver.executeScript(`
    const camera = window.__camera;
    if (camera && camera.fov !== undefined) {
      camera.fov = arguments[0];
      camera.updateProjectionMatrix();
    }
  `, fov);
}

/**
 * Set render distance
 */
export async function setRenderDistance(driver, distance) {
  await driver.executeScript(`
    if (window.__chunkStreamer) {
      window.__chunkStreamer.setRenderDistance(arguments[0]);
    }
  `, distance);
}

/**
 * Set chunk loading speed
 */
export async function setChunkLoadingSpeed(driver, speed) {
  await driver.executeScript(`
    if (window.__chunkStreamer) {
      window.__chunkStreamer.setConcurrentChunks(arguments[0]);
    }
  `, speed);
}

/**
 * Set clouds enabled/disabled
 */
export async function setCloudsEnabled(driver, enabled) {
  await driver.executeScript(`
    if (window.__appSettings) {
      window.__appSettings.setCloudsEnabled(arguments[0]);
    }
  `, enabled);
}

/**
 * Set smooth lighting (ambient occlusion) enabled/disabled
 */
export async function setSmoothLighting(driver, enabled) {
  await driver.executeScript(`
    if (window.__appSettings) {
      window.__appSettings.setSmoothLighting(arguments[0]);
    }
  `, enabled);
}

/**
 * Set day/night cycle enabled/disabled
 * When disabled, time is frozen at noon
 */
export async function setDayNightCycle(driver, enabled) {
  await driver.executeScript(`
    if (window.__appSettings) {
      window.__appSettings.setDayNightCycle(arguments[0]);
    }
  `, enabled);
}

/**
 * Wait for a specific number of chunks to load
 */
export async function waitForChunksLoaded(driver, minChunks, timeoutMs = 300000) {
  console.log(`${colors.dim}  Waiting for ${minChunks} chunks to load...${colors.reset}`);
  
  const startTime = Date.now();
  
  await driver.wait(async () => {
    const stats = await driver.executeScript(`
      if (window.__chunkStreamer) {
        return {
          loaded: window.__chunkStreamer.loadedChunks.size,
          loading: window.__chunkStreamer.loadingChunks.size,
          queued: window.__chunkStreamer.loadQueue?.size || 0,
        };
      }
      return null;
    `);
    
    if (stats && stats.loaded >= minChunks) {
      console.log(`${colors.green}  ✓ ${stats.loaded} chunks loaded${colors.reset}`);
      return true;
    }
    
    // Progress update every 5 seconds
    if ((Date.now() - startTime) % 5000 < 1000 && stats) {
      console.log(`${colors.dim}    ... ${stats.loaded}/${minChunks} chunks loaded, ${stats.loading} loading, ${stats.queued} queued${colors.reset}`);
    }
    
    return false;
  }, timeoutMs, `Failed to load ${minChunks} chunks within timeout`);
}

/**
 * Take a screenshot
 * @returns {string} Path to screenshot file
 */
export async function takeScreenshot(driver, name, directory) {
  const screenshot = await driver.takeScreenshot();
  const filepath = path.join(directory, `${name}.png`);
  fs.writeFileSync(filepath, screenshot, 'base64');
  return filepath;
}

/**
 * Compare two PNG images
 * @returns {object} Comparison result
 */
export function compareScreenshots(baselinePath, currentPath, diffPath, config = DEFAULT_CONFIG) {
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  const current = PNG.sync.read(fs.readFileSync(currentPath));
  
  const { width, height } = baseline;
  
  if (current.width !== width || current.height !== height) {
    return {
      match: false,
      error: `Dimension mismatch: baseline ${width}x${height}, current ${current.width}x${current.height}`,
    };
  }
  
  const diff = new PNG({ width, height });
  
  const diffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    { threshold: config.pixelThreshold }
  );
  
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  
  const totalPixels = width * height;
  const diffPercentage = (diffPixels / totalPixels) * 100;
  
  return {
    match: diffPercentage <= config.maxDiffPercentage,
    diffPixels,
    diffPercentage,
    totalPixels,
  };
}

/**
 * Generate screenshot name from camera position
 */
export function screenshotName(x, y, z, yaw, pitch) {
  return `${x.toFixed(3)}_${y.toFixed(3)}_${z.toFixed(3)}_${yaw.toFixed(1)}_${pitch.toFixed(1)}`;
}

/**
 * Print test summary
 */
export function printSummary(results, mode = 'regression') {
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Test Summary${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const updated = results.filter(r => r.updated).length;
  
  if (mode === 'update') {
    console.log(`${colors.green}  ${updated} baseline(s) updated${colors.reset}`);
  } else {
    console.log(`${colors.green}  ${passed} passed${colors.reset}`);
    if (failed > 0) {
      console.log(`${colors.red}  ${failed} failed${colors.reset}`);
    }
  }
  
  console.log('');
  
  return failed === 0;
}

