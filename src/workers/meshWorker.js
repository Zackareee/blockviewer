/**
 * Mesh Worker - Offloads greedy mesh building from the main thread
 * 
 * Receives block data, builds greedy mesh geometry, and returns
 * raw typed arrays that can be transferred (zero-copy) back to main thread.
 */

// Face definitions matching the original working CulledMesh winding order
const FACE_INFO = [
  { 
    name: 'top', axis: 1, dir: 1, u: 0, v: 2,
    getCorners: (x, y, z, w, h) => [
      [x,     y + 1, z + h],
      [x + w, y + 1, z + h],
      [x + w, y + 1, z    ],
      [x,     y + 1, z    ],
    ]
  },
  { 
    name: 'bottom', axis: 1, dir: -1, u: 0, v: 2,
    getCorners: (x, y, z, w, h) => [
      [x,     y, z    ],
      [x + w, y, z    ],
      [x + w, y, z + h],
      [x,     y, z + h],
    ]
  },
  { 
    name: 'right', axis: 0, dir: 1, u: 2, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x + 1, y,     z    ],
      [x + 1, y + h, z    ],
      [x + 1, y + h, z + w],
      [x + 1, y,     z + w],
    ]
  },
  { 
    name: 'left', axis: 0, dir: -1, u: 2, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x, y,     z + w],
      [x, y + h, z + w],
      [x, y + h, z    ],
      [x, y,     z    ],
    ]
  },
  { 
    name: 'front', axis: 2, dir: 1, u: 0, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x,     y,     z + 1],
      [x + w, y,     z + 1],
      [x + w, y + h, z + 1],
      [x,     y + h, z + 1],
    ]
  },
  { 
    name: 'back', axis: 2, dir: -1, u: 0, v: 1,
    getCorners: (x, y, z, w, h) => [
      [x + w, y,     z],
      [x,     y,     z],
      [x,     y + h, z],
      [x + w, y + h, z],
    ]
  },
];

