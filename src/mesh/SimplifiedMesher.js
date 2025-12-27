/**
 * SimplifiedMesher - Low-poly mesh generation for distant LOD
 * 
 * Uses FIXED GRID SAMPLING: creates a regular grid of vertices across the
 * region bounds, samples heights at each grid point, and connects them
 * into a gap-free triangulated mesh. This guarantees no holes regardless
 * of caves, overhangs, or steep terrain.
 * 
 * LOD levels control grid density (approximate vertex counts):
 * LOD 1: 358x358 grid = ~128k vertices
 * LOD 2: 253x253 grid = ~64k vertices
 * LOD 3: 179x179 grid = ~32k vertices
 * LOD 4: 127x127 grid = ~16k vertices
 */

import { parseSectionKey, sectionToWorldY } from './BinaryGrid.js';

const S = 16;
const S2 = S * S;
const BLOCK_ID_MASK = 0x0FFF;

/**
 * Build simplified mesh using fixed grid sampling
 * @param {BinaryGrid} grid - The voxel grid
 * @param {Object} registry - Block registry
 * @param {Object} offset - Center offset {x, y, z}
 * @param {number} lodLevel - 1=64x64, 2=32x32, 3=16x16, 4=8x8 grid
 */
export function buildSimplifiedMesh(grid, registry, offset = { x: 0, y: 0, z: 0 }, lodLevel = 1) {
  // Build lookup tables
  // For LOD, we consider both opaque AND fluid blocks as "surface"
  // This ensures water/lava areas aren't holes in the LOD mesh
  const isSurface = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info) {
      // Consider opaque blocks AND fluids as surface (not air)
      const isFluid = info.name && (info.name.includes('water') || info.name.includes('lava'));
      isSurface[id] = (registry.isOpaque(id) || isFluid) ? 1 : 0;
      const col = registry.getColor(id);
      colorR[id] = col.r;
      colorG[id] = col.g;
      colorB[id] = col.b;
    }
  }
  
  // First pass: Collect ALL surface points and find bounds
  // Key: "wx,wz" -> { height, blockId }
  const surfacePoints = new Map();
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S;
    const baseY = sectionToWorldY(sy);
    const baseZ = cz * S;
    
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        
        // Track world bounds
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minZ = Math.min(minZ, wz);
        maxZ = Math.max(maxZ, wz);
        
        // Find highest block in this column
        for (let ly = S - 1; ly >= 0; ly--) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          
          if (bid !== 0) {
            // Check if this is a surface block (opaque or fluid)
            // We check both the pre-built lookup AND do a live check for fluids
            // because fluid block IDs might be registered after the lookup was built
            let isValidSurface = isSurface[bid];
            if (!isValidSurface) {
              // Live check for fluids
              const info = registry.getBlockInfo(bid);
              if (info && info.name && (info.name.includes('water') || info.name.includes('lava'))) {
                isValidSurface = true;
              }
            }
            if (!isValidSurface) continue;
            
            const worldY = baseY + ly;
            const pointKey = `${wx},${wz}`;
            const existing = surfacePoints.get(pointKey);
            
            if (!existing || worldY > existing.height) {
              surfacePoints.set(pointKey, { height: worldY, blockId: bid, x: wx, z: wz });
            }
            break;
          }
        }
      }
    }
  }
  
  if (surfacePoints.size === 0) return null;
  
  // Determine grid size based on LOD level
  // LOD 1: 358x358 (~128k), LOD 2: 253x253 (~64k), LOD 3: 179x179 (~32k), LOD 4: 127x127 (~16k)
  const LOD_GRID_SIZES = [358, 358, 253, 179, 127]; // Index 0 unused, 1-4 are LOD levels
  const gridSize = LOD_GRID_SIZES[Math.min(lodLevel, 4)] || 127;
  
  const rangeX = maxX - minX + 1;
  const rangeZ = maxZ - minZ + 1;
  const cellSizeX = rangeX / gridSize;
  const cellSizeZ = rangeZ / gridSize;
  
  // Create grid of sampled heights
  // gridData[gz][gx] = { height, r, g, b }
  const gridData = [];
  
  for (let gz = 0; gz <= gridSize; gz++) {
    gridData[gz] = [];
    for (let gx = 0; gx <= gridSize; gx++) {
      // World position for this grid vertex
      const wx = minX + gx * cellSizeX;
      const wz = minZ + gz * cellSizeZ;
      
      // Sample height and color from nearby surface points
      const sample = sampleHeightAt(surfacePoints, wx, wz, Math.max(cellSizeX, cellSizeZ));
      
      if (sample) {
        gridData[gz][gx] = {
          height: sample.height,
          r: colorR[sample.blockId],
          g: colorG[sample.blockId],
          b: colorB[sample.blockId]
        };
      } else {
        // No surface point found - interpolate from neighbors later
        gridData[gz][gx] = null;
      }
    }
  }
  
  // Fill in any null cells by interpolating from neighbors
  fillNullCells(gridData, gridSize);
  
  // Build the mesh from the grid
  const ox = offset.x, oy = offset.y, oz = offset.z;
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  
  // Create vertices for each grid point
  const vertexIndices = [];
  for (let gz = 0; gz <= gridSize; gz++) {
    vertexIndices[gz] = [];
    for (let gx = 0; gx <= gridSize; gx++) {
      const data = gridData[gz][gx];
      if (!data) continue;
      
      const vi = positions.length / 3;
      vertexIndices[gz][gx] = vi;
      
      const wx = minX + gx * cellSizeX;
      const wz = minZ + gz * cellSizeZ;
      
      positions.push(wx - ox, data.height + 1 - oy, wz - oz);
      
      // Calculate normal from neighboring heights
      const hL = gx > 0 && gridData[gz][gx-1] ? gridData[gz][gx-1].height : data.height;
      const hR = gx < gridSize && gridData[gz][gx+1] ? gridData[gz][gx+1].height : data.height;
      const hD = gz > 0 && gridData[gz-1][gx] ? gridData[gz-1][gx].height : data.height;
      const hU = gz < gridSize && gridData[gz+1][gx] ? gridData[gz+1][gx].height : data.height;
      
      const nx = (hL - hR) / (2 * cellSizeX);
      const nz = (hD - hU) / (2 * cellSizeZ);
      const len = Math.sqrt(nx * nx + 1 + nz * nz);
      
      normals.push(nx / len, 1 / len, nz / len);
      colors.push(data.r, data.g, data.b);
    }
  }
  
  // Create triangles connecting grid points
  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const v00 = vertexIndices[gz]?.[gx];
      const v10 = vertexIndices[gz]?.[gx + 1];
      const v01 = vertexIndices[gz + 1]?.[gx];
      const v11 = vertexIndices[gz + 1]?.[gx + 1];
      
      // Only create triangles if all 4 vertices exist
      if (v00 !== undefined && v10 !== undefined && v01 !== undefined && v11 !== undefined) {
        // Two triangles per quad (counter-clockwise winding)
        indices.push(v00, v01, v11);
        indices.push(v00, v11, v10);
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
 * Sample height at a world position by finding nearest surface point
 * Uses expanding search radius to ensure we find something
 */
function sampleHeightAt(surfacePoints, wx, wz, searchRadius) {
  // Try exact position first
  const exactKey = `${Math.round(wx)},${Math.round(wz)}`;
  if (surfacePoints.has(exactKey)) {
    return surfacePoints.get(exactKey);
  }
  
  // Search in expanding radius for nearest point
  let bestPoint = null;
  let bestDist = Infinity;
  
  // Start with requested radius, expand if needed
  const cx = Math.round(wx);
  const cz = Math.round(wz);
  
  // Search in multiple passes with increasing radius
  for (let radius = Math.ceil(searchRadius); radius <= searchRadius * 4 && !bestPoint; radius += searchRadius) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const key = `${cx + dx},${cz + dz}`;
        const point = surfacePoints.get(key);
        if (point) {
          const dist = dx * dx + dz * dz;
          if (dist < bestDist) {
            bestDist = dist;
            bestPoint = point;
          }
        }
      }
    }
  }
  
  return bestPoint;
}

