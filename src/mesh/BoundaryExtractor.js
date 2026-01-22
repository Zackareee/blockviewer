/**
 * BoundaryExtractor - Extract just the 1-block boundary strip from chunks
 * 
 * This allows pre-loading neighbor boundary data before meshing,
 * eliminating the need for rebuilds when neighbors load.
 * 
 * For each super-chunk, we need data from the adjacent blocks:
 * - North edge: z=15 of chunks at z-1
 * - South edge: z=0 of chunks at z+1
 * - East edge: x=15 of chunks at x+1
 * - West edge: x=0 of chunks at x-1
 * 
 * Enhanced to also extract light data (skyLight + blockLight) for proper
 * lighting at chunk boundaries without rebuilds.
 */

import pako from 'pako';
import { getBlockRegistry } from './BlockRegistry.js';

// Section size
const S = 16;

// Number of Y sections (from y=-64 to y=320 = 384 blocks = 24 sections)
const NUM_SECTIONS = 24;
const MIN_SECTION_Y = -4; // y=-64 / 16

// Air block names
const AIR_BLOCKS = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 
  'air', 'cave_air', 'void_air'
]);

/**
 * Check if a block name is air
 */
function isAirBlock(name) {
  return AIR_BLOCKS.has(name);
}

/**
 * Extract boundary blocks from a single chunk's NBT data
 * 
 * @param {Object} chunkData - Parsed NBT chunk data
 * @param {number} chunkX - Chunk X coordinate  
 * @param {number} chunkZ - Chunk Z coordinate
 * @param {string} edge - Which edge to extract: 'north' (z=0), 'south' (z=15), 'east' (x=15), 'west' (x=0)
 * @param {BlockRegistry} registry - Block registry for ID lookup
 * @returns {Object} Sparse boundary data: { chunkX, chunkZ, edge, blocks: Map<sectionY, Uint16Array(16x16)> }
 */
export function extractBoundaryFromChunk(chunkData, chunkX, chunkZ, edge, registry = null) {
  const reg = registry || getBlockRegistry();
  const sections = chunkData.sections || (chunkData.Level && chunkData.Level.Sections);
  
  if (!sections) {
    return { chunkX, chunkZ, edge, blocks: new Map() };
  }
  
  const blocks = new Map();
  
  for (const section of sections) {
    const sectionY = section.Y ?? section.y;
    if (sectionY === undefined) continue;
    
    // Get block_states data
    const blockStates = section.block_states || section.BlockStates;
    let palette = null;
    let data = null;
    
    if (blockStates) {
      palette = blockStates.palette;
      data = blockStates.data;
    } else if (section.Palette) {
      palette = section.Palette;
      data = section.BlockStates;
    }
    
    if (!palette) continue;
    
    // Single-entry palette means entire section is that block
    if (palette.length === 1) {
      const entry = palette[0];
      const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
      const blockId = reg.getBlockId(name);
      
      if (blockId === 0 || isAirBlock(name)) continue;
      
      // Fill the boundary strip with this block ID
      const stripData = new Uint16Array(16 * 384); // 16 blocks per strip × 384 Y levels max
      stripData.fill(blockId);
      blocks.set(sectionY, { singleBlock: blockId });
      continue;
    }
    
    // Multi-entry palette - need to decode
    if (!data) continue;
    
    // Pre-process palette
    const paletteBlockIds = new Uint16Array(palette.length);
    for (let i = 0; i < palette.length; i++) {
      const entry = palette[i];
      const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
      paletteBlockIds[i] = reg.getBlockId(name);
    }
    
    // Calculate bits per block
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const mask = (1 << bitsPerBlock) - 1;
    const blocksPerLong = Math.floor(64 / bitsPerBlock);
    
    // Extract just the boundary strip based on edge
    const stripData = new Uint16Array(16 * 16); // 16 blocks along edge × 16 Y levels in section
    
    // Convert BigInt64Array or similar to array for processing
    const longArray = data instanceof BigInt64Array ? data : 
                      Array.isArray(data) ? data.map(v => BigInt(v)) :
                      Array.from(data).map(v => BigInt(v));
    
    for (let y = 0; y < S; y++) {
      for (let i = 0; i < S; i++) {
        let lx, lz;
        let stripIndex;
        
        switch (edge) {
          case 'north': // z=0 row
            lx = i;
            lz = 0;
            stripIndex = y * S + lx;
            break;
          case 'south': // z=15 row
            lx = i;
            lz = 15;
            stripIndex = y * S + lx;
            break;
          case 'east': // x=15 column
            lx = 15;
            lz = i;
            stripIndex = y * S + lz;
            break;
          case 'west': // x=0 column
            lx = 0;
            lz = i;
            stripIndex = y * S + lz;
            break;
          default:
            continue;
        }
        
        // Calculate block index within section (YZX order)
        const blockIndex = (y * S * S) + (lz * S) + lx;
        
        // Decode from packed longs
        const longIndex = Math.floor(blockIndex / blocksPerLong);
        const bitOffset = (blockIndex % blocksPerLong) * bitsPerBlock;
        
        if (longIndex < longArray.length) {
          const longVal = longArray[longIndex];
          const paletteIndex = Number((longVal >> BigInt(bitOffset)) & BigInt(mask));
          
          if (paletteIndex < paletteBlockIds.length) {
            stripData[stripIndex] = paletteBlockIds[paletteIndex];
          }
        }
      }
    }
    
    blocks.set(sectionY, { stripData });
  }
  
  return { chunkX, chunkZ, edge, blocks };
}

