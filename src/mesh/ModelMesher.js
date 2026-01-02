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

// DEBUG: Blocks to skip rendering (for testing/debugging)
// Add block names here to temporarily disable their rendering
const DEBUG_SKIP_BLOCKS = new Set([
  // 'mangrove_roots',
]);

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

// Cross-model blocks that should have their MODEL rotated (not just texture)
// These are plants with X-shaped cross models that look better with random Y rotation
const MODEL_ROTATION_BLOCKS = new Set([
  // Grass and ferns
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  // Nether vegetation
  'nether_sprouts', 'crimson_roots', 'warped_roots',
  // Flowers (cross-model type)
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower', 'pink_petals', 'eyeblossom',
  // Dead plants
  'dead_bush',
  // Saplings
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'pale_oak_sapling',
  // Cave plants
  'hanging_roots', 'spore_blossom',
  // Mushrooms (small)
  'red_mushroom', 'brown_mushroom', 'crimson_fungus', 'warped_fungus',
  // Sea pickle (has 4 rotation variants in blockstate)
  'sea_pickle',
  // Path blocks (15 pixels tall, have 4 rotation variants that cause z-fighting if duplicated)
  'dirt_path', 'farmland',
]);

// Blocks that should have random XZ position offset within their block
// These are small plants that look more natural when not perfectly centered
// Offset is up to 0.25 blocks (4 pixels) in X and Z
const POSITION_OFFSET_BLOCKS = new Set([
  // Grass and small plants
  'short_grass', 'fern',
  // Small flowers
  'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'torchflower',
  // Nether small plants
  'nether_sprouts', 'crimson_roots', 'warped_roots',
  // Cave plants
  'hanging_roots',
  // Mushrooms
  'red_mushroom', 'brown_mushroom', 'crimson_fungus', 'warped_fungus',
  // Saplings
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling',
]);

// Facing direction to rotation value mapping (for blocks using facing property)
const FACING_TO_ROTATION = {
  'north': 0,
  'east': 1,
  'south': 2,
  'west': 3,
};

// Patterns for transparent PARTIAL blocks that need special rendering
// These blocks use single-sided rendering with transparency (defined here for use in buildModelMeshes)
// Note: Full cube transparent blocks (ice, glass) are handled by FastMesher, not here
const TRANSPARENT_MODEL_PATTERNS = [
  '_pane',           // Glass panes (all stained variants)
  'iron_bars',       // Iron bars
  'copper_bars',     // Copper bars
  'slime_block',     // Translucent with inner cube
  'honey_block',     // Translucent with inner cube
  'nether_portal',   // Portal effect
  'powder_snow',     // Hollow translucent block
  'mangrove_roots',  // See-through roots
];

// Edge threshold for determining if a face is at the block boundary
const EDGE_THRESHOLD = 0.01;

// Coverage regions for partial blocks - defines which portions of a block are "solid"
// Each entry is [minY, maxY] representing the Y range covered (0-1)
// For same-half stairs/slabs adjacent horizontally, if their Y coverage overlaps, cull the shared face
const SLAB_COVERAGE = {
  bottom: { minY: 0, maxY: 0.5 },
  top: { minY: 0.5, maxY: 1.0 },
  double: { minY: 0, maxY: 1.0 },
};

// For stairs, coverage depends on facing and whether we're looking at the "full" or "step" side
// Full side (back) covers full height for half the block
// Step side covers half height for the other half
// For simplicity, we treat same-half same-facing stairs as fully covering shared faces

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
  'crimson_roots', 'warped_roots', 'crimson_fungus', 'warped_fungus', // Nether cross-model plants
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
  '_fence', 'iron_bars', 'copper_bars',
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
 * Compute position-based XZ offset for small plants
 * Returns an offset in the range [-0.25, 0.25] for X and Z
 * Uses the same position hash as rotation for consistency
 * @param {number} x - World X coordinate
 * @param {number} y - World Y coordinate  
 * @param {number} z - World Z coordinate
 * @returns {{dx: number, dz: number}} Offset values in block units
 */
function getPositionOffset(x, y, z) {
  const ix = x | 0;
  const iy = y | 0;
  const iz = z | 0;
  
  // Use Minecraft's position hash
  const xPart = BigInt(Math.imul(ix, 3129871));
  const zPart = BigInt(iz) * 116129781n;
  const yPart = BigInt(iy);
  
  let l = xPart ^ zPart ^ yPart;
  l = l * l * 42317861n + l * 11n;
  const seed = l >> 16n;
  
  // Java Random simulation for two values
  const MULT = 0x5DEECE66Dn;
  const MASK = (1n << 48n) - 1n;
  
  let rng = (seed ^ MULT) & MASK;
  
  // First random value for X offset
  rng = (rng * MULT + 0xBn) & MASK;
  const xRand = Number((rng >> 17n) & 0x7FFFn) / 32767.0; // 0 to 1
  
  // Second random value for Z offset
  rng = (rng * MULT + 0xBn) & MASK;
  const zRand = Number((rng >> 17n) & 0x7FFFn) / 32767.0; // 0 to 1
  
  // Map to [-0.25, 0.25] range (Minecraft's typical offset range)
  return {
    dx: (xRand - 0.5) * 0.5, // -0.25 to 0.25
    dz: (zRand - 0.5) * 0.5  // -0.25 to 0.25
  };
}

/**
 * Rotate a vertex position around Y axis by 90-degree increments
 * @param {number} vx - Vertex X (relative to block center 0.5)
 * @param {number} vz - Vertex Z (relative to block center 0.5)
 * @param {number} rotation - 0=0°, 1=90°, 2=180°, 3=270°
 * @returns {{rx: number, rz: number}} Rotated position
 */
function rotateVertexY(vx, vz, rotation) {
  // Rotate around block center (0.5, 0.5)
  const cx = vx - 0.5;
  const cz = vz - 0.5;
  
  switch (rotation) {
    case 1: // 90° clockwise
      return { rx: -cz + 0.5, rz: cx + 0.5 };
    case 2: // 180°
      return { rx: -cx + 0.5, rz: -cz + 0.5 };
    case 3: // 270° clockwise (90° counter-clockwise)
      return { rx: cz + 0.5, rz: -cx + 0.5 };
    default: // 0° - no rotation
      return { rx: vx, rz: vz };
  }
}

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
// Use larger initial allocation to reduce resize operations
const INITIAL_VERTEX_COUNT = 200000;

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
 * @param {LightGrid} options.lightGrid - Light grid for per-vertex lighting
 * @returns {Object} Mesh data {positions, normals, colors, indices, texIndices, skyLight, blockLight}
 */
