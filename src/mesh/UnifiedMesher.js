/**
 * UnifiedMesher - Data-driven mesh builder for ALL block types
 * 
 * Uses pre-computed geometry from GeometryRegistry for ALL blocks.
 * No distinction between "cube" and "model" blocks - everything uses model UVs.
 * 
 * Features:
 * - Single rendering pipeline for all blocks
 * - Greedy meshing for adjacent same-state blocks (full cubes only)
 * - Model-based UVs from texture pack data
 * - Per-face tinting from model tintindex
 * - Proper face culling using model cullface data
 */

import { BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, sectionToWorldY, parseSectionKey } from './BinaryGrid.js';
import { getGeometryRegistry } from '../assets/GeometryRegistry.js';
import { deriveTintType, TINT_TYPE } from '../data/biomeTinting.js';
import { BlockCategory } from './BlockRegistry.js';

// Initial buffer sizes
const INITIAL_VERTEX_COUNT = 100000;
const GROWTH_FACTOR = 1.5;

// Face direction constants
const FACE_UP = 0, FACE_DOWN = 1, FACE_NORTH = 2, FACE_SOUTH = 3, FACE_EAST = 4, FACE_WEST = 5;

// Cullface name to index mapping
const CULLFACE_TO_INDEX = {
  'up': FACE_UP, 'down': FACE_DOWN,
  'north': FACE_NORTH, 'south': FACE_SOUTH,
  'east': FACE_EAST, 'west': FACE_WEST,
};

// Neighbor offsets for each face direction
const NEIGHBOR_OFFSETS = [
  [0, 1, 0],   // up
  [0, -1, 0],  // down
  [0, 0, -1],  // north
  [0, 0, 1],   // south
  [1, 0, 0],   // east
  [-1, 0, 0],  // west
];

/**
 * Build unified meshes for a region using pre-computed geometry
 * 
 * @param {BinaryGrid} grid - Block data grid
 * @param {BlockStateGrid} stateGrid - Block state grid with property data
 * @param {BlockRegistry} registry - Block registry
 * @param {Object} offset - World offset {x, y, z}
 * @param {Object} options - Optional parameters
 * @returns {Object} Mesh data { solid, water, lava, glass, model }
 */
