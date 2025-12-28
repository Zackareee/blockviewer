/**
 * ParallelMesher - Uses SharedArrayBuffer and Web Workers for true parallelism
 */

import { BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, sectionToWorldY, makeSectionKey, parseSectionKey } from './BinaryGrid.js';

const WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 4, 8);
const S = 16, S2 = 256, S3 = 4096;

// Worker code as a string (to avoid separate file)
const workerCode = `
const S = 16, S2 = 256, S3 = 4096;
const BLOCK_ID_MASK = 0x0FFF;

let sharedGrid = null;
let sectionOffsets = null;
let isOpaque = null;
let isNonCube = null;
let colorR = null, colorG = null, colorB = null;

self.onmessage = function(e) {
  const { type, data } = e.data;
  
  if (type === 'init') {
    sharedGrid = new Uint16Array(data.gridBuffer);
    sectionOffsets = data.sectionOffsets;
    isOpaque = new Uint8Array(data.isOpaque);
    isNonCube = new Uint8Array(data.isNonCube);
    colorR = new Float32Array(data.colorR);
    colorG = new Float32Array(data.colorG);
    colorB = new Float32Array(data.colorB);
    self.postMessage({ type: 'ready' });
    return;
  }
  
  if (type === 'mesh') {
    const { sectionKeys, baseCoords, neighborKeys, offset } = data;
    const result = meshSections(sectionKeys, baseCoords, neighborKeys, offset);
    self.postMessage({ type: 'result', data: result }, result.transferables);
  }
};

function getSection(key) {
  const off = sectionOffsets[key];
  if (off === undefined) return null;
  return sharedGrid.subarray(off, off + S3);
}

function meshSections(sectionKeys, baseCoords, neighborKeys, offset) {
  const ox = offset.x, oy = offset.y, oz = offset.z;
  
  // Estimate output size
  const maxQuads = sectionKeys.length * 1000;
  let positions = new Float32Array(maxQuads * 12);
  let normals = new Float32Array(maxQuads * 12);
  let colors = new Float32Array(maxQuads * 12);
  let indices = new Uint32Array(maxQuads * 6);
  let vc = 0, ic = 0;
  
  const mask = new Uint16Array(S2);
  const visited = new Uint8Array(S2);
  
  for (let si = 0; si < sectionKeys.length; si++) {
    const sectionKey = sectionKeys[si];
    const section = getSection(sectionKey);
    if (!section) continue;
    
    const { baseX, baseY, baseZ } = baseCoords[si];
    const { top, bot, right, left, front, back } = neighborKeys[si];
    
    const secTop = getSection(top);
    const secBot = getSection(bot);
    const secRight = getSection(right);
    const secLeft = getSection(left);
    const secFront = getSection(front);
    const secBack = getSection(back);
    
    // Process all 6 faces
    // Face 0: Top (+Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      const sliceBase = ly * S2;
      
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
        
        let nid = 0;
        if (ly < 15) nid = section[sliceBase + S2 + j] & BLOCK_ID_MASK;
        else if (secTop) nid = secTop[j] & BLOCK_ID_MASK;
        
        if (!isOpaque[nid] || isNonCube[nid]) { mask[j] = bid; hasFaces = true; }
      }
      
      if (hasFaces) {
        visited.fill(0);
        for (let jj = 0; jj < S; jj++) {
          for (let ii = 0; ii < S; ii++) {
            const mi = jj * S + ii;
            if (visited[mi] || mask[mi] === 0) continue;
            
            const bid = mask[mi];
            let w = 1;
            while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
            
            let h = 1;
            outer: while (jj + h < S) {
              for (let k = 0; k < w; k++) {
                if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
              }
              h++;
            }
            
            for (let dj = 0; dj < h; dj++)
              for (let di = 0; di < w; di++)
                visited[(jj + dj) * S + ii + di] = 1;
            
            // Emit quad
            const x = baseX + ii - ox, y = baseY + ly + 1 - oy, z = baseZ + jj - oz;
            const sv = vc, pi = vc * 3;
            
            // Check bounds
            if (pi + 12 > positions.length) {
              const newSize = positions.length * 2;
              const newPos = new Float32Array(newSize);
              newPos.set(positions);
              positions = newPos;
              const newNorm = new Float32Array(newSize);
              newNorm.set(normals);
              normals = newNorm;
              const newCol = new Float32Array(newSize);
              newCol.set(colors);
              colors = newCol;
              const newIdx = new Uint32Array(newSize / 2);
              newIdx.set(indices);
              indices = newIdx;
            }
            
            positions[pi] = x; positions[pi+1] = y; positions[pi+2] = z + h;
            positions[pi+3] = x + w; positions[pi+4] = y; positions[pi+5] = z + h;
            positions[pi+6] = x + w; positions[pi+7] = y; positions[pi+8] = z;
            positions[pi+9] = x; positions[pi+10] = y; positions[pi+11] = z;
            
            const r = colorR[bid], g = colorG[bid], b = colorB[bid];
            for (let v = 0; v < 4; v++) {
              normals[pi + v*3] = 0; normals[pi + v*3 + 1] = 1; normals[pi + v*3 + 2] = 0;
              colors[pi + v*3] = r; colors[pi + v*3 + 1] = g; colors[pi + v*3 + 2] = b;
            }
            vc += 4;
            indices[ic++] = sv; indices[ic++] = sv + 1; indices[ic++] = sv + 2;
            indices[ic++] = sv; indices[ic++] = sv + 2; indices[ic++] = sv + 3;
          }
        }
      }
    }
    
    // Face 1: Bottom (-Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      const sliceBase = ly * S2;
      
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
        
        let nid = 0;
        if (ly > 0) nid = section[sliceBase - S2 + j] & BLOCK_ID_MASK;
        else if (secBot) nid = secBot[15 * S2 + j] & BLOCK_ID_MASK;
        
        if (!isOpaque[nid] || isNonCube[nid]) { mask[j] = bid; hasFaces = true; }
      }
      
      if (hasFaces) {
        visited.fill(0);
        for (let jj = 0; jj < S; jj++) {
          for (let ii = 0; ii < S; ii++) {
            const mi = jj * S + ii;
            if (visited[mi] || mask[mi] === 0) continue;
            
            const bid = mask[mi];
            let w = 1;
            while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
            
            let h = 1;
            outer: while (jj + h < S) {
              for (let k = 0; k < w; k++) {
                if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
              }
              h++;
            }
            
            for (let dj = 0; dj < h; dj++)
              for (let di = 0; di < w; di++)
                visited[(jj + dj) * S + ii + di] = 1;
            
            const x = baseX + ii - ox, y = baseY + ly - oy, z = baseZ + jj - oz;
            const sv = vc, pi = vc * 3;
            
            if (pi + 12 > positions.length) continue;
            
            positions[pi] = x; positions[pi+1] = y; positions[pi+2] = z;
            positions[pi+3] = x + w; positions[pi+4] = y; positions[pi+5] = z;
            positions[pi+6] = x + w; positions[pi+7] = y; positions[pi+8] = z + h;
            positions[pi+9] = x; positions[pi+10] = y; positions[pi+11] = z + h;
            
            const r = colorR[bid], g = colorG[bid], b = colorB[bid];
            for (let v = 0; v < 4; v++) {
              normals[pi + v*3] = 0; normals[pi + v*3 + 1] = -1; normals[pi + v*3 + 2] = 0;
              colors[pi + v*3] = r; colors[pi + v*3 + 1] = g; colors[pi + v*3 + 2] = b;
            }
            vc += 4;
            indices[ic++] = sv; indices[ic++] = sv + 1; indices[ic++] = sv + 2;
            indices[ic++] = sv; indices[ic++] = sv + 2; indices[ic++] = sv + 3;
          }
        }
      }
    }
    
    // Face 2: Right (+X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
          
          let nid = 0;
          if (lx < 15) nid = section[idx + 1] & BLOCK_ID_MASK;
          else if (secRight) nid = secRight[ly * S2 + lz * S] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid] || isNonCube[nid]) { mask[ly * S + lz] = bid; hasFaces = true; }
        }
      }
      
      if (hasFaces) {
        visited.fill(0);
        for (let jj = 0; jj < S; jj++) {
          for (let ii = 0; ii < S; ii++) {
            const mi = jj * S + ii;
            if (visited[mi] || mask[mi] === 0) continue;
            
            const bid = mask[mi];
            let w = 1;
            while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
            
            let h = 1;
            outer: while (jj + h < S) {
              for (let k = 0; k < w; k++) {
                if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
              }
              h++;
            }
            
            for (let dj = 0; dj < h; dj++)
              for (let di = 0; di < w; di++)
                visited[(jj + dj) * S + ii + di] = 1;
            
            const x = baseX + lx + 1 - ox, y = baseY + jj - oy, z = baseZ + ii - oz;
            const sv = vc, pi = vc * 3;
            
            if (pi + 12 > positions.length) continue;
            
            positions[pi] = x; positions[pi+1] = y; positions[pi+2] = z;
            positions[pi+3] = x; positions[pi+4] = y + h; positions[pi+5] = z;
            positions[pi+6] = x; positions[pi+7] = y + h; positions[pi+8] = z + w;
            positions[pi+9] = x; positions[pi+10] = y; positions[pi+11] = z + w;
            
            const r = colorR[bid], g = colorG[bid], b = colorB[bid];
            for (let v = 0; v < 4; v++) {
              normals[pi + v*3] = 1; normals[pi + v*3 + 1] = 0; normals[pi + v*3 + 2] = 0;
              colors[pi + v*3] = r; colors[pi + v*3 + 1] = g; colors[pi + v*3 + 2] = b;
            }
            vc += 4;
            indices[ic++] = sv; indices[ic++] = sv + 1; indices[ic++] = sv + 2;
            indices[ic++] = sv; indices[ic++] = sv + 2; indices[ic++] = sv + 3;
          }
        }
      }
    }
    
    // Face 3: Left (-X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
          
          let nid = 0;
          if (lx > 0) nid = section[idx - 1] & BLOCK_ID_MASK;
          else if (secLeft) nid = secLeft[ly * S2 + lz * S + 15] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid] || isNonCube[nid]) { mask[ly * S + lz] = bid; hasFaces = true; }
        }
      }
      
      if (hasFaces) {
        visited.fill(0);
        for (let jj = 0; jj < S; jj++) {
          for (let ii = 0; ii < S; ii++) {
            const mi = jj * S + ii;
            if (visited[mi] || mask[mi] === 0) continue;
            
            const bid = mask[mi];
            let w = 1;
            while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
            
            let h = 1;
            outer: while (jj + h < S) {
              for (let k = 0; k < w; k++) {
                if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
              }
              h++;
            }
            
            for (let dj = 0; dj < h; dj++)
              for (let di = 0; di < w; di++)
                visited[(jj + dj) * S + ii + di] = 1;
            
            const x = baseX + lx - ox, y = baseY + jj - oy, z = baseZ + ii - oz;
            const sv = vc, pi = vc * 3;
            
            if (pi + 12 > positions.length) continue;
            
            positions[pi] = x; positions[pi+1] = y; positions[pi+2] = z + w;
            positions[pi+3] = x; positions[pi+4] = y + h; positions[pi+5] = z + w;
            positions[pi+6] = x; positions[pi+7] = y + h; positions[pi+8] = z;
            positions[pi+9] = x; positions[pi+10] = y; positions[pi+11] = z;
            
            const r = colorR[bid], g = colorG[bid], b = colorB[bid];
            for (let v = 0; v < 4; v++) {
              normals[pi + v*3] = -1; normals[pi + v*3 + 1] = 0; normals[pi + v*3 + 2] = 0;
              colors[pi + v*3] = r; colors[pi + v*3 + 1] = g; colors[pi + v*3 + 2] = b;
            }
            vc += 4;
            indices[ic++] = sv; indices[ic++] = sv + 1; indices[ic++] = sv + 2;
            indices[ic++] = sv; indices[ic++] = sv + 2; indices[ic++] = sv + 3;
          }
        }
      }
    }
    
    // Face 4: Front (+Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
          
          let nid = 0;
          if (lz < 15) nid = section[idx + S] & BLOCK_ID_MASK;
          else if (secFront) nid = secFront[ly * S2 + lx] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid] || isNonCube[nid]) { mask[ly * S + lx] = bid; hasFaces = true; }
        }
      }
      
      if (hasFaces) {
        visited.fill(0);
        for (let jj = 0; jj < S; jj++) {
          for (let ii = 0; ii < S; ii++) {
            const mi = jj * S + ii;
            if (visited[mi] || mask[mi] === 0) continue;
            
            const bid = mask[mi];
            let w = 1;
            while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
            
            let h = 1;
            outer: while (jj + h < S) {
              for (let k = 0; k < w; k++) {
                if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
              }
              h++;
            }
            
            for (let dj = 0; dj < h; dj++)
              for (let di = 0; di < w; di++)
                visited[(jj + dj) * S + ii + di] = 1;
            
            const x = baseX + ii - ox, y = baseY + jj - oy, z = baseZ + lz + 1 - oz;
            const sv = vc, pi = vc * 3;
            
            if (pi + 12 > positions.length) continue;
            
            positions[pi] = x; positions[pi+1] = y; positions[pi+2] = z;
            positions[pi+3] = x + w; positions[pi+4] = y; positions[pi+5] = z;
            positions[pi+6] = x + w; positions[pi+7] = y + h; positions[pi+8] = z;
            positions[pi+9] = x; positions[pi+10] = y + h; positions[pi+11] = z;
            
            const r = colorR[bid], g = colorG[bid], b = colorB[bid];
            for (let v = 0; v < 4; v++) {
              normals[pi + v*3] = 0; normals[pi + v*3 + 1] = 0; normals[pi + v*3 + 2] = 1;
              colors[pi + v*3] = r; colors[pi + v*3 + 1] = g; colors[pi + v*3 + 2] = b;
            }
            vc += 4;
            indices[ic++] = sv; indices[ic++] = sv + 1; indices[ic++] = sv + 2;
            indices[ic++] = sv; indices[ic++] = sv + 2; indices[ic++] = sv + 3;
          }
        }
      }
    }
    
    // Face 5: Back (-Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
          
          let nid = 0;
          if (lz > 0) nid = section[idx - S] & BLOCK_ID_MASK;
          else if (secBack) nid = secBack[ly * S2 + 15 * S + lx] & BLOCK_ID_MASK;
          
          if (!isOpaque[nid] || isNonCube[nid]) { mask[ly * S + lx] = bid; hasFaces = true; }
        }
      }
      
      if (hasFaces) {
        visited.fill(0);
        for (let jj = 0; jj < S; jj++) {
          for (let ii = 0; ii < S; ii++) {
            const mi = jj * S + ii;
            if (visited[mi] || mask[mi] === 0) continue;
            
            const bid = mask[mi];
            let w = 1;
            while (ii + w < S && !visited[mi + w] && mask[mi + w] === bid) w++;
            
            let h = 1;
            outer: while (jj + h < S) {
              for (let k = 0; k < w; k++) {
                if (visited[(jj + h) * S + ii + k] || mask[(jj + h) * S + ii + k] !== bid) break outer;
              }
              h++;
            }
            
            for (let dj = 0; dj < h; dj++)
              for (let di = 0; di < w; di++)
                visited[(jj + dj) * S + ii + di] = 1;
            
            const x = baseX + ii - ox, y = baseY + jj - oy, z = baseZ + lz - oz;
            const sv = vc, pi = vc * 3;
            
            if (pi + 12 > positions.length) continue;
            
            positions[pi] = x + w; positions[pi+1] = y; positions[pi+2] = z;
            positions[pi+3] = x; positions[pi+4] = y; positions[pi+5] = z;
            positions[pi+6] = x; positions[pi+7] = y + h; positions[pi+8] = z;
            positions[pi+9] = x + w; positions[pi+10] = y + h; positions[pi+11] = z;
            
            const r = colorR[bid], g = colorG[bid], b = colorB[bid];
            for (let v = 0; v < 4; v++) {
              normals[pi + v*3] = 0; normals[pi + v*3 + 1] = 0; normals[pi + v*3 + 2] = -1;
              colors[pi + v*3] = r; colors[pi + v*3 + 1] = g; colors[pi + v*3 + 2] = b;
            }
            vc += 4;
            indices[ic++] = sv; indices[ic++] = sv + 1; indices[ic++] = sv + 2;
            indices[ic++] = sv; indices[ic++] = sv + 2; indices[ic++] = sv + 3;
          }
        }
      }
    }
  }
  
  // Trim arrays
  const finalPos = positions.slice(0, vc * 3);
  const finalNorm = normals.slice(0, vc * 3);
  const finalCol = colors.slice(0, vc * 3);
  const finalIdx = indices.slice(0, ic);
  
  return {
    positions: finalPos,
    normals: finalNorm,
    colors: finalCol,
    indices: finalIdx,
    vertexCount: vc,
    triangleCount: ic / 3,
    transferables: [finalPos.buffer, finalNorm.buffer, finalCol.buffer, finalIdx.buffer]
  };
}
`;

