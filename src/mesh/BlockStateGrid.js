/**
 * BlockStateGrid - Sparse storage for block state properties
 * 
 * Stores state IDs only for blocks that need non-cube geometry.
 * Works alongside BinaryGrid which stores block IDs.
 * 
 * Uses a Map with compound keys for O(1) lookup.
 */

import { makeSectionKey, parseSectionKey } from './BinaryGrid.js';

/**
 * BlockStateGrid class - sparse state storage
 */
export class BlockStateGrid {
  constructor() {
    // sectionKey → Uint16Array(4096) for sections with any states
    // Sparse: only sections with non-cube blocks have entries
    this.sections = new Map();
    
    // Track which blocks need state lookup (for fast mesher path)
    this.hasStates = new Set(); // Set of sectionKeys
    
    // Statistics
    this.stateCount = 0;
  }

  /**
   * Set state ID for a block
   * @param {string} sectionKey - Section key from BinaryGrid
   * @param {number} index - Block index within section (0-4095)
   * @param {number} stateId - State ID from StateRegistry
   */
  setState(sectionKey, index, stateId) {
    let section = this.sections.get(sectionKey);
    
    if (!section) {
      section = new Uint16Array(4096); // Initialized to 0
      this.sections.set(sectionKey, section);
      this.hasStates.add(sectionKey);
    }

    if (section[index] === 0 && stateId !== 0) {
      this.stateCount++;
    } else if (section[index] !== 0 && stateId === 0) {
      this.stateCount--;
    }

    section[index] = stateId;
  }

  /**
   * Get state ID for a block
   * @returns {number} State ID or 0 if not stored
   */
  getState(sectionKey, index) {
    const section = this.sections.get(sectionKey);
    return section ? section[index] : 0;
  }

  /**
   * Check if a section has any state data
   */
  sectionHasStates(sectionKey) {
    return this.hasStates.has(sectionKey);
  }

  /**
   * Get all state data for a section
   * @returns {Uint16Array|null}
   */
  getSection(sectionKey) {
    return this.sections.get(sectionKey) || null;
  }

  /**
   * Clear all data
   */
  clear() {
    this.sections.clear();
    this.hasStates.clear();
    this.stateCount = 0;
  }

  /**
   * Get memory usage estimate
   */
  getMemoryUsage() {
    return {
      sectionCount: this.sections.size,
      bytesUsed: this.sections.size * 4096 * 2,
      stateCount: this.stateCount,
    };
  }

  /**
   * Export for worker transfer
   */
  export() {
    const data = [];
    for (const [key, section] of this.sections) {
      data.push({
        key,
        data: section.buffer.slice(0),
      });
    }
    return { sections: data, stateCount: this.stateCount };
  }

  /**
   * Import from exported data
   */
  static import(data) {
    const grid = new BlockStateGrid();
    for (const { key, data: buffer } of data.sections) {
      grid.sections.set(key, new Uint16Array(buffer));
      grid.hasStates.add(key);
    }
    grid.stateCount = data.stateCount;
    return grid;
  }
}

export default BlockStateGrid;

