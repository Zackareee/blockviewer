import { SUBCHUNK_SIZE, getSubchunkY, getSubchunkYRange, buildSubchunkMesh, buildWaterSubchunkMesh } from './greedyMesher';

/**
 * SubchunkManager - Organizes blocks into 16x16x16 subchunks for efficient rendering
 * 
 * Each subchunk is identified by its Y-level index (subchunkY).
 * For Minecraft's Y range of -64 to 320, this gives 24 subchunk layers.
 */
export class SubchunkManager {
  constructor() {
    // Map of subchunkY -> array of solid blocks in that subchunk
    this.subchunks = new Map();
    // Map of subchunkY -> array of water blocks in that subchunk
    this.waterSubchunks = new Map();
    // All water blocks (for reference)
    this.waterBlocks = [];
    // All solid blocks (for reference)
    this.allSolidBlocks = [];
    // Track min/max subchunk Y for iteration
    this.minSubchunkY = Infinity;
    this.maxSubchunkY = -Infinity;
    // Track water subchunk bounds separately
    this.minWaterSubchunkY = Infinity;
    this.maxWaterSubchunkY = -Infinity;
  }

  /**
   * Clear all data
   */
  clear() {
    this.subchunks.clear();
    this.waterSubchunks.clear();
    this.waterBlocks = [];
    this.allSolidBlocks = [];
    this.minSubchunkY = Infinity;
    this.maxSubchunkY = -Infinity;
    this.minWaterSubchunkY = Infinity;
    this.maxWaterSubchunkY = -Infinity;
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
}

/**
 * Helper to check if a block is water
 */
function isWaterBlock(blockName) {
  if (!blockName) return false;
  const name = blockName.toLowerCase();
  return name.includes('water') || name.includes('flowing_water');
}

export { SUBCHUNK_SIZE, getSubchunkY, getSubchunkYRange, buildSubchunkMesh, buildWaterSubchunkMesh };

