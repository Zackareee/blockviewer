/**
 * ChunkDecoder - Decode Minecraft NBT chunks into BinaryGrid format
 * 
 * Handles all Minecraft chunk formats:
 * - Modern (1.18+): sections with block_states
 * - Legacy (1.13-1.17): Palette and BlockStates
 * - Pre-1.13: Blocks byte array
 */

import { BinaryGrid, SECTION_SIZE, MIN_Y, MAX_Y, makeSectionKey } from './BinaryGrid.js';
import { getBlockRegistry } from './BlockRegistry.js';
import { BlockStateGrid } from './BlockStateGrid.js';
import { isNonCubeBlock } from './ModelMesher.js';
import { getBakedModelLoader } from './BakedModelLoader.js';
import { hasEmitter } from '../particles/ParticleEmitter.js';
import { 
  AIR_BLOCKS, UNDERWATER_BLOCKS, FLUID_CONTAINER_BLOCKS,
  AXIS_Y, AXIS_X, AXIS_Z, AXIS_SHIFT,
} from './workers/shared.js';

// Re-export axis constants for other modules
export { AXIS_Y, AXIS_X, AXIS_Z, AXIS_SHIFT };
export const AXIS_MASK = 0x3000; // Bits 12-13

// Facing encoding for directional blocks (stored in bits 12-13, same as axis - mutually exclusive)
// Facing values: 0 = north, 1 = east, 2 = south, 3 = west
export const FACING_NORTH = 0;
export const FACING_EAST = 1;
export const FACING_SOUTH = 2;
export const FACING_WEST = 3;
export const FACING_SHIFT = 12; // Same bits as axis
export const FACING_MASK = 0x3000; // Bits 12-13

// Directional blocks that need facing encoding
const DIRECTIONAL_BLOCKS = new Set([
  'furnace', 'blast_furnace', 'smoker',
  'loom',
  'carved_pumpkin', 'jack_o_lantern',
]);

// Pre-computed BigInt bit offsets for common bitsPerBlock values (4-15)
const BIT_OFFSETS = Array.from({ length: 16 }, (_, i) => 
  Array.from({ length: 64 }, (_, j) => BigInt(j * i))
);

// AIR_BLOCKS imported from shared.js

/**
 * Unpack nibble-packed light data (2048 bytes -> 4096 values)
 * Minecraft stores light as 4 bits per block, packed into bytes
 * @param {Uint8Array|Int8Array} data - 2048 byte array of packed light values
 * @returns {Uint8Array} 4096 unpacked light values (0-15)
 */
function unpackLightData(data) {
  const unpacked = new Uint8Array(4096);
  for (let i = 0; i < 2048; i++) {
    const byte = data[i] & 0xFF; // Handle signed bytes
    unpacked[i * 2] = byte & 0x0F;       // Lower nibble
    unpacked[i * 2 + 1] = (byte >> 4) & 0x0F; // Upper nibble
  }
  return unpacked;
}

// UNDERWATER_BLOCKS and FLUID_CONTAINER_BLOCKS imported from shared.js

/**
 * Unpack block indices from packed long array (Minecraft 1.16+ format)
 * 
 * OPTIMIZATION: For bitsPerBlock == 4 (most common case with palettes 1-16 entries),
 * we can process using Number operations which are ~10x faster than BigInt.
 * With 4 bits per entry, 16 entries fit in 64 bits, and no entry crosses the 32-bit boundary.
 */
