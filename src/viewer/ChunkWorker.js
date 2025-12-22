/**
 * Unified Chunk Worker
 * 
 * Processes a single chunk: NBT extraction + greedy meshing in one step.
 * Returns transferable ArrayBuffers for zero-copy transfer to main thread.
 */

import pako from 'pako';

// ============================================================================
// NBT PARSING (copied from nbtParser.js for worker isolation)
// ============================================================================

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

class NBTReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  readByte() {
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readShort() {
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  readInt() {
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  readLong() {
    const high = this.view.getInt32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return BigInt(high) * BigInt(0x100000000) + BigInt(low);
  }

  readFloat() {
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  readDouble() {
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  readString() {
    const length = this.readShort();
    if (length <= 0) return '';
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return new TextDecoder('utf-8').decode(bytes);
  }

  readByteArray() {
    const length = this.readInt();
    const array = new Int8Array(this.buffer, this.offset, length);
    this.offset += length;
    return Array.from(array);
  }

  readIntArray() {
    const length = this.readInt();
    const array = [];
    for (let i = 0; i < length; i++) {
      array.push(this.readInt());
    }
    return array;
  }

  readLongArray() {
    const length = this.readInt();
    const array = [];
    for (let i = 0; i < length; i++) {
      array.push(this.readLong());
    }
    return array;
  }

  readTag(tagType) {
    switch (tagType) {
      case TAG_END: return null;
      case TAG_BYTE: return this.readByte();
      case TAG_SHORT: return this.readShort();
      case TAG_INT: return this.readInt();
      case TAG_LONG: return this.readLong();
      case TAG_FLOAT: return this.readFloat();
      case TAG_DOUBLE: return this.readDouble();
      case TAG_BYTE_ARRAY: return this.readByteArray();
      case TAG_STRING: return this.readString();
      case TAG_LIST: return this.readList();
      case TAG_COMPOUND: return this.readCompound();
      case TAG_INT_ARRAY: return this.readIntArray();
      case TAG_LONG_ARRAY: return this.readLongArray();
      default: throw new Error(`Unknown tag type: ${tagType}`);
    }
  }

  readList() {
    const itemType = this.readByte();
    const length = this.readInt();
    const list = [];
    for (let i = 0; i < length; i++) {
      list.push(this.readTag(itemType));
    }
    return list;
  }

  readCompound() {
    const compound = {};
    while (true) {
      const tagType = this.readByte();
      if (tagType === TAG_END) break;
      const name = this.readString();
      compound[name] = this.readTag(tagType);
    }
    return compound;
  }

  parse() {
    const tagType = this.readByte();
    if (tagType !== TAG_COMPOUND) {
      throw new Error('Root tag must be a compound');
    }
    const name = this.readString();
    const value = this.readCompound();
    return { name, value };
  }
}

// ============================================================================
// BLOCK EXTRACTION
// ============================================================================

const AIR_BLOCKS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'air']);

function isAirBlock(name) {
  if (!name) return true;
  return AIR_BLOCKS.has(name) || name.endsWith(':air');
}

const BIT_OFFSETS = Array.from({ length: 16 }, (_, i) => 
  Array.from({ length: 64 }, (_, j) => BigInt(j * i))
);

function unpackBlockIndices(data, bitsPerBlock, totalBlocks) {
  const indices = new Uint16Array(totalBlocks);
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const entriesPerLong = Math.floor(64 / bitsPerBlock);
  
  const dataLen = data.length;
  const longValues = new Array(dataLen);
  for (let j = 0; j < dataLen; j++) {
    const val = data[j];
    longValues[j] = typeof val === 'bigint' ? BigInt.asUintN(64, val) : BigInt(val >>> 0);
  }
  
  const bitOffsets = bitsPerBlock < 16 ? BIT_OFFSETS[bitsPerBlock] : null;
  
  let i = 0;
  for (let longIndex = 0; longIndex < dataLen && i < totalBlocks; longIndex++) {
    const longValue = longValues[longIndex];
    for (let indexInLong = 0; indexInLong < entriesPerLong && i < totalBlocks; indexInLong++) {
      const bitOffset = bitOffsets ? bitOffsets[indexInLong] : BigInt(indexInLong * bitsPerBlock);
      indices[i++] = Number((longValue >> bitOffset) & mask);
    }
  }
  
  return indices;
}

/**
 * Extract blocks from chunk data into typed arrays
 * Returns { x, y, z, blockType, level, count, palette }
 */
function extractBlocksTyped(chunkData, worldOffsetX, worldOffsetZ) {
  const data = chunkData;
  const sections = data.sections || (data.Level && data.Level.Sections);
  
  if (!sections) {
    return { x: new Int32Array(0), y: new Int16Array(0), z: new Int32Array(0), 
             blockType: new Uint16Array(0), level: new Int8Array(0), count: 0, palette: [] };
  }

  // First pass: count blocks
  let totalBlocks = 0;
  const sectionData = [];
  
  for (const section of sections) {
    const y = section.Y !== undefined ? Number(section.Y) : 0;
    const baseY = y * 16;
    if (baseY < -64 || baseY > 320) continue;
    
    const blockStates = section.block_states;
    if (blockStates) {
      const palette = blockStates.palette;
      if (!palette || palette.length === 0) continue;
      
      const blockData = blockStates.data;
      
      // Pre-process palette
      const paletteInfo = palette.map(entry => {
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        const isAir = isAirBlock(name);
        let level = -1;
        const isWater = name.includes('water');
        const isLava = name.includes('lava');
        
        if (typeof entry === 'object' && entry.Properties?.level !== undefined) {
          level = parseInt(entry.Properties.level, 10) || 0;
        } else if (isWater || isLava) {
          level = 0;
        }
        
        return { name, isAir, level, isWater, isLava };
      });
      
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        if (!paletteInfo[0].isAir) {
          totalBlocks += 4096;
          sectionData.push({ baseY, paletteInfo, indices: null, singleBlock: true });
        }
      } else {
        const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
        const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
        
        let sectionCount = 0;
        for (let i = 0; i < 4096; i++) {
          if (indices[i] < palette.length && !paletteInfo[indices[i]].isAir) {
            sectionCount++;
          }
        }
        
        if (sectionCount > 0) {
          totalBlocks += sectionCount;
          sectionData.push({ baseY, paletteInfo, indices, singleBlock: false });
        }
      }
    }
  }

  // Allocate arrays
  const x = new Int32Array(totalBlocks);
  const yArr = new Int16Array(totalBlocks);
  const z = new Int32Array(totalBlocks);
  const blockType = new Uint16Array(totalBlocks);
  const level = new Int8Array(totalBlocks);
  
  // Global palette across all sections
  const globalPalette = ['minecraft:air'];
  const paletteMap = new Map([['minecraft:air', 0]]);
  
  // Second pass: fill arrays
  let idx = 0;
  
  for (const sd of sectionData) {
    const { baseY, paletteInfo, indices, singleBlock } = sd;
    
    if (singleBlock) {
      const info = paletteInfo[0];
      let typeIdx = paletteMap.get(info.name);
      if (typeIdx === undefined) {
        typeIdx = globalPalette.length;
        globalPalette.push(info.name);
        paletteMap.set(info.name, typeIdx);
      }
      
      for (let ly = 0; ly < 16; ly++) {
        const worldY = baseY + ly;
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            x[idx] = lx + worldOffsetX;
            yArr[idx] = worldY;
            z[idx] = lz + worldOffsetZ;
            blockType[idx] = typeIdx;
            level[idx] = info.level;
            idx++;
          }
        }
      }
    } else {
      let blockIndex = 0;
      for (let ly = 0; ly < 16; ly++) {
        const worldY = baseY + ly;
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const paletteIdx = indices[blockIndex++];
            if (paletteIdx < paletteInfo.length && !paletteInfo[paletteIdx].isAir) {
              const info = paletteInfo[paletteIdx];
              
              let typeIdx = paletteMap.get(info.name);
              if (typeIdx === undefined) {
                typeIdx = globalPalette.length;
                globalPalette.push(info.name);
                paletteMap.set(info.name, typeIdx);
              }
              
              x[idx] = lx + worldOffsetX;
              yArr[idx] = worldY;
              z[idx] = lz + worldOffsetZ;
              blockType[idx] = typeIdx;
              level[idx] = info.level;
              idx++;
            }
          }
        }
      }
    }
  }

  return { x, y: yArr, z, blockType, level, count: totalBlocks, palette: globalPalette };
}

