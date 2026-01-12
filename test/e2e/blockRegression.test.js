/**
 * Single Block Regression Test
 * 
 * Uses coordinates from debug_world_blocks.json to test individual block rendering.
 * Positions camera directly above/below each block with narrow FOV for isolated view.
 * 
 * Usage:
 *   npm run test:block                     # Run in headless mode
 *   npm run test:block:update              # Update baseline screenshots
 *   npm run test:block -- --filter=stairs  # Run only tests matching 'stairs'
 *   npm run test:block -- --limit=10       # Run only first 10 tests
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { PNG } from 'pngjs';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Parse command line arguments
const UPDATE_BASELINE = process.argv.includes('--update');
const HEADLESS = process.env.HEADLESS !== '0';
const FILTER = process.argv.find(arg => arg.startsWith('--filter='))?.split('=')[1];
const LIMIT = parseInt(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '0', 10);
const USE_SUBSET = process.argv.includes('--subset');

// Diverse subset of ~100 blocks covering all categories
// Includes: stairs, slabs, doors, trapdoors, fences, walls, signs, banners, skulls,
// beds, chests, flowers, saplings, torches, lanterns, buttons, levers, rails,
// redstone components, campfires, bells, lecterns, brewing stands, etc.
const SUBSET_PATTERNS = [
  // Stairs (various types)
  'oak_stairs__facing_south_half_bottom',
  'stone_stairs__facing_east_half_top',
  'cobblestone_stairs__facing_north_half_bottom_shape_outer',
  'brick_stairs__facing_west_half_bottom_shape_inner',
  'quartz_stairs__facing_south_half_top',
  // Slabs
  'oak_slab__type_bottom',
  'stone_slab__type_top',
  'cobblestone_slab__type_double',
  // Doors
  'oak_door__facing_south_half_lower_hinge_left_open_false',
  'iron_door__facing_north_half_upper_hinge_right_open_true',
  'acacia_door__facing_east_half_lower',
  // Trapdoors
  'oak_trapdoor__facing_north_half_bottom_open_false',
  'iron_trapdoor__facing_south_half_top_open_true',
  'birch_trapdoor__facing_west_half_bottom_open_true',
  // Fences & Gates
  'oak_fence__',
  'stone_brick_wall__',
  'oak_fence_gate__facing_south_open_false',
  // Signs (block entities - not rendered)
  'oak_sign__',
  'birch_wall_sign__',
  'crimson_hanging_sign__',
  // Banners (block entities - not rendered)
  'white_banner__',
  'red_wall_banner__',
  // Skulls/Heads (block entities - not rendered)
  'skeleton_skull__',
  'zombie_head__',
  'player_head__',
  'creeper_head__',
  // Beds (block entities - not rendered)
  'red_bed__facing_south_part_foot',
  'blue_bed__facing_north_part_head',
  // Chests (block entities - not rendered)
  'chest__facing_south',
  'trapped_chest__facing_east',
  'ender_chest__facing_north',
  // Flowers & Plants
  'poppy',
  'dandelion',
  'blue_orchid',
  'rose_bush__half_lower',
  'tall_grass__half_upper',
  'fern',
  // Saplings
  'oak_sapling',
  'birch_sapling',
  'spruce_sapling',
  // Torches & Lanterns
  'torch',
  'wall_torch__facing_south',
  'soul_torch',
  'lantern__hanging_false',
  'soul_lantern__hanging_true',
  // Buttons & Levers
  'oak_button__face_wall_facing_north',
  'stone_button__face_floor',
  'lever__face_ceiling',
  // Rails
  'rail__shape_north_south',
  'powered_rail__powered_true_shape_ascending_east',
  'detector_rail__',
  'activator_rail__',
  // Redstone
  'redstone_wire__',
  'redstone_torch__',
  'redstone_wall_torch__facing_east_lit_true',
  'repeater__facing_south_delay_2',
  'comparator__facing_north_mode_compare',
  // Campfires
  'campfire__facing_south_lit_true',
  'soul_campfire__facing_north_lit_false',
  // Bells
  'bell__attachment_floor_facing_south',
  'bell__attachment_ceiling',
  'bell__attachment_single_wall_facing_east',
  // Lectern & Brewing Stand
  'lectern__facing_south_has_book_false',
  'brewing_stand__',
  // Anvil & Grindstone
  'anvil__facing_south',
  'grindstone__face_floor_facing_north',
  // Hoppers & Droppers
  'hopper__facing_down',
  'dropper__facing_up',
  'dispenser__facing_east',
  // Pistons
  'piston__facing_up_extended_false',
  'sticky_piston__facing_down',
  'piston_head__facing_north_type_normal',
  // Glazed Terracotta (rotated full blocks)
  'white_glazed_terracotta__facing_south',
  'orange_glazed_terracotta__facing_east',
  // Barrels & Beehives
  'barrel__facing_up_open_false',
  'beehive__facing_south_honey_level_0',
  // Furnaces & Crafting
  'furnace__facing_north_lit_false',
  'blast_furnace__facing_east_lit_true',
  'smoker__facing_south',
  // Misc partial blocks
  'end_rod__facing_up',
  'lightning_rod__facing_down',
  'chain__axis_y',
  'ladder__facing_south',
  'vine__east_true_north_false',
  'snow__layers_3',
  'farmland__moisture_7',
  'enchanting_table',
  'conduit__',
  'turtle_egg__eggs_2_hatch_1',
];

/**
 * Filter blocks to subset patterns - picks ONE block per pattern
 */