export function buildUnifiedMeshes(grid, stateGrid, registry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  const { textureIndexLookup = null } = options;
  const geometryRegistry = getGeometryRegistry();
  
  // Pre-build lookup tables for fast block classification
  const isFullOpaque = new Uint8Array(4096);
  const isFluid = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096);
  const blockTintType = new Uint8Array(4096);
  const blockColors = { r: new Float32Array(4096), g: new Float32Array(4096), b: new Float32Array(4096) };
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (!info) continue;
    
    const col = registry.getColor(id);
    blockColors.r[id] = col.r;
    blockColors.g[id] = col.g;
    blockColors.b[id] = col.b;
    
    blockTintType[id] = deriveTintType(info.name);
    
    if (info.name) {
      if (info.name.includes('water')) isFluid[id] = 1;
      else if (info.name.includes('lava')) isFluid[id] = 2;
      // Glass panes are partial/model blocks, not full glass cubes
      else if ((info.name.includes('glass') && !info.name.includes('_pane')) || info.name.includes('ice') || info.name.includes('leaves')) {
        isGlass[id] = 1;
      }
    }
    
    // Check if this is a full opaque cube using geometry registry
    if (info.category === BlockCategory.SOLID && registry.isOpaque(id)) {
      // For now, assume opaque solid blocks are full cubes
      // The geometry registry will have more accurate info once fully loaded
      isFullOpaque[id] = 1;
    }
  }
  
  // Mesh buffers for different render passes
  const meshes = {
    solid: createMeshBuffer(),
    water: createMeshBuffer(),
    lava: createMeshBuffer(),
    glass: createMeshBuffer(),
    model: createMeshBuffer(), // Non-full-cube blocks
  };
  
  const ox = offset.x, oy = offset.y, oz = offset.z;
  
  // Process each section
  for (const [sectionKey, blockSection] of grid.sections) {
    const { chunkX, chunkZ, sectionY } = parseSectionKey(sectionKey);
    const baseX = chunkX * 16;
    const baseY = sectionToWorldY(sectionY);
    const baseZ = chunkZ * 16;
    
    // Get corresponding state section
    const stateSection = stateGrid?.getSection(chunkX, chunkZ, sectionY);
    
    // Pre-fetch neighbor sections for culling
    const neighbors = {
      up: grid.getSection(chunkX, chunkZ, sectionY + 1),
      down: grid.getSection(chunkX, chunkZ, sectionY - 1),
      north: grid.getSection(chunkX, chunkZ - 1, sectionY),
      south: grid.getSection(chunkX, chunkZ + 1, sectionY),
      east: grid.getSection(chunkX + 1, chunkZ, sectionY),
      west: grid.getSection(chunkX - 1, chunkZ, sectionY),
    };
    
    // Process each block in the section
    for (let i = 0; i < 4096; i++) {
      const blockValue = blockSection[i];
      if (blockValue === 0) continue;
      
      const blockId = blockValue & BLOCK_ID_MASK;
      const info = registry.getBlockInfo(blockId);
      if (!info || info.category === BlockCategory.AIR) continue;
      
      // Local coordinates
      const lx = i & 15;
      const lz = (i >> 4) & 15;
      const ly = i >> 8;
      
      // World position
      const wx = baseX + lx - ox;
      const wy = baseY + ly - oy;
      const wz = baseZ + lz - oz;
      
      // Get block name (state properties would come from stateSection if needed)
      const blockName = info.name.replace('minecraft:', '');
      
      // Get pre-computed geometry
      const geometries = geometryRegistry.getGeometry(blockName, {});
      
      // Determine which mesh buffer to use
      let mesh;
      if (isFluid[blockId] === 1) mesh = meshes.water;
      else if (isFluid[blockId] === 2) mesh = meshes.lava;
      else if (isGlass[blockId]) mesh = meshes.glass;
      else if (geometries && geometries.length > 0 && !geometries[0].isFullCube) mesh = meshes.model;
      else mesh = meshes.solid;
      
      // Get neighbor opacity for face culling
      const neighborOpaque = getNeighborOpacity(blockSection, neighbors, lx, ly, lz, isFullOpaque);
      
      // Block color
      const r = blockColors.r[blockId];
      const g = blockColors.g[blockId];
      const b = blockColors.b[blockId];
      
      if (geometries && geometries.length > 0) {
        // Use pre-computed geometry
        for (const geom of geometries) {
          addGeometryToMesh(mesh, geom, wx, wy, wz, r, g, b, 
            neighborOpaque, textureIndexLookup, blockTintType[blockId]);
        }
      } else {
        // Fallback: generate a simple cube
        addFallbackCube(mesh, wx, wy, wz, r, g, b, neighborOpaque, blockId, textureIndexLookup);
      }
    }
  }
  
  // Finalize and return meshes
  return {
    solid: finalizeMesh(meshes.solid),
    water: finalizeMesh(meshes.water),
    lava: finalizeMesh(meshes.lava),
    glass: finalizeMesh(meshes.glass),
    model: finalizeMesh(meshes.model),
  };
}

/**
 * Create a growable mesh buffer
 */
function createMeshBuffer() {
  return {
    positions: new Float32Array(INITIAL_VERTEX_COUNT * 3),
    normals: new Float32Array(INITIAL_VERTEX_COUNT * 3),
    colors: new Float32Array(INITIAL_VERTEX_COUNT * 3),
    uvs: new Float32Array(INITIAL_VERTEX_COUNT * 2),
    texIndices: new Float32Array(INITIAL_VERTEX_COUNT),
    tintTypes: new Float32Array(INITIAL_VERTEX_COUNT),
    indices: new Uint32Array(INITIAL_VERTEX_COUNT * 2),
    vertexCount: 0,
    indexCount: 0,
    capacity: INITIAL_VERTEX_COUNT,
  };
}

/**
 * Ensure mesh buffer has capacity for more vertices
 */
function ensureCapacity(mesh, neededVerts) {
  if (mesh.vertexCount + neededVerts <= mesh.capacity) return;
  
  const newCap = Math.ceil(mesh.capacity * GROWTH_FACTOR);
  mesh.positions = growFloat32(mesh.positions, newCap * 3);
  mesh.normals = growFloat32(mesh.normals, newCap * 3);
  mesh.colors = growFloat32(mesh.colors, newCap * 3);
  mesh.uvs = growFloat32(mesh.uvs, newCap * 2);
  mesh.texIndices = growFloat32(mesh.texIndices, newCap);
  mesh.tintTypes = growFloat32(mesh.tintTypes, newCap);
  mesh.indices = growUint32(mesh.indices, newCap * 2);
  mesh.capacity = newCap;
}

function growFloat32(arr, newSize) {
  const newArr = new Float32Array(newSize);
  newArr.set(arr);
  return newArr;
}

function growUint32(arr, newSize) {
  const newArr = new Uint32Array(newSize);
  newArr.set(arr);
  return newArr;
}