/**
 * Filter blocks by Y range
 */
function filterBlocksByY(blocks, minY, maxY) {
  const { x, y, z, blockType, level, count, palette } = blocks;
  
  // First pass: count blocks in range
  let newCount = 0;
  for (let i = 0; i < count; i++) {
    if (y[i] >= minY && y[i] <= maxY) newCount++;
  }
  
  // If all blocks are in range, return as-is
  if (newCount === count) {
    return blocks;
  }
  
  // Allocate new arrays
  const newX = new Int32Array(newCount);
  const newY = new Int16Array(newCount);
  const newZ = new Int32Array(newCount);
  const newBlockType = new Uint16Array(newCount);
  const newLevel = new Int8Array(newCount);
  
  // Second pass: copy filtered blocks
  let j = 0;
  for (let i = 0; i < count; i++) {
    if (y[i] >= minY && y[i] <= maxY) {
      newX[j] = x[i];
      newY[j] = y[i];
      newZ[j] = z[i];
      newBlockType[j] = blockType[i];
      newLevel[j] = level[i];
      j++;
    }
  }
  
  return { x: newX, y: newY, z: newZ, blockType: newBlockType, level: newLevel, count: newCount, palette };
}

// ============================================================================
// BLOCK COLORS
// ============================================================================

const COLOR_MAP = {
  'stone': 0x808080, 'granite': 0x9A6C4C, 'diorite': 0xBFBFBF, 'andesite': 0x888888,
  'deepslate': 0x4A4A4A, 'cobblestone': 0x7A7A7A, 'bedrock': 0x2A2A2A,
  'dirt': 0x8B6C4C, 'grass_block': 0x5D8C32, 'podzol': 0x6A5D3A, 'clay': 0x9BA4AF,
  'sand': 0xE3D59E, 'red_sand': 0xBA6629, 'gravel': 0x8A8A8A,
  'sandstone': 0xD9C896, 'red_sandstone': 0xA44D22,
  'coal_ore': 0x4A4A4A, 'iron_ore': 0xB8A090, 'copper_ore': 0xA67B5B,
  'gold_ore': 0xFCEE4B, 'redstone_ore': 0xFF0000, 'emerald_ore': 0x17DD62,
  'lapis_ore': 0x1E4B9B, 'diamond_ore': 0x4AEDD9,
  'oak_log': 0x8B7355, 'spruce_log': 0x4A3728, 'birch_log': 0xE8E4D5,
  'jungle_log': 0x6A5B3A, 'acacia_log': 0x6A3D2A, 'dark_oak_log': 0x3A2714,
  'oak_planks': 0xBA9862, 'spruce_planks': 0x7A5A3A, 'birch_planks': 0xC9B87A,
  'oak_leaves': 0x3A8B25, 'spruce_leaves': 0x2A5A35, 'birch_leaves': 0x5A9A3A,
  'water': 0x3F76E4, 'lava': 0xFF6600,
  'bricks': 0x9A5A4A, 'stone_bricks': 0x7A7A7A, 'obsidian': 0x1A0A2A,
  'netherrack': 0x8A3A3A, 'soul_sand': 0x5A4A3A, 'basalt': 0x4A4A4A,
  'end_stone': 0xDADA9A, 'purpur_block': 0xAA6AAA,
  'glass': 0xFFFFFF, 'ice': 0x91B9FF, 'packed_ice': 0x7AA4FF, 'blue_ice': 0x5A84FF,
  'snow_block': 0xF0F0F0, 'snow': 0xFAFAFA,
  'terracotta': 0x9A5A4A, 'white_terracotta': 0xD9C8B8,
  'white_concrete': 0xCFCFCF, 'gray_concrete': 0x36393D,
  'glowstone': 0xFFDD75, 'shroomlight': 0xF0C040,
  'copper_block': 0xC06040, 'amethyst_block': 0x8A5AAA,
  'moss_block': 0x4A7A3A, 'sculk': 0x0A2A3A,
  'bone_block': 0xE5DCC5, 'hay_block': 0xB8A050,
  'white_wool': 0xE8E8E8, 'black_wool': 0x181818,
};