/**
 * Unpack nibble-packed light data for a single boundary strip
 * Minecraft stores light as 4 bits per block (2048 bytes = 4096 blocks per section)
 * 
 * @param {Uint8Array|Int8Array} lightData - 2048 byte packed light array
 * @param {string} edge - Which edge to extract
 * @returns {Uint8Array} 16x16 unpacked light values for the strip (16 positions * 16 Y levels)
 */
function unpackLightStrip(lightData, edge) {
  const stripLight = new Uint8Array(S * S); // 16 positions × 16 Y levels per section
  
  for (let y = 0; y < S; y++) {
    for (let i = 0; i < S; i++) {
      let lx, lz;
      let stripIndex;
      
      switch (edge) {
        case 'north': lx = i; lz = 0; stripIndex = y * S + lx; break;
        case 'south': lx = i; lz = 15; stripIndex = y * S + lx; break;
        case 'east': lx = 15; lz = i; stripIndex = y * S + lz; break;
        case 'west': lx = 0; lz = i; stripIndex = y * S + lz; break;
        case 'southeast': lx = 15; lz = 15; stripIndex = 0; if (i > 0 || y > 0) continue; break;
        case 'southwest': lx = 0; lz = 15; stripIndex = 0; if (i > 0 || y > 0) continue; break;
        case 'northeast': lx = 15; lz = 0; stripIndex = 0; if (i > 0 || y > 0) continue; break;
        case 'northwest': lx = 0; lz = 0; stripIndex = 0; if (i > 0 || y > 0) continue; break;
        default: continue;
      }
      
      // Block index within section (YZX order)
      const blockIndex = (y * S * S) + (lz * S) + lx;
      
      // Light is nibble-packed: 2 values per byte
      const byteIndex = Math.floor(blockIndex / 2);
      const isUpperNibble = (blockIndex % 2) === 1;
      
      if (byteIndex < lightData.length) {
        const byte = lightData[byteIndex] & 0xFF; // Handle signed bytes
        const lightValue = isUpperNibble ? ((byte >> 4) & 0x0F) : (byte & 0x0F);
        stripLight[stripIndex] = lightValue;
      }
    }
  }
  
  return stripLight;
}

