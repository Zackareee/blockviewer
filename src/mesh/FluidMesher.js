/**
 * FluidMesher - Minecraft-accurate water and lava mesh generation
 * 
 * Implements proper fluid rendering with:
 * - Per-vertex corner height interpolation for angled flowing surfaces
 * - All exposed faces (top, bottom, sides)
 * - Flow direction calculation for texture UV rotation
 * - Texture atlas support with animated water_still/water_flow textures
 * 
 * Fluid Level System (Minecraft):
 * - level 0: Source block (height = 8/9 ≈ 0.889)
 * - level 1-7: Flowing (height decreases as level increases)
 * - level 8-15: Falling fluid (height = 1.0, same flow patterns but falling)
 */

import { 
  BLOCK_ID_MASK, 
  LEVEL_MASK, 
  LEVEL_SHIFT, 
  SECTION_SIZE, 
  sectionToWorldY, 
  parseSectionKey 
} from './BinaryGrid.js';

// Constants
const S = SECTION_SIZE; // 16
const S2 = S * S; // 256

// Fluid type identifiers
export const FLUID_NONE = 0;
export const FLUID_WATER = 1;
export const FLUID_LAVA = 2;

// Initial mesh buffer sizes
const INITIAL_VERTICES = 8192;

/**
 * Convert fluid level to block height (0.0 to 1.0)
 * @param {number} level - Fluid level (0-15)
 * @returns {number} Height from 0.0 to 1.0
 */
export function getFluidHeight(level) {
  // Falling fluid (level >= 8) - full height
  if (level >= 8) return 1.0;
  
  // Source block (level 0) - slightly below full height
  if (level === 0) return 8 / 9; // ~0.889
  
  // Flowing levels 1-7: linearly decreasing height
  // level 1 = 7/9, level 2 = 6/9, ..., level 7 = 1/9
  return (8 - level) / 9;
}

/**
 * Get the effective fluid level at a position
 * Returns -1 if not a matching fluid type
 * @param {BinaryGrid} grid - The block grid
 * @param {number} worldX - World X coordinate
 * @param {number} worldY - World Y coordinate
 * @param {number} worldZ - World Z coordinate
 * @param {Uint8Array} isFluidLookup - Lookup table: blockId -> fluid type (0/1/2)
 * @param {number} fluidType - The fluid type to match (FLUID_WATER or FLUID_LAVA)
 * @returns {number} Fluid level (0-15) or -1 if not this fluid type
 */
function getFluidLevel(grid, worldX, worldY, worldZ, isFluidLookup, fluidType) {
  const block = grid.getBlock(worldX, worldY, worldZ);
  if (!block) return -1;
  
  const ft = isFluidLookup[block.blockId];
  
  // Check for waterlogged blocks (level 8 on non-fluid blocks)
  if (fluidType === FLUID_WATER && ft === 0 && block.level === 8) {
    return 0; // Treat waterlogged as source water
  }
  
  if (ft !== fluidType) return -1;
  return block.level;
}

/**
 * Check if position has same fluid type above (submerged)
 */
function hasFluidAbove(grid, worldX, worldY, worldZ, isFluidLookup, fluidType) {
  const block = grid.getBlock(worldX, worldY + 1, worldZ);
  if (!block) return false;
  
  const ft = isFluidLookup[block.blockId];
  
  // Waterlogged block above counts as water above
  if (fluidType === FLUID_WATER && ft === 0 && block.level === 8) {
    return true;
  }
  
  return ft === fluidType;
}

/**
 * Get effective fluid height at a position for corner averaging
 * This matches Minecraft's LiquidBlockRenderer.getHeight() method
 * 
 * @param {BinaryGrid} grid - The block grid
 * @param {number} worldX, worldY, worldZ - World position
 * @param {Uint8Array} isFluidLookup - Lookup table for fluid types
 * @param {number} fluidType - FLUID_WATER or FLUID_LAVA
 * @returns {number} Height (0-1) or -1 if not this fluid type
 */
function getEffectiveHeight(grid, worldX, worldY, worldZ, isFluidLookup, fluidType) {
  // Check if there's same fluid above - if so, height is 1.0
  if (hasFluidAbove(grid, worldX, worldY, worldZ, isFluidLookup, fluidType)) {
    return 1.0;
  }
  
  const level = getFluidLevel(grid, worldX, worldY, worldZ, isFluidLookup, fluidType);
  if (level < 0) return -1;
  
  return getFluidHeight(level);
}