function getBlockColor(blockName) {
  if (!blockName) return 0x707070;
  const name = blockName.replace('minecraft:', '');
  
  if (COLOR_MAP[name]) return COLOR_MAP[name];
  
  for (const [key, color] of Object.entries(COLOR_MAP)) {
    if (name.includes(key)) return color;
  }
  
  if (name.includes('ore')) return 0x8A7A6A;
  if (name.includes('log') || name.includes('wood')) return 0x8B7355;
  if (name.includes('leaves')) return 0x3A8B25;
  if (name.includes('stone')) return 0x808080;
  if (name.includes('dirt')) return 0x8B6C4C;
  if (name.includes('sand')) return 0xE3D59E;
  if (name.includes('grass')) return 0x5D8C32;
  if (name.includes('water')) return 0x3F76E4;
  if (name.includes('lava')) return 0xFF6600;
  if (name.includes('ice')) return 0x91B9FF;
  if (name.includes('snow')) return 0xF0F0F0;
  if (name.includes('nether') || name.includes('crimson')) return 0x7A2A2A;
  if (name.includes('warped')) return 0x2A7A7A;
  
  return 0x707070;
}

// ============================================================================
// GREEDY MESHING
// ============================================================================

const FACE_NORMALS = [
  [0, 1, 0],   // top
  [0, -1, 0],  // bottom
  [1, 0, 0],   // right (+X)
  [-1, 0, 0],  // left (-X)
  [0, 0, 1],   // front (+Z)
  [0, 0, -1],  // back (-Z)
];

