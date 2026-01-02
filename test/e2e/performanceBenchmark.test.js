/**
 * E2E Performance Benchmark Test
 * 
 * Loads region -1,-1 and measures:
 * - Time to display
 * - Mesh statistics (triangles, blocks)
 * - Verifies expected output
 * 
 * Usage:
 *   npm run test:benchmark
 *   HEADLESS=1 npm run test:benchmark  # Run headless
 */

import { Builder, By, until, logging } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
chrome.logging = logging;
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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
  devServerPort: 5175,
  devServerStartTimeout: 30000,
  pageLoadTimeout: 10000,
  renderTimeout: 120000, // 2 minutes for benchmark
  
  // Test region: r.-1.-1.mca (large region for benchmark)
  testRegionPath: path.join(PROJECT_ROOT, 'test-regions', 'r.-1.-1.mca'),
  
  // Expected values for test region (approximate, with tolerances)
  expected: {
    minBlocks: 30000000,      // At least 30M blocks
    maxBlocks: 40000000,      // At most 40M blocks
    minTriangles: 500000,     // At least 500K triangles (solid mesh only)
    maxTriangles: 5000000,    // At most 5M triangles
    maxLoadTimeMs: 60000,     // Target: under 60 seconds (SwiftShader is slower)
  },
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
 * Create Chrome WebDriver
 */
async function createDriver() {
  const isHeadless = process.env.HEADLESS === '1';
  console.log(`${colors.dim}  Launching Chrome${isHeadless ? ' (headless)' : ''}...${colors.reset}`);
  
  const options = new chrome.Options();
  
  if (isHeadless) {
    options.addArguments('--headless=new');
  }
  
  options.addArguments(
    '--window-size=1280,960',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader'
  );
  
  // Enable console log capture
  const prefs = new logging.Preferences();
  prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
  options.setLoggingPrefs(prefs);
  
  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();
  
  console.log(`${colors.green}  ✓ Chrome launched${colors.reset}`);
  return driver;
}

/**
 * Upload region file and start timing
 */
async function uploadRegionFile(driver, filePath) {
  console.log(`${colors.dim}  Uploading region file: ${path.basename(filePath)}${colors.reset}`);
  
  const fileInput = await driver.findElement(By.css('input[type="file"]'));
  await fileInput.sendKeys(filePath);
  
  console.log(`${colors.green}  ✓ File uploaded${colors.reset}`);
}

/**
 * Wait for region to load and capture timing
 */
async function waitForRegionLoaded(driver) {
  console.log(`${colors.dim}  Waiting for region to load...${colors.reset}`);
  
  // Wait for loading to start
  try {
    await driver.wait(async () => {
      const overlays = await driver.findElements(By.css('.loading-overlay, .build-overlay'));
      for (const overlay of overlays) {
        if (await overlay.isDisplayed().catch(() => false)) return true;
      }
      return false;
    }, 5000);
    console.log(`${colors.dim}    Loading started...${colors.reset}`);
  } catch {}
  
  // Wait for loading to complete by checking for __chunkManagerStats
  let lastProgress = '';
  let attempt = 0;
  await driver.wait(async () => {
    attempt++;
    
    // Check loading overlay progress
    const overlays = await driver.findElements(By.css('.loading-overlay, .build-overlay'));
    for (const overlay of overlays) {
      if (await overlay.isDisplayed().catch(() => false)) {
        try {
          const text = await overlay.getText();
          if (text && text !== lastProgress) {
            const firstLine = text.split('\n')[0];
            console.log(`${colors.dim}    ${firstLine}${colors.reset}`);
            lastProgress = text;
          }
        } catch {}
      }
    }
    
    // The definitive check: __chunkManagerStats is set when loading completes
    try {
      const stats = await driver.executeScript(() => window.__chunkManagerStats);
      if (stats && stats.blocks > 0) {
        console.log(`${colors.dim}    Stats available: ${stats.blocks.toLocaleString()} blocks${colors.reset}`);
        return true;
      }
    } catch {}
    
    // Check for errors on every 50th attempt
    if (attempt % 50 === 0) {
      try {
        const logs = await driver.manage().logs().get('browser');
        const errors = logs.filter(l => l.level.name === 'SEVERE' || l.message.includes('Error'));
        if (errors.length > 0) {
          console.log(`${colors.red}    Browser errors found:${colors.reset}`);
          for (const err of errors.slice(0, 3)) {
            console.log(`${colors.red}      ${err.message.substring(0, 200)}${colors.reset}`);
          }
        }
      } catch {}
    }
    
    if (attempt % 10 === 0) {
      console.log(`${colors.dim}    Still waiting... (attempt ${attempt})${colors.reset}`);
    }
    
    return false;
  }, CONFIG.renderTimeout, 'Waiting for __chunkManagerStats to be set');
  
  console.log(`${colors.green}  ✓ Region loaded${colors.reset}`);
}

/**
 * Verify mesh statistics against expected values
 */