export function buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  const { textureIndexLookup = null, lodLevel = 0, lightGrid = null } = options;
  
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
  const stateHasModelRotation = new Uint8Array(maxStateId); // 1 if block should have model Y-rotation
  const stateHasPositionOffset = new Uint8Array(maxStateId); // 1 if block should have XZ position offset
  
  // Slab optimization: track slab types for enhanced face culling
  // 0 = not a slab, 1 = bottom slab, 2 = top slab, 3 = double slab
  const stateSlabType = new Uint8Array(maxStateId);
  
  // Stair optimization: track stair properties for enhanced face culling
  // Encode: facing (0-3 for N/S/E/W) + half (0=bottom, 4=top)
  // 0 = not a stair, 1-8 = valid stair configurations
  const stateStairType = new Uint8Array(maxStateId);
  
  // Track stair facing direction for back-face culling
  // 0=north, 1=south, 2=east, 3=west (the direction the stair "faces" - open side)
  const stateStairFacing = new Uint8Array(maxStateId);
  
  // Track stair half: 0=bottom (normal), 1=top (upside-down)
  const stateStairHalf = new Uint8Array(maxStateId);
  
  // Track wall/fence blocks - same type adjacent can cull shared faces
  // Value is a unique ID per wall/fence material type
  const stateWallType = new Uint16Array(maxStateId);
  const stateFenceType = new Uint16Array(maxStateId);
  let nextWallTypeId = 1;
  let nextFenceTypeId = 1;
  const wallTypeMap = new Map(); // blockName → typeId
  const fenceTypeMap = new Map(); // blockName → typeId
  
  // Track blocks that are "opaque for their occupied portion"
  // These can cull faces of adjacent partial blocks when they overlap
  const stateIsPartialOpaque = new Uint8Array(maxStateId);
  
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
      
      // DEBUG: Skip specific blocks for testing
      if (DEBUG_SKIP_BLOCKS.has(blockName)) {
        stateGeometries[stateId] = null;
        continue;
      }
      
      // Mark as processed (even if null)
      const geometries = stateRegistry.getGeometrySync(stateId);
      stateGeometries[stateId] = geometries && geometries.length > 0 ? geometries : null;
      
      // Pre-compute rotation type and slab type
      if (state) {
        if (POSITION_ROTATION_BLOCKS.has(blockName)) {
          stateRotationType[stateId] = 1; // Position-based texture rotation
        } else if (FACING_TEXTURE_ROTATION_BLOCKS.has(blockName)) {
          stateRotationType[stateId] = 2; // Facing-based texture rotation
          // Pre-compute facing rotation
          if (state.properties && state.properties.facing) {
            const rot = FACING_TO_ROTATION[state.properties.facing];
            stateFacingRotation[stateId] = rot !== undefined ? rot : 0;
          }
        }
        
        // Check for model Y-rotation (cross-model plants)
        if (MODEL_ROTATION_BLOCKS.has(blockName)) {
          stateHasModelRotation[stateId] = 1;
        }
        
        // Check for position XZ offset (small plants)
        if (POSITION_OFFSET_BLOCKS.has(blockName)) {
          stateHasPositionOffset[stateId] = 1;
        }
        
        // Detect slab type for enhanced face culling
        if (blockName.includes('_slab') && state.properties) {
          const slabType = state.properties.type;
          if (slabType === 'bottom') {
            stateSlabType[stateId] = 1;
            stateIsPartialOpaque[stateId] = 1;
          } else if (slabType === 'top') {
            stateSlabType[stateId] = 2;
            stateIsPartialOpaque[stateId] = 1;
          } else if (slabType === 'double') {
            stateSlabType[stateId] = 3;
            stateIsPartialOpaque[stateId] = 1;
          }
        }
        
        // Detect stair type for enhanced face culling
        if (blockName.includes('_stairs') && state.properties) {
          stateIsPartialOpaque[stateId] = 1;
          // Encode stair facing + half for culling decisions
          // This allows us to cull faces between adjacent stairs
          const facing = state.properties.facing || 'north';
          const half = state.properties.half || 'bottom';
          const facingCode = { north: 0, south: 1, east: 2, west: 3 }[facing] || 0;
          const halfCode = half === 'top' ? 1 : 0;
          stateStairType[stateId] = 1 + facingCode + halfCode * 4;
          stateStairFacing[stateId] = facingCode; // 0=N, 1=S, 2=E, 3=W
          stateStairHalf[stateId] = halfCode; // 0=bottom, 1=top
        }
        
        // Detect wall blocks for wall-to-wall culling
        if (blockName.includes('_wall')) {
          stateIsPartialOpaque[stateId] = 1;
          if (!wallTypeMap.has(blockName)) {
            wallTypeMap.set(blockName, nextWallTypeId++);
          }
          stateWallType[stateId] = wallTypeMap.get(blockName);
        }
        
        // Detect fence blocks for fence-to-fence culling
        if (blockName.includes('_fence') && !blockName.includes('_fence_gate')) {
          stateIsPartialOpaque[stateId] = 1;
          if (!fenceTypeMap.has(blockName)) {
            fenceTypeMap.set(blockName, nextFenceTypeId++);
          }
          stateFenceType[stateId] = fenceTypeMap.get(blockName);
        }
        
        // Detect transparent model blocks (glass panes, iron bars, slime, honey, etc.)
        // Note: packed_ice and blue_ice are OPAQUE, not transparent
        const isPackedOrBlueIce = blockName.includes('packed_ice') || blockName.includes('blue_ice');
        if (!isPackedOrBlueIce && TRANSPARENT_MODEL_PATTERNS.some(pattern => blockName.includes(pattern))) {
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
  let shadeFlags = new Float32Array(INITIAL_VERTEX_COUNT); // Face shading flag per vertex (0=no shade, 1=shade)
  let singleSidedFlags = new Float32Array(INITIAL_VERTEX_COUNT); // Single-sided flag per vertex (0=double-sided, 1=cull backface)
  let skyLightArr = new Float32Array(INITIAL_VERTEX_COUNT); // Sky light per vertex (0-15)
  let blockLightArr = new Float32Array(INITIAL_VERTEX_COUNT); // Block light per vertex (0-15)
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
  let tShadeFlags = new Float32Array(INITIAL_VERTEX_COUNT);
  let tSingleSidedFlags = new Float32Array(INITIAL_VERTEX_COUNT);
  let tSkyLight = new Float32Array(INITIAL_VERTEX_COUNT);
  let tBlockLight = new Float32Array(INITIAL_VERTEX_COUNT);
  let tIndices = new Uint32Array(INITIAL_VERTEX_COUNT * 2);
  
  let tVertexCount = 0;
  let tIndexCount = 0;
  let tCapacity = INITIAL_VERTEX_COUNT;

  // Growable buffers for OVERLAY models (torch bulb glow panels - rendered with depthWrite: false)
  let oPositions = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let oNormals = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let oColors = new Float32Array(INITIAL_VERTEX_COUNT * 3);
  let oModelUVs = new Float32Array(INITIAL_VERTEX_COUNT * 2);
  let oTexIndices = new Float32Array(INITIAL_VERTEX_COUNT);
  let oTexRotations = new Float32Array(INITIAL_VERTEX_COUNT);
  let oTintTypes = new Float32Array(INITIAL_VERTEX_COUNT);
  let oShadeFlags = new Float32Array(INITIAL_VERTEX_COUNT);
  let oSingleSidedFlags = new Float32Array(INITIAL_VERTEX_COUNT);
  let oSkyLight = new Float32Array(INITIAL_VERTEX_COUNT);
  let oBlockLight = new Float32Array(INITIAL_VERTEX_COUNT);
  let oIndices = new Uint32Array(INITIAL_VERTEX_COUNT * 2);
  
  let oVertexCount = 0;
  let oIndexCount = 0;
  let oCapacity = INITIAL_VERTEX_COUNT;

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
      
      // Current block's partial block info for enhanced culling
      const mySlabType = stateSlabType[stateId];
      const myStairType = stateStairType[stateId];
      const myStairFacing = stateStairFacing[stateId]; // 0=N, 1=S, 2=E, 3=W
      const myStairHalf = stateStairHalf[stateId]; // 0=bottom, 1=top
      const myWallType = stateWallType[stateId];
      const myFenceType = stateFenceType[stateId];
      
      // Helper to get neighbor state ID (inline for performance)
      let neighborStateId;
      
      // +Y neighbor (up)
      if (ly < 15) {
        nUp = isFullOpaqueCube[blockSection[i + 256] & BLOCK_ID_MASK];
        if (!nUp) {
          neighborStateId = stateSection[i + 256];
          // Slab: bottom slab's top face is covered by top slab above
          if (mySlabType === 1 && neighborStateId && stateSlabType[neighborStateId] === 2) {
            nUp = 1;
          }
          // Stair: bottom stair can cull top if neighbor is bottom stair (covers full bottom half)
          // or if neighbor is same-facing bottom stair
          else if (myStairType && myStairHalf === 0 && neighborStateId) {
            const nStairHalf = stateStairHalf[neighborStateId];
            // Top stair above a bottom stair covers the top face if both have same facing
            if (stateStairType[neighborStateId] && nStairHalf === 1) {
              nUp = 1; // Top stair covers bottom stair's top
            }
          }
        }
      } else if (secTop) {
        nUp = isFullOpaqueCube[secTop[lz * 16 + lx] & BLOCK_ID_MASK];
      }
      
      // -Y neighbor (down)
      if (ly > 0) {
        nDown = isFullOpaqueCube[blockSection[i - 256] & BLOCK_ID_MASK];
        if (!nDown) {
          neighborStateId = stateSection[i - 256];
          // Slab: top slab's bottom face is covered by bottom slab below
          if (mySlabType === 2 && neighborStateId && stateSlabType[neighborStateId] === 1) {
            nDown = 1;
          }
          // Stair: top stair can cull bottom if neighbor is top stair
          else if (myStairType && myStairHalf === 1 && neighborStateId) {
            const nStairHalf = stateStairHalf[neighborStateId];
            if (stateStairType[neighborStateId] && nStairHalf === 0) {
              nDown = 1; // Bottom stair covers top stair's bottom
            }
          }
        }
      } else if (secBot) {
        nDown = isFullOpaqueCube[secBot[15 * 256 + lz * 16 + lx] & BLOCK_ID_MASK];
      }
      
      // +Z neighbor (south) - face direction is 'south', stair back is when stair faces north (0)
      if (lz < 15) {
        nSouth = isFullOpaqueCube[blockSection[i + 16] & BLOCK_ID_MASK];
        if (!nSouth) {
          neighborStateId = stateSection[i + 16];
          if (neighborStateId) {
            // Slab: same-type slabs cull shared faces
            if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
              nSouth = 1;
            }
            // Stair: cull south face if...
            else if (myStairType) {
              const nStairType = stateStairType[neighborStateId];
              const nStairHalf = stateStairHalf[neighborStateId];
              const nStairFacing = stateStairFacing[neighborStateId];
              if (nStairType && nStairHalf === myStairHalf) {
                // Same half stairs - check if they share full face coverage
                // My south face is full if I face north (0) - it's my back
                // Neighbor's north face is full if neighbor faces south (1) - it's their back
                // Or if both have same facing, their side faces match
                if (myStairFacing === 0 || nStairFacing === 1 || myStairFacing === nStairFacing) {
                  nSouth = 1;
                }
              }
            }
            // Wall: same type walls cull shared faces
            else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
              nSouth = 1;
            }
            // Fence: same type fences cull shared faces
            else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
              nSouth = 1;
            }
          }
        }
      } else if (secPosZ) {
        nSouth = isFullOpaqueCube[secPosZ[ly * 256 + lx] & BLOCK_ID_MASK];
      }
      
      // -Z neighbor (north) - face direction is 'north', stair back is when stair faces south (1)
      if (lz > 0) {
        nNorth = isFullOpaqueCube[blockSection[i - 16] & BLOCK_ID_MASK];
        if (!nNorth) {
          neighborStateId = stateSection[i - 16];
          if (neighborStateId) {
            if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
              nNorth = 1;
            }
            else if (myStairType) {
              const nStairType = stateStairType[neighborStateId];
              const nStairHalf = stateStairHalf[neighborStateId];
              const nStairFacing = stateStairFacing[neighborStateId];
              if (nStairType && nStairHalf === myStairHalf) {
                // My north face is full if I face south (1)
                // Neighbor's south face is full if neighbor faces north (0)
                if (myStairFacing === 1 || nStairFacing === 0 || myStairFacing === nStairFacing) {
                  nNorth = 1;
                }
              }
            }
            // Wall: same type walls cull shared faces
            else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
              nNorth = 1;
            }
            // Fence: same type fences cull shared faces
            else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
              nNorth = 1;
            }
          }
        }
      } else if (secNegZ) {
        nNorth = isFullOpaqueCube[secNegZ[ly * 256 + 15 * 16 + lx] & BLOCK_ID_MASK];
      }
      
      // +X neighbor (east) - face direction is 'east', stair back is when stair faces west (3)
      if (lx < 15) {
        nEast = isFullOpaqueCube[blockSection[i + 1] & BLOCK_ID_MASK];
        if (!nEast) {
          neighborStateId = stateSection[i + 1];
          if (neighborStateId) {
            if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
              nEast = 1;
            }
            else if (myStairType) {
              const nStairType = stateStairType[neighborStateId];
              const nStairHalf = stateStairHalf[neighborStateId];
              const nStairFacing = stateStairFacing[neighborStateId];
              if (nStairType && nStairHalf === myStairHalf) {
                // My east face is full if I face west (3)
                // Neighbor's west face is full if neighbor faces east (2)
                if (myStairFacing === 3 || nStairFacing === 2 || myStairFacing === nStairFacing) {
                  nEast = 1;
                }
              }
            }
            // Wall: same type walls cull shared faces
            else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
              nEast = 1;
            }
            // Fence: same type fences cull shared faces
            else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
              nEast = 1;
            }
          }
        }
      } else if (secPosX) {
        nEast = isFullOpaqueCube[secPosX[ly * 256 + lz * 16] & BLOCK_ID_MASK];
      }
      
      // -X neighbor (west) - face direction is 'west', stair back is when stair faces east (2)
      if (lx > 0) {
        nWest = isFullOpaqueCube[blockSection[i - 1] & BLOCK_ID_MASK];
        if (!nWest) {
          neighborStateId = stateSection[i - 1];
          if (neighborStateId) {
            if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
              nWest = 1;
            }
            else if (myStairType) {
              const nStairType = stateStairType[neighborStateId];
              const nStairHalf = stateStairHalf[neighborStateId];
              const nStairFacing = stateStairFacing[neighborStateId];
              if (nStairType && nStairHalf === myStairHalf) {
                // My west face is full if I face east (2)
                // Neighbor's east face is full if neighbor faces west (3)
                if (myStairFacing === 2 || nStairFacing === 3 || myStairFacing === nStairFacing) {
                  nWest = 1;
                }
              }
            }
            // Wall: same type walls cull shared faces
            else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
              nWest = 1;
            }
            // Fence: same type fences cull shared faces
            else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
              nWest = 1;
            }
          }
        }
      } else if (secNegX) {
        nWest = isFullOpaqueCube[secNegX[ly * 256 + lz * 16 + 15] & BLOCK_ID_MASK];
      }
      
      // ========================================================================
      // OCCLUSION CULLING: Skip blocks completely surrounded by solid blocks
      // This primarily helps cross-pattern blocks (grass, flowers) underground
      // ========================================================================
      // For cross-pattern blocks (no cullface, can't be partially culled), check if
      // completely occluded by solid neighbors
      const isCrossPattern = stateHasModelRotation[stateId] === 1;
      if (isCrossPattern) {
        // Use raw neighbor solid check (not the modified nUp/nDown that includes partials)
        let rawUp = 0, rawDown = 0, rawNorth = 0, rawSouth = 0, rawWest = 0, rawEast = 0;
        
        if (ly < 15) rawUp = isFullOpaqueCube[blockSection[i + 256] & BLOCK_ID_MASK];
        else if (secTop) rawUp = isFullOpaqueCube[secTop[lz * 16 + lx] & BLOCK_ID_MASK];
        
        if (ly > 0) rawDown = isFullOpaqueCube[blockSection[i - 256] & BLOCK_ID_MASK];
        else if (secBot) rawDown = isFullOpaqueCube[secBot[15 * 256 + lz * 16 + lx] & BLOCK_ID_MASK];
        
        if (lz < 15) rawSouth = isFullOpaqueCube[blockSection[i + 16] & BLOCK_ID_MASK];
        else if (secPosZ) rawSouth = isFullOpaqueCube[secPosZ[ly * 256 + lx] & BLOCK_ID_MASK];
        
        if (lz > 0) rawNorth = isFullOpaqueCube[blockSection[i - 16] & BLOCK_ID_MASK];
        else if (secNegZ) rawNorth = isFullOpaqueCube[secNegZ[ly * 256 + 15 * 16 + lx] & BLOCK_ID_MASK];
        
        if (lx < 15) rawEast = isFullOpaqueCube[blockSection[i + 1] & BLOCK_ID_MASK];
        else if (secPosX) rawEast = isFullOpaqueCube[secPosX[ly * 256 + lz * 16] & BLOCK_ID_MASK];
        
        if (lx > 0) rawWest = isFullOpaqueCube[blockSection[i - 1] & BLOCK_ID_MASK];
        else if (secNegX) rawWest = isFullOpaqueCube[secNegX[ly * 256 + lz * 16 + 15] & BLOCK_ID_MASK];
        
        // If all 6 neighbors are solid opaque cubes, skip this block entirely
        if (rawUp && rawDown && rawNorth && rawSouth && rawWest && rawEast) {
          continue; // Block is completely occluded
        }
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
      
      // Compute model Y-rotation for cross-model plants (grass, flowers, etc.)
      let modelRotation = 0;
      if (stateHasModelRotation[stateId]) {
        modelRotation = getPositionRotation(baseX + lx, baseY + ly, baseZ + lz);
      }
      
      // Compute position XZ offset for small plants
      let offsetX = 0, offsetZ = 0;
      if (stateHasPositionOffset[stateId]) {
        const offset = getPositionOffset(baseX + lx, baseY + ly, baseZ + lz);
        offsetX = offset.dx;
        offsetZ = offset.dz;
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
          
          // ========================================================================
          // BOUNDS-BASED PARTIAL BLOCK CULLING
          // For faces without cullface that are at block edges, check if neighbor
          // partial blocks cover them. This handles stair-to-stair, wall-to-wall, etc.
          // ========================================================================
          const bounds = cullInfo.bounds;
          const faceDir = cullInfo.faceDirection;
          
          if (bounds && faceDir && (myStairType || mySlabType || myWallType || myFenceType)) {
            let shouldCullFace = false;
            
            // Check if this face is at the block boundary and could be culled
            // Face must be at the edge of the block in the direction it's pointing
            if (faceDir === 'east' && bounds.maxX > 1 - EDGE_THRESHOLD) {
              // East face at x=1 boundary, check +X neighbor
              if (lx < 15) {
                neighborStateId = stateSection[i + 1];
                if (neighborStateId) {
                  // Check if neighbor stair/slab covers this face's Y range
                  if (myStairType && stateStairType[neighborStateId] && stateStairHalf[neighborStateId] === myStairHalf) {
                    // Same-half stairs cover each other's side faces
                    if (bounds.minY >= (myStairHalf === 0 ? 0 : 0.5) - EDGE_THRESHOLD &&
                        bounds.maxY <= (myStairHalf === 0 ? 0.5 : 1.0) + EDGE_THRESHOLD) {
                      shouldCullFace = true;
                    }
                  } else if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
                    // Same-type slabs cover each other
                    shouldCullFace = true;
                  } else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
                    shouldCullFace = true;
                  } else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
                    shouldCullFace = true;
                  }
                }
              }
            } else if (faceDir === 'west' && bounds.minX < EDGE_THRESHOLD) {
              // West face at x=0 boundary, check -X neighbor
              if (lx > 0) {
                neighborStateId = stateSection[i - 1];
                if (neighborStateId) {
                  if (myStairType && stateStairType[neighborStateId] && stateStairHalf[neighborStateId] === myStairHalf) {
                    if (bounds.minY >= (myStairHalf === 0 ? 0 : 0.5) - EDGE_THRESHOLD &&
                        bounds.maxY <= (myStairHalf === 0 ? 0.5 : 1.0) + EDGE_THRESHOLD) {
                      shouldCullFace = true;
                    }
                  } else if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
                    shouldCullFace = true;
                  } else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
                    shouldCullFace = true;
                  } else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
                    shouldCullFace = true;
                  }
                }
              }
            } else if (faceDir === 'south' && bounds.maxZ > 1 - EDGE_THRESHOLD) {
              // South face at z=1 boundary, check +Z neighbor
              if (lz < 15) {
                neighborStateId = stateSection[i + 16];
                if (neighborStateId) {
                  if (myStairType && stateStairType[neighborStateId] && stateStairHalf[neighborStateId] === myStairHalf) {
                    if (bounds.minY >= (myStairHalf === 0 ? 0 : 0.5) - EDGE_THRESHOLD &&
                        bounds.maxY <= (myStairHalf === 0 ? 0.5 : 1.0) + EDGE_THRESHOLD) {
                      shouldCullFace = true;
                    }
                  } else if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
                    shouldCullFace = true;
                  } else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
                    shouldCullFace = true;
                  } else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
                    shouldCullFace = true;
                  }
                }
              }
            } else if (faceDir === 'north' && bounds.minZ < EDGE_THRESHOLD) {
              // North face at z=0 boundary, check -Z neighbor
              if (lz > 0) {
                neighborStateId = stateSection[i - 16];
                if (neighborStateId) {
                  if (myStairType && stateStairType[neighborStateId] && stateStairHalf[neighborStateId] === myStairHalf) {
                    if (bounds.minY >= (myStairHalf === 0 ? 0 : 0.5) - EDGE_THRESHOLD &&
                        bounds.maxY <= (myStairHalf === 0 ? 0.5 : 1.0) + EDGE_THRESHOLD) {
                      shouldCullFace = true;
                    }
                  } else if (mySlabType > 0 && stateSlabType[neighborStateId] === mySlabType) {
                    shouldCullFace = true;
                  } else if (myWallType > 0 && stateWallType[neighborStateId] === myWallType) {
                    shouldCullFace = true;
                  } else if (myFenceType > 0 && stateFenceType[neighborStateId] === myFenceType) {
                    shouldCullFace = true;
                  }
                }
              }
            } else if (faceDir === 'up' && bounds.maxY > 1 - EDGE_THRESHOLD) {
              // Up face at y=1 boundary, check +Y neighbor
              if (ly < 15) {
                neighborStateId = stateSection[i + 256];
                if (neighborStateId) {
                  // Top slabs cover bottom slabs from above
                  if (mySlabType === 1 && stateSlabType[neighborStateId] === 2) {
                    shouldCullFace = true;
                  }
                  // Bottom stairs can be covered by top stairs above
                  if (myStairType && myStairHalf === 0 && stateStairType[neighborStateId] && stateStairHalf[neighborStateId] === 1) {
                    shouldCullFace = true;
                  }
                }
              }
            } else if (faceDir === 'down' && bounds.minY < EDGE_THRESHOLD) {
              // Down face at y=0 boundary, check -Y neighbor
              if (ly > 0) {
                neighborStateId = stateSection[i - 256];
                if (neighborStateId) {
                  // Bottom slabs cover top slabs from below
                  if (mySlabType === 2 && stateSlabType[neighborStateId] === 1) {
                    shouldCullFace = true;
                  }
                  // Top stairs can be covered by bottom stairs below
                  if (myStairType && myStairHalf === 1 && stateStairType[neighborStateId] && stateStairHalf[neighborStateId] === 0) {
                    shouldCullFace = true;
                  }
                }
              }
            }
            
            if (shouldCullFace) continue;
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
          
          // Sample light for this face based on face direction
          // For partial blocks (slabs, farmland, etc.), use smart light sampling:
          // 1. For UP faces: sample from above (Y+1) - this is where sky light comes from
          // 2. For other faces: sample from adjacent OR the block above if adjacent is solid
          // Light sampling for model block faces:
          // Key insight: Model blocks exist in air space. When a face points INTO
          // a solid block, it should use the model block's own light (where there IS light),
          // not the solid block's light (which would be 0).
          let faceSkyLight = 15, faceBlockLight = 0;
          if (lightGrid) {
            // Actual world coordinates (before offset subtraction)
            const worldX = baseX + lx;
            const worldY = baseY + ly;
            const worldZ = baseZ + lz;
            
            // Get the model block's own light - this is the primary source
            // since model blocks occupy air space where light exists
            const ownLight = lightGrid.getLight(worldX, worldY, worldZ);
            
            const faceDirName = cullInfo.faceDirection || cullInfo.cullface || 'up';
            
            // Direction offsets for each face
            const faceOffsets = {
              'up': [0, 1, 0],
              'down': [0, -1, 0],
              'east': [1, 0, 0],
              'west': [-1, 0, 0],
              'south': [0, 0, 1],
              'north': [0, 0, -1],
            };
            
            const offset = faceOffsets[faceDirName];
            
            if (offset) {
              // We have a clear face direction - check the adjacent block
              const adjX = worldX + offset[0];
              const adjY = worldY + offset[1];
              const adjZ = worldZ + offset[2];
              const adjBlockId = grid.getBlockId(adjX, adjY, adjZ);
              
              // If adjacent is air or transparent, sample from there (more accurate)
              // If adjacent is solid, use our own light (face is against a wall)
              if (adjBlockId === 0 || !isFullOpaqueCube[adjBlockId]) {
                const light = lightGrid.getLight(adjX, adjY, adjZ);
                faceSkyLight = light.skyLight;
                faceBlockLight = light.blockLight;
              } else {
                // Face is against a solid block - use our own position's light
                faceSkyLight = ownLight.skyLight;
                faceBlockLight = ownLight.blockLight;
              }
            } else {
              // No clear face direction (cross-model plants, etc.)
              // Use the block's own position - they're in air space and uniformly lit
              faceSkyLight = ownLight.skyLight;
              faceBlockLight = ownLight.blockLight;
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
          
          // Check if this face is an overlay (torch bulb panels, etc.)
          // Overlay faces are rendered with depthWrite: false to not occlude geometry behind them
          const isOverlay = cullInfo.overlay === true;
          
          // Route to appropriate buffer set: overlay > transparent > opaque
          if (isOverlay) {
            // Route to overlay buffer (rendered with depthWrite: false)
            if (oVertexCount + 4 > oCapacity) {
              oCapacity = Math.ceil(oCapacity * 2);
              oPositions = growArray(oPositions, oCapacity * 3);
              oNormals = growArray(oNormals, oCapacity * 3);
              oColors = growArray(oColors, oCapacity * 3);
              oModelUVs = growArray(oModelUVs, oCapacity * 2);
              oTexIndices = growArray(oTexIndices, oCapacity);
              oTexRotations = growArray(oTexRotations, oCapacity);
              oTintTypes = growArray(oTintTypes, oCapacity);
              oShadeFlags = growArray(oShadeFlags, oCapacity);
              oSingleSidedFlags = growArray(oSingleSidedFlags, oCapacity);
              oSkyLight = growArray(oSkyLight, oCapacity);
              oBlockLight = growArray(oBlockLight, oCapacity);
              oIndices = growArrayUint(oIndices, oCapacity * 2);
            }

            const dstVertexStart = oVertexCount;
            
            // Copy vertex data
            const srcBase = srcVertexStart * 3;
            const dstBase = oVertexCount * 3;
            const srcUvBase = srcVertexStart * 2;
            const dstUvBase = oVertexCount * 2;
            
            // Copy positions with model rotation, offset, and world offset
            // Apply Y-axis model rotation and XZ position offset if needed
            if (modelRotation !== 0 || offsetX !== 0 || offsetZ !== 0) {
              // Process each of the 4 vertices
              for (let vIdx = 0; vIdx < 4; vIdx++) {
                let px = geom.positions[srcBase + vIdx * 3];
                const py = geom.positions[srcBase + vIdx * 3 + 1];
                let pz = geom.positions[srcBase + vIdx * 3 + 2];
                
                // Apply model rotation around block center (0.5, 0.5)
                if (modelRotation !== 0) {
                  const rotated = rotateVertexY(px, pz, modelRotation);
                  px = rotated.rx;
                  pz = rotated.rz;
                }
                
                // Apply position offset
                px += offsetX;
                pz += offsetZ;
                
                // Write to buffer with world offset
                oPositions[dstBase + vIdx * 3] = px + wx;
                oPositions[dstBase + vIdx * 3 + 1] = py + wy;
                oPositions[dstBase + vIdx * 3 + 2] = pz + wz;
              }
            } else {
              // Fast path: no transformation needed
              oPositions[dstBase] = geom.positions[srcBase] + wx;
              oPositions[dstBase + 1] = geom.positions[srcBase + 1] + wy;
              oPositions[dstBase + 2] = geom.positions[srcBase + 2] + wz;
              oPositions[dstBase + 3] = geom.positions[srcBase + 3] + wx;
              oPositions[dstBase + 4] = geom.positions[srcBase + 4] + wy;
              oPositions[dstBase + 5] = geom.positions[srcBase + 5] + wz;
              oPositions[dstBase + 6] = geom.positions[srcBase + 6] + wx;
              oPositions[dstBase + 7] = geom.positions[srcBase + 7] + wy;
              oPositions[dstBase + 8] = geom.positions[srcBase + 8] + wz;
              oPositions[dstBase + 9] = geom.positions[srcBase + 9] + wx;
              oPositions[dstBase + 10] = geom.positions[srcBase + 10] + wy;
              oPositions[dstBase + 11] = geom.positions[srcBase + 11] + wz;
            }
            
            // Copy normals
            oNormals[dstBase] = geom.normals[srcBase];
            oNormals[dstBase + 1] = geom.normals[srcBase + 1];
            oNormals[dstBase + 2] = geom.normals[srcBase + 2];
            oNormals[dstBase + 3] = geom.normals[srcBase + 3];
            oNormals[dstBase + 4] = geom.normals[srcBase + 4];
            oNormals[dstBase + 5] = geom.normals[srcBase + 5];
            oNormals[dstBase + 6] = geom.normals[srcBase + 6];
            oNormals[dstBase + 7] = geom.normals[srcBase + 7];
            oNormals[dstBase + 8] = geom.normals[srcBase + 8];
            oNormals[dstBase + 9] = geom.normals[srcBase + 9];
            oNormals[dstBase + 10] = geom.normals[srcBase + 10];
            oNormals[dstBase + 11] = geom.normals[srcBase + 11];
            
            // Set colors
            oColors[dstBase] = r; oColors[dstBase + 1] = g; oColors[dstBase + 2] = b;
            oColors[dstBase + 3] = r; oColors[dstBase + 4] = g; oColors[dstBase + 5] = b;
            oColors[dstBase + 6] = r; oColors[dstBase + 7] = g; oColors[dstBase + 8] = b;
            oColors[dstBase + 9] = r; oColors[dstBase + 10] = g; oColors[dstBase + 11] = b;
            
            // Copy UVs
            if (geom.uvs) {
              oModelUVs[dstUvBase] = geom.uvs[srcUvBase];
              oModelUVs[dstUvBase + 1] = geom.uvs[srcUvBase + 1];
              oModelUVs[dstUvBase + 2] = geom.uvs[srcUvBase + 2];
              oModelUVs[dstUvBase + 3] = geom.uvs[srcUvBase + 3];
              oModelUVs[dstUvBase + 4] = geom.uvs[srcUvBase + 4];
              oModelUVs[dstUvBase + 5] = geom.uvs[srcUvBase + 5];
              oModelUVs[dstUvBase + 6] = geom.uvs[srcUvBase + 6];
              oModelUVs[dstUvBase + 7] = geom.uvs[srcUvBase + 7];
            }
            
            // Set per-vertex attributes
            oTexIndices[oVertexCount] = texIdx;
            oTexIndices[oVertexCount + 1] = texIdx;
            oTexIndices[oVertexCount + 2] = texIdx;
            oTexIndices[oVertexCount + 3] = texIdx;
            oTexRotations[oVertexCount] = blockTexRotation;
            oTexRotations[oVertexCount + 1] = blockTexRotation;
            oTexRotations[oVertexCount + 2] = blockTexRotation;
            oTexRotations[oVertexCount + 3] = blockTexRotation;
            oTintTypes[oVertexCount] = tintType;
            oTintTypes[oVertexCount + 1] = tintType;
            oTintTypes[oVertexCount + 2] = tintType;
            oTintTypes[oVertexCount + 3] = tintType;
            const oShadeValue = cullInfo.shade !== false ? 1.0 : 0.0;
            oShadeFlags[oVertexCount] = oShadeValue;
            oShadeFlags[oVertexCount + 1] = oShadeValue;
            oShadeFlags[oVertexCount + 2] = oShadeValue;
            oShadeFlags[oVertexCount + 3] = oShadeValue;
            const oSingleSidedValue = cullInfo.singleSided ? 1.0 : 0.0;
            oSingleSidedFlags[oVertexCount] = oSingleSidedValue;
            oSingleSidedFlags[oVertexCount + 1] = oSingleSidedValue;
            oSingleSidedFlags[oVertexCount + 2] = oSingleSidedValue;
            oSingleSidedFlags[oVertexCount + 3] = oSingleSidedValue;
            oSkyLight[oVertexCount] = faceSkyLight;
            oSkyLight[oVertexCount + 1] = faceSkyLight;
            oSkyLight[oVertexCount + 2] = faceSkyLight;
            oSkyLight[oVertexCount + 3] = faceSkyLight;
            oBlockLight[oVertexCount] = faceBlockLight;
            oBlockLight[oVertexCount + 1] = faceBlockLight;
            oBlockLight[oVertexCount + 2] = faceBlockLight;
            oBlockLight[oVertexCount + 3] = faceBlockLight;
            
            oVertexCount += 4;
            
            // Emit indices
            oIndices[oIndexCount] = dstVertexStart;
            oIndices[oIndexCount + 1] = dstVertexStart + 2;
            oIndices[oIndexCount + 2] = dstVertexStart + 1;
            oIndices[oIndexCount + 3] = dstVertexStart;
            oIndices[oIndexCount + 4] = dstVertexStart + 3;
            oIndices[oIndexCount + 5] = dstVertexStart + 2;
            oIndexCount += 6;
          } else if (isTransparent) {
            // Ensure capacity for transparent buffers (4 verts per quad face)
            if (tVertexCount + 4 > tCapacity) {
              tCapacity = Math.ceil(tCapacity * 2); // Double to reduce reallocations
              tPositions = growArray(tPositions, tCapacity * 3);
              tNormals = growArray(tNormals, tCapacity * 3);
              tColors = growArray(tColors, tCapacity * 3);
              tModelUVs = growArray(tModelUVs, tCapacity * 2);
              tTexIndices = growArray(tTexIndices, tCapacity);
              tTexRotations = growArray(tTexRotations, tCapacity);
              tTintTypes = growArray(tTintTypes, tCapacity);
              tShadeFlags = growArray(tShadeFlags, tCapacity);
              tSingleSidedFlags = growArray(tSingleSidedFlags, tCapacity);
              tSkyLight = growArray(tSkyLight, tCapacity);
              tBlockLight = growArray(tBlockLight, tCapacity);
              tIndices = growArrayUint(tIndices, tCapacity * 2);
            }

            const dstVertexStart = tVertexCount;
            
            // Optimized: batch copy 4 vertices using direct array indexing
            const srcBase = srcVertexStart * 3;
            const dstBase = tVertexCount * 3;
            const srcUvBase = srcVertexStart * 2;
            const dstUvBase = tVertexCount * 2;
            
            // Copy positions with model rotation, offset, and world offset
            if (modelRotation !== 0 || offsetX !== 0 || offsetZ !== 0) {
              for (let vIdx = 0; vIdx < 4; vIdx++) {
                let px = geom.positions[srcBase + vIdx * 3];
                const py = geom.positions[srcBase + vIdx * 3 + 1];
                let pz = geom.positions[srcBase + vIdx * 3 + 2];
                
                if (modelRotation !== 0) {
                  const rotated = rotateVertexY(px, pz, modelRotation);
                  px = rotated.rx;
                  pz = rotated.rz;
                }
                
                px += offsetX;
                pz += offsetZ;
                
                tPositions[dstBase + vIdx * 3] = px + wx;
                tPositions[dstBase + vIdx * 3 + 1] = py + wy;
                tPositions[dstBase + vIdx * 3 + 2] = pz + wz;
              }
            } else {
              tPositions[dstBase] = geom.positions[srcBase] + wx;
              tPositions[dstBase + 1] = geom.positions[srcBase + 1] + wy;
              tPositions[dstBase + 2] = geom.positions[srcBase + 2] + wz;
              tPositions[dstBase + 3] = geom.positions[srcBase + 3] + wx;
              tPositions[dstBase + 4] = geom.positions[srcBase + 4] + wy;
              tPositions[dstBase + 5] = geom.positions[srcBase + 5] + wz;
              tPositions[dstBase + 6] = geom.positions[srcBase + 6] + wx;
              tPositions[dstBase + 7] = geom.positions[srcBase + 7] + wy;
              tPositions[dstBase + 8] = geom.positions[srcBase + 8] + wz;
              tPositions[dstBase + 9] = geom.positions[srcBase + 9] + wx;
              tPositions[dstBase + 10] = geom.positions[srcBase + 10] + wy;
              tPositions[dstBase + 11] = geom.positions[srcBase + 11] + wz;
            }
            
            // Copy normals directly
            tNormals[dstBase] = geom.normals[srcBase];
            tNormals[dstBase + 1] = geom.normals[srcBase + 1];
            tNormals[dstBase + 2] = geom.normals[srcBase + 2];
            tNormals[dstBase + 3] = geom.normals[srcBase + 3];
            tNormals[dstBase + 4] = geom.normals[srcBase + 4];
            tNormals[dstBase + 5] = geom.normals[srcBase + 5];
            tNormals[dstBase + 6] = geom.normals[srcBase + 6];
            tNormals[dstBase + 7] = geom.normals[srcBase + 7];
            tNormals[dstBase + 8] = geom.normals[srcBase + 8];
            tNormals[dstBase + 9] = geom.normals[srcBase + 9];
            tNormals[dstBase + 10] = geom.normals[srcBase + 10];
            tNormals[dstBase + 11] = geom.normals[srcBase + 11];
            
            // Set colors (same for all 4 vertices)
            tColors[dstBase] = r; tColors[dstBase + 1] = g; tColors[dstBase + 2] = b;
            tColors[dstBase + 3] = r; tColors[dstBase + 4] = g; tColors[dstBase + 5] = b;
            tColors[dstBase + 6] = r; tColors[dstBase + 7] = g; tColors[dstBase + 8] = b;
            tColors[dstBase + 9] = r; tColors[dstBase + 10] = g; tColors[dstBase + 11] = b;
            
            // Copy UVs if present
            if (geom.uvs) {
              tModelUVs[dstUvBase] = geom.uvs[srcUvBase];
              tModelUVs[dstUvBase + 1] = geom.uvs[srcUvBase + 1];
              tModelUVs[dstUvBase + 2] = geom.uvs[srcUvBase + 2];
              tModelUVs[dstUvBase + 3] = geom.uvs[srcUvBase + 3];
              tModelUVs[dstUvBase + 4] = geom.uvs[srcUvBase + 4];
              tModelUVs[dstUvBase + 5] = geom.uvs[srcUvBase + 5];
              tModelUVs[dstUvBase + 6] = geom.uvs[srcUvBase + 6];
              tModelUVs[dstUvBase + 7] = geom.uvs[srcUvBase + 7];
            }
            
            // Set per-vertex attributes (same for all 4 vertices)
            tTexIndices[tVertexCount] = texIdx;
            tTexIndices[tVertexCount + 1] = texIdx;
            tTexIndices[tVertexCount + 2] = texIdx;
            tTexIndices[tVertexCount + 3] = texIdx;
            tTexRotations[tVertexCount] = blockTexRotation;
            tTexRotations[tVertexCount + 1] = blockTexRotation;
            tTexRotations[tVertexCount + 2] = blockTexRotation;
            tTexRotations[tVertexCount + 3] = blockTexRotation;
            tTintTypes[tVertexCount] = tintType;
            tTintTypes[tVertexCount + 1] = tintType;
            tTintTypes[tVertexCount + 2] = tintType;
            tTintTypes[tVertexCount + 3] = tintType;
            // Face shading flag (0 = no shading, 1 = apply directional shading)
            const tShadeValue = cullInfo.shade !== false ? 1.0 : 0.0;
            tShadeFlags[tVertexCount] = tShadeValue;
            tShadeFlags[tVertexCount + 1] = tShadeValue;
            tShadeFlags[tVertexCount + 2] = tShadeValue;
            tShadeFlags[tVertexCount + 3] = tShadeValue;
            // Single-sided flag (0 = double-sided, 1 = cull backface)
            const tSingleSidedValue = cullInfo.singleSided ? 1.0 : 0.0;
            tSingleSidedFlags[tVertexCount] = tSingleSidedValue;
            tSingleSidedFlags[tVertexCount + 1] = tSingleSidedValue;
            tSingleSidedFlags[tVertexCount + 2] = tSingleSidedValue;
            tSingleSidedFlags[tVertexCount + 3] = tSingleSidedValue;
            tSkyLight[tVertexCount] = faceSkyLight;
            tSkyLight[tVertexCount + 1] = faceSkyLight;
            tSkyLight[tVertexCount + 2] = faceSkyLight;
            tSkyLight[tVertexCount + 3] = faceSkyLight;
            tBlockLight[tVertexCount] = faceBlockLight;
            tBlockLight[tVertexCount + 1] = faceBlockLight;
            tBlockLight[tVertexCount + 2] = faceBlockLight;
            tBlockLight[tVertexCount + 3] = faceBlockLight;
            
            tVertexCount += 4;
            
            // Emit indices for transparent mesh (two triangles forming a quad)
            tIndices[tIndexCount] = dstVertexStart;
            tIndices[tIndexCount + 1] = dstVertexStart + 2;
            tIndices[tIndexCount + 2] = dstVertexStart + 1;
            tIndices[tIndexCount + 3] = dstVertexStart;
            tIndices[tIndexCount + 4] = dstVertexStart + 3;
            tIndices[tIndexCount + 5] = dstVertexStart + 2;
            tIndexCount += 6;
          } else {
            // Ensure capacity for opaque buffers (4 verts per quad face)
            if (vertexCount + 4 > capacity) {
              capacity = Math.ceil(capacity * 2); // Double to reduce reallocations
              positions = growArray(positions, capacity * 3);
              normals = growArray(normals, capacity * 3);
              colors = growArray(colors, capacity * 3);
              modelUVs = growArray(modelUVs, capacity * 2);
              texIndices = growArray(texIndices, capacity);
              texRotations = growArray(texRotations, capacity);
              tintTypes = growArray(tintTypes, capacity);
              shadeFlags = growArray(shadeFlags, capacity);
              singleSidedFlags = growArray(singleSidedFlags, capacity);
              skyLightArr = growArray(skyLightArr, capacity);
              blockLightArr = growArray(blockLightArr, capacity);
              indices = growArrayUint(indices, capacity * 2);
            }

            const dstVertexStart = vertexCount;
            
            // Optimized: batch copy 4 vertices using direct array indexing
            // Pre-compute base offsets once
            const srcBase = srcVertexStart * 3;
            const dstBase = vertexCount * 3;
            const srcUvBase = srcVertexStart * 2;
            const dstUvBase = vertexCount * 2;
            
            // Copy positions with model rotation, offset, and world offset
            if (modelRotation !== 0 || offsetX !== 0 || offsetZ !== 0) {
              for (let vIdx = 0; vIdx < 4; vIdx++) {
                let px = geom.positions[srcBase + vIdx * 3];
                const py = geom.positions[srcBase + vIdx * 3 + 1];
                let pz = geom.positions[srcBase + vIdx * 3 + 2];
                
                if (modelRotation !== 0) {
                  const rotated = rotateVertexY(px, pz, modelRotation);
                  px = rotated.rx;
                  pz = rotated.rz;
                }
                
                px += offsetX;
                pz += offsetZ;
                
                positions[dstBase + vIdx * 3] = px + wx;
                positions[dstBase + vIdx * 3 + 1] = py + wy;
                positions[dstBase + vIdx * 3 + 2] = pz + wz;
              }
            } else {
              positions[dstBase] = geom.positions[srcBase] + wx;
              positions[dstBase + 1] = geom.positions[srcBase + 1] + wy;
              positions[dstBase + 2] = geom.positions[srcBase + 2] + wz;
              positions[dstBase + 3] = geom.positions[srcBase + 3] + wx;
              positions[dstBase + 4] = geom.positions[srcBase + 4] + wy;
              positions[dstBase + 5] = geom.positions[srcBase + 5] + wz;
              positions[dstBase + 6] = geom.positions[srcBase + 6] + wx;
              positions[dstBase + 7] = geom.positions[srcBase + 7] + wy;
              positions[dstBase + 8] = geom.positions[srcBase + 8] + wz;
              positions[dstBase + 9] = geom.positions[srcBase + 9] + wx;
              positions[dstBase + 10] = geom.positions[srcBase + 10] + wy;
              positions[dstBase + 11] = geom.positions[srcBase + 11] + wz;
            }
            
            // Copy normals directly (no offset needed)
            normals[dstBase] = geom.normals[srcBase];
            normals[dstBase + 1] = geom.normals[srcBase + 1];
            normals[dstBase + 2] = geom.normals[srcBase + 2];
            normals[dstBase + 3] = geom.normals[srcBase + 3];
            normals[dstBase + 4] = geom.normals[srcBase + 4];
            normals[dstBase + 5] = geom.normals[srcBase + 5];
            normals[dstBase + 6] = geom.normals[srcBase + 6];
            normals[dstBase + 7] = geom.normals[srcBase + 7];
            normals[dstBase + 8] = geom.normals[srcBase + 8];
            normals[dstBase + 9] = geom.normals[srcBase + 9];
            normals[dstBase + 10] = geom.normals[srcBase + 10];
            normals[dstBase + 11] = geom.normals[srcBase + 11];
            
            // Set colors (same for all 4 vertices)
            colors[dstBase] = r; colors[dstBase + 1] = g; colors[dstBase + 2] = b;
            colors[dstBase + 3] = r; colors[dstBase + 4] = g; colors[dstBase + 5] = b;
            colors[dstBase + 6] = r; colors[dstBase + 7] = g; colors[dstBase + 8] = b;
            colors[dstBase + 9] = r; colors[dstBase + 10] = g; colors[dstBase + 11] = b;
            
            // Copy UVs if present
            if (geom.uvs) {
              modelUVs[dstUvBase] = geom.uvs[srcUvBase];
              modelUVs[dstUvBase + 1] = geom.uvs[srcUvBase + 1];
              modelUVs[dstUvBase + 2] = geom.uvs[srcUvBase + 2];
              modelUVs[dstUvBase + 3] = geom.uvs[srcUvBase + 3];
              modelUVs[dstUvBase + 4] = geom.uvs[srcUvBase + 4];
              modelUVs[dstUvBase + 5] = geom.uvs[srcUvBase + 5];
              modelUVs[dstUvBase + 6] = geom.uvs[srcUvBase + 6];
              modelUVs[dstUvBase + 7] = geom.uvs[srcUvBase + 7];
            }
            
            // Set per-vertex attributes (same for all 4 vertices)
            texIndices[vertexCount] = texIdx;
            texIndices[vertexCount + 1] = texIdx;
            texIndices[vertexCount + 2] = texIdx;
            texIndices[vertexCount + 3] = texIdx;
            texRotations[vertexCount] = blockTexRotation;
            texRotations[vertexCount + 1] = blockTexRotation;
            texRotations[vertexCount + 2] = blockTexRotation;
            texRotations[vertexCount + 3] = blockTexRotation;
            tintTypes[vertexCount] = tintType;
            tintTypes[vertexCount + 1] = tintType;
            tintTypes[vertexCount + 2] = tintType;
            tintTypes[vertexCount + 3] = tintType;
            // Face shading flag (0 = no shading, 1 = apply directional shading)
            const shadeValue = cullInfo.shade !== false ? 1.0 : 0.0;
            shadeFlags[vertexCount] = shadeValue;
            shadeFlags[vertexCount + 1] = shadeValue;
            shadeFlags[vertexCount + 2] = shadeValue;
            shadeFlags[vertexCount + 3] = shadeValue;
            // Single-sided flag (0 = double-sided, 1 = cull backface)
            const singleSidedValue = cullInfo.singleSided ? 1.0 : 0.0;
            singleSidedFlags[vertexCount] = singleSidedValue;
            singleSidedFlags[vertexCount + 1] = singleSidedValue;
            singleSidedFlags[vertexCount + 2] = singleSidedValue;
            singleSidedFlags[vertexCount + 3] = singleSidedValue;
            skyLightArr[vertexCount] = faceSkyLight;
            skyLightArr[vertexCount + 1] = faceSkyLight;
            skyLightArr[vertexCount + 2] = faceSkyLight;
            skyLightArr[vertexCount + 3] = faceSkyLight;
            blockLightArr[vertexCount] = faceBlockLight;
            blockLightArr[vertexCount + 1] = faceBlockLight;
            blockLightArr[vertexCount + 2] = faceBlockLight;
            blockLightArr[vertexCount + 3] = faceBlockLight;
            
            vertexCount += 4;
            
            // Emit indices for opaque mesh (two triangles forming a quad)
            // Front face winding: 0,2,1 and 0,3,2
            indices[indexCount] = dstVertexStart;
            indices[indexCount + 1] = dstVertexStart + 2;
            indices[indexCount + 2] = dstVertexStart + 1;
            indices[indexCount + 3] = dstVertexStart;
            indices[indexCount + 4] = dstVertexStart + 3;
            indices[indexCount + 5] = dstVertexStart + 2;
            indexCount += 6;
            
            // For cross-model plants (shade: false), emit backface with reversed winding
            // This allows using FrontSide material which is much faster than DoubleSide
            // Only cross-model elements need backfaces - opaque blocks like slabs/stairs don't
            if (!cullInfo.singleSided && cullInfo.shade === false) {
              // Ensure capacity for backface indices
              if (indexCount + 6 > indices.length) {
                indices = growArrayUint(indices, Math.ceil(indices.length * 2));
              }
              // Back face winding: 0,1,2 and 0,2,3 (reversed from front)
              indices[indexCount] = dstVertexStart;
              indices[indexCount + 1] = dstVertexStart + 1;
              indices[indexCount + 2] = dstVertexStart + 2;
              indices[indexCount + 3] = dstVertexStart;
              indices[indexCount + 4] = dstVertexStart + 2;
              indices[indexCount + 5] = dstVertexStart + 3;
              indexCount += 6;
            }
          }
        }
      }
    }
  }

  // Build result object with opaque, transparent, and overlay meshes
  const opaqueResult = vertexCount > 0 ? {
    positions: positions.subarray(0, vertexCount * 3),
    normals: normals.subarray(0, vertexCount * 3),
    colors: colors.subarray(0, vertexCount * 3),
    modelUVs: modelUVs.subarray(0, vertexCount * 2),
    indices: indices.subarray(0, indexCount),
    shadeFlags: shadeFlags.subarray(0, vertexCount),
    singleSidedFlags: singleSidedFlags.subarray(0, vertexCount),
    skyLight: skyLightArr.subarray(0, vertexCount),
    blockLight: blockLightArr.subarray(0, vertexCount),
    vertexCount,
    triangleCount: indexCount / 3,
  } : null;
  
  const transparentResult = tVertexCount > 0 ? {
    positions: tPositions.subarray(0, tVertexCount * 3),
    normals: tNormals.subarray(0, tVertexCount * 3),
    colors: tColors.subarray(0, tVertexCount * 3),
    modelUVs: tModelUVs.subarray(0, tVertexCount * 2),
    indices: tIndices.subarray(0, tIndexCount),
    shadeFlags: tShadeFlags.subarray(0, tVertexCount),
    singleSidedFlags: tSingleSidedFlags.subarray(0, tVertexCount),
    skyLight: tSkyLight.subarray(0, tVertexCount),
    blockLight: tBlockLight.subarray(0, tVertexCount),
    vertexCount: tVertexCount,
    triangleCount: tIndexCount / 3,
  } : null;
  
  // Overlay mesh for torch bulb glow panels (rendered with depthWrite: false)
  const overlayResult = oVertexCount > 0 ? {
    positions: oPositions.subarray(0, oVertexCount * 3),
    normals: oNormals.subarray(0, oVertexCount * 3),
    colors: oColors.subarray(0, oVertexCount * 3),
    modelUVs: oModelUVs.subarray(0, oVertexCount * 2),
    indices: oIndices.subarray(0, oIndexCount),
    shadeFlags: oShadeFlags.subarray(0, oVertexCount),
    singleSidedFlags: oSingleSidedFlags.subarray(0, oVertexCount),
    skyLight: oSkyLight.subarray(0, oVertexCount),
    blockLight: oBlockLight.subarray(0, oVertexCount),
    vertexCount: oVertexCount,
    triangleCount: oIndexCount / 3,
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
    if (overlayResult) {
      overlayResult.texIndices = oTexIndices.subarray(0, oVertexCount);
      overlayResult.texRotations = oTexRotations.subarray(0, oVertexCount);
      overlayResult.tintTypes = oTintTypes.subarray(0, oVertexCount);
    }
  }
  
  // Return null if no geometry was generated
  if (!opaqueResult && !transparentResult && !overlayResult) {
    return null;
  }
  
  // Return split meshes for opaque, transparent, and overlay models
  return {
    opaque: opaqueResult,
    transparent: transparentResult,
    overlay: overlayResult,
  };
}

