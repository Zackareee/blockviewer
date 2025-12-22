/**
 * BinaryGreedyMesher - Optimized greedy meshing for binary grid data
 * 
 * Operates directly on BinaryGrid data without creating intermediate objects.
 * Uses typed arrays throughout for maximum performance.
 */

import { SECTION_SIZE, BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, blockIndexInSection, sectionToWorldY } from './BinaryGrid.js';
import { BlockCategory, getBlockRegistry } from './BlockRegistry.js';

// Face definitions with winding order
const FACES = [
  { name: 'top',    axis: 1, dir: 1,  normal: [0, 1, 0],  u: 0, v: 2 },
  { name: 'bottom', axis: 1, dir: -1, normal: [0, -1, 0], u: 0, v: 2 },
  { name: 'right',  axis: 0, dir: 1,  normal: [1, 0, 0],  u: 2, v: 1 },
  { name: 'left',   axis: 0, dir: -1, normal: [-1, 0, 0], u: 2, v: 1 },
  { name: 'front',  axis: 2, dir: 1,  normal: [0, 0, 1],  u: 0, v: 1 },
  { name: 'back',   axis: 2, dir: -1, normal: [0, 0, -1], u: 0, v: 1 },
];

// Corner generators for each face type
function getTopCorners(x, y, z, w, h) {
  return [
    [x,     y + 1, z + h],
    [x + w, y + 1, z + h],
    [x + w, y + 1, z    ],
    [x,     y + 1, z    ],
  ];
}

function getBottomCorners(x, y, z, w, h) {
  return [
    [x,     y, z    ],
    [x + w, y, z    ],
    [x + w, y, z + h],
    [x,     y, z + h],
  ];
}

function getRightCorners(x, y, z, w, h) {
  return [
    [x + 1, y,     z    ],
    [x + 1, y + h, z    ],
    [x + 1, y + h, z + w],
    [x + 1, y,     z + w],
  ];
}

function getLeftCorners(x, y, z, w, h) {
  return [
    [x, y,     z + w],
    [x, y + h, z + w],
    [x, y + h, z    ],
    [x, y,     z    ],
  ];
}

function getFrontCorners(x, y, z, w, h) {
  return [
    [x,     y,     z + 1],
    [x + w, y,     z + 1],
    [x + w, y + h, z + 1],
    [x,     y + h, z + 1],
  ];
}

function getBackCorners(x, y, z, w, h) {
  return [
    [x + w, y,     z],
    [x,     y,     z],
    [x,     y + h, z],
    [x + w, y + h, z],
  ];
}

const CORNER_GENERATORS = [
  getTopCorners,
  getBottomCorners,
  getRightCorners,
  getLeftCorners,
  getFrontCorners,
  getBackCorners,
];

/**
 * BinaryGreedyMesher class
 */
export class BinaryGreedyMesher {
  constructor(registry = null) {
    this.registry = registry || getBlockRegistry();
  }
  
