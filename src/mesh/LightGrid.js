/**
 * LightGrid - Sparse storage for per-block light values
 * 
 * Stores sky light (0-15) for each block position using the same
 * section-based sparse storage pattern as BinaryGrid.
 * 
 * Minecraft's sky light at noon:
 * - 15 = Full sunlight (outdoors)
 * - 0 = Complete darkness (deep caves)
 * - Decrements by 1 per block in shadow
 */

import { 
  SECTION_SIZE, 
  SECTION_VOLUME,
  MIN_Y,
  makeSectionKey,
  parseSectionKey,
  worldYToSection,
  blockIndexInSection
} from './BinaryGrid.js';

// Maximum light level (full sunlight at noon)
export const MAX_LIGHT = 15;

/**
 * LightGrid class - sparse storage for light values
 */
export class LightGrid {
  constructor() {
    // Map of section key -> Uint8Array(4096)
    // Each byte stores sky light (0-15) in lower nibble
    // Upper nibble reserved for block light if needed later
    this.sections = new Map();
    
    // Track bounds for efficient iteration
    this.minChunkX = Infinity;
    this.maxChunkX = -Infinity;
    this.minChunkZ = Infinity;
    this.maxChunkZ = -Infinity;
    this.minSectionY = Infinity;
    this.maxSectionY = -Infinity;
    
    // Flag to track if this grid has pre-loaded Minecraft light data
    // If true, missing sections should default to 0 (dark underground)
    // If false, we're using fallback propagation or empty data
    this.hasMinecraftLightData = false;
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
    this.hasMinecraftLightData = false;
  }
  
  /**
   * Get or create a section
   */
  _getOrCreateSection(chunkX, chunkZ, sectionY) {
    const key = makeSectionKey(chunkX, chunkZ, sectionY);
    let section = this.sections.get(key);
    
    if (!section) {
      section = new Uint8Array(SECTION_VOLUME);
      this.sections.set(key, section);
      
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
   * Set sky light at world coordinates
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} worldZ - World Z coordinate
   * @param {number} skyLight - Sky light level (0-15)
   */
  setSkyLight(worldX, worldY, worldZ, skyLight) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const section = this._getOrCreateSection(chunkX, chunkZ, sectionY);
    const index = blockIndexInSection(localX, localY, localZ);
    
    // Store sky light in lower nibble (preserving upper nibble for block light)
    section[index] = (section[index] & 0xF0) | (skyLight & 0x0F);
  }
  
  /**
   * Get sky light at world coordinates
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} worldZ - World Z coordinate
   * @returns {number} Sky light level (0-15)
   */
  getSkyLight(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const section = this.getSection(chunkX, chunkZ, sectionY);
    // If section doesn't exist, use same logic as getLight()
    if (!section) {
      const withinBounds = 
        chunkX >= this.minChunkX && chunkX <= this.maxChunkX &&
        chunkZ >= this.minChunkZ && chunkZ <= this.maxChunkZ;
      
      if (this.hasMinecraftLightData && withinBounds) {
        return 0; // Underground with MC data
      }
      return MAX_LIGHT; // Outside bounds or no MC data
    }
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const index = blockIndexInSection(localX, localY, localZ);
    return section[index] & 0x0F;
  }
  
  /**
   * Set block light at world coordinates
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} worldZ - World Z coordinate
   * @param {number} blockLight - Block light level (0-15)
   */
  setBlockLight(worldX, worldY, worldZ, blockLight) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const section = this._getOrCreateSection(chunkX, chunkZ, sectionY);
    const index = blockIndexInSection(localX, localY, localZ);
    
