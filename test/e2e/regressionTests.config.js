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
  {
    name: 'spawn_area_north',
    description: 'View from spawn looking north',
    x: 0,
    y: 80,
    z: 0,
    yaw: 0,
    pitch: -15,
  },
  {
    name: 'spawn_area_east',
    description: 'View from spawn looking east',
    x: 0,
    y: 80,
    z: 0,
    yaw: 90,
    pitch: -15,
  },
  {
    name: 'spawn_area_south',
    description: 'View from spawn looking south',
    x: 0,
    y: 80,
    z: 0,
    yaw: 180,
    pitch: -15,
  },
  {
    name: 'spawn_area_west',
    description: 'View from spawn looking west',
    x: 0,
    y: 80,
    z: 0,
    yaw: 270,
    pitch: -15,
  },
  
  // ============================================================================
  // Block Type Tests (debug_world specific positions)
  // ============================================================================
  {
    name: 'glass_appearance',
    description: 'Test glass block rendering',
    x: 10,
    y: 4,
    z: 102,
    yaw: 25,
    pitch: 50,
  },
  {
    name: 'water_surface',
    description: 'Test water rendering',
    x: 0,
    y: 65,
    z: 100,
    yaw: 0,
    pitch: -30,
  },
  {
    name: 'underground_lighting',
    description: 'Test cave lighting',
    x: 0,
    y: 40,
    z: 0,
    yaw: 45,
    pitch: 0,
  },
  {
    name: 'chunk_boundary',
    description: 'View across chunk boundary for stitching test',
    x: 16,
    y: 80,
    z: 0,
    yaw: 0,
    pitch: -20,
    settings: {
      renderDistance: 4, // Smaller to focus on boundary
    },
  },
  {
    name: 'model_blocks',
    description: 'Test partial block models (stairs, slabs, etc)',
    x: 50,
    y: 70,
    z: 50,
    yaw: 45,
    pitch: -30,
  },
  {
    name: 'leaves_and_grass',
    description: 'Test transparent blocks like leaves',
    x: 100,
    y: 80,
    z: 100,
    yaw: 0,
    pitch: -20,
  },
  
  // ============================================================================
  // Lighting Tests
  // ============================================================================
  {
    name: 'sunlight_gradient',
    description: 'Test sunlight falloff at surface',
    x: 0,
    y: 100,
    z: 0,
    yaw: 0,
    pitch: -45,
  },
  {
    name: 'blocklight_torch',
    description: 'Test torch light emission',
    x: 0,
    y: 30,
    z: 0,
    yaw: 0,
    pitch: 0,
  },
  
  // ============================================================================
  // Chunk Stitching Tests
  // ============================================================================
  {
    name: 'stitching_light_boundary',
    description: 'Test light continuity across chunk boundary',
    x: 32,
    y: 70,
    z: 32,
    yaw: 45,
    pitch: -10,
    settings: {
      renderDistance: 4,
    },
  },
  {
    name: 'stitching_water_boundary',
    description: 'Test water mesh continuity across chunk boundary',
    x: 16,
    y: 62,
    z: 16,
    yaw: 90,
    pitch: -5,
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