function unpackBlockIndices(data, bitsPerBlock, totalBlocks) {
  const indices = new Uint16Array(totalBlocks);
  const entriesPerLong = Math.floor(64 / bitsPerBlock);
  const dataLen = data.length;
  
  // FAST PATH: For bitsPerBlock == 4 (very common - palettes with 1-16 entries)
  // 4 bits per entry means 16 entries per long, and no entry crosses 32-bit boundary
  if (bitsPerBlock === 4) {
    let i = 0;
    
    for (let longIndex = 0; longIndex < dataLen && i < totalBlocks; longIndex++) {
      const val = data[longIndex];
      
      // Split 64-bit value into two 32-bit numbers
      let low, high;
      if (typeof val === 'bigint') {
        low = Number(val & 0xFFFFFFFFn);
        high = Number((val >> 32n) & 0xFFFFFFFFn);
      } else {
        low = val >>> 0;
        high = 0;
      }
      
      // Extract 8 entries from low, 8 from high (4 bits each, total 16 entries)
      // Low 32 bits: entries 0-7
      if (i < totalBlocks) indices[i++] = (low) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 4) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 8) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 12) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 16) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 20) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 24) & 0xF;
      if (i < totalBlocks) indices[i++] = (low >>> 28) & 0xF;
      
      // High 32 bits: entries 8-15
      if (i < totalBlocks) indices[i++] = (high) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 4) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 8) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 12) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 16) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 20) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 24) & 0xF;
      if (i < totalBlocks) indices[i++] = (high >>> 28) & 0xF;
    }
    
    return indices;
  }
  
  // STANDARD PATH: Use BigInt for all other cases (still optimized with pre-computed offsets)
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  
  // Pre-convert all longs to unsigned BigInts once
  const longValues = new Array(dataLen);
  for (let j = 0; j < dataLen; j++) {
    const val = data[j];
    longValues[j] = typeof val === 'bigint' ? BigInt.asUintN(64, val) : BigInt(val >>> 0);
  }
  
  // Use pre-computed bit offsets if available
  const bitOffsets = bitsPerBlock < 16 ? BIT_OFFSETS[bitsPerBlock] : null;
  
  let i = 0;
  for (let longIndex = 0; longIndex < dataLen && i < totalBlocks; longIndex++) {
    const longValue = longValues[longIndex];
    
    for (let indexInLong = 0; indexInLong < entriesPerLong && i < totalBlocks; indexInLong++) {
      const bitOffset = bitOffsets ? bitOffsets[indexInLong] : BigInt(indexInLong * bitsPerBlock);
      indices[i++] = Number((longValue >> bitOffset) & mask);
    }
  }
  
  return indices;
}

/**
 * Check if a block name is air
 */
function isAirBlock(name) {
  if (!name) return true;
  return AIR_BLOCKS.has(name) || name.endsWith(':air');
}

/**
 * Extract fluid level from block properties
 */
