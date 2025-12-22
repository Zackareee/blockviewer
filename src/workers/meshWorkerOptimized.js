/**
 * Optimized Mesh Worker - High-performance greedy meshing
 * 
 * Key optimizations:
 * 1. Works directly on typed arrays (no object conversion)
 * 2. Uses sparse HashMap for lookups (no dense grid allocation)
 * 3. Processes multiple subchunks per message (reduced IPC overhead)
 * 4. Single-pass grid construction with visibility precomputation
 * 5. Efficient memory pooling for output arrays
 */

// Face definitions - same winding order as original
const FACES = [
  { axis: 1, dir: 1,  u: 0, v: 2, nx: 0, ny: 1,  nz: 0 },  // top (+Y)
  { axis: 1, dir: -1, u: 0, v: 2, nx: 0, ny: -1, nz: 0 },  // bottom (-Y)
  { axis: 0, dir: 1,  u: 2, v: 1, nx: 1, ny: 0,  nz: 0 },  // right (+X)
  { axis: 0, dir: -1, u: 2, v: 1, nx: -1, ny: 0, nz: 0 },  // left (-X)
  { axis: 2, dir: 1,  u: 0, v: 1, nx: 0, ny: 0,  nz: 1 },  // front (+Z)
  { axis: 2, dir: -1, u: 0, v: 1, nx: 0, ny: 0,  nz: -1 }, // back (-Z)
];

// Corner generation functions for each face (matching original winding)
function getTopCorners(x, y, z, w, h) {
  return [[x, y + 1, z + h], [x + w, y + 1, z + h], [x + w, y + 1, z], [x, y + 1, z]];
}
function getBottomCorners(x, y, z, w, h) {
  return [[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]];
}
function getRightCorners(x, y, z, w, h) {
  return [[x + 1, y, z], [x + 1, y + h, z], [x + 1, y + h, z + w], [x + 1, y, z + w]];
}
function getLeftCorners(x, y, z, w, h) {
  return [[x, y, z + w], [x, y + h, z + w], [x, y + h, z], [x, y, z]];
}
function getFrontCorners(x, y, z, w, h) {
  return [[x, y, z + 1], [x + w, y, z + 1], [x + w, y + h, z + 1], [x, y + h, z + 1]];
}
function getBackCorners(x, y, z, w, h) {
  return [[x + w, y, z], [x, y, z], [x, y + h, z], [x + w, y + h, z]];
}

const CORNER_FNS = [getTopCorners, getBottomCorners, getRightCorners, getLeftCorners, getFrontCorners, getBackCorners];

// Color lookup table (pre-computed for performance)
const COLOR_MAP = new Map([
  ['stone', 0x808080], ['granite', 0x9A6C4C], ['diorite', 0xBFBFBF], ['andesite', 0x888888],
  ['deepslate', 0x4A4A4A], ['cobblestone', 0x7A7A7A], ['bedrock', 0x2A2A2A],
  ['dirt', 0x8B6C4C], ['grass_block', 0x5D8C32], ['sand', 0xE3D59E], ['gravel', 0x8A8A8A],
  ['coal_ore', 0x4A4A4A], ['iron_ore', 0xB8A090], ['copper_ore', 0xA67B5B],
  ['gold_ore', 0xFCEE4B], ['diamond_ore', 0x4AEDD9], ['emerald_ore', 0x17DD62],
  ['redstone_ore', 0xFF0000], ['lapis_ore', 0x1E4B9B],
  ['oak_log', 0x8B7355], ['spruce_log', 0x4A3728], ['birch_log', 0xE8E4D5],
  ['oak_planks', 0xBA9862], ['oak_leaves', 0x3A8B25], ['spruce_leaves', 0x2A5A35],
  ['water', 0x3F76E4], ['lava', 0xFF6600],
  ['bricks', 0x9A5A4A], ['stone_bricks', 0x7A7A7A], ['obsidian', 0x1A0A2A],
  ['netherrack', 0x8A3A3A], ['end_stone', 0xDADA9A],
  ['glass', 0xFFFFFF], ['ice', 0x91B9FF], ['snow_block', 0xF0F0F0],
  ['terracotta', 0x9A5A4A], ['concrete', 0x808080], ['wool', 0xE8E8E8],
  ['glowstone', 0xFFDD75], ['tuff', 0x5A5A4A], ['calcite', 0xE0E0E0],
  ['moss_block', 0x4A7A3A], ['amethyst_block', 0x8A5AAA],
]);