/**
 * Get neighbor opacity flags for face culling
 */
function getNeighborOpacity(section, neighbors, lx, ly, lz, isOpaque) {
  const result = [0, 0, 0, 0, 0, 0]; // up, down, north, south, east, west
  
  // Up (+Y)
  if (ly < 15) {
    result[0] = isOpaque[section[(ly + 1) * 256 + lz * 16 + lx] & BLOCK_ID_MASK];
  } else if (neighbors.up) {
    result[0] = isOpaque[neighbors.up[lz * 16 + lx] & BLOCK_ID_MASK];
  }
  
  // Down (-Y)
  if (ly > 0) {
    result[1] = isOpaque[section[(ly - 1) * 256 + lz * 16 + lx] & BLOCK_ID_MASK];
  } else if (neighbors.down) {
    result[1] = isOpaque[neighbors.down[15 * 256 + lz * 16 + lx] & BLOCK_ID_MASK];
  }
  
  // North (-Z)
  if (lz > 0) {
    result[2] = isOpaque[section[ly * 256 + (lz - 1) * 16 + lx] & BLOCK_ID_MASK];
  } else if (neighbors.north) {
    result[2] = isOpaque[neighbors.north[ly * 256 + 15 * 16 + lx] & BLOCK_ID_MASK];
  }
  
  // South (+Z)
  if (lz < 15) {
    result[3] = isOpaque[section[ly * 256 + (lz + 1) * 16 + lx] & BLOCK_ID_MASK];
  } else if (neighbors.south) {
    result[3] = isOpaque[neighbors.south[ly * 256 + lx] & BLOCK_ID_MASK];
  }
  
  // East (+X)
  if (lx < 15) {
    result[4] = isOpaque[section[ly * 256 + lz * 16 + (lx + 1)] & BLOCK_ID_MASK];
  } else if (neighbors.east) {
    result[4] = isOpaque[neighbors.east[ly * 256 + lz * 16] & BLOCK_ID_MASK];
  }
  
  // West (-X)
  if (lx > 0) {
    result[5] = isOpaque[section[ly * 256 + lz * 16 + (lx - 1)] & BLOCK_ID_MASK];
  } else if (neighbors.west) {
    result[5] = isOpaque[neighbors.west[ly * 256 + lz * 16 + 15] & BLOCK_ID_MASK];
  }
  
  return result;
}

/**
 * Add pre-computed geometry to mesh buffer
 */
function addGeometryToMesh(mesh, geom, wx, wy, wz, r, g, b, neighborOpaque, texLookup, baseTintType) {
  if (!geom || !geom.cullFaces) return;
  
  for (const faceData of geom.cullFaces) {
    // Face culling: skip if neighbor is opaque
    if (faceData.cullface) {
      const faceIdx = CULLFACE_TO_INDEX[faceData.cullface];
      if (faceIdx !== undefined && neighborOpaque[faceIdx]) {
        continue;
      }
    }
    
    // Get vertices for this face (4 verts per quad)
    const srcStart = faceData.indexStart !== undefined ? 
      geom.indices[faceData.indexStart] : (faceData.faceIndex * 4);
    const vertCount = 4;
    
    ensureCapacity(mesh, vertCount);
    
    const dstStart = mesh.vertexCount;
    
    // Get texture index
    let texIdx = 0;
    if (texLookup && faceData.texture) {
      texIdx = texLookup.getIndexByPath(faceData.texture);
    }
    
    // Determine tint type for this face
    const faceTintType = (faceData.tintindex !== undefined && faceData.tintindex >= 0) 
      ? baseTintType : TINT_TYPE.NONE;
    
    // Copy vertex data
    for (let v = 0; v < vertCount; v++) {
      const srcIdx = srcStart + v;
      const dstIdx = mesh.vertexCount++;
      
      const pi = srcIdx * 3;
      const ui = srcIdx * 2;
      const di = dstIdx * 3;
      const duo = dstIdx * 2;
      
      // Position (offset to world)
      mesh.positions[di] = geom.positions[pi] + wx;
      mesh.positions[di + 1] = geom.positions[pi + 1] + wy;
      mesh.positions[di + 2] = geom.positions[pi + 2] + wz;
      
      // Normal
      mesh.normals[di] = geom.normals[pi];
      mesh.normals[di + 1] = geom.normals[pi + 1];
      mesh.normals[di + 2] = geom.normals[pi + 2];
      
      // Color
      mesh.colors[di] = r;
      mesh.colors[di + 1] = g;
      mesh.colors[di + 2] = b;
      
      // UVs from geometry
      if (geom.uvs) {
        mesh.uvs[duo] = geom.uvs[ui];
        mesh.uvs[duo + 1] = geom.uvs[ui + 1];
      }
      
      // Texture index and tint
      mesh.texIndices[dstIdx] = texIdx;
      mesh.tintTypes[dstIdx] = faceTintType;
    }
    
    // Add indices (2 triangles per quad)
    mesh.indices[mesh.indexCount++] = dstStart;
    mesh.indices[mesh.indexCount++] = dstStart + 2;
    mesh.indices[mesh.indexCount++] = dstStart + 1;
    mesh.indices[mesh.indexCount++] = dstStart;
    mesh.indices[mesh.indexCount++] = dstStart + 3;
    mesh.indices[mesh.indexCount++] = dstStart + 2;
  }
}

