/**
 * FluidMesher - Height-aware meshing for water and lava
 * 
 * Handles fluid blocks with variable heights and sloped surfaces
 * for flowing water/lava. Corner heights are interpolated from
 * neighboring blocks for smooth slopes.
 */

import { SECTION_SIZE, BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, blockIndexInSection, sectionToWorldY } from './BinaryGrid.js';
import { BlockCategory, getBlockRegistry } from './BlockRegistry.js';

/**
 * Convert fluid level to height (0.0 to 1.0)
 * 
 * Minecraft fluid levels:
 * - 0: Source block (full height ~0.875)
 * - 1-7: Flowing (progressively lower)
 * - 8-15: Falling (vertical flow, full height)
 */
function fluidLevelToHeight(level) {
  if (level === undefined || level === null || level < 0) {
    return 14 / 16; // Source blocks ~0.875
  }
  
  // Falling fluid (level 8-15) is full height
  if (level >= 8) {
    return 1.0;
  }
  
  // Flowing fluid (level 1-7): height decreases linearly
  const height = (14 - level * 1.5) / 16;
  return Math.max(2 / 16, height); // Minimum height of 2/16
}

/**
 * Calculate corner heights for a fluid block with neighbor interpolation
 */
function calculateFluidCornerHeights(x, y, z, grid, registry, fluidType) {
  const ownLevel = grid.getLevel(x, y, z);
  const ownHeight = fluidLevelToHeight(ownLevel);
  
  // Check if there's fluid above - if so, this block is submerged
  const aboveId = grid.getBlockId(x, y + 1, z);
  const aboveInfo = registry.getBlockInfo(aboveId);
  if (aboveInfo && aboveInfo.name.includes(fluidType)) {
    return { nw: 1.0, ne: 1.0, se: 1.0, sw: 1.0 };
  }
  
  // For source blocks (level 0) and falling water (level 8+), use flat top
  if (ownLevel === undefined || ownLevel === 0 || ownLevel >= 8) {
    return { nw: ownHeight, ne: ownHeight, se: ownHeight, sw: ownHeight };
  }
  
  // For flowing blocks, calculate corner heights by averaging neighbors
  const getNeighborInfo = (nx, nz) => {
    const neighborId = grid.getBlockId(nx, y, nz);
    const neighborInfo = registry.getBlockInfo(neighborId);
    
    if (neighborInfo && neighborInfo.name.includes(fluidType)) {
      // Check if neighbor has fluid above
      const neighborAboveId = grid.getBlockId(nx, y + 1, nz);
      const neighborAboveInfo = registry.getBlockInfo(neighborAboveId);
      if (neighborAboveInfo && neighborAboveInfo.name.includes(fluidType)) {
        return { height: 1.0, isNonFlowing: true };
      }
      
      const level = grid.getLevel(nx, y, nz);
      const height = fluidLevelToHeight(level);
      const isNonFlowing = level === 0 || level >= 8;
      return { height, isNonFlowing };
    }
    
    // If neighbor is solid, don't contribute
    if (neighborInfo && registry.isOpaque(neighborId)) {
      return null;
    }
    
    // Air/empty - water slopes down
    return { height: 0, isNonFlowing: false };
  };
  
  const calculateCorner = (offsets) => {
    const neighbors = [];
    let hasNonFlowing = false;
    let maxNonFlowingHeight = ownHeight;
    
    for (const [dx, dz] of offsets) {
      const info = getNeighborInfo(x + dx, z + dz);
      if (info !== null) {
        neighbors.push(info);
        if (info.isNonFlowing) {
          hasNonFlowing = true;
          maxNonFlowingHeight = Math.max(maxNonFlowingHeight, info.height);
        }
      }
    }
    
    // If any neighbor is source/falling, use max height
    if (hasNonFlowing) {
      return maxNonFlowingHeight;
    }
    
    // Average all heights
    let sum = ownHeight;
    let count = 1;
    for (const info of neighbors) {
      sum += info.height;
      count++;
    }
    
    return sum / count;
  };
  
  // Corner neighbor offsets
  const nw = calculateCorner([[-1, 0], [0, -1], [-1, -1]]);
  const ne = calculateCorner([[1, 0], [0, -1], [1, -1]]);
  const se = calculateCorner([[1, 0], [0, 1], [1, 1]]);
  const sw = calculateCorner([[-1, 0], [0, 1], [-1, 1]]);
  
  return { nw, ne, se, sw };
}

/**
 * FluidMesher class
 */
export class FluidMesher {
  constructor(registry = null) {
    this.registry = registry || getBlockRegistry();
  }
  
