/**
 * FastMesher - Ultra-optimized single-pass greedy mesher
 * 
 * Key optimization: Single pass through blocks, build all 6 face masks at once
 */

import { BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, SLAB_MASK, SLAB_SHIFT, SLAB_DOUBLE, sectionToWorldY, makeSectionKey, parseSectionKey } from './BinaryGrid.js';
import { FACE_UP, FACE_DOWN, FACE_NORTH, FACE_SOUTH, FACE_EAST, FACE_WEST } from '../assets/TextureIndexLookup.js';
import { AXIS_Y, AXIS_X, AXIS_Z, AXIS_SHIFT, AXIS_MASK } from './ChunkDecoder.js';
import { getBakedModelLoader } from './BakedModelLoader.js';
import { buildFaceTintTypeLookup, TINT_TYPE } from '../data/biomeTinting.js';
import { getRandomRotationRegistry } from '../assets/RandomRotationRegistry.js';
import { buildFluidMeshes } from './FluidMesher.js';
import { AO_BRIGHTNESS, calculateCornerAO, shouldFlipQuadTriangulation } from './AmbientOcclusion.js';

const S = 16;
const S2 = 256;
const S3 = 4096;

// ============================================================================
// LOOKUP TABLE CACHE
// Caches expensive-to-build lookup tables per registry instance
// ============================================================================
let cachedRegistry = null;
let cachedTextureIndexLookup = null;
let cachedLookupTables = null;

function getCachedLookupTables(registry, textureIndexLookup) {
  // Return cached tables if registry and textureIndexLookup haven't changed
  if (cachedRegistry === registry && cachedTextureIndexLookup === textureIndexLookup && cachedLookupTables) {
    return cachedLookupTables;
  }
  
  // Build new lookup tables
  const isOpaque = new Uint8Array(4096);
  const isNonCube = new Uint8Array(4096);
  const isSlab = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  const isFluid = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096);
  const isLeaves = new Uint8Array(4096); // Leaves render before water (unlike glass which renders after)
  const isRotatable = new Uint8Array(4096);
  const hasRandomRotation = new Uint8Array(4096);
  const isTopOnlyRotation = new Uint8Array(4096);
  const isHalfRotation = new Uint8Array(4096);
  const needsSideOverlay = new Uint8Array(4096);
  const sideOverlayTexIdx = new Float32Array(4096);
  const isAOTransparent = new Uint8Array(4096);
  
  const randomRotationRegistry = getRandomRotationRegistry();
  const faceTintTypeLookup = buildFaceTintTypeLookup(registry);
  const bakedLoader = getBakedModelLoader();
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info) {
      isOpaque[id] = registry.isOpaque(id) ? 1 : 0;
      isNonCube[id] = registry.isNonCube(id) ? 1 : 0;
      const col = registry.getColor(id);
      colorR[id] = col.r;
      colorG[id] = col.g;
      colorB[id] = col.b;
      if (info.name) {
        const blockName = info.name.replace('minecraft:', '');
        
        // Fluid detection
        if (blockName.includes('water')) isFluid[id] = 1;
        else if (blockName.includes('lava')) isFluid[id] = 2;
        
        // Glass/leaves detection for render pass sorting
        if ((blockName.includes('glass') && !blockName.includes('_pane')) || blockName.includes('ice')) {
          isGlass[id] = 1;
        } else if (blockName.includes('leaves')) {
          isLeaves[id] = 1;
        }
        
        // Slab detection
        if (blockName.includes('_slab')) {
          isSlab[id] = 1;
        }
        
        // Axis rotation (logs, pillars) from baked data
        if (bakedLoader.hasAxisRotation(blockName)) {
          isRotatable[id] = 1;
        }
        
        // Random rotation from baked data
        if (bakedLoader.hasRandomRotation(blockName)) {
          hasRandomRotation[id] = 1;
          // Top-only and half rotation still need registry for detailed info
          if (randomRotationRegistry.isTopOnlyRotation(blockName)) {
            isTopOnlyRotation[id] = 1;
          }
          if (randomRotationRegistry.isHalfRotation(blockName)) {
            isHalfRotation[id] = 1;
          }
        }
        
        // AO transparency from baked data
        if (bakedLoader.isTransparent(blockName) || registry.isNonCube(id)) {
          isAOTransparent[id] = 1;
        }
        
        // Side overlay (grass_block side overlay)
        if (blockName === 'grass_block' && textureIndexLookup) {
          needsSideOverlay[id] = 1;
          sideOverlayTexIdx[id] = textureIndexLookup.getIndexByPath('block/grass_block_side_overlay');
        }
      }
    }
  }
  
  cachedLookupTables = {
    isOpaque,
    isNonCube,
    isSlab,
    colorR,
    colorG,
    colorB,
    isFluid,
    isGlass,
    isRotatable,
    hasRandomRotation,
    isTopOnlyRotation,
    isHalfRotation,
    needsSideOverlay,
    sideOverlayTexIdx,
    isAOTransparent,
    isLeaves,
    faceTintTypeLookup,
  };
  cachedRegistry = registry;
  cachedTextureIndexLookup = textureIndexLookup;
  
  return cachedLookupTables;
}

/**
 * Sample smooth light at a corner position by averaging neighboring blocks
 * Minecraft's smooth lighting averages light from the 4 blocks touching each vertex corner
 * 
 * Blocks that are transparent for AO purposes (don't block smooth lighting):
 * - Air (blockId 0)
 * - Glass, ice, leaves, slime, honey
 * - Non-cube blocks (slabs, stairs, fences, etc.)
 * - Fluids (water, lava)
 * 
 * @param {LightGrid} lightGrid - The light grid
 * @param {number} x - Corner X position (integer vertex position)
 * @param {number} y - Corner Y position 
 * @param {number} z - Corner Z position
 * @param {number} nx - Face normal X (-1, 0, or 1)
 * @param {number} ny - Face normal Y (-1, 0, or 1)
 * @param {number} nz - Face normal Z (-1, 0, or 1)
 * @param {BinaryGrid} blockGrid - Block grid for solid block detection
 * @param {Uint8Array} isOpaque - Opaque block lookup
 * @param {Uint8Array} isAOTransparent - Blocks that don't block AO (glass, leaves, non-cube, etc.)
 * @returns {{ skyLight: number, blockLight: number }}
 */
/**
 * Sample smooth light for a vertex with Minecraft-style AO
 * 
 * This samples light from the 4 blocks touching the vertex corner,
 * then applies AO based on the 3-neighbor algorithm.
 * 
 * @param {LightGrid} lightGrid - Light data
 * @param {number} x, y, z - Vertex position (corner of face, in air space)
 * @param {number} aoLevel - Pre-computed AO level (0-3) from getVertexAO
 * @param {BinaryGrid} blockGrid - Block data
 * @param {Uint8Array} isOpaque - Opaque block lookup
 * @param {Uint8Array} isAOTransparent - AO-transparent block lookup
 * @param {string} plane - 'xz', 'yz', or 'xy' - the sampling plane
 * @returns {{skyLight: number, blockLight: number}} Light values with AO applied
 */