/**
 * Extract boundary blocks AND light data from a single chunk's NBT data
 * 
 * This is the enhanced version that includes light for proper boundary rendering.
 * Returns transferable typed arrays optimized for worker communication.
 * 
 * @param {Object} chunkData - Parsed NBT chunk data
 * @param {number} chunkX - Chunk X coordinate (world coordinates)
 * @param {number} chunkZ - Chunk Z coordinate (world coordinates)
 * @param {string} edge - Which edge to extract: 'north', 'south', 'east', 'west', or corner variants
 * @param {BlockRegistry} registry - Block registry for ID lookup
 * @returns {Object} Boundary data with blocks and light:
 *   {
 *     chunkX, chunkZ, edge,
 *     blocks: Map<sectionY, { stripData: Uint16Array | singleBlock: number }>,
 *     light: Map<sectionY, { skyLight: Uint8Array, blockLight: Uint8Array }>
 *   }
 */
export function extractBoundaryWithLight(chunkData, chunkX, chunkZ, edge, registry = null) {
  const reg = registry || getBlockRegistry();
  const sections = chunkData.sections || (chunkData.Level && chunkData.Level.Sections);
  
  if (!sections) {
    return { chunkX, chunkZ, edge, blocks: new Map(), light: new Map() };
  }
  
  const blocks = new Map();
  const light = new Map();
  
  for (const section of sections) {
    const sectionY = section.Y ?? section.y;
    if (sectionY === undefined) continue;
    
    // === Extract blocks ===
    const blockStates = section.block_states || section.BlockStates;
    let palette = null;
    let data = null;
    
    if (blockStates) {
      palette = blockStates.palette;
      data = blockStates.data;
    } else if (section.Palette) {
      palette = section.Palette;
      data = section.BlockStates;
    }
    
    if (palette) {
      // Single-entry palette means entire section is that block
      if (palette.length === 1) {
        const entry = palette[0];
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        const blockId = reg.getBlockId(name);
        
        if (blockId !== 0 && !isAirBlock(name)) {
          blocks.set(sectionY, { singleBlock: blockId });
        }
      } else if (data) {
        // Multi-entry palette - decode the strip
        const paletteBlockIds = new Uint16Array(palette.length);
        for (let i = 0; i < palette.length; i++) {
          const entry = palette[i];
          const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
          paletteBlockIds[i] = reg.getBlockId(name);
        }
        
        const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
        const mask = (1 << bitsPerBlock) - 1;
        const blocksPerLong = Math.floor(64 / bitsPerBlock);
        
        const stripData = new Uint16Array(S * S);
        
        const longArray = data instanceof BigInt64Array ? data : 
                          Array.isArray(data) ? data.map(v => BigInt(v)) :
                          Array.from(data).map(v => BigInt(v));
        
        for (let y = 0; y < S; y++) {
          for (let i = 0; i < S; i++) {
            let lx, lz, stripIndex;
            
            switch (edge) {
              case 'north': lx = i; lz = 0; stripIndex = y * S + lx; break;
              case 'south': lx = i; lz = 15; stripIndex = y * S + lx; break;
              case 'east': lx = 15; lz = i; stripIndex = y * S + lz; break;
              case 'west': lx = 0; lz = i; stripIndex = y * S + lz; break;
              case 'southeast': lx = 15; lz = 15; stripIndex = y * S; if (i > 0) continue; break;
              case 'southwest': lx = 0; lz = 15; stripIndex = y * S; if (i > 0) continue; break;
              case 'northeast': lx = 15; lz = 0; stripIndex = y * S; if (i > 0) continue; break;
              case 'northwest': lx = 0; lz = 0; stripIndex = y * S; if (i > 0) continue; break;
              default: continue;
            }
            
            const blockIndex = (y * S * S) + (lz * S) + lx;
            const longIndex = Math.floor(blockIndex / blocksPerLong);
            const bitOffset = (blockIndex % blocksPerLong) * bitsPerBlock;
            
            if (longIndex < longArray.length) {
              const longVal = longArray[longIndex];
              const paletteIndex = Number((longVal >> BigInt(bitOffset)) & BigInt(mask));
              
              if (paletteIndex < paletteBlockIds.length) {
                stripData[stripIndex] = paletteBlockIds[paletteIndex];
              }
            }
          }
        }
        
        blocks.set(sectionY, { stripData });
      }
    }
    
    // === Extract light data ===
    const skyLightData = section.SkyLight || section.sky_light;
    const blockLightData = section.BlockLight || section.block_light;
    
    const sectionLight = {};
    
    if (skyLightData && skyLightData.length >= 2048) {
      sectionLight.skyLight = unpackLightStrip(skyLightData, edge);
    }
    
    if (blockLightData && blockLightData.length >= 2048) {
      sectionLight.blockLight = unpackLightStrip(blockLightData, edge);
    }
    
    if (sectionLight.skyLight || sectionLight.blockLight) {
      light.set(sectionY, sectionLight);
    }
  }
  
  return { chunkX, chunkZ, edge, blocks, light };
}