  /**
   * Build mesh for all fluid blocks of a specific type
   * @param {BinaryGrid} grid - Source grid
   * @param {string} fluidType - 'water' or 'lava'
   * @param {Object} offset - World offset
   * @returns {Object} Mesh data or null
   */
  buildFluidMesh(grid, fluidType, offset = { x: 0, y: 0, z: 0 }) {
    const fluidBlocks = [];
    
    // Collect all fluid blocks
    grid.forEachSection((section, chunkX, chunkZ, sectionY) => {
      const baseY = sectionToWorldY(sectionY);
      
      for (let i = 0; i < section.length; i++) {
        const blockId = section[i] & BLOCK_ID_MASK;
        if (blockId === 0) continue;
        
        const info = this.registry.getBlockInfo(blockId);
        if (!info || !info.name.includes(fluidType)) continue;
        
        const localX = i % SECTION_SIZE;
        const localZ = Math.floor(i / SECTION_SIZE) % SECTION_SIZE;
        const localY = Math.floor(i / (SECTION_SIZE * SECTION_SIZE));
        
        const level = (section[i] & LEVEL_MASK) >> LEVEL_SHIFT;
        
        fluidBlocks.push({
          x: chunkX * SECTION_SIZE + localX,
          y: baseY + localY,
          z: chunkZ * SECTION_SIZE + localZ,
          blockId,
          level,
        });
      }
    });
    
    if (fluidBlocks.length === 0) return null;
    
    // Pre-allocate arrays
    const maxQuads = fluidBlocks.length * 6;
    const positions = new Float32Array(maxQuads * 4 * 3);
    const normals = new Float32Array(maxQuads * 4 * 3);
    const colors = new Float32Array(maxQuads * 4 * 3);
    const indices = new Uint32Array(maxQuads * 6);
    
    let vertexCount = 0;
    let posIdx = 0;
    let normIdx = 0;
    let colorIdx = 0;
    let indexIdx = 0;
    
    // Build faces for each fluid block
    for (const block of fluidBlocks) {
      const { x, y, z, blockId } = block;
      
      // Calculate corner heights
      const heights = calculateFluidCornerHeights(x, y, z, grid, this.registry, fluidType);
      
      const color = this.registry.getColor(blockId);
      
      // Check face visibility (cull against solid and same-type fluid)
      const shouldCull = (nx, ny, nz) => {
        const neighborId = grid.getBlockId(nx, ny, nz);
        if (neighborId === 0) return false;
        
        const neighborInfo = this.registry.getBlockInfo(neighborId);
        if (!neighborInfo) return false;
        
        // Cull against solid blocks
        if (this.registry.isOpaque(neighborId)) return true;
        
        // Cull against same fluid type
        if (neighborInfo.name.includes(fluidType)) return true;
        
        return false;
      };
      
      // Adjusted coordinates
      const wx = x - offset.x;
      const wy = y - offset.y;
      const wz = z - offset.z;
      
      // TOP FACE
      if (!shouldCull(x, y + 1, z)) {
        const startVertex = vertexCount;
        
        // SW, SE, NE, NW corners
        const topVerts = [
          [wx,     wy + heights.sw, wz + 1],
          [wx + 1, wy + heights.se, wz + 1],
          [wx + 1, wy + heights.ne, wz    ],
          [wx,     wy + heights.nw, wz    ],
        ];
        
        for (const [vx, vy, vz] of topVerts) {
          positions[posIdx++] = vx;
          positions[posIdx++] = vy;
          positions[posIdx++] = vz;
          normals[normIdx++] = 0;
          normals[normIdx++] = 1;
          normals[normIdx++] = 0;
          colors[colorIdx++] = color.r;
          colors[colorIdx++] = color.g;
          colors[colorIdx++] = color.b;
          vertexCount++;
        }
        
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 1;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex + 3;
      }
      
      // BOTTOM FACE
      if (!shouldCull(x, y - 1, z)) {
        const startVertex = vertexCount;
        
        const bottomVerts = [
          [wx,     wy, wz    ],
          [wx + 1, wy, wz    ],
          [wx + 1, wy, wz + 1],
          [wx,     wy, wz + 1],
        ];
        
        for (const [vx, vy, vz] of bottomVerts) {
          positions[posIdx++] = vx;
          positions[posIdx++] = vy;
          positions[posIdx++] = vz;
          normals[normIdx++] = 0;
          normals[normIdx++] = -1;
          normals[normIdx++] = 0;
          colors[colorIdx++] = color.r;
          colors[colorIdx++] = color.g;
          colors[colorIdx++] = color.b;
          vertexCount++;
        }
        
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 1;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex + 3;
      }
      
      // FRONT FACE (+Z)
      if (!shouldCull(x, y, z + 1)) {
        const startVertex = vertexCount;
        
        const frontVerts = [
          [wx,     wy,              wz + 1],
          [wx + 1, wy,              wz + 1],
          [wx + 1, wy + heights.se, wz + 1],
          [wx,     wy + heights.sw, wz + 1],
        ];
        
        for (const [vx, vy, vz] of frontVerts) {
          positions[posIdx++] = vx;
          positions[posIdx++] = vy;
          positions[posIdx++] = vz;
          normals[normIdx++] = 0;
          normals[normIdx++] = 0;
          normals[normIdx++] = 1;
          colors[colorIdx++] = color.r;
          colors[colorIdx++] = color.g;
          colors[colorIdx++] = color.b;
          vertexCount++;
        }
        
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 1;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex + 3;
      }
      
      // BACK FACE (-Z)
      if (!shouldCull(x, y, z - 1)) {
        const startVertex = vertexCount;
        
        const backVerts = [
          [wx + 1, wy,              wz],
          [wx,     wy,              wz],
          [wx,     wy + heights.nw, wz],
          [wx + 1, wy + heights.ne, wz],
        ];
        
        for (const [vx, vy, vz] of backVerts) {
          positions[posIdx++] = vx;
          positions[posIdx++] = vy;
          positions[posIdx++] = vz;
          normals[normIdx++] = 0;
          normals[normIdx++] = 0;
          normals[normIdx++] = -1;
          colors[colorIdx++] = color.r;
          colors[colorIdx++] = color.g;
          colors[colorIdx++] = color.b;
          vertexCount++;
        }
        
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 1;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex + 3;
      }
      
      // RIGHT FACE (+X)
      if (!shouldCull(x + 1, y, z)) {
        const startVertex = vertexCount;
        
        const rightVerts = [
          [wx + 1, wy,              wz    ],
          [wx + 1, wy + heights.ne, wz    ],
          [wx + 1, wy + heights.se, wz + 1],
          [wx + 1, wy,              wz + 1],
        ];
        
        for (const [vx, vy, vz] of rightVerts) {
          positions[posIdx++] = vx;
          positions[posIdx++] = vy;
          positions[posIdx++] = vz;
          normals[normIdx++] = 1;
          normals[normIdx++] = 0;
          normals[normIdx++] = 0;
          colors[colorIdx++] = color.r;
          colors[colorIdx++] = color.g;
          colors[colorIdx++] = color.b;
          vertexCount++;
        }
        
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 1;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex + 3;
      }
      
      // LEFT FACE (-X)
      if (!shouldCull(x - 1, y, z)) {
        const startVertex = vertexCount;
        
        const leftVerts = [
          [wx, wy,              wz + 1],
          [wx, wy + heights.sw, wz + 1],
          [wx, wy + heights.nw, wz    ],
          [wx, wy,              wz    ],
        ];
        
        for (const [vx, vy, vz] of leftVerts) {
          positions[posIdx++] = vx;
          positions[posIdx++] = vy;
          positions[posIdx++] = vz;
          normals[normIdx++] = -1;
          normals[normIdx++] = 0;
          normals[normIdx++] = 0;
          colors[colorIdx++] = color.r;
          colors[colorIdx++] = color.g;
          colors[colorIdx++] = color.b;
          vertexCount++;
        }
        
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 1;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex;
        indices[indexIdx++] = startVertex + 2;
        indices[indexIdx++] = startVertex + 3;
      }
    }
    
    if (vertexCount === 0) return null;
    
    return {
      positions: positions.slice(0, posIdx),
      normals: normals.slice(0, normIdx),
      colors: colors.slice(0, colorIdx),
      indices: indices.slice(0, indexIdx),
      vertexCount,
      triangleCount: indexIdx / 3,
      blockCount: fluidBlocks.length,
    };
  }
  
  /**
   * Build water mesh
   */
  buildWaterMesh(grid, offset) {
    return this.buildFluidMesh(grid, 'water', offset);
  }
  
  /**
   * Build lava mesh
   */
  buildLavaMesh(grid, offset) {
    return this.buildFluidMesh(grid, 'lava', offset);
  }
}

/**
 * Standalone functions for worker use
 */
export function buildWaterMesh(grid, registry, offset) {
  const mesher = new FluidMesher(registry);
  return mesher.buildWaterMesh(grid, offset);
}

export function buildLavaMesh(grid, registry, offset) {
  const mesher = new FluidMesher(registry);
  return mesher.buildLavaMesh(grid, offset);
}

export default FluidMesher;