// Full color map for blocks (matching mcaParser.js)
const COLOR_MAP = {
  // Stone variants
  'stone': 0x808080,
  'granite': 0x9A6C4C,
  'polished_granite': 0xA67B5B,
  'diorite': 0xBFBFBF,
  'polished_diorite': 0xD0D0D0,
  'andesite': 0x888888,
  'polished_andesite': 0x9A9A9A,
  'deepslate': 0x4A4A4A,
  'cobblestone': 0x7A7A7A,
  'cobbled_deepslate': 0x3A3A3A,
  'bedrock': 0x2A2A2A,
  
  // Dirt variants
  'dirt': 0x8B6C4C,
  'coarse_dirt': 0x7A5C3C,
  'rooted_dirt': 0x8B6C4C,
  'grass_block': 0x5D8C32,
  'podzol': 0x6A5D3A,
  'mycelium': 0x8B7B7B,
  'mud': 0x3C3C3C,
  'clay': 0x9BA4AF,
  
  // Sand
  'sand': 0xE3D59E,
  'red_sand': 0xBA6629,
  'gravel': 0x8A8A8A,
  'sandstone': 0xD9C896,
  'red_sandstone': 0xA44D22,
  
  // Ores
  'coal_ore': 0x4A4A4A,
  'deepslate_coal_ore': 0x3A3A3A,
  'iron_ore': 0xB8A090,
  'deepslate_iron_ore': 0x8A7060,
  'copper_ore': 0xA67B5B,
  'deepslate_copper_ore': 0x8A5A3A,
  'gold_ore': 0xFCEE4B,
  'deepslate_gold_ore': 0xDAC42B,
  'redstone_ore': 0xFF0000,
  'deepslate_redstone_ore': 0xCC0000,
  'emerald_ore': 0x17DD62,
  'deepslate_emerald_ore': 0x0AAA4A,
  'lapis_ore': 0x1E4B9B,
  'deepslate_lapis_ore': 0x0E3B7B,
  'diamond_ore': 0x4AEDD9,
  'deepslate_diamond_ore': 0x2ACDB9,
  'ancient_debris': 0x6C4A3A,
  
  // Wood
  'oak_log': 0x8B7355,
  'spruce_log': 0x4A3728,
  'birch_log': 0xE8E4D5,
  'jungle_log': 0x6A5B3A,
  'acacia_log': 0x6A3D2A,
  'dark_oak_log': 0x3A2714,
  'mangrove_log': 0x6A2A2A,
  'cherry_log': 0x4A2A3A,
  'oak_planks': 0xBA9862,
  'spruce_planks': 0x7A5A3A,
  'birch_planks': 0xC9B87A,
  'jungle_planks': 0xAB8254,
  'acacia_planks': 0xBA6229,
  'dark_oak_planks': 0x4A3314,
  'oak_leaves': 0x3A8B25,
  'spruce_leaves': 0x2A5A35,
  'birch_leaves': 0x5A9A3A,
  'jungle_leaves': 0x3A8B25,
  'acacia_leaves': 0x6A9A4A,
  'dark_oak_leaves': 0x2A5A25,
  'azalea_leaves': 0x5A8A3A,
  'flowering_azalea_leaves': 0x7A5A7A,
  'cherry_leaves': 0xFFAACC,
  'mangrove_leaves': 0x4A8A3A,
  
  // Water and lava
  'water': 0x3F76E4,
  'lava': 0xFF6600,
  
  // Building blocks
  'bricks': 0x9A5A4A,
  'stone_bricks': 0x7A7A7A,
  'mossy_stone_bricks': 0x5A7A5A,
  'cracked_stone_bricks': 0x6A6A6A,
  'chiseled_stone_bricks': 0x7A7A7A,
  'obsidian': 0x1A0A2A,
  'crying_obsidian': 0x2A1A4A,
  'netherrack': 0x8A3A3A,
  'soul_sand': 0x5A4A3A,
  'soul_soil': 0x4A3A2A,
  'basalt': 0x4A4A4A,
  'smooth_basalt': 0x3A3A3A,
  'blackstone': 0x2A2A2A,
  'end_stone': 0xDADA9A,
  'purpur_block': 0xAA6AAA,
  
  // Glass
  'glass': 0xFFFFFF,
  'tinted_glass': 0x3A3A3A,
  
  // Terracotta
  'terracotta': 0x9A5A4A,
  'white_terracotta': 0xD9C8B8,
  'orange_terracotta': 0xA45B2A,
  'magenta_terracotta': 0x9A5A7A,
  'light_blue_terracotta': 0x7A8AA0,
  'yellow_terracotta': 0xBA982A,
  'lime_terracotta': 0x6A7A3A,
  'pink_terracotta': 0xA0605A,
  'gray_terracotta': 0x4A3A3A,
  'light_gray_terracotta': 0x8A7A70,
  'cyan_terracotta': 0x5A6A6A,
  'purple_terracotta': 0x7A4A6A,
  'blue_terracotta': 0x4A4A6A,
  'brown_terracotta': 0x5A3A2A,
  'green_terracotta': 0x4A5A3A,
  'red_terracotta': 0x8A3A3A,
  'black_terracotta': 0x3A2A2A,
  
  // Concrete
  'white_concrete': 0xCFCFCF,
  'orange_concrete': 0xE06100,
  'magenta_concrete': 0xA9309F,
  'light_blue_concrete': 0x2389C6,
  'yellow_concrete': 0xF1AF15,
  'lime_concrete': 0x5EA818,
  'pink_concrete': 0xD5658E,
  'gray_concrete': 0x36393D,
  'light_gray_concrete': 0x7D7D73,
  'cyan_concrete': 0x157788,
  'purple_concrete': 0x641F9C,
  'blue_concrete': 0x2C2E8E,
  'brown_concrete': 0x603B1F,
  'green_concrete': 0x495B24,
  'red_concrete': 0x8E2121,
  'black_concrete': 0x080A0F,
  
  // Ice and snow
  'ice': 0x91B9FF,
  'packed_ice': 0x7AA4FF,
  'blue_ice': 0x5A84FF,
  'snow_block': 0xF0F0F0,
  'snow': 0xFAFAFA,
  'powder_snow': 0xF8F8F8,
  
  // Nether blocks
  'nether_bricks': 0x3A2A2A,
  'red_nether_bricks': 0x4A1A1A,
  'nether_wart_block': 0x7A1A1A,
  'warped_wart_block': 0x1A7A7A,
  'crimson_nylium': 0x7A2A2A,
  'warped_nylium': 0x2A7A7A,
  'crimson_stem': 0x6A2A4A,
  'warped_stem': 0x2A6A6A,
  'shroomlight': 0xF0C040,
  'glowstone': 0xFFDD75,
  
  // Copper
  'copper_block': 0xC06040,
  'exposed_copper': 0xA08060,
  'weathered_copper': 0x6A9A70,
  'oxidized_copper': 0x4A9A8A,
  
  // Amethyst
  'amethyst_block': 0x8A5AAA,
  'budding_amethyst': 0x9A6ABA,
  
  // Misc
  'tuff': 0x5A5A4A,
  'calcite': 0xE0E0E0,
  'dripstone_block': 0x8A7A6A,
  'moss_block': 0x4A7A3A,
  'sculk': 0x0A2A3A,
  'sculk_catalyst': 0x0A3A4A,
  'sculk_sensor': 0x0A4A5A,
  'sculk_shrieker': 0x0A3A4A,
  'bone_block': 0xE5DCC5,
  'hay_block': 0xB8A050,
  'honeycomb_block': 0xE8A030,
  'slime_block': 0x80CC60,
  'honey_block': 0xFFAA20,
  'sponge': 0xC4C040,
  'wet_sponge': 0xA4A030,
  'melon': 0xA0C830,
  'pumpkin': 0xCC8020,
  'carved_pumpkin': 0xCC8020,
  'jack_o_lantern': 0xCC8020,
  
  // Wool colors
  'white_wool': 0xE8E8E8,
  'orange_wool': 0xE87020,
  'magenta_wool': 0xB838B8,
  'light_blue_wool': 0x58A8D8,
  'yellow_wool': 0xE8C820,
  'lime_wool': 0x60B820,
  'pink_wool': 0xE888A8,
  'gray_wool': 0x484848,
  'light_gray_wool': 0x989898,
  'cyan_wool': 0x189090,
  'purple_wool': 0x7828B8,
  'blue_wool': 0x3838B8,
  'brown_wool': 0x784818,
  'green_wool': 0x407820,
  'red_wool': 0xA82020,
  'black_wool': 0x181818,
};