/**
 * Check if a block at a position is solid (blocks fluid flow)
 */
function isSolidBlock(grid, worldX, worldY, worldZ, isOpaqueLookup) {
  const block = grid.getBlock(worldX, worldY, worldZ);
  if (!block) return false;
  
  // Check if it's opaque AND not waterlogged
  return isOpaqueLookup[block.blockId] && block.level !== 8;
}

/**
 * Calculate the height at a corner vertex
 * Uses Minecraft's actual algorithm from LiquidBlockRenderer.getHeight():
 * 
 * For each of the 4 blocks sharing this corner:
 * 1. If block has same fluid with fluid above → corner height is 1.0 (fully submerged)
 * 2. If block has same fluid → add its height to average
 * 3. If block is AIR/non-solid → count as height 0 (this creates slopes at edges!)
 * 4. If block is solid → don't count it in the average
 * 
 * This is the KEY to creating realistic slopes: air neighbors pull the corner DOWN.
 * 
 * @param {BinaryGrid} grid - The block grid
 * @param {number} worldX - Block's world X
 * @param {number} worldY - Block's world Y
 * @param {number} worldZ - Block's world Z
 * @param {number} cornerX - Corner offset (0 or 1)
 * @param {number} cornerZ - Corner offset (0 or 1)
 * @param {Uint8Array} isFluidLookup - Lookup table for fluid types
 * @param {number} fluidType - FLUID_WATER or FLUID_LAVA
 * @param {Uint8Array} isOpaqueLookup - Lookup table for opaque blocks
 * @returns {number} Interpolated height at this corner
 */
export function getCornerHeight(grid, worldX, worldY, worldZ, cornerX, cornerZ, isFluidLookup, fluidType, isOpaqueLookup) {
  // The corner at world position (worldX + cornerX, worldZ + cornerZ)
  // is shared by 4 blocks. We need to find which 4 blocks.
  
  const cx = worldX + cornerX;
  const cz = worldZ + cornerZ;
  
  // The 4 blocks sharing this corner are:
  // (cx-1, cz-1), (cx, cz-1), (cx-1, cz), (cx, cz)
  const blocks = [
    [cx - 1, cz - 1],
    [cx, cz - 1],
    [cx - 1, cz],
    [cx, cz],
  ];
  
  let totalHeight = 0;
  let count = 0;
  
  for (const [bx, bz] of blocks) {
    const h = getEffectiveHeight(grid, bx, worldY, bz, isFluidLookup, fluidType);
    
    if (h >= 0) {
      // Block has fluid of the same type
      // If any block has fluid above (h = 1.0), the corner is fully submerged
      if (h >= 1.0) {
        return 1.0;
      }
      totalHeight += h;
      count++;
    } else {
      // Block doesn't have this fluid - check if it's solid or air
      // In Minecraft's algorithm:
      // - Solid blocks are NOT counted (they don't affect the average)
      // - Air/non-solid blocks count as height 0 (this creates the slopes!)
      if (!isSolidBlock(grid, bx, worldY, bz, isOpaqueLookup)) {
        // Air or non-solid block - count as height 0
        totalHeight += 0;
        count++;
      }
      // Solid blocks: don't add to count, don't affect average
    }
  }
  
  if (count === 0) {
    // All 4 blocks are solid (shouldn't happen for rendered water, but fallback)
    return getFluidHeight(getFluidLevel(grid, worldX, worldY, worldZ, isFluidLookup, fluidType));
  }
  
  return totalHeight / count;
}

/**
 * Calculate flow direction vector for a fluid block
 * Used to orient the water_flow/lava_flow texture
 * 
 * This follows Minecraft's FlowingFluid.getFlow() algorithm:
 * 1. For each cardinal direction, calculate height difference
 * 2. If a direction has a "drop" (air below neighbor), bias flow towards it
 * 3. The result is a normalized direction vector
 * 
 * @param {BinaryGrid} grid - The block grid
 * @param {number} worldX - Block's world X
 * @param {number} worldY - Block's world Y
 * @param {number} worldZ - Block's world Z
 * @param {Uint8Array} isFluidLookup - Lookup table for fluid types
 * @param {number} fluidType - FLUID_WATER or FLUID_LAVA
 * @returns {{x: number, z: number}} Normalized flow direction vector
 */
