/**
 * AOCalculator - Per-vertex ambient occlusion calculation
 * 
 * Implements Minecraft's "smooth lighting" AO algorithm:
 * - Each vertex samples 3 neighboring blocks (2 edges + 1 corner)
 * - AO level = count of opaque neighbors (0-3)
 * - Darker corners occur where more neighbors are solid
 * 
 * The final brightness combines:
 * - AO factor (0.0 - 1.0 based on neighbor count)
 * - Sky light factor (skyLight / 15)
 */

import { MAX_LIGHT } from './LightGrid.js';

// AO brightness curve - maps neighbor count to brightness multiplier
// Keep AO very subtle - just slight darkening at corners/crevices
// 0 neighbors = full brightness, 3 neighbors = only slightly darker
// This prevents crevices from becoming too dark even near light
export const AO_CURVE = [1.0, 0.92, 0.85, 0.78];

/**
 * AO neighbor offsets for each face and vertex
 * 
 * For each face, we have 4 vertices. For each vertex, we sample 3 neighbors:
 * - side1: edge neighbor in one direction
 * - side2: edge neighbor in perpendicular direction  
 * - corner: diagonal corner neighbor
 * 
 * Face vertex order (looking at face from outside):
 *   3---2
 *   |   |
 *   0---1
 * 
 * The offsets are relative to the block that owns the face.
 */
export const AO_NEIGHBOR_OFFSETS = {
  // UP face (+Y) - vertices at y+1
  // Looking down at top face from above
  up: [
    // v0: front-left (x, y+1, z+1)
    { side1: [-1, 1, 0], side2: [0, 1, 1], corner: [-1, 1, 1] },
    // v1: front-right (x+1, y+1, z+1)
    { side1: [1, 1, 0], side2: [0, 1, 1], corner: [1, 1, 1] },
    // v2: back-right (x+1, y+1, z)
    { side1: [1, 1, 0], side2: [0, 1, -1], corner: [1, 1, -1] },
    // v3: back-left (x, y+1, z)
    { side1: [-1, 1, 0], side2: [0, 1, -1], corner: [-1, 1, -1] },
  ],
  
  // DOWN face (-Y) - vertices at y
  // Looking up at bottom face from below
  down: [
    // v0: back-left (x, y, z)
    { side1: [-1, -1, 0], side2: [0, -1, -1], corner: [-1, -1, -1] },
    // v1: back-right (x+1, y, z)
    { side1: [1, -1, 0], side2: [0, -1, -1], corner: [1, -1, -1] },
    // v2: front-right (x+1, y, z+1)
    { side1: [1, -1, 0], side2: [0, -1, 1], corner: [1, -1, 1] },
    // v3: front-left (x, y, z+1)
    { side1: [-1, -1, 0], side2: [0, -1, 1], corner: [-1, -1, 1] },
  ],
  
  // EAST face (+X) - vertices at x+1
  // Looking at east face from east (positive X)
  east: [
    // v0: bottom-front (x+1, y, z)
    { side1: [1, -1, 0], side2: [1, 0, -1], corner: [1, -1, -1] },
    // v1: top-front (x+1, y+1, z)
    { side1: [1, 1, 0], side2: [1, 0, -1], corner: [1, 1, -1] },
    // v2: top-back (x+1, y+1, z+1)
    { side1: [1, 1, 0], side2: [1, 0, 1], corner: [1, 1, 1] },
    // v3: bottom-back (x+1, y, z+1)
    { side1: [1, -1, 0], side2: [1, 0, 1], corner: [1, -1, 1] },
  ],
  
  // WEST face (-X) - vertices at x
  // Looking at west face from west (negative X)
  west: [
    // v0: bottom-back (x, y, z+1)
    { side1: [-1, -1, 0], side2: [-1, 0, 1], corner: [-1, -1, 1] },
    // v1: top-back (x, y+1, z+1)
    { side1: [-1, 1, 0], side2: [-1, 0, 1], corner: [-1, 1, 1] },
    // v2: top-front (x, y+1, z)
    { side1: [-1, 1, 0], side2: [-1, 0, -1], corner: [-1, 1, -1] },
    // v3: bottom-front (x, y, z)
    { side1: [-1, -1, 0], side2: [-1, 0, -1], corner: [-1, -1, -1] },
  ],
  
  // SOUTH face (+Z) - vertices at z+1
  // Looking at south face from south (positive Z)
  south: [
    // v0: bottom-left (x, y, z+1)
    { side1: [0, -1, 1], side2: [-1, 0, 1], corner: [-1, -1, 1] },
    // v1: bottom-right (x+1, y, z+1)
    { side1: [0, -1, 1], side2: [1, 0, 1], corner: [1, -1, 1] },
    // v2: top-right (x+1, y+1, z+1)
    { side1: [0, 1, 1], side2: [1, 0, 1], corner: [1, 1, 1] },
    // v3: top-left (x, y+1, z+1)
    { side1: [0, 1, 1], side2: [-1, 0, 1], corner: [-1, 1, 1] },
  ],
  
  // NORTH face (-Z) - vertices at z
  // Looking at north face from north (negative Z)
  north: [
    // v0: bottom-right (x+1, y, z)
    { side1: [0, -1, -1], side2: [1, 0, -1], corner: [1, -1, -1] },
    // v1: bottom-left (x, y, z)
    { side1: [0, -1, -1], side2: [-1, 0, -1], corner: [-1, -1, -1] },
    // v2: top-left (x, y+1, z)
    { side1: [0, 1, -1], side2: [-1, 0, -1], corner: [-1, 1, -1] },
    // v3: top-right (x+1, y+1, z)
    { side1: [0, 1, -1], side2: [1, 0, -1], corner: [1, 1, -1] },
  ],
};

