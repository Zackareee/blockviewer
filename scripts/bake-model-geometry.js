#!/usr/bin/env node
/**
 * Geometry Baking Script
 * 
 * Pre-computes model geometry for all block variants and outputs a binary file.
 * This runs in Node.js and simulates what the browser would do.
 * 
 * Output: public/assets/baked-models.bin
 * 
 * Binary Format:
 * [header]
 *   u32: magic (0x424B4D44 = "BKMD")
 *   u32: version
 *   u32: block count
 * 
 * [block index] (for each block)
 *   u16: block name length
 *   bytes: block name (UTF-8)
 *   u32: offset to block data from start of data section
 * 
 * [block data] (for each block)
 *   u8: variant count
 *   u8: flags bitfield:
 *       0x01 = hasRandomRotation
 *       0x02 = hasPositionOffset
 *       0x04 = isTransparent
 *       0x08 = noShade
 *       0x10 = hasInnerCube
 *       0x20 = hasAxisRotation
 *   [variant] (for each variant)
 *     u8: variant key length
 *     bytes: variant key (UTF-8)
 *     u16: face count
 *     [face] (for each face)
 *       u8: direction (0=down, 1=up, 2=north, 3=south, 4=west, 5=east, 6=none)
 *       u8: cullface (same encoding, 0xFF = no cull)
 *       u8: tint type (0=none, 1=grass, 2=foliage, 3=water)
 *       u16: texture index
 *       f32[12]: vertices (4 vertices × 3 components)
 *       f32[8]: uvs (4 vertices × 2 components)
 *       f32[3]: normal
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_PATH = path.join(__dirname, '../minecraft_versions/1.21.11_unobfuscated/assets/minecraft');
const MODELS_PATH = path.join(ASSETS_PATH, 'models/block');
const BLOCKSTATES_PATH = path.join(ASSETS_PATH, 'blockstates');
const MANIFEST_PATH = path.join(__dirname, '../public/assets/block-model-manifest.json');
const OUTPUT_PATH = path.join(__dirname, '../public/assets/baked-models.bin');

// Face directions
const DIRECTION = {
  down: 0, up: 1, north: 2, south: 3, west: 4, east: 5, none: 6
};

// Face normals
const FACE_NORMALS = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

// Face vertices - MUST match ModelGeometry.js for consistent winding order
// Vertices are ordered for CCW winding when viewed from OUTSIDE the block
// Starting from top-left when looking at the face from outside
const FACE_VERTICES = {
  down:  [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]], // -Y
  up:    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], // +Y
  north: [[1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0]], // -Z (starts top-right, goes CCW)
  south: [[0, 1, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1]], // +Z (starts top-left, goes CCW)
  west:  [[0, 1, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0]], // -X
  east:  [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 1]], // +X
};

// Tint type constants
// Must match TINT_TYPE values in src/data/biomeTinting.js:
// NONE=0, GRASS=1, FOLIAGE=2, SPRUCE=3, BIRCH=4, WATER=5, REDSTONE=6, DRY_FOLIAGE=7, STEM=8
const TINT_TYPE = {
  NONE: 0,
  GRASS: 1,
  FOLIAGE: 2,
  SPRUCE: 3,
  BIRCH: 4,
  WATER: 5,
  REDSTONE: 6,
  DRY_FOLIAGE: 7,
  STEM: 8,
};

/**
 * Infer tint type from block name when a face has tintindex defined.
 * 
 * The model's tintindex field tells us "this face needs biome tinting",
 * but it doesn't specify WHICH type of tinting. We infer the type from
 * the block name using Minecraft's known patterns.
 * 
 * @param {string} blockName - The block name (e.g., "oak_leaves", "grass_block")
 * @param {number} tintindex - The tintindex value from the model (usually 0)
 * @returns {number} The tint type constant
 */
