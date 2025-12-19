import * as THREE from 'three';

/**
 * Greedy Meshing Algorithm
 * 
 * Merges adjacent coplanar faces of the same block type into larger quads,
 * dramatically reducing triangle count for voxel geometry.
 * 
 * For a flat 16x16 surface, this reduces 256 quads (512 triangles) to 1 quad (2 triangles).
 */

// Face definitions matching the original working CulledMesh winding order
// Original corners for a unit cube, translated to greedy mesh (x,y,z) + (width w, height h)
const FACE_INFO = [
  { 
    // Original: [[0,1,1], [1,1,1], [1,1,0], [0,1,0]]
    name: 'top', axis: 1, dir: 1, u: 0, v: 2,
    getCorners: (x, y, z, w, h) => [
      [x,     y + 1, z + h],
      [x + w, y + 1, z + h],
      [x + w, y + 1, z    ],
      [x,     y + 1, z    ],
    ]
  },
  { 
    // Original: [[0,0,0], [1,0,0], [1,0,1], [0,0,1]]
    name: 'bottom', axis: 1, dir: -1, u: 0, v: 2,
    getCorners: (x, y, z, w, h) => [
      [x,     y, z    ],
      [x + w, y, z    ],
      [x + w, y, z + h],
      [x,     y, z + h],
    ]
  },
  { 
    // Original: [[1,0,0], [1,1,0], [1,1,1], [1,0,1]]
    name: 'right', axis: 0, dir: 1, u: 2, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x + 1, y,     z    ],
      [x + 1, y + h, z    ],
      [x + 1, y + h, z + w],
      [x + 1, y,     z + w],
    ]
  },
  { 
    // Original: [[0,0,1], [0,1,1], [0,1,0], [0,0,0]]
    name: 'left', axis: 0, dir: -1, u: 2, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x, y,     z + w],
      [x, y + h, z + w],
      [x, y + h, z    ],
      [x, y,     z    ],
    ]
  },
  { 
    // Original: [[0,0,1], [1,0,1], [1,1,1], [0,1,1]]
    name: 'front', axis: 2, dir: 1, u: 0, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x,     y,     z + 1],
      [x + w, y,     z + 1],
      [x + w, y + h, z + 1],
      [x,     y + h, z + 1],
    ]
  },
  { 
    // Original: [[1,0,0], [0,0,0], [0,1,0], [1,1,0]]
    name: 'back', axis: 2, dir: -1, u: 0, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x + w, y,     z],
      [x,     y,     z],
      [x,     y + h, z],
      [x + w, y + h, z],
    ]
  },
];

/**
 * Build both solid and water meshes with greedy meshing
 * Returns { solidGeometry, waterGeometry, stats }
 * 
 * @param {Function} onProgress - Optional async progress callback (current, total, isLoading, message)
 */
