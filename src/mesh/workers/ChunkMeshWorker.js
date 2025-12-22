/**
 * ChunkMeshWorker - Parallel chunk meshing worker
 * 
 * Receives individual chunk section data and builds mesh.
 * Optimized for maximum throughput.
 */

const SECTION_SIZE = 16;

// Block ID mask
const BLOCK_ID_MASK = 0x0FFF;
const LEVEL_MASK = 0xF000;
const LEVEL_SHIFT = 12;

// Face definitions
const FACES = [
  { axis: 1, dir: 1,  n: [0,1,0] },   // top
  { axis: 1, dir: -1, n: [0,-1,0] },  // bottom
  { axis: 0, dir: 1,  n: [1,0,0] },   // right
  { axis: 0, dir: -1, n: [-1,0,0] },  // left
  { axis: 2, dir: 1,  n: [0,0,1] },   // front
  { axis: 2, dir: -1, n: [0,0,-1] },  // back
];

// Pre-computed corner offsets for each face
const CORNERS = [
  // top (y+1)
  (x,y,z,w,h) => [[x,y+1,z+h],[x+w,y+1,z+h],[x+w,y+1,z],[x,y+1,z]],
  // bottom (y)
  (x,y,z,w,h) => [[x,y,z],[x+w,y,z],[x+w,y,z+h],[x,y,z+h]],
  // right (x+1)
  (x,y,z,w,h) => [[x+1,y,z],[x+1,y+h,z],[x+1,y+h,z+w],[x+1,y,z+w]],
  // left (x)
  (x,y,z,w,h) => [[x,y,z+w],[x,y+h,z+w],[x,y+h,z],[x,y,z]],
  // front (z+1)
  (x,y,z,w,h) => [[x,y,z+1],[x+w,y,z+1],[x+w,y+h,z+1],[x,y+h,z+1]],
  // back (z)
  (x,y,z,w,h) => [[x+w,y,z],[x,y,z],[x,y+h,z],[x+w,y+h,z]],
];

// Color palette (will be populated from message)
let colorPalette = null;
let opaquePalette = null;

function blockIdx(x, y, z) {
  return y * 256 + z * 16 + x;
}

function fluidHeight(level) {
  if (level < 0) return 0.875;
  if (level >= 8) return 1.0;
  return Math.max(0.125, (14 - level * 1.5) / 16);
}

/**
 * Build mesh for sections
 */
function buildSectionMeshes(sections, neighborSections, offset, worldBaseX, worldBaseZ) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vertexCount = 0;
  
  // Process each section
  for (const sec of sections) {
    const { sectionY, data } = sec;
    const baseY = sectionY * 16 + (-64); // MIN_Y = -64
    const section = new Uint16Array(data);
    
    // Get neighbor sections for boundary checking
    const getNeighborBlock = (lx, ly, lz) => {
      // Check if within this section
      if (lx >= 0 && lx < 16 && ly >= 0 && ly < 16 && lz >= 0 && lz < 16) {
        return section[blockIdx(lx, ly, lz)] & BLOCK_ID_MASK;
      }
      
      // Check neighbor sections
      let targetSecY = sectionY;
      let targetLy = ly;
      
      if (ly < 0) {
        targetSecY = sectionY - 1;
        targetLy = ly + 16;
      } else if (ly >= 16) {
        targetSecY = sectionY + 1;
        targetLy = ly - 16;
      }
      
      const ns = neighborSections.find(n => n.sectionY === targetSecY);
      if (ns) {
        const nsData = new Uint16Array(ns.data);
        const clampX = Math.max(0, Math.min(15, lx));
        const clampZ = Math.max(0, Math.min(15, lz));
        return nsData[blockIdx(clampX, targetLy, clampZ)] & BLOCK_ID_MASK;
      }
      
      return 0; // Air
    };
    
    // Process each face
    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
      const { axis, dir, n } = FACES[faceIdx];
      const getCorners = CORNERS[faceIdx];
      const u = axis === 0 ? 2 : 0;
      const v = axis === 1 ? 2 : 1;
      const w = axis;
      
      for (let d = 0; d < 16; d++) {
        const mask = new Uint16Array(256);
        
        for (let j = 0; j < 16; j++) {
          for (let i = 0; i < 16; i++) {
            const coords = [0, 0, 0];
            coords[u] = i;
            coords[v] = j;
            coords[w] = d;
            
            const idx = blockIdx(coords[0], coords[1], coords[2]);
            const blockId = section[idx] & BLOCK_ID_MASK;
            
            if (blockId === 0 || !opaquePalette[blockId]) continue;
            
            // Check neighbor
            const nc = [coords[0], coords[1], coords[2]];
            nc[w] += dir;
            
            const neighborId = getNeighborBlock(nc[0], nc[1], nc[2]);
            const neighborOpaque = neighborId !== 0 && opaquePalette[neighborId];
            
            if (!neighborOpaque) {
              mask[i + j * 16] = blockId;
            }
          }
        }
        
        // Greedy merge
        const visited = new Uint8Array(256);
        
        for (let j = 0; j < 16; j++) {
          for (let i = 0; i < 16; i++) {
            const mi = i + j * 16;
            if (visited[mi] || mask[mi] === 0) continue;
            
            const blockId = mask[mi];
            
            let width = 1;
            while (i + width < 16 && !visited[mi + width] && mask[mi + width] === blockId) width++;
            
            let height = 1;
            outer: while (j + height < 16) {
              for (let k = 0; k < width; k++) {
                const ci = (i + k) + (j + height) * 16;
                if (visited[ci] || mask[ci] !== blockId) break outer;
              }
              height++;
            }
            
            for (let dj = 0; dj < height; dj++) {
              for (let di = 0; di < width; di++) {
                visited[(i + di) + (j + dj) * 16] = 1;
              }
            }
            
            const bc = [0, 0, 0];
            bc[u] = i;
            bc[v] = j;
            bc[w] = d;
            
            const wx = worldBaseX + bc[0] - offset.x;
            const wy = baseY + bc[1] - offset.y;
            const wz = worldBaseZ + bc[2] - offset.z;
            
            const corners = getCorners(wx, wy, wz, width, height);
            const color = colorPalette[blockId] || { r: 0.5, g: 0.5, b: 0.5 };
            const sv = vertexCount;
            
            for (const [cx, cy, cz] of corners) {
              positions.push(cx, cy, cz);
              normals.push(n[0], n[1], n[2]);
              colors.push(color.r, color.g, color.b);
              vertexCount++;
            }
            
            indices.push(sv, sv+1, sv+2, sv, sv+2, sv+3);
          }
        }
      }
    }
  }
  
  if (vertexCount === 0) return null;
  
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    vertexCount,
    triangleCount: indices.length / 3,
  };
}

