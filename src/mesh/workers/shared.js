/**
 * Shared utilities for workers and main thread
 * 
 * This module contains code that was previously duplicated across:
 * - SuperChunkWorker.js
 * - RegionWorker.js
 * - DecodeWorker.js
 * - ChunkDecoder.js
 * - mcaParser.js
 * 
 * Since workers use ES modules (type: 'module'), they can import this shared code.
 */

// ============================================================================
// Constants
// ============================================================================

export const S = 16;
export const S2 = 256;
export const S3 = 4096;
export const MIN_Y = -64;
export const MAX_Y = 321;

export const BLOCK_ID_MASK = 0x0FFF;
export const LEVEL_MASK = 0xF000;
export const LEVEL_SHIFT = 12;

// Axis encoding for rotatable blocks (stored in bits 12-13 of block data)
export const AXIS_Y = 0;
export const AXIS_X = 1;
export const AXIS_Z = 2;
export const AXIS_SHIFT = 12;

// ============================================================================
// Block Sets
// ============================================================================

export const AIR_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'
]);

export const UNDERWATER_BLOCKS = new Set([
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column',
  'minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:kelp', 
  'minecraft:kelp_plant', 'minecraft:bubble_column'
]);

// Blocks that contain fluid in their name but aren't actual fluid blocks
export const FLUID_CONTAINER_BLOCKS = new Set([
  'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron',
  'minecraft:water_cauldron', 'minecraft:lava_cauldron', 'minecraft:powder_snow_cauldron'
]);

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse a section key string into chunk coordinates
 * @param {string} key - Format: "chunkX,chunkZ,sectionY"
 * @returns {{ chunkX: number, chunkZ: number, sectionY: number }}
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
 * Convert section Y to world Y coordinate
 * @param {number} sectionY - Section Y index
 * @returns {number} World Y coordinate
 */
export function sectionToWorldY(sectionY) {
  return sectionY * S + MIN_Y;
}

/**
 * Check if a block is rotatable (logs, pillars, etc.)
 * Uses pattern matching to detect block types.
 * @param {string} name - Block name (with or without minecraft: prefix)
 * @returns {boolean}
 */
export function isRotatableBlock(name) {
  return name.includes('_log') || 
         name.includes('_wood') ||
         name.includes('_stem') ||
         name.includes('_hyphae') ||
         name.includes('quartz_pillar') ||
         name.includes('purpur_pillar') ||
         name.includes('bone_block') ||
         name.includes('hay_block') ||
         name.includes('basalt') ||
         (name.includes('deepslate') && !name.includes('tiles') && !name.includes('bricks')) ||
         name.includes('chain') ||
         name.includes('muddy_mangrove_roots') ||
         name.includes('bamboo_block') ||
         name.includes('froglight');
}

/**
 * Check if a block name is an air block
 * @param {string} name - Block name
 * @returns {boolean}
 */
export function isAirBlock(name) {
  if (!name) return true;
  return AIR_BLOCKS.has(name) || name.endsWith(':air');
}

/**
 * Check if a block is underwater vegetation
 * @param {string} name - Block name  
 * @returns {boolean}
 */
export function isUnderwaterBlock(name) {
  return UNDERWATER_BLOCKS.has(name);
}

// ============================================================================
// WorkerBlockRegistry - Lightweight block registry for workers
// ============================================================================

/**
 * Lightweight block registry for use in web workers.
 * Mirrors the main BlockRegistry API but is self-contained.
 */
export class WorkerBlockRegistry {
  constructor() {
    this.nameToId = new Map();
    this.idToInfo = [];
    this.nextId = 0;
    this._register('minecraft:air', 0x000000, false, false);
  }
  
  _register(name, color, isOpaque, isFluid) {
    const id = this.nextId++;
    const info = {
      id, 
      name, 
      color, 
      isOpaque, 
      isFluid,
      colorR: ((color >> 16) & 0xFF) / 255,
      colorG: ((color >> 8) & 0xFF) / 255,
      colorB: (color & 0xFF) / 255,
      isNonCube: false,
    };
    this.nameToId.set(name, id);
    this.idToInfo[id] = info;
    const short = name.replace('minecraft:', '');
    if (short !== name) this.nameToId.set(short, id);
    return id;
  }
  
  getBlockId(name) {
    if (!name) return 0;
    const existing = this.nameToId.get(name);
    if (existing !== undefined) return existing;
    
    const short = name.replace('minecraft:', '');
    const isAir = AIR_BLOCKS.has(name) || AIR_BLOCKS.has(short);
    if (isAir) return 0;
    
    // Auto-register unknown block with gray color
    return this._register(name, 0x808080, true, false);
  }
  
  getBlockInfo(id) {
    return this.idToInfo[id] || null;
  }
  
  /**
   * Initialize from serialized data (from main thread)
   * @param {Object} data - { names: string[], colors: number[], opaque: boolean[], fluid: boolean[] }
   */
  initFromData(data) {
    if (!data || !data.names) return;
    
    this.nameToId.clear();
    this.idToInfo = [];
    this.nextId = 0;
    
    for (let i = 0; i < data.names.length; i++) {
      this._register(
        data.names[i],
        data.colors?.[i] || 0x808080,
        data.opaque?.[i] ?? true,
        data.fluid?.[i] ?? false
      );
    }
  }
}

// ============================================================================
// WorkerBinaryGrid - Lightweight block storage for workers
// ============================================================================

/**
 * Lightweight block grid for use in web workers.
 * Stores blocks as packed data in sections.
 */
