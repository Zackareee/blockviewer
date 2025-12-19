import { SUBCHUNK_SIZE, getSubchunkY, getSubchunkYRange, buildSubchunkMesh, buildWaterSubchunkMesh, buildLavaSubchunkMesh } from './greedyMesher';

/**
 * SubchunkManager - Organizes blocks into 16x16x16 subchunks for efficient rendering
 * 
 * Each subchunk is identified by its Y-level index (subchunkY).
 * For Minecraft's Y range of -64 to 320, this gives 24 subchunk layers.
 * 
 * Supports both object-based blocks and typed array blocks for performance.
 */
export class SubchunkManager {
  constructor() {
    // Map of subchunkY -> array of solid blocks in that subchunk
    this.subchunks = new Map();
    // Map of subchunkY -> array of water blocks in that subchunk
    this.waterSubchunks = new Map();
    // Map of subchunkY -> array of lava blocks in that subchunk
    this.lavaSubchunks = new Map();
    // All water blocks (for reference)
    this.waterBlocks = [];
    // All lava blocks (for reference)
    this.lavaBlocks = [];
    // All solid blocks (for reference)
    this.allSolidBlocks = [];
    // Track min/max subchunk Y for iteration
    this.minSubchunkY = Infinity;
    this.maxSubchunkY = -Infinity;
    // Track water subchunk bounds separately
    this.minWaterSubchunkY = Infinity;
    this.maxWaterSubchunkY = -Infinity;
    // Track lava subchunk bounds separately
    this.minLavaSubchunkY = Infinity;
    this.maxLavaSubchunkY = -Infinity;
    
    // Palette for typed array blocks (shared across all chunks)
    this.palette = null;
  }

  /**
   * Clear all data
   */
  clear() {
    this.subchunks.clear();
    this.waterSubchunks.clear();
    this.lavaSubchunks.clear();
    this.waterBlocks = [];
    this.lavaBlocks = [];
    this.allSolidBlocks = [];
    this.minSubchunkY = Infinity;
    this.maxSubchunkY = -Infinity;
    this.minWaterSubchunkY = Infinity;
    this.maxWaterSubchunkY = -Infinity;
    this.minLavaSubchunkY = Infinity;
    this.maxLavaSubchunkY = -Infinity;
    this.palette = null;
  }

  /**
   * Set the block palette for typed array operations
   * @param {string[]} palette - Array of block names indexed by block type
   */
  setPalette(palette) {
    this.palette = palette;
  }

  /**
   * Add blocks from typed arrays (high-performance path)
   * @param {Object} typedBlocks - { x: Uint8Array, y: Int16Array, z: Uint8Array, blockType: Uint16Array, level: Int8Array, count: number }
   * @param {string[]} palette - Block name palette
   */
  addTypedBlocks(typedBlocks, palette) {
    const { x, y, z, blockType, level, count } = typedBlocks;
    
    // Store palette for later use
    if (!this.palette) {
      this.palette = palette;
    }
    
    for (let i = 0; i < count; i++) {
      const blockX = x[i];
      const blockY = y[i];
      const blockZ = z[i];
      const blockName = palette[blockType[i]] || 'minecraft:air';
      const subchunkY = getSubchunkY(blockY);
      
      const block = { x: blockX, y: blockY, z: blockZ, block: blockName };
      
      // Add level property for fluids (level >= 0 means it's a fluid)
      if (level && level[i] >= 0) {
        block.level = level[i];
      }
      
      if (isWaterBlock(blockName)) {
        this.waterBlocks.push(block);
        
        if (subchunkY < this.minWaterSubchunkY) this.minWaterSubchunkY = subchunkY;
        if (subchunkY > this.maxWaterSubchunkY) this.maxWaterSubchunkY = subchunkY;
        
        if (!this.waterSubchunks.has(subchunkY)) {
          this.waterSubchunks.set(subchunkY, []);
        }
        this.waterSubchunks.get(subchunkY).push(block);
      } else if (isLavaBlock(blockName)) {
        this.lavaBlocks.push(block);
        
        if (subchunkY < this.minLavaSubchunkY) this.minLavaSubchunkY = subchunkY;
        if (subchunkY > this.maxLavaSubchunkY) this.maxLavaSubchunkY = subchunkY;
        
        if (!this.lavaSubchunks.has(subchunkY)) {
          this.lavaSubchunks.set(subchunkY, []);
        }
        this.lavaSubchunks.get(subchunkY).push(block);
      } else {
        this.allSolidBlocks.push(block);
        
        if (subchunkY < this.minSubchunkY) this.minSubchunkY = subchunkY;
        if (subchunkY > this.maxSubchunkY) this.maxSubchunkY = subchunkY;
        
        if (!this.subchunks.has(subchunkY)) {
          this.subchunks.set(subchunkY, []);
        }
        this.subchunks.get(subchunkY).push(block);
      }
    }
  }