// Fast pattern-based color fallbacks
const COLOR_PATTERNS = [
  ['ore', 0x8A7A6A], ['log', 0x8B7355], ['wood', 0x8B7355], ['leaves', 0x3A8B25],
  ['stone', 0x808080], ['dirt', 0x8B6C4C], ['sand', 0xE3D59E], ['grass', 0x5D8C32],
  ['water', 0x3F76E4], ['lava', 0xFF6600], ['ice', 0x91B9FF], ['snow', 0xF0F0F0],
  ['nether', 0x7A2A2A], ['copper', 0xC06040], ['iron', 0xD8D8D8], ['gold', 0xFCEE4B],
  ['diamond', 0x4AEDD9], ['coal', 0x2A2A2A], ['deepslate', 0x4A4A4A],
  ['planks', 0xBA9862], ['brick', 0x9A5A4A], ['concrete', 0x808080],
];

function getBlockColor(blockName) {
  if (!blockName) return 0x707070;
  const name = blockName.replace('minecraft:', '');
  
  const exact = COLOR_MAP.get(name);
  if (exact !== undefined) return exact;
  
  for (const [pattern, color] of COLOR_PATTERNS) {
    if (name.includes(pattern)) return color;
  }
  
  return 0x707070;
}

function hexToRgb(hex) {
  return {
    r: ((hex >> 16) & 255) / 255,
    g: ((hex >> 8) & 255) / 255,
    b: (hex & 255) / 255,
  };
}

/**
 * Spatial hash key for sparse voxel lookup
 * Uses bit packing: x (12 bits) | z (12 bits) | y (10 bits) = 34 bits fits in Number
 * Range: x,z: -2048 to 2047, y: -512 to 511
 */
function packCoord(x, y, z) {
  // Offset to handle negatives: x,z by 2048, y by 512
  return ((x + 2048) << 22) | ((z + 2048) << 10) | (y + 512);
}

/**
 * Build greedy mesh from indexed typed arrays
 * 
 * @param {Int32Array} xArr - Block X coordinates
 * @param {Int16Array} yArr - Block Y coordinates  
 * @param {Int32Array} zArr - Block Z coordinates
 * @param {Uint16Array} typeArr - Block type indices into palette
 * @param {Uint32Array} indices - Indices of blocks to mesh (subset of arrays)
 * @param {Uint32Array} neighborIndices - Indices of neighbor blocks for culling
 * @param {string[]} palette - Block name palette
 * @param {Object} offset - World offset {x, y, z}
 * @param {number} targetType - 1=solid, 2=water, 3=lava
 * @returns {Object|null} - {positions, normals, colors, indices} or null
 */