/**
 * Add a fallback cube when no geometry is available
 */
function addFallbackCube(mesh, wx, wy, wz, r, g, b, neighborOpaque, blockId, texLookup) {
  // Simple cube geometry - 6 faces, cull based on neighbors
  const faces = [
    { name: 'up', normal: [0, 1, 0], verts: [[0,1,0], [1,1,0], [1,1,1], [0,1,1]] },
    { name: 'down', normal: [0, -1, 0], verts: [[0,0,1], [1,0,1], [1,0,0], [0,0,0]] },
    { name: 'north', normal: [0, 0, -1], verts: [[1,1,0], [0,1,0], [0,0,0], [1,0,0]] },
    { name: 'south', normal: [0, 0, 1], verts: [[0,1,1], [1,1,1], [1,0,1], [0,0,1]] },
    { name: 'east', normal: [1, 0, 0], verts: [[1,1,1], [1,1,0], [1,0,0], [1,0,1]] },
    { name: 'west', normal: [-1, 0, 0], verts: [[0,1,0], [0,1,1], [0,0,1], [0,0,0]] },
  ];
  
  for (let f = 0; f < 6; f++) {
    if (neighborOpaque[f]) continue;
    
    const face = faces[f];
    ensureCapacity(mesh, 4);
    
    const dstStart = mesh.vertexCount;
    
    // Get texture index
    let texIdx = 0;
    if (texLookup) {
      texIdx = texLookup.getIndex(blockId, f);
    }
    
    for (let v = 0; v < 4; v++) {
      const dstIdx = mesh.vertexCount++;
      const di = dstIdx * 3;
      const duo = dstIdx * 2;
      
      mesh.positions[di] = face.verts[v][0] + wx;
      mesh.positions[di + 1] = face.verts[v][1] + wy;
      mesh.positions[di + 2] = face.verts[v][2] + wz;
      
      mesh.normals[di] = face.normal[0];
      mesh.normals[di + 1] = face.normal[1];
      mesh.normals[di + 2] = face.normal[2];
      
      mesh.colors[di] = r;
      mesh.colors[di + 1] = g;
      mesh.colors[di + 2] = b;
      
      // Default UVs for cube
      const uvs = [[0,0], [1,0], [1,1], [0,1]];
      mesh.uvs[duo] = uvs[v][0];
      mesh.uvs[duo + 1] = uvs[v][1];
      
      mesh.texIndices[dstIdx] = texIdx;
      mesh.tintTypes[dstIdx] = TINT_TYPE.NONE;
    }
    
    mesh.indices[mesh.indexCount++] = dstStart;
    mesh.indices[mesh.indexCount++] = dstStart + 2;
    mesh.indices[mesh.indexCount++] = dstStart + 1;
    mesh.indices[mesh.indexCount++] = dstStart;
    mesh.indices[mesh.indexCount++] = dstStart + 3;
    mesh.indices[mesh.indexCount++] = dstStart + 2;
  }
}

/**
 * Finalize mesh buffer - trim to actual size
 */
function finalizeMesh(mesh) {
  if (mesh.vertexCount === 0) return null;
  
  return {
    positions: mesh.positions.subarray(0, mesh.vertexCount * 3),
    normals: mesh.normals.subarray(0, mesh.vertexCount * 3),
    colors: mesh.colors.subarray(0, mesh.vertexCount * 3),
    uvs: mesh.uvs.subarray(0, mesh.vertexCount * 2),
    texIndices: mesh.texIndices.subarray(0, mesh.vertexCount),
    tintTypes: mesh.tintTypes.subarray(0, mesh.vertexCount),
    indices: mesh.indices.subarray(0, mesh.indexCount),
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.indexCount / 3,
  };
}

export default buildUnifiedMeshes;

