/**
 * SimplifiedMesher - Low-poly mesh generation for distant LOD
 * 
 * Instead of greedy meshing every face, this samples blocks at lower resolution
 * to create a simplified mesh suitable for viewing from a distance.
 * 
 * LOD 0 (close): Full detail - every block face
 * LOD 1 (medium): 2x2 sampling - ~4x fewer faces  
 * LOD 2 (far): 4x4 sampling - ~16x fewer faces
 * LOD 3 (very far): 8x8 sampling - ~64x fewer faces
 * LOD 4 (extreme): 16x16 sampling - ~256x fewer faces (1 sample per section)
 */

import { parseSectionKey, makeSectionKey, sectionToWorldY } from './BinaryGrid.js';

const S = 16;
const S2 = S * S;
const S3 = S * S * S;
const BLOCK_ID_MASK = 0x0FFF;

/**
 * Build simplified mesh at given LOD level
 * @param {BinaryGrid} grid - The voxel grid
 * @param {Object} registry - Block registry
 * @param {Object} offset - Center offset {x, y, z}
 * @param {number} lodLevel - 0=full, 1=2x, 2=4x, 3=8x, 4=16x sampling
 */
export function buildSimplifiedMesh(grid, registry, offset = { x: 0, y: 0, z: 0 }, lodLevel = 1) {
  // Sampling step: 2, 4, 8, or 16
  const step = Math.min(16, Math.pow(2, lodLevel));
  
  // Build lookup tables (same pattern as FastMesher)
  const isOpaque = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info) {
      isOpaque[id] = registry.isOpaque(id) ? 1 : 0;
      const col = registry.getColor(id);
      colorR[id] = col.r;
      colorG[id] = col.g;
      colorB[id] = col.b;
    }
  }
  
  // Output arrays
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  
  const ox = offset.x, oy = offset.y, oz = offset.z;
  
  // Process each section
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S;
    const baseY = sectionToWorldY(sy);
    const baseZ = cz * S;
    
    // Sample at lower resolution
    for (let ly = 0; ly < S; ly += step) {
      for (let lz = 0; lz < S; lz += step) {
        for (let lx = 0; lx < S; lx += step) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          
          if (bid === 0 || !isOpaque[bid]) continue;
          
          // World position
          const wx = baseX + lx - ox;
          const wy = baseY + ly - oy;
          const wz = baseZ + lz - oz;
          
          // Block size at this LOD (covers step x step x step area)
          const size = step;
          
          // Check each face - simplified neighbor check
          // Top face (+Y)
          if (!hasOpaqueNeighbor(grid, section, lx, ly + step, lz, cx, cz, sy, isOpaque, step)) {
            addFace(positions, normals, colors, indices, 
              wx, wy + size, wz, size, size, 0, 1, 0,
              colorR[bid], colorG[bid], colorB[bid]);
          }
          
          // Bottom face (-Y)
          if (!hasOpaqueNeighbor(grid, section, lx, ly - step, lz, cx, cz, sy, isOpaque, step)) {
            addFace(positions, normals, colors, indices,
              wx, wy, wz, size, size, 0, -1, 0,
              colorR[bid], colorG[bid], colorB[bid]);
          }
          
          // Right face (+X)
          if (!hasOpaqueNeighbor(grid, section, lx + step, ly, lz, cx, cz, sy, isOpaque, step)) {
            addFace(positions, normals, colors, indices,
              wx + size, wy, wz, size, size, 1, 0, 0,
              colorR[bid], colorG[bid], colorB[bid]);
          }
          
          // Left face (-X)
          if (!hasOpaqueNeighbor(grid, section, lx - step, ly, lz, cx, cz, sy, isOpaque, step)) {
            addFace(positions, normals, colors, indices,
              wx, wy, wz, size, size, -1, 0, 0,
              colorR[bid], colorG[bid], colorB[bid]);
          }
          
          // Front face (+Z)
          if (!hasOpaqueNeighbor(grid, section, lx, ly, lz + step, cx, cz, sy, isOpaque, step)) {
            addFace(positions, normals, colors, indices,
              wx, wy, wz + size, size, size, 0, 0, 1,
              colorR[bid], colorG[bid], colorB[bid]);
          }
          
          // Back face (-Z)
          if (!hasOpaqueNeighbor(grid, section, lx, ly, lz - step, cx, cz, sy, isOpaque, step)) {
            addFace(positions, normals, colors, indices,
              wx, wy, wz, size, size, 0, 0, -1,
              colorR[bid], colorG[bid], colorB[bid]);
          }
        }
      }
    }
  }
  
  if (positions.length === 0) return null;
  
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/**
 * Check if neighbor position has an opaque block
 */
function hasOpaqueNeighbor(grid, section, lx, ly, lz, cx, cz, sy, isOpaque, step) {
  // Handle section boundaries
  let ncx = cx, ncz = cz, nsy = sy;
  let nlx = lx, nly = ly, nlz = lz;
  
  if (ly < 0) {
    nsy = sy - 1;
    nly = S + ly;
  } else if (ly >= S) {
    nsy = sy + 1;
    nly = ly - S;
  }
  
  if (lx < 0) {
    ncx = cx - 1;
    nlx = S + lx;
  } else if (lx >= S) {
    ncx = cx + 1;
    nlx = lx - S;
  }
  
  if (lz < 0) {
    ncz = cz - 1;
    nlz = S + lz;
  } else if (lz >= S) {
    ncz = cz + 1;
    nlz = lz - S;
  }
  
  // Get the section
  let targetSection = section;
  if (ncx !== cx || ncz !== cz || nsy !== sy) {
    targetSection = grid.sections.get(makeSectionKey(ncx, ncz, nsy));
    if (!targetSection) return false;
  }
  
  // Clamp to valid range
  nlx = Math.max(0, Math.min(S - 1, nlx));
  nly = Math.max(0, Math.min(S - 1, nly));
  nlz = Math.max(0, Math.min(S - 1, nlz));
  
  const idx = nly * S2 + nlz * S + nlx;
  const bid = targetSection[idx] & BLOCK_ID_MASK;
  
  return isOpaque[bid] === 1;
}

/**
 * Add a quad face to the mesh
 */
function addFace(positions, normals, colors, indices, x, y, z, w, h, nx, ny, nz, r, g, b) {
  const vi = positions.length / 3;
  
  // Generate 4 vertices based on normal direction
  if (ny !== 0) {
    // Horizontal face (top/bottom)
    positions.push(x, y, z);
    positions.push(x + w, y, z);
    positions.push(x + w, y, z + h);
    positions.push(x, y, z + h);
  } else if (nx !== 0) {
    // X-facing face
    positions.push(x, y, z);
    positions.push(x, y + h, z);
    positions.push(x, y + h, z + w);
    positions.push(x, y, z + w);
  } else {
    // Z-facing face
    positions.push(x, y, z);
    positions.push(x + w, y, z);
    positions.push(x + w, y + h, z);
    positions.push(x, y + h, z);
  }
  
  // Normals (4 vertices)
  for (let i = 0; i < 4; i++) {
    normals.push(nx, ny, nz);
    colors.push(r, g, b);
  }
  
  // Indices (2 triangles)
  if (nx > 0 || ny > 0 || nz < 0) {
    indices.push(vi, vi + 1, vi + 2);
    indices.push(vi, vi + 2, vi + 3);
  } else {
    indices.push(vi, vi + 2, vi + 1);
    indices.push(vi, vi + 3, vi + 2);
  }
}

export default buildSimplifiedMesh;

