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

// Patterns for transparent partial blocks that need special rendering
// These blocks use single-sided rendering with transparency (defined here for use in buildModelMeshes)
const TRANSPARENT_MODEL_PATTERNS = ['_pane', 'iron_bars'];

// LOD Level definitions for partial blocks
// LOD 0 = full detail (all blocks)
// LOD 1 = skip small decorative blocks (flowers, grass, small plants)
// LOD 2 = skip more blocks (add vines, saplings, crops)
// LOD 3 = skip most non-structural (only keep slabs, stairs, walls)

// Decorative blocks to skip at LOD level 1+ (patterns)
const LOD1_SKIP_PATTERNS = [
  // Flowers
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'rose_bush',
  'peony', 'torchflower', 'pitcher', 'pink_petals', 'spore_blossom', 'cactus_flower',
  'eyeblossom', 'wildflowers',
  // Grass and small plants
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush',
  'nether_sprouts', 'hanging_roots', 'short_dry_grass', 'tall_dry_grass', 'leaf_litter',
];

// Additional blocks to skip at LOD level 2+ (patterns)
const LOD2_SKIP_PATTERNS = [
  ...LOD1_SKIP_PATTERNS,
  // Vines and climbing plants
  'vine', 'weeping_vines', 'twisting_vines', 'cave_vines', 'glow_lichen',
  'pale_hanging_moss', 'firefly_bush',
  // Saplings
  '_sapling', 'mangrove_propagule',
  // Crops
  'wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush', 'nether_wart',
  'melon_stem', 'pumpkin_stem', 'cocoa',
  // Candles and small items
  'candle', 'sea_pickle', 'lily_pad',
];

// Additional blocks to skip at LOD level 3+ (patterns)
const LOD3_SKIP_PATTERNS = [
  ...LOD2_SKIP_PATTERNS,
  // Fences and bars
  '_fence', 'iron_bars',
  // Rails
  'rail',
  // Torches
  'torch', 'soul_torch', 'redstone_torch',
  // Signs
  '_sign',
  // Small redstone
  'lever', 'tripwire', 'tripwire_hook', 'redstone_wire',
  '_button', '_pressure_plate',
];

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
 * @param {number} options.lodLevel - LOD level (0=full, 1-3=reduced detail)
 * @returns {Object} Mesh data {positions, normals, colors, indices, texIndices}
 */