function getBlockColor(blockName) {
  if (!blockName) return 0x707070;
  const name = blockName.replace('minecraft:', '');
  
  // Check for exact match first (fast O(1) lookup)
  if (COLOR_MAP[name]) return COLOR_MAP[name];
  
  // Fast pattern matching fallbacks (no expensive iteration)
  if (name.includes('ore')) return 0x8A7A6A;
  if (name.includes('log') || name.includes('wood')) return 0x8B7355;
  if (name.includes('leaves') || name.includes('leaf')) return 0x3A8B25;
  if (name.includes('stone')) return 0x808080;
  if (name.includes('dirt') || name.includes('mud')) return 0x8B6C4C;
  if (name.includes('sand')) return 0xE3D59E;
  if (name.includes('grass')) return 0x5D8C32;
  if (name.includes('water')) return 0x3F76E4;
  if (name.includes('lava')) return 0xFF6600;
  if (name.includes('ice')) return 0x91B9FF;
  if (name.includes('snow')) return 0xF0F0F0;
  if (name.includes('nether') || name.includes('crimson')) return 0x7A2A2A;
  if (name.includes('warped')) return 0x2A7A7A;
  if (name.includes('copper')) return 0xC06040;
  if (name.includes('iron')) return 0xD8D8D8;
  if (name.includes('gold')) return 0xFCEE4B;
  if (name.includes('diamond')) return 0x4AEDD9;
  if (name.includes('emerald')) return 0x17DD62;
  if (name.includes('redstone')) return 0xFF0000;
  if (name.includes('lapis')) return 0x1E4B9B;
  if (name.includes('coal')) return 0x2A2A2A;
  if (name.includes('wool')) return 0xE8E8E8;
  if (name.includes('concrete')) return 0x808080;
  if (name.includes('terracotta')) return 0x9A5A4A;
  if (name.includes('glass')) return 0xFFFFFF;
  if (name.includes('brick')) return 0x9A5A4A;
  if (name.includes('planks')) return 0xBA9862;
  if (name.includes('deepslate')) return 0x4A4A4A;
  if (name.includes('calcite')) return 0xE0E0E0;
  if (name.includes('tuff')) return 0x5A5A4A;
  if (name.includes('dripstone')) return 0x8A7A6A;
  if (name.includes('moss')) return 0x4A7A3A;
  if (name.includes('amethyst')) return 0x8A5AAA;
  if (name.includes('slab') || name.includes('stairs')) return 0x808080;
  
  // Unknown block - use a subtle gray
  return 0x707070;
}