/**
 * Serialize boundary data for worker transfer
 * Converts Maps to arrays of transferable objects
 * 
 * @param {Object} boundaryData - From extractBoundaryWithLight
 * @returns {Object} Serialized data with transferable arrays
 */
export function serializeBoundaryForWorker(boundaryData) {
  const { chunkX, chunkZ, edge, blocks, light } = boundaryData;
  
  // Convert blocks Map to array
  const blocksArray = [];
  for (const [sectionY, data] of blocks) {
    if (data.singleBlock !== undefined) {
      blocksArray.push({ sectionY, singleBlock: data.singleBlock });
    } else if (data.stripData) {
      blocksArray.push({ sectionY, stripData: data.stripData });
    }
  }
  
  // Convert light Map to array
  const lightArray = [];
  for (const [sectionY, data] of light) {
    lightArray.push({
      sectionY,
      skyLight: data.skyLight || null,
      blockLight: data.blockLight || null,
    });
  }
  
  return { chunkX, chunkZ, edge, blocks: blocksArray, light: lightArray };
}

/**
 * Deserialize boundary data received from main thread
 * Converts arrays back to Maps for grid injection
 * 
 * @param {Object} serialized - From serializeBoundaryForWorker
 * @returns {Object} Boundary data with Maps
 */
export function deserializeBoundaryFromWorker(serialized) {
  const { chunkX, chunkZ, edge, blocks: blocksArray, light: lightArray } = serialized;
  
  const blocks = new Map();
  for (const entry of blocksArray) {
    if (entry.singleBlock !== undefined) {
      blocks.set(entry.sectionY, { singleBlock: entry.singleBlock });
    } else if (entry.stripData) {
      blocks.set(entry.sectionY, { stripData: entry.stripData });
    }
  }
  
  const light = new Map();
  for (const entry of lightArray) {
    const sectionLight = {};
    if (entry.skyLight) sectionLight.skyLight = entry.skyLight;
    if (entry.blockLight) sectionLight.blockLight = entry.blockLight;
    if (Object.keys(sectionLight).length > 0) {
      light.set(entry.sectionY, sectionLight);
    }
  }
  
  return { chunkX, chunkZ, edge, blocks, light };
}

/**
 * Get transferable buffers from serialized boundary data
 * Use this when calling postMessage to transfer ownership
 * 
 * @param {Object} serialized - From serializeBoundaryForWorker
 * @returns {ArrayBuffer[]} Array of transferable buffers
 */
export function getTransferableBuffers(serialized) {
  const buffers = [];
  
  for (const entry of serialized.blocks) {
    if (entry.stripData?.buffer) {
      buffers.push(entry.stripData.buffer);
    }
  }
  
  for (const entry of serialized.light) {
    if (entry.skyLight?.buffer) buffers.push(entry.skyLight.buffer);
    if (entry.blockLight?.buffer) buffers.push(entry.blockLight.buffer);
  }
  
  return buffers;
}

/**
 * Parse NBT from raw compressed chunk data
 * This is a minimal parser for boundary extraction
 */