/**
 * Build model meshes with multiple LOD levels
 * Returns meshes at LOD0 (full), LOD1, LOD2, LOD3 for distance-based rendering
 * 
 * @param {BinaryGrid} grid - Block data
 * @param {BlockStateGrid} stateGrid - State IDs for non-cube blocks
 * @param {BlockRegistry} registry - Block type info
 * @param {StateRegistry} stateRegistry - State to geometry mapping
 * @param {Object} offset - World offset {x, y, z}
 * @param {Object} options - Optional parameters
 * @returns {Object} { lod0, lod1, lod2, lod3 } mesh data at different detail levels
 */
export function buildModelMeshesWithLOD(grid, stateGrid, registry, stateRegistry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  // LOD0 = full detail
  const lod0 = buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset, { ...options, lodLevel: 0 });
  
  // LOD1 = skip flowers and small plants
  const lod1 = buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset, { ...options, lodLevel: 1 });
  
  // LOD2 = skip more decorative blocks
  const lod2 = buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset, { ...options, lodLevel: 2 });
  
  // LOD3 = only structural blocks (slabs, stairs, walls)
  const lod3 = buildModelMeshes(grid, stateGrid, registry, stateRegistry, offset, { ...options, lodLevel: 3 });
  
  return { lod0, lod1, lod2, lod3 };
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
  '_slab', '_stairs', '_fence', '_wall', '_door', '_trapdoor', '_pane', 'iron_bars', 'copper_bars',
  
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
  'crimson_roots', 'warped_roots', 'crimson_fungus', 'warped_fungus', // Nether cross-model plants
  'twisting_vines', 'weeping_vines', 'cave_vines', // Vine plants
  
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
  
  // Note: 'iron_chain' and variants - renamed from 'chain' in Minecraft 1.21
  
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
  'stonecutter', 'heavy_core', 'dried_ghast',
  
  // Portals (thin panels, not full cubes)
  // Note: end_portal and end_gateway use block entity renderers, not block models
  'nether_portal',
  
  // Path blocks (15 blocks tall, not 16)
  'farmland', 'dirt_path',
  
  // Fire (cross pattern)
  'fire', 'soul_fire',
  
  // Special blocks with inner elements (not simple cubes)
  'slime_block', 'honey_block', 'powder_snow', 'mangrove_roots',
  
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
  'chain',                             // Old name (pre-1.21) - still in old worlds
  'iron_chain',                        // Iron chain (renamed from 'chain' in 1.21)
  'copper_chain',                      // Copper chain variants
  'exposed_copper_chain',
  'weathered_copper_chain',
  'oxidized_copper_chain',
  'waxed_copper_chain',
  'waxed_exposed_copper_chain',
  'waxed_weathered_copper_chain',
  'waxed_oxidized_copper_chain',
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
