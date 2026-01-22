/**
 * WASM NBT Decoder - Dynamic Hybrid Solution
 * 
 * Provides a JavaScript bridge for the WASM-based NBT decoder with:
 * - FNV-1a hash-based O(1) block state lookups
 * - Fallback handling for unknown blocks
 * - Dynamic lookup table updates
 * 
 * The WASM module handles:
 * - Decompression (zlib/gzip via flate2)
 * - NBT parsing (via fastnbt)
 * - Chunk decoding with hash-based state resolution
 */

/**
 * FNV-1a hash function - must match WASM implementation exactly
 * @param {string} str - String to hash
 * @returns {bigint} - 64-bit hash value
 */
export function fnv1aHash(str) {
  const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return hash;
}

/**
 * Build state string from block name and properties
 * Matches Minecraft's block state string format
 * @param {string} name - Block name (e.g., "minecraft:oak_stairs")
 * @param {Object} properties - Block properties object
 * @returns {string} - State string (e.g., "minecraft:oak_stairs[facing=north,half=bottom]")
 */
export function buildStateString(name, properties) {
  if (!properties || Object.keys(properties).length === 0) {
    return name;
  }
  
  // Sort properties alphabetically for consistent hashing
  const sortedKeys = Object.keys(properties).sort();
  const propStr = sortedKeys
    .map(k => `${k}=${properties[k]}`)
    .join(',');
  
  return `${name}[${propStr}]`;
}

/**
 * WasmNBTDecoder - Manages the hash-based lookup table for WASM decoding
 */
export class WasmNBTDecoder {
  constructor() {
    this.wasmModule = null;
    this.blockRegistry = null;
    this.stateRegistry = null;
    this.lookupInitialized = false;
    
    // Cache of known state strings -> (blockId, stateId)
    this.stateCache = new Map();
    
    // Track unknown blocks for reporting
    this.unknownBlocks = new Set();
    
    // Pending updates to batch
    this.pendingUpdates = [];
    this.updatePending = false;
  }
  
  /**
   * Initialize with WASM module and registries
   * @param {Object} wasmModule - The initialized WASM module
   * @param {Object} blockRegistry - BlockRegistry instance
   * @param {Object} stateRegistry - ModelStateRegistry or similar
   */
  async initialize(wasmModule, blockRegistry, stateRegistry = null) {
    this.wasmModule = wasmModule;
    this.blockRegistry = blockRegistry;
    this.stateRegistry = stateRegistry;
    
    await this.buildLookupTable();
  }
  
  /**
   * Build and initialize the WASM hash lookup table
   */
  async buildLookupTable() {
    if (!this.wasmModule || !this.blockRegistry) {
      console.warn('[WasmNBTDecoder] Cannot build lookup - missing dependencies');
      return;
    }
    
    const startTime = performance.now();
    
    // Collect all block states with their hashes
    const stateHashes = [];
    const stateIds = [];
    const blockIds = [];
    
    // Get all block states from the registry
    const allStates = this.blockRegistry.getAllStates?.() || 
                      this.getAllBlockStates();
    
    for (const [stateString, blockId] of allStates) {
      const hash = fnv1aHash(stateString);
      
      stateHashes.push(hash);
      blockIds.push(blockId);
      
      // Get state ID for model blocks if state registry exists
      let stateId = 0;
      if (this.stateRegistry && this.blockRegistry.isNonCube?.(blockId)) {
        stateId = this.stateRegistry.getStateId?.(stateString) || 0;
      }
      stateIds.push(stateId);
      
      // Cache for JS-side fallback
      this.stateCache.set(stateString, { blockId, stateId });
    }
    
    // Convert BigInts to a format WASM can accept
    // WASM expects Vec<u64>, but wasm-bindgen needs special handling for u64
    // We'll pass as two arrays of u32 (high and low bits)
    const hashesLow = new Uint32Array(stateHashes.length);
    const hashesHigh = new Uint32Array(stateHashes.length);
    
    for (let i = 0; i < stateHashes.length; i++) {
      const hash = stateHashes[i];
      hashesLow[i] = Number(hash & 0xFFFFFFFFn);
      hashesHigh[i] = Number((hash >> 32n) & 0xFFFFFFFFn);
    }
    
    // Initialize WASM lookup
    try {
      // Check if WASM has the init function
      if (this.wasmModule.init_state_hash_lookup) {
        // Convert to full u64 array
        const hashesU64 = new BigUint64Array(stateHashes.length);
        for (let i = 0; i < stateHashes.length; i++) {
          hashesU64[i] = stateHashes[i];
        }
        
        this.wasmModule.init_state_hash_lookup(
          Array.from(hashesU64),
          new Uint16Array(stateIds),
          new Uint16Array(blockIds)
        );
        
        this.lookupInitialized = true;
        
        const elapsed = (performance.now() - startTime).toFixed(1);
        console.log(`[WasmNBTDecoder] Initialized hash lookup with ${stateHashes.length} states in ${elapsed}ms`);
      } else {
        console.warn('[WasmNBTDecoder] WASM module missing init_state_hash_lookup - hash lookup disabled');
      }
    } catch (e) {
      console.error('[WasmNBTDecoder] Failed to initialize WASM hash lookup:', e);
    }
  }
  
