/**
 * RandomRotationRegistry - Detects and manages blocks with random rotation variants
 * 
 * In Minecraft, some blocks have multiple rotation variants in their blockstate file
 * that are selected based on a position hash. This creates visual variety for blocks
 * like grass, dirt, stone, sand, etc.
 * 
 * This registry:
 * 1. Parses blockstate files to detect random rotation variants
 * 2. Provides fast lookup for which blocks use random rotation
 * 3. Supports texture pack overrides
 */

import { getBlockstateResolver } from './BlockstateResolver.js';

/**
 * Minecraft's position hash algorithm for random variant selection
 * Matches Java Edition's MathHelper.hashCode implementation
 * 
 * @param {number} x - World X coordinate
 * @param {number} y - World Y coordinate  
 * @param {number} z - World Z coordinate
 * @returns {number} Rotation value 0-3 (0°, 90°, 180°, 270°)
 */
export function getPositionRotation(x, y, z) {
  const ix = x | 0;
  const iy = y | 0;
  const iz = z | 0;
  
  // Match Java's int multiplication with overflow, then cast to long
  // JavaScript's Math.imul gives us 32-bit signed integer multiplication
  const xPart = BigInt(Math.imul(ix, 3129871));  // int multiply, then to long
  const zPart = BigInt(iz) * 116129781n;          // cast to long first, then multiply
  const yPart = BigInt(iy);
  
  let l = xPart ^ zPart ^ yPart;
  l = l * l * 42317861n + l * 11n;
  const seed = l >> 16n;
  
  // Java Random: seed = (seed ^ 0x5DEECE66DL) & ((1L << 48) - 1)
  // then nextInt advances and extracts bits
  const MULT = 0x5DEECE66Dn;
  const MASK = (1n << 48n) - 1n;
  
  let rng = (seed ^ MULT) & MASK;
  rng = (rng * MULT + 0xBn) & MASK;
  
  // next(31) = seed >>> 17, nextInt(4) = (4L * next31) >> 31
  const next31 = rng >> 17n;
  const result = (4n * next31) >> 31n;
  
  return Number(result & 3n);
}

/**
 * Blocks that should ONLY rotate on the TOP face.
 * These blocks have directional side textures (e.g., grass overlay on dirt)
 * that would look wrong if rotated.
 */
const TOP_ONLY_ROTATION_BLOCKS = new Set([
  'grass_block',
  'podzol',
  'mycelium',
  'crimson_nylium',
  'warped_nylium',
  'dirt_path',
  'farmland',
  'snow', // Snow layers have directional overlay
]);

/**
 * Default list of vanilla blocks known to have random Y-rotation variants
 * These blocks have blockstate files with arrays of 4 variants (0°, 90°, 180°, 270°)
 * 
 * This is used as a fallback when blockstates haven't been parsed yet,
 * and can be overridden by texture packs.
 * 
 * Blocks in TOP_ONLY_ROTATION_BLOCKS will only rotate on the top face,
 * all other blocks here will rotate on all faces.
 */
const DEFAULT_RANDOM_ROTATION_BLOCKS = new Set([
  // Top-only rotation blocks (included here for completeness, filtered by TOP_ONLY)
  'grass_block',
  'podzol',
  'mycelium',
  'crimson_nylium',
  'warped_nylium',
  'dirt_path',
  'farmland',
  
  // All-face rotation blocks (uniform textures)
  'dirt',
  'coarse_dirt',
  'rooted_dirt',
  
  // Stone variants
  'stone',
  'granite',
  'diorite',
  'andesite',
  'tuff',
  'deepslate',
  'calcite',
  'dripstone_block',
  
  // Sand and gravel
  'sand',
  'red_sand',
  'suspicious_sand',
  'suspicious_gravel',
  
  // Nether blocks
  'netherrack',
  'soul_sand',
  'soul_soil',
  'blackstone',
  
  // End blocks
  'end_stone',
  
  // Clay and mud
  'clay',
  'mud',
  'packed_mud',
  
  // Ore blocks (often have rotation variants)
  'coal_ore',
  'iron_ore',
  'gold_ore',
  'diamond_ore',
  'emerald_ore',
  'lapis_ore',
  'redstone_ore',
  'copper_ore',
  'deepslate_coal_ore',
  'deepslate_iron_ore',
  'deepslate_gold_ore',
  'deepslate_diamond_ore',
  'deepslate_emerald_ore',
  'deepslate_lapis_ore',
  'deepslate_redstone_ore',
  'deepslate_copper_ore',
  'nether_gold_ore',
  'nether_quartz_ore',
  'ancient_debris',
  
  // Miscellaneous
  'bedrock',
  'obsidian',
  'crying_obsidian',
  'gravel',
  'snow_block',
  'powder_snow',
  'moss_block',
  'pale_moss_block',
  'sculk',
]);

class RandomRotationRegistry {
  constructor() {
    // Set of block names (without minecraft:) that use random rotation
    this.randomRotationBlocks = new Set(DEFAULT_RANDOM_ROTATION_BLOCKS);
    
    // Blocks that only rotate on the top face (have directional side textures)
    this.topOnlyBlocks = new Set(TOP_ONLY_ROTATION_BLOCKS);
    
    // Blocks detected from parsing blockstate files
    this.detectedBlocks = new Set();
    
    // Custom overrides from texture packs
    this.packOverrides = new Set();
    
    // Whether we've scanned blockstates
    this.initialized = false;
  }