const FACE_CORNERS = [
  // top (Y+1): corners at y+1
  (x, y, z, w, h) => [[x, y+1, z+h], [x+w, y+1, z+h], [x+w, y+1, z], [x, y+1, z]],
  // bottom (Y): corners at y
  (x, y, z, w, h) => [[x, y, z], [x+w, y, z], [x+w, y, z+h], [x, y, z+h]],
  // right (+X): at x+1
  (x, y, z, w, h) => [[x+1, y, z], [x+1, y+h, z], [x+1, y+h, z+w], [x+1, y, z+w]],
  // left (-X): at x
  (x, y, z, w, h) => [[x, y, z+w], [x, y+h, z+w], [x, y+h, z], [x, y, z]],
  // front (+Z): at z+1
  (x, y, z, w, h) => [[x, y, z+1], [x+w, y, z+1], [x+w, y+h, z+1], [x, y+h, z+1]],
  // back (-Z): at z
  (x, y, z, w, h) => [[x+w, y, z], [x, y, z], [x, y+h, z], [x+w, y+h, z]],
];

// Face info: [axis, direction, uAxis, vAxis]
const FACE_INFO = [
  [1, 1, 0, 2],   // top: Y axis, +1 dir, U=X, V=Z
  [1, -1, 0, 2],  // bottom
  [0, 1, 2, 1],   // right: X axis, +1 dir, U=Z, V=Y
  [0, -1, 2, 1],  // left
  [2, 1, 0, 1],   // front: Z axis, +1 dir, U=X, V=Y
  [2, -1, 0, 1],  // back
];

