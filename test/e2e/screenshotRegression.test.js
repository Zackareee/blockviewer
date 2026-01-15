/**
 * E2E Screenshot Regression Test
 * 
 * Uses Selenium WebDriver in headless mode to capture screenshots
 * and compare them against baseline images for visual regression testing.
 * 
 * Prerequisites:
 * - Chrome browser installed
 * - npm install (includes chromedriver, selenium-webdriver, pixelmatch, pngjs)
 * 
 * Usage:
 *   npm run test:e2e:regression          # Run regression test
 *   npm run test:e2e:update-baseline     # Update baseline screenshots
 */

import { Builder, By, until, logging } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

// Re-export chrome logging for convenience
chrome.logging = logging;

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
};

// Test configuration
const CONFIG = {
  // Vite dev server
  devServerPort: 5174, // Use different port from main e2e tests
  devServerStartTimeout: 30000,
  
  // Test timeouts
  pageLoadTimeout: 10000,
  renderTimeout: 120000, // 2 minutes for large regions
  
  // Test region file
  testRegionPath: path.join(PROJECT_ROOT, 'test-regions', 'r.-1.0.mca'),
  
  // Screenshot directories
  baselineDir: path.join(PROJECT_ROOT, 'test', 'screenshots', 'baseline'),
  currentDir: path.join(PROJECT_ROOT, 'test', 'screenshots', 'current'),
  diffDir: path.join(PROJECT_ROOT, 'test', 'screenshots', 'diff'),
  
  // Comparison threshold (0 = exact match, higher = more tolerance)
  // Pixel difference threshold (0-1 where 0 is exact and 1 is completely different)
  pixelThreshold: 0.1,
  // Maximum percentage of different pixels allowed before test fails
  maxDiffPercentage: 1.0, // Allow 1% difference for anti-aliasing variations
  
  // Screenshot size
  windowWidth: 1280,
  windowHeight: 900,
};

// Parse command line arguments
const UPDATE_BASELINE = process.argv.includes('--update');

/**
 * Ensure directories exist
 */
function ensureDirectories() {
  [CONFIG.baselineDir, CONFIG.currentDir, CONFIG.diffDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

/**
 * Clean diff and current directories before running tests
 */
function cleanTestDirectories() {
  [CONFIG.currentDir, CONFIG.diffDir].forEach(dir => {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  });
}

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
    
    server.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Local:') || output.includes(`localhost:${CONFIG.devServerPort}`)) {
        started = true;
        clearTimeout(timeout);
        console.log(`${colors.green}  ✓ Dev server started on port ${CONFIG.devServerPort}${colors.reset}`);
        resolve(server);
      }
    });
    
    server.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Local:') || output.includes(`localhost:${CONFIG.devServerPort}`)) {
        started = true;
        clearTimeout(timeout);
        console.log(`${colors.green}  ✓ Dev server started on port ${CONFIG.devServerPort}${colors.reset}`);
        resolve(server);
      }
    });
    
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
 * Create a Chrome WebDriver instance in headless mode
 */
async function createDriver() {
  const options = new chrome.Options();
  
  // Always run headless for regression tests
  options.addArguments('--headless=new');
  
  // Chrome flags for WebGL support in headless mode
  options.addArguments('--no-sandbox');
  options.addArguments('--disable-dev-shm-usage');
  options.addArguments('--disable-gpu-sandbox');
  options.addArguments('--enable-webgl');
  options.addArguments('--ignore-gpu-blocklist');
  options.addArguments(`--window-size=${CONFIG.windowWidth},${CONFIG.windowHeight}`);
  
  // Use GPU for proper WebGL rendering (don't use swiftshader for Three.js)
  options.addArguments('--enable-gpu');
  options.addArguments('--use-gl=angle');
  options.addArguments('--use-angle=metal'); // Use Metal on macOS for better WebGL support
  
  // Enable logging to capture console
  const loggingPrefs = new chrome.logging.Preferences();
  loggingPrefs.setLevel('browser', 'ALL');
  options.setLoggingPrefs(loggingPrefs);
  
  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();
  
  return driver;
}

/**
 * Wait for the app to load (React has rendered)
 */
async function waitForAppLoaded(driver) {
  console.log(`${colors.dim}  Waiting for app to load...${colors.reset}`);
  
  await driver.wait(
    until.elementLocated(By.css('.app')),
    CONFIG.pageLoadTimeout,
    'App container not found'
  );
  
  await driver.wait(async () => {
    const emptyState = await driver.findElements(By.css('.empty-state'));
    const canvas = await driver.findElements(By.css('canvas'));
    return emptyState.length > 0 || canvas.length > 0;
  }, CONFIG.pageLoadTimeout, 'Neither empty state nor canvas found');
  
  console.log(`${colors.green}  ✓ App loaded${colors.reset}`);
}