export function getFlowDirection(grid, worldX, worldY, worldZ, isFluidLookup, fluidType) {
  const centerLevel = getFluidLevel(grid, worldX, worldY, worldZ, isFluidLookup, fluidType);
  if (centerLevel < 0) return { x: 0, z: 0 };
  
  // Falling fluid has no horizontal flow direction
  if (centerLevel >= 8) return { x: 0, z: 0 };
  
  let flowX = 0;
  let flowZ = 0;
  
  // Check each cardinal direction
  const directions = [
    { dx: 1, dz: 0 },   // +X (east)
    { dx: -1, dz: 0 },  // -X (west)
    { dx: 0, dz: 1 },   // +Z (south)
    { dx: 0, dz: -1 },  // -Z (north)
  ];
  
  for (const { dx, dz } of directions) {
    const nx = worldX + dx;
    const nz = worldZ + dz;
    
    // Get neighbor level
    const neighborLevel = getFluidLevel(grid, nx, worldY, nz, isFluidLookup, fluidType);
    
    // Check if neighbor is empty or solid (can flow there?)
    const neighborBlock = grid.getBlock(nx, worldY, nz);
    const isNeighborBlocked = neighborBlock && neighborBlock.blockId !== 0 && 
      isFluidLookup[neighborBlock.blockId] !== fluidType;
    
    // Check if there's a drop (air below neighbor)
    const blockBelow = grid.getBlock(nx, worldY - 1, nz);
    const hasDrop = !blockBelow || blockBelow.blockId === 0 || 
      isFluidLookup[blockBelow.blockId] === fluidType;
    
    if (neighborLevel >= 0) {
      // Both have fluid - flow towards lower level
      const levelDiff = centerLevel - neighborLevel;
      // Positive diff = neighbor is higher level number = lower height
      // Water flows towards lower height (higher level number)
      flowX += dx * levelDiff;
      flowZ += dz * levelDiff;
    } else if (!isNeighborBlocked && hasDrop) {
      // Neighbor is empty with a drop - strong pull in that direction
      // This creates the "waterfall" effect
      flowX += dx * 2;
      flowZ += dz * 2;
    }
  }
  
  // Normalize
  const len = Math.sqrt(flowX * flowX + flowZ * flowZ);
  if (len > 0.0001) {
    flowX /= len;
    flowZ /= len;
  }
  
  return { x: flowX, z: flowZ };
}

/**
 * Convert flow direction to texture rotation (0-3 for 90° increments)
 * @param {{x: number, z: number}} flow - Flow direction vector
 * @returns {number} Rotation value 0-3
 * 
 * Minecraft's water_flow texture has arrows/stripes that animate "downward" in UV space.
 * On a top face with our UV layout:
 *   - UV (0,0) at (x, z), UV (1,0) at (x+1, z), UV (1,1) at (x+1, z+1), UV (0,1) at (x, z+1)
 *   - So +U = world +X, +V = world +Z
 *   - Default texture "down" (+V direction) = world +Z (south)
 * 
 * We rotate UV coordinates counterclockwise by 90° per step:
 *   - rot 0: no rotation, arrows point south (+Z)
 *   - rot 1: 90° CCW, arrows point east (+X)
 *   - rot 2: 180°, arrows point north (-Z)
 *   - rot 3: 270° CCW, arrows point west (-X)
 */
export function flowToRotation(flow) {
  if (Math.abs(flow.x) < 0.01 && Math.abs(flow.z) < 0.01) {
    return 0; // No flow - use default orientation
  }
  
  // Determine dominant flow direction
  const absX = Math.abs(flow.x);
  const absZ = Math.abs(flow.z);
  
  if (absZ >= absX) {
    // Primary flow is along Z axis
    return flow.z > 0 ? 0 : 2; // South (+Z) = 0, North (-Z) = 2
  } else {
    // Primary flow is along X axis
    return flow.x > 0 ? 1 : 3; // East (+X) = 1, West (-X) = 3
  }
}

/**
 * Rotate UV coordinates by 90° increments
 * @param {Array<[number, number]>} uvs - Array of 4 UV pairs
 * @param {number} rotation - Rotation 0-3 (0=0°, 1=90°, 2=180°, 3=270°)
 * @returns {Array<[number, number]>} Rotated UVs
 */
