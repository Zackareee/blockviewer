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
 * Fluid Level to Height Conversion
 * 
 * Minecraft fluid levels:
 * - 0: Source block (full height)
 * - 1-7: Flowing (progressively lower)
 * - 8-15: Falling (vertical flow, rendered at full height)
 * 
 * Height formula: For levels 0-7, height decreases linearly
 * Level 0 = 0.875 (14/16), Level 7 = 0.125 (2/16)
 * This matches Minecraft's visual appearance where even source blocks
 * aren't quite full height.
 */

/**
 * Convert fluid level to height (0.0 to 1.0)
 * @param {number} level - Fluid level (0-15, or undefined for source)
 * @returns {number} Height from 0.0 to 1.0
 */
function fluidLevelToHeight(level) {
  // Undefined or invalid level = source block
  if (level === undefined || level === null || level < 0) {
    return 14 / 16; // 0.875 - source blocks in Minecraft are slightly below full
  }
  
  // Falling fluid (level 8-15) is rendered at full block height
  // This ensures it connects properly with blocks below
  if (level >= 8) {
    return 1.0;
  }
  
  // Flowing fluid (level 1-7): height decreases linearly
  // Level 0 = 14/16, Level 7 = 2/16
  const height = (14 - level * 1.5) / 16;
  return Math.max(2 / 16, height); // Minimum height of 2/16
}

/**
 * Calculate corner heights for a fluid block with sloping for flowing water
 * Each corner's height is the average of the heights of the 4 blocks touching that corner
 * 
 * @param {number} x - Block X coordinate
 * @param {number} y - Block Y coordinate  
 * @param {number} z - Block Z coordinate
 * @param {Function} getFluidLevel - Function to get fluid level at (x, y, z), returns undefined if not fluid
 * @param {Function} isSolidBlock - Function to check if block at (x, y, z) is solid
 * @returns {Object} Corner heights: { nw, ne, se, sw } (values 0.0-1.0)
 */
function calculateFluidCornerHeights(x, y, z, getFluidLevel, isSolidBlock) {
  const ownLevel = getFluidLevel(x, y, z);
  const ownHeight = fluidLevelToHeight(ownLevel);
  
  // Check if there's fluid above - if so, this block is submerged (full height)
  const hasFluidAbove = getFluidLevel(x, y + 1, z) !== undefined;
  if (hasFluidAbove) {
    return { nw: 1.0, ne: 1.0, se: 1.0, sw: 1.0 };
  }
  
  // For source blocks (level 0 or undefined) and falling water (level 8+), use flat top
  // Falling water should not slope - it's a vertical column
  if (ownLevel === undefined || ownLevel === 0 || ownLevel >= 8) {
    return { nw: ownHeight, ne: ownHeight, se: ownHeight, sw: ownHeight };
  }
  
  // For flowing blocks, calculate corner heights by averaging neighbors
  // Each corner averages the 4 blocks that touch it (including this block)
  // EXCEPT: if any neighbor is source/falling water, snap to that height for seamless connection
  
  // Helper to get height and level info from a neighbor
  const getNeighborInfo = (nx, nz) => {
    const level = getFluidLevel(nx, y, nz);
    if (level !== undefined) {
      // Check if neighbor has fluid above (submerged = full height)
      if (getFluidLevel(nx, y + 1, nz) !== undefined) {
        return { height: 1.0, isNonFlowing: true };
      }
      const height = fluidLevelToHeight(level);
      // Source (level 0) or falling (level 8+) water is "non-flowing"
      const isNonFlowing = level === 0 || level >= 8;
      return { height, isNonFlowing };
    }
    // If neighbor is solid, don't contribute to average (water rises against walls)
    if (isSolidBlock(nx, y, nz)) {
      return null;
    }
    // Air/empty neighbor - water slopes down toward air
    return { height: 0, isNonFlowing: false };
  };
  
  // Calculate corner height - if any neighbor is source/falling, use MAX; otherwise average
  const calculateCorner = (offsets) => {
    const neighbors = [];
    let hasNonFlowing = false;
    let maxNonFlowingHeight = ownHeight;
    
    // Collect neighbor info
    for (const [dx, dz] of offsets) {
      const info = getNeighborInfo(x + dx, z + dz);
      if (info !== null) {
        neighbors.push(info);
        if (info.isNonFlowing) {
          hasNonFlowing = true;
          maxNonFlowingHeight = Math.max(maxNonFlowingHeight, info.height);
        }
      }
    }
    
    // If any neighbor is source/falling water, use the max height to ensure seamless connection
    if (hasNonFlowing) {
      return maxNonFlowingHeight;
    }
    
    // Otherwise average all heights (including own)
    let sum = ownHeight;
    let count = 1;
    for (const info of neighbors) {
      sum += info.height;
      count++;
    }
    
    return sum / count;
  };
  
  // Corner neighbor offsets (the 3 other blocks touching each corner besides this one)
  // NW corner (x, z): neighbors at (x-1, z), (x, z-1), (x-1, z-1)
  const nw = calculateCorner([[-1, 0], [0, -1], [-1, -1]]);
  // NE corner (x+1, z): neighbors at (x+1, z), (x, z-1), (x+1, z-1)
  const ne = calculateCorner([[1, 0], [0, -1], [1, -1]]);
  // SE corner (x+1, z+1): neighbors at (x+1, z), (x, z+1), (x+1, z+1)
  const se = calculateCorner([[1, 0], [0, 1], [1, 1]]);
  // SW corner (x, z+1): neighbors at (x-1, z), (x, z+1), (x-1, z+1)
  const sw = calculateCorner([[-1, 0], [0, 1], [-1, 1]]);
  
  return { nw, ne, se, sw };
}