function verifyMeshStats(stats) {
  const issues = [];
  
  if (stats.blockCount < CONFIG.expected.minBlocks) {
    issues.push(`Block count ${stats.blockCount.toLocaleString()} is below minimum ${CONFIG.expected.minBlocks.toLocaleString()}`);
  }
  if (stats.blockCount > CONFIG.expected.maxBlocks) {
    issues.push(`Block count ${stats.blockCount.toLocaleString()} exceeds maximum ${CONFIG.expected.maxBlocks.toLocaleString()}`);
  }
  
  if (stats.triangleCount < CONFIG.expected.minTriangles) {
    issues.push(`Triangle count ${stats.triangleCount.toLocaleString()} is below minimum ${CONFIG.expected.minTriangles.toLocaleString()}`);
  }
  if (stats.triangleCount > CONFIG.expected.maxTriangles) {
    issues.push(`Triangle count ${stats.triangleCount.toLocaleString()} exceeds maximum ${CONFIG.expected.maxTriangles.toLocaleString()}`);
  }
  
  return issues;
}

/**
 * Main benchmark test
 */
async function runBenchmark() {
  const regionName = path.basename(CONFIG.testRegionPath);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Performance Benchmark: ${regionName}${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.dim}  Target: < ${CONFIG.expected.maxLoadTimeMs / 1000}s load time${colors.reset}`);
  console.log(`${colors.dim}  Region: ${path.basename(CONFIG.testRegionPath)}${colors.reset}`);
  console.log();
  
  let server = null;
  let driver = null;
  let passed = true;
  
  try {
    // Start dev server
    server = await startDevServer();
    
    // Launch browser
    driver = await createDriver();
    
    // Navigate to app
    const url = `http://localhost:${CONFIG.devServerPort}`;
    console.log(`${colors.dim}  Navigating to ${url}...${colors.reset}`);
    await driver.get(url);
    
    // Wait for app to load
    await driver.wait(until.elementLocated(By.css('input[type="file"]')), CONFIG.pageLoadTimeout);
    console.log(`${colors.green}  ✓ App loaded${colors.reset}`);
    
    // Start timing
    const startTime = Date.now();
    
    // Upload region file
    await uploadRegionFile(driver, CONFIG.testRegionPath);
    
    // Wait for region to load (initial load)
    await waitForRegionLoaded(driver);
    
    // End timing (after initial load)
    const endTime = Date.now();
    const loadTimeMs = endTime - startTime;
    
    // Get stats directly from window object (already set when loading completed)
    const jsStats = await driver.executeScript(() => window.__chunkManagerStats);
    const stats = {
      blockCount: jsStats?.blocks || 0,
      triangleCount: jsStats?.triangles || 0,
      totalTimeMs: jsStats?.timeMs || 0,
      parseTimeMs: 0,
      meshTimeMs: 0,
      measuredLoadTimeMs: loadTimeMs,
    };
    stats.measuredLoadTimeMs = loadTimeMs;
    
    // Print results
    console.log();
    console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}  Benchmark Results${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
    console.log();
    console.log(`${colors.bold}  Timing:${colors.reset}`);
    console.log(`    Total load time:  ${colors.bold}${(loadTimeMs / 1000).toFixed(2)}s${colors.reset}`);
    if (stats.parseTimeMs > 0) {
      console.log(`    Parse time:       ${(stats.parseTimeMs / 1000).toFixed(2)}s`);
    }
    if (stats.meshTimeMs > 0) {
      console.log(`    Mesh time:        ${(stats.meshTimeMs / 1000).toFixed(2)}s`);
    }
    console.log();
    console.log(`${colors.bold}  Mesh Statistics:${colors.reset}`);
    console.log(`    Blocks:           ${stats.blockCount.toLocaleString()}`);
    console.log(`    Triangles:        ${stats.triangleCount.toLocaleString()}`);
    if (stats.modelTriangles > 0) {
      console.log(`    Model triangles:  ${stats.modelTriangles.toLocaleString()}`);
    }
    if (stats.glassTriangles > 0) {
      console.log(`    Glass triangles:  ${stats.glassTriangles.toLocaleString()}`);
    }
    console.log();
    
    // Verify against expected values
    const issues = verifyMeshStats(stats);
    
    // Check load time target
    if (loadTimeMs > CONFIG.expected.maxLoadTimeMs) {
      console.log(`${colors.yellow}  ⚠ Load time ${(loadTimeMs / 1000).toFixed(2)}s exceeds target ${CONFIG.expected.maxLoadTimeMs / 1000}s${colors.reset}`);
    } else {
      console.log(`${colors.green}  ✓ Load time within target (< ${CONFIG.expected.maxLoadTimeMs / 1000}s)${colors.reset}`);
    }
    
    if (issues.length > 0) {
      console.log();
      console.log(`${colors.red}  Validation Issues:${colors.reset}`);
      for (const issue of issues) {
        console.log(`${colors.red}    - ${issue}${colors.reset}`);
      }
      passed = false;
    } else {
      console.log(`${colors.green}  ✓ Mesh statistics within expected range${colors.reset}`);
    }
    
  } catch (error) {
    console.log(`${colors.red}  ✗ Benchmark failed: ${error.message}${colors.reset}`);
    passed = false;
  } finally {
    // Cleanup
    if (driver) {
      console.log(`${colors.dim}  Closing browser...${colors.reset}`);
      await driver.quit().catch(() => {});
    }
    if (server) {
      console.log(`${colors.dim}  Stopping dev server...${colors.reset}`);
      server.kill('SIGTERM');
    }
  }
  
  console.log();
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Summary${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  if (passed) {
    console.log(`${colors.green}  ✓ Benchmark passed${colors.reset}`);
  } else {
    console.log(`${colors.red}  ✗ Benchmark failed${colors.reset}`);
  }
  console.log();
  
  process.exit(passed ? 0 : 1);
}

// Run the benchmark
runBenchmark().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});

