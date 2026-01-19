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

// ============================================================================
// DEPRECATED HARDCODED LISTS
// These are no longer used. All flags are now detected from model/blockstate
// structure in bake-model-geometry.js. Kept here for reference only.
// ============================================================================

// Flags are now detected by:
// - hasRandomRotation: blockstate has array variants with different y rotations
// - hasPositionOffset: cross-pattern model (no cullface faces)
// - isTransparent: cross-pattern model or leaves/pane patterns
// - noShade: model has elements with shade: false
// - hasInnerCube: model has both cullface and non-cullface faces

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
  
  // Nether portal: axis selects between different models (ns vs ew), not runtime rotation
  if (blockName === 'nether_portal') {
    if (propName === 'axis') return 'geometry';
  }
  
  // Logs, wood, stems, hyphae: axis selects between vertical and horizontal models
  // axis=y uses log model, axis=x/z use log_horizontal model with different rotations
  if (blockName.endsWith('_log') || blockName.endsWith('_wood') || 
      blockName.endsWith('_stem') || blockName.endsWith('_hyphae')) {
    if (propName === 'axis') return 'geometry';
  }
  
  // Pillars and basalt also use different models for different axes
  if (blockName.includes('pillar') || blockName === 'basalt' || blockName === 'polished_basalt' ||
      blockName === 'bone_block' || blockName === 'hay_block' || blockName === 'purpur_pillar') {
    if (propName === 'axis') return 'geometry';
  }
  
  // Test blocks have mode property that selects different models
  if (blockName === 'test_block') {
    if (propName === 'mode') return 'geometry';
  }
  
  // Redstone lamp: 'lit' affects the texture (uses redstone_lamp_on model when lit)
  if (blockName === 'redstone_lamp') {
    if (propName === 'lit') return 'geometry';
  }
  
  // Copper bulbs: both 'lit' and 'powered' affect the texture
  // (copper_bulb, copper_bulb_lit, copper_bulb_powered, copper_bulb_lit_powered)
  if (blockName.includes('copper_bulb')) {
    if (propName === 'lit') return 'geometry';
    if (propName === 'powered') return 'geometry';
  }
  
  // Furnace-type blocks: 'lit' affects the model (furnace vs furnace_on, etc.)
  if (blockName === 'furnace' || blockName === 'blast_furnace' || blockName === 'smoker') {
    if (propName === 'lit') return 'geometry';
    if (propName === 'facing') return 'geometry'; // Rotation is baked into variant
  }
  
  // Bee blocks: 'honey_level' affects the model (empty vs honey-filled front texture)
  if (blockName === 'bee_nest' || blockName === 'beehive') {
    if (propName === 'honey_level') return 'geometry';
    if (propName === 'facing') return 'geometry'; // Rotation is baked into variant
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
    // Flags are now detected from model/blockstate structure in bake-model-geometry.js
    // We don't compute them here anymore
  };
  
  if (blockstate.multipart) {
    // Multipart blocks (fences, walls, etc.)
    // These compose multiple models based on connection states
    analysis.isMultipart = true;
    
    // For multipart blocks, create a variant entry for each unique model+rotation combo
    // This allows the bake script to bake the geometry for each component
    let partIndex = 0;
    for (const part of blockstate.multipart) {
      const apply = Array.isArray(part.apply) ? part.apply : [part.apply];
      for (const model of apply) {
        if (model.model) {
          const modelPath = normalizeModelPath(model.model);
          analysis.uniqueModels.add(modelPath);
          
          // Create a variant key based on the condition or part index
          let variantKey;
          if (part.when) {
            // Convert condition to variant key format
            const conditions = Object.entries(part.when)
              .filter(([k]) => k !== 'OR') // Skip complex OR conditions for now
              .map(([k, v]) => `${k}=${v}`)
              .sort()
              .join(',');
            variantKey = conditions || `part_${partIndex}`;
          } else {
            // Base part (always applied)
            variantKey = partIndex === 0 ? 'default' : `part_${partIndex}`;
          }
          
          // Store unique combinations
          const uniqueKey = `${variantKey}_${model.x || 0}_${model.y || 0}`;
          if (!analysis.variants[uniqueKey]) {
            analysis.variants[uniqueKey] = {
              model: modelPath,
              rotX: model.x || 0,
              rotY: model.y || 0,
              uvlock: model.uvlock || false,
              condition: part.when || null, // Store condition for runtime composition
            };
          }
        }
        partIndex++;
      }
      
      // Analyze conditions for property classification
      if (part.when) {
        for (const [prop, value] of Object.entries(part.when)) {
          if (prop === 'OR') continue; // Skip complex OR conditions
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
  let fullCubeBlocksIncluded = 0;
  let multipartBlockCount = 0;
  
  for (const file of blockstateFiles) {
    const blockName = file.replace('.json', '');
    
    const blockstatePath = path.join(BLOCKSTATES_PATH, file);
    const blockstate = loadJson(blockstatePath);
    
    if (!blockstate) continue;
    
    const analysis = analyzeBlockstate(blockName, blockstate);
    
    // Include ALL blocks now, including multipart blocks
    // Multipart blocks will have their component models baked
    // The runtime will compose them based on block state
    
    if (analysis.isMultipart) {
      multipartBlockCount++;
    }
    
    const hasVariants = Object.keys(analysis.variants).length > 0 || analysis.isMultipart;
    
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
    
    // Track if this is a full cube model (for stats only now)
    const isFullCube = fullCubeCount > 0 && nonFullCubeCount === 0;
    if (isFullCube) {
      fullCubeBlocksIncluded++;
    }
    
    // Include ALL blocks now - full cubes included for complete coverage
    // The bake script will compute all flags from model/blockstate structure
    manifest.blocks[blockName] = {
      isMultipart: analysis.isMultipart,
      variants: analysis.variants,
      rotationProperties: analysis.rotationProperties,
      geometryProperties: analysis.geometryProperties,
      flipProperties: analysis.flipProperties,
      flagProperties: analysis.flagProperties,
      uniqueModels: analysis.uniqueModels,
      resolvedModels,
      isFullCube, // Mark for runtime to know if FastMesher can handle it
      // Flags are now computed in bake-model-geometry.js from model/blockstate structure
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
  console.log(`  Total blocks: ${modelBlockCount}`);
  console.log(`  Full cube blocks: ${fullCubeBlocksIncluded}`);
  console.log(`  Multipart blocks: ${multipartBlockCount}`);
  console.log(`  Skipped (no variants): ${skippedCount}`);
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