export async function buildGreedyMeshes(blocks, getBlockColor, offset = { x: 0, y: 0, z: 0 }, onProgress = null) {
  const startTime = performance.now();
  
  // Phase 1: Sort blocks (quick, no progress needed)
  const solidBlocks = [];
  const waterBlocks = [];
  
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (isWaterBlock(b.block)) {
      waterBlocks.push(b);
    } else {
      solidBlocks.push(b);
    }
  }

  // Phase 2: Build solid mesh - show as 0/1 -> 1/1
  onProgress?.(0, 1, true, 'Building solid mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));
  
  const solidGeometry = solidBlocks.length > 0 
    ? buildGreedyMeshForType(solidBlocks, waterBlocks, getBlockColor, offset, 1)
    : null;
  
  onProgress?.(1, 1, true, 'Building solid mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));

  // Phase 3: Count water bodies - show as 0/1 -> 1/1
  onProgress?.(0, 1, true, 'Counting water blocks...');
  await new Promise(resolve => setTimeout(resolve, 0));
  
  onProgress?.(1, 1, true, 'Counting water blocks...');
  await new Promise(resolve => setTimeout(resolve, 0));

  // Phase 4: Build water mesh - show as 0/1 -> 1/1
  onProgress?.(0, 1, true, 'Building water mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));
  
  const waterGeometry = waterBlocks.length > 0
    ? buildGreedyMeshForType(waterBlocks, solidBlocks, getBlockColor, offset, 2)
    : null;

  onProgress?.(1, 1, true, 'Building water mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));

  const elapsed = performance.now() - startTime;

  const solidTris = solidGeometry ? solidGeometry.index.count / 3 : 0;
  const waterTris = waterGeometry ? waterGeometry.index.count / 3 : 0;

  return {
    solidGeometry,
    waterGeometry,
    stats: {
      solidBlocks: solidBlocks.length,
      waterBlocks: waterBlocks.length,
      solidTriangles: solidTris,
      waterTriangles: waterTris,
      timeMs: elapsed
    }
  };
}

/**
 * Build greedy mesh for a specific block type with awareness of other blocks
 */
function buildGreedyMeshForType(targetBlocks, otherBlocks, getBlockColor, offset, targetType) {
  if (targetBlocks.length === 0) return null;

  // Combine all blocks for bounds calculation
  const allBlocks = [...targetBlocks, ...otherBlocks];

  // Find bounds
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < allBlocks.length; i++) {
    const b = allBlocks[i];
    if (b.x < minX) minX = b.x;
    if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.y > maxY) maxY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.z > maxZ) maxZ = b.z;
  }

  const sizeX = maxX - minX + 1;
  const sizeY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;
  const sizes = [sizeX, sizeY, sizeZ];
  const mins = [minX, minY, minZ];

  const blockPalette = new Map();
  const paletteList = [null];
  
  // For very large regions, use Map-based lookup to avoid memory allocation failures
  const totalCells = sizeX * sizeY * sizeZ;
  const useMapLookup = totalCells > 100000000; // 100M cells threshold
  
  let grid, typeGrid, getIdx, getPaletteIdx, getBlockType;
  
  if (useMapLookup) {
    // Sparse Map-based lookup for large regions
    const blockMap = new Map(); // key -> paletteIdx
    const typeMap = new Map();  // key -> type
    const key = (x, y, z) => `${x},${y},${z}`;
    
    // Fill maps with target blocks
    for (let i = 0; i < targetBlocks.length; i++) {
      const b = targetBlocks[i];
      let paletteIdx = blockPalette.get(b.block);
      if (paletteIdx === undefined) {
        paletteIdx = paletteList.length;
        blockPalette.set(b.block, paletteIdx);
        paletteList.push(b.block);
      }
      const k = key(b.x, b.y, b.z);
      blockMap.set(k, paletteIdx);
      typeMap.set(k, targetType);
    }
    
    // Fill type map with other blocks
    for (let i = 0; i < otherBlocks.length; i++) {
      const b = otherBlocks[i];
      typeMap.set(key(b.x, b.y, b.z), isWaterBlock(b.block) ? 2 : 1);
    }
    
    getPaletteIdx = (x, y, z) => blockMap.get(key(x, y, z)) || 0;
    getBlockType = (x, y, z) => typeMap.get(key(x, y, z)) || 0;
    
    console.log(`Using Map lookup for ${totalCells.toLocaleString()} cell region`);
  } else {
    // Dense array lookup for smaller regions (faster)
    grid = new Uint16Array(totalCells);
    typeGrid = new Uint8Array(totalCells);
    getIdx = (x, y, z) => (x - minX) + (y - minY) * sizeX + (z - minZ) * sizeX * sizeY;

    // Fill grid with target blocks
    for (let i = 0; i < targetBlocks.length; i++) {
      const b = targetBlocks[i];
      let paletteIdx = blockPalette.get(b.block);
      if (paletteIdx === undefined) {
        paletteIdx = paletteList.length;
        blockPalette.set(b.block, paletteIdx);
        paletteList.push(b.block);
      }
      const idx = getIdx(b.x, b.y, b.z);
      grid[idx] = paletteIdx;
      typeGrid[idx] = targetType;
    }

    // Fill type grid with other blocks (for culling)
    for (let i = 0; i < otherBlocks.length; i++) {
      const b = otherBlocks[i];
      const idx = getIdx(b.x, b.y, b.z);
      typeGrid[idx] = isWaterBlock(b.block) ? 2 : 1;
    }
    
    getPaletteIdx = (x, y, z) => {
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
      return grid[getIdx(x, y, z)];
    };
    getBlockType = (x, y, z) => {
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
      return typeGrid[getIdx(x, y, z)];
    };
  }

  // Determine culling behavior
  // Solid: cull against solid only (show faces toward water/air)
  // Water: cull against solid and water (only show outer surfaces)
  const cullTypes = targetType === 1 ? [1] : [1, 2];

  const shouldCull = (x, y, z) => {
    const type = getBlockType(x, y, z);
    return cullTypes.includes(type);
  };

  // Pre-compute colors
  const paletteColors = paletteList.map(name => {
    if (!name) return null;
    const color = new THREE.Color(getBlockColor(name));
    return { r: color.r, g: color.g, b: color.b };
  });

  // Use dynamic arrays to avoid memory allocation failures on large models
  // Greedy meshing dramatically reduces output size, so pre-allocation estimates are wasteful
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  let vertexCount = 0;

  // Process each face direction
  for (const face of FACE_INFO) {
    const { axis, dir, u, v, getCorners } = face;
    const w = axis;

    const dimU = sizes[u];
    const dimV = sizes[v];
    const dimW = sizes[w];

    // For each slice along the normal axis
    for (let d = 0; d < dimW; d++) {
      // Build 2D mask of visible faces
      const mask = new Uint16Array(dimU * dimV);

      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          // Convert 2D (i, j) + slice d to 3D coordinates
          const coords = [0, 0, 0];
          coords[u] = mins[u] + i;
          coords[v] = mins[v] + j;
          coords[w] = mins[w] + d;

          const [x, y, z] = coords;
          const paletteIdx = getPaletteIdx(x, y, z);

          if (paletteIdx === 0) continue; // No block here

          // Check neighbor in face direction
          const neighborCoords = [...coords];
          neighborCoords[w] += dir;
          const [nx, ny, nz] = neighborCoords;

          if (!shouldCull(nx, ny, nz)) {
            // Face is visible
            mask[i + j * dimU] = paletteIdx;
          }
        }
      }

      // Greedy merge the mask
      const visited = new Uint8Array(dimU * dimV);

      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          const maskIdx = i + j * dimU;
          if (visited[maskIdx] || mask[maskIdx] === 0) continue;

          const paletteIdx = mask[maskIdx];

          // Expand width (along u axis)
          let width = 1;
          while (i + width < dimU) {
            const nextIdx = (i + width) + j * dimU;
            if (visited[nextIdx] || mask[nextIdx] !== paletteIdx) break;
            width++;
          }

          // Expand height (along v axis)
          let height = 1;
          let canExpand = true;
          while (j + height < dimV && canExpand) {
            for (let k = 0; k < width; k++) {
              const checkIdx = (i + k) + (j + height) * dimU;
              if (visited[checkIdx] || mask[checkIdx] !== paletteIdx) {
                canExpand = false;
                break;
              }
            }
            if (canExpand) height++;
          }

          // Mark cells as visited
          for (let dj = 0; dj < height; dj++) {
            for (let di = 0; di < width; di++) {
              visited[(i + di) + (j + dj) * dimU] = 1;
            }
          }

          // Calculate base position for this quad
          const baseCoords = [0, 0, 0];
          baseCoords[u] = mins[u] + i;
          baseCoords[v] = mins[v] + j;
          baseCoords[w] = mins[w] + d;

          const [baseX, baseY, baseZ] = baseCoords;

          // Get the 4 corners with correct winding order
          const corners = getCorners(baseX, baseY, baseZ, width, height);

          const color = paletteColors[paletteIdx];
          const startVertex = vertexCount;

          // Emit 4 vertices
          for (const [cx, cy, cz] of corners) {
            positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
            normals.push(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0);
            colors.push(color.r, color.g, color.b);
            vertexCount++;
          }

          // Two triangles for the quad
          indices.push(
            startVertex, startVertex + 1, startVertex + 2,
            startVertex, startVertex + 2, startVertex + 3
          );
        }
      }
    }
  }

  if (vertexCount === 0) return null;

  // Convert to typed arrays for THREE.js
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}

