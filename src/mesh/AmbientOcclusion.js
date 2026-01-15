/**
 * AmbientOcclusion.js - Minecraft-accurate ambient occlusion utilities
 * 
 * This module provides shared AO calculation functions used by both FastMesher
 * (full cubes) and ModelMesher (partial blocks like slabs, stairs).
 * 
 * Minecraft's AO Algorithm:
 * - For each vertex of a block face, check 3 neighboring blocks: side1, side2, and corner
 * - If both sides are solid, corner is fully occluded (AO level 0)
 * - Otherwise, AO level = 3 - (side1 solid) - (side2 solid) - (corner solid)
 * - AO levels 0-3 map to brightness multipliers [0.2, 0.6, 0.8, 1.0]
 */

// ============================================================================
// AO BRIGHTNESS VALUES
// These are Minecraft's actual AO brightness multipliers
// ============================================================================

/**
 * AO level to brightness multiplier mapping
 * AO 0 = both sides blocked (darkest corner) = 0.2
 * AO 1 = 2 neighbors blocked = 0.6
 * AO 2 = 1 neighbor blocked = 0.8
 * AO 3 = no neighbors blocked (fully lit) = 1.0
 */
export const AO_BRIGHTNESS = [0.2, 0.6, 0.8, 1.0];

// ============================================================================
// CORE AO CALCULATION
// ============================================================================

/**
 * Calculate AO level for a single vertex corner
 * 
 * @param {boolean} side1 - Is side1 neighbor solid?
 * @param {boolean} side2 - Is side2 neighbor solid?
 * @param {boolean} corner - Is corner (diagonal) neighbor solid?
 * @returns {number} AO level 0-3 (0=darkest, 3=brightest)
 */
export function calculateCornerAO(side1, side2, corner) {
  // Minecraft behavior: if both sides are solid, corner is fully occluded
  if (side1 && side2) {
    return 0;
  }
  // Otherwise count solid neighbors
  return 3 - (side1 ? 1 : 0) - (side2 ? 1 : 0) - (corner ? 1 : 0);
}

/**
 * Convert AO level to brightness multiplier
 * @param {number} aoLevel - AO level 0-3
 * @returns {number} Brightness multiplier 0.2-1.0
 */
export function aoToBrightness(aoLevel) {
  return AO_BRIGHTNESS[Math.max(0, Math.min(3, aoLevel))];
}

// ============================================================================
// FACE-SPECIFIC AO CALCULATION
// Each function calculates AO for all 4 vertices of a face
// ============================================================================

/**
 * Calculate AO for all 4 vertices of a TOP face (+Y normal)
 * 
 * Face vertices (looking down from +Y):
 *     V0(x,y,z+1) -------- V1(x+1,y,z+1)
 *          |                    |
 *          |      FACE          |
 *          |                    |
 *     V3(x,y,z) ---------- V2(x+1,y,z)
 * 
 * Sample Y = blockY + 1 (one block above the solid block, in the air space)
 * 
 * @param {number} blockX, blockY, blockZ - Block position
 * @param {Function} isSolidForAO - (x, y, z) => boolean
 * @returns {number[]} [ao0, ao1, ao2, ao3] AO levels for each vertex
 */