// Face index mapping
export const FACE_UP = 0;
export const FACE_DOWN = 1;
export const FACE_EAST = 2;
export const FACE_WEST = 3;
export const FACE_SOUTH = 4;
export const FACE_NORTH = 5;

const FACE_NAMES = ['up', 'down', 'east', 'west', 'south', 'north'];

/**
 * Compute AO level for a single vertex
 * 
 * Uses Minecraft's algorithm:
 * - Count opaque neighbors among side1, side2, corner
 * - If both sides are opaque, corner doesn't matter (count = 3)
 * - Otherwise count = side1 + side2 + corner
 * 
 * @param {number} side1 - 1 if side1 neighbor is opaque, 0 otherwise
 * @param {number} side2 - 1 if side2 neighbor is opaque, 0 otherwise
 * @param {number} corner - 1 if corner neighbor is opaque, 0 otherwise
 * @returns {number} AO level 0-3 (0 = brightest, 3 = darkest)
 */
export function computeAOLevel(side1, side2, corner) {
  // Minecraft's rule: if both sides are solid, corner is automatically blocked
  if (side1 && side2) {
    return 3;
  }
  return side1 + side2 + corner;
}

/**
 * Compute per-vertex AO for a face
 * 
 * @param {number} blockX - Block world X
 * @param {number} blockY - Block world Y
 * @param {number} blockZ - Block world Z
 * @param {number} faceIndex - Face index (0-5)
 * @param {Function} isOpaqueAt - Function(x,y,z) => boolean
 * @returns {number[]} Array of 4 AO levels (0-3) for each vertex
 */
export function computeFaceAO(blockX, blockY, blockZ, faceIndex, isOpaqueAt) {
  const faceName = FACE_NAMES[faceIndex];
  const offsets = AO_NEIGHBOR_OFFSETS[faceName];
  
  const aoLevels = new Array(4);
  
  for (let v = 0; v < 4; v++) {
    const { side1, side2, corner } = offsets[v];
    
    const s1 = isOpaqueAt(blockX + side1[0], blockY + side1[1], blockZ + side1[2]) ? 1 : 0;
    const s2 = isOpaqueAt(blockX + side2[0], blockY + side2[1], blockZ + side2[2]) ? 1 : 0;
    const c = isOpaqueAt(blockX + corner[0], blockY + corner[1], blockZ + corner[2]) ? 1 : 0;
    
    aoLevels[v] = computeAOLevel(s1, s2, c);
  }
  
  return aoLevels;
}

/**
 * Compute final vertex brightness combining AO and sky light
 * 
 * Uses Minecraft's brightness formula:
 * - Light level determines base brightness using exponential curve
 * - AO applies subtle darkening at corners/edges
 * - Minimum ambient prevents pitch black areas
 * 
 * @param {number} aoLevel - AO level 0-3
 * @param {number} skyLight - Sky light 0-15
 * @returns {number} Brightness 0.0-1.0
 */
