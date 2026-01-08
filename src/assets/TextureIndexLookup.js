/**
 * TextureIndexLookup - Maps block IDs to texture atlas indices
 * 
 * Provides fast lookup from (blockId, faceDirection) to atlas texture index.
 * The index is used by the shader to calculate UV coordinates in the atlas.
 * 
 * Face directions:
 * - 'up' / 'down' - Y-axis faces
 * - 'north' / 'south' - Z-axis faces  
 * - 'east' / 'west' - X-axis faces
 * 
 * Texture Resolution Strategy:
 * 1. Try ModelTextureMapper (data-driven from model JSON files)
 * 2. Fall back to BlockTextureRegistry (hardcoded mappings for edge cases)
 */

import { getBlockTexture } from './BlockTextureRegistry.js';
import { getModelTextureMapper } from './ModelTextureMapper.js';

// Face direction constants for array indexing
export const FACE_UP = 0;
export const FACE_DOWN = 1;
export const FACE_NORTH = 2;
export const FACE_SOUTH = 3;
export const FACE_EAST = 4;
export const FACE_WEST = 5;

// Face name to index mapping
const FACE_NAME_TO_INDEX = {
  'up': FACE_UP,
  'down': FACE_DOWN,
  'north': FACE_NORTH,
  'south': FACE_SOUTH,
  'east': FACE_EAST,
  'west': FACE_WEST,
};

/**
 * TextureIndexLookup class
 */
export class TextureIndexLookup {
  /**
   * @param {number} tilesPerRow - Number of tiles per row in the atlas
   * @param {number} tilesPerCol - Number of tiles per column in the atlas
   */
  constructor(tilesPerRow, tilesPerCol) {
    this.tilesPerRow = tilesPerRow;
    this.tilesPerCol = tilesPerCol;
    this.totalTiles = tilesPerRow * tilesPerCol;
    
    // Fast lookup array: indices[blockId * 6 + faceIndex] = textureIndex
    // Pre-allocate for up to 4096 block IDs (Minecraft limit)
    this.indices = new Float32Array(4096 * 6);
    
    // Default all to 0 (first texture in atlas as fallback)
    this.indices.fill(0);
    
    // Track which block IDs have been set
    this.registeredBlocks = new Set();
    
    // Texture path to atlas index mapping (set by TextureAtlas)
    this.texturePathToIndex = new Map();
    
    // Default texture index for missing textures
    this.defaultIndex = 0;
    
    // Track blocks with missing textures (log once per unique block type)
    this.missingTextureBlocks = new Set();
  }
  
  /**
   * Set the texture path to atlas index mapping
   * Called by TextureAtlas after building the atlas
   * @param {Map<string, number>} pathToIndex - Map of texture paths to atlas indices
   */
  setTexturePathMapping(pathToIndex) {
    this.texturePathToIndex = pathToIndex;
  }
  
  /**
   * Set the default texture index for missing textures
   * @param {number} index - Atlas index to use as fallback
   */
  setDefaultIndex(index) {
    this.defaultIndex = index;
    // Update all unregistered blocks to use this default
    for (let blockId = 0; blockId < 4096; blockId++) {
      if (!this.registeredBlocks.has(blockId)) {
        for (let face = 0; face < 6; face++) {
          this.indices[blockId * 6 + face] = index;
        }
      }
    }
  }
  