export function buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  const { textureIndexLookup = null, lodLevel = 0 } = options;
  
  // Select skip patterns based on LOD level
  let skipPatterns = null;
  if (lodLevel >= 3) {
    skipPatterns = LOD3_SKIP_PATTERNS;
  } else if (lodLevel >= 2) {
    skipPatterns = LOD2_SKIP_PATTERNS;
  } else if (lodLevel >= 1) {
    skipPatterns = LOD1_SKIP_PATTERNS;
  }
  
  // Build lookup tables for colors and full opaque cube detection
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  const isFullOpaqueCube = new Uint8Array(4096); // Pre-compute for fast neighbor checks
  
  for (let id = 0; id < 4096; id++) {
    const col = registry.getColor(id);
    colorR[id] = col.r;
    colorG[id] = col.g;
    colorB[id] = col.b;
    
    // Pre-compute "is full opaque cube" for neighbor culling
    const info = registry.getBlockInfo(id);
    if (info && info.category === BlockCategory.SOLID && info.isOpaque) {
      isFullOpaqueCube[id] = 1;
    }
  }
  
  // Build tint type lookup for biome tinting
  const tintTypeLookup = buildTintTypeLookup(registry);

  // ========================================================================
  // PRE-CACHE: Collect all unique state IDs and pre-compute their metadata
  // This avoids repeated Map lookups and object property access in the hot loop
  // ========================================================================
  const maxStateId = stateRegistry.nextId || 4096;
  
  // Pre-cache arrays indexed by stateId for O(1) lookup
  // Using arrays instead of Maps for faster indexed access
  const stateGeometries = new Array(maxStateId);     // stateId → geometry array or null
  const stateRotationType = new Uint8Array(maxStateId); // 0=none, 1=position-based, 2=facing-based
  const stateFacingRotation = new Uint8Array(maxStateId); // Pre-computed facing rotation for facing-based blocks
  
  // Slab optimization: track slab types for enhanced face culling
  // 0 = not a slab, 1 = bottom slab, 2 = top slab, 3 = double slab
  const stateSlabType = new Uint8Array(maxStateId);
  
  // Transparent model detection: glass panes, iron bars, etc.
  const stateIsTransparent = new Uint8Array(maxStateId);
  
  // Collect unique state IDs from the grid
  for (const [, stateSection] of stateGrid.sections) {
    for (let i = 0; i < 4096; i++) {
      const stateId = stateSection[i];
      if (stateId === 0 || stateGeometries[stateId] !== undefined) continue;
      
      // Get state info first for LOD check
      const state = stateRegistry.getState(stateId);
      const blockName = state ? state.blockName : '';
      
      // LOD optimization: skip decorative blocks based on LOD level
      if (skipPatterns && blockName) {
        const shouldSkip = skipPatterns.some(pattern => blockName.includes(pattern));
        if (shouldSkip) {
          stateGeometries[stateId] = null; // Mark as skipped
          continue;
        }
      }
      
      // Mark as processed (even if null)
      const geometries = stateRegistry.getGeometrySync(stateId);
      stateGeometries[stateId] = geometries && geometries.length > 0 ? geometries : null;
      
      // Pre-compute rotation type and slab type
      if (state) {
        if (POSITION_ROTATION_BLOCKS.has(blockName)) {
          stateRotationType[stateId] = 1; // Position-based
        } else if (FACING_TEXTURE_ROTATION_BLOCKS.has(blockName)) {
          stateRotationType[stateId] = 2; // Facing-based
          // Pre-compute facing rotation
          if (state.properties && state.properties.facing) {
            const rot = FACING_TO_ROTATION[state.properties.facing];
            stateFacingRotation[stateId] = rot !== undefined ? rot : 0;
          }
        }
        
        // Detect slab type for enhanced face culling
        if (blockName.includes('_slab') && state.properties) {
          const slabType = state.properties.type;
          if (slabType === 'bottom') stateSlabType[stateId] = 1;
          else if (slabType === 'top') stateSlabType[stateId] = 2;
          else if (slabType === 'double') stateSlabType[stateId] = 3;
        }
        
        // Detect transparent model blocks (glass panes, iron bars)
        if (TRANSPARENT_MODEL_PATTERNS.some(pattern => blockName.includes(pattern))) {
          stateIsTransparent[stateId] = 1;
        }
      }
    }
  }

  // Growable buffers for OPAQUE models
  let positions = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let normals = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let colors = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let modelUVs = new Float32Array(INITIAL_VERTEX_COUNT * 2); // Model UV coordinates per vertex
  let texIndices = new Float32Array(INITIAL_VERTEX_COUNT); // Texture atlas index per vertex
  let texRotations = new Float32Array(INITIAL_VERTEX_COUNT); // Texture rotation per vertex (0 for model blocks)
  let tintTypes = new Float32Array(INITIAL_VERTEX_COUNT); // Biome tint type per vertex
  let indices = new Uint32Array(INITIAL_VERTEX_COUNT * 2);
  
  let vertexCount = 0;
  let indexCount = 0;
  let capacity = INITIAL_VERTEX_COUNT;

  // Growable buffers for TRANSPARENT models (glass panes, iron bars)
  let tPositions = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let tNormals = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let tColors = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let tModelUVs = new Float32Array(INITIAL_VERTEX_COUNT * 2);
  let tTexIndices = new Float32Array(INITIAL_VERTEX_COUNT);
  let tTexRotations = new Float32Array(INITIAL_VERTEX_COUNT);
  let tTintTypes = new Float32Array(INITIAL_VERTEX_COUNT);
  let tIndices = new Uint32Array(INITIAL_VERTEX_COUNT * 2);
  
  let tVertexCount = 0;
  let tIndexCount = 0;
  let tCapacity = INITIAL_VERTEX_COUNT;

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

    // Pre-fetch all 6 neighbor sections once per section (avoids repeated Map lookups)
    const secTop = grid.getSection(chunkX, chunkZ, sectionY + 1);
    const secBot = grid.getSection(chunkX, chunkZ, sectionY - 1);
    const secPosX = grid.getSection(chunkX + 1, chunkZ, sectionY);
    const secNegX = grid.getSection(chunkX - 1, chunkZ, sectionY);
    const secPosZ = grid.getSection(chunkX, chunkZ + 1, sectionY);
    const secNegZ = grid.getSection(chunkX, chunkZ - 1, sectionY);

    // Process each block with state data
    for (let i = 0; i < 4096; i++) {
      const stateId = stateSection[i];
      if (stateId === 0) continue;

      // Fast array lookup instead of Map lookup
      const geometries = stateGeometries[stateId];
      if (!geometries) continue;

      const blockValue = blockSection[i];
      if (blockValue === 0) continue;

      const blockId = blockValue & BLOCK_ID_MASK;

      // Local coordinates (bitwise ops are faster than modulo/floor)
      const lx = i & 15;           // i % 16
      const lz = (i >> 4) & 15;    // Math.floor(i / 16) % 16
      const ly = i >> 8;           // Math.floor(i / 256)

      // World position
      const wx = baseX + lx - ox;
      const wy = baseY + ly - oy;
      const wz = baseZ + lz - oz;

      // Get block color
      const r = colorR[blockId];
      const g = colorG[blockId];
      const b = colorB[blockId];

      // ========================================================================
      // FAST NEIGHBOR LOOKUP: Direct array access instead of getBlockId() calls
      // Uses pre-fetched sections and pre-computed isFullOpaqueCube lookup
      // ========================================================================
      let nUp = 0, nDown = 0, nNorth = 0, nSouth = 0, nWest = 0, nEast = 0;
      
      // Current block's slab type for enhanced culling
      const mySlabType = stateSlabType[stateId];
      
      // +Y neighbor (up)
      if (ly < 15) {
        nUp = isFullOpaqueCube[blockSection[i + 256] & BLOCK_ID_MASK];
        // Slab optimization: bottom slab's top face is covered by top slab above
        if (!nUp && mySlabType === 1) { // Current is bottom slab
          const neighborStateId = stateSection[i + 256];
          if (neighborStateId && stateSlabType[neighborStateId] === 2) { // Neighbor is top slab
            nUp = 1; // Cull the up face
          }
        }
      } else if (secTop) {
        nUp = isFullOpaqueCube[secTop[lz * 16 + lx] & BLOCK_ID_MASK];
      }
      
      // -Y neighbor (down)
      if (ly > 0) {
        nDown = isFullOpaqueCube[blockSection[i - 256] & BLOCK_ID_MASK];
        // Slab optimization: top slab's bottom face is covered by bottom slab below
        if (!nDown && mySlabType === 2) { // Current is top slab
          const neighborStateId = stateSection[i - 256];
          if (neighborStateId && stateSlabType[neighborStateId] === 1) { // Neighbor is bottom slab
            nDown = 1; // Cull the down face
          }
        }
      } else if (secBot) {
        nDown = isFullOpaqueCube[secBot[15 * 256 + lz * 16 + lx] & BLOCK_ID_MASK];
      }
      
      // +Z neighbor (south)
      if (lz < 15) {
        nSouth = isFullOpaqueCube[blockSection[i + 16] & BLOCK_ID_MASK];
      } else if (secPosZ) {
        nSouth = isFullOpaqueCube[secPosZ[ly * 256 + lx] & BLOCK_ID_MASK];
      }
      
      // -Z neighbor (north)
      if (lz > 0) {
        nNorth = isFullOpaqueCube[blockSection[i - 16] & BLOCK_ID_MASK];
      } else if (secNegZ) {
        nNorth = isFullOpaqueCube[secNegZ[ly * 256 + 15 * 16 + lx] & BLOCK_ID_MASK];
      }
      
      // +X neighbor (east)
      if (lx < 15) {
        nEast = isFullOpaqueCube[blockSection[i + 1] & BLOCK_ID_MASK];
      } else if (secPosX) {
        nEast = isFullOpaqueCube[secPosX[ly * 256 + lz * 16] & BLOCK_ID_MASK];
      }
      
      // -X neighbor (west)
      if (lx > 0) {
        nWest = isFullOpaqueCube[blockSection[i - 1] & BLOCK_ID_MASK];
      } else if (secNegX) {
        nWest = isFullOpaqueCube[secNegX[ly * 256 + lz * 16 + 15] & BLOCK_ID_MASK];
      }

      // Compute texture rotation using pre-cached rotation type
      let blockTexRotation = 0;
      const rotType = stateRotationType[stateId];
      if (rotType === 1) {
        // Position-based rotation for blocks like lily_pad
        blockTexRotation = getPositionRotation(baseX + lx, baseY + ly, baseZ + lz);
      } else if (rotType === 2) {
        // Pre-computed facing-based rotation
        blockTexRotation = stateFacingRotation[stateId];
      }

      // Determine if this block uses transparent or opaque buffer
      const isTransparent = stateIsTransparent[stateId];

      // Add geometry from all variants
      for (const geom of geometries) {
        // Check each face for culling
        for (const cullInfo of geom.cullFaces) {
          // Fast inline face culling using pre-computed neighbor data
          if (cullInfo.cullface) {
            const cf = cullInfo.cullface;
            if ((cf === 'up' && nUp) || (cf === 'down' && nDown) ||
                (cf === 'north' && nNorth) || (cf === 'south' && nSouth) ||
                (cf === 'west' && nWest) || (cf === 'east' && nEast)) {
              continue; // Skip this face - neighbor is full opaque cube
            }
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

          // Get the first source vertex index from the geometry
          const srcVertexStart = geom.indices[cullInfo.indexStart];
          
          // Compute tint type once per face
          let tintType = 0;
          if (cullInfo.tintindex !== undefined) {
            tintType = cullInfo.tintindex >= 0 ? tintTypeLookup[blockId] : 0;
          } else {
            tintType = tintTypeLookup[blockId];
          }
          
          // Route to appropriate buffer set based on transparency
          if (isTransparent) {
            // Ensure capacity for transparent buffers
            const faceverts = cullInfo.indexCount / 6 * 4; // 4 verts per quad
            if (tVertexCount + faceverts > tCapacity) {
              tCapacity = Math.ceil(tCapacity * 1.5);
              tPositions = growArray(tPositions, tCapacity * 3);
              tNormals = growArray(tNormals, tCapacity * 3);
              tColors = growArray(tColors, tCapacity * 3);
              tModelUVs = growArray(tModelUVs, tCapacity * 2);
              tTexIndices = growArray(tTexIndices, tCapacity);
              tTexRotations = growArray(tTexRotations, tCapacity);
              tTintTypes = growArray(tTintTypes, tCapacity);
              tIndices = growArrayUint(tIndices, tCapacity * 2);
            }

            const dstVertexStart = tVertexCount;
            
            // Copy all 4 vertices to transparent buffer
            for (let v = 0; v < 4; v++) {
              const srcIdx = srcVertexStart + v;
              const dstIdx = tVertexCount++;
              
              const pi = srcIdx * 3;
              const ni = dstIdx * 3;
              const ui = srcIdx * 2;
              const uo = dstIdx * 2;
              
              tPositions[ni] = geom.positions[pi] + wx;
              tPositions[ni + 1] = geom.positions[pi + 1] + wy;
              tPositions[ni + 2] = geom.positions[pi + 2] + wz;
              
              tNormals[ni] = geom.normals[pi];
              tNormals[ni + 1] = geom.normals[pi + 1];
              tNormals[ni + 2] = geom.normals[pi + 2];
              
              tColors[ni] = r;
              tColors[ni + 1] = g;
              tColors[ni + 2] = b;
              
              if (geom.uvs) {
                tModelUVs[uo] = geom.uvs[ui];
                tModelUVs[uo + 1] = geom.uvs[ui + 1];
              }
              
              tTexIndices[dstIdx] = texIdx;
              tTexRotations[dstIdx] = blockTexRotation;
              tTintTypes[dstIdx] = tintType;
            }
            
            // Emit indices for transparent mesh
            tIndices[tIndexCount++] = dstVertexStart;
            tIndices[tIndexCount++] = dstVertexStart + 2;
            tIndices[tIndexCount++] = dstVertexStart + 1;
            tIndices[tIndexCount++] = dstVertexStart;
            tIndices[tIndexCount++] = dstVertexStart + 3;
            tIndices[tIndexCount++] = dstVertexStart + 2;
          } else {
            // Ensure capacity for opaque buffers
            const faceverts = cullInfo.indexCount / 6 * 4; // 4 verts per quad
            if (vertexCount + faceverts > capacity) {
              capacity = Math.ceil(capacity * 1.5);
              positions = growArray(positions, capacity * 3);
              normals = growArray(normals, capacity * 3);
              colors = growArray(colors, capacity * 3);
              modelUVs = growArray(modelUVs, capacity * 2);
              texIndices = growArray(texIndices, capacity);
              texRotations = growArray(texRotations, capacity);
              tintTypes = growArray(tintTypes, capacity);
              indices = growArrayUint(indices, capacity * 2);
            }

            const dstVertexStart = vertexCount;
            
            // Copy all 4 vertices to opaque buffer
            for (let v = 0; v < 4; v++) {
              const srcIdx = srcVertexStart + v;
              const dstIdx = vertexCount++;
              
              const pi = srcIdx * 3;
              const ni = dstIdx * 3;
              const ui = srcIdx * 2;
              const uo = dstIdx * 2;
              
              positions[ni] = geom.positions[pi] + wx;
              positions[ni + 1] = geom.positions[pi + 1] + wy;
              positions[ni + 2] = geom.positions[pi + 2] + wz;
              
              normals[ni] = geom.normals[pi];
              normals[ni + 1] = geom.normals[pi + 1];
              normals[ni + 2] = geom.normals[pi + 2];
              
              colors[ni] = r;
              colors[ni + 1] = g;
              colors[ni + 2] = b;
              
              if (geom.uvs) {
                modelUVs[uo] = geom.uvs[ui];
                modelUVs[uo + 1] = geom.uvs[ui + 1];
              }
              
              texIndices[dstIdx] = texIdx;
              texRotations[dstIdx] = blockTexRotation;
              tintTypes[dstIdx] = tintType;
            }
            
            // Emit indices for opaque mesh
            indices[indexCount++] = dstVertexStart;
            indices[indexCount++] = dstVertexStart + 2;
            indices[indexCount++] = dstVertexStart + 1;
            indices[indexCount++] = dstVertexStart;
            indices[indexCount++] = dstVertexStart + 3;
            indices[indexCount++] = dstVertexStart + 2;
          }
        }
      }
    }
  }

  // Build result object with opaque and transparent meshes
  const opaqueResult = vertexCount > 0 ? {
    positions: positions.subarray(0, vertexCount * 3),
    normals: normals.subarray(0, vertexCount * 3),
    colors: colors.subarray(0, vertexCount * 3),
    modelUVs: modelUVs.subarray(0, vertexCount * 2),
    indices: indices.subarray(0, indexCount),
    vertexCount,
    triangleCount: indexCount / 3,
  } : null;
  
  const transparentResult = tVertexCount > 0 ? {
    positions: tPositions.subarray(0, tVertexCount * 3),
    normals: tNormals.subarray(0, tVertexCount * 3),
    colors: tColors.subarray(0, tVertexCount * 3),
    modelUVs: tModelUVs.subarray(0, tVertexCount * 2),
    indices: tIndices.subarray(0, tIndexCount),
    vertexCount: tVertexCount,
    triangleCount: tIndexCount / 3,
  } : null;
  
  // Add texture data if available
  if (textureIndexLookup) {
    if (opaqueResult) {
      opaqueResult.texIndices = texIndices.subarray(0, vertexCount);
      opaqueResult.texRotations = texRotations.subarray(0, vertexCount);
      opaqueResult.tintTypes = tintTypes.subarray(0, vertexCount);
    }
    if (transparentResult) {
      transparentResult.texIndices = tTexIndices.subarray(0, tVertexCount);
      transparentResult.texRotations = tTexRotations.subarray(0, tVertexCount);
      transparentResult.tintTypes = tTintTypes.subarray(0, tVertexCount);
    }
  }
  
  // Return null if no geometry was generated
  if (!opaqueResult && !transparentResult) {
    return null;
  }
  
  // Return split meshes for opaque and transparent models
  return {
    opaque: opaqueResult,
    transparent: transparentResult,
  };
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
 * Glass panes and iron bars are included - they use multipart model rendering
 */
export const NON_CUBE_PATTERNS = [
  // Slabs, stairs, fences, walls, doors, trapdoors, panes
  '_slab', '_stairs', '_fence', '_wall', '_door', '_trapdoor', '_pane', 'iron_bars',
  
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
  'beacon',                            // Multi-element block (glass shell, obsidian base, beacon core)
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

// Re-export transparent patterns for external use
export { TRANSPARENT_MODEL_PATTERNS };

/**
 * Check if a block is a transparent model block (glass panes, iron bars, etc.)
 */
export function isTransparentModelBlock(blockName) {
  const name = blockName.replace('minecraft:', '');
  return TRANSPARENT_MODEL_PATTERNS.some(pattern => name.includes(pattern));
}