function hexToRgb(hex) {
  // Return sRGB values (0-1 range) - THREE.js handles color space conversion
  return {
    r: ((hex >> 16) & 255) / 255,
    g: ((hex >> 8) & 255) / 255,
    b: (hex & 255) / 255,
  };
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
 * Build greedy mesh and return raw arrays (no THREE.js dependency)
 */
function buildGreedyMeshArrays(targetBlocks, otherBlocks, offset, targetType) {
  if (targetBlocks.length === 0) return null;

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
  
  // For large regions, use Map-based sparse lookup to avoid memory exhaustion
  const totalCells = sizeX * sizeY * sizeZ;
  const useMapLookup = totalCells > 10000000; // 10M cells threshold (more conservative for workers)
  
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
      typeMap.set(key(b.x, b.y, b.z), isWaterBlock(b.block) ? 2 : (isLavaBlock(b.block) ? 3 : 1));
    }
    
    getPaletteIdx = (x, y, z) => blockMap.get(key(x, y, z)) || 0;
    getBlockType = (x, y, z) => typeMap.get(key(x, y, z)) || 0;
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

    // Fill type grid with other blocks
    for (let i = 0; i < otherBlocks.length; i++) {
      const b = otherBlocks[i];
      const idx = getIdx(b.x, b.y, b.z);
      typeGrid[idx] = isWaterBlock(b.block) ? 2 : (isLavaBlock(b.block) ? 3 : 1);
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
  // Solid (1): cull against solid only
  // Water (2): cull against solid and water
  // Lava (3): cull against solid and lava
  let cullTypes;
  if (targetType === 1) {
    cullTypes = [1];
  } else if (targetType === 2) {
    cullTypes = [1, 2];
  } else {
    cullTypes = [1, 3];
  }

  const shouldCull = (x, y, z) => {
    const type = getBlockType(x, y, z);
    return cullTypes.includes(type);
  };

  // Pre-compute colors
  const paletteColors = paletteList.map(name => {
    if (!name) return null;
    return hexToRgb(getBlockColor(name));
  });

  // Output arrays
  const estimatedQuads = targetBlocks.length * 3;
  const positions = new Float32Array(estimatedQuads * 4 * 3);
  const normals = new Float32Array(estimatedQuads * 4 * 3);
  const colors = new Float32Array(estimatedQuads * 4 * 3);
  const indices = new Uint32Array(estimatedQuads * 6);

  let vertexCount = 0;
  let posIdx = 0;
  let normIdx = 0;
  let colorIdx = 0;
  let indexIdx = 0;

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

      // Greedy merge
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
            positions[posIdx++] = cx - offset.x;
            positions[posIdx++] = cy - offset.y;
            positions[posIdx++] = cz - offset.z;

            normals[normIdx++] = axis === 0 ? dir : 0;
            normals[normIdx++] = axis === 1 ? dir : 0;
            normals[normIdx++] = axis === 2 ? dir : 0;

            colors[colorIdx++] = color.r;
            colors[colorIdx++] = color.g;
            colors[colorIdx++] = color.b;

            vertexCount++;
          }

          indices[indexIdx++] = startVertex;
          indices[indexIdx++] = startVertex + 1;
          indices[indexIdx++] = startVertex + 2;
          indices[indexIdx++] = startVertex;
          indices[indexIdx++] = startVertex + 2;
          indices[indexIdx++] = startVertex + 3;
        }
      }
    }
  }

  if (vertexCount === 0) return null;

  return {
    positions: positions.slice(0, posIdx),
    normals: normals.slice(0, normIdx),
    colors: colors.slice(0, colorIdx),
    indices: indices.slice(0, indexIdx),
    vertexCount,
    triangleCount: indexIdx / 3,
  };
}