function extractFluidLevel(entry) {
  if (typeof entry !== 'object' || !entry.Properties) {
    return 0; // Default to source block
  }
  
  const level = entry.Properties.level;
  if (level !== undefined) {
    const parsed = parseInt(level, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
  
  return 0; // Source block
}

/**
 * Pre-process a palette into block IDs, air mask, fluid levels, axis, and state info
 */
function preprocessPalette(palette, registry, stateRegistry = null) {
  const len = palette.length;
  const blockIds = new Uint16Array(len);
  const isAir = new Uint8Array(len);
  const levels = new Int8Array(len);
  const axisValues = new Uint8Array(len);  // Axis for rotatable blocks (0=y, 1=x, 2=z)
  const needsState = new Uint8Array(len);  // Track which entries need state storage
  const stateIds = new Uint16Array(len);   // State IDs for non-cube blocks
  const names = new Array(len);            // Block names for state lookup
  const properties = new Array(len);       // Properties for each entry
  
  for (let i = 0; i < len; i++) {
    const entry = palette[i];
    const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
    const props = (typeof entry === 'object' && entry.Properties) ? entry.Properties : null;
    
    names[i] = name;
    properties[i] = props;
    blockIds[i] = registry.getBlockId(name);
    isAir[i] = isAirBlock(name) ? 1 : 0;
    
    // Extract fluid level for water/lava (but not cauldrons which contain fluid internally)
    if ((name.includes('water') || name.includes('lava')) && !FLUID_CONTAINER_BLOCKS.has(name)) {
      levels[i] = extractFluidLevel(entry);
    } else {
      // Check for waterlogged property on non-fluid blocks
      if (typeof entry === 'object' && entry.Properties?.waterlogged === 'true') {
        // Use level 8 as a marker for waterlogged blocks
        levels[i] = 8;
      } 
      // Check for blocks that inherently exist in water (seagrass, kelp, etc.)
      else if (UNDERWATER_BLOCKS.has(name)) {
        levels[i] = 8;
      } else {
        levels[i] = -1; // Not a fluid, not waterlogged
      }
    }
    
    // Extract axis for rotatable blocks (logs, pillars, etc.)
    if (getBakedModelLoader().hasAxisRotation(name) && props?.axis) {
      if (props.axis === 'x') {
        axisValues[i] = AXIS_X;
      } else if (props.axis === 'z') {
        axisValues[i] = AXIS_Z;
      } else {
        axisValues[i] = AXIS_Y; // Default or explicit 'y'
      }
    }
    // Extract facing for directional blocks (furnace, loom, pumpkins, etc.)
    // Uses same bits 12-13 as axis since these block types are mutually exclusive
    else if (DIRECTIONAL_BLOCKS.has(name) && props?.facing) {
      if (props.facing === 'east') {
        axisValues[i] = FACING_EAST;
      } else if (props.facing === 'south') {
        axisValues[i] = FACING_SOUTH;
      } else if (props.facing === 'west') {
        axisValues[i] = FACING_WEST;
      } else {
        axisValues[i] = FACING_NORTH; // Default or explicit 'north'
      }
    }
    
    // Check if this block needs state-based geometry OR has particle emitters
    // We need to track state for both non-cube blocks AND particle emitting blocks
    if (!isAir[i] && (isNonCubeBlock(name) || hasEmitter(name))) {
      needsState[i] = 1;
      if (stateRegistry) {
        stateIds[i] = stateRegistry.register(name, props || {});
      }
    }
  }
  
  return { blockIds, isAir, levels, axisValues, needsState, stateIds, names, properties };
}

/**
 * Decode a single chunk section into the grid - OPTIMIZED
 * @param {Object} section - NBT section data
 * @param {number} chunkX - Chunk X coordinate
 * @param {number} chunkZ - Chunk Z coordinate
 * @param {BinaryGrid} grid - Block data grid
 * @param {BlockRegistry} registry - Block registry
 * @param {BlockStateGrid} stateGrid - Optional state grid for non-cube blocks
 * @param {StateRegistry} stateRegistry - Optional state registry
 * @param {LightGrid} lightGrid - Optional light grid to populate with Minecraft's light data
 */
function decodeSection(section, chunkX, chunkZ, grid, registry, stateGrid = null, stateRegistry = null, lightGrid = null) {
  const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
  // Minecraft section Y is already world-relative: section Y=-4 means world Y=-64
  const baseY = sectionY * SECTION_SIZE;
  
  // Skip sections outside valid range (silently - this is normal for some worlds)
  // Valid Y range: MIN_Y (-64) to MAX_Y (321, exclusive), so sections -4 to 20
  if (baseY < MIN_Y || baseY >= MAX_Y) {
    return 0;
  }
  
  // Convert Minecraft section Y to internal section index (0-based from MIN_Y)
  // MIN_Y=-64 / 16 = -4, so section Y=-4 becomes internal index 0
  const internalSectionY = sectionY - Math.floor(MIN_Y / SECTION_SIZE); // -4 - (-4) = 0
  
  // Parse light data from section if lightGrid is provided
  // Minecraft stores SkyLight and BlockLight as nibble-packed arrays (2048 bytes = 4096 nibbles)
  if (lightGrid) {
    const skyLightData = section.SkyLight || section.sky_light;
    const blockLightData = section.BlockLight || section.block_light;
    
    if (skyLightData || blockLightData) {
      // Mark that this light grid has actual Minecraft light data
      // This affects default behavior for missing sections (dark vs light)
      lightGrid.hasMinecraftLightData = true;
      
      const lightSection = lightGrid._getOrCreateSection(chunkX, chunkZ, internalSectionY);
      
      // Unpack and store sky light (lower nibble of light storage)
      if (skyLightData && skyLightData.length >= 2048) {
        const skyLight = unpackLightData(skyLightData);
        for (let i = 0; i < 4096; i++) {
          // Store sky light in lower nibble
          lightSection[i] = (lightSection[i] & 0xF0) | (skyLight[i] & 0x0F);
        }
      }
      
      // Unpack and store block light (upper nibble of light storage)
      if (blockLightData && blockLightData.length >= 2048) {
        const blockLight = unpackLightData(blockLightData);
        for (let i = 0; i < 4096; i++) {
          // Store block light in upper nibble
          lightSection[i] = (lightSection[i] & 0x0F) | ((blockLight[i] & 0x0F) << 4);
        }
      }
    }
  }
  
  let blocksDecoded = 0;
  
  // Modern format (1.18+) with block_states
  const blockStates = section.block_states;
  if (blockStates) {
    const palette = blockStates.palette;
    if (!palette || palette.length === 0) return 0;
    
    const blockData = blockStates.data;
    const { blockIds, isAir, levels, axisValues, needsState, stateIds } = preprocessPalette(palette, registry, stateRegistry);
    
    // Check if any palette entries need state storage
    const hasNonCubeBlocks = stateGrid && needsState.some(v => v === 1);
    const sectionKey = hasNonCubeBlocks ? makeSectionKey(chunkX, chunkZ, internalSectionY) : null;
    
    // Get or create section once (avoid repeated lookups)
    const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSectionY);
    
    // Single block type section (no data array needed)
    if (palette.length === 1 || !blockData || blockData.length === 0) {
      if (isAir[0]) return 0;
      
      const blockId = blockIds[0];
      // For rotatable blocks, encode axis in bits 12-13; for fluids, use level in bits 12-15
      const level = levels[0] >= 0 ? levels[0] : 0;
      const axis = axisValues[0];
      const metadata = level >= 0 ? level : (axis << 0); // If it's a fluid, use level; otherwise axis
      const value = (blockId & 0x0FFF) | ((axis & 0x3) << AXIS_SHIFT);
      
      // Fill entire section
      gridSection.fill(value);
      grid.totalBlocks += 4096;
      
      // If this single block type needs state, fill state grid too
      if (hasNonCubeBlocks && needsState[0]) {
        for (let i = 0; i < 4096; i++) {
          stateGrid.setState(sectionKey, i, stateIds[0]);
        }
      }
      
      return 4096;
    }
    
    // Calculate bits per block
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
    
    // Decode directly into section - YZX order
    for (let i = 0; i < 4096; i++) {
      const paletteIndex = indices[i];
      
      if (paletteIndex < palette.length && !isAir[paletteIndex]) {
        const blockId = blockIds[paletteIndex];
        const level = levels[paletteIndex];
        const axis = axisValues[paletteIndex];
        
        // Encode metadata in bits 12-15:
        // - For fluids: level (0-15)
        // - For rotatable blocks: axis (0-2) in bits 12-13
        // - For other blocks: 0
        let metadata;
        if (level >= 0) {
          metadata = level; // Fluid level
        } else if (axis > 0) {
          metadata = axis; // Axis value (1=x, 2=z; 0=y is default)
        } else {
          metadata = 0;
        }
        
        gridSection[i] = (blockId & 0x0FFF) | ((metadata & 0xF) << 12);
        blocksDecoded++;
        
        // Store state ID for non-cube blocks
        if (hasNonCubeBlocks && needsState[paletteIndex]) {
          stateGrid.setState(sectionKey, i, stateIds[paletteIndex]);
        }
      }
    }
    
    grid.totalBlocks += blocksDecoded;
    return blocksDecoded;
  }
  
  // Legacy format (1.13-1.17) with Palette and BlockStates
  if (section.Palette && section.BlockStates) {
    const palette = section.Palette;
    const blockData = section.BlockStates;
    
    if (palette.length === 0) return 0;
    
    const { blockIds, isAir, levels, axisValues, needsState, stateIds } = preprocessPalette(palette, registry, stateRegistry);
    const hasNonCubeBlocks = stateGrid && needsState.some(v => v === 1);
    const sectionKey = hasNonCubeBlocks ? makeSectionKey(chunkX, chunkZ, internalSectionY) : null;
    const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSectionY);
    
    // Single block type section
    if (palette.length === 1) {
      if (isAir[0]) return 0;
      
      const blockId = blockIds[0];
      const level = levels[0];
      const axis = axisValues[0];
      const metadata = level >= 0 ? level : (axis > 0 ? axis : 0);
      const value = (blockId & 0x0FFF) | ((metadata & 0xF) << 12);
      
      gridSection.fill(value);
      grid.totalBlocks += 4096;
      
      if (hasNonCubeBlocks && needsState[0]) {
        for (let i = 0; i < 4096; i++) {
          stateGrid.setState(sectionKey, i, stateIds[0]);
        }
      }
      
      return 4096;
    }
    
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
    
    for (let i = 0; i < 4096; i++) {
      const paletteIndex = indices[i];
      
      if (paletteIndex < palette.length && !isAir[paletteIndex]) {
        const blockId = blockIds[paletteIndex];
        const level = levels[paletteIndex];
        const axis = axisValues[paletteIndex];
        const metadata = level >= 0 ? level : (axis > 0 ? axis : 0);
        
        gridSection[i] = (blockId & 0x0FFF) | ((metadata & 0xF) << 12);
        blocksDecoded++;
        
        if (hasNonCubeBlocks && needsState[paletteIndex]) {
          stateGrid.setState(sectionKey, i, stateIds[paletteIndex]);
        }
      }
    }
    
    grid.totalBlocks += blocksDecoded;
    return blocksDecoded;
  }
  
  // Very old format with Blocks byte array (pre-1.13)
  if (section.Blocks) {
    const blocksArray = section.Blocks;
    const addArray = section.Add || null;
    const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSectionY);
    
    for (let i = 0; i < 4096; i++) {
      let blockId = blocksArray[i] & 0xFF;
      
      if (addArray) {
        const addIndex = i >> 1;
        const addValue = addArray[addIndex] & 0xFF;
        if (i % 2 === 0) {
          blockId |= (addValue & 0x0F) << 8;
        } else {
          blockId |= (addValue & 0xF0) << 4;
        }
      }
      
      if (blockId !== 0) {
        const legacyId = registry.getBlockId(`minecraft:legacy_${blockId}`);
        gridSection[i] = legacyId & 0x0FFF;
        blocksDecoded++;
      }
    }
    
    grid.totalBlocks += blocksDecoded;
    return blocksDecoded;
  }
  
  return 0;
}

