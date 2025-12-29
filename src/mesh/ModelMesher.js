/**
 * ModelMesher - Generates mesh geometry for non-cube blocks
 * 
 * Uses pre-computed model geometry from the assets system.
 * Applies vertex colors from BlockRegistry, with optional texture atlas support.
 * 
 * Handles face culling based on cullface data from models.
 */

import { BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, sectionToWorldY, makeSectionKey, parseSectionKey } from './BinaryGrid.js';
import { CULLFACE_OFFSETS } from '../assets/ModelGeometry.js';
import { BlockCategory } from './BlockRegistry.js';
import { FACE_UP, FACE_DOWN, FACE_NORTH, FACE_SOUTH, FACE_EAST, FACE_WEST } from '../assets/TextureIndexLookup.js';
import { buildTintTypeLookup } from '../data/biomeTinting.js';

// Map face name to face index constant
const FACE_NAME_TO_INDEX = {
  'up': FACE_UP,
  'down': FACE_DOWN,
  'north': FACE_NORTH,
  'south': FACE_SOUTH,
  'east': FACE_EAST,
  'west': FACE_WEST,
};

// Blocks that need position-based texture rotation (horizontal planes with random rotation variants)
// These blocks have multiple Y-rotation variants in their blockstate that are selected based on position hash
const POSITION_ROTATION_BLOCKS = new Set([
  'lily_pad',
]);

// Blocks that use facing-based TEXTURE rotation (simple flat planes only)
// Complex models with positioned elements (stems, etc.) use model rotation instead
const FACING_TEXTURE_ROTATION_BLOCKS = new Set([
  'leaf_litter',
]);

// Facing direction to rotation value mapping (for blocks using facing property)
const FACING_TO_ROTATION = {
  'north': 0,
  'east': 1,
  'south': 2,
  'west': 3,
};

/**
 * Compute position-based texture rotation for blocks with random rotation variants
 * Uses Minecraft's exact position hash algorithm for variant selection
 * @param {number} x - World X coordinate
 * @param {number} y - World Y coordinate  
 * @param {number} z - World Z coordinate
 * @returns {number} Rotation value 0-3 (0°, 90°, 180°, 270°)
 */
