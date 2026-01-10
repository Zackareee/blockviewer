/**
 * BlockStateGrid - Sparse storage for block state properties
 * 
 * Stores state hashes (u64 FNV-1a) only for blocks that need non-cube geometry.
 * Works alongside BinaryGrid which stores block IDs.
 * 
 * Uses a Map with compound keys for O(1) lookup.
 * 
 * Supports two modes:
 * 1. Legacy u16 state IDs (for main thread model meshing)
 * 2. u64 FNV hashes (for WASM model meshing)
 */

import { makeSectionKey, parseSectionKey } from './BinaryGrid.js';

// FNV-1a constants for 64-bit hash
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/**
 * Compute FNV-1a 64-bit hash of a string
 * Must match the Rust fnv crate implementation exactly
 * @param {string} str - String to hash
 * @returns {bigint} 64-bit hash value
 */
export function fnv1aHash(str) {
  let hash = FNV_OFFSET_BASIS;
  
  for (let i = 0; i < str.length; i++) {
    const byte = BigInt(str.charCodeAt(i));
    hash ^= byte;
    hash = (hash * FNV_PRIME) & 0xFFFFFFFFFFFFFFFFn; // Keep as 64-bit
  }
  
  return hash;
}

/**
 * Build canonical state string from block name and properties
 * Format: "minecraft:block_name[prop1=val1,prop2=val2]"
 * @param {string} blockName - Block name (with or without minecraft: prefix)
 * @param {Object} properties - Block properties object
 * @returns {string} Canonical state string
 */
export function buildStateString(blockName, properties = {}) {
  const name = blockName.startsWith('minecraft:') ? blockName : `minecraft:${blockName}`;
  
  const keys = Object.keys(properties).sort();
  if (keys.length === 0) {
    return name;
  }
  
  const propsStr = keys.map(k => `${k}=${properties[k]}`).join(',');
  return `${name}[${propsStr}]`;
}

/**
 * BlockStateGrid class - sparse state storage
 * 
 * Stores both:
 * - sections: Uint16Array with legacy u16 state IDs (backward compatible)
 * - hashSections: BigUint64Array with FNV-1a hashes (for WASM)
 */
export class BlockStateGrid {
  constructor() {
    // sectionKey → Uint16Array(4096) for legacy u16 state IDs
    // This is the primary Map for backward compatibility
    this.sections = new Map();
    
    // sectionKey → BigUint64Array(4096) for FNV-1a hashes
    // Used for WASM model meshing
    this.hashSections = new Map();
    
    // Track which blocks need state lookup (for fast mesher path)
    this.hasStates = new Set(); // Set of sectionKeys
    
    // Statistics
    this.stateCount = 0;
  }

  /**
   * Set state hash for a block
   * @param {string} sectionKey - Section key from BinaryGrid
   * @param {number} index - Block index within section (0-4095)
   * @param {bigint} stateHash - FNV-1a hash of state string
   * @param {number} legacyStateId - Legacy u16 state ID for fallback
   */
  setStateHash(sectionKey, index, stateHash, legacyStateId = 0) {
    // Store legacy ID (for backward compatibility with existing code)
    let section = this.sections.get(sectionKey);
    if (!section) {
      section = new Uint16Array(4096); // Initialized to 0
      this.sections.set(sectionKey, section);
      this.hasStates.add(sectionKey);
    }
    
    const prevId = section[index];
    if (prevId === 0 && legacyStateId !== 0) {
      this.stateCount++;
    } else if (prevId !== 0 && legacyStateId === 0) {
      this.stateCount--;
    }
    
    section[index] = legacyStateId;
    
    // Store hash (for WASM model meshing)
    if (stateHash !== 0n) {
      let hashSection = this.hashSections.get(sectionKey);
      if (!hashSection) {
        hashSection = new BigUint64Array(4096);
        this.hashSections.set(sectionKey, hashSection);
      }
      hashSection[index] = stateHash;
    }
  }

  /**
   * Set state ID for a block (legacy API)
   * @param {string} sectionKey - Section key from BinaryGrid
   * @param {number} index - Block index within section (0-4095)
   * @param {number} stateId - State ID from StateRegistry
   * @param {string} stateString - Optional state string for hash computation
   */
  setState(sectionKey, index, stateId, stateString = null) {
    // Compute hash if state string provided
    const stateHash = stateString ? fnv1aHash(stateString) : 0n;
    this.setStateHash(sectionKey, index, stateHash, stateId);
  }