export function computeVertexBrightness(aoLevel, skyLight) {
  // Minecraft's lighting at noon is very bright overall
  // Even shadowed areas (light 7-10) should be 60-80% bright
  // Use mostly linear with slight compression at low end
  
  // Base brightness: linear but with raised floor
  // This ensures even low light levels stay relatively bright
  const normalizedLight = skyLight / MAX_LIGHT;
  
  // Compress the range: map 0-1 to 0.35-1.0
  // This means light level 0 = 35% bright, light 15 = 100%
  const compressedLight = 0.35 + normalizedLight * 0.65;
  
  // Apply very subtle AO - just slight edge darkening
  const aoFactor = AO_CURVE[aoLevel];
  const brightness = compressedLight * aoFactor;
  
  // Minimum ambient (caves at noon still have some light)
  const minAmbient = 0.25;
  
  return Math.max(minAmbient, brightness);
}

/**
 * Compute per-vertex AO using quick neighbor sampling
 * Optimized for the mesher's inner loop
 * 
 * @param {number} blockX - Block world X
 * @param {number} blockY - Block world Y
 * @param {number} blockZ - Block world Z
 * @param {number} faceIndex - Face index (0-5)
 * @param {Function} getBlockId - Function(x,y,z) => blockId
 * @param {Uint8Array} isOpaque - Opaque lookup table
 * @returns {number[]} Array of 4 AO levels (0-3)
 */
export function computeFaceAOFast(blockX, blockY, blockZ, faceIndex, getBlockId, isOpaque) {
  const faceName = FACE_NAMES[faceIndex];
  const offsets = AO_NEIGHBOR_OFFSETS[faceName];
  
  const aoLevels = new Array(4);
  
  for (let v = 0; v < 4; v++) {
    const { side1, side2, corner } = offsets[v];
    
    const s1 = isOpaque[getBlockId(blockX + side1[0], blockY + side1[1], blockZ + side1[2])] ? 1 : 0;
    const s2 = isOpaque[getBlockId(blockX + side2[0], blockY + side2[1], blockZ + side2[2])] ? 1 : 0;
    const c = isOpaque[getBlockId(blockX + corner[0], blockY + corner[1], blockZ + corner[2])] ? 1 : 0;
    
    aoLevels[v] = computeAOLevel(s1, s2, c);
  }
  
  return aoLevels;
}

/**
 * Get the sky light value for a face by sampling the air block in front of the face
 * 
 * @param {number} blockX - Block world X
 * @param {number} blockY - Block world Y
 * @param {number} blockZ - Block world Z
 * @param {number} faceIndex - Face index (0-5)
 * @param {LightGrid} lightGrid - Light grid
 * @returns {number} Sky light 0-15
 */
export function getFaceSkyLight(blockX, blockY, blockZ, faceIndex, lightGrid) {
  // Normal directions for each face
  const normals = [
    [0, 1, 0],   // UP
    [0, -1, 0],  // DOWN
    [1, 0, 0],   // EAST
    [-1, 0, 0],  // WEST
    [0, 0, 1],   // SOUTH
    [0, 0, -1],  // NORTH
  ];
  
  const [nx, ny, nz] = normals[faceIndex];
  return lightGrid.getSkyLight(blockX + nx, blockY + ny, blockZ + nz);
}

/**
 * Compute per-vertex lighting for all 4 vertices of a face
 * Combines AO and sky light into final brightness values
 * 
 * @param {number} blockX - Block world X
 * @param {number} blockY - Block world Y
 * @param {number} blockZ - Block world Z
 * @param {number} faceIndex - Face index (0-5)
 * @param {Function} getBlockId - Function(x,y,z) => blockId
 * @param {Uint8Array} isOpaque - Opaque lookup table
 * @param {LightGrid} lightGrid - Light grid
 * @returns {number[]} Array of 4 brightness values (0.0-1.0)
 */
export function computeFaceVertexLighting(blockX, blockY, blockZ, faceIndex, getBlockId, isOpaque, lightGrid) {
  const aoLevels = computeFaceAOFast(blockX, blockY, blockZ, faceIndex, getBlockId, isOpaque);
  const skyLight = lightGrid ? getFaceSkyLight(blockX, blockY, blockZ, faceIndex, lightGrid) : MAX_LIGHT;
  
  return aoLevels.map(ao => computeVertexBrightness(ao, skyLight));
}

export default {
  computeAOLevel,
  computeFaceAO,
  computeFaceAOFast,
  computeVertexBrightness,
  getFaceSkyLight,
  computeFaceVertexLighting,
  AO_CURVE,
  AO_NEIGHBOR_OFFSETS,
  FACE_UP,
  FACE_DOWN,
  FACE_EAST,
  FACE_WEST,
  FACE_SOUTH,
  FACE_NORTH,
};


