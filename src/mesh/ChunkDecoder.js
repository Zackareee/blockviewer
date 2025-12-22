/**
 * ChunkDecoder - Decode Minecraft NBT chunks into BinaryGrid format
 * 
 * Handles all Minecraft chunk formats:
 * - Modern (1.18+): sections with block_states
 * - Legacy (1.13-1.17): Palette and BlockStates
 * - Pre-1.13: Blocks byte array
 */

import { BinaryGrid, SECTION_SIZE, MIN_Y } from './BinaryGrid.js';
import { getBlockRegistry } from './BlockRegistry.js';

// Pre-computed BigInt bit offsets for common bitsPerBlock values (4-15)
const BIT_OFFSETS = Array.from({ length: 16 }, (_, i) => 
  Array.from({ length: 64 }, (_, j) => BigInt(j * i))
);

// Air block names for quick lookup
const AIR_BLOCKS = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'air', 'cave_air', 'void_air'
]);

/**
 * Unpack block indices from packed long array (Minecraft 1.16+ format)
 */
function unpackBlockIndices(data, bitsPerBlock, totalBlocks) {
  const indices = new Uint16Array(totalBlocks);
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const entriesPerLong = Math.floor(64 / bitsPerBlock);
  
  // Pre-convert all longs to unsigned BigInts once
  const dataLen = data.length;
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
 * Pre-process a palette into block IDs, air mask, and fluid levels
 */
function preprocessPalette(palette, registry) {
  const len = palette.length;
  const blockIds = new Uint16Array(len);
  const isAir = new Uint8Array(len);
  const levels = new Int8Array(len);
  
  for (let i = 0; i < len; i++) {
    const entry = palette[i];
    const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
    
    blockIds[i] = registry.getBlockId(name);
    isAir[i] = isAirBlock(name) ? 1 : 0;
    
    // Extract fluid level for water/lava
    if (name.includes('water') || name.includes('lava')) {
      levels[i] = extractFluidLevel(entry);
    } else {
      levels[i] = -1; // Not a fluid
    }
  }
  
  return { blockIds, isAir, levels };
}

/**
 * Decode a single chunk section into the grid - OPTIMIZED
 */
function decodeSection(section, chunkX, chunkZ, grid, registry) {
  const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
  // Minecraft section Y is already world-relative: section Y=-4 means world Y=-64
  const baseY = sectionY * SECTION_SIZE;
  
  // Skip sections outside valid range (silently - this is normal for some worlds)
  if (baseY < MIN_Y || baseY > 320) {
    return 0;
  }
  
  // Convert Minecraft section Y to internal section index (0-based from MIN_Y)
  // MIN_Y=-64 / 16 = -4, so section Y=-4 becomes internal index 0
  const internalSectionY = sectionY - Math.floor(MIN_Y / SECTION_SIZE); // -4 - (-4) = 0
  
  let blocksDecoded = 0;
  
  // Modern format (1.18+) with block_states
  const blockStates = section.block_states;
  if (blockStates) {
    const palette = blockStates.palette;
    if (!palette || palette.length === 0) return 0;
    
    const blockData = blockStates.data;
    const { blockIds, isAir, levels } = preprocessPalette(palette, registry);
    
    // Get or create section once (avoid repeated lookups)
    const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSectionY);
    
    // Single block type section (no data array needed)
    if (palette.length === 1 || !blockData || blockData.length === 0) {
      if (isAir[0]) return 0;
      
      const blockId = blockIds[0];
      const level = levels[0] >= 0 ? levels[0] : 0;
      const value = (blockId & 0x0FFF) | ((level & 0xF) << 12);
      
      // Fill entire section
      gridSection.fill(value);
      grid.totalBlocks += 4096;
      return 4096;
    }
    
    // Calculate bits per block
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
    
    // Decode directly into section - YZX order
    for (let i = 0; i < 4096; i++) {
      const paletteIndex = indices[i];
      
      if (paletteIndex < palette.length && !isAir[paletteIndex]) {
        const level = levels[paletteIndex] >= 0 ? levels[paletteIndex] : 0;
        gridSection[i] = (blockIds[paletteIndex] & 0x0FFF) | ((level & 0xF) << 12);
        blocksDecoded++;
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
    
    const { blockIds, isAir, levels } = preprocessPalette(palette, registry);
    const gridSection = grid._getOrCreateSection(chunkX, chunkZ, internalSectionY);
    
    // Single block type section
    if (palette.length === 1) {
      if (isAir[0]) return 0;
      
      const blockId = blockIds[0];
      const level = levels[0] >= 0 ? levels[0] : 0;
      const value = (blockId & 0x0FFF) | ((level & 0xF) << 12);
      
      gridSection.fill(value);
      grid.totalBlocks += 4096;
      return 4096;
    }
    
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
    
    for (let i = 0; i < 4096; i++) {
      const paletteIndex = indices[i];
      
      if (paletteIndex < palette.length && !isAir[paletteIndex]) {
        const level = levels[paletteIndex] >= 0 ? levels[paletteIndex] : 0;
        gridSection[i] = (blockIds[paletteIndex] & 0x0FFF) | ((level & 0xF) << 12);
        blocksDecoded++;
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
 * @returns {number} Number of blocks decoded
 */
export function decodeChunk(chunk, grid, registry) {
  const { x: chunkX, z: chunkZ, data } = chunk;
  
  // Get sections array
  const sections = data.sections || (data.Level && data.Level.Sections);
  if (!sections) return 0;
  
  let totalBlocks = 0;
  
  for (const section of sections) {
    totalBlocks += decodeSection(section, chunkX, chunkZ, grid, registry);
  }
  
  return totalBlocks;
}

/**
 * Decode all chunks from a parsed region into a BinaryGrid
 * @param {Array} chunks - Array of parsed chunks
 * @param {BlockRegistry} registry - Optional block registry (uses global if not provided)
 * @param {Function} onProgress - Optional progress callback (current, total)
 * @returns {BinaryGrid} Populated grid
 */
export function decodeRegion(chunks, registry = null, onProgress = null) {
  const reg = registry || getBlockRegistry();
  const grid = new BinaryGrid();
  
  let totalBlocks = 0;
  
  for (let i = 0; i < chunks.length; i++) {
    totalBlocks += decodeChunk(chunks[i], grid, reg);
    
    if (onProgress) {
      onProgress(i + 1, chunks.length);
    }
  }
  
  return grid;
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

