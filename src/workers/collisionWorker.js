/**
 * Collision Worker - Builds collision sets off the main thread
 * 
 * Takes raw chunk data, extracts blocks, and builds a collision set.
 * Returns the collision data as a transferable format.
 */

// Pre-computed BigInt bit offsets for common bitsPerBlock values (4-15)
const BIT_OFFSETS = Array.from({ length: 16 }, (_, i) => 
  Array.from({ length: 64 }, (_, j) => BigInt(j * i))
);

// Air block name set for O(1) lookup
const AIR_BLOCKS = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'air'
]);

// Fast air check
function isAirBlockFast(name) {
  if (!name) return true;
  return AIR_BLOCKS.has(name) || name.endsWith(':air');
}

// Pre-process palette to identify air blocks
function preprocessPalette(palette) {
  const len = palette.length;
  const airMask = new Uint8Array(len);
  
  for (let i = 0; i < len; i++) {
    const entry = palette[i];
    const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
    airMask[i] = isAirBlockFast(name) ? 1 : 0;
  }
  
  return { airMask };
}

// Optimized unpacking of block indices
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
 * Extract solid block positions from chunk data
 * Returns an array of [x, y, z] world coordinates
 */
function extractSolidBlocks(chunkData, chunkWorldX, chunkWorldZ, filterMinY, filterMaxY) {
  const blocks = [];
  
  const data = chunkData.data || chunkData;
  let sections = data.sections || (data.Level && data.Level.Sections);
  
  if (!sections) return blocks;

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];
    const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
    const baseY = sectionY * 16;
    
    // Skip sections outside Y filter range
    if (baseY + 15 < filterMinY || baseY > filterMaxY) continue;
    
    // Modern format (1.18+)
    const blockStates = section.block_states;
    if (blockStates) {
      const palette = blockStates.palette;
      if (!palette || palette.length === 0) continue;
      
      const blockData = blockStates.data;
      const { airMask } = preprocessPalette(palette);
      
      // Single block type section
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        if (airMask[0]) continue;
        
        for (let ly = 0; ly < 16; ly++) {
          const worldY = baseY + ly;
          if (worldY < filterMinY || worldY > filterMaxY) continue;
          
          for (let lz = 0; lz < 16; lz++) {
            const worldZ = chunkWorldZ + lz;
            for (let lx = 0; lx < 16; lx++) {
              const worldX = chunkWorldX + lx;
              blocks.push([worldX, worldY, worldZ]);
            }
          }
        }
        continue;
      }
      
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
      
      let blockIndex = 0;
      for (let ly = 0; ly < 16; ly++) {
        const worldY = baseY + ly;
        const skipY = worldY < filterMinY || worldY > filterMaxY;
        
        for (let lz = 0; lz < 16; lz++) {
          const worldZ = chunkWorldZ + lz;
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex++];
            
            if (!skipY && paletteIndex < palette.length && !airMask[paletteIndex]) {
              const worldX = chunkWorldX + lx;
              blocks.push([worldX, worldY, worldZ]);
            }
          }
        }
      }
    }
    // Legacy format (1.13-1.17)
    else if (section.Palette && section.BlockStates) {
      const palette = section.Palette;
      const blockData = section.BlockStates;
      
      if (palette.length === 0) continue;
      
      const { airMask } = preprocessPalette(palette);
      
      if (palette.length === 1) {
        if (airMask[0]) continue;
        
        for (let ly = 0; ly < 16; ly++) {
          const worldY = baseY + ly;
          if (worldY < filterMinY || worldY > filterMaxY) continue;
          
          for (let lz = 0; lz < 16; lz++) {
            const worldZ = chunkWorldZ + lz;
            for (let lx = 0; lx < 16; lx++) {
              const worldX = chunkWorldX + lx;
              blocks.push([worldX, worldY, worldZ]);
            }
          }
        }
        continue;
      }
      
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
      
      let blockIndex = 0;
      for (let ly = 0; ly < 16; ly++) {
        const worldY = baseY + ly;
        const skipY = worldY < filterMinY || worldY > filterMaxY;
        
        for (let lz = 0; lz < 16; lz++) {
          const worldZ = chunkWorldZ + lz;
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex++];
            
            if (!skipY && paletteIndex < palette.length && !airMask[paletteIndex]) {
              const worldX = chunkWorldX + lx;
              blocks.push([worldX, worldY, worldZ]);
            }
          }
        }
      }
    }
    // Pre-1.13 format
    else if (section.Blocks) {
      const blocksArray = section.Blocks;
      const addArray = section.Add || null;
      
      let blockIndex = 0;
      for (let ly = 0; ly < 16; ly++) {
        const worldY = baseY + ly;
        const skipY = worldY < filterMinY || worldY > filterMaxY;
        
        for (let lz = 0; lz < 16; lz++) {
          const worldZ = chunkWorldZ + lz;
          for (let lx = 0; lx < 16; lx++) {
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
            
            if (!skipY && blockId !== 0) {
              const worldX = chunkWorldX + lx;
              blocks.push([worldX, worldY, worldZ]);
            }
            blockIndex++;
          }
        }
      }
    }
  }

  return blocks;
}

/**
 * Build collision data from multiple chunks
 * Returns collision keys as a flat Int32Array for efficient transfer
 */
function buildCollisionData(chunks, filterMinY, filterMaxY) {
  const allBlocks = [];
  
  for (const chunk of chunks) {
    const worldX = chunk.chunkX * 16;
    const worldZ = chunk.chunkZ * 16;
    
    try {
      const blocks = extractSolidBlocks(chunk.rawData, worldX, worldZ, filterMinY, filterMaxY);
      allBlocks.push(...blocks);
    } catch (e) {
      console.warn(`Worker: Failed to extract chunk (${chunk.chunkX}, ${chunk.chunkZ}):`, e.message);
    }
  }
  
  // Pack into Int32Array: [x1, y1, z1, x2, y2, z2, ...]
  const result = new Int32Array(allBlocks.length * 3);
  for (let i = 0; i < allBlocks.length; i++) {
    result[i * 3] = allBlocks[i][0];
    result[i * 3 + 1] = allBlocks[i][1];
    result[i * 3 + 2] = allBlocks[i][2];
  }
  
  return result;
}

/**
 * Worker message handler
 */
self.onmessage = function(e) {
  const { type, id, data } = e.data;

  if (type === 'buildCollision') {
    const { chunks, filterMinY, filterMaxY } = data;
    
    const startTime = performance.now();
    const collisionData = buildCollisionData(chunks, filterMinY, filterMaxY);
    const elapsed = performance.now() - startTime;
    
    // Transfer the typed array (zero-copy)
    self.postMessage({
      type: 'collisionResult',
      id,
      result: {
        collisionData,
        blockCount: collisionData.length / 3,
        timeMs: elapsed
      }
    }, [collisionData.buffer]);
  }
};

