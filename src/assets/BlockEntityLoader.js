/**
 * Block Entity Loader
 * 
 * Loads and manages block entity models for rendering chests, beds, signs,
 * skulls, banners, shulker boxes, and other block entities.
 * 
 * This module handles:
 * - Loading the block entity model binary file
 * - Loading the block entity manifest (block -> model mapping)
 * - Initializing the WASM block entity registry
 * - Providing variant resolution based on block state and NBT data
 */

// Cached data
let blockEntityManifest = null;
let blockEntityModels = null;
let isInitialized = false;

// Model name to index mapping (matches WASM registry order)
let modelNameToIndex = new Map();

/**
 * Load the block entity manifest (block name -> model configuration)
 */
export async function loadBlockEntityManifest() {
  if (blockEntityManifest) return blockEntityManifest;
  
  try {
    const response = await fetch('/assets/block-entity-manifest.json');
    if (!response.ok) {
      throw new Error(`Failed to load manifest: ${response.status}`);
    }
    blockEntityManifest = await response.json();
    console.log(`[BlockEntityLoader] Loaded manifest with ${Object.keys(blockEntityManifest.block_entities).length} block types`);
    return blockEntityManifest;
  } catch (error) {
    console.error('[BlockEntityLoader] Failed to load manifest:', error);
    throw error;
  }
}

/**
 * Load the block entity models JSON (for JavaScript-side access)
 */
export async function loadBlockEntityModels() {
  if (blockEntityModels) return blockEntityModels;
  
  try {
    const response = await fetch('/assets/baked-block-entities.json');
    if (!response.ok) {
      throw new Error(`Failed to load models: ${response.status}`);
    }
    blockEntityModels = await response.json();
    
    // Build name to index mapping
    let index = 0;
    for (const modelName of Object.keys(blockEntityModels.models)) {
      modelNameToIndex.set(modelName, index++);
    }
    
    console.log(`[BlockEntityLoader] Loaded ${Object.keys(blockEntityModels.models).length} models`);
    return blockEntityModels;
  } catch (error) {
    console.error('[BlockEntityLoader] Failed to load models:', error);
    throw error;
  }
}

// WASM module reference (set externally)
let wasmModule = null;

/**
 * Set the WASM module reference
 * @param {Object} wasm - WASM module from WasmMesher
 */
export function setWasmModule(wasm) {
  wasmModule = wasm;
}

/**
 * Initialize the WASM block entity registry
 * @param {Object} wasm - Optional WASM module (uses cached if not provided)
 */
export async function initBlockEntityRegistry(wasm = null) {
  if (isInitialized) return true;
  
  if (wasm) {
    wasmModule = wasm;
  }
  
  try {
    // Load the binary file
    const response = await fetch('/assets/baked-block-entities.bin');
    if (!response.ok) {
      throw new Error(`Failed to load binary: ${response.status}`);
    }
    const data = await response.arrayBuffer();
    
    // Initialize the WASM registry if module is available
    if (wasmModule && wasmModule.init_block_entity_registry) {
      const success = wasmModule.init_block_entity_registry(new Uint8Array(data));
      if (!success) {
        console.warn('[BlockEntityLoader] WASM init_block_entity_registry returned false');
      } else {
        console.log('[BlockEntityLoader] WASM registry initialized');
      }
    } else {
      console.log('[BlockEntityLoader] WASM module not available, running in JS-only mode');
    }
    
    isInitialized = true;
    return true;
  } catch (error) {
    console.error('[BlockEntityLoader] Failed to init block entity registry:', error);
    throw error;
  }
}

/**
 * Initialize all block entity assets
 */
export async function initBlockEntities() {
  await Promise.all([
    loadBlockEntityManifest(),
    loadBlockEntityModels(),
    initBlockEntityRegistry(),
  ]);
  
  return {
    manifest: blockEntityManifest,
    models: blockEntityModels,
  };
}

/**
 * Get block entity configuration for a block name
 * @param {string} blockName - Block name without 'minecraft:' prefix
 * @returns {Object|null} Block entity configuration or null
 */
export function getBlockEntityConfig(blockName) {
  if (!blockEntityManifest) return null;
  return blockEntityManifest.block_entities[blockName] || null;
}

/**
 * Check if a block has an entity model
 * @param {string} blockName - Block name without 'minecraft:' prefix
 * @returns {boolean} True if block has entity model
 */
export function isBlockEntity(blockName) {
  if (!blockEntityManifest) return false;
  return blockName in blockEntityManifest.block_entities;
}