function inferTintType(blockName, tintindex) {
  // If no tintindex, no tinting needed
  if (tintindex === undefined || tintindex === null) {
    return TINT_TYPE.NONE;
  }
  
  const name = blockName.toLowerCase();
  
  // Blocks with tintindex that DON'T actually use biome tinting
  // These use tintindex for other purposes (e.g., hardcoded colors in renderer)
  const noTintBlocks = ['stonecutter', 'cauldron', 'lava_cauldron', 'water_cauldron', 'powder_snow_cauldron'];
  if (noTintBlocks.includes(name)) return TINT_TYPE.NONE;
  
  // Fixed-color leaves (don't use colormap)
  if (name.includes('spruce_leaves')) return TINT_TYPE.SPRUCE;
  if (name.includes('birch_leaves')) return TINT_TYPE.BIRCH;
  
  // Dry foliage (pale garden biome) - check before regular foliage
  if (name.includes('pale_oak_leaves')) return TINT_TYPE.DRY_FOLIAGE;
  if (name.includes('pale_moss') || name.includes('pale_hanging_moss')) return TINT_TYPE.DRY_FOLIAGE;
  if (name.includes('dry_grass')) return TINT_TYPE.DRY_FOLIAGE;
  if (name === 'leaf_litter') return TINT_TYPE.DRY_FOLIAGE;
  
  // Stems (pumpkin/melon) - growth-based coloring
  if (name.includes('_stem') && (name.includes('pumpkin') || name.includes('melon'))) {
    return TINT_TYPE.STEM;
  }
  
  // Water tinting
  if (name.includes('water')) return TINT_TYPE.WATER;
  
  // Grass colormap blocks
  if (name.includes('grass')) return TINT_TYPE.GRASS;
  if (name === 'sugar_cane') return TINT_TYPE.GRASS;
  if (name === 'bush') return TINT_TYPE.GRASS;
  if (name === 'bamboo' || name.includes('bamboo_stage') || name === 'bamboo_sapling') return TINT_TYPE.GRASS;
  if (name === 'wildflowers') return TINT_TYPE.GRASS;
  
  // Foliage colormap blocks (leaves, vines, ferns, etc.)
  if (name.includes('leaves')) return TINT_TYPE.FOLIAGE;
  if (name === 'vine') return TINT_TYPE.FOLIAGE;
  if (name.includes('fern')) return TINT_TYPE.FOLIAGE;
  if (name === 'lily_pad') return TINT_TYPE.FOLIAGE;
  if (name.includes('seagrass')) return TINT_TYPE.FOLIAGE;
  if (name === 'pink_petals') return TINT_TYPE.FOLIAGE;
  if (name === 'mangrove_roots') return TINT_TYPE.FOLIAGE;
  
  // Redstone tinting (power-based)
  if (name === 'redstone_wire') return TINT_TYPE.REDSTONE;
  
  // Default: if we have a tintindex but don't recognize the block,
  // assume foliage tinting as a safe fallback
  console.warn(`[TintType] Unknown tinted block: ${blockName}, defaulting to FOLIAGE`);
  return TINT_TYPE.FOLIAGE;
}

// ============================================================================
// FLAG DETECTION FROM MODEL/BLOCKSTATE STRUCTURE
// These functions replace hardcoded lists by analyzing the actual data.
// ============================================================================

/**
 * Detect if a model uses cross-pattern (non-cullface faces on all sides).
 * Cross-pattern blocks are typically plants, flowers, and saplings.
 * They have faces without cullface, meaning they don't occlude neighbors.
 * 
 * @param {Object} model - Resolved model with elements
 * @returns {boolean} True if model uses cross pattern
 */
function hasCrossPattern(model) {
  if (!model || !model.elements) return false;
  
  let hasNonCullfaceFaces = false;
  let hasCullfaceFaces = false;
  
  for (const element of model.elements) {
    if (!element.faces) continue;
    
    for (const faceData of Object.values(element.faces)) {
      if (faceData.cullface) {
        hasCullfaceFaces = true;
      } else {
        hasNonCullfaceFaces = true;
      }
    }
  }
  
  // Pure cross pattern: all faces are non-cullface
  return hasNonCullfaceFaces && !hasCullfaceFaces;
}

/**
 * Detect if model has any element with shade: false.
 * This is typically used for cross-pattern plants and emissive blocks.
 * 
 * @param {Object} model - Resolved model with elements
 * @returns {boolean} True if any element has shade: false
 */
function hasNoShadeElement(model) {
  if (!model || !model.elements) return false;
  
  for (const element of model.elements) {
    if (element.shade === false) {
      return true;
    }
  }
  return false;
}

/**
 * Detect if block has an inner cube (transparent outer shell with opaque inner cube).
 * Only specific blocks have this pattern - slime_block and honey_block.
 * 
 * @param {string} blockName - Block name to check
 * @returns {boolean} True if block has inner cube pattern
 */
function hasInnerCubePattern(blockName) {
  const INNER_CUBE_BLOCKS = ['slime_block', 'honey_block'];
  return INNER_CUBE_BLOCKS.includes(blockName);
}