function getPositionRotation(x, y, z) {
  // Minecraft's MathHelper.hashCode:
  // long l = (long)(x * 3129871) ^ (long)z * 116129781L ^ (long)y;
  // l = l * l * 42317861L + l * 11L;
  // return l >> 16;
  // 
  // Note: (long)(x * 3129871) does INT multiply first, then casts to long
  // This matters for overflow behavior!
  
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

// Initial buffer sizes (will grow as needed)
const INITIAL_VERTEX_COUNT = 50000;

/**
 * Build meshes for non-cube blocks in a region
 * 
 * @param {BinaryGrid} grid - Block data
 * @param {BlockStateGrid} stateGrid - State IDs for non-cube blocks
 * @param {BlockRegistry} registry - Block type info
 * @param {StateRegistry} stateRegistry - State to geometry mapping
 * @param {Object} offset - World offset {x, y, z}
 * @param {Object} options - Optional parameters
 * @param {TextureIndexLookup} options.textureIndexLookup - Texture atlas index lookup
 * @returns {Object} Mesh data {positions, normals, colors, indices, texIndices}
 */
export function buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  const { textureIndexLookup = null } = options;
  
  // Build lookup tables for colors
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const col = registry.getColor(id);
    colorR[id] = col.r;
    colorG[id] = col.g;
    colorB[id] = col.b;
  }
  
  // Build tint type lookup for biome tinting
  const tintTypeLookup = buildTintTypeLookup(registry);

  // Growable buffers
  let positions = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let normals = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let colors = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let texIndices = new Float32Array(INITIAL_VERTEX_COUNT); // Texture atlas index per vertex
  let texRotations = new Float32Array(INITIAL_VERTEX_COUNT); // Texture rotation per vertex (0 for model blocks)
  let tintTypes = new Float32Array(INITIAL_VERTEX_COUNT); // Biome tint type per vertex
  let indices = new Uint32Array(INITIAL_VERTEX_COUNT * 2);
  
  let vertexCount = 0;
  let indexCount = 0;
  let capacity = INITIAL_VERTEX_COUNT;

  const ox = offset.x, oy = offset.y, oz = offset.z;

  // Process each section that has state data
  for (const [sectionKey, stateSection] of stateGrid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(sectionKey);
    const baseX = chunkX * 16;
    const baseY = sectionToWorldY(sectionY);
    const baseZ = chunkZ * 16;

    // Get corresponding block data section
    const blockSection = grid.getSection(chunkX, chunkZ, sectionY);
    if (!blockSection) continue;

    // Process each block with state data
    for (let i = 0; i < 4096; i++) {
      const stateId = stateSection[i];
      if (stateId === 0) continue;

      const blockValue = blockSection[i];
      if (blockValue === 0) continue;

      const blockId = blockValue & BLOCK_ID_MASK;
      
      // Get pre-computed geometry
      const geometries = stateRegistry.getGeometrySync(stateId);
      if (!geometries || geometries.length === 0) continue;

      // Local coordinates
      const lx = i % 16;
      const lz = Math.floor(i / 16) % 16;
      const ly = Math.floor(i / 256);

      // World position
      const wx = baseX + lx - ox;
      const wy = baseY + ly - oy;
      const wz = baseZ + lz - oz;

      // Get block color
      const r = colorR[blockId];
      const g = colorG[blockId];
      const b = colorB[blockId];

      // Get neighbor data for face culling (only cull against full opaque cubes)
      const neighbors = getNeighborMask(grid, baseX + lx, baseY + ly, baseZ + lz, registry);

      // Compute texture rotation for blocks that need position-based or facing-based rotation
      // NOTE: Only apply to flat plane blocks - complex models use model rotation instead
      let blockTexRotation = 0;
      const state = stateRegistry.getState(stateId);
      if (state) {
        const blockName = state.blockName;
        if (POSITION_ROTATION_BLOCKS.has(blockName)) {
          // Position-based rotation for blocks like lily_pad
          blockTexRotation = getPositionRotation(baseX + lx, baseY + ly, baseZ + lz);
        } else if (FACING_TEXTURE_ROTATION_BLOCKS.has(blockName) && state.properties && state.properties.facing) {
          // Facing-based texture rotation for simple flat plane blocks like leaf_litter
          const facing = state.properties.facing;
          if (FACING_TO_ROTATION[facing] !== undefined) {
            blockTexRotation = FACING_TO_ROTATION[facing];
          }
        }
      }

      // Add geometry from all variants
      for (const geom of geometries) {
        // Check each face for culling
        for (const cullInfo of geom.cullFaces) {
          if (cullInfo.cullface && shouldCullFace(cullInfo.cullface, neighbors)) {
            continue; // Skip this face
          }

          // Ensure capacity
          const faceverts = cullInfo.indexCount / 6 * 4; // 4 verts per quad
          if (vertexCount + faceverts > capacity) {
            capacity = Math.ceil(capacity * 1.5);
            positions = growArray(positions, capacity * 3);
            normals = growArray(normals, capacity * 3);
            colors = growArray(colors, capacity * 3);
            texIndices = growArray(texIndices, capacity);
            texRotations = growArray(texRotations, capacity);
            tintTypes = growArray(tintTypes, capacity);
            indices = growArrayUint(indices, capacity * 2);
          }

          // Get texture index for this face
          // Priority: 1. Use texture from model geometry, 2. Fall back to block ID lookup
          let texIdx = 0;
          if (textureIndexLookup) {
            if (cullInfo.texture) {
              // Use the texture path from the resolved model
              texIdx = textureIndexLookup.getIndexByPath(cullInfo.texture);
            } else {
              // Fall back to block ID based lookup
              let faceDir = FACE_UP; // Default
              if (cullInfo.cullface && FACE_NAME_TO_INDEX[cullInfo.cullface] !== undefined) {
                faceDir = FACE_NAME_TO_INDEX[cullInfo.cullface];
              }
              texIdx = textureIndexLookup.getIndex(blockId, faceDir);
            }
          }

          // Copy vertices for this face
          const startIdx = cullInfo.indexStart;
          const endIdx = startIdx + cullInfo.indexCount;
          
          // Find unique vertices used by these indices
          const faceIndices = geom.indices.subarray(startIdx, endIdx);
          const vertMap = new Map(); // old index → new index
          
          for (const oldIdx of faceIndices) {
            if (vertMap.has(oldIdx)) continue;
            
            const newIdx = vertexCount++;
            vertMap.set(oldIdx, newIdx);
            
            const pi = oldIdx * 3;
            const ni = newIdx * 3;
            
            // Position (offset to world coords)
            positions[ni] = geom.positions[pi] + wx;
            positions[ni + 1] = geom.positions[pi + 1] + wy;
            positions[ni + 2] = geom.positions[pi + 2] + wz;
            
            // Normal
            normals[ni] = geom.normals[pi];
            normals[ni + 1] = geom.normals[pi + 1];
            normals[ni + 2] = geom.normals[pi + 2];
            
            // Color
            colors[ni] = r;
            colors[ni + 1] = g;
            colors[ni + 2] = b;
            
            // Texture index and rotation
            texIndices[newIdx] = texIdx;
            texRotations[newIdx] = blockTexRotation;
            // Apply tinting based on per-face tintindex from the model:
            // - tintindex >= 0: Apply block's tint type (explicit tinting)
            // - tintindex === -1: No tinting (explicitly disabled in model)
            // - tintindex undefined: Fall back to block-level tinting (backwards compat)
            let tintType = 0;
            if (cullInfo.tintindex !== undefined) {
              // Model explicitly specifies tintindex
              tintType = cullInfo.tintindex >= 0 ? tintTypeLookup[blockId] : 0;
            } else {
              // No tintindex in model - use block-level tinting as fallback
              tintType = tintTypeLookup[blockId];
            }
            tintTypes[newIdx] = tintType;
          }
          
          // Add remapped indices
          for (const oldIdx of faceIndices) {
            indices[indexCount++] = vertMap.get(oldIdx);
          }
        }
      }
    }
  }

  if (vertexCount === 0) {
    return null;
  }

  const result = {
    positions: positions.subarray(0, vertexCount * 3),
    normals: normals.subarray(0, vertexCount * 3),
    colors: colors.subarray(0, vertexCount * 3),
    indices: indices.subarray(0, indexCount),
    vertexCount,
    triangleCount: indexCount / 3,
  };
  
  // Include texture indices and rotations if texture lookup is available
  if (textureIndexLookup) {
    result.texIndices = texIndices.subarray(0, vertexCount);
    result.texRotations = texRotations.subarray(0, vertexCount);
    result.tintTypes = tintTypes.subarray(0, vertexCount);
  }
  
  return result;
}

