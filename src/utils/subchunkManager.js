import { SUBCHUNK_SIZE, getSubchunkY, getSubchunkYRange, buildSubchunkMesh, buildWaterSubchunkMesh, buildLavaSubchunkMesh } from './greedyMesher';

/**
 * SubchunkManager - Organizes blocks into 16-block-tall Y-level subchunks
 * 
 * OPTIMIZED: Uses Y-level only partitioning for fewer subchunks (faster loading).
 * Key format: subchunkY (number) -> indices array
 */
export class SubchunkManager {
  constructor() {
    // Map of subchunkY -> indices array for solid blocks
    this.subchunkIndices = new Map();
    // Map of subchunkY -> indices array for water blocks
    this.waterSubchunkIndices = new Map();
    // Map of subchunkY -> indices array for lava blocks
    this.lavaSubchunkIndices = new Map();
    
    // Typed arrays for all blocks (stored contiguously for performance)
    this.typedX = null;
    this.typedY = null;
    this.typedZ = null;
    this.typedBlockType = null;
    this.typedLevel = null;
    this.blockCount = 0;
    
    // Legacy object arrays (created lazily on demand)
    this.subchunks = new Map();
    this.waterSubchunks = new Map();
    this.lavaSubchunks = new Map();
    this.waterBlocks = null;
    this.lavaBlocks = null;
    this.allSolidBlocks = null;
    this._objectsCached = false;
    
    // Track min/max subchunk Y for iteration
    this.minSubchunkY = Infinity;
    this.maxSubchunkY = -Infinity;
    this.minWaterSubchunkY = Infinity;
    this.maxWaterSubchunkY = -Infinity;
    this.minLavaSubchunkY = Infinity;
    this.maxLavaSubchunkY = -Infinity;
    
    // Palette for typed array blocks (shared across all chunks)
    this.palette = null;
  }
  
  /**
   * Parse key - format is "chunkX,chunkZ,subchunkY"
   */
  _parseKey(key) {
    if (typeof key !== 'string') {
      return { chunkX: 0, chunkZ: 0, subchunkY: key };
    }
    const parts = key.split(',');
    return { 
      chunkX: parseInt(parts[0], 10), 
      chunkZ: parseInt(parts[1], 10), 
      subchunkY: parseInt(parts[2], 10) 
    };
  }