/**
 * Blocks that receive random Y-rotation at render time.
 * This is an engine behavior applied to specific blocks, not a model property.
 */
const RANDOM_ROTATION_BLOCKS = new Set([
  // Cross-model plants
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  'nether_sprouts', 'crimson_roots', 'warped_roots',
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower', 'pink_petals', 'eyeblossom', 'dead_bush',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'pale_oak_sapling', 'hanging_roots', 'spore_blossom',
  'red_mushroom', 'brown_mushroom', 'crimson_fungus', 'warped_fungus',
  // 3D models with rotation variants
  'sea_pickle',
  // Path blocks - have 4 rotation variants that would cause z-fighting if all rendered
  'dirt_path', 'farmland',
]);

/**
 * Check if a block should have random rotation applied at render time.
 * 
 * @param {string} blockName - Block name to check
 * @returns {boolean} True if block uses random rotation
 */
function hasRandomRotation(blockName) {
  return RANDOM_ROTATION_BLOCKS.has(blockName);
}

/**
 * Detect if blockstate has axis property (x/y/z) indicating axis-rotatable block.
 * Used for logs, pillars, etc.
 * 
 * @param {Object} blockstateVariants - The variants object from blockstate JSON
 * @returns {boolean} True if block has axis variants
 */
function hasAxisVariants(blockstateVariants) {
  if (!blockstateVariants) return false;
  
  for (const variantKey of Object.keys(blockstateVariants)) {
    if (variantKey.includes('axis=')) {
      return true;
    }
  }
  return false;
}

/**
 * Detect if block is transparent based on block name patterns.
 * Transparency is an engine behavior, not a model property.
 * 
 * @param {Object} model - Resolved model with elements
 * @param {string} blockName - Block name for pattern matching
 * @returns {boolean} True if block should be rendered as transparent
 */
function isTransparentModel(model, blockName) {
  // Cross patterns are transparent
  if (hasCrossPattern(model)) return true;
  
  // Exclude packed_ice and blue_ice (they're opaque despite having 'ice' in name)
  if (blockName.includes('packed_ice') || blockName.includes('blue_ice')) {
    return false;
  }
  
  // Check for transparent block patterns
  const transparentPatterns = [
    'glass', 'ice', 'leaves', 'slime_block', 'honey_block',
    '_pane', '_bars', 'water', 'lava', 'barrier', 'light'
  ];
  
  return transparentPatterns.some(p => blockName.includes(p));
}

/**
 * Blocks that receive position-based XZ offset at render time.
 * These are small plants that sway/offset based on world position.
 */
const POSITION_OFFSET_BLOCKS = new Set([
  'short_grass', 'fern',
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower',
  'nether_sprouts', 'crimson_roots', 'warped_roots',
  'hanging_roots',
  'red_mushroom', 'brown_mushroom', 'crimson_fungus', 'warped_fungus',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
]);

/**
 * Detect if block should have position-based XZ offset.
 * 
 * @param {Object} model - Resolved model with elements (unused, kept for API compatibility)
 * @param {string} blockName - Block name
 * @returns {boolean} True if block needs position offset
 */
function needsPositionOffset(model, blockName) {
  return POSITION_OFFSET_BLOCKS.has(blockName);
}

/**
 * Extract all flags for a block by analyzing its model and blockstate.
 * 
 * @param {string} blockName - The block name
 * @param {Object} model - Resolved model with elements
 * @param {Object} blockstateVariants - Blockstate variants (if available)
 * @returns {Object} Flags object
 */
function extractBlockFlags(blockName, model, blockstateVariants = null) {
  return {
    hasRandomRotation: hasRandomRotation(blockName),
    hasPositionOffset: needsPositionOffset(model, blockName),
    isTransparent: isTransparentModel(model, blockName),
    noShade: hasNoShadeElement(model),
    hasInnerCube: hasInnerCubePattern(blockName),
    hasAxisRotation: hasAxisVariants(blockstateVariants),
  };
}

// Caches
const modelCache = new Map();
const blockstateCache = new Map();
const textureMap = new Map();
let nextTextureIndex = 0;

function loadJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

/**
 * Load and cache blockstate JSON for a block.
 */
function loadBlockstate(blockName) {
  if (blockstateCache.has(blockName)) {
    return blockstateCache.get(blockName);
  }
  
  const blockstatePath = path.join(BLOCKSTATES_PATH, `${blockName}.json`);
  const blockstate = loadJson(blockstatePath);
  blockstateCache.set(blockName, blockstate);
  return blockstate;
}