function filterToSubset(testCases) {
  const selected = [];
  const usedPatterns = new Set();
  
  for (const pattern of SUBSET_PATTERNS) {
    // Find the first test case matching this pattern
    const match = testCases.find(tc => tc.name.includes(pattern));
    if (match && !usedPatterns.has(match.name)) {
      selected.push(match);
      usedPatterns.add(match.name);
    }
  }
  
  return selected;
}

// Configuration
const CONFIG = {
  ...DEFAULT_CONFIG,
  devServerPort: 5177, // Different port from main regression tests
  baselineDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'baseline', 'blocks'),
  currentDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'current', 'blocks'),
  diffDir: path.join(PROJECT_ROOT, 'test', 'e2e', 'diff', 'blocks'),
  worldFile: path.join(PROJECT_ROOT, 'test', 'world_files', 'debug_world.zip'),
  blocksFile: path.join(PROJECT_ROOT, 'debug_world_blocks.json'),
};

// FOV and distance tuned to show mostly just the target block
const BLOCK_TEST_FOV = 50; // Slightly narrower FOV
const CAMERA_DISTANCE = 2; // Closer to target

// Crop settings
const CROP_SIZE = 350; // Size of the cropped square in pixels
const UI_PANEL_WIDTH = 350; // Width of the right-side UI panel

/**
 * Crop screenshot to center of the 3D canvas (accounting for UI panel)
 */
function cropToCenter(imagePath, size = CROP_SIZE) {
  const png = PNG.sync.read(fs.readFileSync(imagePath));
  
  // Calculate the actual canvas area (excluding UI panel on right)
  const canvasWidth = png.width - UI_PANEL_WIDTH;
  const canvasHeight = png.height;
  
  // Calculate crop region (center of the canvas, not full window)
  const canvasCenterX = Math.floor(canvasWidth / 2);
  const canvasCenterY = Math.floor(canvasHeight / 2);
  
  const cropX = Math.max(0, canvasCenterX - Math.floor(size / 2));
  const cropY = Math.max(0, canvasCenterY - Math.floor(size / 2));
  
  // Clamp to canvas bounds
  const actualSize = Math.min(size, canvasWidth, canvasHeight);
  
  // Create new PNG for cropped image
  const cropped = new PNG({ width: actualSize, height: actualSize });
  
  // Copy pixels from center of canvas
  for (let y = 0; y < actualSize; y++) {
    for (let x = 0; x < actualSize; x++) {
      const srcIdx = ((cropY + y) * png.width + (cropX + x)) * 4;
      const dstIdx = (y * actualSize + x) * 4;
      cropped.data[dstIdx] = png.data[srcIdx];         // R
      cropped.data[dstIdx + 1] = png.data[srcIdx + 1]; // G
      cropped.data[dstIdx + 2] = png.data[srcIdx + 2]; // B
      cropped.data[dstIdx + 3] = png.data[srcIdx + 3]; // A
    }
  }
  
  // Overwrite the file with cropped version
  fs.writeFileSync(imagePath, PNG.sync.write(cropped));
  return imagePath;
}

/**
 * Load block data from debug_world_blocks.json
 */
function loadBlockData() {
  const data = JSON.parse(fs.readFileSync(CONFIG.blocksFile, 'utf8'));
  return data.blocks;
}

/**
 * Generate test cases from block data
 * Each unique block gets a test case
 */