export function parseNBTForBoundary(compressedData, compressionType) {
  // Decompress
  let decompressed;
  if (compressionType === 1) {
    decompressed = pako.ungzip(new Uint8Array(compressedData));
  } else {
    decompressed = pako.inflate(new Uint8Array(compressedData));
  }
  
  // Parse NBT (simplified)
  // We need the sections array
  const view = new DataView(decompressed.buffer);
  let offset = 0;
  
  // Skip NBT tag type and root compound name
  if (view.getUint8(offset) !== 10) { // TAG_Compound
    throw new Error('Invalid NBT: expected compound tag');
  }
  offset++;
  
  const nameLen = view.getUint16(offset);
  offset += 2 + nameLen;
  
  // Parse compound
  return parseNBTCompound(view, offset).value;
}

/**
 * Minimal NBT compound parser
 */
function parseNBTCompound(view, offset) {
  const result = {};
  
  while (offset < view.byteLength) {
    const tagType = view.getUint8(offset);
    offset++;
    
    if (tagType === 0) { // TAG_End
      break;
    }
    
    // Read name
    const nameLen = view.getUint16(offset);
    offset += 2;
    const nameBytes = new Uint8Array(view.buffer, offset, nameLen);
    const name = new TextDecoder().decode(nameBytes);
    offset += nameLen;
    
    // Parse value
    const { value, newOffset } = parseNBTValue(view, offset, tagType);
    result[name] = value;
    offset = newOffset;
  }
  
  return { value: result, newOffset: offset };
}

/**
 * Parse an NBT value of given type
 */
function parseNBTValue(view, offset, tagType) {
  switch (tagType) {
    case 1: // TAG_Byte
      return { value: view.getInt8(offset), newOffset: offset + 1 };
    case 2: // TAG_Short
      return { value: view.getInt16(offset), newOffset: offset + 2 };
    case 3: // TAG_Int
      return { value: view.getInt32(offset), newOffset: offset + 4 };
    case 4: // TAG_Long
      return { value: view.getBigInt64(offset), newOffset: offset + 8 };
    case 5: // TAG_Float
      return { value: view.getFloat32(offset), newOffset: offset + 4 };
    case 6: // TAG_Double
      return { value: view.getFloat64(offset), newOffset: offset + 8 };
    case 7: { // TAG_Byte_Array
      const len = view.getInt32(offset);
      offset += 4;
      const arr = new Int8Array(view.buffer, offset, len);
      return { value: arr, newOffset: offset + len };
    }
    case 8: { // TAG_String
      const len = view.getUint16(offset);
      offset += 2;
      const strBytes = new Uint8Array(view.buffer, offset, len);
      const str = new TextDecoder().decode(strBytes);
      return { value: str, newOffset: offset + len };
    }
    case 9: { // TAG_List
      const listTagType = view.getUint8(offset);
      offset++;
      const len = view.getInt32(offset);
      offset += 4;
      const list = [];
      for (let i = 0; i < len; i++) {
        const { value, newOffset } = parseNBTValue(view, offset, listTagType);
        list.push(value);
        offset = newOffset;
      }
      return { value: list, newOffset: offset };
    }
    case 10: { // TAG_Compound
      const { value, newOffset } = parseNBTCompound(view, offset);
      return { value, newOffset };
    }
    case 11: { // TAG_Int_Array
      const len = view.getInt32(offset);
      offset += 4;
      const arr = new Int32Array(len);
      for (let i = 0; i < len; i++) {
        arr[i] = view.getInt32(offset + i * 4);
      }
      return { value: arr, newOffset: offset + len * 4 };
    }
    case 12: { // TAG_Long_Array
      const len = view.getInt32(offset);
      offset += 4;
      const arr = new BigInt64Array(len);
      for (let i = 0; i < len; i++) {
        arr[i] = view.getBigInt64(offset + i * 8);
      }
      return { value: arr, newOffset: offset + len * 8 };
    }
    default:
      throw new Error(`Unknown NBT tag type: ${tagType}`);
  }
}

