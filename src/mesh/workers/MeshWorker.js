/**
 * MeshWorker - Parallel mesh building worker
 * 
 * Builds solid and fluid meshes from binary grid data.
 * Runs in a Web Worker for parallel processing.
 */

import { BlockRegistry } from '../BlockRegistry.js';
import { BinaryGrid, SECTION_SIZE, BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, blockIndexInSection, sectionToWorldY } from '../BinaryGrid.js';

// Face definitions
const FACES = [
  { name: 'top',    axis: 1, dir: 1,  normal: [0, 1, 0],  u: 0, v: 2 },
  { name: 'bottom', axis: 1, dir: -1, normal: [0, -1, 0], u: 0, v: 2 },
  { name: 'right',  axis: 0, dir: 1,  normal: [1, 0, 0],  u: 2, v: 1 },
  { name: 'left',   axis: 0, dir: -1, normal: [-1, 0, 0], u: 2, v: 1 },
  { name: 'front',  axis: 2, dir: 1,  normal: [0, 0, 1],  u: 0, v: 1 },
  { name: 'back',   axis: 2, dir: -1, normal: [0, 0, -1], u: 0, v: 1 },
];

// Corner generators
function getTopCorners(x, y, z, w, h) {
  return [[x, y+1, z+h], [x+w, y+1, z+h], [x+w, y+1, z], [x, y+1, z]];
}
function getBottomCorners(x, y, z, w, h) {
  return [[x, y, z], [x+w, y, z], [x+w, y, z+h], [x, y, z+h]];
}
function getRightCorners(x, y, z, w, h) {
  return [[x+1, y, z], [x+1, y+h, z], [x+1, y+h, z+w], [x+1, y, z+w]];
}
function getLeftCorners(x, y, z, w, h) {
  return [[x, y, z+w], [x, y+h, z+w], [x, y+h, z], [x, y, z]];
}
function getFrontCorners(x, y, z, w, h) {
  return [[x, y, z+1], [x+w, y, z+1], [x+w, y+h, z+1], [x, y+h, z+1]];
}
function getBackCorners(x, y, z, w, h) {
  return [[x+w, y, z], [x, y, z], [x, y+h, z], [x+w, y+h, z]];
}

const CORNER_GENERATORS = [
  getTopCorners, getBottomCorners, getRightCorners,
  getLeftCorners, getFrontCorners, getBackCorners
];

/**
 * Fluid level to height conversion
 */
function fluidLevelToHeight(level) {
  if (level === undefined || level === null || level < 0) return 14/16;
  if (level >= 8) return 1.0;
  return Math.max(2/16, (14 - level * 1.5) / 16);
}

/**
 * Build solid mesh for a single chunk
 */
