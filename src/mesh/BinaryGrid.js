/**
 * BinaryGrid - Sparse binary voxel storage for region data
 * 
 * Uses compact 16-bit storage per block:
 * - Bits 0-11: Block type ID (0-4095)
 * - Bits 12-15: Fluid level / metadata (0-15)
 * 
 * Memory is allocated sparsely per 16x16x16 section to avoid
 * allocating memory for empty (air) sections.
 */

// Constants
export const SECTION_SIZE = 16;
export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE; // 4096
export const BYTES_PER_BLOCK = 2; // Uint16
export const SECTION_BYTES = SECTION_VOLUME * BYTES_PER_BLOCK; // 8192 bytes per section

// Bit masks for block data
export const BLOCK_ID_MASK = 0x0FFF;     // Bits 0-11 (4096 unique blocks)
export const LEVEL_MASK = 0xF000;         // Bits 12-15 (16 levels)
export const LEVEL_SHIFT = 12;

// Region bounds (Minecraft region = 32x32 chunks)
export const CHUNKS_PER_REGION = 32;
export const REGION_SIZE_XZ = CHUNKS_PER_REGION * SECTION_SIZE; // 512 blocks

// Y bounds (Minecraft 1.18+: -64 to 320)
export const MIN_Y = -64;
export const MAX_Y = 320;
export const Y_SECTIONS = (MAX_Y - MIN_Y) / SECTION_SIZE; // 24 sections

/**
 * Convert world Y to section index
 */
export function worldYToSection(worldY) {
  return Math.floor((worldY - MIN_Y) / SECTION_SIZE);
}

/**
 * Convert section index to world Y base
 */
export function sectionToWorldY(sectionIndex) {
  return sectionIndex * SECTION_SIZE + MIN_Y;
}

/**
 * Create a section key from chunk and section coordinates
 * Uses string key to support arbitrary chunk coordinates across multiple regions
 */
export function makeSectionKey(chunkX, chunkZ, sectionY) {
  return `${chunkX},${chunkZ},${sectionY}`;
}

/**
 * Parse section key back to coordinates
 */
export function parseSectionKey(key) {
  const parts = key.split(',');
  return {
    chunkX: parseInt(parts[0], 10),
    chunkZ: parseInt(parts[1], 10),
    sectionY: parseInt(parts[2], 10),
  };
}

/**
 * Calculate block index within a section
 */
export function blockIndexInSection(localX, localY, localZ) {
  // YZX order (Minecraft standard)
  return localY * SECTION_SIZE * SECTION_SIZE + localZ * SECTION_SIZE + localX;
}

/**
 * BinaryGrid class - sparse storage for a Minecraft region
 */
export class BinaryGrid {
  constructor() {
    // Map of section key -> Uint16Array(4096)
    this.sections = new Map();
    
    // Track bounds for efficient iteration
    this.minChunkX = Infinity;
    this.maxChunkX = -Infinity;
    this.minChunkZ = Infinity;
    this.maxChunkZ = -Infinity;
    this.minSectionY = Infinity;
    this.maxSectionY = -Infinity;
    
    // Statistics
    this.totalBlocks = 0;
    this.sectionCount = 0;
  }
  
  /**
   * Clear all data
   */
  clear() {
    this.sections.clear();
    this.minChunkX = Infinity;
    this.maxChunkX = -Infinity;
    this.minChunkZ = Infinity;
    this.maxChunkZ = -Infinity;
    this.minSectionY = Infinity;
    this.maxSectionY = -Infinity;
    this.totalBlocks = 0;
    this.sectionCount = 0;
  }
  
  /**
   * Get or create a section
   */
  _getOrCreateSection(chunkX, chunkZ, sectionY) {
    const key = makeSectionKey(chunkX, chunkZ, sectionY);
    let section = this.sections.get(key);
    
    if (!section) {
      section = new Uint16Array(SECTION_VOLUME);
      this.sections.set(key, section);
      this.sectionCount++;
      
      // Update bounds
      if (chunkX < this.minChunkX) this.minChunkX = chunkX;
      if (chunkX > this.maxChunkX) this.maxChunkX = chunkX;
      if (chunkZ < this.minChunkZ) this.minChunkZ = chunkZ;
      if (chunkZ > this.maxChunkZ) this.maxChunkZ = chunkZ;
      if (sectionY < this.minSectionY) this.minSectionY = sectionY;
      if (sectionY > this.maxSectionY) this.maxSectionY = sectionY;
    }
    
    return section;
  }
  