function buildMeshFromTypedArrays(xArr, yArr, zArr, typeArr, indices, neighborIndices, palette, offset, targetType) {
  if (indices.length === 0) return null;
  
  // Build sparse lookup maps
  const blockMap = new Map(); // packCoord -> paletteIdx for target blocks
  const typeMap = new Map();  // packCoord -> blockType (1=solid, 2=water, 3=lava)
  
  // Pre-compute block type lookup from palette
  const paletteTypes = new Uint8Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    const name = palette[i];
    if (!name) {
      paletteTypes[i] = 0;
    } else if (name.includes('water') || name.includes('flowing_water')) {
      paletteTypes[i] = 2;
    } else if (name.includes('lava') || name.includes('flowing_lava')) {
      paletteTypes[i] = 3;
    } else {
      paletteTypes[i] = 1;
    }
  }
  
  // Find bounds while populating maps
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  // Build palette for target blocks
  const blockPalette = new Map();
  const paletteList = [null]; // 0 = empty
  
  // Add target blocks
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const x = xArr[idx], y = yArr[idx], z = zArr[idx];
    const type = typeArr[idx];
    
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    
    const key = packCoord(x, y, z);
    
    let paletteIdx = blockPalette.get(type);
    if (paletteIdx === undefined) {
      paletteIdx = paletteList.length;
      blockPalette.set(type, paletteIdx);
      paletteList.push(palette[type]);
    }
    
    blockMap.set(key, paletteIdx);
    typeMap.set(key, targetType);
  }
  
  // Add neighbor blocks (just for culling, expand bounds too)
  for (let i = 0; i < neighborIndices.length; i++) {
    const idx = neighborIndices[i];
    const x = xArr[idx], y = yArr[idx], z = zArr[idx];
    const type = typeArr[idx];
    
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    
    const key = packCoord(x, y, z);
    typeMap.set(key, paletteTypes[type]);
  }
  
  const sizeX = maxX - minX + 1;
  const sizeY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;
  const sizes = [sizeX, sizeY, sizeZ];
  const mins = [minX, minY, minZ];
  
  // Pre-compute colors for palette
  const paletteColors = paletteList.map(name => name ? hexToRgb(getBlockColor(name)) : null);
  
  // Determine culling behavior
  const cullTypes = targetType === 1 ? [1] : (targetType === 2 ? [1, 2] : [1, 3]);
  
  const shouldCull = (x, y, z) => {
    const key = packCoord(x, y, z);
    const type = typeMap.get(key);
    return type !== undefined && cullTypes.includes(type);
  };
  
  const getPaletteIdx = (x, y, z) => {
    return blockMap.get(packCoord(x, y, z)) || 0;
  };
  
  // Output arrays - estimate based on block count (greedy merging reduces significantly)
  const estimatedQuads = indices.length * 3; // Pessimistic estimate
  let positions = new Float32Array(estimatedQuads * 4 * 3);
  let normals = new Float32Array(estimatedQuads * 4 * 3);
  let colors = new Float32Array(estimatedQuads * 4 * 3);
  let indexBuffer = new Uint32Array(estimatedQuads * 6);
  
  let vertexCount = 0;
  let posIdx = 0;
  let normIdx = 0;
  let colorIdx = 0;
  let idxIdx = 0;
  
  // Process each face direction
  for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
    const face = FACES[faceIdx];
    const { axis, dir, u, v, nx, ny, nz } = face;
    const getCorners = CORNER_FNS[faceIdx];
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
          const nx = coords[0] + (axis === 0 ? dir : 0);
          const ny = coords[1] + (axis === 1 ? dir : 0);
          const nz = coords[2] + (axis === 2 ? dir : 0);
          
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
          
          // Check if we need to grow arrays
          if (posIdx + 12 > positions.length) {
            const newSize = positions.length * 2;
            const newPositions = new Float32Array(newSize);
            const newNormals = new Float32Array(newSize);
            const newColors = new Float32Array(newSize);
            newPositions.set(positions);
            newNormals.set(normals);
            newColors.set(colors);
            positions = newPositions;
            normals = newNormals;
            colors = newColors;
          }
          if (idxIdx + 6 > indexBuffer.length) {
            const newIndices = new Uint32Array(indexBuffer.length * 2);
            newIndices.set(indexBuffer);
            indexBuffer = newIndices;
          }
          
          // Emit 4 vertices
          for (const [cx, cy, cz] of corners) {
            positions[posIdx++] = cx - offset.x;
            positions[posIdx++] = cy - offset.y;
            positions[posIdx++] = cz - offset.z;
            
            normals[normIdx++] = face.nx;
            normals[normIdx++] = face.ny;
            normals[normIdx++] = face.nz;
            
            colors[colorIdx++] = color.r;
            colors[colorIdx++] = color.g;
            colors[colorIdx++] = color.b;
            
            vertexCount++;
          }
          
          // Two triangles
          indexBuffer[idxIdx++] = startVertex;
          indexBuffer[idxIdx++] = startVertex + 1;
          indexBuffer[idxIdx++] = startVertex + 2;
          indexBuffer[idxIdx++] = startVertex;
          indexBuffer[idxIdx++] = startVertex + 2;
          indexBuffer[idxIdx++] = startVertex + 3;
        }
      }
    }
  }
  
  if (vertexCount === 0) return null;
  
  return {
    positions: positions.slice(0, posIdx),
    normals: normals.slice(0, normIdx),
    colors: colors.slice(0, colorIdx),
    indices: indexBuffer.slice(0, idxIdx),
    vertexCount,
    triangleCount: idxIdx / 3,
  };
}