function getTextureIndex(textureName) {
  const normalized = textureName.replace('minecraft:', '').replace('block/', '');
  if (!textureMap.has(normalized)) {
    textureMap.set(normalized, nextTextureIndex++);
  }
  return textureMap.get(normalized);
}


function resolveModel(modelName) {
  if (modelCache.has(modelName)) {
    return modelCache.get(modelName);
  }
  
  const modelPath = path.join(MODELS_PATH, `${modelName}.json`);
  let model = loadJson(modelPath);
  
  if (!model) {
    // Try with full path
    const altPath = path.join(ASSETS_PATH, 'models', `block/${modelName}.json`);
    model = loadJson(altPath);
  }
  
  if (!model) {
    modelCache.set(modelName, null);
    return null;
  }
  
  let result = {
    elements: [],
    textures: {},
    ambientocclusion: model.ambientocclusion !== false,
  };
  
  if (model.parent) {
    const parentName = model.parent.replace('minecraft:', '').replace('block/', '');
    const parent = resolveModel(parentName);
    if (parent) {
      result.elements = [...parent.elements];
      result.textures = { ...parent.textures };
      result.ambientocclusion = parent.ambientocclusion;
    }
  }
  
  if (model.textures) {
    Object.assign(result.textures, model.textures);
  }
  
  if (model.elements) {
    result.elements = model.elements;
  }
  
  modelCache.set(modelName, result);
  return result;
}

function resolveTexture(textureRef, textures) {
  if (!textureRef) return null;
  
  let resolved = textureRef;
  const visited = new Set();
  
  while (resolved.startsWith('#')) {
    if (visited.has(resolved)) return null; // Circular
    visited.add(resolved);
    
    const key = resolved.slice(1);
    resolved = textures[key];
    if (!resolved) return null;
  }
  
  return resolved.replace('minecraft:', '').replace('block/', '');
}

function rotateVertex(v, rotX, rotY) {
  let [x, y, z] = v;
  
  // Minecraft rotation order: X first, then Y
  // This matches ModelGeometry.js which uses combined matrix Y * X
  // (matrix multiplication order is reverse of application order)
  
  // Rotate around X axis FIRST
  if (rotX !== 0) {
    const radX = (rotX * Math.PI) / 180;
    const cosX = Math.cos(radX);
    const sinX = Math.sin(radX);
    const newY = (y - 0.5) * cosX - (z - 0.5) * sinX + 0.5;
    const newZ = (y - 0.5) * sinX + (z - 0.5) * cosX + 0.5;
    y = newY;
    z = newZ;
  }
  
  // Rotate around Y axis SECOND
  if (rotY !== 0) {
    const radY = (rotY * Math.PI) / 180;
    const cosY = Math.cos(radY);
    const sinY = Math.sin(radY);
    const newX = (x - 0.5) * cosY - (z - 0.5) * sinY + 0.5;
    const newZ = (x - 0.5) * sinY + (z - 0.5) * cosY + 0.5;
    x = newX;
    z = newZ;
  }
  
  return [x, y, z];
}

function rotateNormal(n, rotX, rotY) {
  let [x, y, z] = n;
  
  // Minecraft rotation order: X first, then Y (same as rotateVertex)
  
  // Rotate around X axis FIRST
  if (rotX !== 0) {
    const radX = (rotX * Math.PI) / 180;
    const cosX = Math.cos(radX);
    const sinX = Math.sin(radX);
    const newY = y * cosX - z * sinX;
    const newZ = y * sinX + z * cosX;
    y = newY;
    z = newZ;
  }
  
  // Rotate around Y axis SECOND
  if (rotY !== 0) {
    const radY = (rotY * Math.PI) / 180;
    const cosY = Math.cos(radY);
    const sinY = Math.sin(radY);
    const newX = x * cosY - z * sinY;
    const newZ = x * sinY + z * cosY;
    x = newX;
    z = newZ;
  }
  
  return [x, y, z];
}

