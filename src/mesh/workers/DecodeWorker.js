/**
 * DecodeWorker - Parallel chunk decoding worker
 * 
 * Decodes Minecraft NBT chunk data into binary grid format.
 * Runs in a Web Worker for parallel processing.
 */

// Import block registry (will be recreated from transferred data)
import { BlockRegistry } from '../BlockRegistry.js';
import { BinaryGrid, SECTION_SIZE, MIN_Y, MAX_Y } from '../BinaryGrid.js';
import { AIR_BLOCKS, UNDERWATER_BLOCKS, isAirBlock } from './shared.js';

// Pre-computed BigInt bit offsets for common bitsPerBlock values (4-15)
const BIT_OFFSETS = Array.from({ length: 16 }, (_, i) => 
  Array.from({ length: 64 }, (_, j) => BigInt(j * i))
);

/**
 * Unpack block indices from packed long array
 */
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

// isAirBlock imported from shared.js

/**
 * Extract fluid level from block properties
 */
function extractFluidLevel(entry) {
  if (typeof entry !== 'object' || !entry.Properties) {
    return 0;
  }
  
  const level = entry.Properties.level;
  if (level !== undefined) {
    const parsed = parseInt(level, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
  
  return 0;
}

/**
 * Pre-process a palette into block IDs
 */
function preprocessPalette(palette, registry) {
  const len = palette.length;
  const blockIds = new Uint16Array(len);
  const isAir = new Uint8Array(len);
  const levels = new Int8Array(len);
  
  for (let i = 0; i < len; i++) {
    const entry = palette[i];
    const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
    
    blockIds[i] = registry.getBlockId(name);
    isAir[i] = isAirBlock(name) ? 1 : 0;
    
    if (name.includes('water') || name.includes('lava')) {
      levels[i] = extractFluidLevel(entry);
    } else {
      // Check for waterlogged property on non-fluid blocks
      if (typeof entry === 'object' && entry.Properties?.waterlogged === 'true') {
        // Use level 8 as a marker for waterlogged blocks
        levels[i] = 8;
      } 
      // Check for blocks that inherently exist in water (seagrass, kelp, etc.)
      else if (UNDERWATER_BLOCKS.has(name)) {
        levels[i] = 8;
      } else {
        levels[i] = -1; // Not a fluid, not waterlogged
      }
    }
  }
  
  return { blockIds, isAir, levels };
}

/**
 * Decode a single section
 */
function decodeSection(section, chunkX, chunkZ, grid, registry) {
  const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
  const baseY = sectionY * SECTION_SIZE;
  
  if (baseY < MIN_Y || baseY >= MAX_Y) return 0;
  
  let blocksDecoded = 0;
  
  // Modern format with block_states
  const blockStates = section.block_states;
  if (blockStates) {
    const palette = blockStates.palette;
    if (!palette || palette.length === 0) return 0;
    
    const blockData = blockStates.data;
    const { blockIds, isAir, levels } = preprocessPalette(palette, registry);
    
    // Single block type section
    if (palette.length === 1 || !blockData || blockData.length === 0) {
      if (isAir[0]) return 0;
      
      const blockId = blockIds[0];
      const level = levels[0] >= 0 ? levels[0] : 0;
      
      for (let ly = 0; ly < SECTION_SIZE; ly++) {
        const worldY = baseY + ly;
        for (let lz = 0; lz < SECTION_SIZE; lz++) {
          for (let lx = 0; lx < SECTION_SIZE; lx++) {
            grid.setBlockLocal(chunkX, chunkZ, lx, worldY, lz, blockId, level);
            blocksDecoded++;
          }
        }
      }
      return blocksDecoded;
    }
    
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
    
    let blockIndex = 0;
    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      const worldY = baseY + ly;
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          const paletteIndex = indices[blockIndex++];
          
          if (paletteIndex < palette.length && !isAir[paletteIndex]) {
            const level = levels[paletteIndex] >= 0 ? levels[paletteIndex] : 0;
            grid.setBlockLocal(chunkX, chunkZ, lx, worldY, lz, blockIds[paletteIndex], level);
            blocksDecoded++;
          }
        }
      }
    }
    
    return blocksDecoded;
  }
  
  // Legacy format with Palette and BlockStates
  if (section.Palette && section.BlockStates) {
    const palette = section.Palette;
    const blockData = section.BlockStates;
    
    if (palette.length === 0) return 0;
    
    const { blockIds, isAir, levels } = preprocessPalette(palette, registry);
    
    if (palette.length === 1) {
      if (isAir[0]) return 0;
      
      const blockId = blockIds[0];
      const level = levels[0] >= 0 ? levels[0] : 0;
      
      for (let ly = 0; ly < SECTION_SIZE; ly++) {
        const worldY = baseY + ly;
        for (let lz = 0; lz < SECTION_SIZE; lz++) {
          for (let lx = 0; lx < SECTION_SIZE; lx++) {
            grid.setBlockLocal(chunkX, chunkZ, lx, worldY, lz, blockId, level);
            blocksDecoded++;
          }
        }
      }
      return blocksDecoded;
    }
    
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
    
    let blockIndex = 0;
    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      const worldY = baseY + ly;
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          const paletteIndex = indices[blockIndex++];
          
          if (paletteIndex < palette.length && !isAir[paletteIndex]) {
            const level = levels[paletteIndex] >= 0 ? levels[paletteIndex] : 0;
            grid.setBlockLocal(chunkX, chunkZ, lx, worldY, lz, blockIds[paletteIndex], level);
            blocksDecoded++;
          }
        }
      }
    }
    
    return blocksDecoded;
  }
  
  // Pre-1.13 format
  if (section.Blocks) {
    const blocksArray = section.Blocks;
    const addArray = section.Add || null;
    
    let blockIndex = 0;
    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      const worldY = baseY + ly;
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          let blockId = blocksArray[blockIndex] & 0xFF;
          
          if (addArray) {
            const addIndex = blockIndex >> 1;
            const addValue = addArray[addIndex] & 0xFF;
            if (blockIndex % 2 === 0) {
              blockId |= (addValue & 0x0F) << 8;
            } else {
              blockId |= (addValue & 0xF0) << 4;
            }
          }
          
          if (blockId !== 0) {
            const legacyId = registry.getBlockId(`minecraft:legacy_${blockId}`);
            grid.setBlockLocal(chunkX, chunkZ, lx, worldY, lz, legacyId, 0);
            blocksDecoded++;
          }
          
          blockIndex++;
        }
      }
    }
    
    return blocksDecoded;
  }
  
  return 0;
}

