/**
 * BlockLightPropagator - Block light flood-fill propagation
 * 
 * Implements Minecraft's block light system:
 * - Light sources (torches, glowstone, etc.) emit light at specific levels
 * - Light decrements by 1 per block traveled
 * - Opaque blocks block light completely
 * - Some blocks (water, stained glass) attenuate light
 * 
 * Algorithm:
 * 1. Find all light-emitting blocks and their light levels
 * 2. BFS flood-fill from each light source
 * 3. Take maximum light at each position (multiple sources can overlap)
 * 
 * Performance: Uses a ring buffer queue for O(1) enqueue/dequeue instead of
 * array.shift() which is O(n).
 */

import { MAX_LIGHT } from './LightGrid.js';

/**
 * Ring buffer queue for O(1) enqueue/dequeue operations.
 * Standard array.shift() is O(n) which becomes a bottleneck for BFS with millions of nodes.
 */
class LightQueue {
  constructor(initialCapacity = 65536) {
    this.capacity = initialCapacity;
    // Store as flat typed arrays for cache efficiency
    // Each entry is (x, y, z, light) packed into 4 consecutive Int16 values
    this.data = new Int16Array(initialCapacity * 4);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }
  
  get length() {
    return this.size;
  }
  
  push(item) {
    // Grow if needed
    if (this.size >= this.capacity) {
      this._grow();
    }
    
    const idx = this.tail * 4;
    this.data[idx] = item.x;
    this.data[idx + 1] = item.y;
    this.data[idx + 2] = item.z;
    this.data[idx + 3] = item.light;
    
    this.tail = (this.tail + 1) % this.capacity;
    this.size++;
  }
  
  shift() {
    if (this.size === 0) return undefined;
    
    const idx = this.head * 4;
    const item = {
      x: this.data[idx],
      y: this.data[idx + 1],
      z: this.data[idx + 2],
      light: this.data[idx + 3],
    };
    
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    return item;
  }
  
  _grow() {
    const newCapacity = this.capacity * 2;
    const newData = new Int16Array(newCapacity * 4);
    
    // Copy existing data in order
    for (let i = 0; i < this.size; i++) {
      const oldIdx = ((this.head + i) % this.capacity) * 4;
      const newIdx = i * 4;
      newData[newIdx] = this.data[oldIdx];
      newData[newIdx + 1] = this.data[oldIdx + 1];
      newData[newIdx + 2] = this.data[oldIdx + 2];
      newData[newIdx + 3] = this.data[oldIdx + 3];
    }
    
    this.data = newData;
    this.head = 0;
    this.tail = this.size;
    this.capacity = newCapacity;
  }
}
import { 
  SECTION_SIZE, 
  parseSectionKey,
  sectionToWorldY
} from './BinaryGrid.js';

const BLOCK_ID_MASK = 0x0FFF;

/**
 * Light emission levels for Minecraft blocks
 * Source: https://minecraft.wiki/w/Light#Light-emitting_blocks
 */
export const LIGHT_EMISSION = {
  // Level 15
  'beacon': 15,
  'conduit': 15,
  'end_gateway': 15,
  'end_portal': 15,
  'fire': 15,
  'glowstone': 15,
  'jack_o_lantern': 15,
  'lantern': 15,
  'lava': 15,
  'sea_lantern': 15,
  'shroomlight': 15,
  'campfire': 15,  // When lit
  'soul_campfire': 10, // Soul variant is dimmer
  'respawn_anchor': 15, // When fully charged
  'froglight': 15,
  'pearlescent_froglight': 15,
  'verdant_froglight': 15,
  'ochre_froglight': 15,
  
  // Level 14
  'torch': 14,
  'wall_torch': 14,
  
  // Level 13
  'blast_furnace': 13, // When lit
  'furnace': 13, // When lit
  'smoker': 13, // When lit
  
  // Level 12
  'end_rod': 14,
  'crying_obsidian': 10,
  
  // Level 11
  'nether_portal': 11,
  
  // Level 10
  'soul_torch': 10,
  'soul_wall_torch': 10,
  'soul_lantern': 10,
  'soul_fire': 10,
  
  // Level 9
  'enchanting_table': 7, // Actually 7
  
  // Level 7
  'ender_chest': 7,
  'redstone_torch': 7,
  'redstone_wall_torch': 7,
  'glow_lichen': 7,
  'sculk_catalyst': 6,
  
  // Level 6
  'amethyst_cluster': 5,
  
  // Level 5
  'large_amethyst_bud': 4,
  
  // Level 4
  'medium_amethyst_bud': 2,
  
  // Level 3
  'magma_block': 3,
  
  // Level 2
  'small_amethyst_bud': 1,
  
  // Level 1
  'brewing_stand': 1,
  'brown_mushroom': 1,
  'dragon_egg': 1,
  'sculk_sensor': 1,
  'calibrated_sculk_sensor': 1,
};

/**
 * Get light emission level for a block
 * @param {string} blockName - Block name (e.g., "torch", "glowstone")
 * @returns {number} Light emission level (0-15), 0 if not a light source
 */