function isWaterBlock(blockName) {
  if (!blockName) return false;
  const name = blockName.toLowerCase();
  return name.includes('water') || name.includes('flowing_water');
}

/**
 * Subchunk size constant (Minecraft uses 16x16x16 subchunks)
 */
export const SUBCHUNK_SIZE = 16;

/**
 * Calculate subchunk key from world Y coordinate
 * Minecraft Y ranges from -64 to 320, giving 24 subchunks
 */
export function getSubchunkY(worldY) {
  return Math.floor(worldY / SUBCHUNK_SIZE);
}

/**
 * Get the world Y range for a subchunk
 */
export function getSubchunkYRange(subchunkY) {
  return {
    minY: subchunkY * SUBCHUNK_SIZE,
    maxY: (subchunkY + 1) * SUBCHUNK_SIZE - 1
  };
}

/**
 * Build a greedy mesh for a single 16x16x16 subchunk of SOLID blocks only.
 * Water blocks are passed separately for correct face culling but not meshed.
 * 
 * @param {Array} solidBlocks - Solid blocks within this subchunk
 * @param {Array} neighborBlocks - Blocks from neighboring subchunks for correct culling at boundaries
 * @param {Function} getBlockColor - Color lookup function
 * @param {Object} offset - World offset for positioning {x, y, z}
 * @returns {THREE.BufferGeometry|null} - The subchunk geometry or null if empty
 */