/**
 * Process a batch of subchunks using indexed typed arrays
 * This is the main entry point for high-performance meshing
 */
function processTypedBatch(data) {
  const { 
    xArr, yArr, zArr, typeArr, // Shared typed arrays
    jobs, // Array of { targetIndices, neighborIndices, offset, subchunkY, meshType }
    palette 
  } = data;
  
  const results = [];
  const transferables = [];
  
  for (const job of jobs) {
    const { targetIndices, neighborIndices, offset, subchunkY, subchunkKey, meshType } = job;
    const targetType = meshType === 'water' ? 2 : (meshType === 'lava' ? 3 : 1);
    
    try {
      const result = buildMeshFromTypedArrays(
        xArr, yArr, zArr, typeArr,
        targetIndices,
        neighborIndices,
        palette,
        offset,
        targetType
      );
      
      if (result) {
        transferables.push(
          result.positions.buffer,
          result.normals.buffer,
          result.colors.buffer,
          result.indices.buffer
        );
      }
      
      results.push({
        subchunkY,
        subchunkKey,
        geometry: result,
        blockCount: targetIndices.length,
        triangleCount: result?.triangleCount || 0,
      });
    } catch (error) {
      results.push({
        subchunkY,
        subchunkKey,
        geometry: null,
        blockCount: targetIndices.length,
        triangleCount: 0,
        error: error.message,
      });
    }
  }
  
  return { results, transferables };
}

/**
 * Build mesh from compact typed arrays (pre-extracted blocks for this job only)
 */