/**
 * Wait for the WebGL canvas to be present
 */
async function waitForCanvasRendered(driver) {
  console.log(`${colors.dim}  Waiting for WebGL canvas...${colors.reset}`);
  
  const canvas = await driver.wait(
    until.elementLocated(By.css('canvas')),
    CONFIG.renderTimeout,
    'Canvas element not found after file upload'
  );
  
  await driver.wait(async () => {
    const width = await canvas.getAttribute('width');
    const height = await canvas.getAttribute('height');
    return parseInt(width) > 0 && parseInt(height) > 0;
  }, CONFIG.pageLoadTimeout, 'Canvas has zero dimensions');
  
  return canvas;
}

/**
 * Upload a region file via the file input
 */
async function uploadRegionFile(driver, filePath) {
  console.log(`${colors.dim}  Uploading region file: ${path.basename(filePath)}${colors.reset}`);
  
  const fileInput = await driver.findElement(By.css('input[type="file"][accept=".mca,.mcr"]'));
  await fileInput.sendKeys(filePath);
  
  console.log(`${colors.green}  ✓ File uploaded${colors.reset}`);
}

/**
 * Wait for the region to finish loading and rendering
 */
async function waitForRegionLoaded(driver) {
  console.log(`${colors.dim}  Waiting for region to load...${colors.reset}`);
  
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
  } catch (e) {
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
  }, CONFIG.renderTimeout, 'Loading overlay did not disappear');
  
  // Wait for file info to show region count
  await driver.wait(async () => {
    try {
      const fileInfo = await driver.findElement(By.css('.file-info'));
      const text = await fileInfo.getText();
      return text.includes('region') || text.includes('chunk');
    } catch {
      return false;
    }
  }, 10000, 'File info not updated');
  
  console.log(`${colors.green}  ✓ Region loaded${colors.reset}`);
}

/**
 * Take a screenshot and save it
 */
async function takeScreenshot(driver, name, directory) {
  const screenshot = await driver.takeScreenshot();
  const filepath = path.join(directory, `${name}.png`);
  fs.writeFileSync(filepath, screenshot, 'base64');
  return filepath;
}

/**
 * Compare two PNG images and return difference information
 */
function compareScreenshots(baselinePath, currentPath, diffPath) {
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  const current = PNG.sync.read(fs.readFileSync(currentPath));
  
  const { width, height } = baseline;
  
  // Ensure dimensions match
  if (current.width !== width || current.height !== height) {
    return {
      match: false,
      error: `Dimension mismatch: baseline ${width}x${height}, current ${current.width}x${current.height}`,
      diffPixels: null,
      diffPercentage: null,
    };
  }
  
  const diff = new PNG({ width, height });
  
  const diffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    { threshold: CONFIG.pixelThreshold }
  );
  
  // Save diff image
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  
  const totalPixels = width * height;
  const diffPercentage = (diffPixels / totalPixels) * 100;
  
  return {
    match: diffPercentage <= CONFIG.maxDiffPercentage,
    diffPixels,
    diffPercentage,
    totalPixels,
  };
}

/**
 * Run a single screenshot regression test
 */