function generateTestCases(blocks) {
  const testCases = [];
  
  for (const block of blocks) {
    const shortName = block.block.replace('minecraft:', '');
    
    // Create a unique test name from block + properties
    const propsStr = block.properties 
      ? Object.entries(block.properties)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([k, v]) => `${k}_${v}`)
          .join('_')
      : '';
    
    const testName = propsStr ? `${shortName}__${propsStr}` : shortName;
    
    // Apply filter if specified
    if (FILTER && !testName.toLowerCase().includes(FILTER.toLowerCase())) {
      continue;
    }
    
    testCases.push({
      name: testName,
      block: block.block,
      properties: block.properties,
      x: block.x,
      y: block.y,
      z: block.z,
    });
  }
  
  // Apply subset filter if specified
  let filtered = testCases;
  if (USE_SUBSET) {
    filtered = filterToSubset(testCases);
    console.log(`${colors.dim}  Subset mode: ${filtered.length} blocks matched from ${SUBSET_PATTERNS.length} patterns${colors.reset}`);
  }
  
  // Apply limit if specified
  if (LIMIT > 0) {
    return filtered.slice(0, LIMIT);
  }
  
  return filtered;
}

/**
 * Apply settings for single block testing
 */
async function applyBlockTestSettings(driver) {
  await setCameraFOV(driver, BLOCK_TEST_FOV);
  // Set a large render distance to load entire region
  await setRenderDistance(driver, 32);
  // Max loading speed for faster initial load
  await setChunkLoadingSpeed(driver, 8);
  await setCloudsEnabled(driver, false);
  await setSmoothLighting(driver, false);
  await setDayNightCycle(driver, false);
  
  console.log(`${colors.dim}  Settings: FOV=${BLOCK_TEST_FOV}, renderDistance=32 (full region)${colors.reset}`);
}

/**
 * Main test runner
 */