/**
 * Decode a full chunk into the grid
 * @param {Object} chunk - Parsed chunk with { x, z, data }
 * @param {BinaryGrid} grid - Target grid
 * @param {BlockRegistry} registry - Block registry
 * @param {BlockStateGrid} stateGrid - Optional state grid for non-cube blocks
 * @param {StateRegistry} stateRegistry - Optional state registry
 * @returns {number} Number of blocks decoded
 */
export function decodeChunk(chunk, grid, registry, stateGrid = null, stateRegistry = null, lightGrid = null) {
  const { x: chunkX, z: chunkZ, data } = chunk;
  
  // Get sections array
  const sections = data.sections || (data.Level && data.Level.Sections);
  if (!sections) return 0;
  
  let totalBlocks = 0;
  
  for (const section of sections) {
    totalBlocks += decodeSection(section, chunkX, chunkZ, grid, registry, stateGrid, stateRegistry, lightGrid);
  }
  
  return totalBlocks;
}

/**
 * Decode all chunks from a parsed region into a BinaryGrid
 * @param {Array} chunks - Array of parsed chunks
 * @param {BlockRegistry} registry - Optional block registry (uses global if not provided)
 * @param {Function} onProgress - Optional progress callback (current, total)
 * @param {BlockStateGrid} stateGrid - Optional state grid for non-cube blocks
 * @param {StateRegistry} stateRegistry - Optional state registry
 * @returns {BinaryGrid} Populated grid
 */