  /**
   * Clear all data
   */
  clear() {
    this.subchunkIndices.clear();
    this.waterSubchunkIndices.clear();
    this.lavaSubchunkIndices.clear();
    this.subchunks.clear();
    this.waterSubchunks.clear();
    this.lavaSubchunks.clear();
    this.typedX = null;
    this.typedY = null;
    this.typedZ = null;
    this.typedBlockType = null;
    this.typedLevel = null;
    this.blockCount = 0;
    this.waterBlocks = null;
    this.lavaBlocks = null;
    this.allSolidBlocks = null;
    this._objectsCached = false;
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
   * Create a subchunk key from chunk and Y coordinates
   * @private
   */
  _makeKey(chunkX, chunkZ, subchunkY) {
    return `${chunkX},${chunkZ},${subchunkY}`;
  }

  /**
   * Add blocks from typed arrays (high-performance path)
   * FIXED: Uses chunk-based partitioning (16x16x16 subchunks) for proper memory management
   * @param {Object} typedBlocks - { x: Int32Array, y: Int16Array, z: Int32Array, blockType: Uint16Array, level: Int8Array, count: number }
   * @param {string[]} palette - Block name palette
   */
  addTypedBlocks(typedBlocks, palette) {
    const { x, y, z, blockType, level, count } = typedBlocks;
    
    // Store palette for later use
    if (!this.palette) {
      this.palette = palette;
    } else {
      // Merge palettes if needed (for incremental loading)
      if (palette !== this.palette) {
        // Just use the new palette - it should be a superset
        this.palette = palette;
      }
    }
    
    // Build water/lava type lookup once (using Set for O(1) lookup)
    const waterTypeIndices = new Set();
    const lavaTypeIndices = new Set();
    for (let i = 0; i < palette.length; i++) {
      const name = palette[i];
      if (name && isWaterBlock(name)) waterTypeIndices.add(i);
      else if (name && isLavaBlock(name)) lavaTypeIndices.add(i);
    }
    
    // If we already have data, we need to merge (copy and extend arrays)
    const baseOffset = this.blockCount;
    if (baseOffset > 0) {
      // Extend existing arrays
      const newX = new Int32Array(baseOffset + count);
      const newY = new Int16Array(baseOffset + count);
      const newZ = new Int32Array(baseOffset + count);
      const newBlockType = new Uint16Array(baseOffset + count);
      const newLevel = new Int8Array(baseOffset + count);
      
      newX.set(this.typedX);
      newY.set(this.typedY);
      newZ.set(this.typedZ);
      newBlockType.set(this.typedBlockType);
      if (this.typedLevel) newLevel.set(this.typedLevel);
      
      newX.set(x, baseOffset);
      newY.set(y, baseOffset);
      newZ.set(z, baseOffset);
      newBlockType.set(blockType, baseOffset);
      if (level) newLevel.set(level, baseOffset);
      
      this.typedX = newX;
      this.typedY = newY;
      this.typedZ = newZ;
      this.typedBlockType = newBlockType;
      this.typedLevel = newLevel;
    } else {
      // First batch - just reference the arrays (they're already copies from worker)
      this.typedX = x;
      this.typedY = y;
      this.typedZ = z;
      this.typedBlockType = blockType;
      this.typedLevel = level || new Int8Array(count);
    }
    
    this.blockCount = baseOffset + count;
    this._objectsCached = false; // Invalidate any cached objects
    
    // Build subchunk index maps using CHUNK-BASED partitioning (16x16x16 subchunks)
    // This keeps each subchunk at a reasonable size (~4096 blocks max)
    for (let i = 0; i < count; i++) {
      const globalIdx = baseOffset + i;
      const blockX = x[i];
      const blockY = y[i];
      const blockZ = z[i];
      const type = blockType[i];
      
      // Calculate chunk coordinates and subchunk Y
      const chunkX = Math.floor(blockX / 16);
      const chunkZ = Math.floor(blockZ / 16);
      const subchunkY = getSubchunkY(blockY);
      const key = this._makeKey(chunkX, chunkZ, subchunkY);
      
      if (waterTypeIndices.has(type)) {
        // Water block
        if (subchunkY < this.minWaterSubchunkY) this.minWaterSubchunkY = subchunkY;
        if (subchunkY > this.maxWaterSubchunkY) this.maxWaterSubchunkY = subchunkY;
        
        let indices = this.waterSubchunkIndices.get(key);
        if (!indices) {
          indices = [];
          this.waterSubchunkIndices.set(key, indices);
        }
        indices.push(globalIdx);
      } else if (lavaTypeIndices.has(type)) {
        // Lava block
        if (subchunkY < this.minLavaSubchunkY) this.minLavaSubchunkY = subchunkY;
        if (subchunkY > this.maxLavaSubchunkY) this.maxLavaSubchunkY = subchunkY;
        
        let indices = this.lavaSubchunkIndices.get(key);
        if (!indices) {
          indices = [];
          this.lavaSubchunkIndices.set(key, indices);
        }
        indices.push(globalIdx);
      } else {
        // Solid block
        if (subchunkY < this.minSubchunkY) this.minSubchunkY = subchunkY;
        if (subchunkY > this.maxSubchunkY) this.maxSubchunkY = subchunkY;
        
        let indices = this.subchunkIndices.get(key);
        if (!indices) {
          indices = [];
          this.subchunkIndices.set(key, indices);
        }
        indices.push(globalIdx);
      }
    }
  }
  
  /**
   * Convert index to block object (lazy creation)
   * @private
   */
  _indexToBlock(idx) {
    return {
      x: this.typedX[idx],
      y: this.typedY[idx],
      z: this.typedZ[idx],
      block: this.palette[this.typedBlockType[idx]] || 'minecraft:air',
      level: this.typedLevel ? this.typedLevel[idx] : undefined
    };
  }
  
  /**
   * Build object cache for legacy API (called lazily)
   * @private
   */
  _buildObjectCache() {
    if (this._objectsCached) return;
    
    // Build solid subchunks
    this.subchunks.clear();
    for (const [key, indices] of this.subchunkIndices) {
      const blocks = indices.map(idx => this._indexToBlock(idx));
      this.subchunks.set(key, blocks);
    }
    
    // Build water subchunks
    this.waterSubchunks.clear();
    for (const [key, indices] of this.waterSubchunkIndices) {
      const blocks = indices.map(idx => this._indexToBlock(idx));
      this.waterSubchunks.set(key, blocks);
    }
    
    // Build lava subchunks
    this.lavaSubchunks.clear();
    for (const [key, indices] of this.lavaSubchunkIndices) {
      const blocks = indices.map(idx => this._indexToBlock(idx));
      this.lavaSubchunks.set(key, blocks);
    }
    
    this._objectsCached = true;
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
   * Get all subchunk keys that have solid blocks
   * @returns {Array<string>} Array of "chunkX,chunkZ,subchunkY" keys
   */
  getSubchunkYIndices() {
    return Array.from(this.subchunkIndices.keys());
  }

  /**
   * Get all subchunk keys that have water blocks
   * @returns {Array<string>} Array of subchunk keys
   */
  getWaterSubchunkYIndices() {
    return Array.from(this.waterSubchunkIndices.keys());
  }

  /**
   * Get all subchunk keys that have lava blocks
   * @returns {Array<string>} Array of subchunk keys
   */
  getLavaSubchunkYIndices() {
    return Array.from(this.lavaSubchunkIndices.keys());
  }

  /**
   * Get solid blocks for a specific subchunk
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   * @returns {Array} Array of blocks in that subchunk
   */
  getSubchunkBlocks(key) {
    const indices = this.subchunkIndices.get(key);
    if (!indices || indices.length === 0) return [];
    return indices.map(idx => this._indexToBlock(idx));
  }

  /**
   * Get water blocks for a specific subchunk
   * @param {string} key - The subchunk key
   * @returns {Array} Array of water blocks in that subchunk
   */
  getWaterSubchunkBlocks(key) {
    const indices = this.waterSubchunkIndices.get(key);
    if (!indices || indices.length === 0) return [];
    return indices.map(idx => this._indexToBlock(idx));
  }

  /**
   * Get lava blocks for a specific subchunk
   * @param {string} key - The subchunk key
   * @returns {Array} Array of lava blocks in that subchunk
   */
  getLavaSubchunkBlocks(key) {
    const indices = this.lavaSubchunkIndices.get(key);
    if (!indices || indices.length === 0) return [];
    return indices.map(idx => this._indexToBlock(idx));
  }

  /**
   * Get neighbor blocks for solid subchunk boundary culling
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   * @returns {Array} Array of blocks from neighboring subchunks near the boundary
   */
  getNeighborBlocks(key) {
    const { chunkX, chunkZ, subchunkY } = this._parseKey(key);
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    const boundaryYBelow = minY - 1;
    const boundaryYAbove = maxY + 1;
    const neighbors = [];
    
    // Helper to add blocks at boundary Y from an index array
    const addBoundaryBlocks = (indices, boundaryY) => {
      if (!indices) return;
      for (const idx of indices) {
        if (this.typedY[idx] === boundaryY) {
          neighbors.push(this._indexToBlock(idx));
        }
      }
    };
    
    // Get blocks from subchunks above and below (same chunk)
    const keyBelow = this._makeKey(chunkX, chunkZ, subchunkY - 1);
    const keyAbove = this._makeKey(chunkX, chunkZ, subchunkY + 1);
    
    addBoundaryBlocks(this.subchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryBlocks(this.subchunkIndices.get(keyAbove), boundaryYAbove);
    addBoundaryBlocks(this.waterSubchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryBlocks(this.waterSubchunkIndices.get(keyAbove), boundaryYAbove);
    
    return neighbors;
  }

  /**
   * Get neighbor blocks for water subchunk boundary culling
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   * @returns {Array} Array of blocks from neighboring subchunks near the boundary
   */
  getWaterNeighborBlocks(key) {
    const { chunkX, chunkZ, subchunkY } = this._parseKey(key);
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    const boundaryYBelow = minY - 1;
    const boundaryYAbove = maxY + 1;
    const neighbors = [];
    
    const addBoundaryBlocks = (indices, boundaryY) => {
      if (!indices) return;
      for (const idx of indices) {
        if (this.typedY[idx] === boundaryY) {
          neighbors.push(this._indexToBlock(idx));
        }
      }
    };
    
    const keyBelow = this._makeKey(chunkX, chunkZ, subchunkY - 1);
    const keyAbove = this._makeKey(chunkX, chunkZ, subchunkY + 1);
    
    addBoundaryBlocks(this.waterSubchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryBlocks(this.waterSubchunkIndices.get(keyAbove), boundaryYAbove);
    addBoundaryBlocks(this.subchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryBlocks(this.subchunkIndices.get(keyAbove), boundaryYAbove);
    
    return neighbors;
  }

  /**
   * Get neighbor blocks for lava subchunk boundary culling
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   * @returns {Array} Array of blocks from neighboring subchunks near the boundary
   */
  getLavaNeighborBlocks(key) {
    const { chunkX, chunkZ, subchunkY } = this._parseKey(key);
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    const boundaryYBelow = minY - 1;
    const boundaryYAbove = maxY + 1;
    const neighbors = [];
    
    const addBoundaryBlocks = (indices, boundaryY) => {
      if (!indices) return;
      for (const idx of indices) {
        if (this.typedY[idx] === boundaryY) {
          neighbors.push(this._indexToBlock(idx));
        }
      }
    };
    
    const keyBelow = this._makeKey(chunkX, chunkZ, subchunkY - 1);
    const keyAbove = this._makeKey(chunkX, chunkZ, subchunkY + 1);
    
    addBoundaryBlocks(this.lavaSubchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryBlocks(this.lavaSubchunkIndices.get(keyAbove), boundaryYAbove);
    addBoundaryBlocks(this.subchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryBlocks(this.subchunkIndices.get(keyAbove), boundaryYAbove);
    
    return neighbors;
  }

  /**
   * Extract subchunkY from a key and check if fully within Y range
   */
  isSubchunkFullyInRange(key, minY, maxY) {
    const { subchunkY } = typeof key === 'string' ? this._parseKey(key) : { subchunkY: key };
    const range = getSubchunkYRange(subchunkY);
    return range.minY >= minY && range.maxY <= maxY;
  }

  /**
   * Check if a subchunk intersects a Y range
   */
  isSubchunkInRange(key, minY, maxY) {
    const { subchunkY } = typeof key === 'string' ? this._parseKey(key) : { subchunkY: key };
    const range = getSubchunkYRange(subchunkY);
    return range.maxY >= minY && range.minY <= maxY;
  }

  /**
   * Check if a subchunk is partially clipped by a Y range
   */
  isSubchunkClipped(key, minY, maxY) {
    const { subchunkY } = typeof key === 'string' ? this._parseKey(key) : { subchunkY: key };
    const range = getSubchunkYRange(subchunkY);
    const clippedAtBottom = minY > range.minY && minY <= range.maxY;
    const clippedAtTop = maxY >= range.minY && maxY < range.maxY;
    return clippedAtBottom || clippedAtTop;
  }

  /**
   * Get solid blocks for a subchunk filtered by Y range
   */
  getSubchunkBlocksInRange(key, minY, maxY) {
    const indices = this.subchunkIndices.get(key);
    if (!indices) return [];
    const result = [];
    for (const idx of indices) {
      const y = this.typedY[idx];
      if (y >= minY && y <= maxY) {
        result.push(this._indexToBlock(idx));
      }
    }
    return result;
  }

  /**
   * Get water blocks for a subchunk filtered by Y range
   */
  getWaterSubchunkBlocksInRange(key, minY, maxY) {
    const indices = this.waterSubchunkIndices.get(key);
    if (!indices) return [];
    const result = [];
    for (const idx of indices) {
      const y = this.typedY[idx];
      if (y >= minY && y <= maxY) {
        result.push(this._indexToBlock(idx));
      }
    }
    return result;
  }

  /**
   * Get lava blocks for a subchunk filtered by Y range
   */
  getLavaSubchunkBlocksInRange(key, minY, maxY) {
    const indices = this.lavaSubchunkIndices.get(key);
    if (!indices) return [];
    const result = [];
    for (const idx of indices) {
      const y = this.typedY[idx];
      if (y >= minY && y <= maxY) {
        result.push(this._indexToBlock(idx));
      }
    }
    return result;
  }

  // ============================================================
  // HIGH-PERFORMANCE INDEXED ACCESS (no object conversion)
  // ============================================================

  /**
   * Get raw typed arrays for direct worker access
   * @returns {Object} { x: Int32Array, y: Int16Array, z: Int32Array, blockType: Uint16Array, level: Int8Array, count: number }
   */
  getTypedArrays() {
    return {
      x: this.typedX,
      y: this.typedY,
      z: this.typedZ,
      blockType: this.typedBlockType,
      level: this.typedLevel,
      count: this.blockCount,
      palette: this.palette,
    };
  }

  /**
   * Get solid block indices for a subchunk as Uint32Array (no object conversion)
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   * @returns {Uint32Array} Indices into the typed arrays
   */
  getSolidIndices(key) {
    const indices = this.subchunkIndices.get(key);
    if (!indices || indices.length === 0) return new Uint32Array(0);
    return new Uint32Array(indices);
  }

  /**
   * Get water block indices for a subchunk as Uint32Array
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   */
  getWaterIndices(key) {
    const indices = this.waterSubchunkIndices.get(key);
    if (!indices || indices.length === 0) return new Uint32Array(0);
    return new Uint32Array(indices);
  }

  /**
   * Get lava block indices for a subchunk as Uint32Array
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   */
  getLavaIndices(key) {
    const indices = this.lavaSubchunkIndices.get(key);
    if (!indices || indices.length === 0) return new Uint32Array(0);
    return new Uint32Array(indices);
  }

  /**
   * Get neighbor block indices for solid subchunk boundary culling
   * Returns indices of blocks in adjacent Y layers
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   * @returns {Uint32Array} Indices into typed arrays
   */
  getNeighborIndices(key) {
    const { chunkX, chunkZ, subchunkY } = this._parseKey(key);
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    const boundaryYBelow = minY - 1;
    const boundaryYAbove = maxY + 1;
    const neighborList = [];
    
    const addBoundaryIndices = (indices, boundaryY) => {
      if (!indices) return;
      for (const idx of indices) {
        if (this.typedY[idx] === boundaryY) {
          neighborList.push(idx);
        }
      }
    };
    
    const keyBelow = this._makeKey(chunkX, chunkZ, subchunkY - 1);
    const keyAbove = this._makeKey(chunkX, chunkZ, subchunkY + 1);
    
    addBoundaryIndices(this.subchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryIndices(this.subchunkIndices.get(keyAbove), boundaryYAbove);
    addBoundaryIndices(this.waterSubchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryIndices(this.waterSubchunkIndices.get(keyAbove), boundaryYAbove);
    
    return new Uint32Array(neighborList);
  }

  /**
   * Get neighbor indices for water subchunk
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   */
  getWaterNeighborIndices(key) {
    const { chunkX, chunkZ, subchunkY } = this._parseKey(key);
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    const boundaryYBelow = minY - 1;
    const boundaryYAbove = maxY + 1;
    const neighborList = [];
    
    const addBoundaryIndices = (indices, boundaryY) => {
      if (!indices) return;
      for (const idx of indices) {
        if (this.typedY[idx] === boundaryY) {
          neighborList.push(idx);
        }
      }
    };
    
    const keyBelow = this._makeKey(chunkX, chunkZ, subchunkY - 1);
    const keyAbove = this._makeKey(chunkX, chunkZ, subchunkY + 1);
    
    addBoundaryIndices(this.waterSubchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryIndices(this.waterSubchunkIndices.get(keyAbove), boundaryYAbove);
    addBoundaryIndices(this.subchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryIndices(this.subchunkIndices.get(keyAbove), boundaryYAbove);
    
    return new Uint32Array(neighborList);
  }

  /**
   * Get neighbor indices for lava subchunk
   * @param {string} key - The subchunk key "chunkX,chunkZ,subchunkY"
   */
  getLavaNeighborIndices(key) {
    const { chunkX, chunkZ, subchunkY } = this._parseKey(key);
    const { minY, maxY } = getSubchunkYRange(subchunkY);
    const boundaryYBelow = minY - 1;
    const boundaryYAbove = maxY + 1;
    const neighborList = [];
    
    const addBoundaryIndices = (indices, boundaryY) => {
      if (!indices) return;
      for (const idx of indices) {
        if (this.typedY[idx] === boundaryY) {
          neighborList.push(idx);
        }
      }
    };
    
    const keyBelow = this._makeKey(chunkX, chunkZ, subchunkY - 1);
    const keyAbove = this._makeKey(chunkX, chunkZ, subchunkY + 1);
    
    addBoundaryIndices(this.lavaSubchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryIndices(this.lavaSubchunkIndices.get(keyAbove), boundaryYAbove);
    addBoundaryIndices(this.subchunkIndices.get(keyBelow), boundaryYBelow);
    addBoundaryIndices(this.subchunkIndices.get(keyAbove), boundaryYAbove);
    
    return new Uint32Array(neighborList);
  }

  /**
   * Prepare all mesh jobs for a batch using indexed data
   * Returns jobs ready to be sent to optimized mesh workers
   * @param {Object} offset - World offset {x, y, z}
   * @returns {Object} { solidJobs, waterJobs, lavaJobs, typedArrays }
   */
  prepareIndexedMeshJobs(offset) {
    const typedArrays = this.getTypedArrays();
    
    const solidJobs = [];
    for (const key of this.subchunkIndices.keys()) {
      const { subchunkY } = this._parseKey(key);
      solidJobs.push({
        targetIndices: this.getSolidIndices(key),
        neighborIndices: this.getNeighborIndices(key),
        offset,
        subchunkY,
        subchunkKey: key,
        meshType: 'solid',
      });
    }
    
    const waterJobs = [];
    for (const key of this.waterSubchunkIndices.keys()) {
      const { subchunkY } = this._parseKey(key);
      waterJobs.push({
        targetIndices: this.getWaterIndices(key),
        neighborIndices: this.getWaterNeighborIndices(key),
        offset,
        subchunkY,
        subchunkKey: key,
        meshType: 'water',
      });
    }
    
    const lavaJobs = [];
    for (const key of this.lavaSubchunkIndices.keys()) {
      const { subchunkY } = this._parseKey(key);
      lavaJobs.push({
        targetIndices: this.getLavaIndices(key),
        neighborIndices: this.getLavaNeighborIndices(key),
        offset,
        subchunkY,
        subchunkKey: key,
        meshType: 'lava',
      });
    }
    
    return { solidJobs, waterJobs, lavaJobs, typedArrays };
  }

  /**
   * Get the total number of subchunks
   */
  get subchunkCount() {
    return this.subchunkIndices.size;
  }

  /**
   * Get the total number of solid blocks
   */
  get solidBlockCount() {
    let count = 0;
    for (const indices of this.subchunkIndices.values()) {
      count += indices.length;
    }
    return count;
  }

  /**
   * Get the total number of water blocks
   */
  get waterBlockCount() {
    let count = 0;
    for (const indices of this.waterSubchunkIndices.values()) {
      count += indices.length;
    }
    return count;
  }

  /**
   * Get the total number of lava blocks
   */
  get lavaBlockCount() {
    let count = 0;
    for (const indices of this.lavaSubchunkIndices.values()) {
      count += indices.length;
    }
    return count;
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