  /**
   * Add blocks and organize them into subchunks
   * @param {Array} blocks - Array of block objects with {x, y, z, block}
   */
  addBlocks(blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const subchunkY = getSubchunkY(block.y);
      
      if (isWaterBlock(block.block)) {
        this.waterBlocks.push(block);
        
        // Update water bounds
        if (subchunkY < this.minWaterSubchunkY) this.minWaterSubchunkY = subchunkY;
        if (subchunkY > this.maxWaterSubchunkY) this.maxWaterSubchunkY = subchunkY;
        
        // Add to water subchunk
        if (!this.waterSubchunks.has(subchunkY)) {
          this.waterSubchunks.set(subchunkY, []);
        }
        this.waterSubchunks.get(subchunkY).push(block);
      } else if (isLavaBlock(block.block)) {
        this.lavaBlocks.push(block);
        
        // Update lava bounds
        if (subchunkY < this.minLavaSubchunkY) this.minLavaSubchunkY = subchunkY;
        if (subchunkY > this.maxLavaSubchunkY) this.maxLavaSubchunkY = subchunkY;
        
        // Add to lava subchunk
        if (!this.lavaSubchunks.has(subchunkY)) {
          this.lavaSubchunks.set(subchunkY, []);
        }
        this.lavaSubchunks.get(subchunkY).push(block);
      } else {
        this.allSolidBlocks.push(block);
        
        // Update bounds
        if (subchunkY < this.minSubchunkY) this.minSubchunkY = subchunkY;
        if (subchunkY > this.maxSubchunkY) this.maxSubchunkY = subchunkY;
        
        // Add to subchunk
        if (!this.subchunks.has(subchunkY)) {
          this.subchunks.set(subchunkY, []);
        }
        this.subchunks.get(subchunkY).push(block);
      }
    }
  }

  /**
   * Get all subchunk Y indices that have solid blocks
   * @returns {Array<number>} Sorted array of subchunk Y indices
   */
  getSubchunkYIndices() {
    return Array.from(this.subchunks.keys()).sort((a, b) => a - b);
  }

  /**
   * Get all subchunk Y indices that have water blocks
   * @returns {Array<number>} Sorted array of water subchunk Y indices
   */
  getWaterSubchunkYIndices() {
    return Array.from(this.waterSubchunks.keys()).sort((a, b) => a - b);
  }

  /**
   * Get all subchunk Y indices that have lava blocks
   * @returns {Array<number>} Sorted array of lava subchunk Y indices
   */
  getLavaSubchunkYIndices() {
    return Array.from(this.lavaSubchunks.keys()).sort((a, b) => a - b);
  }

  /**
   * Get solid blocks for a specific subchunk
   * @param {number} subchunkY - The subchunk Y index
   * @returns {Array} Array of blocks in that subchunk
   */
  getSubchunkBlocks(subchunkY) {
    return this.subchunks.get(subchunkY) || [];
  }

  /**
   * Get water blocks for a specific subchunk
   * @param {number} subchunkY - The subchunk Y index
   * @returns {Array} Array of water blocks in that subchunk
   */
  getWaterSubchunkBlocks(subchunkY) {
    return this.waterSubchunks.get(subchunkY) || [];
  }

  /**
   * Get lava blocks for a specific subchunk
   * @param {number} subchunkY - The subchunk Y index
   * @returns {Array} Array of lava blocks in that subchunk
   */
  getLavaSubchunkBlocks(subchunkY) {
    return this.lavaSubchunks.get(subchunkY) || [];
  }

  /**
   * Get neighbor blocks for solid subchunk boundary culling
   * @param {number} subchunkY - The subchunk Y index
   * @returns {Array} Array of blocks from neighboring subchunks near the boundary
   */
  getNeighborBlocks(subchunkY) {
    const neighbors = [];
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    
    // Get solid blocks from subchunk below (only those at maxY of that subchunk)
    const belowBlocks = this.subchunks.get(subchunkY - 1);
    if (belowBlocks) {
      const boundaryY = minY - 1;
      for (const block of belowBlocks) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get solid blocks from subchunk above (only those at minY of that subchunk)
    const aboveBlocks = this.subchunks.get(subchunkY + 1);
    if (aboveBlocks) {
      const boundaryY = maxY + 1;
      for (const block of aboveBlocks) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Also include water blocks near boundaries for correct culling
    const belowWater = this.waterSubchunks.get(subchunkY - 1);
    if (belowWater) {
      const boundaryY = minY - 1;
      for (const block of belowWater) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    const aboveWater = this.waterSubchunks.get(subchunkY + 1);
    if (aboveWater) {
      const boundaryY = maxY + 1;
      for (const block of aboveWater) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    return neighbors;
  }

  /**
   * Get neighbor blocks for water subchunk boundary culling
   * Includes both water AND solid blocks since water culls against both
   * @param {number} subchunkY - The subchunk Y index
   * @returns {Array} Array of blocks from neighboring subchunks near the boundary
   */
  getWaterNeighborBlocks(subchunkY) {
    const neighbors = [];
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    
    // Get water blocks from subchunk below
    const belowWater = this.waterSubchunks.get(subchunkY - 1);
    if (belowWater) {
      const boundaryY = minY - 1;
      for (const block of belowWater) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get water blocks from subchunk above
    const aboveWater = this.waterSubchunks.get(subchunkY + 1);
    if (aboveWater) {
      const boundaryY = maxY + 1;
      for (const block of aboveWater) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get solid blocks from subchunk below
    const belowSolid = this.subchunks.get(subchunkY - 1);
    if (belowSolid) {
      const boundaryY = minY - 1;
      for (const block of belowSolid) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get solid blocks from subchunk above
    const aboveSolid = this.subchunks.get(subchunkY + 1);
    if (aboveSolid) {
      const boundaryY = maxY + 1;
      for (const block of aboveSolid) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    return neighbors;
  }

  /**
   * Get neighbor blocks for lava subchunk boundary culling
   * Includes both lava AND solid blocks since lava culls against both
   * @param {number} subchunkY - The subchunk Y index
   * @returns {Array} Array of blocks from neighboring subchunks near the boundary
   */
  getLavaNeighborBlocks(subchunkY) {
    const neighbors = [];
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    
    // Get lava blocks from subchunk below
    const belowLava = this.lavaSubchunks.get(subchunkY - 1);
    if (belowLava) {
      const boundaryY = minY - 1;
      for (const block of belowLava) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get lava blocks from subchunk above
    const aboveLava = this.lavaSubchunks.get(subchunkY + 1);
    if (aboveLava) {
      const boundaryY = maxY + 1;
      for (const block of aboveLava) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get solid blocks from subchunk below
    const belowSolid = this.subchunks.get(subchunkY - 1);
    if (belowSolid) {
      const boundaryY = minY - 1;
      for (const block of belowSolid) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get solid blocks from subchunk above
    const aboveSolid = this.subchunks.get(subchunkY + 1);
    if (aboveSolid) {
      const boundaryY = maxY + 1;
      for (const block of aboveSolid) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    return neighbors;
  }

  /**
   * Check if a subchunk is fully within a Y range
   * @param {number} subchunkY - The subchunk Y index
   * @param {number} minY - Minimum Y to check
   * @param {number} maxY - Maximum Y to check
   * @returns {boolean} True if subchunk is fully within range
   */
  isSubchunkFullyInRange(subchunkY, minY, maxY) {
    const range = getSubchunkYRange(subchunkY);
    return range.minY >= minY && range.maxY <= maxY;
  }

  /**
   * Check if a subchunk intersects a Y range
   * @param {number} subchunkY - The subchunk Y index
   * @param {number} minY - Minimum Y to check
   * @param {number} maxY - Maximum Y to check
   * @returns {boolean} True if subchunk intersects range
   */
  isSubchunkInRange(subchunkY, minY, maxY) {
    const range = getSubchunkYRange(subchunkY);
    return range.maxY >= minY && range.minY <= maxY;
  }

  /**
   * Check if a subchunk is partially clipped by a Y range (needs remeshing)
   * @param {number} subchunkY - The subchunk Y index
   * @param {number} minY - Minimum Y of visible range
   * @param {number} maxY - Maximum Y of visible range
   * @returns {boolean} True if subchunk is clipped at boundaries
   */
  isSubchunkClipped(subchunkY, minY, maxY) {
    const range = getSubchunkYRange(subchunkY);
    // Clipped if the Y range cuts through this subchunk
    const clippedAtBottom = minY > range.minY && minY <= range.maxY;
    const clippedAtTop = maxY >= range.minY && maxY < range.maxY;
    return clippedAtBottom || clippedAtTop;
  }

  /**
   * Get solid blocks for a subchunk filtered by Y range
   * @param {number} subchunkY - The subchunk Y index
   * @param {number} minY - Minimum Y to include
   * @param {number} maxY - Maximum Y to include
   * @returns {Array} Filtered array of blocks
   */
  getSubchunkBlocksInRange(subchunkY, minY, maxY) {
    const blocks = this.subchunks.get(subchunkY) || [];
    return blocks.filter(b => b.y >= minY && b.y <= maxY);
  }

  /**
   * Get water blocks for a subchunk filtered by Y range
   * @param {number} subchunkY - The subchunk Y index
   * @param {number} minY - Minimum Y to include
   * @param {number} maxY - Maximum Y to include
   * @returns {Array} Filtered array of water blocks
   */
  getWaterSubchunkBlocksInRange(subchunkY, minY, maxY) {
    const blocks = this.waterSubchunks.get(subchunkY) || [];
    return blocks.filter(b => b.y >= minY && b.y <= maxY);
  }

  /**
   * Get lava blocks for a subchunk filtered by Y range
   * @param {number} subchunkY - The subchunk Y index
   * @param {number} minY - Minimum Y to include
   * @param {number} maxY - Maximum Y to include
   * @returns {Array} Filtered array of lava blocks
   */
  getLavaSubchunkBlocksInRange(subchunkY, minY, maxY) {
    const blocks = this.lavaSubchunks.get(subchunkY) || [];
    return blocks.filter(b => b.y >= minY && b.y <= maxY);
  }

  /**
   * Get the total number of subchunks
   */
  get subchunkCount() {
    return this.subchunks.size;
  }

  /**
   * Get the total number of solid blocks
   */
  get solidBlockCount() {
    return this.allSolidBlocks.length;
  }

  /**
   * Get the total number of water blocks
   */
  get waterBlockCount() {
    return this.waterBlocks.length;
  }

  /**
   * Get the total number of lava blocks
   */
  get lavaBlockCount() {
    return this.lavaBlocks.length;
  }
}

/**
 * Helper to check if a block is water
 */
function isWaterBlock(blockName) {
  if (!blockName) return false;
  const name = blockName.toLowerCase();
  return name.includes('water') || name.includes('flowing_water');
}

/**
 * Helper to check if a block is lava
 */
function isLavaBlock(blockName) {
  if (!blockName) return false;
  const name = blockName.toLowerCase();
  return name.includes('lava') || name.includes('flowing_lava');
}

export { SUBCHUNK_SIZE, getSubchunkY, getSubchunkYRange, buildSubchunkMesh, buildWaterSubchunkMesh, buildLavaSubchunkMesh };