/**
 * Get which edges of neighboring chunks are needed for a super chunk
 * 
 * @param {number} superX - Super chunk X coordinate
 * @param {number} superZ - Super chunk Z coordinate
 * @param {number} superChunkSize - Size of super chunks (e.g., 2 for 2x2)
 * @returns {Array} Array of { chunkX, chunkZ, edge } describing needed boundaries
 */
export function getNeededBoundaryEdges(superX, superZ, superChunkSize = 2) {
  const needed = [];
  
  const minChunkX = superX * superChunkSize;
  const maxChunkX = minChunkX + superChunkSize - 1;
  const minChunkZ = superZ * superChunkSize;
  const maxChunkZ = minChunkZ + superChunkSize - 1;
  
  // West boundary: need x=15 (east edge) from chunks at x-1
  for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
    needed.push({ chunkX: minChunkX - 1, chunkZ: cz, edge: 'east' });
  }
  
  // East boundary: need x=0 (west edge) from chunks at x+1
  for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
    needed.push({ chunkX: maxChunkX + 1, chunkZ: cz, edge: 'west' });
  }
  
  // North boundary: need z=15 (south edge) from chunks at z-1
  for (let cx = minChunkX; cx <= maxChunkX; cx++) {
    needed.push({ chunkX: cx, chunkZ: minChunkZ - 1, edge: 'south' });
  }
  
  // South boundary: need z=0 (north edge) from chunks at z+1
  for (let cx = minChunkX; cx <= maxChunkX; cx++) {
    needed.push({ chunkX: cx, chunkZ: maxChunkZ + 1, edge: 'north' });
  }
  
  // Corner chunks
  // NW: need SE corner
  needed.push({ chunkX: minChunkX - 1, chunkZ: minChunkZ - 1, edge: 'southeast' });
  // NE: need SW corner
  needed.push({ chunkX: maxChunkX + 1, chunkZ: minChunkZ - 1, edge: 'southwest' });
  // SW: need NE corner
  needed.push({ chunkX: minChunkX - 1, chunkZ: maxChunkZ + 1, edge: 'northeast' });
  // SE: need NW corner
  needed.push({ chunkX: maxChunkX + 1, chunkZ: maxChunkZ + 1, edge: 'northwest' });
  
  return needed;
}

/**
 * Inject boundary data into a BinaryGrid
 * 
 * @param {BinaryGrid} grid - Grid to inject into
 * @param {Object} boundaryData - From extractBoundaryFromChunk
 */
export function injectBoundaryIntoGrid(grid, boundaryData) {
  const { chunkX, chunkZ, edge, blocks } = boundaryData;
  
  for (const [sectionY, data] of blocks) {
    if (data.singleBlock !== undefined) {
      // Entire boundary strip is same block
      injectSingleBlockStrip(grid, chunkX, chunkZ, sectionY, edge, data.singleBlock);
    } else if (data.stripData) {
      injectStripData(grid, chunkX, chunkZ, sectionY, edge, data.stripData);
    }
  }
}

/**
 * Inject a single-block-type strip into the grid
 */
function injectSingleBlockStrip(grid, chunkX, chunkZ, sectionY, edge, blockId) {
  const section = grid.getOrCreateSection(chunkX, chunkZ, sectionY);
  
  for (let y = 0; y < S; y++) {
    for (let i = 0; i < S; i++) {
      let lx, lz;
      switch (edge) {
        case 'north': lx = i; lz = 0; break;
        case 'south': lx = i; lz = 15; break;
        case 'east': lx = 15; lz = i; break;
        case 'west': lx = 0; lz = i; break;
        case 'southeast': lx = 15; lz = 15; if (i > 0) continue; break;
        case 'southwest': lx = 0; lz = 15; if (i > 0) continue; break;
        case 'northeast': lx = 15; lz = 0; if (i > 0) continue; break;
        case 'northwest': lx = 0; lz = 0; if (i > 0) continue; break;
        default: continue;
      }
      
      const idx = y * S * S + lz * S + lx;
      section[idx] = blockId;
    }
  }
}

/**
 * Inject strip data into the grid
 */