function fluidLevelToHeight(level) {
  if (level === undefined || level === null || level < 0) return 14 / 16;
  if (level >= 8) return 1.0;
  return Math.max(2 / 16, (14 - level * 1.5) / 16);
}

/**
 * Build mesh for a chunk
 * Returns { positions, normals, colors, indices } as typed arrays
 */
function buildChunkMesh(blocks, palette, blockType, isSolid = true) {
  const { x, y, z, level, count } = blocks;
  
  if (count === 0) {
    return { positions: new Float32Array(0), normals: new Float32Array(0), 
             colors: new Float32Array(0), indices: new Uint32Array(0) };
  }

  // Find bounds
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  for (let i = 0; i < count; i++) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
    if (z[i] < minZ) minZ = z[i];
    if (z[i] > maxZ) maxZ = z[i];
  }

  const sizeX = maxX - minX + 1;
  const sizeY = maxY - minY + 1;
  const sizeZ = maxZ - minZ + 1;
  
  // Build lookup grid
  const getIdx = (bx, by, bz) => (bx - minX) + (by - minY) * sizeX + (bz - minZ) * sizeX * sizeY;
  const grid = new Uint16Array(sizeX * sizeY * sizeZ);
  const levelGrid = new Int8Array(sizeX * sizeY * sizeZ);
  levelGrid.fill(-1);
  
  for (let i = 0; i < count; i++) {
    const idx = getIdx(x[i], y[i], z[i]);
    grid[idx] = blockType[i] + 1; // +1 so 0 = empty
    levelGrid[idx] = level[i];
  }
  
  const hasBlock = (bx, by, bz) => {
    if (bx < minX || bx > maxX || by < minY || by > maxY || bz < minZ || bz > maxZ) return false;
    return grid[getIdx(bx, by, bz)] > 0;
  };
  
  // Pre-compute colors
  const paletteColors = palette.map(name => {
    const c = getBlockColor(name);
    return [(c >> 16) / 255, ((c >> 8) & 0xFF) / 255, (c & 0xFF) / 255];
  });
  
  // Estimate size (will grow if needed)
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vertexCount = 0;

  if (isSolid) {
    // Use greedy meshing for solid blocks
    const sizes = [sizeX, sizeY, sizeZ];
    const mins = [minX, minY, minZ];
    
    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
      const [axis, dir, uAxis, vAxis] = FACE_INFO[faceIdx];
      const wAxis = axis;
      const normal = FACE_NORMALS[faceIdx];
      const getCorners = FACE_CORNERS[faceIdx];
      
      const dimU = sizes[uAxis];
      const dimV = sizes[vAxis];
      const dimW = sizes[wAxis];
      
      for (let d = 0; d < dimW; d++) {
        const mask = new Uint16Array(dimU * dimV);
        
        for (let j = 0; j < dimV; j++) {
          for (let i = 0; i < dimU; i++) {
            const coords = [0, 0, 0];
            coords[uAxis] = mins[uAxis] + i;
            coords[vAxis] = mins[vAxis] + j;
            coords[wAxis] = mins[wAxis] + d;
            
            const [bx, by, bz] = coords;
            const idx = getIdx(bx, by, bz);
            const blockIdx = grid[idx];
            
            if (blockIdx === 0) continue;
            
            // Check neighbor
            const neighborCoords = [...coords];
            neighborCoords[wAxis] += dir;
            const [nx, ny, nz] = neighborCoords;
            
            if (!hasBlock(nx, ny, nz)) {
              mask[i + j * dimU] = blockIdx;
            }
          }
        }
        
        // Greedy merge
        const visited = new Uint8Array(dimU * dimV);
        
        for (let j = 0; j < dimV; j++) {
          for (let i = 0; i < dimU; i++) {
            const maskIdx = i + j * dimU;
            if (visited[maskIdx] || mask[maskIdx] === 0) continue;
            
            const blockIdx = mask[maskIdx];
            
            // Expand width
            let width = 1;
            while (i + width < dimU && !visited[(i + width) + j * dimU] && 
                   mask[(i + width) + j * dimU] === blockIdx) {
              width++;
            }
            
            // Expand height
            let height = 1;
            outer: while (j + height < dimV) {
              for (let k = 0; k < width; k++) {
                const checkIdx = (i + k) + (j + height) * dimU;
                if (visited[checkIdx] || mask[checkIdx] !== blockIdx) break outer;
              }
              height++;
            }
            
            // Mark visited
            for (let dj = 0; dj < height; dj++) {
              for (let di = 0; di < width; di++) {
                visited[(i + di) + (j + dj) * dimU] = 1;
              }
            }
            
            // Create quad
            const baseCoords = [0, 0, 0];
            baseCoords[uAxis] = mins[uAxis] + i;
            baseCoords[vAxis] = mins[vAxis] + j;
            baseCoords[wAxis] = mins[wAxis] + d;
            
            const [baseX, baseY, baseZ] = baseCoords;
            const corners = getCorners(baseX, baseY, baseZ, width, height);
            const color = paletteColors[blockIdx - 1] || [0.5, 0.5, 0.5];
            const startVertex = vertexCount;
            
            for (const [cx, cy, cz] of corners) {
              positions.push(cx, cy, cz);
              normals.push(...normal);
              colors.push(...color);
              vertexCount++;
            }
            
            indices.push(startVertex, startVertex + 1, startVertex + 2,
                        startVertex, startVertex + 2, startVertex + 3);
          }
        }
      }
    }
  } else {
    // Per-block rendering for fluids (with height adjustment)
    for (let i = 0; i < count; i++) {
      const bx = x[i], by = y[i], bz = z[i];
      const idx = getIdx(bx, by, bz);
      const blockIdx = grid[idx];
      if (blockIdx === 0) continue;
      
      const h = fluidLevelToHeight(level[i]);
      const color = paletteColors[blockIdx - 1] || [0.5, 0.5, 0.5];
      
      // Check each face
      const faces = [
        { check: [bx, by + 1, bz], normal: [0, 1, 0], corners: [
          [bx, by + h, bz + 1], [bx + 1, by + h, bz + 1], [bx + 1, by + h, bz], [bx, by + h, bz]
        ]},
        { check: [bx, by - 1, bz], normal: [0, -1, 0], corners: [
          [bx, by, bz], [bx + 1, by, bz], [bx + 1, by, bz + 1], [bx, by, bz + 1]
        ]},
        { check: [bx + 1, by, bz], normal: [1, 0, 0], corners: [
          [bx + 1, by, bz], [bx + 1, by + h, bz], [bx + 1, by + h, bz + 1], [bx + 1, by, bz + 1]
        ]},
        { check: [bx - 1, by, bz], normal: [-1, 0, 0], corners: [
          [bx, by, bz + 1], [bx, by + h, bz + 1], [bx, by + h, bz], [bx, by, bz]
        ]},
        { check: [bx, by, bz + 1], normal: [0, 0, 1], corners: [
          [bx, by, bz + 1], [bx + 1, by, bz + 1], [bx + 1, by + h, bz + 1], [bx, by + h, bz + 1]
        ]},
        { check: [bx, by, bz - 1], normal: [0, 0, -1], corners: [
          [bx + 1, by, bz], [bx, by, bz], [bx, by + h, bz], [bx + 1, by + h, bz]
        ]},
      ];
      
      for (const face of faces) {
        const [nx, ny, nz] = face.check;
        if (!hasBlock(nx, ny, nz)) {
          const startVertex = vertexCount;
          for (const [cx, cy, cz] of face.corners) {
            positions.push(cx, cy, cz);
            normals.push(...face.normal);
            colors.push(...color);
            vertexCount++;
          }
          indices.push(startVertex, startVertex + 1, startVertex + 2,
                      startVertex, startVertex + 2, startVertex + 3);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

self.onmessage = function(e) {
  const { type, id, chunkX, chunkZ, chunkData, minY = -64, maxY = 320 } = e.data;
  
  if (type !== 'processChunk') return;
  
  try {
    // chunkData is already parsed - structured clone preserves BigInt natively!
    // Extract blocks - offset is chunk position in world coordinates
    // chunkX/chunkZ are chunk coordinates, multiply by 16 to get block coordinates
    const offsetX = chunkX * 16;
    const offsetZ = chunkZ * 16;
    const allBlocks = extractBlocksTyped(chunkData, offsetX, offsetZ);
    
    // Filter blocks by Y range
    const blocks = filterBlocksByY(allBlocks, minY, maxY);
    
    // Separate solid, water, lava
    const solidX = [], solidY = [], solidZ = [], solidType = [], solidLevel = [];
    const waterX = [], waterY = [], waterZ = [], waterType = [], waterLevel = [];
    const lavaX = [], lavaY = [], lavaZ = [], lavaType = [], lavaLevel = [];
    
    for (let i = 0; i < blocks.count; i++) {
      const name = blocks.palette[blocks.blockType[i]];
      const isWater = name && name.includes('water');
      const isLava = name && name.includes('lava');
      
      if (isWater) {
        waterX.push(blocks.x[i]);
        waterY.push(blocks.y[i]);
        waterZ.push(blocks.z[i]);
        waterType.push(blocks.blockType[i]);
        waterLevel.push(blocks.level[i]);
      } else if (isLava) {
        lavaX.push(blocks.x[i]);
        lavaY.push(blocks.y[i]);
        lavaZ.push(blocks.z[i]);
        lavaType.push(blocks.blockType[i]);
        lavaLevel.push(blocks.level[i]);
      } else {
        solidX.push(blocks.x[i]);
        solidY.push(blocks.y[i]);
        solidZ.push(blocks.z[i]);
        solidType.push(blocks.blockType[i]);
        solidLevel.push(blocks.level[i]);
      }
    }
    
    // Build meshes
    const solidBlocks = {
      x: new Int32Array(solidX), y: new Int16Array(solidY), z: new Int32Array(solidZ),
      level: new Int8Array(solidLevel), count: solidX.length
    };
    const waterBlocks = {
      x: new Int32Array(waterX), y: new Int16Array(waterY), z: new Int32Array(waterZ),
      level: new Int8Array(waterLevel), count: waterX.length
    };
    const lavaBlocks = {
      x: new Int32Array(lavaX), y: new Int16Array(lavaY), z: new Int32Array(lavaZ),
      level: new Int8Array(lavaLevel), count: lavaX.length
    };
    
    const solid = buildChunkMesh(solidBlocks, blocks.palette, new Uint16Array(solidType), true);
    const water = buildChunkMesh(waterBlocks, blocks.palette, new Uint16Array(waterType), false);
    const lava = buildChunkMesh(lavaBlocks, blocks.palette, new Uint16Array(lavaType), false);
    
    // Find actual bounds of blocks in this chunk
    let boundsMinY = Infinity, boundsMaxY = -Infinity;
    for (let i = 0; i < blocks.count; i++) {
      if (blocks.y[i] < boundsMinY) boundsMinY = blocks.y[i];
      if (blocks.y[i] > boundsMaxY) boundsMaxY = blocks.y[i];
    }
    
    // Transfer ownership of buffers
    const transferables = [
      solid.positions.buffer, solid.normals.buffer, solid.colors.buffer, solid.indices.buffer,
      water.positions.buffer, water.normals.buffer, water.colors.buffer, water.indices.buffer,
      lava.positions.buffer, lava.normals.buffer, lava.colors.buffer, lava.indices.buffer,
    ];
    
    self.postMessage({
      type: 'chunkComplete',
      id,
      chunkX,
      chunkZ,
      solid,
      water,
      lava,
      blockCount: blocks.count,
      bounds: { minY: boundsMinY, maxY: boundsMaxY },
    }, transferables);
    
  } catch (error) {
    self.postMessage({
      type: 'chunkError',
      id,
      chunkX,
      chunkZ,
      error: error.message,
    });
  }
};