    // Store block light in upper nibble (preserving lower nibble for sky light)
    section[index] = (section[index] & 0x0F) | ((blockLight & 0x0F) << 4);
  }
  
  /**
   * Get block light at world coordinates
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} worldZ - World Z coordinate
   * @returns {number} Block light level (0-15), defaults to 0 if not set
   */
  getBlockLight(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const section = this.getSection(chunkX, chunkZ, sectionY);
    if (!section) return 0;
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const index = blockIndexInSection(localX, localY, localZ);
    return (section[index] >> 4) & 0x0F;
  }
  
  /**
   * Get both sky light and block light at world coordinates
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} worldZ - World Z coordinate
   * @returns {{skyLight: number, blockLight: number}} Light levels (0-15 each)
   */
  getLight(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);
    
    const section = this.getSection(chunkX, chunkZ, sectionY);
    // If section doesn't exist, we need to determine if this is:
    // 1. Empty air above terrain (should be bright, sky=15)
    // 2. Underground area with missing data (should be dark, sky=0)
    // 3. Outside loaded chunk bounds (default to sky=15 for safety)
    if (!section) {
      // Check if this chunk position is within our loaded bounds
      // If we have Minecraft light data and the chunk is within bounds,
      // a missing section likely means underground (dark)
      // If outside bounds, default to bright to avoid darkening unloaded areas
      const withinBounds = 
        chunkX >= this.minChunkX && chunkX <= this.maxChunkX &&
        chunkZ >= this.minChunkZ && chunkZ <= this.maxChunkZ;
      
      if (this.hasMinecraftLightData && withinBounds) {
        // Within loaded chunks with MC data - missing section = underground
        return { skyLight: 0, blockLight: 0 };
      }
      // Outside bounds or no MC data - default to bright (safe fallback)
      return { skyLight: MAX_LIGHT, blockLight: 0 };
    }
    
    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    
    const index = blockIndexInSection(localX, localY, localZ);
    const value = section[index];
    return {
      skyLight: value & 0x0F,
      blockLight: (value >> 4) & 0x0F,
    };
  }
  
  /**
   * Fast sky light lookup using pre-computed section
   * @param {Uint8Array} section - The light section
   * @param {number} localX - Local X (0-15)
   * @param {number} localY - Local Y (0-15)
   * @param {number} localZ - Local Z (0-15)
   * @returns {number} Sky light level (0-15)
   */
  getSkyLightInSection(section, localX, localY, localZ) {
    const index = localY * SECTION_SIZE * SECTION_SIZE + localZ * SECTION_SIZE + localX;
    return section[index] & 0x0F;
  }
  
  /**
   * Set sky light using pre-computed section (for batch operations)
   */
  setSkyLightInSection(section, localX, localY, localZ, skyLight) {
    const index = localY * SECTION_SIZE * SECTION_SIZE + localZ * SECTION_SIZE + localX;
    section[index] = (section[index] & 0xF0) | (skyLight & 0x0F);
  }
  
  /**
   * ULTRA-FAST: Get light value by direct index (no coordinate conversion)
   * @param {Uint8Array} section - The light section
   * @param {number} index - Direct array index (0-4095)
   * @returns {number} Combined light byte (sky in lower nibble, block in upper)
   */
  static getLightByIndex(section, index) {
    return section[index];
  }
  
  /**
   * ULTRA-FAST: Get sky and block light by index (inline-friendly)
   * Call as: const val = section[index]; skyLight = val & 0xF; blockLight = val >> 4;
   */
  
  /**
   * Get a light section by section key directly (avoids coordinate math)
   * @param {string} key - Section key from makeSectionKey
   * @returns {Uint8Array|undefined}
   */
  getSectionByKey(key) {
    return this.sections.get(key);
  }
  
  /**
   * Get memory usage estimate
   */
  getMemoryUsage() {
    return {
      sectionCount: this.sections.size,
      bytesUsed: this.sections.size * SECTION_VOLUME,
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
    };
  }

  /**
   * Import grid data from export
   */
  static import(data) {
    const grid = new LightGrid();
    
    for (const { key, data: buffer } of data.sections) {
      const section = new Uint8Array(buffer);
      grid.sections.set(key, section);
    }
    
    if (data.bounds) {
      grid.minChunkX = data.bounds.minChunkX;
      grid.maxChunkX = data.bounds.maxChunkX;
      grid.minChunkZ = data.bounds.minChunkZ;
      grid.maxChunkZ = data.bounds.maxChunkZ;
      grid.minSectionY = data.bounds.minSectionY;
      grid.maxSectionY = data.bounds.maxSectionY;
    }
    
    return grid;
  }
}

export default LightGrid;


