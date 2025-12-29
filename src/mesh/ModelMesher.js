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

// Map face name to face index constant
const FACE_NAME_TO_INDEX = {
  'up': FACE_UP,
  'down': FACE_DOWN,
  'north': FACE_NORTH,
  'south': FACE_SOUTH,
  'east': FACE_EAST,
  'west': FACE_WEST,
};

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

  // Growable buffers
  let positions = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let normals = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let colors = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let texIndices = new Float32Array(INITIAL_VERTEX_COUNT); // Texture atlas index per vertex
  let texRotations = new Float32Array(INITIAL_VERTEX_COUNT); // Texture rotation per vertex (0 for model blocks)
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
            indices = growArrayUint(indices, capacity * 2);
          }

          // Determine face direction for texture lookup
          // Use cullface if available, otherwise guess from the first face's geometry
          let faceDir = FACE_UP; // Default
          if (cullInfo.cullface && FACE_NAME_TO_INDEX[cullInfo.cullface] !== undefined) {
            faceDir = FACE_NAME_TO_INDEX[cullInfo.cullface];
          }
          
          // Get texture index for this face
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(blockId, faceDir) : 0;

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
            
            // Texture index and rotation (0 = no rotation for model blocks)
            texIndices[newIdx] = texIdx;
            texRotations[newIdx] = 0;
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
 */
export const NON_CUBE_PATTERNS = [
  // Slabs
  '_slab',
  // Stairs
  '_stairs',
  // Fences and walls
  '_fence', '_wall',
  // Doors and trapdoors
  '_door', '_trapdoor',
  // Glass panes and iron bars
  '_pane', 'iron_bars',
  // Plants and flowers
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'torchflower', 'pitcher',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'seagrass', 'tall_seagrass', 'kelp',
  // Saplings
  '_sapling', 'mangrove_propagule',
  // Mushrooms (not blocks)
  'brown_mushroom', 'red_mushroom',
  // Crops
  'wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush',
  'melon_stem', 'pumpkin_stem', 'cocoa',
  // Rails
  '_rail',
  // Torches
  'torch', 'soul_torch', 'redstone_torch',
  // Lanterns
  'lantern', 'soul_lantern',
  // Chains
  'chain',
  // Carpets
  '_carpet',
  // Snow
  'snow',
  // Buttons and pressure plates
  '_button', '_pressure_plate',
  // Signs
  '_sign',
  // Levers
  'lever',
  // Ladders
  'ladder',
  // Vines
  'vine', 'weeping_vines', 'twisting_vines', 'cave_vines', 'glow_lichen',
  // Coral
  'coral', 'coral_fan',
  // Candles
  'candle',
  // Sculk
  'sculk_vein', 'sculk_sensor', 'sculk_shrieker',
  // Dripleaf
  'dripleaf',
  // Misc
  'flower_pot', 'potted_',
  'campfire', 'soul_campfire',
  'anvil', 'bell', 'grindstone',
  'brewing_stand', 'cauldron',
  'end_rod', 'lightning_rod',
  'pointed_dripstone',
  'amethyst_cluster', 'amethyst_bud',
  'bamboo',
];

/**
 * Check if a block name needs model-based rendering
 */
export function isNonCubeBlock(blockName) {
  const name = blockName.replace('minecraft:', '');
  return NON_CUBE_PATTERNS.some(pattern => name.includes(pattern));
}

export default buildModelMeshes;