  /**
   * Get a section (returns undefined if not exists)
   */
  getSection(chunkX, chunkZ, sectionY) {
    const key = makeSectionKey(chunkX, chunkZ, sectionY);
    return this.sections.get(key);
  }
  
  /**
   * Set a block at world coordinates
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} worldZ - World Z coordinate
   * @param {number} blockId - Block type ID (0-4095)
   * @param {number} level - Fluid level or metadata (0-15)
   */
  setBlock(worldX, worldY, worldZ, blockId, level = 0) {
    // Convert to chunk/section coordinates
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    // Local coordinates within section
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    // Get or create section
    const section = this._getOrCreateSection(chunkX, chunkZ, sectionY);
    
    // Calculate index and set value
    const index = blockIndexInSection(localX, localY, localZ);
    const oldValue = section[index];
    const newValue = (blockId & BLOCK_ID_MASK) | ((level & 0xF) << LEVEL_SHIFT);
    
    section[index] = newValue;
    
    // Update block count
    if (oldValue === 0 && newValue !== 0) {
      this.totalBlocks++;
    } else if (oldValue !== 0 && newValue === 0) {
      this.totalBlocks--;
    }
  }
  
  /**
   * Set a block using chunk-relative coordinates
   * @param {number} chunkX - Chunk X coordinate
   * @param {number} chunkZ - Chunk Z coordinate
   * @param {number} localX - Local X within chunk (0-15)
   * @param {number} worldY - World Y coordinate
   * @param {number} localZ - Local Z within chunk (0-15)
   * @param {number} blockId - Block type ID (0-4095)
   * @param {number} level - Fluid level or metadata (0-15)
   */
  setBlockLocal(chunkX, chunkZ, localX, worldY, localZ, blockId, level = 0) {
    const sectionY = worldYToSection(worldY);
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    
    const section = this._getOrCreateSection(chunkX, chunkZ, sectionY);
    const index = blockIndexInSection(localX, localY, localZ);
    const oldValue = section[index];
    const newValue = (blockId & BLOCK_ID_MASK) | ((level & 0xF) << LEVEL_SHIFT);
    
    section[index] = newValue;
    
    if (oldValue === 0 && newValue !== 0) {
      this.totalBlocks++;
    } else if (oldValue !== 0 && newValue === 0) {
      this.totalBlocks--;
    }
  }
  
  /**
   * FAST: Set a block with pre-computed section - for batch decoding
   * @param {Uint16Array} section - Pre-fetched section array
   * @param {number} localX - Local X (0-15)
   * @param {number} localY - Local Y (0-15)
   * @param {number} localZ - Local Z (0-15)
   * @param {number} blockId - Block ID (0-4095)
   * @param {number} level - Fluid level (0-15)
   */
  setBlockInSection(section, localX, localY, localZ, blockId, level = 0) {
    const index = localY * SECTION_SIZE * SECTION_SIZE + localZ * SECTION_SIZE + localX;
    const oldValue = section[index];
    const newValue = (blockId & BLOCK_ID_MASK) | ((level & 0xF) << LEVEL_SHIFT);
    section[index] = newValue;
    
    if (oldValue === 0 && newValue !== 0) {
      this.totalBlocks++;
    } else if (oldValue !== 0 && newValue === 0) {
      this.totalBlocks--;
    }
  }
  
  /**
   * Get block data at world coordinates
   * @returns {{blockId: number, level: number} | null}
   */
  getBlock(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const section = this.getSection(chunkX, chunkZ, sectionY);
    if (!section) return null;
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const index = blockIndexInSection(localX, localY, localZ);
    const value = section[index];
    
    return {
      blockId: value & BLOCK_ID_MASK,
      level: (value & LEVEL_MASK) >> LEVEL_SHIFT,
    };
  }
  
  /**
   * Get block ID at world coordinates (fast path)
   * @returns {number} Block ID or 0 if air/missing
   */
  getBlockId(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const section = this.getSection(chunkX, chunkZ, sectionY);
    if (!section) return 0;
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const index = blockIndexInSection(localX, localY, localZ);
    return section[index] & BLOCK_ID_MASK;
  }
  
  /**
   * Get fluid level at world coordinates
   * @returns {number} Level 0-15 or -1 if not a fluid
   */
  getLevel(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const section = this.getSection(chunkX, chunkZ, sectionY);
    if (!section) return -1;
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const index = blockIndexInSection(localX, localY, localZ);
    const value = section[index];
    
    if (value === 0) return -1;
    return (value & LEVEL_MASK) >> LEVEL_SHIFT;
  }
  