function rotateUVs(uvs, rotation) {
  if (rotation === 0) return uvs;
  
  // Rotate UVs around center (0.5, 0.5)
  const rotated = [];
  const cos = [1, 0, -1, 0][rotation];
  const sin = [0, 1, 0, -1][rotation];
  
  for (const [u, v] of uvs) {
    // Translate to origin, rotate, translate back
    const cu = u - 0.5;
    const cv = v - 0.5;
    const ru = cu * cos - cv * sin + 0.5;
    const rv = cu * sin + cv * cos + 0.5;
    rotated.push([ru, rv]);
  }
  
  return rotated;
}

/**
 * Check if a side face should be rendered
 * Don't render if:
 * - Neighbor is same fluid type (submerged)
 * - Neighbor is waterlogged (for water) - water connects through
 * - Neighbor is a full opaque cube (would z-fight)
 * 
 * DO render if:
 * - Neighbor is air/transparent
 * - Neighbor is a partial block (even if technically "opaque")
 */
function shouldRenderSide(grid, worldX, worldY, worldZ, dx, dy, dz, isFluidLookup, fluidType, isOpaqueLookup) {
  const nx = worldX + dx;
  const ny = worldY + dy;
  const nz = worldZ + dz;
  
  const block = grid.getBlock(nx, ny, nz);
  if (!block) return true; // Edge of world - render face
  
  // Don't render if neighbor is same fluid type (water connects to water)
  const ft = isFluidLookup[block.blockId];
  if (ft === fluidType) return false;
  
  // Don't render if neighbor is waterlogged (for water) - water connects through
  if (fluidType === FLUID_WATER && ft === 0 && block.level === 8) return false;
  
  // Check if neighbor is a full opaque cube (would cause z-fighting)
  // Only skip if the block is BOTH opaque AND a full cube (no model data suggesting partial block)
  // For now, we use a simple check: if opaque AND not waterlogged, skip the face
  // This prevents z-fighting with solid walls while allowing water to show through partial blocks
  if (isOpaqueLookup[block.blockId] && block.level !== 8) {
    return false;
  }
  
  return true;
}

/**
 * Build fluid meshes for a grid
 * 
 * @param {BinaryGrid} grid - The block grid
 * @param {Object} registry - Block registry
 * @param {Object} offset - World offset { x, y, z }
 * @param {Object} options - Mesh options
 * @param {Object} options.textureIndexLookup - Texture index lookup
 * @param {Object} options.lightGrid - Light grid for lighting data
 * @returns {{water: Object, lava: Object}} Mesh data for water and lava
 */