function injectStripData(grid, chunkX, chunkZ, sectionY, edge, stripData) {
  const section = grid.getOrCreateSection(chunkX, chunkZ, sectionY);
  
  for (let y = 0; y < S; y++) {
    for (let i = 0; i < S; i++) {
      let lx, lz;
      let stripIndex;
      
      switch (edge) {
        case 'north': lx = i; lz = 0; stripIndex = y * S + lx; break;
        case 'south': lx = i; lz = 15; stripIndex = y * S + lx; break;
        case 'east': lx = 15; lz = i; stripIndex = y * S + lz; break;
        case 'west': lx = 0; lz = i; stripIndex = y * S + lz; break;
        default: continue;
      }
      
      const blockId = stripData[stripIndex];
      if (blockId !== 0) {
        const idx = y * S * S + lz * S + lx;
        section[idx] = blockId;
      }
    }
  }
}

/**
 * Inject boundary light data into a LightGrid
 * 
 * @param {LightGrid} lightGrid - Light grid to inject into
 * @param {Object} boundaryData - From extractBoundaryWithLight (with light Map)
 */
export function injectBoundaryLightIntoGrid(lightGrid, boundaryData) {
  const { chunkX, chunkZ, edge, light } = boundaryData;
  
  if (!light || light.size === 0) return;
  
  for (const [sectionY, lightData] of light) {
    const { skyLight, blockLight } = lightData;
    
    // Get or create the light section
    const lightSection = lightGrid._getOrCreateSection(chunkX, chunkZ, sectionY);
    
    for (let y = 0; y < S; y++) {
      for (let i = 0; i < S; i++) {
        let lx, lz;
        let stripIndex;
        
        switch (edge) {
          case 'north': lx = i; lz = 0; stripIndex = y * S + lx; break;
          case 'south': lx = i; lz = 15; stripIndex = y * S + lx; break;
          case 'east': lx = 15; lz = i; stripIndex = y * S + lz; break;
          case 'west': lx = 0; lz = i; stripIndex = y * S + lz; break;
          case 'southeast': lx = 15; lz = 15; stripIndex = y * S; if (i > 0) continue; break;
          case 'southwest': lx = 0; lz = 15; stripIndex = y * S; if (i > 0) continue; break;
          case 'northeast': lx = 15; lz = 0; stripIndex = y * S; if (i > 0) continue; break;
          case 'northwest': lx = 0; lz = 0; stripIndex = y * S; if (i > 0) continue; break;
          default: continue;
        }
        
        const idx = y * S * S + lz * S + lx;
        
        // Combine sky light (lower nibble) and block light (upper nibble)
        let value = lightSection[idx];
        
        if (skyLight && stripIndex < skyLight.length) {
          value = (value & 0xF0) | (skyLight[stripIndex] & 0x0F);
        }
        
        if (blockLight && stripIndex < blockLight.length) {
          value = (value & 0x0F) | ((blockLight[stripIndex] & 0x0F) << 4);
        }
        
        lightSection[idx] = value;
      }
    }
  }
  
  // Mark that this grid has Minecraft light data
  lightGrid.hasMinecraftLightData = true;
}

/**
 * Inject both blocks and light from boundary data
 * Convenience function that calls both injection methods
 * 
 * @param {BinaryGrid} grid - Block grid to inject into
 * @param {LightGrid} lightGrid - Light grid to inject into
 * @param {Object} boundaryData - From extractBoundaryWithLight
 */
export function injectFullBoundary(grid, lightGrid, boundaryData) {
  injectBoundaryIntoGrid(grid, boundaryData);
  if (lightGrid && boundaryData.light) {
    injectBoundaryLightIntoGrid(lightGrid, boundaryData);
  }
}

export default {
  extractBoundaryFromChunk,
  extractBoundaryWithLight,
  parseNBTForBoundary,
  getNeededBoundaryEdges,
  injectBoundaryIntoGrid,
  injectBoundaryLightIntoGrid,
  injectFullBoundary,
  serializeBoundaryForWorker,
  deserializeBoundaryFromWorker,
  getTransferableBuffers,
};