export function buildSubchunkMesh(solidBlocks, neighborBlocks, getBlockColor, offset = { x: 0, y: 0, z: 0 }) {
  if (solidBlocks.length === 0) return null;

  // Combine for bounds and culling
  const allBlocks = [...solidBlocks, ...neighborBlocks];

  // Find bounds of all blocks (needed for correct neighbor detection)
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < allBlocks.length; i++) {
    const b = allBlocks[i];
    if (b.x < minX) minX = b.x;
    if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.y > maxY) maxY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.z > maxZ) maxZ = b.z;
  }

  const sizeX = maxX - minX + 1;
  const sizeY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;
  const sizes = [sizeX, sizeY, sizeZ];
  const mins = [minX, minY, minZ];

  const blockPalette = new Map();
  const paletteList = [null];
  
  // Use dense array for subchunks (they're small enough)
  const totalCells = sizeX * sizeY * sizeZ;
  const grid = new Uint16Array(totalCells);
  const typeGrid = new Uint8Array(totalCells);
  
  const getIdx = (x, y, z) => (x - minX) + (y - minY) * sizeX + (z - minZ) * sizeX * sizeY;

  // Fill grid with solid blocks from this subchunk
  for (let i = 0; i < solidBlocks.length; i++) {
    const b = solidBlocks[i];
    let paletteIdx = blockPalette.get(b.block);
    if (paletteIdx === undefined) {
      paletteIdx = paletteList.length;
      blockPalette.set(b.block, paletteIdx);
      paletteList.push(b.block);
    }
    const idx = getIdx(b.x, b.y, b.z);
    grid[idx] = paletteIdx;
    typeGrid[idx] = 1; // Solid
  }

  // Fill type grid with neighbor blocks (for boundary culling)
  for (let i = 0; i < neighborBlocks.length; i++) {
    const b = neighborBlocks[i];
    const idx = getIdx(b.x, b.y, b.z);
    typeGrid[idx] = isWaterBlock(b.block) ? 2 : 1;
  }

  const getPaletteIdx = (x, y, z) => {
    if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
    return grid[getIdx(x, y, z)];
  };
  
  const getBlockType = (x, y, z) => {
    if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
    return typeGrid[getIdx(x, y, z)];
  };

  // Solid blocks cull against solid only (show faces toward water/air)
  const shouldCull = (x, y, z) => {
    const type = getBlockType(x, y, z);
    return type === 1;
  };

  // Pre-compute colors
  const paletteColors = paletteList.map(name => {
    if (!name) return null;
    const color = new THREE.Color(getBlockColor(name));
    return { r: color.r, g: color.g, b: color.b };
  });

  // Use dynamic arrays
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  let vertexCount = 0;

  // Process each face direction
  for (const face of FACE_INFO) {
    const { axis, dir, u, v, getCorners } = face;
    const w = axis;

    const dimU = sizes[u];
    const dimV = sizes[v];
    const dimW = sizes[w];

    // For each slice along the normal axis
    for (let d = 0; d < dimW; d++) {
      // Build 2D mask of visible faces
      const mask = new Uint16Array(dimU * dimV);

      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          const coords = [0, 0, 0];
          coords[u] = mins[u] + i;
          coords[v] = mins[v] + j;
          coords[w] = mins[w] + d;

          const [x, y, z] = coords;
          const paletteIdx = getPaletteIdx(x, y, z);

          if (paletteIdx === 0) continue;

          // Check neighbor in face direction
          const neighborCoords = [...coords];
          neighborCoords[w] += dir;
          const [nx, ny, nz] = neighborCoords;

          if (!shouldCull(nx, ny, nz)) {
            mask[i + j * dimU] = paletteIdx;
          }
        }
      }

      // Greedy merge the mask
      const visited = new Uint8Array(dimU * dimV);

      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          const maskIdx = i + j * dimU;
          if (visited[maskIdx] || mask[maskIdx] === 0) continue;

          const paletteIdx = mask[maskIdx];

          // Expand width
          let width = 1;
          while (i + width < dimU) {
            const nextIdx = (i + width) + j * dimU;
            if (visited[nextIdx] || mask[nextIdx] !== paletteIdx) break;
            width++;
          }

          // Expand height
          let height = 1;
          let canExpand = true;
          while (j + height < dimV && canExpand) {
            for (let k = 0; k < width; k++) {
              const checkIdx = (i + k) + (j + height) * dimU;
              if (visited[checkIdx] || mask[checkIdx] !== paletteIdx) {
                canExpand = false;
                break;
              }
            }
            if (canExpand) height++;
          }

          // Mark as visited
          for (let dj = 0; dj < height; dj++) {
            for (let di = 0; di < width; di++) {
              visited[(i + di) + (j + dj) * dimU] = 1;
            }
          }

          // Calculate base position
          const baseCoords = [0, 0, 0];
          baseCoords[u] = mins[u] + i;
          baseCoords[v] = mins[v] + j;
          baseCoords[w] = mins[w] + d;

          const [baseX, baseY, baseZ] = baseCoords;
          const corners = getCorners(baseX, baseY, baseZ, width, height);
          const color = paletteColors[paletteIdx];
          const startVertex = vertexCount;

          // Emit 4 vertices
          for (const [cx, cy, cz] of corners) {
            positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
            normals.push(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0);
            colors.push(color.r, color.g, color.b);
            vertexCount++;
          }

          // Two triangles
          indices.push(
            startVertex, startVertex + 1, startVertex + 2,
            startVertex, startVertex + 2, startVertex + 3
          );
        }
      }
    }
  }

  if (vertexCount === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}

