/**
 * Regression Test Configuration
 * 
 * Define camera positions and settings for regression testing.
 * Each test case specifies coordinates, rotation, and optional settings.
 * 
 * Usage:
 *   npm run test:regression          # Run all tests
 *   npm run test:regression:update   # Update baseline screenshots
 *   HEADLESS=0 npm run test:regression # Run with visible browser
 */

/**
 * Default camera and rendering settings
 * Applied before each test unless overridden
 */
export function defaultSettings() {
  return {
    fov: 70,
    renderDistance: 8,
    chunkLoadingSpeed: 8, // Fastest for testing
    clouds: false, // Disable clouds for consistent screenshots
    smoothLighting: false, // Enable smooth lighting (AO)
    dayNightCycle: false, // Disable for consistent screenshots
  };
}

/**
 * Test cases for regression testing
 * 
 * Each test case has:
 * - name: Descriptive name (used for screenshot filename)
 * - x, y, z: Camera position
 * - yaw: Horizontal rotation in degrees (0 = +Z, 90 = +X)
 * - pitch: Vertical rotation in degrees (positive = up, negative = down)
 * - settings: (optional) Override default settings
 * - waitMs: (optional) Extra wait time before screenshot
 */
export const testCases = [
  // ============================================================================
  // Basic Views
  // ============================================================================

  
  // ============================================================================
  // Block Type Tests (debug_world specific positions)
  // ============================================================================
  {
    name: 'partial_block_rendering',
    description: '177.3, 67.5, 135.4',
    x: 177.5,
    y: 68,
    z: 135.5,
    yaw: 90,
    pitch: 90,
  }, {
    name: 'solid_block_rendering',
    description: 'solid_block_rendering',
    x: 11.5,
    y: 68,
    z: 331.5,
    yaw: 90,
    pitch: 90,
  }, {
    name: 'grass_tinting',
    description: 'grass_tinting',
    x: 1.5,
    y: 72,
    z: 17.5,
    yaw: 90,
    pitch: -90,
  }, {
    name: 'redstone_power_level',
    description: 'redstone_power_level',
    x: 51.5,
    y: 78,
    z: 203.5,
    yaw: 90,
    pitch: -90,
  }, {
    name: 'partial_block_cross_model',
    description: '319.5, 71.6, 194.0',
    x: 319.5,
    y: 71.5,
    z: 194.5,
    yaw: 180,
    pitch: -45,
    waitMs: 4000, // Extra wait for distant chunks to load
  }
  
  
  // ============================================================================
  // Lighting Tests
  // ============================================================================

  
  // ============================================================================
  // Chunk Stitching Tests
  // ============================================================================

];

/**
 * Additional test cases that use different world files (hermitcraft)
 * Tests AOv3 lighting system with real-world block arrangements
 */
export const hermitcraftTestCases = [
  // Stair AO test - verifies stairs don't have black faces when touching other blocks
  {
    name: 'stair_ao_hermitcraft',
    description: 'Stair AO test - should have no black faces with smooth lighting',
    worldFile: 'hermitcraft10.zip',
    x: -456.1,
    y: 77.6,
    z: -78.5,
    yaw: 180, // north
    pitch: 44,
    settings: {
      smoothLighting: true, // Enable smooth lighting to test AO
      renderDistance: 6,
    },
    waitMs: 5000, // Wait for chunks to load
  },
  // Wall AO test - verifies walls (multipart blocks) are properly lit
  {
    name: 'wall_ao_hermitcraft',
    description: 'Wall AO test - walls should not appear overly dark',
    worldFile: 'hermitcraft10.zip',
    x: -456.1,
    y: 77.6,
    z: -78.5,
    yaw: 180,
    pitch: 44,
    settings: {
      smoothLighting: true,
      renderDistance: 6,
    },
    waitMs: 5000,
  },
];

/**
 * Get a test case by name
 */
export function getTestCase(name) {
  return testCases.find(tc => tc.name === name);
}

/**
 * Get all test case names
 */
export function getTestCaseNames() {
  return testCases.map(tc => tc.name);
}