  /**
   * Register a block's textures
   * 
   * Uses a two-tier resolution strategy:
   * 1. ModelTextureMapper - data-driven from model JSON (preferred)
   * 2. BlockTextureRegistry - hardcoded fallback for edge cases
   * 
   * @param {number} blockId - The numeric block ID
   * @param {string} blockName - The block name (e.g., "stone" or "minecraft:stone")
   * @param {boolean} debug - Whether to log debug info for this block
   */
  registerBlock(blockId, blockName, debug = false) {
    if (blockId < 0 || blockId >= 4096) return;
    
    const baseIdx = blockId * 6;
    const name = blockName.replace('minecraft:', '');
    
    // Get texture for each face
    const faces = ['up', 'down', 'north', 'south', 'east', 'west'];
    
    let foundAny = false;
    let missingFaces = [];
    let usedModelMapper = false;
    const debugInfo = debug ? { blockId, blockName: name, faces: {}, source: 'unknown' } : null;
    
    // Try ModelTextureMapper first (data-driven from model JSON)
    const modelTextureMapper = getModelTextureMapper();
    let modelFaceTextures = null;
    
    if (modelTextureMapper.initialized) {
      modelFaceTextures = modelTextureMapper.getBlockFaceTextures(name);
      if (modelFaceTextures) {
        usedModelMapper = true;
        if (debug) {
          debugInfo.source = 'model';
        }
      }
    }
    
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      let texturePath;
      
      // Try model-based texture first
      if (modelFaceTextures && modelFaceTextures[face]) {
        texturePath = modelFaceTextures[face];
      } else {
        // Fall back to BlockTextureRegistry (hardcoded mappings)
        texturePath = getBlockTexture(name, face);
        if (debug && !usedModelMapper) {
          debugInfo.source = 'registry';
        }
      }
      
      // Try multiple path formats to find the texture in the atlas
      const pathsToTry = [
        texturePath,                              // e.g., 'block/stone'
        texturePath.startsWith('block/') ? texturePath.substring(6) : null, // e.g., 'stone'
        `textures/${texturePath}.png`,            // e.g., 'textures/block/stone.png'
        `textures/${texturePath}`,                // e.g., 'textures/block/stone'
      ].filter(Boolean);
      
      let atlasIndex = undefined;
      let matchedPath = null;
      
      for (const path of pathsToTry) {
        atlasIndex = this.texturePathToIndex.get(path);
        if (atlasIndex !== undefined) {
          matchedPath = path;
          foundAny = true;
          break;
        }
      }
      
      // Use default if not found
      if (atlasIndex === undefined) {
        atlasIndex = this.defaultIndex;
        missingFaces.push({ face, requestedPath: texturePath });
      }
      
      if (debug) {
        debugInfo.faces[face] = {
          requestedPath: texturePath,
          triedPaths: pathsToTry,
          matchedPath,
          atlasIndex,
          usedDefault: matchedPath === null,
          fromModel: usedModelMapper && modelFaceTextures && modelFaceTextures[face],
        };
      }
      
      this.indices[baseIdx + i] = atlasIndex;
    }
    
    if (debug) {
      console.log(`[TextureIndexLookup] Block ${name} (id=${blockId}):`, debugInfo);
    }
    
    // Log missing textures (once per unique block type)
    // Skip invisible/non-rendered blocks that intentionally don't have textures
    const INVISIBLE_BLOCKS = new Set([
      'air', 'cave_air', 'void_air', 'light', 'barrier', 'structure_void',
      'moving_piston', 'bubble_column', 'fire', 'soul_fire', 'water', 'lava',
      'end_gateway', 'end_portal', 'nether_portal', 'tripwire'
    ]);
    
    if (!foundAny && !this.missingTextureBlocks.has(name) && !INVISIBLE_BLOCKS.has(name)) {
      this.missingTextureBlocks.add(name);
      const triedPaths = missingFaces.length > 0 ? missingFaces[0].requestedPath : 'unknown';
      console.warn(`[TextureIndexLookup] Missing texture for block '${name}' - tried path: '${triedPaths}' (using fallback)`);
    }
    