export function decodeRegion(chunks, registry = null, onProgress = null, stateGrid = null, stateRegistry = null) {
  const reg = registry || getBlockRegistry();
  const grid = new BinaryGrid();
  
  let totalBlocks = 0;
  
  for (let i = 0; i < chunks.length; i++) {
    totalBlocks += decodeChunk(chunks[i], grid, reg, stateGrid, stateRegistry);
    
    if (onProgress) {
      onProgress(i + 1, chunks.length);
    }
  }
  
  return grid;
}

/**
 * Extract ALL block entity NBT data from chunks for the block inspector.
 * Returns a Map keyed by "x,y,z" containing the full NBT data for each block entity.
 * 
 * Block entities include: chests, signs, banners, beacons, spawners, etc.
 * 
 * @param {Array} chunks - Array of parsed chunks
 * @returns {Map<string, object>} Map of "x,y,z" -> block entity NBT data
 */
export function extractAllBlockEntities(chunks) {
  const blockEntityMap = new Map();
  
  for (const chunk of chunks) {
    const { data } = chunk;
    
    // Block entities are stored differently in different Minecraft versions
    // Modern (1.17+): data.block_entities
    // Legacy: data.Level.TileEntities
    const blockEntities = data.block_entities || (data.Level && data.Level.TileEntities) || [];
    
    for (const entity of blockEntities) {
      // Get position
      const x = entity.x ?? entity.X ?? 0;
      const y = entity.y ?? entity.Y ?? 0;
      const z = entity.z ?? entity.Z ?? 0;
      const key = `${x},${y},${z}`;
      
      // Store the full entity data
      blockEntityMap.set(key, entity);
    }
  }
  
  return blockEntityMap;
}