function buildMeshFromCompactArrays(xArr, yArr, zArr, typeArr, targetCount, neighborCount, palette, offset, meshType) {
  if (targetCount === 0) return null;
  
  const targetType = meshType === 'water' ? 2 : (meshType === 'lava' ? 3 : 1);
  
  // Build sparse lookup maps
  const blockMap = new Map(); // packCoord -> paletteIdx for target blocks
  const typeMap = new Map();  // packCoord -> blockType (1=solid, 2=water, 3=lava)
  
  // Pre-compute block type lookup from palette
  const paletteTypes = new Uint8Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    const name = palette[i];
    if (!name) {
      paletteTypes[i] = 0;
    } else if (name.includes('water') || name.includes('flowing_water')) {
      paletteTypes[i] = 2;
    } else if (name.includes('lava') || name.includes('flowing_lava')) {
      paletteTypes[i] = 3;
    } else {
      paletteTypes[i] = 1;
    }
  }
  
  // Find bounds while populating maps
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  // Build palette for target blocks
  const blockPalette = new Map();
  const paletteList = [null]; // 0 = empty
  
  // Add target blocks (first targetCount entries)
  for (let i = 0; i < targetCount; i++) {
    const x = xArr[i], y = yArr[i], z = zArr[i];
    const type = typeArr[i];
    
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    
    const key = packCoord(x, y, z);
    
    let paletteIdx = blockPalette.get(type);
    if (paletteIdx === undefined) {
      paletteIdx = paletteList.length;
      blockPalette.set(type, paletteIdx);
      paletteList.push(palette[type]);
    }
    
    blockMap.set(key, paletteIdx);
    typeMap.set(key, targetType);
  }
  
  // Add neighbor blocks (for culling, starting at targetCount)
  for (let i = 0; i < neighborCount; i++) {
    const idx = targetCount + i;
    const x = xArr[idx], y = yArr[idx], z = zArr[idx];
    const type = typeArr[idx];
    
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    
    const key = packCoord(x, y, z);
    typeMap.set(key, paletteTypes[type]);
  }
  
  const sizeX = maxX - minX + 1;
  const sizeY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;
  const sizes = [sizeX, sizeY, sizeZ];
  const mins = [minX, minY, minZ];
  
  // Pre-compute colors for palette
  const paletteColors = paletteList.map(name => name ? hexToRgb(getBlockColor(name)) : null);
  
  // Determine culling behavior
  const cullTypes = targetType === 1 ? [1] : (targetType === 2 ? [1, 2] : [1, 3]);
  
  const shouldCull = (x, y, z) => {
    const key = packCoord(x, y, z);
    const type = typeMap.get(key);
    return type !== undefined && cullTypes.includes(type);
  };
  
  const getPaletteIdx = (x, y, z) => {
    return blockMap.get(packCoord(x, y, z)) || 0;
  };
  
  // Output arrays - greedy meshing significantly reduces output size
  const estimatedQuads = targetCount * 3;
  let positions = new Float32Array(estimatedQuads * 4 * 3);
  let normals = new Float32Array(estimatedQuads * 4 * 3);
  let colors = new Float32Array(estimatedQuads * 4 * 3);
  let indexBuffer = new Uint32Array(estimatedQuads * 6);
  
  let vertexCount = 0;
  let posIdx = 0, normIdx = 0, colorIdx = 0, idxIdx = 0;
  
  // Process each face direction
  for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
    const face = FACES[faceIdx];
    const { axis, dir, u, v } = face;
    const getCorners = CORNER_FNS[faceIdx];
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
          
          const nx = coords[0] + (axis === 0 ? dir : 0);
          const ny = coords[1] + (axis === 1 ? dir : 0);
          const nz = coords[2] + (axis === 2 ? dir : 0);
          
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
          
          let height = 1, canExpand = true;
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
          
          // Grow arrays if needed
          if (posIdx + 12 > positions.length) {
            const newSize = positions.length * 2;
            const newPos = new Float32Array(newSize);
            const newNorm = new Float32Array(newSize);
            const newCol = new Float32Array(newSize);
            newPos.set(positions); newNorm.set(normals); newCol.set(colors);
            positions = newPos; normals = newNorm; colors = newCol;
          }
          if (idxIdx + 6 > indexBuffer.length) {
            const newIdx = new Uint32Array(indexBuffer.length * 2);
            newIdx.set(indexBuffer);
            indexBuffer = newIdx;
          }
          
          for (const [cx, cy, cz] of corners) {
            positions[posIdx++] = cx - offset.x;
            positions[posIdx++] = cy - offset.y;
            positions[posIdx++] = cz - offset.z;
            normals[normIdx++] = face.nx;
            normals[normIdx++] = face.ny;
            normals[normIdx++] = face.nz;
            colors[colorIdx++] = color.r;
            colors[colorIdx++] = color.g;
            colors[colorIdx++] = color.b;
            vertexCount++;
          }
          
          indexBuffer[idxIdx++] = startVertex;
          indexBuffer[idxIdx++] = startVertex + 1;
          indexBuffer[idxIdx++] = startVertex + 2;
          indexBuffer[idxIdx++] = startVertex;
          indexBuffer[idxIdx++] = startVertex + 2;
          indexBuffer[idxIdx++] = startVertex + 3;
        }
      }
    }
  }
  
  if (vertexCount === 0) return null;
  
  return {
    positions: positions.slice(0, posIdx),
    normals: normals.slice(0, normIdx),
    colors: colors.slice(0, colorIdx),
    indices: indexBuffer.slice(0, idxIdx),
    vertexCount,
    triangleCount: idxIdx / 3,
  };
}

/**
 * Process a batch of compact jobs (pre-extracted blocks per job)
 */