/**
 * Convert typed array blocks to object format for mesh building
 * @param {Object} typedBlocks - { x, y, z, blockType, level, count }
 * @param {string[]} palette - Block name palette
 * @param {number} minY - Min Y filter
 * @param {number} maxY - Max Y filter
 * @returns {{ solidBlocks: Array, waterBlocks: Array, lavaBlocks: Array }}
 */
function typedBlocksToSeparated(typedBlocks, palette, minY, maxY) {
  const { x, y, z, blockType, level, count } = typedBlocks;
  const solidBlocks = [];
  const waterBlocks = [];
  const lavaBlocks = [];
  
  for (let i = 0; i < count; i++) {
    const blockY = y[i];
    if (blockY < minY || blockY > maxY) continue;
    
    const blockName = palette[blockType[i]] || 'minecraft:air';
    const block = { x: x[i], y: blockY, z: z[i], block: blockName };
    
    // Add level property for fluids (level >= 0 means it's a fluid)
    if (level && level[i] >= 0) {
      block.level = level[i];
    }
    
    if (isWaterBlock(blockName)) {
      waterBlocks.push(block);
    } else if (isLavaBlock(blockName)) {
      lavaBlocks.push(block);
    } else {
      solidBlocks.push(block);
    }
  }
  
  return { solidBlocks, waterBlocks, lavaBlocks };
}

/**
 * Main worker message handler
 */