  /**
   * Get all block states from the block registry
   * @returns {Map<string, number>} - Map of state string -> block ID
   */
  getAllBlockStates() {
    const states = new Map();
    
    if (!this.blockRegistry) return states;
    
    // Try different methods to get all states
    if (this.blockRegistry.getAllStates) {
      return this.blockRegistry.getAllStates();
    }
    
    // Build states from block names + common property combinations
    // This is a fallback for registries that don't expose all states
    const blockNames = this.blockRegistry.getBlockNames?.() || [];
    
    for (const name of blockNames) {
      const blockId = this.blockRegistry.getBlockId(name);
      
      // Add base state (no properties)
      states.set(name, blockId);
      
      // For non-cube blocks, we'd need to enumerate property combinations
      // This is expensive, so we rely on the registry providing them
    }
    
    return states;
  }
  
  /**
   * Handle an unknown block state
   * Called when WASM encounters a hash it doesn't recognize
   * @param {string} stateString - The unknown state string
   * @returns {Object} - { blockId, stateId }
   */
  handleUnknownBlock(stateString) {
    // Check JS cache first
    if (this.stateCache.has(stateString)) {
      return this.stateCache.get(stateString);
    }
    
    // Extract block name from state string
    const bracketIdx = stateString.indexOf('[');
    const blockName = bracketIdx >= 0 ? stateString.slice(0, bracketIdx) : stateString;
    
    // Get block ID from registry
    let blockId = 0;
    if (this.blockRegistry) {
      blockId = this.blockRegistry.getBlockId?.(blockName) || 0;
    }
    
    // For unknown blocks, default to a placeholder
    if (blockId === 0 && !blockName.endsWith(':air') && !blockName.endsWith('_air')) {
      // Log unknown block for debugging
      if (!this.unknownBlocks.has(blockName)) {
        this.unknownBlocks.add(blockName);
        console.warn(`[WasmNBTDecoder] Unknown block: ${blockName}`);
      }
      
      // Default to stone as a visible placeholder
      blockId = this.blockRegistry?.getBlockId?.('minecraft:stone') || 1;
    }
    
    // Get state ID if applicable
    let stateId = 0;
    if (this.stateRegistry && this.blockRegistry?.isNonCube?.(blockId)) {
      stateId = this.stateRegistry.getStateId?.(stateString) || 0;
    }
    
    // Cache the result
    const result = { blockId, stateId };
    this.stateCache.set(stateString, result);
    
    // Queue update for WASM (if we could update dynamically)
    this.pendingUpdates.push({ stateString, blockId, stateId });
    
    return result;
  }
  
  /**
   * Compute hash for a state string
   * @param {string} stateString - Block state string
   * @returns {bigint} - FNV-1a hash
   */
  computeHash(stateString) {
    return fnv1aHash(stateString);
  }
  
  /**
   * Check if the WASM hash lookup is initialized
   * @returns {boolean}
   */
  isLookupInitialized() {
    return this.lookupInitialized;
  }
  
  /**
   * Get statistics about the decoder
   * @returns {Object}
   */
  getStats() {
    return {
      lookupInitialized: this.lookupInitialized,
      cachedStates: this.stateCache.size,
      unknownBlocks: this.unknownBlocks.size,
      pendingUpdates: this.pendingUpdates.length,
    };
  }
}

// Singleton instance
let decoderInstance = null;

/**
 * Get the singleton WasmNBTDecoder instance
 * @returns {WasmNBTDecoder}
 */
export function getWasmNBTDecoder() {
  if (!decoderInstance) {
    decoderInstance = new WasmNBTDecoder();
  }
  return decoderInstance;
}

export default WasmNBTDecoder;