export function getBlockLightEmission(blockName) {
  if (!blockName) return 0;
  
  // Check direct match first
  if (LIGHT_EMISSION[blockName] !== undefined) {
    return LIGHT_EMISSION[blockName];
  }
  
  // Check partial matches for variants
  for (const [pattern, level] of Object.entries(LIGHT_EMISSION)) {
    if (blockName.includes(pattern)) {
      return level;
    }
  }
  
  // Sea pickles emit light based on count (underwater only)
  if (blockName.includes('sea_pickle')) {
    return 6; // Base level, varies with count
  }
  
  // Candles emit light when lit (varies with count)
  if (blockName.includes('candle') && !blockName.includes('cake')) {
    return 3; // Base level for single candle
  }
  
  return 0;
}

/**
 * Get light opacity for a block
 * @param {number} blockId - Block ID
 * @param {Uint8Array} isOpaque - Opaque lookup table
 * @param {Uint8Array} isGlass - Glass lookup table
 * @param {Uint8Array} isFluid - Fluid lookup table
 * @returns {number} Light opacity (0-15)
 */
function getLightOpacity(blockId, isOpaque, isGlass, isFluid) {
  if (blockId === 0) return 0; // Air
  if (isGlass[blockId]) return 0; // Glass passes light fully
  if (isFluid[blockId]) return 1; // Water/lava slightly attenuates
  if (isOpaque[blockId]) return 15; // Opaque blocks block all light
  return 0; // Non-cube/transparent blocks pass light
}

/**
 * Propagate block light through the block grid
 * 
 * @param {BinaryGrid} blockGrid - The block data
 * @param {LightGrid} lightGrid - The light grid to populate (block light in upper nibble)
 * @param {BlockRegistry} registry - Block registry for opacity and name lookup
 */
export function propagateBlockLight(blockGrid, lightGrid, registry) {
  const startTime = performance.now();
  
  // Build lookup tables for fast access
  const isOpaque = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096);
  const isFluid = new Uint8Array(4096);
  const isNonCube = new Uint8Array(4096);
  const lightEmission = new Uint8Array(4096); // Light level emitted by each block ID
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info) {
      isOpaque[id] = registry.isOpaque(id) ? 1 : 0;
      isNonCube[id] = registry.isNonCube(id) ? 1 : 0;
      if (info.name) {
        if (info.name.includes('glass') || info.name.includes('ice') || info.name.includes('leaves')) {
          isGlass[id] = 1;
        }
        if (info.name.includes('water') || info.name.includes('lava')) {
          isFluid[id] = 1;
        }
        // Get light emission for this block
        lightEmission[id] = getBlockLightEmission(info.name);
      }
    }
  }
  
  // Find all light sources and build initial queue
  // Use ring buffer queue for O(1) operations instead of O(n) array.shift()
  const queue = new LightQueue();
  
  for (const [key, section] of blockGrid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
    const baseX = chunkX * SECTION_SIZE;
    const baseY = sectionToWorldY(sectionY);
    const baseZ = chunkZ * SECTION_SIZE;
    
    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      const worldY = baseY + ly;
      const sliceBase = ly * SECTION_SIZE * SECTION_SIZE;
      
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          const idx = sliceBase + lz * SECTION_SIZE + lx;
          const blockId = section[idx] & BLOCK_ID_MASK;
          
          const emission = lightEmission[blockId];
          if (emission > 0) {
            const worldX = baseX + lx;
            const worldZ = baseZ + lz;
            
            // Set initial block light at source
            lightGrid.setBlockLight(worldX, worldY, worldZ, emission);
            
            // Add to propagation queue
            queue.push({ x: worldX, y: worldY, z: worldZ, light: emission });
          }
        }
      }
    }
  }
  
  // BFS flood-fill from all light sources
  // Direction offsets: ±X, ±Y, ±Z
  const DIRECTIONS = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  
  let iterations = 0;
  
  while (queue.length > 0) {
    const { x, y, z, light } = queue.shift();
    iterations++;
    
    // The new light level after spreading is one less
    const newLight = light - 1;
    if (newLight <= 0) continue;
    
    // Try to spread to all 6 neighbors
    for (const [dx, dy, dz] of DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      
      // Get neighbor block ID
      const neighborBlockId = blockGrid.getBlockId(nx, ny, nz);
      
      // Get opacity of neighbor
      const opacity = getLightOpacity(neighborBlockId, isOpaque, isGlass, isFluid);
      
      // If fully opaque, can't spread
      if (opacity >= 15) continue;
      
      // Calculate attenuated light level
      const attenuatedLight = newLight - opacity;
      if (attenuatedLight <= 0) continue;
      
      // Check current light level at neighbor
      const currentLight = lightGrid.getBlockLight(nx, ny, nz);
      
      // Only update if this produces brighter light
      if (attenuatedLight > currentLight) {
        lightGrid.setBlockLight(nx, ny, nz, attenuatedLight);
        queue.push({ x: nx, y: ny, z: nz, light: attenuatedLight });
      }
    }
  }
  
  const elapsed = performance.now() - startTime;
  console.log(`[BlockLightPropagator] Propagated block light in ${elapsed.toFixed(1)}ms, ${iterations} iterations`);
}

export default propagateBlockLight;