/**
 * Extract beacon block entity data from chunks
 * Returns both active beacons (Levels > 0) and inactive beacons (Levels = 0)
 * This allows us to distinguish between:
 * - Beacons with valid pyramids (show beam)
 * - Beacons without pyramids (don't show beam)
 * - Beacons with no block entity data (show beam as fallback)
 * 
 * @param {Array} chunks - Array of parsed chunks
 * @returns {{active: Map<string, object>, inactive: Set<string>}} 
 *   - active: Map of "x,y,z" -> beacon data for beacons with Levels > 0
 *   - inactive: Set of "x,y,z" keys for beacons with Levels = 0
 */
export function extractActiveBeacons(chunks) {
  const active = new Map();
  const inactive = new Set();
  
  for (const chunk of chunks) {
    const { data } = chunk;
    
    // Block entities are stored differently in different Minecraft versions
    // Modern (1.17+): data.block_entities
    // Legacy: data.Level.TileEntities
    const blockEntities = data.block_entities || (data.Level && data.Level.TileEntities) || [];
    
    for (const entity of blockEntities) {
      // Check if this is a beacon block entity
      const id = entity.id || entity.Id;
      if (!id) continue;
      
      const idLower = id.toLowerCase();
      if (!idLower.includes('beacon')) continue;
      
      // Get position
      const x = entity.x ?? entity.X ?? 0;
      const y = entity.y ?? entity.Y ?? 0;
      const z = entity.z ?? entity.Z ?? 0;
      const key = `${x},${y},${z}`;
      
      // Get pyramid level (Levels property)
      // In Minecraft: 0 = no valid pyramid, 1-4 = valid pyramid levels
      const levels = entity.Levels ?? entity.levels ?? 0;
      
      if (levels > 0) {
        active.set(key, { x, y, z, levels });
      } else {
        inactive.add(key);
      }
    }
  }
  
  return { active, inactive };
}

/**
 * Supported entity types for extraction
 */
const SUPPORTED_ENTITY_TYPES = new Set([
  'item_frame',
  'glow_item_frame',
  'painting',
  'armor_stand',
]);

/**
 * Extract entities from chunks
 * In modern MC (1.17+), entities are in separate entity region files.
 * In legacy MC, entities are embedded in the chunk's Entities list.
 * 
 * @param {Array} chunks - Array of parsed chunks
 * @returns {Array} Array of entity objects
 */
export function extractEntities(chunks) {
  const entities = [];
  
  for (const chunk of chunks) {
    const { data } = chunk;
    
    // Try different locations for entity storage
    // Modern (1.17+): Entities are in separate files, but some servers embed them
    // Legacy: data.Level.Entities
    const chunkEntities = data.entities || (data.Level && data.Level.Entities) || [];
    
    for (const entity of chunkEntities) {
      const id = (entity.id || entity.Id || '').replace('minecraft:', '');
      
      // Only extract supported entity types
      if (!SUPPORTED_ENTITY_TYPES.has(id)) continue;
      
      // Get position
      const pos = entity.Pos || [];
      const x = pos[0] ?? 0;
      const y = pos[1] ?? 0;
      const z = pos[2] ?? 0;
      
      // Get rotation
      const rotation = entity.Rotation || [];
      const yaw = rotation[0] ?? 0;
      const pitch = rotation[1] ?? 0;
      
      // Get facing direction for hanging entities (item frames, paintings)
      const facing = entity.Facing ?? entity.facing ?? 2; // Default NORTH
      
      // Build extracted entity data
      const extractedEntity = {
        id: `minecraft:${id}`,
        x, y, z,
        yaw, pitch,
        Facing: facing,
      };
      
      // Type-specific data
      if (id === 'item_frame' || id === 'glow_item_frame') {
        extractedEntity.Item = entity.Item || null;
        extractedEntity.ItemRotation = entity.ItemRotation ?? 0;
        extractedEntity.Invisible = entity.Invisible ?? false;
        extractedEntity.Fixed = entity.Fixed ?? false;
      } else if (id === 'painting') {
        extractedEntity.variant = entity.variant || 'minecraft:kebab';
      } else if (id === 'armor_stand') {
        extractedEntity.Pose = entity.Pose || {};
        extractedEntity.ShowArms = entity.ShowArms ?? false;
        extractedEntity.Small = entity.Small ?? false;
        extractedEntity.NoBasePlate = entity.NoBasePlate ?? false;
        extractedEntity.ArmorItems = entity.ArmorItems || [];
        extractedEntity.HandItems = entity.HandItems || [];
      }
      
      entities.push(extractedEntity);
    }
  }
  
  return entities;
}