/**
 * Get neighbor occupancy mask for face culling
 * Returns object with boolean for each direction
 * Only returns true if neighbor is a full opaque cube (not air, transparent, or non-cube)
 */
function getNeighborMask(grid, wx, wy, wz, registry) {
  const isFullOpaqueCube = (id) => {
    if (id === 0) return false;
    const info = registry.getBlockInfo(id);
    if (!info) return false;
    // Only cull if neighbor is SOLID category (full opaque cubes)
    return info.category === BlockCategory.SOLID && info.isOpaque;
  };
  
  return {
    up: isFullOpaqueCube(grid.getBlockId(wx, wy + 1, wz)),
    down: isFullOpaqueCube(grid.getBlockId(wx, wy - 1, wz)),
    north: isFullOpaqueCube(grid.getBlockId(wx, wy, wz - 1)),
    south: isFullOpaqueCube(grid.getBlockId(wx, wy, wz + 1)),
    west: isFullOpaqueCube(grid.getBlockId(wx - 1, wy, wz)),
    east: isFullOpaqueCube(grid.getBlockId(wx + 1, wy, wz)),
  };
}

/**
 * Check if a face should be culled based on neighbor
 */
function shouldCullFace(cullface, neighbors) {
  return neighbors[cullface] === true;
}

/**
 * Grow Float32Array
 */
function growArray(arr, newSize) {
  const newArr = new Float32Array(newSize);
  newArr.set(arr);
  return newArr;
}

/**
 * Grow Uint32Array
 */
function growArrayUint(arr, newSize) {
  const newArr = new Uint32Array(newSize);
  newArr.set(arr);
  return newArr;
}

/**
 * Identify blocks that need model-based rendering
 * These patterns match blocks with non-cube geometry
 * Note: '_pane' is excluded - glass panes render as cubes in the glass layer
 */