export function buildFluidMeshes(grid, registry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  const { textureIndexLookup = null, lightGrid = null } = options;
  
  const ox = offset.x;
  const oy = offset.y;
  const oz = offset.z;
  
  // Build lookup tables
  const isFluid = new Uint8Array(4096);
  const isOpaque = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info && info.name) {
      if (info.name.includes('water')) isFluid[id] = FLUID_WATER;
      else if (info.name.includes('lava')) isFluid[id] = FLUID_LAVA;
      isOpaque[id] = registry.isOpaque(id) ? 1 : 0;
    }
  }
  
  // Get texture indices for water and lava
  let waterStillIdx = 0;
  let waterFlowIdx = 0;
  let lavaStillIdx = 0;
  let lavaFlowIdx = 0;
  
  if (textureIndexLookup) {
    waterStillIdx = textureIndexLookup.getIndexByPath('block/water_still') || 0;
    waterFlowIdx = textureIndexLookup.getIndexByPath('block/water_flow') || waterStillIdx;
    lavaStillIdx = textureIndexLookup.getIndexByPath('block/lava_still') || 0;
    lavaFlowIdx = textureIndexLookup.getIndexByPath('block/lava_flow') || lavaStillIdx;
  }
  
  // Get colors for water and lava from registry
  // These are the EXACT Minecraft biome tint colors - no modifications
  // The shader will multiply by texture and lightmap for final appearance
  // Default water: #3F76E4 (most biomes)
  // Default lava: #FF6600 (no biome tinting, but we use this for solid color)
  let waterColor = { r: 0.247, g: 0.463, b: 0.894 }; // #3F76E4 - exact Minecraft default
  let lavaColor = { r: 1.0, g: 0.4, b: 0.0 }; // #FF6600 - Minecraft lava
  
  // Try to get colors from registry
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info && info.name) {
      if (info.name === 'minecraft:water' || info.name === 'water') {
        const col = registry.getColor(id);
        if (col) waterColor = col;
      }
      if (info.name === 'minecraft:lava' || info.name === 'lava') {
        const col = registry.getColor(id);
        if (col) lavaColor = col;
      }
    }
  }
  
  // Mesh buffers for water
  let wPos = new Float32Array(INITIAL_VERTICES * 3);
  let wNorm = new Float32Array(INITIAL_VERTICES * 3);
  let wCol = new Float32Array(INITIAL_VERTICES * 3); // Colors for backwards compat
  let wUV = new Float32Array(INITIAL_VERTICES * 2);
  let wTexIdx = new Float32Array(INITIAL_VERTICES);
  let wSkyLight = new Float32Array(INITIAL_VERTICES);
  let wBlockLight = new Float32Array(INITIAL_VERTICES);
  let wIdx = new Uint32Array(INITIAL_VERTICES * 2);
  let wVC = 0, wIC = 0;
  let wCapacity = INITIAL_VERTICES;
  
  // Mesh buffers for lava
  let lPos = new Float32Array(INITIAL_VERTICES * 3);
  let lNorm = new Float32Array(INITIAL_VERTICES * 3);
  let lCol = new Float32Array(INITIAL_VERTICES * 3); // Colors for backwards compat
  let lUV = new Float32Array(INITIAL_VERTICES * 2);
  let lTexIdx = new Float32Array(INITIAL_VERTICES);
  let lSkyLight = new Float32Array(INITIAL_VERTICES);
  let lBlockLight = new Float32Array(INITIAL_VERTICES);
  let lIdx = new Uint32Array(INITIAL_VERTICES * 2);
  let lVC = 0, lIC = 0;
  let lCapacity = INITIAL_VERTICES;
  
  // Helper to grow arrays
  function growArrays(type) {
    if (type === 'w') {
      const newCap = wCapacity * 2;
      const newPos = new Float32Array(newCap * 3);
      const newNorm = new Float32Array(newCap * 3);
      const newCol = new Float32Array(newCap * 3);
      const newUV = new Float32Array(newCap * 2);
      const newTexIdx = new Float32Array(newCap);
      const newSkyLight = new Float32Array(newCap);
      const newBlockLight = new Float32Array(newCap);
      const newIdx = new Uint32Array(newCap * 2);
      newPos.set(wPos); newNorm.set(wNorm); newCol.set(wCol); newUV.set(wUV);
      newTexIdx.set(wTexIdx); newSkyLight.set(wSkyLight); newBlockLight.set(wBlockLight);
      newIdx.set(wIdx);
      wPos = newPos; wNorm = newNorm; wCol = newCol; wUV = newUV;
      wTexIdx = newTexIdx; wSkyLight = newSkyLight; wBlockLight = newBlockLight;
      wIdx = newIdx; wCapacity = newCap;
    } else {
      const newCap = lCapacity * 2;
      const newPos = new Float32Array(newCap * 3);
      const newNorm = new Float32Array(newCap * 3);
      const newCol = new Float32Array(newCap * 3);
      const newUV = new Float32Array(newCap * 2);
      const newTexIdx = new Float32Array(newCap);
      const newSkyLight = new Float32Array(newCap);
      const newBlockLight = new Float32Array(newCap);
      const newIdx = new Uint32Array(newCap * 2);
      newPos.set(lPos); newNorm.set(lNorm); newCol.set(lCol); newUV.set(lUV);
      newTexIdx.set(lTexIdx); newSkyLight.set(lSkyLight); newBlockLight.set(lBlockLight);
      newIdx.set(lIdx);
      lPos = newPos; lNorm = newNorm; lCol = newCol; lUV = newUV;
      lTexIdx = newTexIdx; lSkyLight = newSkyLight; lBlockLight = newBlockLight;
      lIdx = newIdx; lCapacity = newCap;
    }
  }
  
  // Ensure capacity for N quads (4 vertices, 6 indices each)
  function ensureCapacity(type, quads) {
    const needed = quads * 4;
    if (type === 'w') {
      while (wVC + needed > wCapacity) growArrays('w');
    } else {
      while (lVC + needed > lCapacity) growArrays('l');
    }
  }
  
  // Get light at position
  function getLight(worldX, worldY, worldZ) {
    if (!lightGrid) return { sky: 15, block: 0 };
    const light = lightGrid.getLight(worldX, worldY, worldZ);
    return { sky: light.sky, block: light.block };
  }
  
  /**
   * Emit a quad for a fluid face
   */
  function emitQuad(fluidType, positions, normal, uvs, texIdx, lightData) {
    const isWater = fluidType === FLUID_WATER;
    ensureCapacity(isWater ? 'w' : 'l', 1);
    
    if (isWater) {
      const pi = wVC * 3;
      const ui = wVC * 2;
      const sv = wVC;
      
      for (let v = 0; v < 4; v++) {
        wPos[pi + v * 3] = positions[v][0];
        wPos[pi + v * 3 + 1] = positions[v][1];
        wPos[pi + v * 3 + 2] = positions[v][2];
        wNorm[pi + v * 3] = normal[0];
        wNorm[pi + v * 3 + 1] = normal[1];
        wNorm[pi + v * 3 + 2] = normal[2];
        wCol[pi + v * 3] = waterColor.r;
        wCol[pi + v * 3 + 1] = waterColor.g;
        wCol[pi + v * 3 + 2] = waterColor.b;
        wUV[ui + v * 2] = uvs[v][0];
        wUV[ui + v * 2 + 1] = uvs[v][1];
        wTexIdx[wVC + v] = texIdx;
        wSkyLight[wVC + v] = lightData[v].sky;
        wBlockLight[wVC + v] = lightData[v].block;
      }
      
      // Two triangles: 0-1-2, 0-2-3
      wIdx[wIC++] = sv;
      wIdx[wIC++] = sv + 1;
      wIdx[wIC++] = sv + 2;
      wIdx[wIC++] = sv;
      wIdx[wIC++] = sv + 2;
      wIdx[wIC++] = sv + 3;
      wVC += 4;
    } else {
      const pi = lVC * 3;
      const ui = lVC * 2;
      const sv = lVC;
      
      for (let v = 0; v < 4; v++) {
        lPos[pi + v * 3] = positions[v][0];
        lPos[pi + v * 3 + 1] = positions[v][1];
        lPos[pi + v * 3 + 2] = positions[v][2];
        lNorm[pi + v * 3] = normal[0];
        lNorm[pi + v * 3 + 1] = normal[1];
        lNorm[pi + v * 3 + 2] = normal[2];
        lCol[pi + v * 3] = lavaColor.r;
        lCol[pi + v * 3 + 1] = lavaColor.g;
        lCol[pi + v * 3 + 2] = lavaColor.b;
        lUV[ui + v * 2] = uvs[v][0];
        lUV[ui + v * 2 + 1] = uvs[v][1];
        lTexIdx[lVC + v] = texIdx;
        lSkyLight[lVC + v] = lightData[v].sky;
        lBlockLight[lVC + v] = lightData[v].block;
      }
      
      lIdx[lIC++] = sv;
      lIdx[lIC++] = sv + 1;
      lIdx[lIC++] = sv + 2;
      lIdx[lIC++] = sv;
      lIdx[lIC++] = sv + 2;
      lIdx[lIC++] = sv + 3;
      lVC += 4;
    }
  }
  
  // Process each section
  for (const [key, section] of grid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
    const baseX = chunkX * S;
    const baseY = sectionToWorldY(sectionY);
    const baseZ = chunkZ * S;
    
    // Scan all blocks in section
    for (let ly = 0; ly < S; ly++) {
      const worldY = baseY + ly;
      const sliceBase = ly * S2;
      
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = sliceBase + lz * S + lx;
          const value = section[idx];
          if (value === 0) continue;
          
          const blockId = value & BLOCK_ID_MASK;
          const level = (value & LEVEL_MASK) >> LEVEL_SHIFT;
          const fluidType = isFluid[blockId];
          
          // Check for waterlogged blocks
          const isWaterlogged = (fluidType === 0 && level === 8);
          const effectiveFluidType = isWaterlogged ? FLUID_WATER : fluidType;
          const effectiveLevel = isWaterlogged ? 0 : level;
          
          if (effectiveFluidType === 0) continue;
          
          const worldX = baseX + lx;
          const worldZ = baseZ + lz;
          const x = worldX - ox;
          const y = worldY - oy;
          const z = worldZ - oz;
          
          // Check if there's fluid above (no top face needed - water connects)
          const fluidAbove = hasFluidAbove(grid, worldX, worldY, worldZ, isFluid, effectiveFluidType);
          // Check if block above is waterlogged (water connects through - treat as fluid above)
          const blockAbove = grid.getBlock(worldX, worldY + 1, worldZ);
          const waterloggedAbove = blockAbove && blockAbove.level === 8 && effectiveFluidType === FLUID_WATER;
          // NOTE: We DON'T skip for opaque blocks above - partial blocks (fences, chains, plants)
          // extend above water and we still want to see the water surface beneath them
          const skipTopFace = fluidAbove || waterloggedAbove;
          
          // Calculate flow direction for flowing textures
          const flow = getFlowDirection(grid, worldX, worldY, worldZ, isFluid, effectiveFluidType);
          const hasFlow = Math.abs(flow.x) > 0.01 || Math.abs(flow.z) > 0.01;
          
          // Determine which texture to use
          const stillIdx = effectiveFluidType === FLUID_WATER ? waterStillIdx : lavaStillIdx;
          const flowIdx = effectiveFluidType === FLUID_WATER ? waterFlowIdx : lavaFlowIdx;
          
          // Get light at this block
          const light = getLight(worldX, worldY, worldZ);
          const lightData = [light, light, light, light]; // Same light for all 4 vertices
          
          // === TOP FACE ===
          if (!skipTopFace) {
            // Calculate corner heights
            const h00 = getCornerHeight(grid, worldX, worldY, worldZ, 0, 0, isFluid, effectiveFluidType, isOpaque);
            const h10 = getCornerHeight(grid, worldX, worldY, worldZ, 1, 0, isFluid, effectiveFluidType, isOpaque);
            const h11 = getCornerHeight(grid, worldX, worldY, worldZ, 1, 1, isFluid, effectiveFluidType, isOpaque);
            const h01 = getCornerHeight(grid, worldX, worldY, worldZ, 0, 1, isFluid, effectiveFluidType, isOpaque);
            
            // Vertex positions (counter-clockwise from above)
            const positions = [
              [x, y + h00, z],         // 0: corner (0,0)
              [x + 1, y + h10, z],     // 1: corner (1,0)
              [x + 1, y + h11, z + 1], // 2: corner (1,1)
              [x, y + h01, z + 1],     // 3: corner (0,1)
            ];
            
            // Calculate normal from the angled surface
            // Use cross product of diagonals
            const v1 = [positions[2][0] - positions[0][0], positions[2][1] - positions[0][1], positions[2][2] - positions[0][2]];
            const v2 = [positions[3][0] - positions[1][0], positions[3][1] - positions[1][1], positions[3][2] - positions[1][2]];
            const normal = [
              v1[1] * v2[2] - v1[2] * v2[1],
              v1[2] * v2[0] - v1[0] * v2[2],
              v1[0] * v2[1] - v1[1] * v2[0],
            ];
            const len = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
            if (len > 0) {
              normal[0] /= len;
              normal[1] /= len;
              normal[2] /= len;
            } else {
              normal[0] = 0;
              normal[1] = 1;
              normal[2] = 0;
            }
            
            // UVs - use flowing texture if there's flow, rotated to match flow direction
            const texIdx = hasFlow ? flowIdx : stillIdx;
            let uvs = [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ];
            
            // Rotate UVs to align texture with flow direction
            if (hasFlow) {
              const rotation = flowToRotation(flow);
              uvs = rotateUVs(uvs, rotation);
            }
            
            emitQuad(effectiveFluidType, positions, normal, uvs, texIdx, lightData);
          }
          
          // === SIDE FACES ===
          const blockHeight = getFluidHeight(effectiveLevel);
          const topY = fluidAbove ? 1.0 : blockHeight;
          
          // +X face (east)
          if (shouldRenderSide(grid, worldX, worldY, worldZ, 1, 0, 0, isFluid, effectiveFluidType, isOpaque)) {
            const h0 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 1, 0, isFluid, effectiveFluidType, isOpaque);
            const h1 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 1, 1, isFluid, effectiveFluidType, isOpaque);
            
            const positions = [
              [x + 1, y, z],
              [x + 1, y, z + 1],
              [x + 1, y + h1, z + 1],
              [x + 1, y + h0, z],
            ];
            const uvs = [[0, 1], [1, 1], [1, 1 - h1], [0, 1 - h0]];
            emitQuad(effectiveFluidType, positions, [1, 0, 0], uvs, flowIdx, lightData);
          }
          
          // -X face (west)
          if (shouldRenderSide(grid, worldX, worldY, worldZ, -1, 0, 0, isFluid, effectiveFluidType, isOpaque)) {
            const h0 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 0, 1, isFluid, effectiveFluidType, isOpaque);
            const h1 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 0, 0, isFluid, effectiveFluidType, isOpaque);
            
            const positions = [
              [x, y, z + 1],
              [x, y, z],
              [x, y + h1, z],
              [x, y + h0, z + 1],
            ];
            const uvs = [[0, 1], [1, 1], [1, 1 - h1], [0, 1 - h0]];
            emitQuad(effectiveFluidType, positions, [-1, 0, 0], uvs, flowIdx, lightData);
          }
          
          // +Z face (south)
          if (shouldRenderSide(grid, worldX, worldY, worldZ, 0, 0, 1, isFluid, effectiveFluidType, isOpaque)) {
            const h0 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 1, 1, isFluid, effectiveFluidType, isOpaque);
            const h1 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 0, 1, isFluid, effectiveFluidType, isOpaque);
            
            const positions = [
              [x + 1, y, z + 1],
              [x, y, z + 1],
              [x, y + h1, z + 1],
              [x + 1, y + h0, z + 1],
            ];
            const uvs = [[0, 1], [1, 1], [1, 1 - h1], [0, 1 - h0]];
            emitQuad(effectiveFluidType, positions, [0, 0, 1], uvs, flowIdx, lightData);
          }
          
          // -Z face (north)
          if (shouldRenderSide(grid, worldX, worldY, worldZ, 0, 0, -1, isFluid, effectiveFluidType, isOpaque)) {
            const h0 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 0, 0, isFluid, effectiveFluidType, isOpaque);
            const h1 = fluidAbove ? 1.0 : getCornerHeight(grid, worldX, worldY, worldZ, 1, 0, isFluid, effectiveFluidType, isOpaque);
            
            const positions = [
              [x, y, z],
              [x + 1, y, z],
              [x + 1, y + h1, z],
              [x, y + h0, z],
            ];
            const uvs = [[0, 1], [1, 1], [1, 1 - h1], [0, 1 - h0]];
            emitQuad(effectiveFluidType, positions, [0, 0, -1], uvs, flowIdx, lightData);
          }
          
          // === BOTTOM FACE ===
          // Only render if no fluid/waterlogged below AND no opaque block below (would z-fight)
          const blockBelow = grid.getBlock(worldX, worldY - 1, worldZ);
          const fluidBelow = getFluidLevel(grid, worldX, worldY - 1, worldZ, isFluid, effectiveFluidType) >= 0;
          // Check if block below is waterlogged (water connects through)
          const waterloggedBelow = blockBelow && blockBelow.level === 8 && effectiveFluidType === FLUID_WATER;
          const opaqueBelow = blockBelow && isOpaque[blockBelow.blockId] && !waterloggedBelow;
          if (!fluidBelow && !waterloggedBelow && !opaqueBelow) {
            const positions = [
              [x, y, z + 1],
              [x + 1, y, z + 1],
              [x + 1, y, z],
              [x, y, z],
            ];
            const uvs = [[0, 1], [1, 1], [1, 0], [0, 0]];
            emitQuad(effectiveFluidType, positions, [0, -1, 0], uvs, stillIdx, lightData);
          }
        }
      }
    }
  }
  
  // Build final mesh data
  function buildMeshData(pos, norm, col, uv, texIdx, skyLight, blockLight, idx, vertexCount, indexCount) {
    if (vertexCount === 0) return null;
    
    return {
      positions: pos.subarray(0, vertexCount * 3),
      normals: norm.subarray(0, vertexCount * 3),
      colors: col.subarray(0, vertexCount * 3), // For backwards compat with simple materials
      uvs: uv.subarray(0, vertexCount * 2),
      texIndices: texIdx.subarray(0, vertexCount),
      skyLight: skyLight.subarray(0, vertexCount),
      blockLight: blockLight.subarray(0, vertexCount),
      indices: idx.subarray(0, indexCount),
      vertexCount,
      triangleCount: indexCount / 3,
    };
  }
  
  return {
    water: buildMeshData(wPos, wNorm, wCol, wUV, wTexIdx, wSkyLight, wBlockLight, wIdx, wVC, wIC),
    lava: buildMeshData(lPos, lNorm, lCol, lUV, lTexIdx, lSkyLight, lBlockLight, lIdx, lVC, lIC),
  };
}

export default buildFluidMeshes;