/**
 * Build fluid mesh for sections
 */
function buildFluidMeshes(sections, fluidType, offset, worldBaseX, worldBaseZ) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vertexCount = 0;
  
  for (const sec of sections) {
    const { sectionY, data, fluidMask } = sec;
    if (!fluidMask) continue;
    
    const baseY = sectionY * 16 + (-64);
    const section = new Uint16Array(data);
    const fluids = new Uint8Array(fluidMask);
    
    for (let i = 0; i < 4096; i++) {
      if (fluids[i] !== (fluidType === 'water' ? 1 : 2)) continue;
      
      const lx = i % 16;
      const lz = Math.floor(i / 16) % 16;
      const ly = Math.floor(i / 256);
      
      const blockId = section[i] & BLOCK_ID_MASK;
      const level = (section[i] & LEVEL_MASK) >> LEVEL_SHIFT;
      const h = fluidHeight(level);
      
      const wx = worldBaseX + lx - offset.x;
      const wy = baseY + ly - offset.y;
      const wz = worldBaseZ + lz - offset.z;
      
      const color = colorPalette[blockId] || { r: 0.25, g: 0.46, b: 0.89 };
      
      // Top
      const sv = vertexCount;
      positions.push(wx, wy+h, wz+1, wx+1, wy+h, wz+1, wx+1, wy+h, wz, wx, wy+h, wz);
      normals.push(0,1,0, 0,1,0, 0,1,0, 0,1,0);
      colors.push(color.r,color.g,color.b, color.r,color.g,color.b, color.r,color.g,color.b, color.r,color.g,color.b);
      indices.push(sv, sv+1, sv+2, sv, sv+2, sv+3);
      vertexCount += 4;
    }
  }
  
  if (vertexCount === 0) return null;
  
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    vertexCount,
    triangleCount: indices.length / 3,
  };
}

self.onmessage = function(e) {
  const { type, id, palette, opaque, sections, neighborSections, offset, worldBaseX, worldBaseZ } = e.data;
  
  if (type === 'init') {
    // Initialize palettes
    colorPalette = palette;
    opaquePalette = opaque;
    self.postMessage({ type: 'ready' });
    return;
  }
  
  if (type === 'meshChunk') {
    try {
      const solidMesh = buildSectionMeshes(sections, neighborSections || [], offset, worldBaseX, worldBaseZ);
      const waterMesh = buildFluidMeshes(sections, 'water', offset, worldBaseX, worldBaseZ);
      const lavaMesh = buildFluidMeshes(sections, 'lava', offset, worldBaseX, worldBaseZ);
      
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
        type: 'meshResult',
        id,
        solidMesh,
        waterMesh,
        lavaMesh,
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