function buildChunkSolidMesh(grid, registry, chunkX, chunkZ, offset) {
  const chunkSections = grid.getChunkColumn(chunkX, chunkZ);
  if (chunkSections.size === 0) return null;
  
  // Count solid blocks
  let solidCount = 0;
  for (const section of chunkSections.values()) {
    for (let i = 0; i < section.length; i++) {
      const blockId = section[i] & BLOCK_ID_MASK;
      if (blockId !== 0 && registry.isOpaque(blockId)) solidCount++;
    }
  }
  
  if (solidCount === 0) return null;
  
  const maxQuads = solidCount * 6;
  const positions = new Float32Array(maxQuads * 4 * 3);
  const normals = new Float32Array(maxQuads * 4 * 3);
  const colors = new Float32Array(maxQuads * 4 * 3);
  const indices = new Uint32Array(maxQuads * 6);
  
  let vertexCount = 0;
  let posIdx = 0, normIdx = 0, colorIdx = 0, indexIdx = 0;
  
  // Process each section
  for (const [sectionY, section] of chunkSections) {
    const baseY = sectionToWorldY(sectionY);
    
    // Process each face direction
    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
      const face = FACES[faceIdx];
      const { axis, dir, normal, u, v } = face;
      const getCorners = CORNER_GENERATORS[faceIdx];
      const w = axis;
      
      // For each slice
      for (let d = 0; d < SECTION_SIZE; d++) {
        const mask = new Uint16Array(SECTION_SIZE * SECTION_SIZE);
        
        for (let j = 0; j < SECTION_SIZE; j++) {
          for (let i = 0; i < SECTION_SIZE; i++) {
            const coords = [0, 0, 0];
            coords[u] = i;
            coords[v] = j;
            coords[w] = d;
            
            const idx = blockIndexInSection(coords[0], coords[1], coords[2]);
            const blockId = section[idx] & BLOCK_ID_MASK;
            
            if (blockId === 0 || !registry.isOpaque(blockId)) continue;
            
            // Check neighbor
            const neighborCoords = [...coords];
            neighborCoords[w] += dir;
            
            let neighborOpaque = false;
            
            if (neighborCoords[w] >= 0 && neighborCoords[w] < SECTION_SIZE) {
              const neighborIdx = blockIndexInSection(neighborCoords[0], neighborCoords[1], neighborCoords[2]);
              neighborOpaque = registry.isOpaque(section[neighborIdx] & BLOCK_ID_MASK);
            } else {
              const worldX = chunkX * SECTION_SIZE + coords[0];
              const worldY = baseY + coords[1];
              const worldZ = chunkZ * SECTION_SIZE + coords[2];
              
              let checkX = worldX, checkY = worldY, checkZ = worldZ;
              if (axis === 0) checkX += dir;
              if (axis === 1) checkY += dir;
              if (axis === 2) checkZ += dir;
              
              neighborOpaque = registry.isOpaque(grid.getBlockId(checkX, checkY, checkZ));
            }
            
            if (!neighborOpaque) {
              mask[i + j * SECTION_SIZE] = blockId;
            }
          }
        }
        
        // Greedy merge
        const visited = new Uint8Array(SECTION_SIZE * SECTION_SIZE);
        
        for (let j = 0; j < SECTION_SIZE; j++) {
          for (let i = 0; i < SECTION_SIZE; i++) {
            const maskIdx = i + j * SECTION_SIZE;
            if (visited[maskIdx] || mask[maskIdx] === 0) continue;
            
            const blockId = mask[maskIdx];
            
            let width = 1;
            while (i + width < SECTION_SIZE && !visited[(i+width) + j*SECTION_SIZE] && mask[(i+width) + j*SECTION_SIZE] === blockId) {
              width++;
            }
            
            let height = 1;
            let canExpand = true;
            while (j + height < SECTION_SIZE && canExpand) {
              for (let k = 0; k < width; k++) {
                const checkIdx = (i+k) + (j+height)*SECTION_SIZE;
                if (visited[checkIdx] || mask[checkIdx] !== blockId) {
                  canExpand = false;
                  break;
                }
              }
              if (canExpand) height++;
            }
            
            for (let dj = 0; dj < height; dj++) {
              for (let di = 0; di < width; di++) {
                visited[(i+di) + (j+dj)*SECTION_SIZE] = 1;
              }
            }
            
            const baseCoords = [0, 0, 0];
            baseCoords[u] = i;
            baseCoords[v] = j;
            baseCoords[w] = d;
            
            const worldX = chunkX * SECTION_SIZE + baseCoords[0] - offset.x;
            const worldY = baseY + baseCoords[1] - offset.y;
            const worldZ = chunkZ * SECTION_SIZE + baseCoords[2] - offset.z;
            
            const corners = getCorners(worldX, worldY, worldZ, width, height);
            const color = registry.getColor(blockId);
            const startVertex = vertexCount;
            
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
 * Build fluid mesh for entire grid
 */
function buildFluidMesh(grid, registry, fluidType, offset) {
  const fluidBlocks = [];
  
  grid.forEachSection((section, chunkX, chunkZ, sectionY) => {
    const baseY = sectionToWorldY(sectionY);
    
    for (let i = 0; i < section.length; i++) {
      const blockId = section[i] & BLOCK_ID_MASK;
      if (blockId === 0) continue;
      
      const info = registry.getBlockInfo(blockId);
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
  
  const maxQuads = fluidBlocks.length * 6;
  const positions = new Float32Array(maxQuads * 4 * 3);
  const normals = new Float32Array(maxQuads * 4 * 3);
  const colors = new Float32Array(maxQuads * 4 * 3);
  const indices = new Uint32Array(maxQuads * 6);
  
  let vertexCount = 0;
  let posIdx = 0, normIdx = 0, colorIdx = 0, indexIdx = 0;
  
  for (const block of fluidBlocks) {
    const { x, y, z, blockId, level } = block;
    const height = fluidLevelToHeight(level);
    
    const color = registry.getColor(blockId);
    
    const shouldCull = (nx, ny, nz) => {
      const neighborId = grid.getBlockId(nx, ny, nz);
      if (neighborId === 0) return false;
      const neighborInfo = registry.getBlockInfo(neighborId);
      if (!neighborInfo) return false;
      if (registry.isOpaque(neighborId)) return true;
      if (neighborInfo.name.includes(fluidType)) return true;
      return false;
    };
    
    const wx = x - offset.x;
    const wy = y - offset.y;
    const wz = z - offset.z;
    
    // TOP
    if (!shouldCull(x, y + 1, z)) {
      const startVertex = vertexCount;
      const verts = [
        [wx, wy + height, wz + 1],
        [wx + 1, wy + height, wz + 1],
        [wx + 1, wy + height, wz],
        [wx, wy + height, wz],
      ];
      for (const [vx, vy, vz] of verts) {
        positions[posIdx++] = vx; positions[posIdx++] = vy; positions[posIdx++] = vz;
        normals[normIdx++] = 0; normals[normIdx++] = 1; normals[normIdx++] = 0;
        colors[colorIdx++] = color.r; colors[colorIdx++] = color.g; colors[colorIdx++] = color.b;
        vertexCount++;
      }
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+1; indices[indexIdx++] = startVertex+2;
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+2; indices[indexIdx++] = startVertex+3;
    }
    
    // BOTTOM
    if (!shouldCull(x, y - 1, z)) {
      const startVertex = vertexCount;
      const verts = [[wx, wy, wz], [wx+1, wy, wz], [wx+1, wy, wz+1], [wx, wy, wz+1]];
      for (const [vx, vy, vz] of verts) {
        positions[posIdx++] = vx; positions[posIdx++] = vy; positions[posIdx++] = vz;
        normals[normIdx++] = 0; normals[normIdx++] = -1; normals[normIdx++] = 0;
        colors[colorIdx++] = color.r; colors[colorIdx++] = color.g; colors[colorIdx++] = color.b;
        vertexCount++;
      }
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+1; indices[indexIdx++] = startVertex+2;
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+2; indices[indexIdx++] = startVertex+3;
    }
    
    // FRONT (+Z)
    if (!shouldCull(x, y, z + 1)) {
      const startVertex = vertexCount;
      const verts = [[wx, wy, wz+1], [wx+1, wy, wz+1], [wx+1, wy+height, wz+1], [wx, wy+height, wz+1]];
      for (const [vx, vy, vz] of verts) {
        positions[posIdx++] = vx; positions[posIdx++] = vy; positions[posIdx++] = vz;
        normals[normIdx++] = 0; normals[normIdx++] = 0; normals[normIdx++] = 1;
        colors[colorIdx++] = color.r; colors[colorIdx++] = color.g; colors[colorIdx++] = color.b;
        vertexCount++;
      }
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+1; indices[indexIdx++] = startVertex+2;
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+2; indices[indexIdx++] = startVertex+3;
    }
    
    // BACK (-Z)
    if (!shouldCull(x, y, z - 1)) {
      const startVertex = vertexCount;
      const verts = [[wx+1, wy, wz], [wx, wy, wz], [wx, wy+height, wz], [wx+1, wy+height, wz]];
      for (const [vx, vy, vz] of verts) {
        positions[posIdx++] = vx; positions[posIdx++] = vy; positions[posIdx++] = vz;
        normals[normIdx++] = 0; normals[normIdx++] = 0; normals[normIdx++] = -1;
        colors[colorIdx++] = color.r; colors[colorIdx++] = color.g; colors[colorIdx++] = color.b;
        vertexCount++;
      }
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+1; indices[indexIdx++] = startVertex+2;
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+2; indices[indexIdx++] = startVertex+3;
    }
    
    // RIGHT (+X)
    if (!shouldCull(x + 1, y, z)) {
      const startVertex = vertexCount;
      const verts = [[wx+1, wy, wz], [wx+1, wy+height, wz], [wx+1, wy+height, wz+1], [wx+1, wy, wz+1]];
      for (const [vx, vy, vz] of verts) {
        positions[posIdx++] = vx; positions[posIdx++] = vy; positions[posIdx++] = vz;
        normals[normIdx++] = 1; normals[normIdx++] = 0; normals[normIdx++] = 0;
        colors[colorIdx++] = color.r; colors[colorIdx++] = color.g; colors[colorIdx++] = color.b;
        vertexCount++;
      }
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+1; indices[indexIdx++] = startVertex+2;
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+2; indices[indexIdx++] = startVertex+3;
    }
    
    // LEFT (-X)
    if (!shouldCull(x - 1, y, z)) {
      const startVertex = vertexCount;
      const verts = [[wx, wy, wz+1], [wx, wy+height, wz+1], [wx, wy+height, wz], [wx, wy, wz]];
      for (const [vx, vy, vz] of verts) {
        positions[posIdx++] = vx; positions[posIdx++] = vy; positions[posIdx++] = vz;
        normals[normIdx++] = -1; normals[normIdx++] = 0; normals[normIdx++] = 0;
        colors[colorIdx++] = color.r; colors[colorIdx++] = color.g; colors[colorIdx++] = color.b;
        vertexCount++;
      }
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+1; indices[indexIdx++] = startVertex+2;
      indices[indexIdx++] = startVertex; indices[indexIdx++] = startVertex+2; indices[indexIdx++] = startVertex+3;
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
 * Combine multiple meshes
 */
function combineMeshes(meshes) {
  if (meshes.length === 0) return null;
  if (meshes.length === 1) return meshes[0];
  
  let totalVerts = 0, totalIndices = 0;
  for (const m of meshes) {
    totalVerts += m.vertexCount;
    totalIndices += m.indices.length;
  }
  
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  
  let posOff = 0, idxOff = 0, vertOff = 0;
  
  for (const m of meshes) {
    positions.set(m.positions, posOff);
    normals.set(m.normals, posOff);
    colors.set(m.colors, posOff);
    
    for (let i = 0; i < m.indices.length; i++) {
      indices[idxOff + i] = m.indices[i] + vertOff;
    }
    
    posOff += m.positions.length;
    idxOff += m.indices.length;
    vertOff += m.vertexCount;
  }
  
  return { positions, normals, colors, indices, vertexCount: totalVerts, triangleCount: totalIndices / 3 };
}

// Worker message handler
self.onmessage = function(e) {
  const { type, id, gridData, registryData, offset } = e.data;
  
  if (type === 'buildMesh') {
    try {
      const startTime = performance.now();
      
      // Reconstruct grid and registry
      const grid = BinaryGrid.import(gridData);
      const registry = BlockRegistry.import(registryData);
      
      // Build solid meshes per chunk
      const solidMeshes = [];
      const processedChunks = new Set();
      
      grid.forEachSection((section, chunkX, chunkZ) => {
        const key = `${chunkX},${chunkZ}`;
        if (processedChunks.has(key)) return;
        processedChunks.add(key);
        
        const mesh = buildChunkSolidMesh(grid, registry, chunkX, chunkZ, offset);
        if (mesh) solidMeshes.push(mesh);
      });
      
      const solidMesh = combineMeshes(solidMeshes);
      
      // Build fluid meshes
      const waterMesh = buildFluidMesh(grid, registry, 'water', offset);
      const lavaMesh = buildFluidMesh(grid, registry, 'lava', offset);
      
      const elapsed = performance.now() - startTime;
      
      // Collect transferables
      const transferables = [];
      if (solidMesh) {
        transferables.push(solidMesh.positions.buffer, solidMesh.normals.buffer, solidMesh.colors.buffer, solidMesh.indices.buffer);
      }
      if (waterMesh) {
        transferables.push(waterMesh.positions.buffer, waterMesh.normals.buffer, waterMesh.colors.buffer, waterMesh.indices.buffer);
      }
      if (lavaMesh) {
        transferables.push(lavaMesh.positions.buffer, lavaMesh.normals.buffer, lavaMesh.colors.buffer, lavaMesh.indices.buffer);
      }
      
      self.postMessage({
        type: 'meshComplete',
        id,
        solidMesh,
        waterMesh,
        lavaMesh,
        stats: {
          solidTriangles: solidMesh?.triangleCount || 0,
          waterTriangles: waterMesh?.triangleCount || 0,
          lavaTriangles: lavaMesh?.triangleCount || 0,
          timeMs: elapsed,
        },
      }, transferables);
      
    } catch (error) {
      self.postMessage({
        type: 'meshError',
        id,
        error: error.message,
      });
    }
  }
};