async function runTests() {
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Single Block Regression Test Suite${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.dim}  Mode: ${UPDATE_BASELINE ? 'Update baseline' : 'Compare against baseline'}${colors.reset}`);
  console.log(`${colors.dim}  Browser: ${HEADLESS ? 'Headless' : 'Visible'}${colors.reset}`);
  if (USE_SUBSET) {
    console.log(`${colors.dim}  Subset: ~100 diverse blocks${colors.reset}`);
  }
  
  // Load block data
  if (!fs.existsSync(CONFIG.blocksFile)) {
    console.error(`${colors.red}Error: ${CONFIG.blocksFile} not found${colors.reset}`);
    console.error(`Run: node scripts/extract-world-blocks.cjs test/world_files/debug_world.zip debug_world_blocks.json`);
    process.exit(1);
  }
  
  const blocks = loadBlockData();
  const testCases = generateTestCases(blocks);
  
  console.log(`${colors.dim}  Total blocks: ${blocks.length}${colors.reset}`);
  console.log(`${colors.dim}  Tests to run: ${testCases.length}${colors.reset}`);
  
  if (testCases.length === 0) {
    console.log(`${colors.yellow}No tests to run${colors.reset}`);
    return;
  }
  
  ensureDirectories(CONFIG);
  
  // Start dev server
  console.log(`${colors.dim}  Starting Vite dev server on port ${CONFIG.devServerPort}...${colors.reset}`);
  const server = await startDevServer(CONFIG);
  console.log(`${colors.green}  ✓ Dev server started on port ${CONFIG.devServerPort}${colors.reset}`);
  
  let driver;
  const results = [];
  
  try {
    // Launch browser
    console.log(`${colors.dim}  Launching Chrome (${HEADLESS ? 'headless' : 'visible'})...${colors.reset}`);
    driver = await createDriver(HEADLESS, CONFIG);
    console.log(`${colors.green}  ✓ Chrome launched${colors.reset}`);
    
    // Navigate to app
    console.log(`${colors.dim}  Navigating to http://localhost:${CONFIG.devServerPort}...${colors.reset}`);
    await driver.get(`http://localhost:${CONFIG.devServerPort}`);
    
    // Wait for app
    console.log(`${colors.dim}  Waiting for app to load...${colors.reset}`);
    await waitForAppLoaded(driver);
    console.log(`${colors.green}  ✓ App loaded${colors.reset}`);
    
    // Upload world
    console.log(`${colors.dim}  Uploading file: ${path.basename(CONFIG.worldFile)}${colors.reset}`);
    await uploadFile(driver, CONFIG.worldFile);
    console.log(`${colors.green}  ✓ File uploaded${colors.reset}`);
    
    // Wait for canvas
    console.log(`${colors.dim}  Waiting for WebGL canvas...${colors.reset}`);
    await waitForCanvasRendered(driver);
    
    // Wait for loading
    console.log(`${colors.dim}  Waiting for loading to complete...${colors.reset}`);
    await waitForLoadingComplete(driver);
    console.log(`${colors.green}  ✓ Loading complete${colors.reset}`);
    
    // Wait for chunks - load entire region
    console.log(`${colors.dim}  Waiting for world to load (full region)...${colors.reset}`);
    await applyBlockTestSettings(driver);
    // Wait for more chunks with full region render distance
    await waitForChunksLoaded(driver, 200, 180000); // Wait for 200 chunks, 3 min timeout
    
    // Run each test
    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      const progress = `[${i + 1}/${testCases.length}]`;
      
      console.log(`\n${colors.cyan}▶ ${progress} ${testCase.name}${colors.reset}`);
      console.log(`${colors.dim}  Block: ${testCase.block} at (${testCase.x}, ${testCase.y}, ${testCase.z})${colors.reset}`);
      
      // Position camera isometrically - offset in +X, +Y, +Z, looking at block
      const offset = CAMERA_DISTANCE;
      const camX = testCase.x + 0.5 + offset; // Offset in +X
      const camY = testCase.y + 0.5 + offset * 0.7; // Slightly less offset up (shallower angle)
      const camZ = testCase.z + 0.5 + offset; // Offset in +Z
      const yaw = -135; // Looking northwest (towards -X, -Z)
      const pitch = -25; // Shallower angle - looking down at ~25 degrees
      
      console.log(`${colors.dim}  Camera: (${camX}, ${camY}, ${camZ}) isometric view${colors.reset}`);
      await setCamera(driver, camX, camY, camZ, yaw, pitch);
      
      // Brief wait for render frame (chunks already loaded with full region)
      await driver.sleep(100);
      
      // Take screenshot and crop to center
      const screenshotName = testCase.name;
      console.log(`${colors.dim}  Screenshot: ${screenshotName}.png (cropped ${CROP_SIZE}x${CROP_SIZE})${colors.reset}`);
      const currentPath = await takeScreenshot(driver, screenshotName, CONFIG.currentDir);
      cropToCenter(currentPath, CROP_SIZE);
      
      // Compare or update baseline
      if (UPDATE_BASELINE) {
        const baselinePath = path.join(CONFIG.baselineDir, `${screenshotName}.png`);
        fs.copyFileSync(currentPath, baselinePath);
        console.log(`${colors.green}  ✓ Baseline updated${colors.reset}`);
        results.push({ name: testCase.name, passed: true, updated: true });
      } else {
        const baselinePath = path.join(CONFIG.baselineDir, `${screenshotName}.png`);
        const diffPath = path.join(CONFIG.diffDir, `${screenshotName}-diff.png`);
        
        if (!fs.existsSync(baselinePath)) {
          console.log(`${colors.yellow}  ⚠ No baseline found${colors.reset}`);
          results.push({ name: testCase.name, passed: false, error: 'No baseline' });
          continue;
        }
        
        const comparison = compareScreenshots(baselinePath, currentPath, diffPath, CONFIG);
        
        if (comparison.match) {
          console.log(`${colors.green}  ✓ Match (${(comparison.diffPercent || 0).toFixed(3)}% diff)${colors.reset}`);
          results.push({ name: testCase.name, passed: true, diffPercent: comparison.diffPercent });
        } else {
          console.log(`${colors.red}  ✗ Mismatch: ${(comparison.diffPixels || 0).toLocaleString()} pixels (${(comparison.diffPercent || 0).toFixed(3)}%)${colors.reset}`);
          console.log(`${colors.dim}    Diff saved: ${diffPath}${colors.reset}`);
          results.push({ name: testCase.name, passed: false, diffPercent: comparison.diffPercent });
        }
      }
    }
    
  } finally {
    // Cleanup
    console.log(`${colors.dim}  Closing browser...${colors.reset}`);
    if (driver) await driver.quit();
    console.log(`${colors.dim}  Stopping dev server...${colors.reset}`);
    server.kill();
  }
  
  // Print summary
  printSummary(results, UPDATE_BASELINE, CONFIG);
  
  // Exit with error code if any tests failed
  const failed = results.filter(r => !r.passed && !r.error);
  if (failed.length > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error(`${colors.red}Test error: ${err.message}${colors.reset}`);
  console.error(err.stack);
  process.exit(1);
});