  /**
   * Get state hash for a block
   * @returns {bigint} State hash or 0n if not stored
   */
  getStateHash(sectionKey, index) {
    const section = this.hashSections.get(sectionKey);
    return section ? section[index] : 0n;
  }

  /**
   * Get legacy state ID for a block
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
   * Get all state data for a section (legacy u16 IDs)
   * @returns {Uint16Array|null}
   */
  getSection(sectionKey) {
    return this.sections.get(sectionKey) || null;
  }

  /**
   * Get all hash state data for a section
   * @returns {BigUint64Array|null}
   */
  getHashSection(sectionKey) {
    return this.hashSections.get(sectionKey) || null;
  }

  /**
   * Clear all data
   */
  clear() {
    this.sections.clear();
    this.hashSections.clear();
    this.hasStates.clear();
    this.stateCount = 0;
  }

  /**
   * Get memory usage estimate
   */
  getMemoryUsage() {
    return {
      sectionCount: this.sections.size,
      bytesUsed: this.sections.size * 4096 * 2 + this.hashSections.size * 4096 * 8, // u16 + u64
      stateCount: this.stateCount,
    };
  }

  /**
   * Export for worker transfer (includes both hashes and legacy IDs)
   */
  export() {
    const data = [];
    for (const [key, section] of this.sections) {
      const hashSection = this.hashSections.get(key);
      data.push({
        key,
        data: section.buffer.slice(0), // Uint16Array buffer (legacy format key)
        hashData: hashSection ? hashSection.buffer.slice(0) : null, // BigUint64Array buffer
      });
    }
    return { sections: data, stateCount: this.stateCount };
  }

  /**
   * Import from exported data
   */
  static import(data) {
    const grid = new BlockStateGrid();
    for (const { key, data: legacyData, hashData } of data.sections) {
      // Import legacy u16 data
      if (legacyData) {
        grid.sections.set(key, new Uint16Array(legacyData));
        grid.hasStates.add(key);
      }
      // Import hash data if available
      if (hashData) {
        grid.hashSections.set(key, new BigUint64Array(hashData));
      }
    }
    grid.stateCount = data.stateCount;
    return grid;
  }

  /**
   * Serialize for WASM consumption (u64 hashes)
   * Format: [num_sections: u32][section_key: u64, data: [u64; 4096]]...
   * @returns {Uint8Array}
   */
  serializeForWasm() {
    // First count non-empty sections
    const nonEmptySections = [];
    for (const [key, section] of this.hashSections) {
      let hasData = false;
      for (let i = 0; i < section.length; i++) {
        if (section[i] !== 0n) {
          hasData = true;
          break;
        }
      }
      if (hasData) {
        nonEmptySections.push({ key, section });
      }
    }
    
    if (nonEmptySections.length === 0) {
      // Empty marker - just 4 bytes of zeros
      return new Uint8Array(4);
    }
    
    // Calculate buffer size: 4 + (8 + 4096*8) * numSections
    const SECTION_DATA_SIZE = 4096 * 8; // 4096 * 8 bytes per u64
    const bufferSize = 4 + nonEmptySections.length * (8 + SECTION_DATA_SIZE);
    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);
    
    // Write number of sections
    view.setUint32(0, nonEmptySections.length, true); // little-endian
    
    let offset = 4;
    for (const { key, section } of nonEmptySections) {
      // Parse section key
      const parts = key.split(',');
      const chunkX = parseInt(parts[0], 10);
      const chunkZ = parseInt(parts[1], 10);
      const sectionY = parseInt(parts[2], 10);
      
      // Pack to u64 using same format as WASM
      const cx = BigInt(chunkX + 0x800000);
      const cz = BigInt(chunkZ + 0x800000);
      const sy = BigInt(sectionY & 0xFFFF);
      const packedKey = (cx << 40n) | (cz << 16n) | sy;
      
      // Write packed key as u64 (little-endian)
      view.setBigUint64(offset, packedKey, true);
      offset += 8;
      
      // Write section data (u64 array, little-endian)
      for (let i = 0; i < 4096; i++) {
        view.setBigUint64(offset, section[i], true);
        offset += 8;
      }
    }
    
    return new Uint8Array(buffer);
  }

  /**
   * Serialize legacy u16 IDs for main thread fallback
   * @returns {Array<{sectionKey: string, data: Uint16Array}>}
   */
  serialize() {
    const result = [];
    for (const [key, section] of this.sections) {
      result.push({
        sectionKey: key,
        data: section,
      });
    }
    return result;
  }
}

export default BlockStateGrid;