function rotateCullface(cullface, rotX, rotY) {
  if (!cullface || cullface === 'none') return 'none';
  
  const rotations = ['north', 'east', 'south', 'west'];
  
  let result = cullface;
  
  // Minecraft rotation order: X first, then Y
  
  // X rotation FIRST (only affects up/down/north/south)
  if (rotX !== 0) {
    const xRotations = ['north', 'down', 'south', 'up'];
    if (xRotations.includes(result)) {
      const idx = xRotations.indexOf(result);
      const steps = Math.round(rotX / 90) % 4;
      result = xRotations[(idx + steps + 4) % 4];
    }
  }
  
  // Y rotation SECOND
  if (rotY !== 0 && ['north', 'east', 'south', 'west'].includes(result)) {
    const idx = rotations.indexOf(result);
    const steps = Math.round(rotY / 90) % 4;
    result = rotations[(idx + steps + 4) % 4];
  }
  
  return result;
}

function computeGeometry(model, rotX = 0, rotY = 0, uvlock = false, blockName = '') {
  if (!model || !model.elements || model.elements.length === 0) {
    return null;
  }
  
  const faces = [];
  let hasNoShade = false;  // Track if any element has shade: false
  
  for (const element of model.elements) {
    const from = element.from.map(v => v / 16);
    const to = element.to.map(v => v / 16);
    
    // Check for shade: false on element (torches, lanterns, etc.)
    if (element.shade === false) {
      hasNoShade = true;
    }
    
    if (!element.faces) continue;
    
    for (const [faceName, faceData] of Object.entries(element.faces)) {
      const textureName = resolveTexture(faceData.texture, model.textures);
      if (!textureName) continue;
      
      const textureIndex = getTextureIndex(textureName);
      const tintType = inferTintType(blockName, faceData.tintindex);
      
      // Get base vertices for this face
      // MUST match ModelGeometry.js vertex order for consistent winding
      // Vertices are in CCW order when viewed from OUTSIDE the block
      let vertices;
      switch (faceName) {
        case 'down':
          // -Y face: starts at (from.x, from.y, to.z), goes CCW when looking from below
          vertices = [
            [from[0], from[1], to[2]],    // V0
            [to[0], from[1], to[2]],      // V1
            [to[0], from[1], from[2]],    // V2
            [from[0], from[1], from[2]],  // V3
          ];
          break;
        case 'up':
          // +Y face: starts at (from.x, to.y, from.z), goes CCW when looking from above
          vertices = [
            [from[0], to[1], from[2]],    // V0
            [to[0], to[1], from[2]],      // V1
            [to[0], to[1], to[2]],        // V2
            [from[0], to[1], to[2]],      // V3
          ];
          break;
        case 'north':
          // -Z face: starts at top-right (to.x, to.y, from.z), goes CCW
          vertices = [
            [to[0], to[1], from[2]],      // V0: top-right
            [from[0], to[1], from[2]],    // V1: top-left
            [from[0], from[1], from[2]],  // V2: bottom-left
            [to[0], from[1], from[2]],    // V3: bottom-right
          ];
          break;
        case 'south':
          // +Z face: starts at top-left (from.x, to.y, to.z), goes CCW
          vertices = [
            [from[0], to[1], to[2]],      // V0: top-left
            [to[0], to[1], to[2]],        // V1: top-right
            [to[0], from[1], to[2]],      // V2: bottom-right
            [from[0], from[1], to[2]],    // V3: bottom-left
          ];
          break;
        case 'west':
          // -X face: starts at top-back (from.x, to.y, from.z), goes CCW
          vertices = [
            [from[0], to[1], from[2]],    // V0: top-back
            [from[0], to[1], to[2]],      // V1: top-front
            [from[0], from[1], to[2]],    // V2: bottom-front
            [from[0], from[1], from[2]],  // V3: bottom-back
          ];
          break;
        case 'east':
          // +X face: starts at top-front (to.x, to.y, to.z), goes CCW
          vertices = [
            [to[0], to[1], to[2]],        // V0: top-front
            [to[0], to[1], from[2]],      // V1: top-back
            [to[0], from[1], from[2]],    // V2: bottom-back
            [to[0], from[1], to[2]],      // V3: bottom-front
          ];
          break;
        default:
          continue;
      }
      
      // Apply element rotation if present
      if (element.rotation) {
        const origin = element.rotation.origin.map(v => v / 16);
        const axis = element.rotation.axis;
        const angle = element.rotation.angle || 0;
        const rescale = element.rotation.rescale || false;
        
        if (angle !== 0) {
          const rad = (angle * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          // Rescale factor: 1/cos(angle) to compensate for narrowing during rotation
          const scale = rescale ? 1.0 / Math.abs(cos) : 1.0;
          
          vertices = vertices.map(v => {
            let [x, y, z] = v;
            x -= origin[0];
            y -= origin[1];
            z -= origin[2];
            
            let newX = x, newY = y, newZ = z;
            switch (axis) {
              case 'x':
                // Rotate around X, rescale affects Y and Z
                newY = y * cos - z * sin;
                newZ = y * sin + z * cos;
                if (rescale) {
                  newY *= scale;
                  newZ *= scale;
                }
                break;
              case 'y':
                // Rotate around Y, rescale affects X and Z
                newX = x * cos - z * sin;
                newZ = x * sin + z * cos;
                if (rescale) {
                  newX *= scale;
                  newZ *= scale;
                }
                break;
              case 'z':
                // Rotate around Z, rescale affects X and Y
                newX = x * cos - y * sin;
                newY = x * sin + y * cos;
                if (rescale) {
                  newX *= scale;
                  newY *= scale;
                }
                break;
            }
            
            return [newX + origin[0], newY + origin[1], newZ + origin[2]];
          });
        }
      }
      
      // Apply block-level rotation
      if (rotX !== 0 || rotY !== 0) {
        vertices = vertices.map(v => rotateVertex(v, rotX, rotY));
      }
      
      // Get normal
      let normal = FACE_NORMALS[faceName] || [0, 0, 0];
      if (rotX !== 0 || rotY !== 0) {
        normal = rotateNormal(normal, rotX, rotY);
      }
      
      // Get UVs
      // UV order must match vertex order for each face
      // In Minecraft UV space: (0,0) = top-left, (1,1) = bottom-right
      let uvs;
      if (faceData.uv) {
        const [u0, v0, u1, v1] = faceData.uv.map(v => v / 16);
        // UV corners for the quad (texture coordinates)
        // Vertices go CCW starting from "top" corner, so UVs should match
        switch (faceName) {
          case 'down':
          case 'up':
            // Horizontal faces: V0=front-left, V1=front-right, V2=back-right, V3=back-left
            uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
            break;
          case 'north':
          case 'south':
          case 'west':
          case 'east':
            // Vertical faces: V0=top-X, V1=top-Y, V2=bottom-Y, V3=bottom-X (CCW from top)
            uvs = [[u1, v0], [u0, v0], [u0, v1], [u1, v1]];
            break;
          default:
            uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        }
      } else {
        // Auto-generate UVs based on element bounds (Minecraft's default behavior)
        // When UV is not specified, Minecraft maps element coordinates directly to texture coordinates
        // This CROPS the texture rather than stretching it to fit the element
        let u0, v0, u1, v1;
        switch (faceName) {
          case 'up':
            // Top face: X maps to U, Z maps to V
            u0 = element.from[0] / 16; v0 = element.from[2] / 16;
            u1 = element.to[0] / 16;   v1 = element.to[2] / 16;
            uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
            break;
          case 'down':
            // Bottom face: X maps to U, (16-Z) maps to V (flipped Z)
            u0 = element.from[0] / 16; v0 = (16 - element.to[2]) / 16;
            u1 = element.to[0] / 16;   v1 = (16 - element.from[2]) / 16;
            uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
            break;
          case 'north':
            // North face (-Z): (16-X) maps to U, (16-Y) maps to V
            u0 = (16 - element.to[0]) / 16;   v0 = (16 - element.to[1]) / 16;
            u1 = (16 - element.from[0]) / 16; v1 = (16 - element.from[1]) / 16;
            uvs = [[u1, v0], [u0, v0], [u0, v1], [u1, v1]];
            break;
          case 'south':
            // South face (+Z): X maps to U, (16-Y) maps to V
            u0 = element.from[0] / 16; v0 = (16 - element.to[1]) / 16;
            u1 = element.to[0] / 16;   v1 = (16 - element.from[1]) / 16;
            uvs = [[u1, v0], [u0, v0], [u0, v1], [u1, v1]];
            break;
          case 'west':
            // West face (-X): Z maps to U, (16-Y) maps to V
            u0 = element.from[2] / 16; v0 = (16 - element.to[1]) / 16;
            u1 = element.to[2] / 16;   v1 = (16 - element.from[1]) / 16;
            uvs = [[u1, v0], [u0, v0], [u0, v1], [u1, v1]];
            break;
          case 'east':
            // East face (+X): (16-Z) maps to U, (16-Y) maps to V
            u0 = (16 - element.to[2]) / 16;   v0 = (16 - element.to[1]) / 16;
            u1 = (16 - element.from[2]) / 16; v1 = (16 - element.from[1]) / 16;
            uvs = [[u1, v0], [u0, v0], [u0, v1], [u1, v1]];
            break;
          default:
            uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
        }
      }
      
      // Handle UV rotation
      if (faceData.rotation) {
        const steps = (faceData.rotation / 90) % 4;
        for (let i = 0; i < steps; i++) {
          uvs = [uvs[3], uvs[0], uvs[1], uvs[2]];
        }
      }
      
      // Cullface
      let cullface = faceData.cullface || 'none';
      if (rotX !== 0 || rotY !== 0) {
        cullface = rotateCullface(cullface, rotX, rotY);
      }
      
      faces.push({
        direction: DIRECTION[faceName] || 6,
        cullface: cullface === 'none' ? 0xFF : DIRECTION[cullface],
        tintType,
        textureIndex,
        vertices: vertices.flat(),
        uvs: uvs.flat(),
        normal,
      });
    }
  }
  
  return { faces, hasAO: model.ambientocclusion, hasNoShade: hasNoShade };
}

function writeBinary(manifest) {
  const chunks = [];
  let totalSize = 0;
  
  // Collect all blocks
  const blocks = Object.entries(manifest.blocks);
  
  console.log(`Baking geometry for ${blocks.length} blocks...`);
  
  // Build block data
  const blockDataList = [];
  let bakedVariants = 0;
  let bakedFaces = 0;
  
  for (const [blockName, blockInfo] of blocks) {
    const variants = [];
    
    for (const [variantKey, variantInfo] of Object.entries(blockInfo.variants)) {
      const model = resolveModel(variantInfo.model);
      if (!model) continue;
      
      const geometry = computeGeometry(
        model,
        variantInfo.rotX || 0,
        variantInfo.rotY || 0,
        variantInfo.uvlock || false,
        blockName
      );
      
      if (!geometry || geometry.faces.length === 0) continue;
      
      variants.push({
        key: variantKey,
        faces: geometry.faces,
        hasAO: geometry.hasAO,
        hasNoShade: geometry.hasNoShade,
      });
      
      bakedVariants++;
      bakedFaces += geometry.faces.length;
    }
    
    // =========================================================================
    // FLAG DETECTION FROM MODEL/BLOCKSTATE STRUCTURE
    // Instead of using hardcoded flags from manifest, we detect them from the
    // actual model and blockstate JSON files.
    // =========================================================================
    
    // Load blockstate to detect random rotation and axis variants
    const blockstate = loadBlockstate(blockName);
    const blockstateVariants = blockstate?.variants || null;
    
    // Get the first valid model for structure-based flag detection
    const firstVariant = variants[0];
    const representativeModel = firstVariant 
      ? resolveModel(Object.values(blockInfo.variants)[0]?.model) 
      : null;
    
    // Detect all flags from model/blockstate structure
    const detectedFlags = extractBlockFlags(blockName, representativeModel, blockstateVariants);
    
    // Also check if any variant has no-shade (from element inspection during geometry computation)
    const hasNoShadeFromGeometry = variants.some(v => v.hasNoShade);
    
    // Merge detected flags with geometry-derived flags
    const computedFlags = {
      hasRandomRotation: detectedFlags.hasRandomRotation,
      hasPositionOffset: detectedFlags.hasPositionOffset,
      isTransparent: detectedFlags.isTransparent,
      noShade: detectedFlags.noShade || hasNoShadeFromGeometry,
      hasInnerCube: detectedFlags.hasInnerCube,
      hasAxisRotation: detectedFlags.hasAxisRotation,
    };
    
    // CRITICAL: Include ALL blocks, even with 0 variants, to keep indices aligned
    // with ModelStateLookup which assigns indices to all manifest blocks.
    // Blocks with 0 variants simply won't render any geometry.
    blockDataList.push({
      name: blockName,
      flags: computedFlags,
      variants,
    });
  }
  
  console.log(`Baked ${bakedVariants} variants with ${bakedFaces} faces`);
  console.log(`Unique textures: ${textureMap.size}`);
  
  // Calculate sizes
  const HEADER_SIZE = 12; // magic + version + block count
  let indexSize = 0;
  let dataSize = 0;
  
  for (const block of blockDataList) {
    indexSize += 2 + block.name.length + 4; // nameLen + name + offset
    
    // Block data: variantCount + flags
    let blockSize = 2;
    
    for (const variant of block.variants) {
      // Variant: keyLen + key + faceCount
      blockSize += 1 + variant.key.length + 2;
      
      // Faces: each face is 1 + 1 + 1 + 2 + 48 + 32 + 12 = 97 bytes
      blockSize += variant.faces.length * 97;
    }
    
    dataSize += blockSize;
  }
  
  const totalBytes = HEADER_SIZE + indexSize + dataSize;
  const buffer = Buffer.alloc(totalBytes);
  let offset = 0;
  
  // Write header
  buffer.writeUInt32LE(0x424B4D44, offset); offset += 4; // Magic "BKMD"
  buffer.writeUInt32LE(1, offset); offset += 4; // Version
  buffer.writeUInt32LE(blockDataList.length, offset); offset += 4;
  
  // Write index
  const indexStart = offset;
  const dataStart = indexStart + indexSize;
  let currentDataOffset = 0;
  
  for (const block of blockDataList) {
    buffer.writeUInt16LE(block.name.length, offset); offset += 2;
    buffer.write(block.name, offset, 'utf-8'); offset += block.name.length;
    buffer.writeUInt32LE(currentDataOffset, offset); offset += 4;
    
    // Calculate block data size for offset
    let blockSize = 2;
    for (const variant of block.variants) {
      blockSize += 1 + variant.key.length + 2;
      blockSize += variant.faces.length * 97;
    }
    currentDataOffset += blockSize;
  }
  
  // Write data
  for (const block of blockDataList) {
    // Variant count
    buffer.writeUInt8(block.variants.length, offset); offset += 1;
    
    // Flags bitfield:
    // 0x01 = hasRandomRotation
    // 0x02 = hasPositionOffset
    // 0x04 = isTransparent
    // 0x08 = noShade
    // 0x10 = hasInnerCube
    // 0x20 = hasAxisRotation
    let flags = 0;
    if (block.flags.hasRandomRotation) flags |= 0x01;
    if (block.flags.hasPositionOffset) flags |= 0x02;
    if (block.flags.isTransparent) flags |= 0x04;
    if (block.flags.noShade) flags |= 0x08;
    if (block.flags.hasInnerCube) flags |= 0x10;
    if (block.flags.hasAxisRotation) flags |= 0x20;
    buffer.writeUInt8(flags, offset); offset += 1;
    
    for (const variant of block.variants) {
      // Variant key
      buffer.writeUInt8(variant.key.length, offset); offset += 1;
      buffer.write(variant.key, offset, 'utf-8'); offset += variant.key.length;
      
      // Face count
      buffer.writeUInt16LE(variant.faces.length, offset); offset += 2;
      
      for (const face of variant.faces) {
        buffer.writeUInt8(face.direction, offset); offset += 1;
        buffer.writeUInt8(face.cullface, offset); offset += 1;
        buffer.writeUInt8(face.tintType, offset); offset += 1;
        buffer.writeUInt16LE(face.textureIndex, offset); offset += 2;
        
        // Vertices (12 floats)
        for (let i = 0; i < 12; i++) {
          buffer.writeFloatLE(face.vertices[i], offset); offset += 4;
        }
        
        // UVs (8 floats)
        for (let i = 0; i < 8; i++) {
          buffer.writeFloatLE(face.uvs[i], offset); offset += 4;
        }
        
        // Normal (3 floats)
        for (let i = 0; i < 3; i++) {
          buffer.writeFloatLE(face.normal[i], offset); offset += 4;
        }
      }
    }
  }
  
  // Write texture map as separate file
  const textureMapPath = OUTPUT_PATH.replace('.bin', '-textures.json');
  const textureMapData = Object.fromEntries(textureMap);
  fs.writeFileSync(textureMapPath, JSON.stringify(textureMapData, null, 2));
  
  console.log(`\nOutput:`);
  console.log(`  Binary: ${OUTPUT_PATH} (${(buffer.length / 1024).toFixed(1)} KB)`);
  console.log(`  Textures: ${textureMapPath}`);
  
  return buffer;
}

async function main() {
  console.log('Loading manifest...');
  const manifest = loadJson(MANIFEST_PATH);
  
  if (!manifest) {
    console.error('Failed to load manifest. Run analyze-block-models.js first.');
    process.exit(1);
  }
  
  console.log(`Manifest loaded: ${Object.keys(manifest.blocks).length} blocks`);
  
  const binary = writeBinary(manifest);
  
  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(OUTPUT_PATH, binary);
  
  console.log('\nDone!');
}

main().catch(console.error);