function sampleVertexLight(lightGrid, x, y, z, aoLevel, blockGrid, isOpaque, isAOTransparent, plane) {
  const isSolidForAO = (blockId) => {
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  // Sample light from 4 blocks touching this vertex corner
  // Average light from non-solid blocks only
  let totalSky = 0;
  let totalBlock = 0;
  let count = 0;
  
  if (plane === 'xz') {
    // Top/Bottom face - sample in XZ plane
    for (let dx = -1; dx <= 0; dx++) {
      for (let dz = -1; dz <= 0; dz++) {
        const blockId = blockGrid.getBlockId(x + dx, y, z + dz);
        if (!isSolidForAO(blockId)) {
          const light = lightGrid.getLight(x + dx, y, z + dz);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          count++;
        }
      }
    }
  } else if (plane === 'yz') {
    // East/West face - sample in YZ plane
    for (let dy = -1; dy <= 0; dy++) {
      for (let dz = -1; dz <= 0; dz++) {
        const blockId = blockGrid.getBlockId(x, y + dy, z + dz);
        if (!isSolidForAO(blockId)) {
          const light = lightGrid.getLight(x, y + dy, z + dz);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          count++;
        }
      }
    }
  } else {
    // North/South face - sample in XY plane
    for (let dx = -1; dx <= 0; dx++) {
      for (let dy = -1; dy <= 0; dy++) {
        const blockId = blockGrid.getBlockId(x + dx, y + dy, z);
        if (!isSolidForAO(blockId)) {
          const light = lightGrid.getLight(x + dx, y + dy, z);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          count++;
        }
      }
    }
  }
  
  // Get average light, or fallback to direct sample
  let avgSky, avgBlock;
  if (count > 0) {
    avgSky = totalSky / count;
    avgBlock = totalBlock / count;
  } else {
    // All sampled positions are solid - vertex is in a corner
    // Use the face position's light value as fallback
    const light = lightGrid.getLight(x, y, z);
    avgSky = light.skyLight;
    avgBlock = light.blockLight;
  }
  
  // Apply AO brightness multiplier
  // Minecraft's AO creates subtle shadows, not harsh darkness
  // Values based on actual Minecraft rendering analysis:
  // AO 0 = both sides blocked (corner) = 50% brightness
  // AO 1 = 2 neighbors blocked = 70%
  // AO 2 = 1 neighbor blocked = 85%
  // AO 3 = fully exposed = 100%
  const aoBrightness = [0.2, 0.6, 0.8, 1.0];
  const ao = aoBrightness[aoLevel];
  
  return {
    skyLight: avgSky * ao,
    blockLight: avgBlock * ao,
  };
}

/**
 * Legacy wrapper for smooth light sampling (used by non-TOP faces)
 * Computes AO using a simplified 4-block count method for backward compatibility
 */
function sampleSmoothLight(lightGrid, x, y, z, nx, ny, nz, blockGrid, isOpaque, isAOTransparent) {
  const isSolidForAO = (blockId) => {
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  let solidCount = 0;
  let totalSky = 0;
  let totalBlock = 0;
  let airCount = 0;
  
  // Sample 4 blocks in the plane perpendicular to the normal
  if (ny !== 0) {
    for (let dx = -1; dx <= 0; dx++) {
      for (let dz = -1; dz <= 0; dz++) {
        const blockId = blockGrid.getBlockId(x + dx, y, z + dz);
        if (isSolidForAO(blockId)) {
          solidCount++;
        } else {
          const light = lightGrid.getLight(x + dx, y, z + dz);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          airCount++;
        }
      }
    }
  } else if (nx !== 0) {
    for (let dy = -1; dy <= 0; dy++) {
      for (let dz = -1; dz <= 0; dz++) {
        const blockId = blockGrid.getBlockId(x, y + dy, z + dz);
        if (isSolidForAO(blockId)) {
          solidCount++;
        } else {
          const light = lightGrid.getLight(x, y + dy, z + dz);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          airCount++;
        }
      }
    }
  } else {
    for (let dx = -1; dx <= 0; dx++) {
      for (let dy = -1; dy <= 0; dy++) {
        const blockId = blockGrid.getBlockId(x + dx, y + dy, z);
        if (isSolidForAO(blockId)) {
          solidCount++;
        } else {
          const light = lightGrid.getLight(x + dx, y + dy, z);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          airCount++;
        }
      }
    }
  }
  
  // Convert 4-block count to AO level (0-3)
  // 0 solid → AO 3, 1 solid → AO 2, 2 solid → AO 1, 3-4 solid → AO 0
  const aoLevel = Math.max(0, 3 - solidCount);
  const aoBrightness = [0.2, 0.6, 0.8, 1.0];
  const ao = aoBrightness[aoLevel];
  
  let avgSky, avgBlock;
  if (airCount > 0) {
    avgSky = totalSky / airCount;
    avgBlock = totalBlock / airCount;
  } else {
    // All sampled positions are solid - use the face position's light
    const light = lightGrid.getLight(x, y, z);
    avgSky = light.skyLight;
    avgBlock = light.blockLight;
  }
  
  return {
    skyLight: avgSky * ao,
    blockLight: avgBlock * ao,
  };
}

/**
 * Get AO for all 4 vertices of a TOP face at block position (blockX, blockY, blockZ)
 * 
 * For a TOP face, we check blocks at Y = blockY + 1 (the face level, which should be air above our block).
 * Each vertex corner is influenced by 3 adjacent blocks: side1, side2, and corner (diagonal).
 * 
 * Face vertices (looking down at top face from above):
 *   V0 ---- V1      V0 = (-X, +Z) corner = southwest
 *    |      |       V1 = (+X, +Z) corner = southeast
 *    |      |       V2 = (+X, -Z) corner = northeast
 *   V3 ---- V2      V3 = (-X, -Z) corner = northwest
 * 
 * For each vertex, the 3 neighbors to check are determined by which corner it occupies:
 * - V0 (SW): check blocks at West (-1,0), South (0,+1), and Southwest (-1,+1)
 * - V1 (SE): check blocks at East (+1,0), South (0,+1), and Southeast (+1,+1)
 * - V2 (NE): check blocks at East (+1,0), North (0,-1), and Northeast (+1,-1)
 * - V3 (NW): check blocks at West (-1,0), North (0,-1), and Northwest (-1,-1)
 */
function getTopFaceAO(blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent) {
  const y = blockY + 1; // Sample in air space above block (the face level)
  
  // Helper function to check if a block is solid for AO purposes
  const isSolidForAO = (bx, by, bz) => {
    const blockId = blockGrid.getBlockId(bx, by, bz);
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  // Compute AO level for a vertex given two side offsets (in XZ plane)
  // corner is automatically computed as side1 + side2
  const computeAO = (side1X, side1Z, side2X, side2Z) => {
    const side1 = isSolidForAO(blockX + side1X, y, blockZ + side1Z);
    const side2 = isSolidForAO(blockX + side2X, y, blockZ + side2Z);
    
    // Minecraft behavior: if both sides are solid, corner is fully occluded
    if (side1 && side2) return 0;
    
    const corner = isSolidForAO(blockX + side1X + side2X, y, blockZ + side1Z + side2Z);
    return 3 - (side1 ? 1 : 0) - (side2 ? 1 : 0) - (corner ? 1 : 0);
  };
  
  // V0: corner at (-X, +Z) - check West and South
  const ao0 = computeAO(-1, 0, 0, 1);
  
  // V1: corner at (+X, +Z) - check East and South
  const ao1 = computeAO(1, 0, 0, 1);
  
  // V2: corner at (+X, -Z) - check East and North
  const ao2 = computeAO(1, 0, 0, -1);
  
  // V3: corner at (-X, -Z) - check West and North
  const ao3 = computeAO(-1, 0, 0, -1);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Get AO for all 4 vertices of a BOTTOM face (-Y normal)
 * 
 * Face vertices (looking up from -Y):
 *     V0(x,y,z) ---------- V1(x+1,y,z)
 *          |                    |
 *          |      FACE          |
 *          |                    |
 *     V3(x,y,z+1) -------- V2(x+1,y,z+1)
 * 
 * Sample Y = blockY - 1 (one block below the solid block)
 */
function getBottomFaceAO(blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent) {
  const y = blockY - 1; // Sample in air space below block
  
  const isSolidForAO = (bx, by, bz) => {
    const blockId = blockGrid.getBlockId(bx, by, bz);
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  const n = isSolidForAO(blockX, y, blockZ - 1);
  const s = isSolidForAO(blockX, y, blockZ + 1);
  const e = isSolidForAO(blockX + 1, y, blockZ);
  const w = isSolidForAO(blockX - 1, y, blockZ);
  const ne = isSolidForAO(blockX + 1, y, blockZ - 1);
  const nw = isSolidForAO(blockX - 1, y, blockZ - 1);
  const se = isSolidForAO(blockX + 1, y, blockZ + 1);
  const sw = isSolidForAO(blockX - 1, y, blockZ + 1);
  
  // V0: corner at (-X, -Z) - check West and North
  const ao0 = calculateCornerAO(w, n, nw);
  // V1: corner at (+X, -Z) - check East and North
  const ao1 = calculateCornerAO(e, n, ne);
  // V2: corner at (+X, +Z) - check East and South
  const ao2 = calculateCornerAO(e, s, se);
  // V3: corner at (-X, +Z) - check West and South
  const ao3 = calculateCornerAO(w, s, sw);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Get AO for all 4 vertices of a NORTH face (-Z normal)
 * 
 * Face vertices (looking from -Z toward +Z):
 *     V0(x+w,y,z) ------- V1(x,y,z)
 *          |                    |
 *          |      FACE          |
 *          |                    |
 *     V3(x+w,y+h,z) ----- V2(x,y+h,z)
 * 
 * Sample Z = blockZ - 1 (one block in front of face)
 */
function getNorthFaceAO(blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent) {
  const z = blockZ - 1; // Sample in air space in front of face
  
  const isSolidForAO = (bx, by, bz) => {
    const blockId = blockGrid.getBlockId(bx, by, bz);
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  const u = isSolidForAO(blockX, blockY + 1, z);
  const d = isSolidForAO(blockX, blockY - 1, z);
  const e = isSolidForAO(blockX + 1, blockY, z);
  const w = isSolidForAO(blockX - 1, blockY, z);
  const ue = isSolidForAO(blockX + 1, blockY + 1, z);
  const uw = isSolidForAO(blockX - 1, blockY + 1, z);
  const de = isSolidForAO(blockX + 1, blockY - 1, z);
  const dw = isSolidForAO(blockX - 1, blockY - 1, z);
  
  // North face vertex order in FastMesher: V0(x+w, y, z), V1(x, y, z), V2(x, y+h, z), V3(x+w, y+h, z)
  // V0: corner at (+X, -Y) - check East and Down
  const ao0 = calculateCornerAO(e, d, de);
  // V1: corner at (-X, -Y) - check West and Down
  const ao1 = calculateCornerAO(w, d, dw);
  // V2: corner at (-X, +Y) - check West and Up
  const ao2 = calculateCornerAO(w, u, uw);
  // V3: corner at (+X, +Y) - check East and Up
  const ao3 = calculateCornerAO(e, u, ue);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Get AO for all 4 vertices of a SOUTH face (+Z normal)
 * 
 * Face vertices: V0(x, y, z+1), V1(x+w, y, z+1), V2(x+w, y+h, z+1), V3(x, y+h, z+1)
 * Sample Z = blockZ + 1 (one block behind face)
 */
function getSouthFaceAO(blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent) {
  const z = blockZ + 1; // Sample in air space behind face
  
  const isSolidForAO = (bx, by, bz) => {
    const blockId = blockGrid.getBlockId(bx, by, bz);
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  const u = isSolidForAO(blockX, blockY + 1, z);
  const d = isSolidForAO(blockX, blockY - 1, z);
  const e = isSolidForAO(blockX + 1, blockY, z);
  const w = isSolidForAO(blockX - 1, blockY, z);
  const ue = isSolidForAO(blockX + 1, blockY + 1, z);
  const uw = isSolidForAO(blockX - 1, blockY + 1, z);
  const de = isSolidForAO(blockX + 1, blockY - 1, z);
  const dw = isSolidForAO(blockX - 1, blockY - 1, z);
  
  // South face vertex order: V0(x, y, z+1), V1(x+w, y, z+1), V2(x+w, y+h, z+1), V3(x, y+h, z+1)
  // V0: corner at (-X, -Y) - check West and Down
  const ao0 = calculateCornerAO(w, d, dw);
  // V1: corner at (+X, -Y) - check East and Down
  const ao1 = calculateCornerAO(e, d, de);
  // V2: corner at (+X, +Y) - check East and Up
  const ao2 = calculateCornerAO(e, u, ue);
  // V3: corner at (-X, +Y) - check West and Up
  const ao3 = calculateCornerAO(w, u, uw);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Get AO for all 4 vertices of an EAST face (+X normal)
 * 
 * Face vertices: V0(x+1, y, z), V1(x+1, y+h, z), V2(x+1, y+h, z+w), V3(x+1, y, z+w)
 * Sample X = blockX + 1 (one block to the right of face)
 */
function getEastFaceAO(blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent) {
  const x = blockX + 1; // Sample in air space to the right of face
  
  const isSolidForAO = (bx, by, bz) => {
    const blockId = blockGrid.getBlockId(bx, by, bz);
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  const u = isSolidForAO(x, blockY + 1, blockZ);
  const d = isSolidForAO(x, blockY - 1, blockZ);
  const n = isSolidForAO(x, blockY, blockZ - 1);
  const s = isSolidForAO(x, blockY, blockZ + 1);
  const un = isSolidForAO(x, blockY + 1, blockZ - 1);
  const us = isSolidForAO(x, blockY + 1, blockZ + 1);
  const dn = isSolidForAO(x, blockY - 1, blockZ - 1);
  const ds = isSolidForAO(x, blockY - 1, blockZ + 1);
  
  // East face vertex order: V0(x+1, y, z), V1(x+1, y+h, z), V2(x+1, y+h, z+w), V3(x+1, y, z+w)
  // V0: corner at (-Z, -Y) - check North and Down
  const ao0 = calculateCornerAO(n, d, dn);
  // V1: corner at (-Z, +Y) - check North and Up
  const ao1 = calculateCornerAO(n, u, un);
  // V2: corner at (+Z, +Y) - check South and Up
  const ao2 = calculateCornerAO(s, u, us);
  // V3: corner at (+Z, -Y) - check South and Down
  const ao3 = calculateCornerAO(s, d, ds);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Get AO for all 4 vertices of a WEST face (-X normal)
 * 
 * Face vertices: V0(x, y, z+w), V1(x, y+h, z+w), V2(x, y+h, z), V3(x, y, z)
 * Sample X = blockX - 1 (one block to the left of face)
 */
function getWestFaceAO(blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent) {
  const x = blockX - 1; // Sample in air space to the left of face
  
  const isSolidForAO = (bx, by, bz) => {
    const blockId = blockGrid.getBlockId(bx, by, bz);
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  const u = isSolidForAO(x, blockY + 1, blockZ);
  const d = isSolidForAO(x, blockY - 1, blockZ);
  const n = isSolidForAO(x, blockY, blockZ - 1);
  const s = isSolidForAO(x, blockY, blockZ + 1);
  const un = isSolidForAO(x, blockY + 1, blockZ - 1);
  const us = isSolidForAO(x, blockY + 1, blockZ + 1);
  const dn = isSolidForAO(x, blockY - 1, blockZ - 1);
  const ds = isSolidForAO(x, blockY - 1, blockZ + 1);
  
  // West face vertex order: V0(x, y, z+w), V1(x, y+h, z+w), V2(x, y+h, z), V3(x, y, z)
  // V0: corner at (+Z, -Y) - check South and Down
  const ao0 = calculateCornerAO(s, d, ds);
  // V1: corner at (+Z, +Y) - check South and Up
  const ao1 = calculateCornerAO(s, u, us);
  // V2: corner at (-Z, +Y) - check North and Up
  const ao2 = calculateCornerAO(n, u, un);
  // V3: corner at (-Z, -Y) - check North and Down
  const ao3 = calculateCornerAO(n, d, dn);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Sample vertex light with proper 3-neighbor AO applied
 * This replaces the legacy sampleSmoothLight for all faces
 */
function sampleVertexLightWithAO(lightGrid, x, y, z, aoLevel, blockGrid, isOpaque, isAOTransparent, plane) {
  const isSolidForAO = (blockId) => {
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
  
  // Sample light from 4 blocks touching this vertex corner
  // Average light from non-solid blocks only
  let totalSky = 0;
  let totalBlock = 0;
  let count = 0;
  
  if (plane === 'xz') {
    // Top/Bottom face - sample in XZ plane
    for (let dx = -1; dx <= 0; dx++) {
      for (let dz = -1; dz <= 0; dz++) {
        const blockId = blockGrid.getBlockId(x + dx, y, z + dz);
        if (!isSolidForAO(blockId)) {
          const light = lightGrid.getLight(x + dx, y, z + dz);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          count++;
        }
      }
    }
  } else if (plane === 'yz') {
    // East/West face - sample in YZ plane
    for (let dy = -1; dy <= 0; dy++) {
      for (let dz = -1; dz <= 0; dz++) {
        const blockId = blockGrid.getBlockId(x, y + dy, z + dz);
        if (!isSolidForAO(blockId)) {
          const light = lightGrid.getLight(x, y + dy, z + dz);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          count++;
        }
      }
    }
  } else {
    // North/South face - sample in XY plane
    for (let dx = -1; dx <= 0; dx++) {
      for (let dy = -1; dy <= 0; dy++) {
        const blockId = blockGrid.getBlockId(x + dx, y + dy, z);
        if (!isSolidForAO(blockId)) {
          const light = lightGrid.getLight(x + dx, y + dy, z);
          totalSky += light.skyLight;
          totalBlock += light.blockLight;
          count++;
        }
      }
    }
  }
  
  // Get average light, or fallback to direct sample
  let avgSky, avgBlock;
  if (count > 0) {
    avgSky = totalSky / count;
    avgBlock = totalBlock / count;
  } else {
    // All sampled positions are solid - vertex is in a corner
    const light = lightGrid.getLight(x, y, z);
    avgSky = light.skyLight;
    avgBlock = light.blockLight;
  }
  
  // Apply AO brightness multiplier
  const ao = AO_BRIGHTNESS[aoLevel];
  
  return {
    skyLight: avgSky * ao,
    blockLight: avgBlock * ao,
  };
}

/**
 * Check if a block can be merged with the current run for TOP face
 * Blocks can only merge if ALL their AO values match
 * 
 * @param {number[]} baseAO - AO values [ao0, ao1, ao2, ao3] of first block in run
 * @param {number} blockX, blockY, blockZ - Position of block to check
 * @returns {boolean} true if block can be merged
 */
function canMergeBlockAO(baseAO, blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent) {
  const checkAO = getTopFaceAO(blockX, blockY, blockZ, blockGrid, isOpaque, isAOTransparent);
  return checkAO[0] === baseAO[0] && checkAO[1] === baseAO[1] && 
         checkAO[2] === baseAO[2] && checkAO[3] === baseAO[3];
}

/**
 * Get the light values at a face position for merge checking.
 * For TOP faces, samples at Y+1 (the face level in air space).
 * Returns both sky light and block light since both can vary across the scene.
 * 
 * @param {LightGrid} lightGrid - Light grid
 * @param {number} blockX, blockY, blockZ - Block position
 * @param {string} face - Face direction: 'top', 'bottom', 'east', 'west', 'north', 'south'
 * @returns {{skyLight: number, blockLight: number}} Light levels at the face
 */
function getFaceLightForMerge(lightGrid, blockX, blockY, blockZ, face) {
  if (!lightGrid) return { skyLight: 15, blockLight: 0 };
  
  // Sample light from the air block adjacent to the face
  let sampleX = blockX, sampleY = blockY, sampleZ = blockZ;
  switch (face) {
    case 'top': sampleY = blockY + 1; break;
    case 'bottom': sampleY = blockY - 1; break;
    case 'east': sampleX = blockX + 1; break;
    case 'west': sampleX = blockX - 1; break;
    case 'south': sampleZ = blockZ + 1; break;
    case 'north': sampleZ = blockZ - 1; break;
  }
  
  return lightGrid.getLight(sampleX, sampleY, sampleZ);
}

/**
 * Check if blocks can be merged based on their light values.
 * Blocks can only merge if both sky light AND block light are identical (threshold=0).
 * This prevents blocky lighting artifacts near light sources.
 * The strict matching ensures each block gets its own vertex light values,
 * which then smoothly interpolate across the face.
 * 
 * @param {{skyLight: number, blockLight: number}} baseLight - Light of the first block
 * @param {{skyLight: number, blockLight: number}} checkLight - Light of the block to check
 * @param {number} threshold - Maximum allowed difference (default 0 for smooth lighting)
 * @returns {boolean} true if blocks can be merged
 */
function canMergeBlockLight(baseLight, checkLight, threshold = 0) {
  return Math.abs(baseLight.skyLight - checkLight.skyLight) <= threshold &&
         Math.abs(baseLight.blockLight - checkLight.blockLight) <= threshold;
}

/**
 * Build all meshes for a region
 * @param {BinaryGrid} grid - The block grid
 * @param {BlockRegistry} registry - Block registry
 * @param {Object} offset - World offset { x, y, z }
 * @param {Object} options - Optional parameters
 * @param {TextureIndexLookup} options.textureIndexLookup - Texture atlas index lookup
 * @param {LightGrid} options.lightGrid - Light grid for per-vertex lighting
 */
export function buildGridMeshes(grid, registry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  const { textureIndexLookup = null, lightGrid = null } = options;
  
  // Use cached lookup tables (built once per registry, reused for all chunks)
  const {
    isOpaque,
    isNonCube,
    isSlab,
    colorR,
    colorG,
    colorB,
    isFluid,
    isGlass,
    isRotatable,
    hasRandomRotation,
    isTopOnlyRotation,
    isHalfRotation,
    needsSideOverlay,
    sideOverlayTexIdx,
    isAOTransparent,
    faceTintTypeLookup,
  } = getCachedLookupTables(registry, textureIndexLookup);
  
  /**
   * Check if a block value represents a full cube for greedy meshing purposes.
   * Double slabs ARE full cubes even though their block ID is marked as non-cube.
   * @param {number} value - The full 16-bit block value
   * @returns {boolean} True if this block should be processed as a full cube
   */
  function isFullCube(value) {
    const bid = value & BLOCK_ID_MASK;
    if (bid === 0) return false;
    if (!isOpaque[bid]) return false;
    
    // Slab blocks: only double slabs are full cubes
    if (isSlab[bid]) {
      const slabType = (value & SLAB_MASK) >> SLAB_SHIFT;
      return slabType === SLAB_DOUBLE;
    }
    
    // Other non-cube blocks (stairs, fences, etc.) are not full cubes
    if (isNonCube[bid]) return false;
    
    return true;
  }
  
  /**
   * Check if a neighbor blocks a face (is a full opaque cube).
   * @param {number} nValue - The neighbor's full 16-bit block value
   * @returns {boolean} True if neighbor blocks the face
   */
  function neighborBlocksFace(nValue) {
    const nid = nValue & BLOCK_ID_MASK;
    if (nid === 0) return false;
    if (!isOpaque[nid]) return false;
    
    // Slab neighbor: only double slabs fully block
    if (isSlab[nid]) {
      const slabType = (nValue & SLAB_MASK) >> SLAB_SHIFT;
      return slabType === SLAB_DOUBLE;
    }
    
    // Other non-cube blocks don't fully block
    if (isNonCube[nid]) return false;
    
    return true;
  }
  
  /**
   * Calculate texture rotation for a rotated block face
   * Matches Minecraft's cube_column model UV behavior
   * 
   * In Minecraft's cube model, each face has specific UV mappings that account for
   * the face's orientation. Our triplanar projection needs rotation to match.
   * 
   * @param {number} axis - Block axis: 0=y, 1=x, 2=z
   * @param {number} faceDir - Face direction constant (FACE_UP, FACE_NORTH, etc.)
   * @returns {number} UV rotation: 0=0°, 1=90°, 2=180°, 3=270°
   */
  function getTextureRotation(axis, faceDir) {
    if (axis === AXIS_Y) {
      // Vertical logs: no rotation needed
      // The triplanar UV mapping naturally aligns the texture correctly
      return 0;
    }
    
    // For horizontal logs, we need to match the UV rotations from cube_column_horizontal
    // after block-level X and Y rotations are applied
    //
    // cube_column_horizontal has: UP face = end texture with 180° rotation
    // 
    // axis=z (X=90 rotation):
    //   Original UP (with 180°) → SOUTH
    //   Original EAST/WEST → stay in place but rotate 90° internally
    //   Original NORTH → UP, Original SOUTH → DOWN
    //
    // axis=x (X=90, Y=90 rotation):
    //   Original UP (with 180°) → EAST  
    //   Original DOWN → WEST
    //   Original NORTH → UP, Original SOUTH → DOWN
    //   Original EAST → NORTH, Original WEST → SOUTH
    
    if (axis === AXIS_X) {
      // Block is horizontal along X axis (east-west)
      // EAST face was original UP (had 180° rotation in model)
      if (faceDir === FACE_EAST) {
        return 2; // 180° rotation (from model's UP face rotation)
      }
      // WEST face was original DOWN (no rotation)
      if (faceDir === FACE_WEST) {
        return 0;
      }
      // All bark faces (UP, DOWN, NORTH, SOUTH) need 90° rotation
      // because the texture "up" direction rotated with the model
      return 1;
    }
    
    if (axis === AXIS_Z) {
      // Block is horizontal along Z axis (north-south)
      // SOUTH face was original UP (had 180° rotation in model)
      if (faceDir === FACE_SOUTH) {
        return 2; // 180° rotation
      }
      // NORTH face was original DOWN (no rotation)
      if (faceDir === FACE_NORTH) {
        return 0;
      }
      // EAST/WEST bark faces need 90° rotation
      if (faceDir === FACE_EAST || faceDir === FACE_WEST) {
        return 1;
      }
      // TOP/BOTTOM bark faces - no rotation needed
      // (the model's NORTH/SOUTH faces became UP/DOWN without internal rotation)
      return 0;
    }
    
    return 0;
  }

  /**
   * Get the effective face direction for texture lookup on a rotated block
   * Maps the actual face to the "logical" face for texture selection
   * @param {number} axis - Block axis: 0=y, 1=x, 2=z
   * @param {number} faceDir - Actual face direction
   * @returns {number} Logical face for texture lookup
   */
  function getRotatedFace(axis, faceDir) {
    if (axis === AXIS_Y) {
      return faceDir; // No remapping for default orientation
    }
    
    if (axis === AXIS_X) {
      // Block is horizontal along X axis
      // East/West are now the "end" faces (like top/bottom of upright block)
      if (faceDir === FACE_EAST || faceDir === FACE_WEST) {
        return FACE_UP; // Use top texture
      } else {
        return FACE_NORTH; // Use side texture
      }
    }
    
    if (axis === AXIS_Z) {
      // Block is horizontal along Z axis
      // North/South are now the "end" faces
      if (faceDir === FACE_NORTH || faceDir === FACE_SOUTH) {
        return FACE_UP; // Use top texture
      } else {
        return FACE_EAST; // Use side texture (east is side in our mapping)
      }
    }
    
    return faceDir;
  }

  // Growable arrays - start small, expand as needed
  // This avoids large upfront allocations that can fail under memory pressure
  const INITIAL_SIZE = 100000; // Start with 100k triangles worth
  const GROWTH_FACTOR = 1.5;
  
  // Solid mesh arrays
  let sPos = new Float32Array(INITIAL_SIZE * 12);
  let sNorm = new Float32Array(INITIAL_SIZE * 12);
  let sCol = new Float32Array(INITIAL_SIZE * 12);
  let sTexIdx = new Float32Array(INITIAL_SIZE * 4); // Texture index per vertex
  let sTexRot = new Float32Array(INITIAL_SIZE * 4); // Texture rotation per vertex (0-3 for 90° increments)
  let sTintType = new Float32Array(INITIAL_SIZE * 4); // Biome tint type per vertex
  let sSkyLight = new Float32Array(INITIAL_SIZE * 4); // Sky light level per vertex (0-15)
  let sBlockLight = new Float32Array(INITIAL_SIZE * 4); // Block light level per vertex (0-15)
  let sIdx = new Uint32Array(INITIAL_SIZE * 6);
  let sVC = 0, sIC = 0;
  let sCapacity = INITIAL_SIZE;
  
  // NOTE: Water and lava meshes are now generated by FluidMesher
  // after the section iteration loop completes.
  
  // Glass mesh arrays (moderate initial size - glass structures can be substantial)
  let gPos = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gNorm = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gCol = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gTexIdx = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Texture index per vertex
  let gTexRot = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Texture rotation per vertex
  let gTintType = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Biome tint type per vertex
  let gSkyLight = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Sky light level per vertex
  let gBlockLight = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Block light level per vertex
  let gIdx = new Uint32Array(INITIAL_SIZE * 0.2 * 6);
  let gVC = 0, gIC = 0;
  let gCapacity = Math.floor(INITIAL_SIZE * 0.2);
  
  // Helper to grow arrays when needed
  function growArrays(type) {
    try {
      if (type === 's') {
        const newCap = Math.floor(sCapacity * GROWTH_FACTOR);
        const newPos = new Float32Array(newCap * 12);
        const newNorm = new Float32Array(newCap * 12);
        const newCol = new Float32Array(newCap * 12);
        const newTexIdx = new Float32Array(newCap * 4);
        const newTexRot = new Float32Array(newCap * 4);
        const newTintType = new Float32Array(newCap * 4);
        const newSkyLight = new Float32Array(newCap * 4);
        const newBlockLight = new Float32Array(newCap * 4);
        const newIdx = new Uint32Array(newCap * 6);
        newPos.set(sPos.subarray(0, sVC * 3));
        newNorm.set(sNorm.subarray(0, sVC * 3));
        newCol.set(sCol.subarray(0, sVC * 3));
        newTexIdx.set(sTexIdx.subarray(0, sVC));
        newTexRot.set(sTexRot.subarray(0, sVC));
        newTintType.set(sTintType.subarray(0, sVC));
        newSkyLight.set(sSkyLight.subarray(0, sVC));
        newBlockLight.set(sBlockLight.subarray(0, sVC));
        newIdx.set(sIdx.subarray(0, sIC));
        sPos = newPos; sNorm = newNorm; sCol = newCol; sTexIdx = newTexIdx; sTexRot = newTexRot; sTintType = newTintType; sSkyLight = newSkyLight; sBlockLight = newBlockLight; sIdx = newIdx;
        sCapacity = newCap;
      } else if (type === 'g') {
        const newCap = Math.floor(gCapacity * GROWTH_FACTOR);
        const newPos = new Float32Array(newCap * 12);
        const newNorm = new Float32Array(newCap * 12);
        const newCol = new Float32Array(newCap * 12);
        const newTexIdx = new Float32Array(newCap * 4);
        const newTexRot = new Float32Array(newCap * 4);
        const newTintType = new Float32Array(newCap * 4);
        const newSkyLight = new Float32Array(newCap * 4);
        const newBlockLight = new Float32Array(newCap * 4);
        const newIdx = new Uint32Array(newCap * 6);
        newPos.set(gPos.subarray(0, gVC * 3));
        newNorm.set(gNorm.subarray(0, gVC * 3));
        newCol.set(gCol.subarray(0, gVC * 3));
        newTexIdx.set(gTexIdx.subarray(0, gVC));
        newTexRot.set(gTexRot.subarray(0, gVC));
        newTintType.set(gTintType.subarray(0, gVC));
        newSkyLight.set(gSkyLight.subarray(0, gVC));
        newBlockLight.set(gBlockLight.subarray(0, gVC));
        newIdx.set(gIdx.subarray(0, gIC));
        gPos = newPos; gNorm = newNorm; gCol = newCol; gTexIdx = newTexIdx; gTexRot = newTexRot; gTintType = newTintType; gSkyLight = newSkyLight; gBlockLight = newBlockLight; gIdx = newIdx;
        gCapacity = newCap;
      }
      return true;
    } catch (e) {
      console.warn('[FastMesher] Failed to grow arrays:', e.message);
      return false;
    }
  }
  
  // Check capacity before adding quads
  function ensureCapacity(type, neededQuads) {
    if (type === 's' && sVC / 4 + neededQuads > sCapacity) return growArrays('s');
    if (type === 'g' && gVC / 4 + neededQuads > gCapacity) return growArrays('g');
    return true;
  }
  
  // Reusable masks - 6 faces × 16 slices = 96 masks
  // But we'll process one face at a time to save memory
  const mask = new Uint16Array(S2);
  const visited = new Uint8Array(S2);
  
  const ox = offset.x, oy = offset.y, oz = offset.z;
  
  // Process each section
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S;
    const baseY = sectionToWorldY(sy);
    const baseZ = cz * S;
    
    // Count non-air blocks quickly
    let nonAirCount = 0;
    for (let i = 0; i < S3; i++) {
      if (section[i] !== 0) nonAirCount++;
    }
    if (nonAirCount === 0) continue;
    
    // Ensure capacity for this section (max 6 faces per block, but greedy reduces this significantly)
    // Estimate ~10% of blocks will have exposed faces on average
    const estimatedQuads = Math.ceil(nonAirCount * 0.3);
    if (!ensureCapacity('s', estimatedQuads)) {
      console.warn('[FastMesher] Cannot allocate more memory, stopping mesh generation');
      break; // Stop processing more sections if we can't allocate
    }
    
    // Get block section neighbors
    const secTop = grid.sections.get(makeSectionKey(cx, cz, sy + 1));
    const secBot = grid.sections.get(makeSectionKey(cx, cz, sy - 1));
    const secRight = grid.sections.get(makeSectionKey(cx + 1, cz, sy));
    const secLeft = grid.sections.get(makeSectionKey(cx - 1, cz, sy));
    const secFront = grid.sections.get(makeSectionKey(cx, cz + 1, sy));
    const secBack = grid.sections.get(makeSectionKey(cx, cz - 1, sy));
    
    // Pre-fetch light sections for fast light lookup (current + 6 neighbors + above/below for Y sampling)
    const lightKey = makeSectionKey(cx, cz, sy);
    const lightSec = lightGrid ? lightGrid.getSectionByKey(lightKey) : null;
    const lightSecTop = lightGrid ? lightGrid.getSectionByKey(makeSectionKey(cx, cz, sy + 1)) : null;
    const lightSecBot = lightGrid ? lightGrid.getSectionByKey(makeSectionKey(cx, cz, sy - 1)) : null;
    const lightSecRight = lightGrid ? lightGrid.getSectionByKey(makeSectionKey(cx + 1, cz, sy)) : null;
    const lightSecLeft = lightGrid ? lightGrid.getSectionByKey(makeSectionKey(cx - 1, cz, sy)) : null;
    const lightSecFront = lightGrid ? lightGrid.getSectionByKey(makeSectionKey(cx, cz + 1, sy)) : null;
    const lightSecBack = lightGrid ? lightGrid.getSectionByKey(makeSectionKey(cx, cz - 1, sy)) : null;
    
    // ===== SINGLE PASS: Build all 6 face masks simultaneously =====
    // For each slice/layer, we track which blocks have exposed faces
    
    // Face 0: Top (+Y) - process by Y layer
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      
      const sliceBase = ly * S2;
      for (let j = 0; j < S2; j++) {
        const value = section[sliceBase + j];
        const bid = value & BLOCK_ID_MASK;
        // Check if this block should be processed as a full cube (includes double slabs)
        if (!isFullCube(value)) continue;
        
        // Check neighbor above
        let nValue = 0;
        if (ly < 15) {
          nValue = section[sliceBase + S2 + j];
        } else if (secTop) {
          nValue = secTop[j];
        }
        
        // Only draw face if neighbor doesn't fully block it
        if (!neighborBlocksFace(nValue)) {
          mask[j] = bid;
          hasFaces = true;
        }
      }
      
      if (!hasFaces) continue;
      
      // Greedy merge with strict AO and light matching
      // Only merge blocks that have IDENTICAL AO at all 4 corners AND similar block light
      // This prevents lighting discontinuities near light sources like torches
      visited.fill(0);
      const blockY = baseY + ly; // Block Y position
      
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          const worldX = baseX + ii;
          const worldZ = baseZ + jj;
          
          // Get AO signature of starting block's 4 corners
          const startAO = getTopFaceAO(worldX, blockY, worldZ, grid, isOpaque, isAOTransparent);
          
          // Get light of starting block for merge checking
          const startLight = lightGrid ? getFaceLightForMerge(lightGrid, worldX, blockY, worldZ, 'top') : { skyLight: 15, blockLight: 0 };
          
          // Expand width (+X) only if next block has identical AO AND similar light
          // Note: Rotation is now computed per-fragment in the shader, so we can merge freely
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) {
            if (!canMergeBlockAO(startAO, worldX + w, blockY, worldZ, grid, isOpaque, isAOTransparent)) break;
            // Also check block light - don't merge blocks with different lighting
            if (lightGrid) {
              const checkLight = getFaceLightForMerge(lightGrid, worldX + w, blockY, worldZ, 'top');
              if (!canMergeBlockLight(startLight, checkLight, 0)) break;
            }
            w++;
          }
          
          // Expand height (+Z) only if all blocks in row have identical AO AND similar light
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
              if (!canMergeBlockAO(startAO, worldX + k, blockY, worldZ + h, grid, isOpaque, isAOTransparent)) break outer;
              // Also check block light
              if (lightGrid) {
                const checkLight = getFaceLightForMerge(lightGrid, worldX + k, blockY, worldZ + h, 'top');
                if (!canMergeBlockLight(startLight, checkLight, 0)) break outer;
              }
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          // Emit quad - top face
          const x = baseX + ii - ox;
          const y = baseY + ly + 1 - oy;
          const z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;
          
          // World coordinates for light sampling (face is at y = baseY + ly + 1)
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + ly + 1;
          const faceWorldZ = baseZ + jj;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + h;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z + h;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;
          
          // Extract axis from the first block of this quad
          const blockIdx = ly * S2 + jj * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_UP);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          let texRot = getTextureRotation(axis, FACE_UP);
          // For blocks with random rotation, use per-fragment rotation
          // Values 4-7: full rotation (0°, 90°, 180°, 270°)
          // Values 8-11: half rotation (0° and 180° only, for stone/bedrock)
          if (hasRandomRotation[bid]) {
            texRot = texRot + (isHalfRotation[bid] ? 8 : 4);
          }
          const tintType = faceTintTypeLookup[bid * 6 + FACE_UP];
          
          // Per-vertex lighting with Minecraft-style AO
          // Since we only merged blocks with IDENTICAL AO, use startAO for all vertices
          // Vertex positions: V0(x, y, z+h), V1(x+w, y, z+h), V2(x+w, y, z), V3(x, y, z)
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          
          if (lightGrid) {
            // Smooth light sampling: sample from 4 blocks touching each vertex corner
            // This properly averages block light from neighboring blocks, avoiding
            // discontinuities near light sources like torches.
            // AO brightness multipliers
            const aoBrightness = [0.2, 0.6, 0.8, 1.0];
            
            // Sample light at each vertex corner position
            // Vertex positions: V0(x, y, z+h), V1(x+w, y, z+h), V2(x+w, y, z), V3(x, y, z)
            const l0 = sampleVertexLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ + h, startAO[0], grid, isOpaque, isAOTransparent, 'xz');
            const l1 = sampleVertexLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ + h, startAO[1], grid, isOpaque, isAOTransparent, 'xz');
            const l2 = sampleVertexLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, startAO[2], grid, isOpaque, isAOTransparent, 'xz');
            const l3 = sampleVertexLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ, startAO[3], grid, isOpaque, isAOTransparent, 'xz');
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sSkyLight[sVC] = skyL0; sSkyLight[sVC + 1] = skyL1; sSkyLight[sVC + 2] = skyL2; sSkyLight[sVC + 3] = skyL3;
          sBlockLight[sVC] = blockL0; sBlockLight[sVC + 1] = blockL1; sBlockLight[sVC + 2] = blockL2; sBlockLight[sVC + 3] = blockL3;
          
          sVC += 4;
          // Apply quad triangulation flip based on AO
          if (shouldFlipQuadTriangulation(startAO)) {
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 3; sIdx[sIC++] = sv;
          } else {
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          }
        }
      }
    }
    
    // Face 1: Bottom (-Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      
      const sliceBase = ly * S2;
      for (let j = 0; j < S2; j++) {
        const value = section[sliceBase + j];
        const bid = value & BLOCK_ID_MASK;
        if (!isFullCube(value)) continue;
        
        let nValue = 0;
        if (ly > 0) {
          nValue = section[sliceBase - S2 + j];
        } else if (secBot) {
          nValue = secBot[15 * S2 + j];
        }
        
        if (!neighborBlocksFace(nValue)) {
          mask[j] = bid;
          hasFaces = true;
        }
      }
      
      if (!hasFaces) continue;
      
      // Greedy merge with strict AO and light matching (same as TOP face)
      visited.fill(0);
      const blockY = baseY + ly; // Block Y position for BOTTOM face
      
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          const worldX = baseX + ii;
          const worldZ = baseZ + jj;
          
          // Get AO signature of starting block's 4 corners
          const startAO = getBottomFaceAO(worldX, blockY, worldZ, grid, isOpaque, isAOTransparent);
          
          // Get light of starting block for merge checking
          const startLight = lightGrid ? getFaceLightForMerge(lightGrid, worldX, blockY, worldZ, 'bottom') : { skyLight: 15, blockLight: 0 };
          
          // Helper to check if block can merge (same AO signature)
          const canMergeAO = (bx, bz) => {
            const checkAO = getBottomFaceAO(bx, blockY, bz, grid, isOpaque, isAOTransparent);
            return checkAO[0] === startAO[0] && checkAO[1] === startAO[1] && 
                   checkAO[2] === startAO[2] && checkAO[3] === startAO[3];
          };
          
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) {
            if (!canMergeAO(worldX + w, worldZ)) break;
            if (lightGrid) {
              const checkLight = getFaceLightForMerge(lightGrid, worldX + w, blockY, worldZ, 'bottom');
              if (!canMergeBlockLight(startLight, checkLight, 0)) break;
            }
            w++;
          }
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
              if (!canMergeAO(worldX + k, worldZ + h)) break outer;
              if (lightGrid) {
                const checkLight = getFaceLightForMerge(lightGrid, worldX + k, blockY, worldZ + h, 'bottom');
                if (!canMergeBlockLight(startLight, checkLight, 0)) break outer;
              }
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          const x = baseX + ii - ox;
          const y = baseY + ly - oy;
          const z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;
          
          // World coordinates for light sampling (face is at y = baseY + ly - 1)
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + ly - 1;
          const faceWorldZ = baseZ + jj;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z + h;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + h;
          
          // Extract axis from the first block of this quad
          const blockIdx = ly * S2 + jj * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_DOWN);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          let texRot = getTextureRotation(axis, FACE_DOWN);
          // For blocks with random rotation (except top-only blocks), use per-fragment mode
          if (hasRandomRotation[bid] && !isTopOnlyRotation[bid]) {
            texRot = texRot + (isHalfRotation[bid] ? 8 : 4);
          }
          const tintType = faceTintTypeLookup[bid * 6 + FACE_DOWN];
          
          // Per-vertex lighting with Minecraft-style AO (same as TOP face)
          // Vertex positions: V0(x, y, z), V1(x+w, y, z), V2(x+w, y, z+h), V3(x, y, z+h)
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          
          if (lightGrid) {
            const l0 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ, startAO[0], grid, isOpaque, isAOTransparent, 'xz');
            const l1 = sampleVertexLightWithAO(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, startAO[1], grid, isOpaque, isAOTransparent, 'xz');
            const l2 = sampleVertexLightWithAO(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ + h, startAO[2], grid, isOpaque, isAOTransparent, 'xz');
            const l3 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ + h, startAO[3], grid, isOpaque, isAOTransparent, 'xz');
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = -1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sSkyLight[sVC] = skyL0; sSkyLight[sVC + 1] = skyL1; sSkyLight[sVC + 2] = skyL2; sSkyLight[sVC + 3] = skyL3;
          sBlockLight[sVC] = blockL0; sBlockLight[sVC + 1] = blockL1; sBlockLight[sVC + 2] = blockL2; sBlockLight[sVC + 3] = blockL3;
          
          sVC += 4;
          // Apply quad triangulation flip based on AO
          if (shouldFlipQuadTriangulation(startAO)) {
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 3; sIdx[sIC++] = sv;
          } else {
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          }
        }
      }
    }
    
    // Face 2: Right (+X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          const bid = value & BLOCK_ID_MASK;
          if (!isFullCube(value)) continue;
          
          let nValue = 0;
          if (lx < 15) {
            nValue = section[idx + 1];
          } else if (secRight) {
            nValue = secRight[ly * S2 + lz * S];
          }
          
          if (!neighborBlocksFace(nValue)) {
            mask[ly * S + lz] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      // No greedy merge for side faces - emit each face individually to prevent lighting artifacts
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (mask[mi] === 0) continue;
          
          const bid = mask[mi];
          const w = 1;  // No merge - single block faces
          const h = 1;
          
          const x = baseX + lx + 1 - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const sv = sVC, pi = sVC * 3;
          
          // World coordinates for light sampling (face is at x = baseX + lx + 1)
          const faceWorldX = baseX + lx + 1;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + ii;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y + h; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z + w;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + w;
          
          // Extract axis from the first block of this quad
          // For X face: mask uses jj=Y, ii=Z, so blockIdx = jj*S2 + ii*S + lx
          const blockIdx = jj * S2 + ii * S + lx;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_EAST);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          let texRot = getTextureRotation(axis, FACE_EAST);
          // For blocks with random rotation (except top-only blocks), use per-fragment mode
          if (hasRandomRotation[bid] && !isTopOnlyRotation[bid]) {
            texRot = texRot + (isHalfRotation[bid] ? 8 : 4);
          }
          const tintType = faceTintTypeLookup[bid * 6 + FACE_EAST];
          
          // Calculate proper 3-neighbor AO for EAST face
          const blockWorldX = baseX + lx;
          const blockWorldY = baseY + jj;
          const blockWorldZ = baseZ + ii;
          const faceAO = getEastFaceAO(blockWorldX, blockWorldY, blockWorldZ, grid, isOpaque, isAOTransparent);
          
          // Per-vertex lighting with Minecraft-style AO
          // Vertex positions: V0(x, y, z), V1(x, y+h, z), V2(x, y+h, z+w), V3(x, y, z+w)
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          
          if (lightGrid) {
            const l0 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ, faceAO[0], grid, isOpaque, isAOTransparent, 'yz');
            const l1 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, faceAO[1], grid, isOpaque, isAOTransparent, 'yz');
            const l2 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ + w, faceAO[2], grid, isOpaque, isAOTransparent, 'yz');
            const l3 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ + w, faceAO[3], grid, isOpaque, isAOTransparent, 'yz');
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sSkyLight[sVC] = skyL0; sSkyLight[sVC + 1] = skyL1; sSkyLight[sVC + 2] = skyL2; sSkyLight[sVC + 3] = skyL3;
          sBlockLight[sVC] = blockL0; sBlockLight[sVC + 1] = blockL1; sBlockLight[sVC + 2] = blockL2; sBlockLight[sVC + 3] = blockL3;
          
          sVC += 4;
          // Apply quad triangulation flip based on AO
          if (shouldFlipQuadTriangulation(faceAO)) {
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 3; sIdx[sIC++] = sv;
          } else {
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          }
          
          // Add tinted overlay for grass block sides (rendered with glass material for proper alpha)
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            // Same positions as the base face - glass renders after solid so no z-fighting
            gPos[gpi] = x; gPos[gpi+1] = y; gPos[gpi+2] = z;
            gPos[gpi+3] = x; gPos[gpi+4] = y + h; gPos[gpi+5] = z;
            gPos[gpi+6] = x; gPos[gpi+7] = y + h; gPos[gpi+8] = z + w;
            gPos[gpi+9] = x; gPos[gpi+10] = y; gPos[gpi+11] = z + w;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = 1; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = 0;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
            gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
          }
        }
      }
    }
    
    // Face 3: Left (-X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          const bid = value & BLOCK_ID_MASK;
          if (!isFullCube(value)) continue;
          
          let nValue = 0;
          if (lx > 0) {
            nValue = section[idx - 1];
          } else if (secLeft) {
            nValue = secLeft[ly * S2 + lz * S + 15];
          }
          
          if (!neighborBlocksFace(nValue)) {
            mask[ly * S + lz] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      // No greedy merge for side faces - emit each face individually to prevent lighting artifacts
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (mask[mi] === 0) continue;
          
          const bid = mask[mi];
          const w = 1;  // No merge - single block faces
          const h = 1;
          
          const x = baseX + lx - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const sv = sVC, pi = sVC * 3;
          
          // World coordinates for light sampling (face is at x = baseX + lx - 1)
          const faceWorldX = baseX + lx - 1;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + ii;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + w;
          sPos[pi+3] = x; sPos[pi+4] = y + h; sPos[pi+5] = z + w;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;
          
          // Extract axis from the first block of this quad
          const blockIdx = jj * S2 + ii * S + lx;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_WEST);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          let texRot = getTextureRotation(axis, FACE_WEST);
          // For blocks with random rotation (except top-only blocks), use per-fragment mode
          if (hasRandomRotation[bid] && !isTopOnlyRotation[bid]) {
            texRot = texRot + (isHalfRotation[bid] ? 8 : 4);
          }
          const tintType = faceTintTypeLookup[bid * 6 + FACE_WEST];
          
          // Calculate proper 3-neighbor AO for WEST face
          const blockWorldX = baseX + lx;
          const blockWorldY = baseY + jj;
          const blockWorldZ = baseZ + ii;
          const faceAO = getWestFaceAO(blockWorldX, blockWorldY, blockWorldZ, grid, isOpaque, isAOTransparent);
          
          // Per-vertex lighting with Minecraft-style AO
          // Vertex positions: V0(x, y, z+w), V1(x, y+h, z+w), V2(x, y+h, z), V3(x, y, z)
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          
          if (lightGrid) {
            const l0 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ + w, faceAO[0], grid, isOpaque, isAOTransparent, 'yz');
            const l1 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ + w, faceAO[1], grid, isOpaque, isAOTransparent, 'yz');
            const l2 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, faceAO[2], grid, isOpaque, isAOTransparent, 'yz');
            const l3 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ, faceAO[3], grid, isOpaque, isAOTransparent, 'yz');
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = -1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sSkyLight[sVC] = skyL0; sSkyLight[sVC + 1] = skyL1; sSkyLight[sVC + 2] = skyL2; sSkyLight[sVC + 3] = skyL3;
          sBlockLight[sVC] = blockL0; sBlockLight[sVC + 1] = blockL1; sBlockLight[sVC + 2] = blockL2; sBlockLight[sVC + 3] = blockL3;
          
          sVC += 4;
          // Apply quad triangulation flip based on AO
          if (shouldFlipQuadTriangulation(faceAO)) {
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 3; sIdx[sIC++] = sv;
          } else {
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          }
          
          // Add tinted overlay for grass block sides
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            gPos[gpi] = x; gPos[gpi+1] = y; gPos[gpi+2] = z + w;
            gPos[gpi+3] = x; gPos[gpi+4] = y + h; gPos[gpi+5] = z + w;
            gPos[gpi+6] = x; gPos[gpi+7] = y + h; gPos[gpi+8] = z;
            gPos[gpi+9] = x; gPos[gpi+10] = y; gPos[gpi+11] = z;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = -1; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = 0;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
            gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
          }
        }
      }
    }
    
    // Face 4: Front (+Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          const bid = value & BLOCK_ID_MASK;
          if (!isFullCube(value)) continue;
          
          let nValue = 0;
          if (lz < 15) {
            nValue = section[idx + S];
          } else if (secFront) {
            nValue = secFront[ly * S2 + lx];
          }
          
          if (!neighborBlocksFace(nValue)) {
            mask[ly * S + lx] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      // No greedy merge for side faces - emit each face individually to prevent lighting artifacts
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (mask[mi] === 0) continue;
          
          const bid = mask[mi];
          const w = 1;  // No merge - single block faces
          const h = 1;
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz + 1 - oz;
          const sv = sVC, pi = sVC * 3;
          
          // World coordinates for light sampling (face is at z = baseZ + lz + 1)
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + lz + 1;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + w; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y + h; sPos[pi+11] = z;
          
          // Extract axis from the first block of this quad
          // For Z face: mask uses jj=Y, ii=X, so blockIdx = jj*S2 + lz*S + ii
          const blockIdx = jj * S2 + lz * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_SOUTH);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          let texRot = getTextureRotation(axis, FACE_SOUTH);
          // For blocks with random rotation (except top-only blocks), use per-fragment mode
          if (hasRandomRotation[bid] && !isTopOnlyRotation[bid]) {
            texRot = texRot + (isHalfRotation[bid] ? 8 : 4);
          }
          const tintType = faceTintTypeLookup[bid * 6 + FACE_SOUTH];
          
          // Calculate proper 3-neighbor AO for SOUTH face
          const blockWorldX = baseX + ii;
          const blockWorldY = baseY + jj;
          const blockWorldZ = baseZ + lz;
          const faceAO = getSouthFaceAO(blockWorldX, blockWorldY, blockWorldZ, grid, isOpaque, isAOTransparent);
          
          // Per-vertex lighting with Minecraft-style AO
          // Vertex positions: V0(x, y, z), V1(x+w, y, z), V2(x+w, y+h, z), V3(x, y+h, z)
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          
          if (lightGrid) {
            const l0 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ, faceAO[0], grid, isOpaque, isAOTransparent, 'xy');
            const l1 = sampleVertexLightWithAO(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, faceAO[1], grid, isOpaque, isAOTransparent, 'xy');
            const l2 = sampleVertexLightWithAO(lightGrid, faceWorldX + w, faceWorldY + h, faceWorldZ, faceAO[2], grid, isOpaque, isAOTransparent, 'xy');
            const l3 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, faceAO[3], grid, isOpaque, isAOTransparent, 'xy');
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sSkyLight[sVC] = skyL0; sSkyLight[sVC + 1] = skyL1; sSkyLight[sVC + 2] = skyL2; sSkyLight[sVC + 3] = skyL3;
          sBlockLight[sVC] = blockL0; sBlockLight[sVC + 1] = blockL1; sBlockLight[sVC + 2] = blockL2; sBlockLight[sVC + 3] = blockL3;
          
          sVC += 4;
          // Apply quad triangulation flip based on AO
          if (shouldFlipQuadTriangulation(faceAO)) {
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 3; sIdx[sIC++] = sv;
          } else {
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          }
          
          // Add tinted overlay for grass block sides
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            gPos[gpi] = x; gPos[gpi+1] = y; gPos[gpi+2] = z;
            gPos[gpi+3] = x + w; gPos[gpi+4] = y; gPos[gpi+5] = z;
            gPos[gpi+6] = x + w; gPos[gpi+7] = y + h; gPos[gpi+8] = z;
            gPos[gpi+9] = x; gPos[gpi+10] = y + h; gPos[gpi+11] = z;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = 0; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = 1;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
            gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
          }
        }
      }
    }
    
    // Face 5: Back (-Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          const bid = value & BLOCK_ID_MASK;
          if (!isFullCube(value)) continue;
          
          let nValue = 0;
          if (lz > 0) {
            nValue = section[idx - S];
          } else if (secBack) {
            nValue = secBack[ly * S2 + 15 * S + lx];
          }
          
          if (!neighborBlocksFace(nValue)) {
            mask[ly * S + lx] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      // No greedy merge for side faces - emit each face individually to prevent lighting artifacts
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (mask[mi] === 0) continue;
          
          const bid = mask[mi];
          const w = 1;  // No merge - single block faces
          const h = 1;
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz - oz;
          const sv = sVC, pi = sVC * 3;
          
          // World coordinates for light sampling (face is at z = baseZ + lz - 1)
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + lz - 1;
          
          sPos[pi] = x + w; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x + w; sPos[pi+10] = y + h; sPos[pi+11] = z;
          
          // Extract axis from the first block of this quad
          const blockIdx = jj * S2 + lz * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_NORTH);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          let texRot = getTextureRotation(axis, FACE_NORTH);
          // For blocks with random rotation (except top-only blocks), use per-fragment mode
          if (hasRandomRotation[bid] && !isTopOnlyRotation[bid]) {
            texRot = texRot + (isHalfRotation[bid] ? 8 : 4);
          }
          const tintType = faceTintTypeLookup[bid * 6 + FACE_NORTH];
          
          // Calculate proper 3-neighbor AO for NORTH face
          const blockWorldX = baseX + ii;
          const blockWorldY = baseY + jj;
          const blockWorldZ = baseZ + lz;
          const faceAO = getNorthFaceAO(blockWorldX, blockWorldY, blockWorldZ, grid, isOpaque, isAOTransparent);
          
          // Per-vertex lighting with Minecraft-style AO
          // Vertex positions: V0(x+w, y, z), V1(x, y, z), V2(x, y+h, z), V3(x+w, y+h, z)
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          
          if (lightGrid) {
            const l0 = sampleVertexLightWithAO(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, faceAO[0], grid, isOpaque, isAOTransparent, 'xy');
            const l1 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY, faceWorldZ, faceAO[1], grid, isOpaque, isAOTransparent, 'xy');
            const l2 = sampleVertexLightWithAO(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, faceAO[2], grid, isOpaque, isAOTransparent, 'xy');
            const l3 = sampleVertexLightWithAO(lightGrid, faceWorldX + w, faceWorldY + h, faceWorldZ, faceAO[3], grid, isOpaque, isAOTransparent, 'xy');
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = -1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sSkyLight[sVC] = skyL0; sSkyLight[sVC + 1] = skyL1; sSkyLight[sVC + 2] = skyL2; sSkyLight[sVC + 3] = skyL3;
          sBlockLight[sVC] = blockL0; sBlockLight[sVC + 1] = blockL1; sBlockLight[sVC + 2] = blockL2; sBlockLight[sVC + 3] = blockL3;
          
          sVC += 4;
          // Apply quad triangulation flip based on AO
          if (shouldFlipQuadTriangulation(faceAO)) {
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
            sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 3; sIdx[sIC++] = sv;
          } else {
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
            sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          }
          
          // Add tinted overlay for grass block sides
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            gPos[gpi] = x + w; gPos[gpi+1] = y; gPos[gpi+2] = z;
            gPos[gpi+3] = x; gPos[gpi+4] = y; gPos[gpi+5] = z;
            gPos[gpi+6] = x; gPos[gpi+7] = y + h; gPos[gpi+8] = z;
            gPos[gpi+9] = x + w; gPos[gpi+10] = y + h; gPos[gpi+11] = z;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = 0; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = -1;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
            gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
          }
        }
      }
    }
    
    // NOTE: Fluid meshing (water/lava) is now handled by FluidMesher
    // after the section iteration loop completes.
    
    // ===== GLASS BLOCKS: Build all 6 faces with greedy meshing =====
    // Glass blocks are transparent cubes that need all faces rendered
    
    // Helper function to check if neighbor blocks glass face
    // Glass-to-glass faces are hidden (and same for leaves-to-leaves)
    // Partial blocks (stairs, bottom/top slabs) do NOT block glass/leaf faces - they don't fully cover
    // Double slabs ARE full cubes and DO block glass faces
    const blocksGlassFace = (nValue) => {
      const nid = nValue & BLOCK_ID_MASK;
      if (isGlass[nid]) return true;
      // Use neighborBlocksFace to properly handle double slabs
      return neighborBlocksFace(nValue);
    };
    
    // Glass Face 0: Top (+Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      
      const sliceBase = ly * S2;
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isGlass[bid]) continue;
        
        let nValue = 0;
        if (ly < 15) {
          nValue = section[sliceBase + S2 + j];
        } else if (secTop) {
          nValue = secTop[j];
        }
        
        if (!blocksGlassFace(nValue)) {
          mask[j] = bid;
          hasFaces = true;
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + ly + 1 - oy;
          const z = baseZ + jj - oz;
          const gv = gVC, pi = gVC * 3;
          
          // World coordinates for light sampling
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + ly + 1;
          const faceWorldZ = baseZ + jj;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z + h;
          gPos[pi+3] = x + w; gPos[pi+4] = y; gPos[pi+5] = z + h;
          gPos[pi+6] = x + w; gPos[pi+7] = y; gPos[pi+8] = z;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_UP) : 0;
          
          // Per-vertex smooth lighting for glass TOP face
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          if (lightGrid) {
            const l0 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ + h, 0, 1, 0, grid, isOpaque, isAOTransparent);
            const l1 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ + h, 0, 1, 0, grid, isOpaque, isAOTransparent);
            const l2 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, 0, 1, 0, grid, isOpaque, isAOTransparent);
            const l3 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ, 0, 1, 0, grid, isOpaque, isAOTransparent);
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = 1; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_UP];
          }
          gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
          gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 1: Bottom (-Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      
      const sliceBase = ly * S2;
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isGlass[bid]) continue;
        
        let nValue = 0;
        if (ly > 0) {
          nValue = section[sliceBase - S2 + j];
        } else if (secBot) {
          nValue = secBot[15 * S2 + j];
        }
        
        if (!blocksGlassFace(nValue)) {
          mask[j] = bid;
          hasFaces = true;
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + ly - oy;
          const z = baseZ + jj - oz;
          const gv = gVC, pi = gVC * 3;
          
          // World coordinates for light sampling
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + ly - 1;
          const faceWorldZ = baseZ + jj;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x + w; gPos[pi+4] = y; gPos[pi+5] = z;
          gPos[pi+6] = x + w; gPos[pi+7] = y; gPos[pi+8] = z + h;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z + h;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_DOWN) : 0;
          
          // Per-vertex smooth lighting for glass BOTTOM face
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          if (lightGrid) {
            const l0 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ, 0, -1, 0, grid, isOpaque, isAOTransparent);
            const l1 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, 0, -1, 0, grid, isOpaque, isAOTransparent);
            const l2 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ + h, 0, -1, 0, grid, isOpaque, isAOTransparent);
            const l3 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ + h, 0, -1, 0, grid, isOpaque, isAOTransparent);
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = -1; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_DOWN];
          }
          gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
          gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 2: Right (+X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nValue = 0;
          if (lx < 15) {
            nValue = section[idx + 1];
          } else if (secRight) {
            nValue = secRight[ly * S2 + lz * S];
          }
          
          if (!blocksGlassFace(nValue)) {
            mask[ly * S + lz] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + lx + 1 - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const gv = gVC, pi = gVC * 3;
          
          // World coordinates for light sampling
          const faceWorldX = baseX + lx + 1;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + ii;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x; gPos[pi+4] = y + h; gPos[pi+5] = z;
          gPos[pi+6] = x; gPos[pi+7] = y + h; gPos[pi+8] = z + w;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z + w;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_EAST) : 0;
          
          // Per-vertex smooth lighting for glass EAST face
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          if (lightGrid) {
            const l0 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ, 1, 0, 0, grid, isOpaque, isAOTransparent);
            const l1 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, 1, 0, 0, grid, isOpaque, isAOTransparent);
            const l2 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ + w, 1, 0, 0, grid, isOpaque, isAOTransparent);
            const l3 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ + w, 1, 0, 0, grid, isOpaque, isAOTransparent);
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 1; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_EAST];
          }
          gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
          gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 3: Left (-X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nValue = 0;
          if (lx > 0) {
            nValue = section[idx - 1];
          } else if (secLeft) {
            nValue = secLeft[ly * S2 + lz * S + 15];
          }
          
          if (!blocksGlassFace(nValue)) {
            mask[ly * S + lz] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + lx - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const gv = gVC, pi = gVC * 3;
          
          // World coordinates for light sampling
          const faceWorldX = baseX + lx - 1;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + ii;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z + w;
          gPos[pi+3] = x; gPos[pi+4] = y + h; gPos[pi+5] = z + w;
          gPos[pi+6] = x; gPos[pi+7] = y + h; gPos[pi+8] = z;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_WEST) : 0;
          
          // Per-vertex smooth lighting for glass WEST face
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          if (lightGrid) {
            const l0 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ + w, -1, 0, 0, grid, isOpaque, isAOTransparent);
            const l1 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ + w, -1, 0, 0, grid, isOpaque, isAOTransparent);
            const l2 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, -1, 0, 0, grid, isOpaque, isAOTransparent);
            const l3 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ, -1, 0, 0, grid, isOpaque, isAOTransparent);
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = -1; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_WEST];
          }
          gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
          gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 4: Front (+Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nValue = 0;
          if (lz < 15) {
            nValue = section[idx + S];
          } else if (secFront) {
            nValue = secFront[ly * S2 + lx];
          }
          
          if (!blocksGlassFace(nValue)) {
            mask[ly * S + lx] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz + 1 - oz;
          const gv = gVC, pi = gVC * 3;
          
          // World coordinates for light sampling
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + lz + 1;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x + w; gPos[pi+4] = y; gPos[pi+5] = z;
          gPos[pi+6] = x + w; gPos[pi+7] = y + h; gPos[pi+8] = z;
          gPos[pi+9] = x; gPos[pi+10] = y + h; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_SOUTH) : 0;
          
          // Per-vertex smooth lighting for glass SOUTH face
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          if (lightGrid) {
            const l0 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ, 0, 0, 1, grid, isOpaque, isAOTransparent);
            const l1 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, 0, 0, 1, grid, isOpaque, isAOTransparent);
            const l2 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY + h, faceWorldZ, 0, 0, 1, grid, isOpaque, isAOTransparent);
            const l3 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, 0, 0, 1, grid, isOpaque, isAOTransparent);
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = 1;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_SOUTH];
          }
          gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
          gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 5: Back (-Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nValue = 0;
          if (lz > 0) {
            nValue = section[idx - S];
          } else if (secBack) {
            nValue = secBack[ly * S2 + 15 * S + lx];
          }
          
          if (!blocksGlassFace(nValue)) {
            mask[ly * S + lx] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || mask[mi] === 0) continue;
          
          const bid = mask[mi];
          let w = 1;
          while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
          
          let h = 1;
          outer: while (jj + h < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz - oz;
          const gv = gVC, pi = gVC * 3;
          
          // World coordinates for light sampling
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + jj;
          const faceWorldZ = baseZ + lz - 1;
          
          gPos[pi] = x + w; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x; gPos[pi+4] = y; gPos[pi+5] = z;
          gPos[pi+6] = x; gPos[pi+7] = y + h; gPos[pi+8] = z;
          gPos[pi+9] = x + w; gPos[pi+10] = y + h; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_NORTH) : 0;
          
          // Per-vertex smooth lighting for glass NORTH face
          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;
          if (lightGrid) {
            const l0 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY, faceWorldZ, 0, 0, -1, grid, isOpaque, isAOTransparent);
            const l1 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY, faceWorldZ, 0, 0, -1, grid, isOpaque, isAOTransparent);
            const l2 = sampleSmoothLight(lightGrid, faceWorldX, faceWorldY + h, faceWorldZ, 0, 0, -1, grid, isOpaque, isAOTransparent);
            const l3 = sampleSmoothLight(lightGrid, faceWorldX + w, faceWorldY + h, faceWorldZ, 0, 0, -1, grid, isOpaque, isAOTransparent);
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }
          
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = -1;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_NORTH];
          }
          gSkyLight[gVC] = skyL0; gSkyLight[gVC + 1] = skyL1; gSkyLight[gVC + 2] = skyL2; gSkyLight[gVC + 3] = skyL3;
          gBlockLight[gVC] = blockL0; gBlockLight[gVC + 1] = blockL1; gBlockLight[gVC + 2] = blockL2; gBlockLight[gVC + 3] = blockL3;
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
  }
  
  // Build fluid meshes using the new FluidMesher
  const fluidMeshes = buildFluidMeshes(grid, registry, offset, { textureIndexLookup, lightGrid });
  
  // Trim and return
  const trimMesh = (pos, norm, col, idx, vc, ic, texIdx = null, texRot = null, tintType = null, skyLight = null, blockLight = null) => {
    if (vc === 0) return null;
    const result = {
      positions: pos.subarray(0, vc * 3),
      normals: norm.subarray(0, vc * 3),
      colors: col.subarray(0, vc * 3),
      indices: idx.subarray(0, ic),
      vertexCount: vc,
      triangleCount: ic / 3,
    };
    if (texIdx) {
      result.texIndices = texIdx.subarray(0, vc);
    }
    if (texRot) {
      result.texRotations = texRot.subarray(0, vc);
    }
    if (tintType) {
      result.tintTypes = tintType.subarray(0, vc);
    }
    if (skyLight) {
      result.skyLight = skyLight.subarray(0, vc);
    }
    if (blockLight) {
      result.blockLight = blockLight.subarray(0, vc);
    }
    return result;
  };
  
  return {
    solid: trimMesh(sPos, sNorm, sCol, sIdx, sVC, sIC, sTexIdx, sTexRot, sTintType, sSkyLight, sBlockLight),
    water: fluidMeshes.water,
    lava: fluidMeshes.lava,
    glass: trimMesh(gPos, gNorm, gCol, gIdx, gVC, gIC, gTexIdx, gTexRot, gTintType, gSkyLight, gBlockLight),
  };
}

export default buildGridMeshes;