/**
 * Build a greedy mesh for a single 16x16x16 subchunk of WATER blocks.
 * Water culls against both water AND solid blocks to only show outer surfaces.
 * 
 * @param {Array} waterBlocks - Water blocks within this subchunk
 * @param {Array} neighborBlocks - Blocks (water + solid) from neighboring subchunks for correct culling
 * @param {Function} getBlockColor - Color lookup function
 * @param {Object} offset - World offset for positioning {x, y, z}
 * @returns {THREE.BufferGeometry|null} - The subchunk geometry or null if empty
 */
export function buildWaterSubchunkMesh(waterBlocks, neighborBlocks, getBlockColor, offset = { x: 0, y: 0, z: 0 }) {
  if (waterBlocks.length === 0) return null;

  // Combine for bounds and culling
  const allBlocks = [...waterBlocks, ...neighborBlocks];

  // Find bounds of all blocks
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < allBlocks.length; i++) {
    const b = allBlocks[i];
    if (b.x < minX) minX = b.x;
    if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.y > maxY) maxY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.z > maxZ) maxZ = b.z;
  }

  const sizeX = maxX - minX + 1;
  const sizeY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;
  const sizes = [sizeX, sizeY, sizeZ];
  const mins = [minX, minY, minZ];

  const blockPalette = new Map();
  const paletteList = [null];
  
  const totalCells = sizeX * sizeY * sizeZ;
  const grid = new Uint16Array(totalCells);
  const typeGrid = new Uint8Array(totalCells); // 0=air, 1=solid, 2=water
  
  const getIdx = (x, y, z) => (x - minX) + (y - minY) * sizeX + (z - minZ) * sizeX * sizeY;

  // Fill grid with water blocks from this subchunk
  for (let i = 0; i < waterBlocks.length; i++) {
    const b = waterBlocks[i];
    let paletteIdx = blockPalette.get(b.block);
    if (paletteIdx === undefined) {
      paletteIdx = paletteList.length;
      blockPalette.set(b.block, paletteIdx);
      paletteList.push(b.block);
    }
    const idx = getIdx(b.x, b.y, b.z);
    grid[idx] = paletteIdx;
    typeGrid[idx] = 2; // Water
  }

  // Fill type grid with neighbor blocks (for boundary culling)
  for (let i = 0; i < neighborBlocks.length; i++) {
    const b = neighborBlocks[i];
    const idx = getIdx(b.x, b.y, b.z);
    typeGrid[idx] = isWaterBlock(b.block) ? 2 : 1;
  }

  const getPaletteIdx = (x, y, z) => {
    if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
    return grid[getIdx(x, y, z)];
  };
  
  const getBlockType = (x, y, z) => {
    if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
    return typeGrid[getIdx(x, y, z)];
  };

  // Water culls against both water AND solid (only show outer surfaces)
  const shouldCull = (x, y, z) => {
    const type = getBlockType(x, y, z);
    return type === 1 || type === 2; // Cull if solid or water
  };

  // Pre-compute colors
  const paletteColors = paletteList.map(name => {
    if (!name) return null;
    const color = new THREE.Color(getBlockColor(name));
    return { r: color.r, g: color.g, b: color.b };
  });

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  let vertexCount = 0;

  // Process each face direction
  for (const face of FACE_INFO) {
    const { axis, dir, u, v, getCorners } = face;
    const w = axis;

    const dimU = sizes[u];
    const dimV = sizes[v];
    const dimW = sizes[w];

    for (let d = 0; d < dimW; d++) {
      const mask = new Uint16Array(dimU * dimV);

      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          const coords = [0, 0, 0];
          coords[u] = mins[u] + i;
          coords[v] = mins[v] + j;
          coords[w] = mins[w] + d;

          const [x, y, z] = coords;
          const paletteIdx = getPaletteIdx(x, y, z);

          if (paletteIdx === 0) continue;

          const neighborCoords = [...coords];
          neighborCoords[w] += dir;
          const [nx, ny, nz] = neighborCoords;

          if (!shouldCull(nx, ny, nz)) {
            mask[i + j * dimU] = paletteIdx;
          }
        }
      }

      const visited = new Uint8Array(dimU * dimV);

      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          const maskIdx = i + j * dimU;
          if (visited[maskIdx] || mask[maskIdx] === 0) continue;

          const paletteIdx = mask[maskIdx];

          let width = 1;
          while (i + width < dimU) {
            const nextIdx = (i + width) + j * dimU;
            if (visited[nextIdx] || mask[nextIdx] !== paletteIdx) break;
            width++;
          }

          let height = 1;
          let canExpand = true;
          while (j + height < dimV && canExpand) {
            for (let k = 0; k < width; k++) {
              const checkIdx = (i + k) + (j + height) * dimU;
              if (visited[checkIdx] || mask[checkIdx] !== paletteIdx) {
                canExpand = false;
                break;
              }
            }
            if (canExpand) height++;
          }

          for (let dj = 0; dj < height; dj++) {
            for (let di = 0; di < width; di++) {
              visited[(i + di) + (j + dj) * dimU] = 1;
            }
          }

          const baseCoords = [0, 0, 0];
          baseCoords[u] = mins[u] + i;
          baseCoords[v] = mins[v] + j;
          baseCoords[w] = mins[w] + d;

          const [baseX, baseY, baseZ] = baseCoords;
          const corners = getCorners(baseX, baseY, baseZ, width, height);
          const color = paletteColors[paletteIdx];
          const startVertex = vertexCount;

          for (const [cx, cy, cz] of corners) {
            positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
            normals.push(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0);
            colors.push(color.r, color.g, color.b);
            vertexCount++;
          }

          indices.push(
            startVertex, startVertex + 1, startVertex + 2,
            startVertex, startVertex + 2, startVertex + 3
          );
        }
      }
    }
  }

  if (vertexCount === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}
