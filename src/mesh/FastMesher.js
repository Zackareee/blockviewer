/**
 * FastMesher - Ultra-optimized single-pass greedy mesher
 * 
 * Key optimization: Single pass through blocks, build all 6 face masks at once
 */

import { BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, sectionToWorldY, makeSectionKey, parseSectionKey } from './BinaryGrid.js';

const S = 16;
const S2 = 256;
const S3 = 4096;

/**
 * Build all meshes for a region
 */
export function buildGridMeshes(grid, registry, offset = { x: 0, y: 64, z: 0 }) {
  // Build lookup tables
  const isOpaque = new Uint8Array(4096);
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  const isFluid = new Uint8Array(4096);
  
  for (let id = 0; id < 4096; id++) {
    const info = registry.getBlockInfo(id);
    if (info) {
      isOpaque[id] = registry.isOpaque(id) ? 1 : 0;
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
  
  // Growable arrays - start small, expand as needed
  // This avoids large upfront allocations that can fail under memory pressure
  const INITIAL_SIZE = 100000; // Start with 100k triangles worth
  const GROWTH_FACTOR = 1.5;
  
  // Solid mesh arrays
  let sPos = new Float32Array(INITIAL_SIZE * 12);
  let sNorm = new Float32Array(INITIAL_SIZE * 12);
  let sCol = new Float32Array(INITIAL_SIZE * 12);
  let sIdx = new Uint32Array(INITIAL_SIZE * 6);
  let sVC = 0, sIC = 0;
  let sCapacity = INITIAL_SIZE;
  
  // Water mesh arrays (smaller initial size)
  let wPos = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let wNorm = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let wCol = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let wIdx = new Uint32Array(INITIAL_SIZE * 0.2 * 6);
  let wVC = 0, wIC = 0;
  let wCapacity = Math.floor(INITIAL_SIZE * 0.2);
  
  // Lava mesh arrays (very small initial size)
  let lPos = new Float32Array(INITIAL_SIZE * 0.05 * 12);
  let lNorm = new Float32Array(INITIAL_SIZE * 0.05 * 12);
  let lCol = new Float32Array(INITIAL_SIZE * 0.05 * 12);
  let lIdx = new Uint32Array(INITIAL_SIZE * 0.05 * 6);
  let lVC = 0, lIC = 0;
  let lCapacity = Math.floor(INITIAL_SIZE * 0.05);
  
  // Helper to grow arrays when needed
  function growArrays(type) {
    try {
      if (type === 's') {
        const newCap = Math.floor(sCapacity * GROWTH_FACTOR);
        const newPos = new Float32Array(newCap * 12);
        const newNorm = new Float32Array(newCap * 12);
        const newCol = new Float32Array(newCap * 12);
        const newIdx = new Uint32Array(newCap * 6);
        newPos.set(sPos.subarray(0, sVC * 3));
        newNorm.set(sNorm.subarray(0, sVC * 3));
        newCol.set(sCol.subarray(0, sVC * 3));
        newIdx.set(sIdx.subarray(0, sIC));
        sPos = newPos; sNorm = newNorm; sCol = newCol; sIdx = newIdx;
        sCapacity = newCap;
      } else if (type === 'w') {
        const newCap = Math.floor(wCapacity * GROWTH_FACTOR);
        const newPos = new Float32Array(newCap * 12);
        const newNorm = new Float32Array(newCap * 12);
        const newCol = new Float32Array(newCap * 12);
        const newIdx = new Uint32Array(newCap * 6);
        newPos.set(wPos.subarray(0, wVC * 3));
        newNorm.set(wNorm.subarray(0, wVC * 3));
        newCol.set(wCol.subarray(0, wVC * 3));
        newIdx.set(wIdx.subarray(0, wIC));
        wPos = newPos; wNorm = newNorm; wCol = newCol; wIdx = newIdx;
        wCapacity = newCap;
      } else if (type === 'l') {
        const newCap = Math.floor(lCapacity * GROWTH_FACTOR);
        const newPos = new Float32Array(newCap * 12);
        const newNorm = new Float32Array(newCap * 12);
        const newCol = new Float32Array(newCap * 12);
        const newIdx = new Uint32Array(newCap * 6);
        newPos.set(lPos.subarray(0, lVC * 3));
        newNorm.set(lNorm.subarray(0, lVC * 3));
        newCol.set(lCol.subarray(0, lVC * 3));
        newIdx.set(lIdx.subarray(0, lIC));
        lPos = newPos; lNorm = newNorm; lCol = newCol; lIdx = newIdx;
        lCapacity = newCap;
      }
      return true;
    } catch (e) {
      console.warn('[FastMesher] Failed to grow arrays:', e.message);
      return false;
    }
  }
  
  // Check capacity before adding quads
  function ensureCapacity(type, neededQuads) {
    if (type === 's' && sVC / 4 + neededQuads > sCapacity) return growArrays('s');
    if (type === 'w' && wVC / 4 + neededQuads > wCapacity) return growArrays('w');
    if (type === 'l' && lVC / 4 + neededQuads > lCapacity) return growArrays('l');
    return true;
  }
  
  // Reusable masks - 6 faces × 16 slices = 96 masks
  // But we'll process one face at a time to save memory
  const mask = new Uint16Array(S2);
  const visited = new Uint8Array(S2);
  
  const ox = offset.x, oy = offset.y, oz = offset.z;
  
  // Process each section
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S;
    const baseY = sectionToWorldY(sy);
    const baseZ = cz * S;
    
    // Count non-air blocks quickly
    let nonAirCount = 0;
    for (let i = 0; i < S3; i++) {
      if (section[i] !== 0) nonAirCount++;
    }
    if (nonAirCount === 0) continue;
    
    // Ensure capacity for this section (max 6 faces per block, but greedy reduces this significantly)
    // Estimate ~10% of blocks will have exposed faces on average
    const estimatedQuads = Math.ceil(nonAirCount * 0.3);
    if (!ensureCapacity('s', estimatedQuads)) {
      console.warn('[FastMesher] Cannot allocate more memory, stopping mesh generation');
      break; // Stop processing more sections if we can't allocate
    }
    
    // Get neighbors
    const secTop = grid.sections.get(makeSectionKey(cx, cz, sy + 1));
    const secBot = grid.sections.get(makeSectionKey(cx, cz, sy - 1));
    const secRight = grid.sections.get(makeSectionKey(cx + 1, cz, sy));
    const secLeft = grid.sections.get(makeSectionKey(cx - 1, cz, sy));
    const secFront = grid.sections.get(makeSectionKey(cx, cz + 1, sy));
    const secBack = grid.sections.get(makeSectionKey(cx, cz - 1, sy));
    
    // ===== SINGLE PASS: Build all 6 face masks simultaneously =====
    // For each slice/layer, we track which blocks have exposed faces
    
    // Face 0: Top (+Y) - process by Y layer
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      
      const sliceBase = ly * S2;
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isOpaque[bid]) continue;
        
        // Check neighbor above
        let nid = 0;
        if (ly < 15) {
          nid = section[sliceBase + S2 + j] & BLOCK_ID_MASK;
        } else if (secTop) {
          nid = secTop[j] & BLOCK_ID_MASK;
        }
        
        if (!isOpaque[nid]) {
          mask[j] = bid;
          hasFaces = true;
        }
      }
      
      if (!hasFaces) continue;
      
      // Greedy merge
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
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          // Emit quad - top face
          const x = baseX + ii - ox;
          const y = baseY + ly + 1 - oy;
          const z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + h;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z + h;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
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
        if (bid === 0 || !isOpaque[bid]) continue;
        
        let nid = 0;
        if (ly > 0) {
          nid = section[sliceBase - S2 + j] & BLOCK_ID_MASK;
        } else if (secBot) {
          nid = secBot[15 * S2 + j] & BLOCK_ID_MASK;
        }
        
        if (!isOpaque[nid]) {
          mask[j] = bid;
          hasFaces = true;
        }
      }
      
      if (!hasFaces) continue;
      
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
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          const x = baseX + ii - ox;
          const y = baseY + ly - oy;
          const z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z + h;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + h;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = -1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
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
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lx < 15) {
            nid = section[idx + 1] & BLOCK_ID_MASK;
          } else if (secRight) {
            nid = secRight[ly * S2 + lz * S] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid]) {
            mask[ly * S + lz] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
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
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          const x = baseX + lx + 1 - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y + h; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z + w;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + w;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
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
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lx > 0) {
            nid = section[idx - 1] & BLOCK_ID_MASK;
          } else if (secLeft) {
            nid = secLeft[ly * S2 + lz * S + 15] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid]) {
            mask[ly * S + lz] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
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
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          const x = baseX + lx - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + w;
          sPos[pi+3] = x; sPos[pi+4] = y + h; sPos[pi+5] = z + w;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = -1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
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
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lz < 15) {
            nid = section[idx + S] & BLOCK_ID_MASK;
          } else if (secFront) {
            nid = secFront[ly * S2 + lx] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid]) {
            mask[ly * S + lx] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
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
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz + 1 - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + w; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y + h; sPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
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
          if (bid === 0 || !isOpaque[bid]) continue;
          
          let nid = 0;
          if (lz > 0) {
            nid = section[idx - S] & BLOCK_ID_MASK;
          } else if (secBack) {
            nid = secBack[ly * S2 + 15 * S + lx] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid]) {
            mask[ly * S + lx] = bid;
            hasFaces = true;
          }
        }
      }
      
      if (!hasFaces) continue;
      
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
              const ci = (jj + h) * S + ii + k;
              if (visited[ci] || mask[ci] !== bid) break outer;
            }
            h++;
          }
          
          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz - oz;
          const sv = sVC, pi = sVC * 3;
          
          sPos[pi] = x + w; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + h; sPos[pi+8] = z;
          sPos[pi+9] = x + w; sPos[pi+10] = y + h; sPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = -1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
    
    // Fluids - just top faces
    for (let i = 0; i < S3; i++) {
      const value = section[i];
      if (value === 0) continue;
      
      const bid = value & BLOCK_ID_MASK;
      const ft = isFluid[bid];
      if (ft === 0) continue;
      
      const level = (value & LEVEL_MASK) >> LEVEL_SHIFT;
      let h = level >= 8 ? 1.0 : (level > 0 ? Math.max(0.125, (14 - level * 1.5) / 16) : 0.875);
      
      const lx = i % S;
      const lz = Math.floor(i / S) % S;
      const ly = Math.floor(i / S2);
      
      const x = baseX + lx - ox;
      const y = baseY + ly - oy;
      const z = baseZ + lz - oz;
      
      const pos = ft === 1 ? wPos : lPos;
      const norm = ft === 1 ? wNorm : lNorm;
      const col = ft === 1 ? wCol : lCol;
      const idx = ft === 1 ? wIdx : lIdx;
      let vc = ft === 1 ? wVC : lVC;
      let ic = ft === 1 ? wIC : lIC;
      
      const pi = vc * 3;
      if (pi + 12 > pos.length) continue;
      
      const sv = vc;
      pos[pi] = x; pos[pi+1] = y + h; pos[pi+2] = z + 1;
      pos[pi+3] = x + 1; pos[pi+4] = y + h; pos[pi+5] = z + 1;
      pos[pi+6] = x + 1; pos[pi+7] = y + h; pos[pi+8] = z;
      pos[pi+9] = x; pos[pi+10] = y + h; pos[pi+11] = z;
      
      const r = colorR[bid], g = colorG[bid], b = colorB[bid];
      for (let v = 0; v < 4; v++) {
        norm[pi + v*3] = 0; norm[pi + v*3 + 1] = 1; norm[pi + v*3 + 2] = 0;
        col[pi + v*3] = r; col[pi + v*3 + 1] = g; col[pi + v*3 + 2] = b;
      }
      
      idx[ic++] = sv; idx[ic++] = sv + 1; idx[ic++] = sv + 2;
      idx[ic++] = sv; idx[ic++] = sv + 2; idx[ic++] = sv + 3;
      vc += 4;
      
      if (ft === 1) { wVC = vc; wIC = ic; }
      else { lVC = vc; lIC = ic; }
    }
  }
  
  // Trim and return
  const trimMesh = (pos, norm, col, idx, vc, ic) => {
    if (vc === 0) return null;
    return {
      positions: pos.subarray(0, vc * 3),
      normals: norm.subarray(0, vc * 3),
      colors: col.subarray(0, vc * 3),
      indices: idx.subarray(0, ic),
      vertexCount: vc,
      triangleCount: ic / 3,
    };
  };
  
  return {
    solid: trimMesh(sPos, sNorm, sCol, sIdx, sVC, sIC),
    water: trimMesh(wPos, wNorm, wCol, wIdx, wVC, wIC),
    lava: trimMesh(lPos, lNorm, lCol, lIdx, lVC, lIC),
  };
}

export default buildGridMeshes;