export class WorkerBinaryGrid {
  constructor() {
    this.sections = new Map();
  }
  
  /**
   * Get or create a section
   * @param {string} key - Section key "chunkX,chunkZ,sectionY"
   * @returns {Uint16Array}
   */
  getOrCreateSection(key) {
    let section = this.sections.get(key);
    if (!section) {
      section = new Uint16Array(S3);
      this.sections.set(key, section);
    }
    return section;
  }
  
  /**
   * Get a section (or null if not exists)
   * @param {string} key - Section key
   * @returns {Uint16Array|null}
   */
  getSection(key) {
    return this.sections.get(key) || null;
  }
  
  /**
   * Set a block in the grid
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {number} z - World Z
   * @param {number} blockId - Block ID
   * @param {number} level - Fluid level (0-15)
   */
  setBlock(x, y, z, blockId, level = 0) {
    const chunkX = Math.floor(x / S);
    const chunkZ = Math.floor(z / S);
    const sectionY = Math.floor((y - MIN_Y) / S);
    const key = `${chunkX},${chunkZ},${sectionY}`;
    
    const section = this.getOrCreateSection(key);
    const localX = ((x % S) + S) % S;
    const localY = ((y - MIN_Y) % S + S) % S;
    const localZ = ((z % S) + S) % S;
    const idx = localY * S2 + localZ * S + localX;
    
    section[idx] = (blockId & BLOCK_ID_MASK) | ((level & 0xF) << LEVEL_SHIFT);
  }
  
  /**
   * Get block data at position
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {number} z - World Z
   * @returns {{ blockId: number, level: number } | null}
   */
  getBlock(x, y, z) {
    const chunkX = Math.floor(x / S);
    const chunkZ = Math.floor(z / S);
    const sectionY = Math.floor((y - MIN_Y) / S);
    const key = `${chunkX},${chunkZ},${sectionY}`;
    
    const section = this.sections.get(key);
    if (!section) return null;
    
    const localX = ((x % S) + S) % S;
    const localY = ((y - MIN_Y) % S + S) % S;
    const localZ = ((z % S) + S) % S;
    const idx = localY * S2 + localZ * S + localX;
    
    const data = section[idx];
    return {
      blockId: data & BLOCK_ID_MASK,
      level: (data & LEVEL_MASK) >> LEVEL_SHIFT,
    };
  }
  
  /**
   * Clear all sections
   */
  clear() {
    this.sections.clear();
  }
}

// ============================================================================
// WorkerLightGrid - Light storage for workers
// ============================================================================

/**
 * Lightweight light grid for use in web workers.
 * Stores sky and block light in sections.
 */
export class WorkerLightGrid {
  constructor() {
    this.skySections = new Map();
    this.blockSections = new Map();
  }
  
  getOrCreateSkySection(key) {
    let section = this.skySections.get(key);
    if (!section) {
      section = new Uint8Array(S3);
      this.skySections.set(key, section);
    }
    return section;
  }
  
  getOrCreateBlockSection(key) {
    let section = this.blockSections.get(key);
    if (!section) {
      section = new Uint8Array(S3);
      this.blockSections.set(key, section);
    }
    return section;
  }
  
  setSkyLight(x, y, z, value) {
    const chunkX = Math.floor(x / S);
    const chunkZ = Math.floor(z / S);
    const sectionY = Math.floor((y - MIN_Y) / S);
    const key = `${chunkX},${chunkZ},${sectionY}`;
    
    const section = this.getOrCreateSkySection(key);
    const localX = ((x % S) + S) % S;
    const localY = ((y - MIN_Y) % S + S) % S;
    const localZ = ((z % S) + S) % S;
    section[localY * S2 + localZ * S + localX] = value;
  }
  
  setBlockLight(x, y, z, value) {
    const chunkX = Math.floor(x / S);
    const chunkZ = Math.floor(z / S);
    const sectionY = Math.floor((y - MIN_Y) / S);
    const key = `${chunkX},${chunkZ},${sectionY}`;
    
    const section = this.getOrCreateBlockSection(key);
    const localX = ((x % S) + S) % S;
    const localY = ((y - MIN_Y) % S + S) % S;
    const localZ = ((z % S) + S) % S;
    section[localY * S2 + localZ * S + localX] = value;
  }
  
  getSkyLight(x, y, z) {
    const chunkX = Math.floor(x / S);
    const chunkZ = Math.floor(z / S);
    const sectionY = Math.floor((y - MIN_Y) / S);
    const key = `${chunkX},${chunkZ},${sectionY}`;
    
    const section = this.skySections.get(key);
    if (!section) return 15; // Default to full sky light
    
    const localX = ((x % S) + S) % S;
    const localY = ((y - MIN_Y) % S + S) % S;
    const localZ = ((z % S) + S) % S;
    return section[localY * S2 + localZ * S + localX];
  }
  
  getBlockLight(x, y, z) {
    const chunkX = Math.floor(x / S);
    const chunkZ = Math.floor(z / S);
    const sectionY = Math.floor((y - MIN_Y) / S);
    const key = `${chunkX},${chunkZ},${sectionY}`;
    
    const section = this.blockSections.get(key);
    if (!section) return 0;
    
    const localX = ((x % S) + S) % S;
    const localY = ((y - MIN_Y) % S + S) % S;
    const localZ = ((z % S) + S) % S;
    return section[localY * S2 + localZ * S + localX];
  }
  
  clear() {
    this.skySections.clear();
    this.blockSections.clear();
  }
}