  /**
   * Build mesh for a single chunk column (all sections)
   * @param {BinaryGrid} grid - Source grid
   * @param {number} chunkX - Chunk X coordinate
   * @param {number} chunkZ - Chunk Z coordinate
   * @param {Object} offset - World offset {x, y, z}
   * @returns {Object} { positions, normals, colors, indices } as typed arrays
   */
  buildChunkMesh(grid, chunkX, chunkZ, offset = { x: 0, y: 0, z: 0 }) {
    // Get all sections for this chunk
    const chunkSections = grid.getChunkColumn(chunkX, chunkZ);
    
    if (chunkSections.size === 0) {
      return null;
    }
    
    // Estimate output size (6 faces × 4 vertices × worst case)
    // Greedy meshing significantly reduces this
    let estimatedBlocks = 0;
    for (const section of chunkSections.values()) {
      for (let i = 0; i < section.length; i++) {
        if ((section[i] & BLOCK_ID_MASK) !== 0) estimatedBlocks++;
      }
    }
    
    const estimatedQuads = estimatedBlocks * 3; // Average 3 visible faces per block
    const positions = new Float32Array(estimatedQuads * 4 * 3);
    const normals = new Float32Array(estimatedQuads * 4 * 3);
    const colors = new Float32Array(estimatedQuads * 4 * 3);
    const indices = new Uint32Array(estimatedQuads * 6);
    
    let vertexCount = 0;
    let posIdx = 0;
    let normIdx = 0;
    let colorIdx = 0;
    let indexIdx = 0;
    
    // Process each section
    for (const [sectionY, section] of chunkSections) {
      const baseY = sectionToWorldY(sectionY);
      
      // Build mesh for this section
      const sectionResult = this._buildSectionMesh(
        section, grid, chunkX, chunkZ, sectionY, baseY, offset
      );
      
      if (!sectionResult) continue;
      
      // Check if we need to grow arrays
      const neededVerts = vertexCount + sectionResult.vertexCount;
      const neededIndices = indexIdx + sectionResult.indexCount;
      
      if (neededVerts * 3 > positions.length) {
        // Reallocate (shouldn't happen often with good estimates)
        const newPositions = new Float32Array(positions.length * 2);
        const newNormals = new Float32Array(normals.length * 2);
        const newColors = new Float32Array(colors.length * 2);
        newPositions.set(positions);
        newNormals.set(normals);
        newColors.set(colors);
        positions = newPositions;
        normals = newNormals;
        colors = newColors;
      }
      
      if (neededIndices > indices.length) {
        const newIndices = new Uint32Array(indices.length * 2);
        newIndices.set(indices);
        indices = newIndices;
      }
      
      // Copy data with vertex offset adjustment for indices
      positions.set(sectionResult.positions, posIdx);
      normals.set(sectionResult.normals, normIdx);
      colors.set(sectionResult.colors, colorIdx);
      
      // Adjust indices for vertex offset
      for (let i = 0; i < sectionResult.indexCount; i++) {
        indices[indexIdx + i] = sectionResult.indices[i] + vertexCount;
      }
      
      posIdx += sectionResult.positions.length;
      normIdx += sectionResult.normals.length;
      colorIdx += sectionResult.colors.length;
      indexIdx += sectionResult.indexCount;
      vertexCount += sectionResult.vertexCount;
    }
    
    if (vertexCount === 0) return null;
    
    return {
      positions: positions.slice(0, posIdx),
      normals: normals.slice(0, normIdx),
      colors: colors.slice(0, colorIdx),
      indices: indices.slice(0, indexIdx),
      vertexCount,
      triangleCount: indexIdx / 3,
    };
  }
  