/**
 * Get model index for a model name
 * @param {string} modelName - Model name (e.g., 'chest_single', 'bed_head')
 * @returns {number} Model index or -1 if not found
 */
export function getModelIndex(modelName) {
  return modelNameToIndex.get(modelName) ?? -1;
}

/**
 * Resolve which model variant to use based on block state and NBT
 * @param {string} blockName - Block name
 * @param {Object} blockState - Block state properties (e.g., {facing: 'north', part: 'head'})
 * @param {Object} nbt - Block entity NBT data
 * @returns {Object} Resolution result with modelIndex, variant, rotation, color
 */
export function resolveBlockEntityVariant(blockName, blockState = {}, nbt = {}) {
  const config = getBlockEntityConfig(blockName);
  if (!config) {
    return null;
  }
  
  const result = {
    modelIndex: -1,
    modelName: null,
    variantIndex: 0,
    rotation: 0,
    color: 0,
    textureVariant: 'default',
    flags: 0,
  };
  
  // Determine which model variant to use
  const models = config.models;
  let modelKey = 'default';
  
  if (config.variant_from) {
    // Variant is determined by block state or NBT
    const [source, field] = config.variant_from.split(':');
    
    if (source === 'block_state' && blockState[field]) {
      modelKey = blockState[field]; // e.g., 'head' or 'foot' for beds
    } else if (source === 'nbt' && nbt[field]) {
      modelKey = nbt[field]; // e.g., 'single', 'left', 'right' for chests
    }
  }
  
  // Find the model
  const modelName = models[modelKey] || models['default'] || Object.values(models)[0];
  if (modelName) {
    result.modelName = modelName;
    result.modelIndex = getModelIndex(modelName);
  }
  
  // Determine rotation
  if (config.rotation_source === 'facing') {
    // Convert facing to rotation index
    const facing = blockState.facing || 'north';
    result.rotation = FACING_TO_ROTATION[facing] || 0;
  } else if (config.rotation_source === 'rotation') {
    // Use rotation property directly (0-15)
    result.rotation = parseInt(blockState.rotation || '0', 10);
    
    // Mark as fine rotation if > 3
    if (result.rotation > 3) {
      result.flags |= 0x01; // has16Rotations flag
    }
  }
  
  // Determine color (for beds, banners, shulker boxes)
  if (config.texture_variants) {
    // Try to find color from block name
    const colorMatch = blockName.match(/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/);
    if (colorMatch) {
      result.color = COLOR_TO_INDEX[colorMatch[1]] || 0;
      result.textureVariant = colorMatch[1];
    }
  }
  
  return result;
}

/**
 * Pack entity state for WASM
 * @param {number} entityType - Entity type index (0-255)
 * @param {number} variant - Variant index (0-255)
 * @param {number} rotation - Rotation (0-15)
 * @param {number} color - Color index (0-15)
 * @param {number} flags - Flags (0-255)
 * @returns {number} Packed 32-bit entity state
 */
export function packEntityState(entityType, variant, rotation, color, flags) {
  return (
    (entityType & 0xFF) |
    ((variant & 0xFF) << 8) |
    ((rotation & 0x0F) << 16) |
    ((color & 0x0F) << 20) |
    ((flags & 0xFF) << 24)
  );
}

// Direction to rotation mapping (for facing property)
const FACING_TO_ROTATION = {
  'north': 0,
  'east': 1,
  'south': 2,
  'west': 3,
  'up': 1,    // Rarely used
  'down': 0,  // Rarely used
};

// Color name to index mapping
const COLOR_TO_INDEX = {
  'white': 0,
  'orange': 1,
  'magenta': 2,
  'light_blue': 3,
  'yellow': 4,
  'lime': 5,
  'pink': 6,
  'gray': 7,
  'light_gray': 8,
  'cyan': 9,
  'purple': 10,
  'blue': 11,
  'brown': 12,
  'green': 13,
  'red': 14,
  'black': 15,
};

/**
 * Get list of all block entity block names
 * @returns {string[]} Array of block names that have entity models
 */
export function getBlockEntityNames() {
  if (!blockEntityManifest) return [];
  return Object.keys(blockEntityManifest.block_entities);
}

/**
 * Get model geometry for JavaScript-side rendering
 * @param {string} modelName - Model name
 * @returns {Object|null} Model data or null
 */
export function getModelGeometry(modelName) {
  if (!blockEntityModels) return null;
  return blockEntityModels.models[modelName] || null;
}

/**
 * Check if block entity system is ready
 * @returns {boolean} True if initialized
 */
export function isBlockEntitySystemReady() {
  return isInitialized && blockEntityManifest !== null;
}
