/**
 * FastMesher - Ultra-optimized single-pass greedy mesher
 * 
 * Key optimization: Single pass through blocks, build all 6 face masks at once
 */

import { BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT, sectionToWorldY, makeSectionKey, parseSectionKey } from './BinaryGrid.js';
import { FACE_UP, FACE_DOWN, FACE_NORTH, FACE_SOUTH, FACE_EAST, FACE_WEST } from '../assets/TextureIndexLookup.js';
import { AXIS_Y, AXIS_X, AXIS_Z, AXIS_SHIFT, AXIS_MASK } from './ChunkDecoder.js';
import { isRotatableBlock, getBlockSideOverlay } from '../assets/BlockTextureRegistry.js';
import { buildFaceTintTypeLookup, TINT_TYPE } from '../data/biomeTinting.js';

const S = 16;
const S2 = 256;
const S3 = 4096;

/**
 * Build all meshes for a region
 * @param {BinaryGrid} grid - The block grid
 * @param {BlockRegistry} registry - Block registry
 * @param {Object} offset - World offset { x, y, z }
 * @param {Object} options - Optional parameters
 * @param {TextureIndexLookup} options.textureIndexLookup - Texture atlas index lookup
 */
export function buildGridMeshes(grid, registry, offset = { x: 0, y: 64, z: 0 }, options = {}) {
  const { textureIndexLookup = null } = options;
  
  if (textureIndexLookup) {
    console.log(`[FastMesher] Using textureIndexLookup with ${textureIndexLookup.registeredBlocks.size} blocks, tiles: ${textureIndexLookup.tilesPerRow}x${textureIndexLookup.tilesPerCol}`);
  }
  
  // Build lookup tables
  const isOpaque = new Uint8Array(4096);
  const isNonCube = new Uint8Array(4096); // Non-cube blocks skip greedy meshing
  const colorR = new Float32Array(4096);
  const colorG = new Float32Array(4096);
  const colorB = new Float32Array(4096);
  const isFluid = new Uint8Array(4096);
  const isGlass = new Uint8Array(4096); // Glass and transparent blocks
  const isRotatable = new Uint8Array(4096); // Blocks that support axis rotation
  const needsSideOverlay = new Uint8Array(4096); // Blocks with tinted side overlay (grass_block)
  const sideOverlayTexIdx = new Float32Array(4096); // Overlay texture atlas index
  
  // Build per-face tint type lookup for biome tinting (grass, leaves, etc.)
  // This respects tintindex from block models - e.g. grass_block only tints top face
  const faceTintTypeLookup = buildFaceTintTypeLookup(registry);
  
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
        // Glass and similar transparent blocks (full glass blocks, ice, leaves)
        // Note: glass_pane is EXCLUDED - panes are partial/model blocks, not full cubes
        else if ((info.name.includes('glass') && !info.name.includes('_pane')) || info.name.includes('ice') || info.name.includes('leaves')) {
          isGlass[id] = 1;
        }
        // Check if this block is rotatable (logs, pillars, etc.)
        if (isRotatableBlock(info.name)) {
          isRotatable[id] = 1;
        }
        // Check if this block has a side overlay (grass_block)
        const overlayPath = getBlockSideOverlay(info.name);
        if (overlayPath && textureIndexLookup) {
          needsSideOverlay[id] = 1;
          sideOverlayTexIdx[id] = textureIndexLookup.getIndexByPath(overlayPath);
        }
      }
    }
  }
  
  /**
   * Calculate texture rotation for a rotated block face
   * Matches Minecraft's cube_column model UV behavior
   * 
   * In Minecraft's cube model, each face has specific UV mappings that account for
   * the face's orientation. Our triplanar projection needs rotation to match.
   * 
   * @param {number} axis - Block axis: 0=y, 1=x, 2=z
   * @param {number} faceDir - Face direction constant (FACE_UP, FACE_NORTH, etc.)
   * @returns {number} UV rotation: 0=0°, 1=90°, 2=180°, 3=270°
   */
  function getTextureRotation(axis, faceDir) {
    if (axis === AXIS_Y) {
      // Vertical logs: no rotation needed
      // The triplanar UV mapping naturally aligns the texture correctly
      return 0;
    }
    
    // For horizontal logs, we need to match the UV rotations from cube_column_horizontal
    // after block-level X and Y rotations are applied
    //
    // cube_column_horizontal has: UP face = end texture with 180° rotation
    // 
    // axis=z (X=90 rotation):
    //   Original UP (with 180°) → SOUTH
    //   Original EAST/WEST → stay in place but rotate 90° internally
    //   Original NORTH → UP, Original SOUTH → DOWN
    //
    // axis=x (X=90, Y=90 rotation):
    //   Original UP (with 180°) → EAST  
    //   Original DOWN → WEST
    //   Original NORTH → UP, Original SOUTH → DOWN
    //   Original EAST → NORTH, Original WEST → SOUTH
    
    if (axis === AXIS_X) {
      // Block is horizontal along X axis (east-west)
      // EAST face was original UP (had 180° rotation in model)
      if (faceDir === FACE_EAST) {
        return 2; // 180° rotation (from model's UP face rotation)
      }
      // WEST face was original DOWN (no rotation)
      if (faceDir === FACE_WEST) {
        return 0;
      }
      // All bark faces (UP, DOWN, NORTH, SOUTH) need 90° rotation
      // because the texture "up" direction rotated with the model
      return 1;
    }
    
    if (axis === AXIS_Z) {
      // Block is horizontal along Z axis (north-south)
      // SOUTH face was original UP (had 180° rotation in model)
      if (faceDir === FACE_SOUTH) {
        return 2; // 180° rotation
      }
      // NORTH face was original DOWN (no rotation)
      if (faceDir === FACE_NORTH) {
        return 0;
      }
      // EAST/WEST bark faces need 90° rotation
      if (faceDir === FACE_EAST || faceDir === FACE_WEST) {
        return 1;
      }
      // TOP/BOTTOM bark faces - no rotation needed
      // (the model's NORTH/SOUTH faces became UP/DOWN without internal rotation)
      return 0;
    }
    
    return 0;
  }

  /**
   * Get the effective face direction for texture lookup on a rotated block
   * Maps the actual face to the "logical" face for texture selection
   * @param {number} axis - Block axis: 0=y, 1=x, 2=z
   * @param {number} faceDir - Actual face direction
   * @returns {number} Logical face for texture lookup
   */
  function getRotatedFace(axis, faceDir) {
    if (axis === AXIS_Y) {
      return faceDir; // No remapping for default orientation
    }
    
    if (axis === AXIS_X) {
      // Block is horizontal along X axis
      // East/West are now the "end" faces (like top/bottom of upright block)
      if (faceDir === FACE_EAST || faceDir === FACE_WEST) {
        return FACE_UP; // Use top texture
      } else {
        return FACE_NORTH; // Use side texture
      }
    }
    
    if (axis === AXIS_Z) {
      // Block is horizontal along Z axis
      // North/South are now the "end" faces
      if (faceDir === FACE_NORTH || faceDir === FACE_SOUTH) {
        return FACE_UP; // Use top texture
      } else {
        return FACE_EAST; // Use side texture (east is side in our mapping)
      }
    }
    
    return faceDir;
  }

  // Growable arrays - start small, expand as needed
  // This avoids large upfront allocations that can fail under memory pressure
  const INITIAL_SIZE = 100000; // Start with 100k triangles worth
  const GROWTH_FACTOR = 1.5;
  
  // Solid mesh arrays
  let sPos = new Float32Array(INITIAL_SIZE * 12);
  let sNorm = new Float32Array(INITIAL_SIZE * 12);
  let sCol = new Float32Array(INITIAL_SIZE * 12);
  let sTexIdx = new Float32Array(INITIAL_SIZE * 4); // Texture index per vertex
  let sTexRot = new Float32Array(INITIAL_SIZE * 4); // Texture rotation per vertex (0-3 for 90° increments)
  let sTintType = new Float32Array(INITIAL_SIZE * 4); // Biome tint type per vertex
  let sIdx = new Uint32Array(INITIAL_SIZE * 6);
  let sVC = 0, sIC = 0;
  let sCapacity = INITIAL_SIZE;
  
  // Water mesh arrays - can be large for ocean regions
  let wPos = new Float32Array(INITIAL_SIZE * 0.5 * 12);
  let wNorm = new Float32Array(INITIAL_SIZE * 0.5 * 12);
  let wCol = new Float32Array(INITIAL_SIZE * 0.5 * 12);
  let wIdx = new Uint32Array(INITIAL_SIZE * 0.5 * 6);
  let wVC = 0, wIC = 0;
  let wCapacity = Math.floor(INITIAL_SIZE * 0.5);
  
  // Lava mesh arrays (very small initial size)
  let lPos = new Float32Array(INITIAL_SIZE * 0.05 * 12);
  let lNorm = new Float32Array(INITIAL_SIZE * 0.05 * 12);
  let lCol = new Float32Array(INITIAL_SIZE * 0.05 * 12);
  let lIdx = new Uint32Array(INITIAL_SIZE * 0.05 * 6);
  let lVC = 0, lIC = 0;
  let lCapacity = Math.floor(INITIAL_SIZE * 0.05);
  
  // Glass mesh arrays (moderate initial size - glass structures can be substantial)
  let gPos = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gNorm = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gCol = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gTexIdx = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Texture index per vertex
  let gTexRot = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Texture rotation per vertex
  let gTintType = new Float32Array(INITIAL_SIZE * 0.2 * 4); // Biome tint type per vertex
  let gIdx = new Uint32Array(INITIAL_SIZE * 0.2 * 6);
  let gVC = 0, gIC = 0;
  let gCapacity = Math.floor(INITIAL_SIZE * 0.2);
  
  // Helper to grow arrays when needed
  function growArrays(type) {
    try {
      if (type === 's') {
        const newCap = Math.floor(sCapacity * GROWTH_FACTOR);
        const newPos = new Float32Array(newCap * 12);
        const newNorm = new Float32Array(newCap * 12);
        const newCol = new Float32Array(newCap * 12);
        const newTexIdx = new Float32Array(newCap * 4);
        const newTexRot = new Float32Array(newCap * 4);
        const newTintType = new Float32Array(newCap * 4);
        const newIdx = new Uint32Array(newCap * 6);
        newPos.set(sPos.subarray(0, sVC * 3));
        newNorm.set(sNorm.subarray(0, sVC * 3));
        newCol.set(sCol.subarray(0, sVC * 3));
        newTexIdx.set(sTexIdx.subarray(0, sVC));
        newTexRot.set(sTexRot.subarray(0, sVC));
        newTintType.set(sTintType.subarray(0, sVC));
        newIdx.set(sIdx.subarray(0, sIC));
        sPos = newPos; sNorm = newNorm; sCol = newCol; sTexIdx = newTexIdx; sTexRot = newTexRot; sTintType = newTintType; sIdx = newIdx;
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
      } else if (type === 'g') {
        const newCap = Math.floor(gCapacity * GROWTH_FACTOR);
        const newPos = new Float32Array(newCap * 12);
        const newNorm = new Float32Array(newCap * 12);
        const newCol = new Float32Array(newCap * 12);
        const newTexIdx = new Float32Array(newCap * 4);
        const newTexRot = new Float32Array(newCap * 4);
        const newTintType = new Float32Array(newCap * 4);
        const newIdx = new Uint32Array(newCap * 6);
        newPos.set(gPos.subarray(0, gVC * 3));
        newNorm.set(gNorm.subarray(0, gVC * 3));
        newCol.set(gCol.subarray(0, gVC * 3));
        newTexIdx.set(gTexIdx.subarray(0, gVC));
        newTexRot.set(gTexRot.subarray(0, gVC));
        newTintType.set(gTintType.subarray(0, gVC));
        newIdx.set(gIdx.subarray(0, gIC));
        gPos = newPos; gNorm = newNorm; gCol = newCol; gTexIdx = newTexIdx; gTexRot = newTexRot; gTintType = newTintType; gIdx = newIdx;
        gCapacity = newCap;
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
    if (type === 'g' && gVC / 4 + neededQuads > gCapacity) return growArrays('g');
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
        if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
        
        // Check neighbor above
        let nid = 0;
        if (ly < 15) {
          nid = section[sliceBase + S2 + j] & BLOCK_ID_MASK;
        } else if (secTop) {
          nid = secTop[j] & BLOCK_ID_MASK;
        }
        
        if (!isOpaque[nid] || isNonCube[nid]) {
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
          
          // Extract axis from the first block of this quad
          const blockIdx = ly * S2 + jj * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_UP);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          const texRot = getTextureRotation(axis, FACE_UP);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_UP];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
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
        if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
        
        let nid = 0;
        if (ly > 0) {
          nid = section[sliceBase - S2 + j] & BLOCK_ID_MASK;
        } else if (secBot) {
          nid = secBot[15 * S2 + j] & BLOCK_ID_MASK;
        }
        
        if (!isOpaque[nid] || isNonCube[nid]) {
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
          
          // Extract axis from the first block of this quad
          const blockIdx = ly * S2 + jj * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_DOWN);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          const texRot = getTextureRotation(axis, FACE_DOWN);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_DOWN];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = -1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
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
          if (bid === 0 || !isOpaque[bid] || isNonCube[bid]) continue;
          
          let nid = 0;
          if (lx < 15) {
            nid = section[idx + 1] & BLOCK_ID_MASK;
          } else if (secRight) {
            nid = secRight[ly * S2 + lz * S] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid] || isNonCube[nid]) {
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
          
          // Extract axis from the first block of this quad
          // For X face: mask uses jj=Y, ii=Z, so blockIdx = jj*S2 + ii*S + lx
          const blockIdx = jj * S2 + ii * S + lx;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_EAST);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          const texRot = getTextureRotation(axis, FACE_EAST);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_EAST];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          
          // Add tinted overlay for grass block sides (rendered with glass material for proper alpha)
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            // Same positions as the base face - glass renders after solid so no z-fighting
            gPos[gpi] = x; gPos[gpi+1] = y; gPos[gpi+2] = z;
            gPos[gpi+3] = x; gPos[gpi+4] = y + h; gPos[gpi+5] = z;
            gPos[gpi+6] = x; gPos[gpi+7] = y + h; gPos[gpi+8] = z + w;
            gPos[gpi+9] = x; gPos[gpi+10] = y; gPos[gpi+11] = z + w;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = 1; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = 0;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
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
          if (lx > 0) {
            nid = section[idx - 1] & BLOCK_ID_MASK;
          } else if (secLeft) {
            nid = secLeft[ly * S2 + lz * S + 15] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid] || isNonCube[nid]) {
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
          
          // Extract axis from the first block of this quad
          const blockIdx = jj * S2 + ii * S + lx;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_WEST);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          const texRot = getTextureRotation(axis, FACE_WEST);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_WEST];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = -1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          
          // Add tinted overlay for grass block sides
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            gPos[gpi] = x; gPos[gpi+1] = y; gPos[gpi+2] = z + w;
            gPos[gpi+3] = x; gPos[gpi+4] = y + h; gPos[gpi+5] = z + w;
            gPos[gpi+6] = x; gPos[gpi+7] = y + h; gPos[gpi+8] = z;
            gPos[gpi+9] = x; gPos[gpi+10] = y; gPos[gpi+11] = z;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = -1; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = 0;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
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
          if (lz < 15) {
            nid = section[idx + S] & BLOCK_ID_MASK;
          } else if (secFront) {
            nid = secFront[ly * S2 + lx] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid] || isNonCube[nid]) {
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
          
          // Extract axis from the first block of this quad
          // For Z face: mask uses jj=Y, ii=X, so blockIdx = jj*S2 + lz*S + ii
          const blockIdx = jj * S2 + lz * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_SOUTH);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          const texRot = getTextureRotation(axis, FACE_SOUTH);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_SOUTH];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          
          // Add tinted overlay for grass block sides
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            gPos[gpi] = x; gPos[gpi+1] = y; gPos[gpi+2] = z;
            gPos[gpi+3] = x + w; gPos[gpi+4] = y; gPos[gpi+5] = z;
            gPos[gpi+6] = x + w; gPos[gpi+7] = y + h; gPos[gpi+8] = z;
            gPos[gpi+9] = x; gPos[gpi+10] = y + h; gPos[gpi+11] = z;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = 0; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = 1;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
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
          if (lz > 0) {
            nid = section[idx - S] & BLOCK_ID_MASK;
          } else if (secBack) {
            nid = secBack[ly * S2 + 15 * S + lx] & BLOCK_ID_MASK;
          }
          
          if (!isOpaque[nid] || isNonCube[nid]) {
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
          
          // Extract axis from the first block of this quad
          const blockIdx = jj * S2 + lz * S + ii;
          const fullValue = section[blockIdx];
          const axis = isRotatable[bid] ? ((fullValue >> AXIS_SHIFT) & 0x3) : AXIS_Y;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const rotatedFace = getRotatedFace(axis, FACE_NORTH);
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, rotatedFace) : 0;
          const texRot = getTextureRotation(axis, FACE_NORTH);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_NORTH];
          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = -1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = texRot;
            sTintType[sVC + v] = tintType;
          }
          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
          
          // Add tinted overlay for grass block sides
          if (needsSideOverlay[bid] && ensureCapacity('g', 1)) {
            const gv = gVC, gpi = gVC * 3;
            gPos[gpi] = x + w; gPos[gpi+1] = y; gPos[gpi+2] = z;
            gPos[gpi+3] = x; gPos[gpi+4] = y; gPos[gpi+5] = z;
            gPos[gpi+6] = x; gPos[gpi+7] = y + h; gPos[gpi+8] = z;
            gPos[gpi+9] = x + w; gPos[gpi+10] = y + h; gPos[gpi+11] = z;
            
            const overlayTexIdx = sideOverlayTexIdx[bid];
            for (let v = 0; v < 4; v++) {
              gNorm[gpi + v*3] = 0; gNorm[gpi + v*3 + 1] = 0; gNorm[gpi + v*3 + 2] = -1;
              gCol[gpi + v*3] = r; gCol[gpi + v*3 + 1] = g; gCol[gpi + v*3 + 2] = b;
              gTexIdx[gVC + v] = overlayTexIdx;
              gTexRot[gVC + v] = texRot;
              gTintType[gVC + v] = TINT_TYPE.GRASS;
            }
            gVC += 4;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
            gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
          }
        }
      }
    }
    
    // Fluids - find topmost fluid in each (x,z) column, then greedy mesh
    // This guarantees only ONE surface per body of water regardless of depth
    // Also handles waterlogged blocks (level == 8 marker for non-fluid blocks)
    
    // For each (x,z) column in this section, track the topmost water and lava Y level
    // Key: x + z*16, Value: { y: worldY, blockId, level, height }
    const topWater = new Map();
    const topLava = new Map();
    
    // Get water block ID for coloring waterlogged water
    const waterBlockId = registry.getBlockId('minecraft:water');
    
    // Scan ALL Y levels in this section to find topmost fluids per column
    for (let ly = 0; ly < S; ly++) {
      const sliceBase = ly * S2;
      const worldY = baseY + ly;
      
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = sliceBase + lz * S + lx;
          const value = section[idx];
          if (value === 0) continue;
          
          const bid = value & BLOCK_ID_MASK;
          const level = (value & LEVEL_MASK) >> LEVEL_SHIFT;
          const ft = isFluid[bid];
          
          // Check for waterlogged blocks: non-fluid blocks with level == 8
          const isWaterlogged = (ft === 0 && level === 8);
          
          if (ft === 0 && !isWaterlogged) continue;
          
          const colKey = lx + lz * S;
          
          if (ft === 1 || isWaterlogged) {
            // Water or waterlogged block
            // For waterlogged, use source water height (0.875)
            const h = isWaterlogged ? 0.875 : (level >= 8 ? 1.0 : (level > 0 ? Math.max(0.125, (14 - level * 1.5) / 16) : 0.875));
            const existing = topWater.get(colKey);
            if (!existing || worldY > existing.y) {
              // Use water block ID for color if waterlogged
              topWater.set(colKey, { y: worldY, ly, blockId: isWaterlogged ? waterBlockId : bid, level, height: h, lx, lz });
            }
          } else if (ft === 2) {
            // Lava
            const h = level >= 8 ? 1.0 : (level > 0 ? Math.max(0.125, (14 - level * 1.5) / 16) : 0.875);
            const existing = topLava.get(colKey);
            if (!existing || worldY > existing.y) {
              topLava.set(colKey, { y: worldY, ly, blockId: bid, level, height: h, lx, lz });
            }
          }
        }
      }
    }
    
    // Now check if topmost fluid is covered by fluid/waterlogged in section above
    // Only keep entries that are truly the top surface
    if (secTop) {
      for (const [colKey, data] of topWater) {
        if (data.ly === 15) {
          // This fluid is at top of section - check section above
          const aboveIdx = data.lz * S + data.lx; // Y=0 of section above
          const aboveValue = secTop[aboveIdx];
          const aboveBid = aboveValue & BLOCK_ID_MASK;
          const aboveLevel = (aboveValue & LEVEL_MASK) >> LEVEL_SHIFT;
          // Remove if covered by water or waterlogged block above
          const aboveIsWaterlogged = (isFluid[aboveBid] === 0 && aboveLevel === 8);
          if (isFluid[aboveBid] === 1 || aboveIsWaterlogged) {
            topWater.delete(colKey);
          }
        }
      }
      for (const [colKey, data] of topLava) {
        if (data.ly === 15) {
          const aboveIdx = data.lz * S + data.lx;
          const aboveBid = secTop[aboveIdx] & BLOCK_ID_MASK;
          if (isFluid[aboveBid] === 2) {
            topLava.delete(colKey);
          }
        }
      }
    }
    
    // Build water surface mesh with greedy meshing
    if (topWater.size > 0) {
      // Create 2D mask for greedy merge
      const fluidMask = new Uint16Array(S2);
      const fluidHeights = new Float32Array(S2);
      const fluidY = new Float32Array(S2);
      
      for (const [colKey, data] of topWater) {
        const heightBucket = Math.floor(data.height * 7.99);
        fluidMask[colKey] = (heightBucket << 12) | data.blockId;
        fluidHeights[colKey] = data.height;
        fluidY[colKey] = data.y;
      }
      
      // Greedy merge water surface
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || fluidMask[mi] === 0) continue;
          
          const bid = fluidMask[mi] & 0xFFF;
          const h = fluidHeights[mi];
          const y = fluidY[mi];
          const heightBucket = (fluidMask[mi] >> 12) & 0xF;
          
          // Greedy expand width (X) - must have same Y and height
          let w = 1;
          while (ii + w < S && !visited[mi + w] && fluidMask[mi + w] !== 0) {
            if (((fluidMask[mi + w] >> 12) & 0xF) !== heightBucket) break;
            if (fluidY[mi + w] !== y) break; // Same Y level required
            w++;
          }
          
          // Greedy expand depth (Z)
          let d = 1;
          outer: while (jj + d < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + d) * S + ii + k;
              if (visited[ci] || fluidMask[ci] === 0) break outer;
              if (((fluidMask[ci] >> 12) & 0xF) !== heightBucket) break outer;
              if (fluidY[ci] !== y) break outer;
            }
            d++;
          }
          
          // Mark visited
          for (let dj = 0; dj < d; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          // Emit merged quad
          if (!ensureCapacity('w', 1)) continue;
          
          const x = baseX + ii - ox;
          const wy = y - oy;
          const z = baseZ + jj - oz;
          
          const pi = wVC * 3;
          const sv = wVC;
          wPos[pi] = x; wPos[pi+1] = wy + h; wPos[pi+2] = z + d;
          wPos[pi+3] = x + w; wPos[pi+4] = wy + h; wPos[pi+5] = z + d;
          wPos[pi+6] = x + w; wPos[pi+7] = wy + h; wPos[pi+8] = z;
          wPos[pi+9] = x; wPos[pi+10] = wy + h; wPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            wNorm[pi + v*3] = 0; wNorm[pi + v*3 + 1] = 1; wNorm[pi + v*3 + 2] = 0;
            wCol[pi + v*3] = r; wCol[pi + v*3 + 1] = g; wCol[pi + v*3 + 2] = b;
          }
          
          wIdx[wIC++] = sv; wIdx[wIC++] = sv + 1; wIdx[wIC++] = sv + 2;
          wIdx[wIC++] = sv; wIdx[wIC++] = sv + 2; wIdx[wIC++] = sv + 3;
          wVC += 4;
        }
      }
    }
    
    // Build lava surface mesh with greedy meshing
    if (topLava.size > 0) {
      const fluidMask = new Uint16Array(S2);
      const fluidHeights = new Float32Array(S2);
      const fluidY = new Float32Array(S2);
      
      for (const [colKey, data] of topLava) {
        const heightBucket = Math.floor(data.height * 7.99);
        fluidMask[colKey] = (heightBucket << 12) | data.blockId;
        fluidHeights[colKey] = data.height;
        fluidY[colKey] = data.y;
      }
      
      visited.fill(0);
      for (let jj = 0; jj < S; jj++) {
        for (let ii = 0; ii < S; ii++) {
          const mi = jj * S + ii;
          if (visited[mi] || fluidMask[mi] === 0) continue;
          
          const bid = fluidMask[mi] & 0xFFF;
          const h = fluidHeights[mi];
          const y = fluidY[mi];
          const heightBucket = (fluidMask[mi] >> 12) & 0xF;
          
          let w = 1;
          while (ii + w < S && !visited[mi + w] && fluidMask[mi + w] !== 0) {
            if (((fluidMask[mi + w] >> 12) & 0xF) !== heightBucket) break;
            if (fluidY[mi + w] !== y) break;
            w++;
          }
          
          let d = 1;
          outer: while (jj + d < S) {
            for (let k = 0; k < w; k++) {
              const ci = (jj + d) * S + ii + k;
              if (visited[ci] || fluidMask[ci] === 0) break outer;
              if (((fluidMask[ci] >> 12) & 0xF) !== heightBucket) break outer;
              if (fluidY[ci] !== y) break outer;
            }
            d++;
          }
          
          for (let dj = 0; dj < d; dj++) {
            for (let di = 0; di < w; di++) {
              visited[(jj + dj) * S + ii + di] = 1;
            }
          }
          
          if (!ensureCapacity('l', 1)) continue;
          
          const x = baseX + ii - ox;
          const wy = y - oy;
          const z = baseZ + jj - oz;
          
          const pi = lVC * 3;
          const sv = lVC;
          lPos[pi] = x; lPos[pi+1] = wy + h; lPos[pi+2] = z + d;
          lPos[pi+3] = x + w; lPos[pi+4] = wy + h; lPos[pi+5] = z + d;
          lPos[pi+6] = x + w; lPos[pi+7] = wy + h; lPos[pi+8] = z;
          lPos[pi+9] = x; lPos[pi+10] = wy + h; lPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          for (let v = 0; v < 4; v++) {
            lNorm[pi + v*3] = 0; lNorm[pi + v*3 + 1] = 1; lNorm[pi + v*3 + 2] = 0;
            lCol[pi + v*3] = r; lCol[pi + v*3 + 1] = g; lCol[pi + v*3 + 2] = b;
          }
          
          lIdx[lIC++] = sv; lIdx[lIC++] = sv + 1; lIdx[lIC++] = sv + 2;
          lIdx[lIC++] = sv; lIdx[lIC++] = sv + 2; lIdx[lIC++] = sv + 3;
          lVC += 4;
        }
      }
    }
    
    // ===== GLASS BLOCKS: Build all 6 faces with greedy meshing =====
    // Glass blocks are transparent cubes that need all faces rendered
    
    // Helper function to check if neighbor blocks glass face
    // Glass-to-glass faces are hidden (and same for leaves-to-leaves)
    // Partial blocks (stairs, slabs, etc.) do NOT block glass/leaf faces - they don't fully cover
    const blocksGlassFace = (nid) => (isOpaque[nid] && !isNonCube[nid]) || isGlass[nid];
    
    // Glass Face 0: Top (+Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      
      const sliceBase = ly * S2;
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isGlass[bid]) continue;
        
        let nid = 0;
        if (ly < 15) {
          nid = section[sliceBase + S2 + j] & BLOCK_ID_MASK;
        } else if (secTop) {
          nid = secTop[j] & BLOCK_ID_MASK;
        }
        
        if (!blocksGlassFace(nid)) {
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
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + ly + 1 - oy;
          const z = baseZ + jj - oz;
          const gv = gVC, pi = gVC * 3;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z + h;
          gPos[pi+3] = x + w; gPos[pi+4] = y; gPos[pi+5] = z + h;
          gPos[pi+6] = x + w; gPos[pi+7] = y; gPos[pi+8] = z;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_UP) : 0;
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = 1; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_UP];
          }
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 1: Bottom (-Y)
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      
      const sliceBase = ly * S2;
      for (let j = 0; j < S2; j++) {
        const bid = section[sliceBase + j] & BLOCK_ID_MASK;
        if (bid === 0 || !isGlass[bid]) continue;
        
        let nid = 0;
        if (ly > 0) {
          nid = section[sliceBase - S2 + j] & BLOCK_ID_MASK;
        } else if (secBot) {
          nid = secBot[15 * S2 + j] & BLOCK_ID_MASK;
        }
        
        if (!blocksGlassFace(nid)) {
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
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + ly - oy;
          const z = baseZ + jj - oz;
          const gv = gVC, pi = gVC * 3;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x + w; gPos[pi+4] = y; gPos[pi+5] = z;
          gPos[pi+6] = x + w; gPos[pi+7] = y; gPos[pi+8] = z + h;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z + h;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_DOWN) : 0;
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = -1; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_DOWN];
          }
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 2: Right (+X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nid = 0;
          if (lx < 15) {
            nid = section[idx + 1] & BLOCK_ID_MASK;
          } else if (secRight) {
            nid = secRight[ly * S2 + lz * S] & BLOCK_ID_MASK;
          }
          
          if (!blocksGlassFace(nid)) {
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
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + lx + 1 - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const gv = gVC, pi = gVC * 3;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x; gPos[pi+4] = y + h; gPos[pi+5] = z;
          gPos[pi+6] = x; gPos[pi+7] = y + h; gPos[pi+8] = z + w;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z + w;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_EAST) : 0;
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 1; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_EAST];
          }
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 3: Left (-X)
    for (let lx = 0; lx < S; lx++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nid = 0;
          if (lx > 0) {
            nid = section[idx - 1] & BLOCK_ID_MASK;
          } else if (secLeft) {
            nid = secLeft[ly * S2 + lz * S + 15] & BLOCK_ID_MASK;
          }
          
          if (!blocksGlassFace(nid)) {
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
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + lx - ox;
          const y = baseY + jj - oy;
          const z = baseZ + ii - oz;
          const gv = gVC, pi = gVC * 3;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z + w;
          gPos[pi+3] = x; gPos[pi+4] = y + h; gPos[pi+5] = z + w;
          gPos[pi+6] = x; gPos[pi+7] = y + h; gPos[pi+8] = z;
          gPos[pi+9] = x; gPos[pi+10] = y; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_WEST) : 0;
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = -1; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = 0;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_WEST];
          }
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 4: Front (+Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nid = 0;
          if (lz < 15) {
            nid = section[idx + S] & BLOCK_ID_MASK;
          } else if (secFront) {
            nid = secFront[ly * S2 + lx] & BLOCK_ID_MASK;
          }
          
          if (!blocksGlassFace(nid)) {
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
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz + 1 - oz;
          const gv = gVC, pi = gVC * 3;
          
          gPos[pi] = x; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x + w; gPos[pi+4] = y; gPos[pi+5] = z;
          gPos[pi+6] = x + w; gPos[pi+7] = y + h; gPos[pi+8] = z;
          gPos[pi+9] = x; gPos[pi+10] = y + h; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_SOUTH) : 0;
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = 1;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_SOUTH];
          }
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
    
    // Glass Face 5: Back (-Z)
    for (let lz = 0; lz < S; lz++) {
      mask.fill(0);
      let hasFaces = false;
      
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const bid = section[idx] & BLOCK_ID_MASK;
          if (bid === 0 || !isGlass[bid]) continue;
          
          let nid = 0;
          if (lz > 0) {
            nid = section[idx - S] & BLOCK_ID_MASK;
          } else if (secBack) {
            nid = secBack[ly * S2 + 15 * S + lx] & BLOCK_ID_MASK;
          }
          
          if (!blocksGlassFace(nid)) {
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
          
          if (!ensureCapacity('g', 1)) continue;
          
          const x = baseX + ii - ox;
          const y = baseY + jj - oy;
          const z = baseZ + lz - oz;
          const gv = gVC, pi = gVC * 3;
          
          gPos[pi] = x + w; gPos[pi+1] = y; gPos[pi+2] = z;
          gPos[pi+3] = x; gPos[pi+4] = y; gPos[pi+5] = z;
          gPos[pi+6] = x; gPos[pi+7] = y + h; gPos[pi+8] = z;
          gPos[pi+9] = x + w; gPos[pi+10] = y + h; gPos[pi+11] = z;
          
          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = textureIndexLookup ? textureIndexLookup.getIndex(bid, FACE_NORTH) : 0;
          for (let v = 0; v < 4; v++) {
            gNorm[pi + v*3] = 0; gNorm[pi + v*3 + 1] = 0; gNorm[pi + v*3 + 2] = -1;
            gCol[pi + v*3] = r; gCol[pi + v*3 + 1] = g; gCol[pi + v*3 + 2] = b;
            gTexIdx[gVC + v] = texIdx;
            gTexRot[gVC + v] = 0;
            gTintType[gVC + v] = faceTintTypeLookup[bid * 6 + FACE_NORTH];
          }
          gVC += 4;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 1; gIdx[gIC++] = gv + 2;
          gIdx[gIC++] = gv; gIdx[gIC++] = gv + 2; gIdx[gIC++] = gv + 3;
        }
      }
    }
  }
  
  // Trim and return
  const trimMesh = (pos, norm, col, idx, vc, ic, texIdx = null, texRot = null, tintType = null) => {
    if (vc === 0) return null;
    const result = {
      positions: pos.subarray(0, vc * 3),
      normals: norm.subarray(0, vc * 3),
      colors: col.subarray(0, vc * 3),
      indices: idx.subarray(0, ic),
      vertexCount: vc,
      triangleCount: ic / 3,
    };
    if (texIdx) {
      result.texIndices = texIdx.subarray(0, vc);
    }
    if (texRot) {
      result.texRotations = texRot.subarray(0, vc);
    }
    if (tintType) {
      result.tintTypes = tintType.subarray(0, vc);
    }
    return result;
  };
  
  return {
    solid: trimMesh(sPos, sNorm, sCol, sIdx, sVC, sIC, sTexIdx, sTexRot, sTintType),
    water: trimMesh(wPos, wNorm, wCol, wIdx, wVC, wIC),
    lava: trimMesh(lPos, lNorm, lCol, lIdx, lVC, lIC),
    glass: trimMesh(gPos, gNorm, gCol, gIdx, gVC, gIC, gTexIdx, gTexRot, gTintType),
  };
}

export default buildGridMeshes;