  /**
   * Build mesh for a single 16x16x16 section
   */
  _buildSectionMesh(section, grid, chunkX, chunkZ, sectionY, baseY, offset) {
    // Count non-air solid blocks
    let solidCount = 0;
    for (let i = 0; i < section.length; i++) {
      const blockId = section[i] & BLOCK_ID_MASK;
      if (blockId !== 0) {
        const info = this.registry.getBlockInfo(blockId);
        if (info && info.category === BlockCategory.SOLID) {
          solidCount++;
        }
      }
    }
    
    if (solidCount === 0) return null;
    
    // Pre-allocate output arrays
    const maxQuads = solidCount * 6;
    const positions = new Float32Array(maxQuads * 4 * 3);
    const normals = new Float32Array(maxQuads * 4 * 3);
    const colors = new Float32Array(maxQuads * 4 * 3);
    const indices = new Uint32Array(maxQuads * 6);
    
    let vertexCount = 0;
    let posIdx = 0;
    let normIdx = 0;
    let colorIdx = 0;
    let indexIdx = 0;
    
    // Process each face direction
    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
      const face = FACES[faceIdx];
      const { axis, dir, normal, u, v } = face;
      const getCorners = CORNER_GENERATORS[faceIdx];
      const w = axis;
      
      // Dimension sizes
      const dimU = SECTION_SIZE;
      const dimV = SECTION_SIZE;
      const dimW = SECTION_SIZE;
      
      // For each slice along the face normal axis
      for (let d = 0; d < dimW; d++) {
        // Build visibility mask for this slice
        const mask = new Uint16Array(dimU * dimV);
        
        for (let j = 0; j < dimV; j++) {
          for (let i = 0; i < dimU; i++) {
            // Convert 2D mask coords to 3D section coords
            const coords = [0, 0, 0];
            coords[u] = i;
            coords[v] = j;
            coords[w] = d;
            
            const [localX, localY, localZ] = coords;
            const idx = blockIndexInSection(localX, localY, localZ);
            const blockId = section[idx] & BLOCK_ID_MASK;
            
            if (blockId === 0) continue;
            
            // Check if this is a solid block
            const info = this.registry.getBlockInfo(blockId);
            if (!info || info.category !== BlockCategory.SOLID) continue;
            
            // Check neighbor visibility
            const neighborCoords = [...coords];
            neighborCoords[w] += dir;
            
            let neighborOpaque = false;
            
            if (neighborCoords[w] >= 0 && neighborCoords[w] < SECTION_SIZE) {
              // Neighbor is within this section
              const neighborIdx = blockIndexInSection(
                neighborCoords[0], neighborCoords[1], neighborCoords[2]
              );
              const neighborId = section[neighborIdx] & BLOCK_ID_MASK;
              neighborOpaque = this.registry.isOpaque(neighborId);
            } else {
              // Neighbor is in adjacent section - check grid
              const worldX = chunkX * SECTION_SIZE + localX;
              const worldY = baseY + localY + (dir === 1 && axis === 1 ? 1 : 0);
              const worldZ = chunkZ * SECTION_SIZE + localZ;
              
              let checkX = worldX, checkY = worldY, checkZ = worldZ;
              if (axis === 0) checkX += dir;
              if (axis === 1) checkY += dir;
              if (axis === 2) checkZ += dir;
              
              const neighborId = grid.getBlockId(checkX, checkY, checkZ);
              neighborOpaque = this.registry.isOpaque(neighborId);
            }
            
            if (!neighborOpaque) {
              mask[i + j * dimU] = blockId;
            }
          }
        }
        
        // Greedy merge the mask
        const visited = new Uint8Array(dimU * dimV);
        
        for (let j = 0; j < dimV; j++) {
          for (let i = 0; i < dimU; i++) {
            const maskIdx = i + j * dimU;
            if (visited[maskIdx] || mask[maskIdx] === 0) continue;
            
            const blockId = mask[maskIdx];
            
            // Expand width (along u axis)
            let width = 1;
            while (i + width < dimU) {
              const nextIdx = (i + width) + j * dimU;
              if (visited[nextIdx] || mask[nextIdx] !== blockId) break;
              width++;
            }
            
            // Expand height (along v axis)
            let height = 1;
            let canExpand = true;
            while (j + height < dimV && canExpand) {
              for (let k = 0; k < width; k++) {
                const checkIdx = (i + k) + (j + height) * dimU;
                if (visited[checkIdx] || mask[checkIdx] !== blockId) {
                  canExpand = false;
                  break;
                }
              }
              if (canExpand) height++;
            }
            
            // Mark cells as visited
            for (let dj = 0; dj < height; dj++) {
              for (let di = 0; di < width; di++) {
                visited[(i + di) + (j + dj) * dimU] = 1;
              }
            }
            
            // Calculate world position
            const baseCoords = [0, 0, 0];
            baseCoords[u] = i;
            baseCoords[v] = j;
            baseCoords[w] = d;
            
            const worldX = chunkX * SECTION_SIZE + baseCoords[0] - offset.x;
            const worldY = baseY + baseCoords[1] - offset.y;
            const worldZ = chunkZ * SECTION_SIZE + baseCoords[2] - offset.z;
            
            // Get corners
            const corners = getCorners(worldX, worldY, worldZ, width, height);
            
            // Get color
            const color = this.registry.getColor(blockId);
            const startVertex = vertexCount;
            
            // Emit 4 vertices
            for (const [cx, cy, cz] of corners) {
              positions[posIdx++] = cx;
              positions[posIdx++] = cy;
              positions[posIdx++] = cz;
              
              normals[normIdx++] = normal[0];
              normals[normIdx++] = normal[1];
              normals[normIdx++] = normal[2];
              
              colors[colorIdx++] = color.r;
              colors[colorIdx++] = color.g;
              colors[colorIdx++] = color.b;
              
              vertexCount++;
            }
            
            // Two triangles for the quad
            indices[indexIdx++] = startVertex;
            indices[indexIdx++] = startVertex + 1;
            indices[indexIdx++] = startVertex + 2;
            indices[indexIdx++] = startVertex;
            indices[indexIdx++] = startVertex + 2;
            indices[indexIdx++] = startVertex + 3;
          }
        }
      }
    }
    