/**
 * Build solid, water, and lava meshes with greedy meshing
 * Returns { solidGeometry, waterGeometry, lavaGeometry, stats }
 * 
 * @param {Function} onProgress - Optional async progress callback (current, total, isLoading, message)
 */
export async function buildGreedyMeshes(blocks, getBlockColor, offset = { x: 0, y: 0, z: 0 }, onProgress = null) {
  const startTime = performance.now();
  
  // Phase 1: Sort blocks (quick, no progress needed)
  const solidBlocks = [];
  const waterBlocks = [];
  const lavaBlocks = [];
  
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (isWaterBlock(b.block)) {
      waterBlocks.push(b);
    } else if (isLavaBlock(b.block)) {
      lavaBlocks.push(b);
    } else {
      solidBlocks.push(b);
    }
  }

  // Phase 2: Build solid mesh - show as 0/1 -> 1/1
  onProgress?.(0, 1, true, 'Building solid mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));
  
  // Combine water and lava as "other" blocks for culling
  const otherBlocks = [...waterBlocks, ...lavaBlocks];
  const solidGeometry = solidBlocks.length > 0 
    ? buildGreedyMeshForType(solidBlocks, otherBlocks, getBlockColor, offset, 1)
    : null;
  
  onProgress?.(1, 1, true, 'Building solid mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));

  // Phase 3: Build water mesh - show as 0/1 -> 1/1
  onProgress?.(0, 1, true, 'Building water mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));
  
  const waterGeometry = waterBlocks.length > 0
    ? buildGreedyMeshForType(waterBlocks, [...solidBlocks, ...lavaBlocks], getBlockColor, offset, 2)
    : null;

  onProgress?.(1, 1, true, 'Building water mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));

  // Phase 4: Build lava mesh - show as 0/1 -> 1/1
  onProgress?.(0, 1, true, 'Building lava mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));
  
  const lavaGeometry = lavaBlocks.length > 0
    ? buildGreedyMeshForType(lavaBlocks, [...solidBlocks, ...waterBlocks], getBlockColor, offset, 3)
    : null;

  onProgress?.(1, 1, true, 'Building lava mesh...');
  await new Promise(resolve => setTimeout(resolve, 0));

  const elapsed = performance.now() - startTime;

  const solidTris = solidGeometry ? solidGeometry.index.count / 3 : 0;
  const waterTris = waterGeometry ? waterGeometry.index.count / 3 : 0;
  const lavaTris = lavaGeometry ? lavaGeometry.index.count / 3 : 0;

  return {
    solidGeometry,
    waterGeometry,
    lavaGeometry,
    stats: {
      solidBlocks: solidBlocks.length,
      waterBlocks: waterBlocks.length,
      lavaBlocks: lavaBlocks.length,
      solidTriangles: solidTris,
      waterTriangles: waterTris,
      lavaTriangles: lavaTris,
      timeMs: elapsed
    }
  };
}

/**
 * Build greedy mesh for a specific block type with awareness of other blocks.
 * For fluids (water/lava), the top faces are rendered with sloped corners for flowing blocks.
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
  
  // Check if this is a fluid type (water=2, lava=3)
  const isFluid = targetType === 2 || targetType === 3;
  
  // For very large regions, use Map-based lookup to avoid memory allocation failures
  const totalCells = sizeX * sizeY * sizeZ;
  const useMapLookup = totalCells > 100000000; // 100M cells threshold
  
  let grid, typeGrid, levelGrid, getIdx, getPaletteIdx, getBlockType, getFluidLevel, isSolidBlockAt;
  
  // Build level lookup for fluids
  const levelMap = isFluid ? new Map() : null;
  
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
      if (isFluid) {
        levelMap.set(k, b.level !== undefined ? b.level : 0);
      }
    }
    
    // Fill type map with other blocks
    for (let i = 0; i < otherBlocks.length; i++) {
      const b = otherBlocks[i];
      const k = key(b.x, b.y, b.z);
      if (isWaterBlock(b.block)) {
        typeMap.set(k, 2);
        if (targetType === 2) levelMap.set(k, b.level !== undefined ? b.level : 0);
      } else if (isLavaBlock(b.block)) {
        typeMap.set(k, 3);
        if (targetType === 3) levelMap.set(k, b.level !== undefined ? b.level : 0);
      } else {
        typeMap.set(k, 1);
      }
    }
    
    getPaletteIdx = (x, y, z) => blockMap.get(key(x, y, z)) || 0;
    getBlockType = (x, y, z) => typeMap.get(key(x, y, z)) || 0;
    getFluidLevel = (x, y, z) => {
      const k = key(x, y, z);
      if (typeMap.get(k) !== targetType) return undefined;
      return levelMap.get(k);
    };
    isSolidBlockAt = (x, y, z) => typeMap.get(key(x, y, z)) === 1;
    
    console.log(`Using Map lookup for ${totalCells.toLocaleString()} cell region`);
  } else {
    // Dense array lookup for smaller regions (faster)
    grid = new Uint16Array(totalCells);
    typeGrid = new Uint8Array(totalCells);
    if (isFluid) {
      levelGrid = new Int8Array(totalCells);
      levelGrid.fill(-1); // -1 = not a fluid of this type
    }
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
      if (isFluid) {
        levelGrid[idx] = b.level !== undefined ? b.level : 0;
      }
    }

    // Fill type grid with other blocks (for culling)
    for (let i = 0; i < otherBlocks.length; i++) {
      const b = otherBlocks[i];
      const idx = getIdx(b.x, b.y, b.z);
      if (isWaterBlock(b.block)) {
        typeGrid[idx] = 2;
        if (isFluid && targetType === 2) levelGrid[idx] = b.level !== undefined ? b.level : 0;
      } else if (isLavaBlock(b.block)) {
        typeGrid[idx] = 3;
        if (isFluid && targetType === 3) levelGrid[idx] = b.level !== undefined ? b.level : 0;
      } else {
        typeGrid[idx] = 1;
      }
    }
    
    getPaletteIdx = (x, y, z) => {
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
      return grid[getIdx(x, y, z)];
    };
    getBlockType = (x, y, z) => {
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
      return typeGrid[getIdx(x, y, z)];
    };
    getFluidLevel = (x, y, z) => {
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return undefined;
      const idx = getIdx(x, y, z);
      if (typeGrid[idx] !== targetType) return undefined;
      return levelGrid[idx];
    };
    isSolidBlockAt = (x, y, z) => {
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return false;
      return typeGrid[getIdx(x, y, z)] === 1;
    };
  }

  // Determine culling behavior
  // Solid (1): cull against solid only (show faces toward water/lava/air)
  // Water (2): cull against solid and water (only show outer surfaces)
  // Lava (3): cull against solid and lava (only show outer surfaces)
  let cullTypes;
  if (targetType === 1) {
    cullTypes = [1]; // Solid culls against solid only
  } else if (targetType === 2) {
    cullTypes = [1, 2]; // Water culls against solid and water
  } else {
    cullTypes = [1, 3]; // Lava culls against solid and lava
  }

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

  // For fluids, generate all faces per-block with height-adjusted vertices
  // For solids, use greedy meshing
  if (isFluid) {
    // Debug: log level distribution
    const levelCounts = {};
    for (let i = 0; i < targetBlocks.length; i++) {
      const lvl = targetBlocks[i].level;
      levelCounts[lvl === undefined ? 'undefined' : lvl] = (levelCounts[lvl === undefined ? 'undefined' : lvl] || 0) + 1;
    }
    console.log('buildGreedyMeshForType fluid level distribution:', levelCounts);
    
    for (let i = 0; i < targetBlocks.length; i++) {
      const block = targetBlocks[i];
      const { x, y, z } = block;
      
      const paletteIdx = getPaletteIdx(x, y, z);
      if (paletteIdx === 0) continue;
      
      const color = paletteColors[paletteIdx];
      
      // Calculate corner heights for this fluid block
      const cornerHeights = calculateFluidCornerHeights(x, y, z, getFluidLevel, isSolidBlockAt);
      
      // Debug: log first few non-zero level blocks
      if (block.level !== undefined && block.level > 0 && i < 5) {
        console.log(`buildGreedyMeshForType flowing fluid at (${x},${y},${z}) level=${block.level} corners=`, cornerHeights);
      }
      
      // Heights at each corner of the block:
      const hNW = cornerHeights.nw;
      const hNE = cornerHeights.ne;
      const hSE = cornerHeights.se;
      const hSW = cornerHeights.sw;
      
      // TOP FACE - if visible
      if (!shouldCull(x, y + 1, z)) {
        const startVertex = vertexCount;
        const topCorners = [
          [x,     y + hSW, z + 1],
          [x + 1, y + hSE, z + 1],
          [x + 1, y + hNE, z    ],
          [x,     y + hNW, z    ],
        ];
        for (const [cx, cy, cz] of topCorners) {
          positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
          normals.push(0, 1, 0);
          colors.push(color.r, color.g, color.b);
          vertexCount++;
        }
        indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
      }
      
      // BOTTOM FACE - if visible
      if (!shouldCull(x, y - 1, z)) {
        const startVertex = vertexCount;
        const bottomCorners = [
          [x,     y, z    ],
          [x + 1, y, z    ],
          [x + 1, y, z + 1],
          [x,     y, z + 1],
        ];
        for (const [cx, cy, cz] of bottomCorners) {
          positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
          normals.push(0, -1, 0);
          colors.push(color.r, color.g, color.b);
          vertexCount++;
        }
        indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
      }
      
      // FRONT FACE (+Z) - if visible
      if (!shouldCull(x, y, z + 1)) {
        const startVertex = vertexCount;
        const frontCorners = [
          [x,     y,      z + 1],
          [x + 1, y,      z + 1],
          [x + 1, y + hSE, z + 1],
          [x,     y + hSW, z + 1],
        ];
        for (const [cx, cy, cz] of frontCorners) {
          positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
          normals.push(0, 0, 1);
          colors.push(color.r, color.g, color.b);
          vertexCount++;
        }
        indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
      }
      
      // BACK FACE (-Z) - if visible
      if (!shouldCull(x, y, z - 1)) {
        const startVertex = vertexCount;
        const backCorners = [
          [x + 1, y,      z],
          [x,     y,      z],
          [x,     y + hNW, z],
          [x + 1, y + hNE, z],
        ];
        for (const [cx, cy, cz] of backCorners) {
          positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
          normals.push(0, 0, -1);
          colors.push(color.r, color.g, color.b);
          vertexCount++;
        }
        indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
      }
      
      // RIGHT FACE (+X) - if visible
      if (!shouldCull(x + 1, y, z)) {
        const startVertex = vertexCount;
        const rightCorners = [
          [x + 1, y,      z    ],
          [x + 1, y + hNE, z    ],
          [x + 1, y + hSE, z + 1],
          [x + 1, y,      z + 1],
        ];
        for (const [cx, cy, cz] of rightCorners) {
          positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
          normals.push(1, 0, 0);
          colors.push(color.r, color.g, color.b);
          vertexCount++;
        }
        indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
      }
      
      // LEFT FACE (-X) - if visible
      if (!shouldCull(x - 1, y, z)) {
        const startVertex = vertexCount;
        const leftCorners = [
          [x, y,      z + 1],
          [x, y + hSW, z + 1],
          [x, y + hNW, z    ],
          [x, y,      z    ],
        ];
        for (const [cx, cy, cz] of leftCorners) {
          positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
          normals.push(-1, 0, 0);
          colors.push(color.r, color.g, color.b);
          vertexCount++;
        }
        indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
      }
    }
  } else {
    // Solid blocks: use greedy meshing for efficiency
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

function isLavaBlock(blockName) {
  if (!blockName) return false;
  const name = blockName.toLowerCase();
  return name.includes('lava') || name.includes('flowing_lava');
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
 * Build a mesh for fluid blocks (water/lava) with sloped top faces for flowing fluids.
 * 
 * @param {Array} fluidBlocks - Fluid blocks within this subchunk (with optional .level property)
 * @param {Array} neighborBlocks - Blocks from neighboring subchunks for correct culling
 * @param {Function} getBlockColor - Color lookup function
 * @param {Object} offset - World offset for positioning {x, y, z}
 * @param {number} fluidType - 2 for water, 3 for lava
 * @param {Function} isFluidBlock - Function to check if a block name is this type of fluid
 * @returns {THREE.BufferGeometry|null} - The subchunk geometry or null if empty
 */
function buildFluidSubchunkMeshWithSlopes(fluidBlocks, neighborBlocks, getBlockColor, offset, fluidType, isFluidBlock) {
  if (fluidBlocks.length === 0) return null;

  // Combine for bounds and culling
  const allBlocks = [...fluidBlocks, ...neighborBlocks];

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

  const blockPalette = new Map();
  const paletteList = [null];
  
  const totalCells = sizeX * sizeY * sizeZ;
  const grid = new Uint16Array(totalCells);
  const typeGrid = new Uint8Array(totalCells); // 0=air, 1=solid, 2=water, 3=lava
  const levelGrid = new Int8Array(totalCells); // Fluid levels (-1 = not fluid/source)
  levelGrid.fill(-1);
  
  const getIdx = (x, y, z) => (x - minX) + (y - minY) * sizeX + (z - minZ) * sizeX * sizeY;

  // Build a map of fluid blocks for quick level lookup
  const fluidBlockMap = new Map();
  
  // Fill grid with fluid blocks from this subchunk
  for (let i = 0; i < fluidBlocks.length; i++) {
    const b = fluidBlocks[i];
    let paletteIdx = blockPalette.get(b.block);
    if (paletteIdx === undefined) {
      paletteIdx = paletteList.length;
      blockPalette.set(b.block, paletteIdx);
      paletteList.push(b.block);
    }
    const idx = getIdx(b.x, b.y, b.z);
    grid[idx] = paletteIdx;
    typeGrid[idx] = fluidType;
    levelGrid[idx] = b.level !== undefined ? b.level : 0; // Default to source (0) if no level
    fluidBlockMap.set(`${b.x},${b.y},${b.z}`, b);
  }

  // Fill grids with neighbor blocks (for boundary culling and level lookup)
  for (let i = 0; i < neighborBlocks.length; i++) {
    const b = neighborBlocks[i];
    if (b.x < minX || b.x > maxX || b.y < minY || b.y > maxY || b.z < minZ || b.z > maxZ) continue;
    const idx = getIdx(b.x, b.y, b.z);
    if (isFluidBlock(b.block)) {
      typeGrid[idx] = fluidType;
      levelGrid[idx] = b.level !== undefined ? b.level : 0;
      fluidBlockMap.set(`${b.x},${b.y},${b.z}`, b);
    } else if (isWaterBlock(b.block)) {
      typeGrid[idx] = 2;
    } else if (isLavaBlock(b.block)) {
      typeGrid[idx] = 3;
    } else {
      typeGrid[idx] = 1; // Solid
    }
  }

  const getPaletteIdx = (x, y, z) => {
    if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
    return grid[getIdx(x, y, z)];
  };
  
  const getBlockType = (x, y, z) => {
    if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return 0;
    return typeGrid[getIdx(x, y, z)];
  };
  
  // Get fluid level at position (returns undefined if not this type of fluid)
  const getFluidLevel = (x, y, z) => {
    if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return undefined;
    const idx = getIdx(x, y, z);
    if (typeGrid[idx] !== fluidType) return undefined;
    return levelGrid[idx];
  };
  
  // Check if block is solid
  const isSolidBlock = (x, y, z) => {
    return getBlockType(x, y, z) === 1;
  };

  // Fluid culls against both same-fluid AND solid (only show outer surfaces)
  const shouldCull = (x, y, z) => {
    const type = getBlockType(x, y, z);
    return type === 1 || type === fluidType; // Cull if solid or same fluid
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

  // Debug: log level distribution
  const levelCounts = {};
  for (let i = 0; i < fluidBlocks.length; i++) {
    const lvl = fluidBlocks[i].level;
    levelCounts[lvl === undefined ? 'undefined' : lvl] = (levelCounts[lvl === undefined ? 'undefined' : lvl] || 0) + 1;
  }
  console.log('Fluid level distribution:', levelCounts);

  // For fluids, generate all faces per-block with height-adjusted vertices
  // This is necessary because the top edge of side faces needs to match the fluid height
  for (let i = 0; i < fluidBlocks.length; i++) {
    const block = fluidBlocks[i];
    const { x, y, z } = block;
    
    const paletteIdx = getPaletteIdx(x, y, z);
    if (paletteIdx === 0) continue;
    
    const color = paletteColors[paletteIdx];
    
    // Calculate corner heights for this fluid block
    const cornerHeights = calculateFluidCornerHeights(x, y, z, getFluidLevel, isSolidBlock);
    
    // Debug: log first few non-zero level blocks
    if (block.level !== undefined && block.level > 0 && i < 5) {
      console.log(`Flowing fluid at (${x},${y},${z}) level=${block.level} corners=`, cornerHeights);
    }
    
    // Heights at each corner of the block:
    // NW = (x, z), NE = (x+1, z), SE = (x+1, z+1), SW = (x, z+1)
    const hNW = cornerHeights.nw;
    const hNE = cornerHeights.ne;
    const hSE = cornerHeights.se;
    const hSW = cornerHeights.sw;
    
    // TOP FACE - if visible
    if (!shouldCull(x, y + 1, z)) {
      const startVertex = vertexCount;
      // Corners: SW, SE, NE, NW (matching original winding)
      const topCorners = [
        [x,     y + hSW, z + 1], // SW
        [x + 1, y + hSE, z + 1], // SE
        [x + 1, y + hNE, z    ], // NE
        [x,     y + hNW, z    ], // NW
      ];
      for (const [cx, cy, cz] of topCorners) {
        positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
        normals.push(0, 1, 0);
        colors.push(color.r, color.g, color.b);
        vertexCount++;
      }
      indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
    }
    
    // BOTTOM FACE - if visible
    if (!shouldCull(x, y - 1, z)) {
      const startVertex = vertexCount;
      // Corners: NW, NE, SE, SW (matching original winding)
      const bottomCorners = [
        [x,     y, z    ], // NW
        [x + 1, y, z    ], // NE
        [x + 1, y, z + 1], // SE
        [x,     y, z + 1], // SW
      ];
      for (const [cx, cy, cz] of bottomCorners) {
        positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
        normals.push(0, -1, 0);
        colors.push(color.r, color.g, color.b);
        vertexCount++;
      }
      indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
    }
    
    // FRONT FACE (+Z) - if visible
    if (!shouldCull(x, y, z + 1)) {
      const startVertex = vertexCount;
      // Corners with height-adjusted top
      const frontCorners = [
        [x,     y,      z + 1], // bottom-left
        [x + 1, y,      z + 1], // bottom-right
        [x + 1, y + hSE, z + 1], // top-right (SE corner)
        [x,     y + hSW, z + 1], // top-left (SW corner)
      ];
      for (const [cx, cy, cz] of frontCorners) {
        positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
        normals.push(0, 0, 1);
        colors.push(color.r, color.g, color.b);
        vertexCount++;
      }
      indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
    }
    
    // BACK FACE (-Z) - if visible
    if (!shouldCull(x, y, z - 1)) {
      const startVertex = vertexCount;
      // Corners with height-adjusted top
      const backCorners = [
        [x + 1, y,      z], // bottom-left (from back view)
        [x,     y,      z], // bottom-right
        [x,     y + hNW, z], // top-right (NW corner)
        [x + 1, y + hNE, z], // top-left (NE corner)
      ];
      for (const [cx, cy, cz] of backCorners) {
        positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
        normals.push(0, 0, -1);
        colors.push(color.r, color.g, color.b);
        vertexCount++;
      }
      indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
    }
    
    // RIGHT FACE (+X) - if visible
    if (!shouldCull(x + 1, y, z)) {
      const startVertex = vertexCount;
      // Corners with height-adjusted top
      const rightCorners = [
        [x + 1, y,      z    ], // bottom-back
        [x + 1, y + hNE, z    ], // top-back (NE corner)
        [x + 1, y + hSE, z + 1], // top-front (SE corner)
        [x + 1, y,      z + 1], // bottom-front
      ];
      for (const [cx, cy, cz] of rightCorners) {
        positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
        normals.push(1, 0, 0);
        colors.push(color.r, color.g, color.b);
        vertexCount++;
      }
      indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
    }
    
    // LEFT FACE (-X) - if visible
    if (!shouldCull(x - 1, y, z)) {
      const startVertex = vertexCount;
      // Corners with height-adjusted top
      const leftCorners = [
        [x, y,      z + 1], // bottom-front
        [x, y + hSW, z + 1], // top-front (SW corner)
        [x, y + hNW, z    ], // top-back (NW corner)
        [x, y,      z    ], // bottom-back
      ];
      for (const [cx, cy, cz] of leftCorners) {
        positions.push(cx - offset.x, cy - offset.y, cz - offset.z);
        normals.push(-1, 0, 0);
        colors.push(color.r, color.g, color.b);
        vertexCount++;
      }
      indices.push(startVertex, startVertex + 1, startVertex + 2, startVertex, startVertex + 2, startVertex + 3);
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
 * Build a mesh for a single 16x16x16 subchunk of WATER blocks with sloped flowing water.
 * Water culls against both water AND solid blocks to only show outer surfaces.
 * 
 * @param {Array} waterBlocks - Water blocks within this subchunk
 * @param {Array} neighborBlocks - Blocks (water + solid) from neighboring subchunks for correct culling
 * @param {Function} getBlockColor - Color lookup function
 * @param {Object} offset - World offset for positioning {x, y, z}
 * @returns {THREE.BufferGeometry|null} - The subchunk geometry or null if empty
 */
export function buildWaterSubchunkMesh(waterBlocks, neighborBlocks, getBlockColor, offset = { x: 0, y: 0, z: 0 }) {
  return buildFluidSubchunkMeshWithSlopes(waterBlocks, neighborBlocks, getBlockColor, offset, 2, isWaterBlock);
}

/**
 * Build a mesh for a single 16x16x16 subchunk of LAVA blocks with sloped flowing lava.
 * Lava culls against both lava AND solid blocks to only show outer surfaces.
 * 
 * @param {Array} lavaBlocks - Lava blocks within this subchunk
 * @param {Array} neighborBlocks - Blocks (lava + solid) from neighboring subchunks for correct culling
 * @param {Function} getBlockColor - Color lookup function
 * @param {Object} offset - World offset for positioning {x, y, z}
 * @returns {THREE.BufferGeometry|null} - The subchunk geometry or null if empty
 */
export function buildLavaSubchunkMesh(lavaBlocks, neighborBlocks, getBlockColor, offset = { x: 0, y: 0, z: 0 }) {
  return buildFluidSubchunkMeshWithSlopes(lavaBlocks, neighborBlocks, getBlockColor, offset, 3, isLavaBlock);
}