export const NON_CUBE_PATTERNS = [
  // Slabs, stairs, fences, walls, doors, trapdoors
  '_slab', '_stairs', '_fence', '_wall', '_door', '_trapdoor', 'iron_bars',
  
  // Flowers
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'rose_bush',
  'peony', 'torchflower', 'pitcher', 'pink_petals', 'spore_blossom', 'cactus_flower',
  'eyeblossom', 'wildflowers',
  
  // Grass and plants
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush',
  'seagrass', 'tall_seagrass', 'kelp', 'sugar_cane', 'cactus', 'lily_pad',
  'nether_sprouts', 'hanging_roots', 'short_dry_grass', 'tall_dry_grass', 'leaf_litter',
  'pale_hanging_moss', 'firefly_bush',
  
  // Saplings
  '_sapling', 'mangrove_propagule',
  
  // Note: Small mushrooms need a special check in the matching function
  // because their names overlap with mushroom_block which IS a full cube
  
  // Crops
  'wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush', 'nether_wart',
  'melon_stem', 'pumpkin_stem', 'cocoa',
  
  // Rails (covers rail, powered_rail, detector_rail, activator_rail)
  'rail',
  
  // Torches and lighting
  'torch', 'soul_torch', 'redstone_torch', 'lantern', 'soul_lantern',
  
  // Note: 'chain' is handled as exact match to avoid matching chain_command_block
  
  // Carpets and thin layers (note: 'snow' is exact match to avoid snow_block)
  '_carpet', 'moss_carpet',
  
  // Buttons and pressure plates
  '_button', '_pressure_plate',
  
  // Signs
  '_sign',
  
  // Misc redstone and utility
  'lever', 'ladder', 'tripwire', 'tripwire_hook', 'redstone_wire',
  
  // Vines and climbing plants
  'vine', 'weeping_vines', 'twisting_vines', 'cave_vines', 'glow_lichen',
  
  // Coral fans (small corals like tube_coral are exact matched)
  'coral_fan', 'coral_wall_fan',
  
  // Candles
  'candle',
  
  // Sculk
  'sculk_vein', 'sculk_sensor', 'sculk_shrieker', 'calibrated_sculk_sensor',
  
  // Dripleaf
  'dripleaf',
  
  // Flower pots
  'flower_pot', 'potted_',
  
  // Campfires
  'campfire', 'soul_campfire',
  
  // Utility blocks with custom models
  'anvil', 'bell', 'grindstone', 'brewing_stand', 'cauldron', 'end_rod', 'lightning_rod',
  
  // Dripstone and amethyst
  'pointed_dripstone', 'amethyst_cluster', 'amethyst_bud',
  
  // Note: 'bamboo' is handled as exact match to avoid bamboo_block, bamboo_planks, etc.
  
  // Eggs
  'turtle_egg', 'sniffer_egg', 'frogspawn', 'dragon_egg',
  
  // Chorus
  'chorus_plant', 'chorus_flower',
  
  // Sea pickle
  'sea_pickle',
  
  // Cake
  'cake',
  
  // Decorated pot
  'decorated_pot',
  
  // Heads and skulls
  '_head', '_skull',
  
  // Cobweb
  'cobweb',
  
  // Note: azalea and flowering_azalea are handled as exact matches to avoid matching azalea_leaves
  
  // Conduit
  'conduit',
  
  // Resin clump
  'resin_clump',
  
  // Beds
  '_bed',
  
  // Enchanting table and lectern
  'enchanting_table', 'lectern',
  
  // Chests
  'chest', 'ender_chest', 'trapped_chest',
  
  // Piston head
  'piston_head',
  
  // End portal frame
  'end_portal_frame',
  
  // Banner
  '_banner',
  
  // Redstone components with custom models
  'comparator', 'repeater', 'daylight_detector',
  
  // Hopper and composter
  'hopper', 'composter',
  
  // Scaffolding
  'scaffolding',
  
  // Shulker boxes (not full cubes when open)
  'shulker_box',
];

// Exact match blocks that would otherwise overlap with full cube variants
const EXACT_MATCH_NON_CUBES = new Set([
  'brown_mushroom', 'red_mushroom',  // Small mushrooms (not _block variants)
  'azalea', 'flowering_azalea',       // Azalea bushes (not azalea_leaves)
  'bamboo',                            // Bamboo plant (not bamboo_block, bamboo_planks, etc.)
  'snow',                              // Snow layers (not snow_block)
  'chain',                             // Chain item (not chain_command_block)
  // Small corals (not coral_block variants)
  'tube_coral', 'brain_coral', 'bubble_coral', 'fire_coral', 'horn_coral',
  'dead_tube_coral', 'dead_brain_coral', 'dead_bubble_coral', 'dead_fire_coral', 'dead_horn_coral',
]);

/**
 * Check if a block name needs model-based rendering
 */
export function isNonCubeBlock(blockName) {
  const name = blockName.replace('minecraft:', '');
  
  // Check exact matches first
  if (EXACT_MATCH_NON_CUBES.has(name)) {
    return true;
  }
  
  // Pattern-based matching
  return NON_CUBE_PATTERNS.some(pattern => name.includes(pattern));
}

export default buildModelMeshes;