    if (vertexCount === 0) return null;
    
    return {
      positions: positions.slice(0, posIdx),
      normals: normals.slice(0, normIdx),
      colors: colors.slice(0, colorIdx),
      indices: indices.slice(0, indexIdx),
      vertexCount,
      indexCount: indexIdx,
    };
  }
  
  /**
   * Build mesh for entire grid (all chunks)
   * @param {BinaryGrid} grid - Source grid
   * @param {Object} offset - World offset
   * @returns {Object} Combined mesh data
   */
  buildGridMesh(grid, offset = { x: 0, y: 0, z: 0 }) {
    const chunkMeshes = [];
    
    // Collect unique chunks
    const processedChunks = new Set();
    
    grid.forEachSection((section, chunkX, chunkZ, sectionY) => {
      const chunkKey = `${chunkX},${chunkZ}`;
      if (processedChunks.has(chunkKey)) return;
      processedChunks.add(chunkKey);
      
      const mesh = this.buildChunkMesh(grid, chunkX, chunkZ, offset);
      if (mesh) {
        chunkMeshes.push(mesh);
      }
    });
    
    if (chunkMeshes.length === 0) return null;
    
    // Combine all chunk meshes
    return this._combineMeshes(chunkMeshes);
  }
  
  /**
   * Combine multiple meshes into one
   */
  _combineMeshes(meshes) {
    let totalVertices = 0;
    let totalIndices = 0;
    
    for (const mesh of meshes) {
      totalVertices += mesh.vertexCount;
      totalIndices += mesh.indices.length;
    }
    
    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const colors = new Float32Array(totalVertices * 3);
    const indices = new Uint32Array(totalIndices);
    
    let posOffset = 0;
    let indexOffset = 0;
    let vertexOffset = 0;
    
    for (const mesh of meshes) {
      positions.set(mesh.positions, posOffset);
      normals.set(mesh.normals, posOffset);
      colors.set(mesh.colors, posOffset);
      
      for (let i = 0; i < mesh.indices.length; i++) {
        indices[indexOffset + i] = mesh.indices[i] + vertexOffset;
      }
      
      posOffset += mesh.positions.length;
      indexOffset += mesh.indices.length;
      vertexOffset += mesh.vertexCount;
    }
    
    return {
      positions,
      normals,
      colors,
      indices,
      vertexCount: totalVertices,
      triangleCount: totalIndices / 3,
    };
  }
}

/**
 * Build solid mesh from grid (standalone function for workers)
 */
export function buildSolidMesh(grid, registry, offset = { x: 0, y: 0, z: 0 }) {
  const mesher = new BinaryGreedyMesher(registry);
  return mesher.buildGridMesh(grid, offset);
}

export default BinaryGreedyMesher;

