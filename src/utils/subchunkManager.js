import { SUBCHUNK_SIZE, getSubchunkY, getSubchunkYRange, buildSubchunkMesh } from './greedyMesher';

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
    // All water blocks (kept as single collection for water mesh)
    this.waterBlocks = [];
    // All solid blocks (for reference)
    this.allSolidBlocks = [];
    // Track min/max subchunk Y for iteration
    this.minSubchunkY = Infinity;
    this.maxSubchunkY = -Infinity;
  }

  /**
   * Clear all data
   */
  clear() {
    this.subchunks.clear();
    this.waterBlocks = [];
    this.allSolidBlocks = [];
    this.minSubchunkY = Infinity;
    this.maxSubchunkY = -Infinity;
  }

  /**
   * Add blocks and organize them into subchunks
   * @param {Array} blocks - Array of block objects with {x, y, z, block}
   */
  addBlocks(blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      
      if (isWaterBlock(block.block)) {
        this.waterBlocks.push(block);
      } else {
        this.allSolidBlocks.push(block);
        
        // Determine which subchunk this block belongs to
        const subchunkY = getSubchunkY(block.y);
        
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
   * Get all subchunk Y indices that have blocks
   * @returns {Array<number>} Sorted array of subchunk Y indices
   */
  getSubchunkYIndices() {
    return Array.from(this.subchunks.keys()).sort((a, b) => a - b);
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
   * Get neighbor blocks for boundary culling (blocks in adjacent subchunks that touch the boundary)
   * @param {number} subchunkY - The subchunk Y index
   * @returns {Array} Array of blocks from neighboring subchunks near the boundary
   */
  getNeighborBlocks(subchunkY) {
    const neighbors = [];
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    
    // Get blocks from subchunk below (only those at maxY of that subchunk)
    const belowBlocks = this.subchunks.get(subchunkY - 1);
    if (belowBlocks) {
      const boundaryY = minY - 1;
      for (const block of belowBlocks) {
        if (block.y === boundaryY) {
          neighbors.push(block);
        }
      }
    }
    
    // Get blocks from subchunk above (only those at minY of that subchunk)
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
    for (const block of this.waterBlocks) {
      if (block.y === minY - 1 || block.y === maxY + 1) {
        neighbors.push(block);
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
   * Get blocks for a subchunk filtered by Y range
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

export { SUBCHUNK_SIZE, getSubchunkY, getSubchunkYRange, buildSubchunkMesh };