/**
 * Fill null cells by interpolating from neighbors
 * Ensures ALL cells get filled - no holes allowed
 */
function fillNullCells(gridData, gridSize) {
  // First, find any valid cell to use as fallback
  let fallback = null;
  for (let gz = 0; gz <= gridSize && !fallback; gz++) {
    for (let gx = 0; gx <= gridSize && !fallback; gx++) {
      if (gridData[gz][gx]) fallback = gridData[gz][gx];
    }
  }
  
  if (!fallback) return; // No valid data at all
  
  // Multiple passes with expanding neighbor search
  for (let pass = 0; pass < 10; pass++) {
    let filled = 0;
    
    for (let gz = 0; gz <= gridSize; gz++) {
      for (let gx = 0; gx <= gridSize; gx++) {
        if (gridData[gz][gx] !== null) continue;
        
        // Collect valid neighbors (expand search radius each pass)
        const neighbors = [];
        const radius = pass + 1;
        
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nz = gz + dz;
            const nx = gx + dx;
            if (nz >= 0 && nz <= gridSize && nx >= 0 && nx <= gridSize) {
              if (gridData[nz][nx]) neighbors.push(gridData[nz][nx]);
            }
          }
        }
        
        if (neighbors.length > 0) {
          // Average neighbors
          let h = 0, r = 0, g = 0, b = 0;
          for (const n of neighbors) {
            h += n.height;
            r += n.r;
            g += n.g;
            b += n.b;
          }
          gridData[gz][gx] = {
            height: h / neighbors.length,
            r: r / neighbors.length,
            g: g / neighbors.length,
            b: b / neighbors.length
          };
          filled++;
        }
      }
    }
    
    // If nothing was filled this pass, and we've done several passes, 
    // use fallback for remaining cells
    if (filled === 0 && pass >= 3) {
      for (let gz = 0; gz <= gridSize; gz++) {
        for (let gx = 0; gx <= gridSize; gx++) {
          if (gridData[gz][gx] === null) {
            gridData[gz][gx] = { ...fallback };
          }
        }
      }
      break;
    }
  }
}

export default buildSimplifiedMesh;