  /**
   * Check if a block uses position-based random rotation
   * @param {string} blockName - Block name (with or without minecraft: prefix)
   * @returns {boolean}
   */
  hasRandomRotation(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    return this.randomRotationBlocks.has(normalized) || 
           this.detectedBlocks.has(normalized) ||
           this.packOverrides.has(normalized);
  }

  /**
   * Check if a block should only rotate on the top face
   * These blocks have directional side textures (grass overlay, etc.)
   * @param {string} blockName - Block name (with or without minecraft: prefix)
   * @returns {boolean}
   */
  isTopOnlyRotation(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    return this.topOnlyBlocks.has(normalized);
  }

  /**
   * Add blocks from texture pack override
   * Texture packs can declare additional random rotation blocks
   * @param {string[]} blockNames - Array of block names
   */
  addPackOverrides(blockNames) {
    for (const name of blockNames) {
      this.packOverrides.add(name.replace('minecraft:', ''));
    }
    console.log(`[RandomRotationRegistry] Added ${blockNames.length} pack overrides`);
  }

  /**
   * Clear pack overrides (called when texture pack changes)
   */
  clearPackOverrides() {
    this.packOverrides.clear();
  }

  /**
   * Detect random rotation from a blockstate JSON
   * A block has random rotation if any variant key maps to an array of models
   * with different y rotations (0, 90, 180, 270)
   * 
   * @param {string} blockName - Block name
   * @param {Object} blockstateJson - Parsed blockstate JSON
   * @returns {boolean} Whether random rotation was detected
   */
  detectFromBlockstate(blockName, blockstateJson) {
    const normalized = blockName.replace('minecraft:', '');
    
    if (!blockstateJson || !blockstateJson.variants) {
      return false;
    }
    
    // Check each variant for rotation arrays
    for (const [key, variant] of Object.entries(blockstateJson.variants)) {
      // Random rotation is indicated by an array of variants
      if (!Array.isArray(variant) || variant.length < 2) {
        continue;
      }
      
      // Check if the variants have different y rotations
      const rotations = new Set();
      let hasModel = false;
      
      for (const v of variant) {
        if (v.model) {
          hasModel = true;
          // Extract y rotation (defaults to 0 if not specified)
          const yRot = v.y || 0;
          rotations.add(yRot);
        }
      }
      
      // If we have multiple y rotations from same model, it's random rotation
      // Common patterns: [0, 90, 180, 270] or [0, 180] with mirrored textures
      if (hasModel && rotations.size >= 2) {
        this.detectedBlocks.add(normalized);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Scan all loaded blockstates and detect random rotation
   * Called after blockstates are loaded
   */
  async scanBlockstates() {
    const resolver = getBlockstateResolver();
    
    // Scan the default blocks first
    let detected = 0;
    for (const blockName of DEFAULT_RANDOM_ROTATION_BLOCKS) {
      try {
        const json = await resolver.getBlockstate(blockName);
        if (json && this.detectFromBlockstate(blockName, json)) {
          detected++;
        }
      } catch (e) {
        // Block doesn't exist or error loading - continue
      }
    }
    
    this.initialized = true;
    console.log(`[RandomRotationRegistry] Detected ${detected} blocks with random rotation from blockstates`);
    console.log(`[RandomRotationRegistry] Total blocks with random rotation: ${this.getAllRotationBlocks().length}`);
  }

  /**
   * Get all block names that have random rotation
   * @returns {string[]}
   */
  getAllRotationBlocks() {
    const all = new Set([
      ...this.randomRotationBlocks,
      ...this.detectedBlocks,
      ...this.packOverrides,
    ]);
    return Array.from(all);
  }

  /**
   * Build a lookup array for fast per-blockId checks
   * @param {BlockRegistry} blockRegistry - Block registry with ID mappings
   * @returns {Uint8Array} Lookup array where 1 = has random rotation
   */
  buildLookupArray(blockRegistry) {
    const maxId = blockRegistry.idToInfo.length;
    const lookup = new Uint8Array(maxId);
    
    for (let id = 0; id < maxId; id++) {
      const info = blockRegistry.getBlockInfo(id);
      if (info && info.name && this.hasRandomRotation(info.name)) {
        lookup[id] = 1;
      }
    }
    
    return lookup;
  }

  /**
   * Build a lookup array for blocks that only rotate on the top face
   * @param {BlockRegistry} blockRegistry - Block registry with ID mappings
   * @returns {Uint8Array} Lookup array where 1 = top-only rotation
   */
  buildTopOnlyLookupArray(blockRegistry) {
    const maxId = blockRegistry.idToInfo.length;
    const lookup = new Uint8Array(maxId);
    
    for (let id = 0; id < maxId; id++) {
      const info = blockRegistry.getBlockInfo(id);
      if (info && info.name && this.isTopOnlyRotation(info.name)) {
        lookup[id] = 1;
      }
    }
    
    return lookup;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the random rotation registry singleton
 * @returns {RandomRotationRegistry}
 */
export function getRandomRotationRegistry() {
  if (!instance) {
    instance = new RandomRotationRegistry();
  }
  return instance;
}

export { RandomRotationRegistry };
export default RandomRotationRegistry;