  /**
   * Check if a position has a non-air block
   */
  hasBlock(worldX, worldY, worldZ) {
    return this.getBlockId(worldX, worldY, worldZ) !== 0;
  }
  
  /**
   * Get all section keys
   * @returns {number[]} Array of section keys
   */
  getSectionKeys() {
    return Array.from(this.sections.keys());
  }
  
  /**
   * Iterate over all non-empty sections
   * @param {Function} callback - (section: Uint16Array, chunkX, chunkZ, sectionY) => void
   */
  forEachSection(callback) {
    for (const [key, section] of this.sections) {
      const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
      callback(section, chunkX, chunkZ, sectionY);
    }
  }
  
  /**
   * Iterate over all non-air blocks in a section
   * @param {Function} callback - (blockId, level, localX, localY, localZ) => void
   */
  forEachBlockInSection(section, callback) {
    for (let i = 0; i < SECTION_VOLUME; i++) {
      const value = section[i];
      if (value === 0) continue;
      
      const localX = i % SECTION_SIZE;
      const localZ = Math.floor(i / SECTION_SIZE) % SECTION_SIZE;
      const localY = Math.floor(i / (SECTION_SIZE * SECTION_SIZE));
      
      const blockId = value & BLOCK_ID_MASK;
      const level = (value & LEVEL_MASK) >> LEVEL_SHIFT;
      
      callback(blockId, level, localX, localY, localZ);
    }
  }
  
  /**
   * Get raw section data for a chunk column
   * Returns all sections for a single chunk (16x384x16)
   * @returns {Map<number, Uint16Array>} sectionY -> section data
   */
  getChunkColumn(chunkX, chunkZ) {
    const result = new Map();
    
    for (let sectionY = 0; sectionY < Y_SECTIONS; sectionY++) {
      const section = this.getSection(chunkX, chunkZ, sectionY);
      if (section) {
        result.set(sectionY, section);
      }
    }
    
    return result;
  }
  
  /**
   * Get memory usage estimate
   */
  getMemoryUsage() {
    return {
      sectionCount: this.sectionCount,
      bytesUsed: this.sectionCount * SECTION_BYTES,
      totalBlocks: this.totalBlocks,
    };
  }
  
  /**
   * Get grid bounds in world coordinates
   */
  getBounds() {
    if (this.sectionCount === 0) {
      return null;
    }
    
    return {
      minX: this.minChunkX * SECTION_SIZE,
      maxX: (this.maxChunkX + 1) * SECTION_SIZE - 1,
      minY: sectionToWorldY(this.minSectionY),
      maxY: sectionToWorldY(this.maxSectionY + 1) - 1,
      minZ: this.minChunkZ * SECTION_SIZE,
      maxZ: (this.maxChunkZ + 1) * SECTION_SIZE - 1,
    };
  }
  
  /**
   * Export grid data for worker transfer
   * Returns data that can be sent to workers via postMessage
   */
  export() {
    const sectionsData = [];
    
    for (const [key, section] of this.sections) {
      sectionsData.push({
        key,
        data: section.buffer.slice(0), // Copy buffer
      });
    }
    
    return {
      sections: sectionsData,
      bounds: {
        minChunkX: this.minChunkX,
        maxChunkX: this.maxChunkX,
        minChunkZ: this.minChunkZ,
        maxChunkZ: this.maxChunkZ,
        minSectionY: this.minSectionY,
        maxSectionY: this.maxSectionY,
      },
      totalBlocks: this.totalBlocks,
    };
  }
  
  /**
   * Import grid data from export
   */
  static import(data) {
    const grid = new BinaryGrid();
    
    for (const { key, data: buffer } of data.sections) {
      const section = new Uint16Array(buffer);
      grid.sections.set(key, section);
    }
    
    grid.minChunkX = data.bounds.minChunkX;
    grid.maxChunkX = data.bounds.maxChunkX;
    grid.minChunkZ = data.bounds.minChunkZ;
    grid.maxChunkZ = data.bounds.maxChunkZ;
    grid.minSectionY = data.bounds.minSectionY;
    grid.maxSectionY = data.bounds.maxSectionY;
    grid.totalBlocks = data.totalBlocks;
    grid.sectionCount = data.sections.length;
    
    return grid;
  }
}

export default BinaryGrid;