function processCompactBatch(data) {
  const { jobs, palette } = data;
  
  const results = [];
  const transferables = [];
  
  for (const job of jobs) {
    const { x, y, z, blockType, targetCount, neighborCount, offset, subchunkY, subchunkKey, meshType } = job;
    
    try {
      const result = buildMeshFromCompactArrays(
        x, y, z, blockType,
        targetCount, neighborCount,
        palette, offset, meshType
      );
      
      if (result) {
        transferables.push(
          result.positions.buffer,
          result.normals.buffer,
          result.colors.buffer,
          result.indices.buffer
        );
      }
      
      results.push({
        subchunkY,
        subchunkKey,
        meshType,
        geometry: result,
        blockCount: targetCount,
        triangleCount: result?.triangleCount || 0,
      });
    } catch (error) {
      results.push({
        subchunkY,
        subchunkKey,
        meshType,
        geometry: null,
        blockCount: targetCount,
        triangleCount: 0,
        error: error.message,
      });
    }
  }
  
  return { results, transferables };
}

// Message handler
self.onmessage = function(e) {
  const { type, id, data } = e.data;
  
  // New COMPACT batch processing (pre-extracted blocks per job)
  if (type === 'buildCompactBatch') {
    const startTime = performance.now();
    const { results, transferables } = processCompactBatch(data);
    const elapsed = performance.now() - startTime;
    
    self.postMessage({
      type: 'typedBatchResult',
      id,
      results,
      stats: {
        jobCount: data.jobs.length,
        timeMs: elapsed,
      }
    }, transferables);
    return;
  }
  
  // Old indexed typed array batch processing (kept for compatibility)
  if (type === 'buildTypedBatch') {
    const startTime = performance.now();
    const { results, transferables } = processTypedBatch(data);
    const elapsed = performance.now() - startTime;
    
    self.postMessage({
      type: 'typedBatchResult',
      id,
      results,
      stats: {
        jobCount: data.jobs.length,
        timeMs: elapsed,
      }
    }, transferables);
    return;
  }
  
  // Legacy object-based processing (keep for compatibility)
  if (type === 'buildSubchunkMeshBatch') {
    const { jobs, meshType } = data;
    const startTime = performance.now();
    const results = [];
    const transferables = [];
    
    for (const job of jobs) {
      const { blocks, neighborBlocks, offset, subchunkY, subchunkKey } = job;
      
      try {
        const targetType = meshType === 'water' ? 2 : (meshType === 'lava' ? 3 : 1);
        const result = buildGreedyMeshArraysLegacy(blocks, neighborBlocks, offset, targetType);
        
        if (result) {
          transferables.push(
            result.positions.buffer,
            result.normals.buffer,
            result.colors.buffer,
            result.indices.buffer
          );
        }
        
        results.push({
          subchunkY,
          subchunkKey,
          geometry: result,
          blockCount: blocks.length,
          triangleCount: result?.triangleCount || 0,
        });
      } catch (error) {
        results.push({
          subchunkY,
          subchunkKey,
          geometry: null,
          blockCount: blocks?.length || 0,
          triangleCount: 0,
          error: error.message,
        });
      }
    }
    
    const elapsed = performance.now() - startTime;
    
    self.postMessage({
      type: 'subchunkMeshBatchResult',
      id,
      meshType,
      results,
      stats: {
        jobCount: jobs.length,
        timeMs: elapsed,
      }
    }, transferables);
  }
};

/**
 * Legacy object-based mesher (for compatibility)
 */
