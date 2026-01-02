/**
 * LightPropagator - Sky light flood-fill propagation
 * 
 * Implements Minecraft's sky light system for noon (time=6000):
 * - Full sunlight (15) propagates straight down through air
 * - Light decrements by 1 when spreading horizontally or through transparent blocks
 * - Opaque blocks completely block light
 * - Glass and other transparent blocks allow light through with optional attenuation
 * 
 * Algorithm:
 * 1. Build heightmap (highest opaque block per column)
 * 2. Set sky light = 15 for all air above heightmap
 * 3. BFS flood-fill light into shadowed areas
 * 
 * Performance: Uses a ring buffer queue for O(1) enqueue/dequeue instead of
 * array.shift() which is O(n).
 */

import { MAX_LIGHT, LightGrid } from './LightGrid.js';

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
  MIN_Y, 
  MAX_Y,
  parseSectionKey,
  sectionToWorldY,
  makeSectionKey
} from './BinaryGrid.js';

const BLOCK_ID_MASK = 0x0FFF;

/**
 * Get light opacity for a block
 * @param {number} blockId - Block ID
 * @param {Object} registry - Block registry
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
 * Propagate sky light through the block grid
 * 
 * @param {BinaryGrid} blockGrid - The block data
 * @param {LightGrid} lightGrid - The light grid to populate
 * @param {BlockRegistry} registry - Block registry for opacity lookup
 */
export function propagateSkyLight(blockGrid, lightGrid, registry) {
  const startTime = performance.now();
  
  // Build lookup tables for fast access
  const isOpaque = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096);
  const isFluid = new Uint8Array(4096);
  const isNonCube = new Uint8Array(4096);
  
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
      }
    }
  }
  
  // Get bounds from block grid
  const bounds = blockGrid.getBounds();
  if (!bounds) {
    console.log('[LightPropagator] No bounds, skipping light propagation');
    return;
  }
  
  const { minX, maxX, minZ, maxZ, minY, maxY } = bounds;
  
  // Phase 1: Build heightmap and set initial sky light
  // For each (x, z) column, find highest opaque block
  // Set sky light = 15 for all blocks above that height
  
  const width = maxX - minX + 1;
  const depth = maxZ - minZ + 1;
  
  // Heightmap: highest Y that blocks light for each (x, z)
  // Value of minY - 1 means no blocking blocks in column
  const heightmap = new Int16Array(width * depth);
  heightmap.fill(minY - 1);
  
  // Scan all sections to find highest opaque blocks
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
          
          if (blockId === 0) continue;
          
          // Check if this block blocks light from above
          const opacity = getLightOpacity(blockId, isOpaque, isGlass, isFluid);
          if (opacity > 0) {
            const worldX = baseX + lx;
            const worldZ = baseZ + lz;
            
            // Bounds check
            if (worldX < minX || worldX > maxX || worldZ < minZ || worldZ > maxZ) continue;
            
            const hmIdx = (worldX - minX) + (worldZ - minZ) * width;
            if (worldY > heightmap[hmIdx]) {
              heightmap[hmIdx] = worldY;
            }
          }
        }
      }
    }
  }
  
  // Phase 2: Set sky light = 15 for all positions above heightmap
  // Also prepare BFS queue for propagation into shadows
  // Use ring buffer queue for O(1) operations instead of O(n) array.shift()
  const queue = new LightQueue();
  
  for (const [key, section] of blockGrid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(key);
    const baseX = chunkX * SECTION_SIZE;
    const baseY = sectionToWorldY(sectionY);
    const baseZ = chunkZ * SECTION_SIZE;
    
    // Get or create corresponding light section
    const lightSection = lightGrid._getOrCreateSection(chunkX, chunkZ, sectionY);
    
    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      const worldY = baseY + ly;
      const sliceBase = ly * SECTION_SIZE * SECTION_SIZE;
      
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          const worldX = baseX + lx;
          const worldZ = baseZ + lz;
          
          // Bounds check
          if (worldX < minX || worldX > maxX || worldZ < minZ || worldZ > maxZ) continue;
          
          const hmIdx = (worldX - minX) + (worldZ - minZ) * width;
          const heightmapY = heightmap[hmIdx];
          
          const idx = sliceBase + lz * SECTION_SIZE + lx;
          const blockId = section[idx] & BLOCK_ID_MASK;
          
          if (worldY > heightmapY) {
            // Above heightmap - full sunlight
            lightSection[idx] = MAX_LIGHT;
            
            // Add to queue if this block is near the shadow boundary
            // Check if any horizontal neighbor has lower heightmap (is in shadow)
            let needsQueue = false;
            
            // Check 4 horizontal neighbors
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = worldX + dx;
              const nz = worldZ + dz;
              if (nx >= minX && nx <= maxX && nz >= minZ && nz <= maxZ) {
                const nhmIdx = (nx - minX) + (nz - minZ) * width;
                if (heightmap[nhmIdx] >= worldY) {
                  // This neighbor is in shadow at this Y level
                  needsQueue = true;
                  break;
                }
              }
            }
            
            // Also queue if directly above the heightmap (vertical light entry)
            if (worldY === heightmapY + 1) {
              needsQueue = true;
            }
            
            if (needsQueue) {
              queue.push({ x: worldX, y: worldY, z: worldZ, light: MAX_LIGHT });
            }
          } else if (blockId === 0 || isGlass[blockId] || isNonCube[blockId]) {
            // Air or transparent block below heightmap - needs light propagation
            // These start at 0 and will receive light from BFS
            lightSection[idx] = 0;
          }
        }
      }
    }
  }
  
  // Phase 3: BFS flood-fill light into shadowed areas
  // Start from blocks at the edge of sunlight and spread horizontally/downward
  
  const dx = [1, -1, 0, 0, 0, 0];
  const dy = [0, 0, 1, -1, 0, 0];
  const dz = [0, 0, 0, 0, 1, -1];
  
  let iterations = 0;
  const maxIterations = 10000000; // Safety limit
  
  while (queue.length > 0 && iterations < maxIterations) {
    iterations++;
    const { x, y, z, light } = queue.shift();
    
    if (light <= 1) continue;
    
    // Spread to 6 neighbors
    for (let i = 0; i < 6; i++) {
      const nx = x + dx[i];
      const ny = y + dy[i];
      const nz = z + dz[i];
      
      // Y bounds check
      if (ny < minY || ny > maxY) continue;
      
      // Get neighbor block
      const neighborBlockId = blockGrid.getBlockId(nx, ny, nz);
      
      // Calculate new light level
      const opacity = getLightOpacity(neighborBlockId, isOpaque, isGlass, isFluid);
      
      // If fully opaque, light can't spread here
      if (opacity >= 15) continue;
      
      // Light decrements when spreading
      const newLight = light - 1 - opacity;
      if (newLight <= 0) continue;
      
      // Check current light at neighbor
      const currentLight = lightGrid.getSkyLight(nx, ny, nz);
      
      // Only spread if new light is brighter
      if (newLight > currentLight) {
        lightGrid.setSkyLight(nx, ny, nz, newLight);
        queue.push({ x: nx, y: ny, z: nz, light: newLight });
      }
    }
  }
  
  const elapsed = performance.now() - startTime;
  console.log(`[LightPropagator] Propagated sky light in ${elapsed.toFixed(1)}ms (${iterations} iterations)`);
}

export default propagateSkyLight;


