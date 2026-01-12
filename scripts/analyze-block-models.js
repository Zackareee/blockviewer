#!/usr/bin/env node
/**
 * Block Model Analysis Script
 * 
 * Analyzes all Minecraft blockstates and models to generate a manifest
 * of unique geometry variants for each block type.
 * 
 * Output: public/assets/block-model-manifest.json
 * 
 * The manifest identifies:
 * - Which properties affect geometry (require different model data)
 * - Which properties only affect rotation/flip (can be applied at runtime)
 * - Unique geometry variants per block
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_PATH = path.join(__dirname, '../minecraft_versions/1.21.11_unobfuscated/assets/minecraft');
const BLOCKSTATES_PATH = path.join(ASSETS_PATH, 'blockstates');
const MODELS_PATH = path.join(ASSETS_PATH, 'models/block');
const OUTPUT_PATH = path.join(__dirname, '../public/assets/block-model-manifest.json');

// Properties that only affect runtime rotation (not geometry)
// NOTE: 'facing' is NOT here - most blocks with 'facing' have rotation baked into variants
// Only truly runtime-rotated properties should be here
const ROTATION_PROPERTIES = new Set([
  'rotation', // For signs, skulls - 0-15 rotation value applied at runtime
  'axis',     // For logs, pillars - single model rotated at runtime
]);

// Properties that affect vertical flip
const FLIP_PROPERTIES = new Set([
  'half',     // top/bottom for stairs, slabs
  'type',     // For slabs (top/bottom/double) - affects geometry too
]);

// Properties that definitely affect geometry
const GEOMETRY_PROPERTIES = new Set([
  'shape',      // Stairs (straight, inner_left, outer_left, etc.)
  'type',       // Slabs (top, bottom, double)
  'open',       // Doors, trapdoors
  'hinge',      // Doors
  'powered',    // Rails can have different geometry
  'extended',   // Pistons
  'north', 'south', 'east', 'west', 'up', 'down', // Connections (fences, walls)
  'age',        // Crops
  'layers',     // Snow
  'level',      // Cauldron, composter
  'bites',      // Cake
  'eggs',       // Turtle eggs
  'pickles',    // Sea pickles
  'candles',    // Candles
  'part',       // Beds
  'occupied',   // Beds
  'mode',       // Comparator
  'delay',      // Repeater
  'locked',     // Repeater
  'attachment', // Bells
  'orientation', // Jigsaw
  'thickness',  // Pointed dripstone
  'tilt',       // Big dripleaf
  'berries',    // Cave vines
  'flower_amount', // Pink petals
]);

// Blocks that use random Y-rotation (cross-model plants)
const RANDOM_ROTATION_BLOCKS = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'nether_sprouts', 'crimson_roots', 'warped_roots',
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower', 'eyeblossom', 'pink_petals',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
  'mangrove_propagule', 'hanging_roots', 'spore_blossom',
  'red_mushroom', 'brown_mushroom', 'crimson_fungus', 'warped_fungus',
]);

// Blocks that need position-based XZ offset
const POSITION_OFFSET_BLOCKS = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'nether_sprouts', 'crimson_roots', 'warped_roots',
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower', 'eyeblossom',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
]);

// Blocks that are transparent
const TRANSPARENT_BLOCKS = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'nether_sprouts', 'crimson_roots', 'warped_roots',
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower', 'eyeblossom', 'pink_petals',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
  'hanging_roots', 'spore_blossom', 'sugar_cane', 'kelp', 'seagrass',
  'vine', 'twisting_vines', 'weeping_vines', 'cave_vines',
  // Leaves
  'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'pale_oak_leaves',
  'mangrove_leaves', 'azalea_leaves', 'flowering_azalea_leaves',
]);

// Full cube blocks (shouldn't be model blocks)
const FULL_CUBE_BLOCKS = new Set([
  'stone', 'dirt', 'grass_block', 'cobblestone', 'oak_planks',
  // etc - these are handled by greedy meshing
]);

// Full cubes that NEED V3 handling due to state-dependent textures or complex rotation
// These have different textures based on properties (open/closed, lit/unlit, facing with 6-way rotation)
const STATE_DEPENDENT_FULL_CUBES = new Set([
  // Barrels: 6-way facing + open/closed state changes top texture
  'barrel',
  // Furnaces/Smokers/Blast Furnaces: lit state changes front texture
  'furnace', 'blast_furnace', 'smoker',
  // Beehives/Bee Nests: honey_level changes front texture
  'beehive', 'bee_nest',
  // Carved Pumpkin/Jack o'Lantern: 4-way facing
  'carved_pumpkin', 'jack_o_lantern',
  // Observer: facing + powered changes texture
  'observer',
  // Dispensers/Droppers: facing + triggered state
  'dispenser', 'dropper',
  // Command blocks: facing + conditional
  'command_block', 'chain_command_block', 'repeating_command_block',
  // Loom: facing
  'loom',
  // Crafter: facing + crafting/triggered states
  'crafter',
]);

// Blocks with shade: false (cross-model plants, etc.)
// These blocks should not have directional face shading
const NO_SHADE_BLOCKS = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'nether_sprouts', 'crimson_roots', 'warped_roots',
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower', 'eyeblossom', 'pink_petals',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
  'mangrove_propagule', 'hanging_roots', 'spore_blossom',
  'red_mushroom', 'brown_mushroom', 'crimson_fungus', 'warped_fungus',
  'sugar_cane', 'kelp', 'seagrass', 'tall_seagrass',
  'vine', 'twisting_vines', 'weeping_vines', 'cave_vines',
  'fire', 'soul_fire',
]);

/**
 * Load JSON file
 */
function loadJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.warn(`Failed to load ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Parse blockstate variant key into properties object
 */
function parseVariantKey(key) {
  if (!key || key === '') return {};
  
  const props = {};
  for (const part of key.split(',')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) {
      props[k.trim()] = v.trim();
    }
  }
  return props;
}

/**
 * Determine if a property affects geometry or just rotation
 */
function classifyProperty(propName, propValue, blockName) {
  // Special cases by block type
  // NOTE: For blocks where variants have baked X/Y rotations, 'facing' is GEOMETRY not rotation
  // The rotation is baked into the variant, not applied at runtime
  if (blockName.endsWith('_stairs')) {
    if (propName === 'shape') return 'geometry';
    if (propName === 'facing') return 'geometry'; // Rotation is baked into variant
    if (propName === 'half') return 'geometry';   // Also affects geometry for stairs
    if (propName === 'waterlogged') return 'flag';
  }
  
  if (blockName.endsWith('_slab')) {
    if (propName === 'type') return 'geometry';
    if (propName === 'waterlogged') return 'flag';
  }
  
  if (blockName.endsWith('_fence') || blockName === 'nether_brick_fence') {
    if (['north', 'south', 'east', 'west'].includes(propName)) return 'geometry';
    if (propName === 'waterlogged') return 'flag';
  }
  
  if (blockName.endsWith('_wall')) {
    if (['north', 'south', 'east', 'west', 'up'].includes(propName)) return 'geometry';
    if (propName === 'waterlogged') return 'flag';
  }
  
  if (blockName.endsWith('_door')) {
    if (propName === 'open') return 'geometry';
    if (propName === 'facing') return 'geometry'; // Rotation is baked into variant
    if (propName === 'hinge') return 'geometry';
    if (propName === 'half') return 'geometry';
    if (propName === 'powered') return 'flag';
  }
  
  if (blockName.endsWith('_trapdoor')) {
    if (propName === 'open') return 'geometry';
    if (propName === 'facing') return 'geometry'; // Rotation is baked into variant
    if (propName === 'half') return 'geometry';   // Also affects geometry for trapdoors
    if (propName === 'powered') return 'flag';
    if (propName === 'waterlogged') return 'flag';
  }
  
  // General rules
  if (ROTATION_PROPERTIES.has(propName)) return 'rotation';
  if (GEOMETRY_PROPERTIES.has(propName)) return 'geometry';
  if (propName === 'waterlogged' || propName === 'powered' || propName === 'lit') return 'flag';
  
  // Default: treat as geometry affecting (safer)
  return 'geometry';
}

/**
 * Normalize model path
 */
function normalizeModelPath(modelPath) {
  return modelPath.replace('minecraft:', '').replace('block/', '');
}

/**
 * Extract unique geometry configurations from blockstate
 */
function analyzeBlockstate(blockName, blockstate) {
  const analysis = {
    blockName,
    isMultipart: !!blockstate.multipart,
    variants: {},
    rotationProperties: [],
    geometryProperties: [],
    flipProperties: [],
    flagProperties: [],
    uniqueModels: new Set(),
    hasRandomRotation: RANDOM_ROTATION_BLOCKS.has(blockName),
    hasPositionOffset: POSITION_OFFSET_BLOCKS.has(blockName),
    isTransparent: TRANSPARENT_BLOCKS.has(blockName),
    noShade: NO_SHADE_BLOCKS.has(blockName),
  };
  
  if (blockstate.multipart) {
    // Multipart blocks (fences, walls, etc.)
    // These compose multiple models based on connection states
    analysis.isMultipart = true;
    
    // Collect all possible models
    for (const part of blockstate.multipart) {
      const apply = Array.isArray(part.apply) ? part.apply : [part.apply];
      for (const model of apply) {
        if (model.model) {
          analysis.uniqueModels.add(normalizeModelPath(model.model));
        }
      }
      
      // Analyze conditions
      if (part.when) {
        for (const [prop, value] of Object.entries(part.when)) {
          const classification = classifyProperty(prop, value, blockName);
          if (classification === 'geometry' && !analysis.geometryProperties.includes(prop)) {
            analysis.geometryProperties.push(prop);
          }
        }
      }
    }
  } else if (blockstate.variants) {
    // Variant blocks (stairs, slabs, etc.)
    const seenProps = new Set();
    const propClassifications = {};
    
    for (const [variantKey, variantData] of Object.entries(blockstate.variants)) {
      const props = parseVariantKey(variantKey);
      
      // Classify each property
      for (const [propName, propValue] of Object.entries(props)) {
        seenProps.add(propName);
        const classification = classifyProperty(propName, propValue, blockName);
        if (!propClassifications[propName]) {
          propClassifications[propName] = classification;
        }
      }
      
      // Handle variant array (random rotation) or single model
      const variants = Array.isArray(variantData) ? variantData : [variantData];
      
      for (const variant of variants) {
        if (variant.model) {
          analysis.uniqueModels.add(normalizeModelPath(variant.model));
        }
        
        // Build geometry key (only geometry-affecting properties)
        const geomProps = {};
        for (const [prop, value] of Object.entries(props)) {
          const cls = classifyProperty(prop, value, blockName);
          if (cls === 'geometry') {
            geomProps[prop] = value;
          }
        }
        
        const geomKey = Object.entries(geomProps)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(',') || 'default';
        
        if (!analysis.variants[geomKey]) {
          analysis.variants[geomKey] = {
            model: normalizeModelPath(variant.model),
            rotX: variant.x || 0,
            rotY: variant.y || 0,
            uvlock: variant.uvlock || false,
          };
        }
      }
    }
    
    // Categorize properties
    for (const [prop, cls] of Object.entries(propClassifications)) {
      if (cls === 'rotation') analysis.rotationProperties.push(prop);
      else if (cls === 'geometry') analysis.geometryProperties.push(prop);
      else if (cls === 'flip') analysis.flipProperties.push(prop);
      else if (cls === 'flag') analysis.flagProperties.push(prop);
    }
  }
  
  analysis.uniqueModels = [...analysis.uniqueModels];
  return analysis;
}

/**
 * Resolve model inheritance to get final elements
 */
function resolveModel(modelName, modelCache, visited = new Set()) {
  if (visited.has(modelName)) {
    console.warn(`Circular model reference: ${modelName}`);
    return null;
  }
  visited.add(modelName);
  
  if (modelCache.has(modelName)) {
    return modelCache.get(modelName);
  }
  
  const modelPath = path.join(MODELS_PATH, `${modelName}.json`);
  const model = loadJson(modelPath);
  
  if (!model) {
    // Try without block/ prefix
    const altPath = path.join(ASSETS_PATH, 'models', `${modelName}.json`);
    const altModel = loadJson(altPath);
    if (altModel) {
      return resolveModelData(altModel, modelCache, visited);
    }
    return null;
  }
  
  return resolveModelData(model, modelCache, visited);
}

function resolveModelData(model, modelCache, visited) {
  let result = {
    elements: [],
    textures: {},
    ambientocclusion: model.ambientocclusion !== false,
  };
  
  if (model.parent) {
    const parentName = model.parent.replace('minecraft:', '').replace('block/', '');
    const parent = resolveModel(parentName, modelCache, visited);
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
  
  if (model.ambientocclusion !== undefined) {
    result.ambientocclusion = model.ambientocclusion;
  }
  
  return result;
}

/**
 * Main analysis function
 */
async function analyzeAllBlocks() {
  console.log('Analyzing block models...');
  
  const blockstateFiles = fs.readdirSync(BLOCKSTATES_PATH)
    .filter(f => f.endsWith('.json'));
  
  console.log(`Found ${blockstateFiles.length} blockstate files`);
  
  const manifest = {
    version: '1.21.1',
    generatedAt: new Date().toISOString(),
    blocks: {},
  };
  
  const modelCache = new Map();
  let modelBlockCount = 0;
  let skippedCount = 0;
  
  for (const file of blockstateFiles) {
    const blockName = file.replace('.json', '');
    
    // Skip full cube blocks (handled by greedy meshing)
    if (FULL_CUBE_BLOCKS.has(blockName)) {
      skippedCount++;
      continue;
    }
    
    const blockstatePath = path.join(BLOCKSTATES_PATH, file);
    const blockstate = loadJson(blockstatePath);
    
    if (!blockstate) continue;
    
    const analysis = analyzeBlockstate(blockName, blockstate);
    
    // Only include blocks with model variants (non-cube blocks)
    // Skip multipart blocks for now - they need special handling
    // (fences, walls, redstone wire, etc. use conditional model composition)
    if (analysis.isMultipart) {
      skippedCount++;
      continue;
    }
    
    const hasVariants = Object.keys(analysis.variants).length > 0;
    if (!hasVariants) {
      skippedCount++;
      continue;
    }
    
    // Resolve actual model geometry for each unique model
    const resolvedModels = {};
    let fullCubeCount = 0;
    let nonFullCubeCount = 0;
    for (const modelName of analysis.uniqueModels) {
      const resolved = resolveModel(modelName, modelCache);
      if (resolved && resolved.elements && resolved.elements.length > 0) {
        resolvedModels[modelName] = {
          elementCount: resolved.elements.length,
          hasAO: resolved.ambientocclusion,
        };
        
        // Check if this is a full cube model (single element from 0,0,0 to 16,16,16)
        let isThisModelFullCube = false;
        if (resolved.elements.length === 1) {
          const elem = resolved.elements[0];
          const from = elem.from || [0, 0, 0];
          const to = elem.to || [16, 16, 16];
          if (from[0] === 0 && from[1] === 0 && from[2] === 0 &&
              to[0] === 16 && to[1] === 16 && to[2] === 16) {
            // All 6 faces present = full cube
            const faces = Object.keys(elem.faces || {});
            if (faces.length === 6 && 
                faces.includes('north') && faces.includes('south') &&
                faces.includes('east') && faces.includes('west') &&
                faces.includes('up') && faces.includes('down')) {
              isThisModelFullCube = true;
            }
          }
        }
        
        if (isThisModelFullCube) {
          fullCubeCount++;
        } else {
          nonFullCubeCount++;
        }
      }
    }
    
    // Only skip if ALL models are full cubes (not just some, like double slabs)
    const isFullCube = fullCubeCount > 0 && nonFullCubeCount === 0;
    
    // Skip full cube blocks - they're handled by the greedy mesher
    // UNLESS they need state-dependent textures (barrel open/closed, furnace lit, etc.)
    if (isFullCube && !STATE_DEPENDENT_FULL_CUBES.has(blockName)) {
      skippedCount++;
      continue;
    }
    
    manifest.blocks[blockName] = {
      isMultipart: analysis.isMultipart,
      variants: analysis.variants,
      rotationProperties: analysis.rotationProperties,
      geometryProperties: analysis.geometryProperties,
      flipProperties: analysis.flipProperties,
      flagProperties: analysis.flagProperties,
      uniqueModels: analysis.uniqueModels,
      resolvedModels,
      flags: {
        hasRandomRotation: analysis.hasRandomRotation,
        hasPositionOffset: analysis.hasPositionOffset,
        isTransparent: analysis.isTransparent,
        noShade: analysis.noShade,
      },
    };
    
    modelBlockCount++;
  }
  
  // Write manifest
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2));
  
  console.log(`\nAnalysis complete:`);
  console.log(`  Model blocks: ${modelBlockCount}`);
  console.log(`  Skipped (full cube): ${skippedCount}`);
  console.log(`  Output: ${OUTPUT_PATH}`);
  
  // Print some stats
  const stairsBlocks = Object.keys(manifest.blocks).filter(b => b.endsWith('_stairs'));
  const slabBlocks = Object.keys(manifest.blocks).filter(b => b.endsWith('_slab'));
  const fenceBlocks = Object.keys(manifest.blocks).filter(b => b.endsWith('_fence'));
  const wallBlocks = Object.keys(manifest.blocks).filter(b => b.endsWith('_wall'));
  
  console.log(`\nBlock categories:`);
  console.log(`  Stairs: ${stairsBlocks.length}`);
  console.log(`  Slabs: ${slabBlocks.length}`);
  console.log(`  Fences: ${fenceBlocks.length}`);
  console.log(`  Walls: ${wallBlocks.length}`);
  
  return manifest;
}

// Run
analyzeAllBlocks().catch(console.error);