/**
 * Decode a full chunk
 */
function decodeChunk(chunk, grid, registry) {
  const { x: chunkX, z: chunkZ, data } = chunk;
  
  const sections = data.sections || (data.Level && data.Level.Sections);
  if (!sections) return 0;
  
  let totalBlocks = 0;
  
  for (const section of sections) {
    totalBlocks += decodeSection(section, chunkX, chunkZ, grid, registry);
  }
  
  return totalBlocks;
}

// Worker message handler
self.onmessage = function(e) {
  const { type, id, chunks, registryData } = e.data;
  
  if (type === 'decodeBatch') {
    try {
      // Reconstruct registry from transferred data
      const registry = BlockRegistry.import(registryData);
      
      // Create grid for this batch
      const grid = new BinaryGrid();
      let totalBlocks = 0;
      
      // Decode all chunks
      for (const chunk of chunks) {
        totalBlocks += decodeChunk(chunk, grid, registry);
      }
      
      // Export grid data for transfer
      const gridData = grid.export();
      
      // Collect transferable buffers
      const transferables = gridData.sections.map(s => s.data);
      
      self.postMessage({
        type: 'decodeComplete',
        id,
        gridData,
        blockCount: totalBlocks,
      }, transferables);
      
    } catch (error) {
      self.postMessage({
        type: 'decodeError',
        id,
        error: error.message,
      });
    }
  }
};