self.onmessage = function(e) {
  const { type, id, data } = e.data;

  if (type === 'buildMesh') {
    const { blocks, offset, minY, maxY } = data;
    
    const startTime = performance.now();

    // Filter by Y range and separate solid/water
    const solidBlocks = [];
    const waterBlocks = [];

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.y >= minY && b.y <= maxY) {
        if (isWaterBlock(b.block)) {
          waterBlocks.push(b);
        } else {
          solidBlocks.push(b);
        }
      }
    }

    // Build meshes
    const solidResult = buildGreedyMeshArrays(solidBlocks, waterBlocks, offset, 1);
    const waterResult = buildGreedyMeshArrays(waterBlocks, solidBlocks, offset, 2);

    const elapsed = performance.now() - startTime;

    // Prepare transferable arrays
    const transferables = [];
    
    if (solidResult) {
      transferables.push(
        solidResult.positions.buffer,
        solidResult.normals.buffer,
        solidResult.colors.buffer,
        solidResult.indices.buffer
      );
    }
    
    if (waterResult) {
      transferables.push(
        waterResult.positions.buffer,
        waterResult.normals.buffer,
        waterResult.colors.buffer,
        waterResult.indices.buffer
      );
    }

    // Send result back with zero-copy transfer
    self.postMessage({
      type: 'meshResult',
      id,
      solid: solidResult,
      water: waterResult,
      stats: {
        solidBlocks: solidBlocks.length,
        waterBlocks: waterBlocks.length,
        solidTriangles: solidResult?.triangleCount || 0,
        waterTriangles: waterResult?.triangleCount || 0,
        timeMs: elapsed,
      }
    }, transferables);
  }
  
  // New typed array path for maximum performance
  if (type === 'buildMeshTyped') {
    const { typedBlocks, palette, offset, minY, maxY } = data;
    
    const startTime = performance.now();
    
    // Convert typed arrays to separated block lists
    const { solidBlocks, waterBlocks } = typedBlocksToSeparated(typedBlocks, palette, minY, maxY);

    // Build meshes
    const solidResult = buildGreedyMeshArrays(solidBlocks, waterBlocks, offset, 1);
    const waterResult = buildGreedyMeshArrays(waterBlocks, solidBlocks, offset, 2);

    const elapsed = performance.now() - startTime;

    // Prepare transferable arrays
    const transferables = [];
    
    if (solidResult) {
      transferables.push(
        solidResult.positions.buffer,
        solidResult.normals.buffer,
        solidResult.colors.buffer,
        solidResult.indices.buffer
      );
    }
    
    if (waterResult) {
      transferables.push(
        waterResult.positions.buffer,
        waterResult.normals.buffer,
        waterResult.colors.buffer,
        waterResult.indices.buffer
      );
    }

    self.postMessage({
      type: 'meshResult',
      id,
      solid: solidResult,
      water: waterResult,
      stats: {
        solidBlocks: solidBlocks.length,
        waterBlocks: waterBlocks.length,
        solidTriangles: solidResult?.triangleCount || 0,
        waterTriangles: waterResult?.triangleCount || 0,
        timeMs: elapsed,
      }
    }, transferables);
  }
  
  // Subchunk mesh building - for parallel region meshing
  // Solid subchunk: receives pre-separated solid blocks + neighbor blocks
  if (type === 'buildSubchunkMesh') {
    const { solidBlocks, neighborBlocks, offset, subchunkY } = data;
    
    try {
      const startTime = performance.now();
      
      // Build solid mesh only - neighbor blocks used for culling
      // targetType=1 means solid, which culls against solid only
      const result = buildGreedyMeshArrays(solidBlocks, neighborBlocks, offset, 1);
      
      const elapsed = performance.now() - startTime;
      
      const transferables = [];
      if (result) {
        transferables.push(
          result.positions.buffer,
          result.normals.buffer,
          result.colors.buffer,
          result.indices.buffer
        );
      }
      
      self.postMessage({
        type: 'subchunkMeshResult',
        id,
        subchunkY,
        geometry: result,
        stats: {
          blockCount: solidBlocks.length,
          triangleCount: result?.triangleCount || 0,
          timeMs: elapsed,
        }
      }, transferables);
    } catch (error) {
      console.error(`Worker error building subchunk ${subchunkY}:`, error);
      self.postMessage({
        type: 'subchunkMeshResult',
        id,
        subchunkY,
        geometry: null,
        stats: {
          blockCount: solidBlocks?.length || 0,
          triangleCount: 0,
          timeMs: 0,
          error: error.message
        }
      });
    }
  }
  
  // Water subchunk mesh building
  // Water culls against both solid and water blocks
  if (type === 'buildWaterSubchunkMesh') {
    const { waterBlocks, neighborBlocks, offset, subchunkY } = data;
    
    try {
      const startTime = performance.now();
      
      // Build water mesh - targetType=2 means water, which culls against solid+water
      const result = buildGreedyMeshArrays(waterBlocks, neighborBlocks, offset, 2);
      
      const elapsed = performance.now() - startTime;
      
      const transferables = [];
      if (result) {
        transferables.push(
          result.positions.buffer,
          result.normals.buffer,
          result.colors.buffer,
          result.indices.buffer
        );
      }
      
      self.postMessage({
        type: 'waterSubchunkMeshResult',
        id,
        subchunkY,
        geometry: result,
        stats: {
          blockCount: waterBlocks.length,
          triangleCount: result?.triangleCount || 0,
          timeMs: elapsed,
        }
      }, transferables);
    } catch (error) {
      console.error(`Worker error building water subchunk ${subchunkY}:`, error);
      self.postMessage({
        type: 'waterSubchunkMeshResult',
        id,
        subchunkY,
        geometry: null,
        stats: {
          blockCount: waterBlocks?.length || 0,
          triangleCount: 0,
          timeMs: 0,
          error: error.message
        }
      });
    }
  }
  
  // Lava subchunk mesh building
  // Lava culls against both solid and lava blocks
  if (type === 'buildLavaSubchunkMesh') {
    const { lavaBlocks, neighborBlocks, offset, subchunkY } = data;
    
    try {
      const startTime = performance.now();
      
      // Build lava mesh - targetType=3 means lava, which culls against solid+lava
      const result = buildGreedyMeshArrays(lavaBlocks, neighborBlocks, offset, 3);
      
      const elapsed = performance.now() - startTime;
      
      const transferables = [];
      if (result) {
        transferables.push(
          result.positions.buffer,
          result.normals.buffer,
          result.colors.buffer,
          result.indices.buffer
        );
      }
      
      self.postMessage({
        type: 'lavaSubchunkMeshResult',
        id,
        subchunkY,
        geometry: result,
        stats: {
          blockCount: lavaBlocks.length,
          triangleCount: result?.triangleCount || 0,
          timeMs: elapsed,
        }
      }, transferables);
    } catch (error) {
      console.error(`Worker error building lava subchunk ${subchunkY}:`, error);
      self.postMessage({
        type: 'lavaSubchunkMeshResult',
        id,
        subchunkY,
        geometry: null,
        stats: {
          blockCount: lavaBlocks?.length || 0,
          triangleCount: 0,
          timeMs: 0,
          error: error.message
        }
      });
    }
  }
};