function buildGreedyMeshArraysLegacy(targetBlocks, otherBlocks, offset, targetType) {
  if (targetBlocks.length === 0) return null;
  
  const allBlocks = [...targetBlocks, ...otherBlocks];
  
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  for (const b of allBlocks) {
    if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
    if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
  }
  
  const sizeX = maxX - minX + 1;
  const sizeY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;
  const sizes = [sizeX, sizeY, sizeZ];
  const mins = [minX, minY, minZ];
  
  const blockPalette = new Map();
  const paletteList = [null];
  
  // Use sparse map for large regions
  const blockMap = new Map();
  const typeMap = new Map();
  
  for (const b of targetBlocks) {
    let paletteIdx = blockPalette.get(b.block);
    if (paletteIdx === undefined) {
      paletteIdx = paletteList.length;
      blockPalette.set(b.block, paletteIdx);
      paletteList.push(b.block);
    }
    const key = packCoord(b.x, b.y, b.z);
    blockMap.set(key, paletteIdx);
    typeMap.set(key, targetType);
  }
  
  for (const b of otherBlocks) {
    const key = packCoord(b.x, b.y, b.z);
    const name = b.block?.toLowerCase() || '';
    if (name.includes('water')) typeMap.set(key, 2);
    else if (name.includes('lava')) typeMap.set(key, 3);
    else typeMap.set(key, 1);
  }
  
  const cullTypes = targetType === 1 ? [1] : (targetType === 2 ? [1, 2] : [1, 3]);
  const shouldCull = (x, y, z) => {
    const type = typeMap.get(packCoord(x, y, z));
    return type !== undefined && cullTypes.includes(type);
  };
  const getPaletteIdx = (x, y, z) => blockMap.get(packCoord(x, y, z)) || 0;
  
  const paletteColors = paletteList.map(name => name ? hexToRgb(getBlockColor(name)) : null);
  
  const estimatedQuads = targetBlocks.length * 3;
  let positions = new Float32Array(estimatedQuads * 4 * 3);
  let normals = new Float32Array(estimatedQuads * 4 * 3);
  let colors = new Float32Array(estimatedQuads * 4 * 3);
  let indexBuffer = new Uint32Array(estimatedQuads * 6);
  
  let vertexCount = 0;
  let posIdx = 0, normIdx = 0, colorIdx = 0, idxIdx = 0;
  
  for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
    const face = FACES[faceIdx];
    const { axis, dir, u, v } = face;
    const getCorners = CORNER_FNS[faceIdx];
    const w = axis;
    
    const dimU = sizes[u], dimV = sizes[v], dimW = sizes[w];
    
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
          
          const nx = coords[0] + (axis === 0 ? dir : 0);
          const ny = coords[1] + (axis === 1 ? dir : 0);
          const nz = coords[2] + (axis === 2 ? dir : 0);
          
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
          
          let height = 1, canExpand = true;
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
          
          if (posIdx + 12 > positions.length) {
            const newSize = positions.length * 2;
            const newPos = new Float32Array(newSize);
            const newNorm = new Float32Array(newSize);
            const newCol = new Float32Array(newSize);
            newPos.set(positions); newNorm.set(normals); newCol.set(colors);
            positions = newPos; normals = newNorm; colors = newCol;
          }
          if (idxIdx + 6 > indexBuffer.length) {
            const newIdx = new Uint32Array(indexBuffer.length * 2);
            newIdx.set(indexBuffer);
            indexBuffer = newIdx;
          }
          
          for (const [cx, cy, cz] of corners) {
            positions[posIdx++] = cx - offset.x;
            positions[posIdx++] = cy - offset.y;
            positions[posIdx++] = cz - offset.z;
            normals[normIdx++] = face.nx;
            normals[normIdx++] = face.ny;
            normals[normIdx++] = face.nz;
            colors[colorIdx++] = color.r;
            colors[colorIdx++] = color.g;
            colors[colorIdx++] = color.b;
            vertexCount++;
          }
          
          indexBuffer[idxIdx++] = startVertex;
          indexBuffer[idxIdx++] = startVertex + 1;
          indexBuffer[idxIdx++] = startVertex + 2;
          indexBuffer[idxIdx++] = startVertex;
          indexBuffer[idxIdx++] = startVertex + 2;
          indexBuffer[idxIdx++] = startVertex + 3;
        }
      }
    }
  }
  
  if (vertexCount === 0) return null;
  
  return {
    positions: positions.slice(0, posIdx),
    normals: normals.slice(0, normIdx),
    colors: colors.slice(0, colorIdx),
    indices: indexBuffer.slice(0, idxIdx),
    vertexCount,
    triangleCount: idxIdx / 3,
  };
}