/**
 * Create a worker from inline code
 */
function createWorker() {
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

/**
 * Build meshes using parallel workers
 */
export async function buildGridMeshesParallel(grid, registry, offset = { x: 0, y: 64, z: 0 }) {
  // Build lookup tables
  const isOpaque = new Uint8Array(4096);
  const isNonCube = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  const isFluid = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info) {
      isOpaque[id] = registry.isOpaque(id) ? 1 : 0;
      isNonCube[id] = registry.isNonCube(id) ? 1 : 0;
      const col = registry.getColor(id);
      colorR[id] = col.r;
      colorG[id] = col.g;
      colorB[id] = col.b;
      if (info.name) {
        if (info.name.includes('water')) isFluid[id] = 1;
        else if (info.name.includes('lava')) isFluid[id] = 2;
      }
    }
  }
  
  // Collect all sections and create shared buffer
  const sectionKeys = [...grid.sections.keys()];
  const totalSections = sectionKeys.length;
  
  if (totalSections === 0) {
    return { solid: null, water: null, lava: null };
  }
  
  // Create SharedArrayBuffer for grid data
  const gridBuffer = new SharedArrayBuffer(totalSections * S3 * 2);
  const sharedGrid = new Uint16Array(gridBuffer);
  
  // Build section offset map
  const sectionOffsets = {};
  let bufferOffset = 0;
  
  for (const key of sectionKeys) {
    const section = grid.sections.get(key);
    sectionOffsets[key] = bufferOffset;
    sharedGrid.set(section, bufferOffset);
    bufferOffset += S3;
  }
  
  // Create workers
  const workers = [];
  const workerReadyPromises = [];
  
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = createWorker();
    workers.push(worker);
    
    workerReadyPromises.push(new Promise(resolve => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') resolve();
      };
    }));
    
    // Initialize worker with shared data
    worker.postMessage({
      type: 'init',
      data: {
        gridBuffer,
        sectionOffsets,
        isOpaque: isOpaque.buffer,
        isNonCube: isNonCube.buffer,
        colorR: colorR.buffer,
        colorG: colorG.buffer,
        colorB: colorB.buffer,
      }
    });
  }
  
  await Promise.all(workerReadyPromises);
  
  // Distribute sections to workers
  const sectionsPerWorker = Math.ceil(totalSections / WORKER_COUNT);
  const meshPromises = [];
  
  for (let i = 0; i < WORKER_COUNT; i++) {
    const startIdx = i * sectionsPerWorker;
    const endIdx = Math.min(startIdx + sectionsPerWorker, totalSections);
    
    if (startIdx >= endIdx) continue;
    
    const workerSectionKeys = sectionKeys.slice(startIdx, endIdx);
    const baseCoords = [];
    const neighborKeys = [];
    
    for (const key of workerSectionKeys) {
      const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
      baseCoords.push({
        baseX: cx * S,
        baseY: sectionToWorldY(sy),
        baseZ: cz * S,
      });
      neighborKeys.push({
        top: makeSectionKey(cx, cz, sy + 1),
        bot: makeSectionKey(cx, cz, sy - 1),
        right: makeSectionKey(cx + 1, cz, sy),
        left: makeSectionKey(cx - 1, cz, sy),
        front: makeSectionKey(cx, cz + 1, sy),
        back: makeSectionKey(cx, cz - 1, sy),
      });
    }
    
    meshPromises.push(new Promise((resolve, reject) => {
      workers[i].onmessage = (e) => {
        if (e.data.type === 'result') {
          resolve(e.data.data);
        }
      };
      workers[i].onerror = reject;
      
      workers[i].postMessage({
        type: 'mesh',
        data: {
          sectionKeys: workerSectionKeys,
          baseCoords,
          neighborKeys,
          offset,
        }
      });
    }));
  }
  
  // Wait for all workers
  const results = await Promise.all(meshPromises);
  
  // Terminate workers
  for (const worker of workers) {
    worker.terminate();
  }
  
  // Combine results
  let totalVerts = 0, totalIndices = 0;
  for (const r of results) {
    totalVerts += r.vertexCount;
    totalIndices += r.indices.length;
  }
  
  if (totalVerts === 0) {
    return { solid: null, water: null, lava: null };
  }
  
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  
  let pOff = 0, iOff = 0, vOff = 0;
  
  for (const r of results) {
    positions.set(r.positions, pOff);
    normals.set(r.normals, pOff);
    colors.set(r.colors, pOff);
    
    for (let i = 0; i < r.indices.length; i++) {
      indices[iOff + i] = r.indices[i] + vOff;
    }
    
    pOff += r.positions.length;
    iOff += r.indices.length;
    vOff += r.vertexCount;
  }
  
  return {
    solid: {
      positions,
      normals,
      colors,
      indices,
      vertexCount: totalVerts,
      triangleCount: totalIndices / 3,
    },
    water: null,
    lava: null,
  };
}

export default buildGridMeshesParallel;