/**
 * ChunkDecoder class - manages parallel chunk decoding
 */
export class ChunkDecoder {
  constructor(options = {}) {
    this.workerCount = options.workerCount || Math.min(navigator.hardwareConcurrency || 4, 8);
    this.workers = [];
    this.workerBusy = [];
    this.jobQueue = [];
    this.pendingJobs = new Map();
    this.nextJobId = 0;
    
    // Don't initialize workers until needed
    this._workersInitialized = false;
  }
  
  /**
   * Initialize worker pool
   */
  _initWorkers() {
    if (this._workersInitialized) return;
    
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(
        new URL('./workers/DecodeWorker.js', import.meta.url),
        { type: 'module' }
      );
      
      worker.onmessage = (e) => this._handleWorkerMessage(i, e);
      worker.onerror = (e) => console.error('Decode worker error:', e);
      
      this.workers.push(worker);
      this.workerBusy.push(false);
    }
    
    this._workersInitialized = true;
  }
  
  /**
   * Handle worker response
   */
  _handleWorkerMessage(workerIndex, e) {
    const { type, id, gridData, blockCount, error } = e.data;
    
    this.workerBusy[workerIndex] = false;
    
    if (type === 'decodeComplete') {
      const job = this.pendingJobs.get(id);
      if (job) {
        job.resolve({ gridData, blockCount });
        this.pendingJobs.delete(id);
      }
    } else if (type === 'decodeError') {
      const job = this.pendingJobs.get(id);
      if (job) {
        job.reject(new Error(error));
        this.pendingJobs.delete(id);
      }
    }
    
    this._processQueue();
  }
  
  /**
   * Process queued jobs
   */
  _processQueue() {
    while (this.jobQueue.length > 0) {
      const workerIndex = this.workerBusy.indexOf(false);
      if (workerIndex === -1) return;
      
      const job = this.jobQueue.shift();
      this.workerBusy[workerIndex] = true;
      this.workers[workerIndex].postMessage(job.message);
    }
  }
  
  /**
   * Decode chunks using worker pool
   * @param {Array} chunks - Array of parsed chunks
   * @param {BlockRegistry} registry - Block registry to use
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<BinaryGrid>} Populated grid
   */
  async decodeChunksParallel(chunks, registry, onProgress = null) {
    this._initWorkers();
    
    const BATCH_SIZE = Math.max(4, Math.ceil(chunks.length / this.workerCount));
    const batches = [];
    
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      batches.push(chunks.slice(i, i + BATCH_SIZE));
    }
    
    // Export registry for workers
    const registryData = registry.export();
    
    let completed = 0;
    const gridParts = [];
    
    // Process batches
    const batchPromises = batches.map((batch, batchIndex) => {
      return new Promise((resolve, reject) => {
        const id = this.nextJobId++;
        
        this.pendingJobs.set(id, { resolve, reject });
        
        const message = {
          type: 'decodeBatch',
          id,
          chunks: batch,
          registryData,
        };
        
        this.jobQueue.push({ message });
        this._processQueue();
      }).then(result => {
        completed += batches[batchIndex].length;
        onProgress?.(completed, chunks.length);
        gridParts.push(result);
        return result;
      });
    });
    
    await Promise.all(batchPromises);
    
    // Merge all grid parts
    const finalGrid = new BinaryGrid();
    
    for (const part of gridParts) {
      if (part.gridData) {
        const partGrid = BinaryGrid.import(part.gridData);
        
        // Merge sections
        partGrid.forEachSection((section, chunkX, chunkZ, sectionY) => {
          // Copy section data
          for (let i = 0; i < section.length; i++) {
            if (section[i] !== 0) {
              const localX = i % 16;
              const localZ = Math.floor(i / 16) % 16;
              const localY = Math.floor(i / 256);
              
              const blockId = section[i] & 0x0FFF;
              const level = (section[i] >> 12) & 0xF;
              
              const worldY = sectionY * 16 + localY + MIN_Y;
              finalGrid.setBlockLocal(chunkX, chunkZ, localX, worldY, localZ, blockId, level);
            }
          }
        });
      }
    }
    
    return finalGrid;
  }
  
  /**
   * Terminate all workers
   */
  dispose() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.workerBusy = [];
    this._workersInitialized = false;
  }
}

export default ChunkDecoder;