    this.registeredBlocks.add(blockId);
    return foundAny;
  }
  
  /**
   * Get texture index for a block face (fast path for mesher)
   * @param {number} blockId - The numeric block ID
   * @param {number} faceIndex - Face index (0-5, use FACE_* constants)
   * @returns {number} - Atlas texture index
   */
  getIndex(blockId, faceIndex) {
    if (blockId < 0 || blockId >= 4096 || faceIndex < 0 || faceIndex > 5) {
      return this.defaultIndex;
    }
    return this.indices[blockId * 6 + faceIndex];
  }
  
  /**
   * Get texture index by face name (convenience method)
   * @param {number} blockId - The numeric block ID
   * @param {string} faceName - Face name ('up', 'down', 'north', 'south', 'east', 'west')
   * @returns {number} - Atlas texture index
   */
  get(blockId, faceName) {
    const faceIndex = FACE_NAME_TO_INDEX[faceName];
    if (faceIndex === undefined) return this.defaultIndex;
    return this.getIndex(blockId, faceIndex);
  }
  
  /**
   * Get texture index by texture path (for model-based rendering)
   * @param {string} texturePath - Texture path like "block/sunflower_top"
   * @returns {number} - Atlas texture index, or defaultIndex if not found
   */
  getIndexByPath(texturePath) {
    if (!texturePath) return this.defaultIndex;
    
    // Normalize path
    const normalized = texturePath.replace('minecraft:', '');
    
    // Try multiple path formats
    const pathsToTry = [
      normalized,                              // e.g., 'block/sunflower_top'
      normalized.startsWith('block/') ? normalized.substring(6) : null, // e.g., 'sunflower_top'
      `textures/${normalized}.png`,            // e.g., 'textures/block/sunflower_top.png'
      `textures/${normalized}`,                // e.g., 'textures/block/sunflower_top'
    ].filter(Boolean);
    
    for (const path of pathsToTry) {
      const idx = this.texturePathToIndex.get(path);
      if (idx !== undefined) {
        return idx;
      }
    }
    
    // Log missing texture path (once per unique path)
    if (!this.missingTextureBlocks.has(normalized)) {
      this.missingTextureBlocks.add(normalized);
      console.warn(`[TextureIndexLookup] Missing texture path '${normalized}' (using fallback)`);
    }
    
    return this.defaultIndex;
  }
  
  /**
   * Get the raw indices array (for passing to workers)
   * @returns {Float32Array}
   */
  getIndicesArray() {
    return this.indices;
  }
  
  /**
   * Get atlas dimensions info
   * @returns {Object} { tilesPerRow, tilesPerCol, totalTiles }
   */
  getAtlasInfo() {
    return {
      tilesPerRow: this.tilesPerRow,
      tilesPerCol: this.tilesPerCol,
      totalTiles: this.totalTiles,
    };
  }
  
  /**
   * Check if a block has been registered
   * @param {number} blockId 
   * @returns {boolean}
   */
  isRegistered(blockId) {
    return this.registeredBlocks.has(blockId);
  }
  
  /**
   * Get statistics about the lookup
   * @returns {Object}
   */
  getStats() {
    return {
      registeredBlocks: this.registeredBlocks.size,
      totalCapacity: 4096,
      tilesPerRow: this.tilesPerRow,
      tilesPerCol: this.tilesPerCol,
    };
  }
  
  /**
   * Debug: Log info about the texture path mapping
   */
  debugPathMapping() {
    const paths = Array.from(this.texturePathToIndex.keys());
    console.log(`[TextureIndexLookup] texturePathToIndex has ${paths.length} entries`);
    console.log(`[TextureIndexLookup] Sample paths:`, paths.slice(0, 20));
    
    // Check for common block textures
    const testBlocks = ['stone', 'dirt', 'grass_block_top', 'oak_planks', 'cobblestone'];
    for (const block of testBlocks) {
      const variants = [
        `block/${block}`,
        block,
        `textures/block/${block}.png`,
        `textures/block/${block}`,
      ];
      console.log(`[TextureIndexLookup] Looking for '${block}':`);
      for (const v of variants) {
        const idx = this.texturePathToIndex.get(v);
        if (idx !== undefined) {
          console.log(`  ✓ Found at '${v}' -> index ${idx}`);
        }
      }
    }
  }
}

export default TextureIndexLookup;