export function getTopFaceAO(blockX, blockY, blockZ, isSolidForAO) {
  const y = blockY + 1; // Sample in air space above block
  
  // Pre-sample all 8 neighbors in XZ plane at Y level
  const n = isSolidForAO(blockX, y, blockZ - 1);     // North
  const s = isSolidForAO(blockX, y, blockZ + 1);     // South
  const e = isSolidForAO(blockX + 1, y, blockZ);     // East
  const w = isSolidForAO(blockX - 1, y, blockZ);     // West
  const ne = isSolidForAO(blockX + 1, y, blockZ - 1);
  const nw = isSolidForAO(blockX - 1, y, blockZ - 1);
  const se = isSolidForAO(blockX + 1, y, blockZ + 1);
  const sw = isSolidForAO(blockX - 1, y, blockZ + 1);
  
  // V0: corner at (-X, +Z) - check West and South
  const ao0 = calculateCornerAO(w, s, sw);
  // V1: corner at (+X, +Z) - check East and South
  const ao1 = calculateCornerAO(e, s, se);
  // V2: corner at (+X, -Z) - check East and North
  const ao2 = calculateCornerAO(e, n, ne);
  // V3: corner at (-X, -Z) - check West and North
  const ao3 = calculateCornerAO(w, n, nw);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Calculate AO for all 4 vertices of a BOTTOM face (-Y normal)
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
export function getBottomFaceAO(blockX, blockY, blockZ, isSolidForAO) {
  const y = blockY - 1; // Sample in air space below block
  
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
 * Calculate AO for all 4 vertices of a NORTH face (-Z normal)
 * 
 * Face vertices (looking from -Z toward +Z):
 *     V0(x,y+1,z) -------- V1(x+1,y+1,z)
 *          |                    |
 *          |      FACE          |
 *          |                    |
 *     V3(x,y,z) ---------- V2(x+1,y,z)
 * 
 * Sample Z = blockZ - 1 (one block in front of face)
 */
export function getNorthFaceAO(blockX, blockY, blockZ, isSolidForAO) {
  const z = blockZ - 1; // Sample in air space in front of face
  
  // Sample in XY plane at Z level
  const u = isSolidForAO(blockX, blockY + 1, z);     // Up
  const d = isSolidForAO(blockX, blockY - 1, z);     // Down
  const e = isSolidForAO(blockX + 1, blockY, z);     // East
  const w = isSolidForAO(blockX - 1, blockY, z);     // West
  const ue = isSolidForAO(blockX + 1, blockY + 1, z);
  const uw = isSolidForAO(blockX - 1, blockY + 1, z);
  const de = isSolidForAO(blockX + 1, blockY - 1, z);
  const dw = isSolidForAO(blockX - 1, blockY - 1, z);
  
  // V0: corner at (-X, +Y) - check West and Up
  const ao0 = calculateCornerAO(w, u, uw);
  // V1: corner at (+X, +Y) - check East and Up
  const ao1 = calculateCornerAO(e, u, ue);
  // V2: corner at (+X, -Y) - check East and Down
  const ao2 = calculateCornerAO(e, d, de);
  // V3: corner at (-X, -Y) - check West and Down
  const ao3 = calculateCornerAO(w, d, dw);
  
  return [ao0, ao1, ao2, ao3];
}

/**
 * Calculate AO for all 4 vertices of a SOUTH face (+Z normal)
 * 
 * Face vertices (looking from +Z toward -Z):
 *     V0(x+1,y+1,z) ------ V1(x,y+1,z)
 *          |                    |
 *          |      FACE          |
 *          |                    |
 *     V3(x+1,y,z) -------- V2(x,y,z)
 * 
 * Sample Z = blockZ + 1 (one block behind face)
 */
export function getSouthFaceAO(blockX, blockY, blockZ, isSolidForAO) {
  const z = blockZ + 1; // Sample in air space behind face
  
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
 * Calculate AO for all 4 vertices of an EAST face (+X normal)
 * 
 * Face vertices (looking from +X toward -X):
 *     V0(x,y,z) ---------- V1(x,y+1,z)
 *          |                    |
 *          |      FACE          |
 *          |                    |
 *     V3(x,y,z+1) -------- V2(x,y+1,z+1)
 * 
 * Sample X = blockX + 1 (one block to the right of face)
 */
export function getEastFaceAO(blockX, blockY, blockZ, isSolidForAO) {
  const x = blockX + 1; // Sample in air space to the right of face
  
  // Sample in YZ plane at X level
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
 * Calculate AO for all 4 vertices of a WEST face (-X normal)
 * 
 * Face vertices (looking from -X toward +X):
 *     V0(x,y,z+1) -------- V1(x,y+1,z+1)
 *          |                    |
 *          |      FACE          |
 *          |                    |
 *     V3(x,y,z) ---------- V2(x,y+1,z)
 * 
 * Sample X = blockX - 1 (one block to the left of face)
 */
export function getWestFaceAO(blockX, blockY, blockZ, isSolidForAO) {
  const x = blockX - 1; // Sample in air space to the left of face
  
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

// ============================================================================
// GENERIC VERTEX AO (for partial blocks)
// ============================================================================

/**
 * Calculate AO for a single vertex at an arbitrary world position
 * Used for partial blocks (slabs, stairs, path blocks) where vertex positions don't align with block grid
 * 
 * For each vertex of a face, we sample the 3 blocks that would occlude light at that corner:
 * - Two "side" blocks along the edges meeting at the corner
 * - One "corner" block at the diagonal
 * 
 * Key insight for partial blocks: For a path block (height 15/16) at Y=64, the top face
 * is at Y=64.9375. An adjacent full cube at Y=64 extends from Y=64 to Y=65, which is
 * ABOVE the path block's surface. To detect this occlusion, we sample at the block level
 * (Y=64), not above it (Y=65).
 * 
 * @param {number} vx, vy, vz - Vertex world position
 * @param {string} faceDir - Face direction: 'up', 'down', 'north', 'south', 'east', 'west'
 * @param {Function} isSolidForAO - (x, y, z) => boolean - checks if block at integer coords is solid
 * @returns {number} AO level 0-3
 */
export function getVertexAO(vx, vy, vz, faceDir, isSolidForAO) {
  // Get the block this vertex is in
  const bx = Math.floor(vx);
  const by = Math.floor(vy);
  const bz = Math.floor(vz);
  
  // Get the fractional position within the block (0-1 range)
  const fx = vx - bx;
  const fy = vy - by;
  const fz = vz - bz;
  
  // For each face direction, we sample neighbors at the SAME block level as the vertex
  // This allows partial blocks to receive AO from adjacent full cubes that extend above them
  
  switch (faceDir) {
    case 'up': {
      // Determine which corner based on XZ position
      const westSide = fx < 0.5;
      const northSide = fz < 0.5;
      const dx = westSide ? -1 : 1;
      const dz = northSide ? -1 : 1;
      
      // Check if face is at the block boundary (full cubes, top slabs)
      const faceAtBoundary = fy >= 0.95;
      
      if (faceAtBoundary) {
        // Standard algorithm: check at level above
        const sy = by + 1;
        const s1 = isSolidForAO(bx + dx, sy, bz);
        const s2 = isSolidForAO(bx, sy, bz + dz);
        const corner = isSolidForAO(bx + dx, sy, bz + dz);
        return calculateCornerAO(s1, s2, corner);
      } else {
        // Partial block (path, bottom slab): softer AO at same level
        // Only check direct side neighbors, skip corner for less harsh shadows
        const s1 = isSolidForAO(bx + dx, by, bz);
        const s2 = isSolidForAO(bx, by, bz + dz);
        if (s1 && s2) return 1;
        if (s1 || s2) return 2;
        return 3;
      }
    }
    case 'down': {
      // For downward-facing surfaces, sample at the block level below
      const sy = by - 1;
      
      const westSide = fx < 0.5;
      const northSide = fz < 0.5;
      
      const sideX = isSolidForAO(bx + (westSide ? -1 : 1), sy, bz);
      const sideZ = isSolidForAO(bx, sy, bz + (northSide ? -1 : 1));
      const corner = isSolidForAO(bx + (westSide ? -1 : 1), sy, bz + (northSide ? -1 : 1));
      
      return calculateCornerAO(sideX, sideZ, corner);
    }
    case 'north': {
      // For north-facing surfaces (-Z), sample in XY plane at the block in front
      const sz = bz - 1;
      
      const westSide = fx < 0.5;
      const bottomSide = fy < 0.5;
      
      const sideX = isSolidForAO(bx + (westSide ? -1 : 1), by, sz);
      const sideY = isSolidForAO(bx, by + (bottomSide ? -1 : 1), sz);
      const corner = isSolidForAO(bx + (westSide ? -1 : 1), by + (bottomSide ? -1 : 1), sz);
      
      return calculateCornerAO(sideX, sideY, corner);
    }
    case 'south': {
      // For south-facing surfaces (+Z), sample in XY plane at the block behind
      const sz = bz + 1;
      
      const westSide = fx < 0.5;
      const bottomSide = fy < 0.5;
      
      const sideX = isSolidForAO(bx + (westSide ? -1 : 1), by, sz);
      const sideY = isSolidForAO(bx, by + (bottomSide ? -1 : 1), sz);
      const corner = isSolidForAO(bx + (westSide ? -1 : 1), by + (bottomSide ? -1 : 1), sz);
      
      return calculateCornerAO(sideX, sideY, corner);
    }
    case 'east': {
      // For east-facing surfaces (+X), sample in YZ plane to the east
      const sx = bx + 1;
      
      const northSide = fz < 0.5;
      const bottomSide = fy < 0.5;
      
      const sideZ = isSolidForAO(sx, by, bz + (northSide ? -1 : 1));
      const sideY = isSolidForAO(sx, by + (bottomSide ? -1 : 1), bz);
      const corner = isSolidForAO(sx, by + (bottomSide ? -1 : 1), bz + (northSide ? -1 : 1));
      
      return calculateCornerAO(sideZ, sideY, corner);
    }
    case 'west': {
      // For west-facing surfaces (-X), sample in YZ plane to the west
      const sx = bx - 1;
      
      const northSide = fz < 0.5;
      const bottomSide = fy < 0.5;
      
      const sideZ = isSolidForAO(sx, by, bz + (northSide ? -1 : 1));
      const sideY = isSolidForAO(sx, by + (bottomSide ? -1 : 1), bz);
      const corner = isSolidForAO(sx, by + (bottomSide ? -1 : 1), bz + (northSide ? -1 : 1));
      
      return calculateCornerAO(sideZ, sideY, corner);
    }
    default:
      return 3; // Fully lit if unknown face
  }
}

// ============================================================================
// QUAD TRIANGULATION
// ============================================================================

/**
 * Determine if quad triangulation should be flipped based on AO values
 * 
 * When a quad has different AO values at opposite corners, the triangulation
 * direction affects which diagonal gets the shadow. We flip to put the edge
 * along the darker diagonal for more natural-looking shadows.
 * 
 * @param {number[]} ao - [ao0, ao1, ao2, ao3] AO levels for the 4 vertices
 * @returns {boolean} true if triangulation should be flipped
 */
export function shouldFlipQuadTriangulation(ao) {
  // Standard triangulation uses diagonal V0-V2
  // Flipped triangulation uses diagonal V1-V3
  // Flip when V1+V3 sum is greater (darker diagonal should be the edge)
  return ao[0] + ao[2] <= ao[1] + ao[3];
}

/**
 * Emit triangle indices for a quad, handling AO-based flip
 * 
 * @param {Uint32Array} indices - Index array to write to
 * @param {number} idx - Current index position
 * @param {number} baseVertex - Base vertex index (V0)
 * @param {number[]} ao - [ao0, ao1, ao2, ao3] AO levels
 * @returns {number} New index position after writing 6 indices
 */
export function emitQuadIndices(indices, idx, baseVertex, ao) {
  const sv = baseVertex;
  
  if (shouldFlipQuadTriangulation(ao)) {
    // Flipped: V1-V2-V3, V1-V3-V0
    indices[idx++] = sv + 1;
    indices[idx++] = sv + 2;
    indices[idx++] = sv + 3;
    indices[idx++] = sv + 1;
    indices[idx++] = sv + 3;
    indices[idx++] = sv;
  } else {
    // Standard: V0-V1-V2, V0-V2-V3
    indices[idx++] = sv;
    indices[idx++] = sv + 1;
    indices[idx++] = sv + 2;
    indices[idx++] = sv;
    indices[idx++] = sv + 2;
    indices[idx++] = sv + 3;
  }
  
  return idx;
}

// ============================================================================
// AO-TRANSPARENT BLOCK DETECTION
// ============================================================================

/**
 * Build an AO-transparent lookup table for a block registry
 * 
 * AO-transparent blocks don't contribute to AO calculations (treated as air):
 * - Air (block ID 0)
 * - Glass, ice, leaves, slime, honey
 * - Non-cube blocks (slabs, stairs, fences, etc.)
 * - Fluids (water, lava)
 * 
 * @param {BlockRegistry} registry - Block registry
 * @returns {Uint8Array} Lookup table: 1 = AO-transparent, 0 = solid for AO
 */
export function buildAOTransparentLookup(registry) {
  const isAOTransparent = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info && info.name) {
      if (
        info.name.includes('glass') ||
        info.name.includes('ice') ||
        info.name.includes('leaves') ||
        info.name.includes('slime') ||
        info.name.includes('honey') ||
        info.name.includes('water') ||
        info.name.includes('lava') ||
        info.name.includes('barrier') ||
        info.name.includes('light') ||
        registry.isNonCube(id)
      ) {
        isAOTransparent[id] = 1;
      }
    }
  }
  
  return isAOTransparent;
}

/**
 * Create an isSolidForAO checker function
 * 
 * @param {BinaryGrid} blockGrid - Block grid
 * @param {Uint8Array} isOpaque - Opaque block lookup
 * @param {Uint8Array} isAOTransparent - AO-transparent block lookup
 * @returns {Function} (x, y, z) => boolean
 */
export function createIsSolidForAOChecker(blockGrid, isOpaque, isAOTransparent) {
  return (x, y, z) => {
    const blockId = blockGrid.getBlockId(x, y, z);
    if (blockId === 0) return false;
    if (isAOTransparent && isAOTransparent[blockId]) return false;
    return isOpaque[blockId] === 1;
  };
}
