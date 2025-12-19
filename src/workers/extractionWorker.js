/**
 * Extraction Worker - Parallel block extraction from chunk data
 * 
 * Receives raw chunk NBT data and extracts blocks into typed arrays
 * for zero-copy transfer back to main thread.
 */

// Pre-computed BigInt bit offsets for common bitsPerBlock values (4-15)
const BIT_OFFSETS = Array.from({ length: 16 }, (_, i) => 
  Array.from({ length: 64 }, (_, j) => BigInt(j * i))
);

// Air block name set for O(1) lookup
const AIR_BLOCKS = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'air'
]);

// Block name to palette index mapping (shared across all chunks)
// This allows us to use Uint16 indices instead of strings
const globalBlockPalette = new Map();
const globalBlockNames = ['minecraft:air']; // Index 0 = air
globalBlockPalette.set('minecraft:air', 0);

function getBlockIndex(name) {
  let idx = globalBlockPalette.get(name);
  if (idx === undefined) {
    idx = globalBlockNames.length;
    globalBlockNames.push(name);
    globalBlockPalette.set(name, idx);
  }
  return idx;
}

// Fast air check
function isAirBlockFast(name) {
  if (!name) return true;
  return AIR_BLOCKS.has(name) || name.endsWith(':air');
}

// Pre-process palette to extract block names and identify air blocks
function preprocessPalette(palette) {
  const len = palette.length;
  const names = new Array(len);
  const airMask = new Uint8Array(len);
  const globalIndices = new Uint16Array(len);
  
  for (let i = 0; i < len; i++) {
    const entry = palette[i];
    const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
    names[i] = name;
    airMask[i] = isAirBlockFast(name) ? 1 : 0;
    globalIndices[i] = getBlockIndex(name);
  }
  
  return { names, airMask, globalIndices };
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
 * Extract blocks from chunk data into typed arrays
 * Returns: { x: Int32Array, y: Int16Array, z: Int32Array, blockType: Uint16Array, count: number }
 * 
 * Note: x and z use Int32Array to support world coordinates (chunk offsets can be large)
 */
function extractBlocksTyped(chunkData, chunkOffsetX = 0, chunkOffsetZ = 0) {
  // Pre-allocate maximum possible size (16x384x16 = 98304 blocks per chunk)
  // In practice, we'll use much less due to air blocks
  const maxBlocks = 98304;
  const xArr = new Int32Array(maxBlocks);  // Int32 for world coordinates
  const yArr = new Int16Array(maxBlocks);
  const zArr = new Int32Array(maxBlocks);  // Int32 for world coordinates
  const blockTypeArr = new Uint16Array(maxBlocks);
  
  let count = 0;
  
  const data = chunkData.data || chunkData;
  let sections = data.sections || (data.Level && data.Level.Sections);
  
  if (!sections) {
    return { x: xArr.slice(0, 0), y: yArr.slice(0, 0), z: zArr.slice(0, 0), blockType: blockTypeArr.slice(0, 0), count: 0 };
  }

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];
    const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
    const baseY = sectionY * 16;
    
    if (baseY < -64 || baseY > 320) continue;
    
    // Modern format (1.18+)
    const blockStates = section.block_states;
    if (blockStates) {
      const palette = blockStates.palette;
      if (!palette || palette.length === 0) continue;
      
      const blockData = blockStates.data;
      const { airMask, globalIndices } = preprocessPalette(palette);
      
      // Single block type section
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        if (airMask[0]) continue;
        
        const blockIdx = globalIndices[0];
        for (let ly = 0; ly < 16; ly++) {
          const worldY = baseY + ly;
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              xArr[count] = lx + chunkOffsetX;
              yArr[count] = worldY;
              zArr[count] = lz + chunkOffsetZ;
              blockTypeArr[count] = blockIdx;
              count++;
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
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex++];
            
            if (paletteIndex < palette.length && !airMask[paletteIndex]) {
              xArr[count] = lx + chunkOffsetX;
              yArr[count] = worldY;
              zArr[count] = lz + chunkOffsetZ;
              blockTypeArr[count] = globalIndices[paletteIndex];
              count++;
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
      
      const { airMask, globalIndices } = preprocessPalette(palette);
      
      if (palette.length === 1) {
        if (airMask[0]) continue;
        
        const blockIdx = globalIndices[0];
        for (let ly = 0; ly < 16; ly++) {
          const worldY = baseY + ly;
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              xArr[count] = lx + chunkOffsetX;
              yArr[count] = worldY;
              zArr[count] = lz + chunkOffsetZ;
              blockTypeArr[count] = blockIdx;
              count++;
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
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex++];
            
            if (paletteIndex < palette.length && !airMask[paletteIndex]) {
              xArr[count] = lx + chunkOffsetX;
              yArr[count] = worldY;
              zArr[count] = lz + chunkOffsetZ;
              blockTypeArr[count] = globalIndices[paletteIndex];
              count++;
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
        for (let lz = 0; lz < 16; lz++) {
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
            
            if (blockId !== 0) {
              const blockName = `minecraft:legacy_${blockId}`;
              xArr[count] = lx + chunkOffsetX;
              yArr[count] = worldY;
              zArr[count] = lz + chunkOffsetZ;
              blockTypeArr[count] = getBlockIndex(blockName);
              count++;
            }
            blockIndex++;
          }
        }
      }
    }
  }

  // Return trimmed arrays
  return {
    x: xArr.slice(0, count),
    y: yArr.slice(0, count),
    z: zArr.slice(0, count),
    blockType: blockTypeArr.slice(0, count),
    count
  };
}

/**
 * Worker message handler
 */
self.onmessage = function(e) {
  const { type, id, data } = e.data;

  if (type === 'extractChunk') {
    const { chunkData, chunkOffsetX, chunkOffsetZ } = data;
    
    const startTime = performance.now();
    const result = extractBlocksTyped(chunkData, chunkOffsetX, chunkOffsetZ);
    const elapsed = performance.now() - startTime;

    // Transfer typed arrays (zero-copy)
    self.postMessage({
      type: 'extractionResult',
      id,
      result: {
        x: result.x,
        y: result.y,
        z: result.z,
        blockType: result.blockType,
        count: result.count,
        timeMs: elapsed
      },
      // Include the current palette so main thread can resolve block names
      palette: globalBlockNames.slice()
    }, [
      result.x.buffer,
      result.y.buffer,
      result.z.buffer,
      result.blockType.buffer
    ]);
  }
  
  if (type === 'extractBatch') {
    // Extract multiple chunks in one message
    const { chunks } = data;
    const results = [];
    const startTime = performance.now();
    
    for (const chunk of chunks) {
      const result = extractBlocksTyped(chunk.chunkData, chunk.chunkOffsetX, chunk.chunkOffsetZ);
      results.push({
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        ...result
      });
    }
    
    const elapsed = performance.now() - startTime;
    
    // Collect all buffers for transfer
    const transferables = [];
    for (const r of results) {
      transferables.push(r.x.buffer, r.y.buffer, r.z.buffer, r.blockType.buffer);
    }
    
    self.postMessage({
      type: 'batchResult',
      id,
      results,
      palette: globalBlockNames.slice(),
      timeMs: elapsed
    }, transferables);
  }
  
  if (type === 'getPalette') {
    // Return the current global palette
    self.postMessage({
      type: 'paletteResult',
      id,
      palette: globalBlockNames.slice()
    });
  }
};