async function runScreenshotTest(driver, testName, setupFn) {
  console.log(`\n${colors.cyan}▶ Screenshot Test: ${testName}${colors.reset}`);
  
  // Run setup (e.g., upload file, wait for render)
  await setupFn(driver);
  
  // Wait for render stabilization
  console.log(`${colors.dim}  Waiting for render stabilization...${colors.reset}`);
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Take screenshot
  const currentPath = await takeScreenshot(driver, testName, CONFIG.currentDir);
  console.log(`${colors.dim}  Screenshot captured: ${path.basename(currentPath)}${colors.reset}`);
  
  const baselinePath = path.join(CONFIG.baselineDir, `${testName}.png`);
  const diffPath = path.join(CONFIG.diffDir, `${testName}-diff.png`);
  
  if (UPDATE_BASELINE) {
    // Copy current to baseline
    fs.copyFileSync(currentPath, baselinePath);
    console.log(`${colors.green}  ✓ Baseline updated: ${path.basename(baselinePath)}${colors.reset}`);
    return { passed: true, updated: true };
  }
  
  // Check if baseline exists
  if (!fs.existsSync(baselinePath)) {
    console.log(`${colors.yellow}  ⚠ No baseline found. Run with --update to create one.${colors.reset}`);
    console.log(`${colors.dim}    Expected: ${baselinePath}${colors.reset}`);
    return { passed: false, noBaseline: true };
  }
  
  // Compare screenshots
  console.log(`${colors.dim}  Comparing against baseline...${colors.reset}`);
  const result = compareScreenshots(baselinePath, currentPath, diffPath);
  
  if (result.error) {
    console.log(`${colors.red}  ✗ ${result.error}${colors.reset}`);
    return { passed: false, error: result.error };
  }
  
  if (result.match) {
    console.log(`${colors.green}  ✓ Screenshots match (${result.diffPercentage.toFixed(3)}% difference)${colors.reset}`);
    // Clean up diff image on success
    if (fs.existsSync(diffPath)) {
      fs.unlinkSync(diffPath);
    }
    return { passed: true, diffPercentage: result.diffPercentage };
  } else {
    console.log(`${colors.red}  ✗ Screenshots differ: ${result.diffPixels.toLocaleString()} pixels (${result.diffPercentage.toFixed(3)}%)${colors.reset}`);
    console.log(`${colors.dim}    Diff image saved: ${diffPath}${colors.reset}`);
    console.log(`${colors.dim}    Threshold: ${CONFIG.maxDiffPercentage}%${colors.reset}`);
    return { passed: false, diffPercentage: result.diffPercentage, diffPath };
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  E2E Screenshot Regression Tests${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  if (UPDATE_BASELINE) {
    console.log(`${colors.yellow}  Mode: UPDATE BASELINE${colors.reset}`);
  } else {
    console.log(`${colors.dim}  Mode: Compare against baseline${colors.reset}`);
  }
  
  // Ensure directories exist and clean old files
  ensureDirectories();
  cleanTestDirectories();
  
  // Verify test region exists
  if (!fs.existsSync(CONFIG.testRegionPath)) {
    console.log(`${colors.red}  ✗ Test region not found: ${CONFIG.testRegionPath}${colors.reset}`);
    process.exit(1);
  }
  
  let server = null;
  let driver = null;
  const results = [];
  
  try {
    // Start dev server
    server = await startDevServer();
    
    // Give server a moment to fully initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Create WebDriver
    console.log(`${colors.dim}  Launching Chrome (headless)...${colors.reset}`);
    driver = await createDriver();
    console.log(`${colors.green}  ✓ Chrome launched${colors.reset}`);
    
    // Navigate to the app
    const url = `http://localhost:${CONFIG.devServerPort}`;
    console.log(`${colors.dim}  Navigating to ${url}...${colors.reset}`);
    await driver.get(url);
    
    // Wait for React app to load
    await waitForAppLoaded(driver);
    
    // Test 1: Empty state screenshot
    results.push(await runScreenshotTest(driver, 'empty-state', async () => {
      // No setup needed - just capture the empty state
      console.log(`${colors.dim}  Capturing empty state...${colors.reset}`);
    }));
    
    // Test 2: Region loaded screenshot
    results.push(await runScreenshotTest(driver, 'region-loaded', async () => {
      await uploadRegionFile(driver, CONFIG.testRegionPath);
      await waitForCanvasRendered(driver);
      await waitForRegionLoaded(driver);
    }));
    
  } catch (error) {
    console.log(`${colors.red}  ✗ Test error: ${error.message}${colors.reset}`);
    console.log(`${colors.dim}    ${error.stack}${colors.reset}`);
    
    // Try to take a failure screenshot
    if (driver) {
      try {
        const failPath = await takeScreenshot(driver, 'failure', CONFIG.currentDir);
        console.log(`${colors.dim}  Failure screenshot saved: ${failPath}${colors.reset}`);
      } catch (e) {
        console.log(`${colors.dim}  Could not take failure screenshot${colors.reset}`);
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
  
  // Summary
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Summary${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const updated = results.filter(r => r.updated).length;
  
  if (UPDATE_BASELINE) {
    console.log(`${colors.green}  ${updated} baseline(s) updated${colors.reset}`);
  } else {
    console.log(`${colors.green}  ${passed} passed${colors.reset}`);
    if (failed > 0) {
      console.log(`${colors.red}  ${failed} failed${colors.reset}`);
    }
  }
  
  console.log(`\n${colors.dim}  Baseline directory: ${CONFIG.baselineDir}${colors.reset}`);
  console.log(`${colors.dim}  Current directory:  ${CONFIG.currentDir}${colors.reset}`);
  console.log(`${colors.dim}  Diff directory:     ${CONFIG.diffDir}${colors.reset}`);
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});

