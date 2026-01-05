/**
 * MeshWorker - Web Worker for chunk mesh generation
 * 
 * Runs FastMesher and ModelMesher in a worker thread to avoid blocking the main thread.
 * Receives serialized registry data on initialization and chunk data for meshing.
 * Returns transferable ArrayBuffers with mesh data.
 * 
 * Message protocol:
 * - { type: 'init', data: { registryData, textureIndices, atlasInfo } }
 * - { type: 'mesh', data: { jobId, gridData, stateGridData, lightGridData, offset, options } }
 * - { type: 'result', data: { jobId, meshes, transferables } }
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const SECTION_SIZE = 16;
const SECTION_VOLUME = 4096;
const BLOCK_ID_MASK = 0x0FFF;
const LEVEL_MASK = 0xF000;
const LEVEL_SHIFT = 12;
const SLAB_MASK = 0xC000;
const SLAB_SHIFT = 14;
const SLAB_NONE = 0;
const SLAB_BOTTOM = 1;
const SLAB_TOP = 2;
const SLAB_DOUBLE = 3;
const MIN_Y = -64;
const AXIS_Y = 0;
const AXIS_X = 1;
const AXIS_Z = 2;
const AXIS_SHIFT = 12;
const AXIS_MASK = 0x3000;

// Face direction constants
const FACE_UP = 0;
const FACE_DOWN = 1;
const FACE_NORTH = 2;
const FACE_SOUTH = 3;
const FACE_EAST = 4;
const FACE_WEST = 5;

// ============================================================================
// WORKER STATE
// ============================================================================

let isInitialized = false;
let registryData = null;
let textureIndices = null;
let atlasInfo = null;
let texturePathToIndex = null;

// Block lookup arrays (populated from registry)
let isOpaque = null;
let isNonCube = null;
let isSlab = null;
let isFluid = null;
let isGlass = null;
let isRotatable = null;
let hasRandomRotation = null;
let isTopOnlyRotation = null;
let isHalfRotation = null;
let isAOTransparent = null;
let needsSideOverlay = null;
let sideOverlayTexIdx = null;
let colorR = null;
let colorG = null;
let colorB = null;
let faceTintTypeLookup = null;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function makeSectionKey(chunkX, chunkZ, sectionY) {
  return `${chunkX},${chunkZ},${sectionY}`;
}

function parseSectionKey(key) {
  const parts = key.split(',');
  return {
    chunkX: parseInt(parts[0], 10),
    chunkZ: parseInt(parts[1], 10),
    sectionY: parseInt(parts[2], 10),
  };
}

function worldYToSection(worldY) {
  return Math.floor((worldY - MIN_Y) / SECTION_SIZE);
}

function sectionToWorldY(sectionIndex) {
  return sectionIndex * SECTION_SIZE + MIN_Y;
}

function blockIndexInSection(localX, localY, localZ) {
  return localY * SECTION_SIZE * SECTION_SIZE + localZ * SECTION_SIZE + localX;
}

// ============================================================================
// GRID CLASSES (Worker-compatible versions)
// ============================================================================

class WorkerBinaryGrid {
  constructor() {
    this.sections = new Map();
  }

  getSection(chunkX, chunkZ, sectionY) {
    const key = makeSectionKey(chunkX, chunkZ, sectionY);
    return this.sections.get(key);
  }

  getBlockId(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);

    const section = this.getSection(chunkX, chunkZ, sectionY);
    if (!section) return 0;

    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;

    const index = blockIndexInSection(localX, localY, localZ);
    return section[index] & BLOCK_ID_MASK;
  }

  static fromExport(data) {
    const grid = new WorkerBinaryGrid();
    for (const { key, data: buffer } of data.sections) {
      grid.sections.set(key, new Uint16Array(buffer));
    }
    return grid;
  }
}

class WorkerLightGrid {
  constructor() {
    this.sections = new Map();
  }

  getSection(chunkX, chunkZ, sectionY) {
    const key = makeSectionKey(chunkX, chunkZ, sectionY);
    return this.sections.get(key);
  }

  getSectionByKey(key) {
    return this.sections.get(key);
  }

  getLight(worldX, worldY, worldZ) {
    const chunkX = Math.floor(worldX / SECTION_SIZE);
    const chunkZ = Math.floor(worldZ / SECTION_SIZE);
    const sectionY = worldYToSection(worldY);

    const section = this.getSection(chunkX, chunkZ, sectionY);
    if (!section) return { skyLight: 15, blockLight: 0 };

    const localX = ((worldX % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
    const localY = ((worldY - MIN_Y) % SECTION_SIZE + SECTION_SIZE) % SECTION_SIZE;
    const localZ = ((worldZ % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;

    const index = blockIndexInSection(localX, localY, localZ);
    const value = section[index];
    return {
      skyLight: value & 0x0F,
      blockLight: (value >> 4) & 0x0F,
    };
  }

  static fromExport(data) {
    if (!data) return null;
    const grid = new WorkerLightGrid();
    for (const { key, data: buffer } of data.sections) {
      grid.sections.set(key, new Uint8Array(buffer));
    }
    return grid;
  }
}

class WorkerBlockStateGrid {
  constructor() {
    this.sections = new Map();
    this.hasStates = new Set();
  }

  getSection(sectionKey) {
    return this.sections.get(sectionKey) || null;
  }

  sectionHasStates(sectionKey) {
    return this.hasStates.has(sectionKey);
  }

  static fromExport(data) {
    if (!data) return null;
    const grid = new WorkerBlockStateGrid();
    for (const { key, data: buffer } of data.sections) {
      grid.sections.set(key, new Uint16Array(buffer));
      grid.hasStates.add(key);
    }
    return grid;
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeWorker(data) {
  registryData = data.registryData;
  textureIndices = data.textureIndices ? new Float32Array(data.textureIndices) : null;
  atlasInfo = data.atlasInfo;
  texturePathToIndex = data.texturePathToIndex ? new Map(Object.entries(data.texturePathToIndex)) : null;

  // Build lookup tables from registry data
  const maxId = 4096;
  isOpaque = new Uint8Array(maxId);
  isNonCube = new Uint8Array(maxId);
  isSlab = new Uint8Array(maxId);
  isFluid = new Uint8Array(maxId);
  isGlass = new Uint8Array(maxId);
  isRotatable = new Uint8Array(maxId);
  hasRandomRotation = new Uint8Array(maxId);
  isTopOnlyRotation = new Uint8Array(maxId);
  isHalfRotation = new Uint8Array(maxId);
  isAOTransparent = new Uint8Array(maxId);
  needsSideOverlay = new Uint8Array(maxId);
  sideOverlayTexIdx = new Float32Array(maxId);
  colorR = new Float32Array(maxId);
  colorG = new Float32Array(maxId);
  colorB = new Float32Array(maxId);
  faceTintTypeLookup = new Uint8Array(maxId * 6);

  // Populate from registry data
  if (registryData && registryData.idToInfo) {
    for (const info of registryData.idToInfo) {
      if (!info) continue;
      const id = info.id;

      colorR[id] = info.colorR;
      colorG[id] = info.colorG;
      colorB[id] = info.colorB;
      isOpaque[id] = info.isOpaque ? 1 : 0;

      if (info.name) {
        const name = info.name.replace('minecraft:', '');
        if (name.includes('water')) isFluid[id] = 1;
        else if (name.includes('lava')) isFluid[id] = 2;

        if ((name.includes('glass') && !name.includes('_pane')) ||
            name.includes('ice') || name.includes('leaves')) {
          isGlass[id] = 1;
        }

        if (name.includes('_slab')) {
          isSlab[id] = 1;
        }

        // AO-transparent blocks
        if (name.includes('glass') || name.includes('ice') ||
            name.includes('leaves') || name.includes('slime') ||
            name.includes('honey') || name.includes('water') ||
            name.includes('lava') || name.includes('barrier') ||
            name.includes('light') || info.category === 'custom') {
          isAOTransparent[id] = 1;
        }

        // Non-cube detection
        if (info.category === 'custom') {
          isNonCube[id] = 1;
        }
      }
    }
  }

  // Import tint type lookup if provided
  if (data.faceTintTypeLookup) {
    faceTintTypeLookup.set(new Uint8Array(data.faceTintTypeLookup));
  }

  // Import random rotation data if provided
  if (data.randomRotationData) {
    const rd = data.randomRotationData;
    if (rd.hasRandomRotation) hasRandomRotation.set(new Uint8Array(rd.hasRandomRotation));
    if (rd.isTopOnlyRotation) isTopOnlyRotation.set(new Uint8Array(rd.isTopOnlyRotation));
    if (rd.isHalfRotation) isHalfRotation.set(new Uint8Array(rd.isHalfRotation));
  }

  // Import rotatable and side overlay data if provided
  if (data.rotatableData) {
    isRotatable.set(new Uint8Array(data.rotatableData));
  }
  if (data.sideOverlayData) {
    needsSideOverlay.set(new Uint8Array(data.sideOverlayData.needsSideOverlay));
    sideOverlayTexIdx.set(new Float32Array(data.sideOverlayData.sideOverlayTexIdx));
  }

  isInitialized = true;
}

// ============================================================================
// TEXTURE INDEX LOOKUP (Worker version)
// ============================================================================

function getTextureIndex(blockId, faceIndex) {
  if (!textureIndices || blockId < 0 || blockId >= 4096 || faceIndex < 0 || faceIndex > 5) {
    return 0;
  }
  return textureIndices[blockId * 6 + faceIndex];
}

function getTextureIndexByPath(texturePath) {
  if (!texturePathToIndex || !texturePath) return 0;
  const normalized = texturePath.replace('minecraft:', '');
  return texturePathToIndex.get(normalized) || texturePathToIndex.get(`block/${normalized}`) || 0;
}

// ============================================================================
// FAST MESHER (Worker version - simplified for solid blocks)
// ============================================================================

function buildSolidMesh(grid, lightGrid, offset, options = {}) {
  const S = 16, S2 = 256, S3 = 4096;
  const ox = offset.x, oy = offset.y, oz = offset.z;

  // Initial buffer sizes
  const INITIAL_SIZE = 100000;
  let sPos = new Float32Array(INITIAL_SIZE * 12);
  let sNorm = new Float32Array(INITIAL_SIZE * 12);
  let sCol = new Float32Array(INITIAL_SIZE * 12);
  let sTexIdx = new Float32Array(INITIAL_SIZE * 4);
  let sTexRot = new Float32Array(INITIAL_SIZE * 4);
  let sTintType = new Float32Array(INITIAL_SIZE * 4);
  let sSkyLight = new Float32Array(INITIAL_SIZE * 4);
  let sBlockLight = new Float32Array(INITIAL_SIZE * 4);
  let sIdx = new Uint32Array(INITIAL_SIZE * 6);
  let sVC = 0, sIC = 0;
  let sCapacity = INITIAL_SIZE;

  // Glass mesh arrays
  let gPos = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gNorm = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gCol = new Float32Array(INITIAL_SIZE * 0.2 * 12);
  let gTexIdx = new Float32Array(INITIAL_SIZE * 0.2 * 4);
  let gTexRot = new Float32Array(INITIAL_SIZE * 0.2 * 4);
  let gTintType = new Float32Array(INITIAL_SIZE * 0.2 * 4);
  let gSkyLight = new Float32Array(INITIAL_SIZE * 0.2 * 4);
  let gBlockLight = new Float32Array(INITIAL_SIZE * 0.2 * 4);
  let gIdx = new Uint32Array(INITIAL_SIZE * 0.2 * 6);
  let gVC = 0, gIC = 0;
  let gCapacity = Math.floor(INITIAL_SIZE * 0.2);

  // Helper functions
  function growArrays(type) {
    if (type === 's') {
      const newCap = Math.floor(sCapacity * 1.5);
      const newPos = new Float32Array(newCap * 12);
      const newNorm = new Float32Array(newCap * 12);
      const newCol = new Float32Array(newCap * 12);
      const newTexIdx = new Float32Array(newCap * 4);
      const newTexRot = new Float32Array(newCap * 4);
      const newTintType = new Float32Array(newCap * 4);
      const newSkyLight = new Float32Array(newCap * 4);
      const newBlockLight = new Float32Array(newCap * 4);
      const newIdx = new Uint32Array(newCap * 6);
      newPos.set(sPos.subarray(0, sVC * 3));
      newNorm.set(sNorm.subarray(0, sVC * 3));
      newCol.set(sCol.subarray(0, sVC * 3));
      newTexIdx.set(sTexIdx.subarray(0, sVC));
      newTexRot.set(sTexRot.subarray(0, sVC));
      newTintType.set(sTintType.subarray(0, sVC));
      newSkyLight.set(sSkyLight.subarray(0, sVC));
      newBlockLight.set(sBlockLight.subarray(0, sVC));
      newIdx.set(sIdx.subarray(0, sIC));
      sPos = newPos; sNorm = newNorm; sCol = newCol;
      sTexIdx = newTexIdx; sTexRot = newTexRot; sTintType = newTintType;
      sSkyLight = newSkyLight; sBlockLight = newBlockLight; sIdx = newIdx;
      sCapacity = newCap;
    } else if (type === 'g') {
      const newCap = Math.floor(gCapacity * 1.5);
      const newPos = new Float32Array(newCap * 12);
      const newNorm = new Float32Array(newCap * 12);
      const newCol = new Float32Array(newCap * 12);
      const newTexIdx = new Float32Array(newCap * 4);
      const newTexRot = new Float32Array(newCap * 4);
      const newTintType = new Float32Array(newCap * 4);
      const newSkyLight = new Float32Array(newCap * 4);
      const newBlockLight = new Float32Array(newCap * 4);
      const newIdx = new Uint32Array(newCap * 6);
      newPos.set(gPos.subarray(0, gVC * 3));
      newNorm.set(gNorm.subarray(0, gVC * 3));
      newCol.set(gCol.subarray(0, gVC * 3));
      newTexIdx.set(gTexIdx.subarray(0, gVC));
      newTexRot.set(gTexRot.subarray(0, gVC));
      newTintType.set(gTintType.subarray(0, gVC));
      newSkyLight.set(gSkyLight.subarray(0, gVC));
      newBlockLight.set(gBlockLight.subarray(0, gVC));
      newIdx.set(gIdx.subarray(0, gIC));
      gPos = newPos; gNorm = newNorm; gCol = newCol;
      gTexIdx = newTexIdx; gTexRot = newTexRot; gTintType = newTintType;
      gSkyLight = newSkyLight; gBlockLight = newBlockLight; gIdx = newIdx;
      gCapacity = newCap;
    }
  }

  function ensureCapacity(type, neededQuads) {
    if (type === 's' && sVC / 4 + neededQuads > sCapacity) { growArrays('s'); return true; }
    if (type === 'g' && gVC / 4 + neededQuads > gCapacity) { growArrays('g'); return true; }
    return true;
  }

  function isFullCube(value) {
    const bid = value & BLOCK_ID_MASK;
    if (bid === 0) return false;
    if (!isOpaque[bid]) return false;
    if (isSlab[bid]) {
      const slabType = (value & SLAB_MASK) >> SLAB_SHIFT;
      return slabType === SLAB_DOUBLE;
    }
    if (isNonCube[bid]) return false;
    return true;
  }

  function neighborBlocksFace(nValue) {
    const nid = nValue & BLOCK_ID_MASK;
    if (nid === 0) return false;
    if (!isOpaque[nid]) return false;
    if (isSlab[nid]) {
      const slabType = (nValue & SLAB_MASK) >> SLAB_SHIFT;
      return slabType === SLAB_DOUBLE;
    }
    if (isNonCube[nid]) return false;
    return true;
  }

  // Sample smooth light
  function sampleSmoothLight(x, y, z, nx, ny, nz) {
    if (!lightGrid) return { skyLight: 15, blockLight: 0 };

    const isSolidForAO = (blockId) => {
      if (blockId === 0) return false;
      if (isAOTransparent[blockId]) return false;
      return isOpaque[blockId] === 1;
    };

    let solidCount = 0;
    let totalSky = 0;
    let totalBlock = 0;
    let airCount = 0;

    if (ny !== 0) {
      for (let dx = -1; dx <= 0; dx++) {
        for (let dz = -1; dz <= 0; dz++) {
          const blockId = grid.getBlockId(x + dx, y, z + dz);
          if (isSolidForAO(blockId)) {
            solidCount++;
          } else {
            const light = lightGrid.getLight(x + dx, y, z + dz);
            totalSky += light.skyLight;
            totalBlock += light.blockLight;
            airCount++;
          }
        }
      }
    } else if (nx !== 0) {
      for (let dy = -1; dy <= 0; dy++) {
        for (let dz = -1; dz <= 0; dz++) {
          const blockId = grid.getBlockId(x, y + dy, z + dz);
          if (isSolidForAO(blockId)) {
            solidCount++;
          } else {
            const light = lightGrid.getLight(x, y + dy, z + dz);
            totalSky += light.skyLight;
            totalBlock += light.blockLight;
            airCount++;
          }
        }
      }
    } else {
      for (let dx = -1; dx <= 0; dx++) {
        for (let dy = -1; dy <= 0; dy++) {
          const blockId = grid.getBlockId(x + dx, y + dy, z);
          if (isSolidForAO(blockId)) {
            solidCount++;
          } else {
            const light = lightGrid.getLight(x + dx, y + dy, z);
            totalSky += light.skyLight;
            totalBlock += light.blockLight;
            airCount++;
          }
        }
      }
    }

    const aoLevel = Math.max(0, 3 - solidCount);
    const aoBrightness = [0.5, 0.7, 0.85, 1.0];
    const ao = aoBrightness[aoLevel];

    let avgSky, avgBlock;
    if (airCount > 0) {
      avgSky = totalSky / airCount;
      avgBlock = totalBlock / airCount;
    } else {
      const light = lightGrid.getLight(x, y, z);
      avgSky = light.skyLight;
      avgBlock = light.blockLight;
    }

    return {
      skyLight: avgSky * ao,
      blockLight: avgBlock * ao,
    };
  }

  const mask = new Uint16Array(S2);
  const visited = new Uint8Array(S2);

  // Process each section
  for (const [key, section] of grid.sections) {
    const { chunkX: cx, chunkZ: cz, sectionY: sy } = parseSectionKey(key);
    const baseX = cx * S;
    const baseY = sectionToWorldY(sy);
    const baseZ = cz * S;

    // Count non-air blocks
    let nonAirCount = 0;
    for (let i = 0; i < S3; i++) {
      if (section[i] !== 0) nonAirCount++;
    }
    if (nonAirCount === 0) continue;

    // Get neighbor sections
    const secTop = grid.sections.get(makeSectionKey(cx, cz, sy + 1));
    const secBot = grid.sections.get(makeSectionKey(cx, cz, sy - 1));
    const secRight = grid.sections.get(makeSectionKey(cx + 1, cz, sy));
    const secLeft = grid.sections.get(makeSectionKey(cx - 1, cz, sy));
    const secFront = grid.sections.get(makeSectionKey(cx, cz + 1, sy));
    const secBack = grid.sections.get(makeSectionKey(cx, cz - 1, sy));

    // Process TOP face
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      const sliceBase = ly * S2;

      for (let j = 0; j < S2; j++) {
        const value = section[sliceBase + j];
        const bid = value & BLOCK_ID_MASK;
        if (!isFullCube(value)) continue;

        let nValue = 0;
        if (ly < 15) {
          nValue = section[sliceBase + S2 + j];
        } else if (secTop) {
          nValue = secTop[j];
        }

        if (!neighborBlocksFace(nValue)) {
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

          ensureCapacity('s', 1);

          const x = baseX + ii - ox;
          const y = baseY + ly + 1 - oy;
          const z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;

          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + h;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z + h;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;

          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = getTextureIndex(bid, FACE_UP);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_UP];

          // Sample light at corners
          const faceWorldX = baseX + ii;
          const faceWorldY = baseY + ly + 1;
          const faceWorldZ = baseZ + jj;

          let skyL0 = 15, skyL1 = 15, skyL2 = 15, skyL3 = 15;
          let blockL0 = 0, blockL1 = 0, blockL2 = 0, blockL3 = 0;

          if (lightGrid) {
            const l0 = sampleSmoothLight(faceWorldX, faceWorldY, faceWorldZ + h, 0, 1, 0);
            const l1 = sampleSmoothLight(faceWorldX + w, faceWorldY, faceWorldZ + h, 0, 1, 0);
            const l2 = sampleSmoothLight(faceWorldX + w, faceWorldY, faceWorldZ, 0, 1, 0);
            const l3 = sampleSmoothLight(faceWorldX, faceWorldY, faceWorldZ, 0, 1, 0);
            skyL0 = l0.skyLight; blockL0 = l0.blockLight;
            skyL1 = l1.skyLight; blockL1 = l1.blockLight;
            skyL2 = l2.skyLight; blockL2 = l2.blockLight;
            skyL3 = l3.skyLight; blockL3 = l3.blockLight;
          }

          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = 0;
            sTintType[sVC + v] = tintType;
          }
          sSkyLight[sVC] = skyL0; sSkyLight[sVC + 1] = skyL1;
          sSkyLight[sVC + 2] = skyL2; sSkyLight[sVC + 3] = skyL3;
          sBlockLight[sVC] = blockL0; sBlockLight[sVC + 1] = blockL1;
          sBlockLight[sVC + 2] = blockL2; sBlockLight[sVC + 3] = blockL3;

          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }

    // Process BOTTOM face
    for (let ly = 0; ly < S; ly++) {
      mask.fill(0);
      let hasFaces = false;
      const sliceBase = ly * S2;

      for (let j = 0; j < S2; j++) {
        const value = section[sliceBase + j];
        const bid = value & BLOCK_ID_MASK;
        if (!isFullCube(value)) continue;

        let nValue = 0;
        if (ly > 0) {
          nValue = section[sliceBase - S2 + j];
        } else if (secBot) {
          nValue = secBot[15 * S2 + j];
        }

        if (!neighborBlocksFace(nValue)) {
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

          ensureCapacity('s', 1);

          const x = baseX + ii - ox;
          const y = baseY + ly - oy;
          const z = baseZ + jj - oz;
          const sv = sVC, pi = sVC * 3;

          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + w; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + w; sPos[pi+7] = y; sPos[pi+8] = z + h;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + h;

          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = getTextureIndex(bid, FACE_DOWN);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_DOWN];

          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = -1; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = 0;
            sTintType[sVC + v] = tintType;
            sSkyLight[sVC + v] = 15;
            sBlockLight[sVC + v] = 0;
          }

          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }

    // Process side faces (simplified - emit each face individually)
    // EAST (+X)
    for (let lx = 0; lx < S; lx++) {
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          if (!isFullCube(value)) continue;

          let nValue = 0;
          if (lx < 15) {
            nValue = section[idx + 1];
          } else if (secRight) {
            nValue = secRight[ly * S2 + lz * S];
          }

          if (neighborBlocksFace(nValue)) continue;

          ensureCapacity('s', 1);

          const bid = value & BLOCK_ID_MASK;
          const x = baseX + lx + 1 - ox;
          const y = baseY + ly - oy;
          const z = baseZ + lz - oz;
          const sv = sVC, pi = sVC * 3;

          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y + 1; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + 1; sPos[pi+8] = z + 1;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z + 1;

          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = getTextureIndex(bid, FACE_EAST);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_EAST];

          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = 0;
            sTintType[sVC + v] = tintType;
            sSkyLight[sVC + v] = 15;
            sBlockLight[sVC + v] = 0;
          }

          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }

    // WEST (-X)
    for (let lx = 0; lx < S; lx++) {
      for (let ly = 0; ly < S; ly++) {
        for (let lz = 0; lz < S; lz++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          if (!isFullCube(value)) continue;

          let nValue = 0;
          if (lx > 0) {
            nValue = section[idx - 1];
          } else if (secLeft) {
            nValue = secLeft[ly * S2 + lz * S + 15];
          }

          if (neighborBlocksFace(nValue)) continue;

          ensureCapacity('s', 1);

          const bid = value & BLOCK_ID_MASK;
          const x = baseX + lx - ox;
          const y = baseY + ly - oy;
          const z = baseZ + lz - oz;
          const sv = sVC, pi = sVC * 3;

          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z + 1;
          sPos[pi+3] = x; sPos[pi+4] = y + 1; sPos[pi+5] = z + 1;
          sPos[pi+6] = x; sPos[pi+7] = y + 1; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y; sPos[pi+11] = z;

          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = getTextureIndex(bid, FACE_WEST);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_WEST];

          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = -1; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 0;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = 0;
            sTintType[sVC + v] = tintType;
            sSkyLight[sVC + v] = 15;
            sBlockLight[sVC + v] = 0;
          }

          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }

    // SOUTH (+Z)
    for (let lz = 0; lz < S; lz++) {
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          if (!isFullCube(value)) continue;

          let nValue = 0;
          if (lz < 15) {
            nValue = section[idx + S];
          } else if (secFront) {
            nValue = secFront[ly * S2 + lx];
          }

          if (neighborBlocksFace(nValue)) continue;

          ensureCapacity('s', 1);

          const bid = value & BLOCK_ID_MASK;
          const x = baseX + lx - ox;
          const y = baseY + ly - oy;
          const z = baseZ + lz + 1 - oz;
          const sv = sVC, pi = sVC * 3;

          sPos[pi] = x; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x + 1; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x + 1; sPos[pi+7] = y + 1; sPos[pi+8] = z;
          sPos[pi+9] = x; sPos[pi+10] = y + 1; sPos[pi+11] = z;

          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = getTextureIndex(bid, FACE_SOUTH);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_SOUTH];

          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = 1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = 0;
            sTintType[sVC + v] = tintType;
            sSkyLight[sVC + v] = 15;
            sBlockLight[sVC + v] = 0;
          }

          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }

    // NORTH (-Z)
    for (let lz = 0; lz < S; lz++) {
      for (let ly = 0; ly < S; ly++) {
        for (let lx = 0; lx < S; lx++) {
          const idx = ly * S2 + lz * S + lx;
          const value = section[idx];
          if (!isFullCube(value)) continue;

          let nValue = 0;
          if (lz > 0) {
            nValue = section[idx - S];
          } else if (secBack) {
            nValue = secBack[ly * S2 + 15 * S + lx];
          }

          if (neighborBlocksFace(nValue)) continue;

          ensureCapacity('s', 1);

          const bid = value & BLOCK_ID_MASK;
          const x = baseX + lx - ox;
          const y = baseY + ly - oy;
          const z = baseZ + lz - oz;
          const sv = sVC, pi = sVC * 3;

          sPos[pi] = x + 1; sPos[pi+1] = y; sPos[pi+2] = z;
          sPos[pi+3] = x; sPos[pi+4] = y; sPos[pi+5] = z;
          sPos[pi+6] = x; sPos[pi+7] = y + 1; sPos[pi+8] = z;
          sPos[pi+9] = x + 1; sPos[pi+10] = y + 1; sPos[pi+11] = z;

          const r = colorR[bid], g = colorG[bid], b = colorB[bid];
          const texIdx = getTextureIndex(bid, FACE_NORTH);
          const tintType = faceTintTypeLookup[bid * 6 + FACE_NORTH];

          for (let v = 0; v < 4; v++) {
            sNorm[pi + v*3] = 0; sNorm[pi + v*3 + 1] = 0; sNorm[pi + v*3 + 2] = -1;
            sCol[pi + v*3] = r; sCol[pi + v*3 + 1] = g; sCol[pi + v*3 + 2] = b;
            sTexIdx[sVC + v] = texIdx;
            sTexRot[sVC + v] = 0;
            sTintType[sVC + v] = tintType;
            sSkyLight[sVC + v] = 15;
            sBlockLight[sVC + v] = 0;
          }

          sVC += 4;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 1; sIdx[sIC++] = sv + 2;
          sIdx[sIC++] = sv; sIdx[sIC++] = sv + 2; sIdx[sIC++] = sv + 3;
        }
      }
    }
  }

  // Return trimmed arrays
  const solidMesh = sVC > 0 ? {
    positions: sPos.slice(0, sVC * 3).buffer,
    normals: sNorm.slice(0, sVC * 3).buffer,
    colors: sCol.slice(0, sVC * 3).buffer,
    texIndices: sTexIdx.slice(0, sVC).buffer,
    texRotations: sTexRot.slice(0, sVC).buffer,
    tintTypes: sTintType.slice(0, sVC).buffer,
    skyLight: sSkyLight.slice(0, sVC).buffer,
    blockLight: sBlockLight.slice(0, sVC).buffer,
    indices: sIdx.slice(0, sIC).buffer,
    vertexCount: sVC,
    triangleCount: sIC / 3,
  } : null;

  const glassMesh = gVC > 0 ? {
    positions: gPos.slice(0, gVC * 3).buffer,
    normals: gNorm.slice(0, gVC * 3).buffer,
    colors: gCol.slice(0, gVC * 3).buffer,
    texIndices: gTexIdx.slice(0, gVC).buffer,
    texRotations: gTexRot.slice(0, gVC).buffer,
    tintTypes: gTintType.slice(0, gVC).buffer,
    skyLight: gSkyLight.slice(0, gVC).buffer,
    blockLight: gBlockLight.slice(0, gVC).buffer,
    indices: gIdx.slice(0, gIC).buffer,
    vertexCount: gVC,
    triangleCount: gIC / 3,
  } : null;

  return { solid: solidMesh, glass: glassMesh };
}

// ============================================================================
// MESH JOB PROCESSING
// ============================================================================

function processMeshJob(data) {
  const { jobId, gridData, lightGridData, offset, options } = data;

  // Reconstruct grids from exported data
  const grid = WorkerBinaryGrid.fromExport(gridData);
  const lightGrid = lightGridData ? WorkerLightGrid.fromExport(lightGridData) : null;

  // Build meshes
  const meshes = buildSolidMesh(grid, lightGrid, offset, options);

  // Collect transferables
  const transferables = [];
  if (meshes.solid) {
    transferables.push(
      meshes.solid.positions,
      meshes.solid.normals,
      meshes.solid.colors,
      meshes.solid.texIndices,
      meshes.solid.texRotations,
      meshes.solid.tintTypes,
      meshes.solid.skyLight,
      meshes.solid.blockLight,
      meshes.solid.indices
    );
  }
  if (meshes.glass) {
    transferables.push(
      meshes.glass.positions,
      meshes.glass.normals,
      meshes.glass.colors,
      meshes.glass.texIndices,
      meshes.glass.texRotations,
      meshes.glass.tintTypes,
      meshes.glass.skyLight,
      meshes.glass.blockLight,
      meshes.glass.indices
    );
  }

  return { jobId, meshes, transferables };
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

self.onmessage = function(e) {
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      try {
        initializeWorker(data);
        self.postMessage({ type: 'ready' });
      } catch (error) {
        self.postMessage({ type: 'error', error: error.message });
      }
      break;

    case 'mesh':
      if (!isInitialized) {
        self.postMessage({
          type: 'error',
          error: 'Worker not initialized',
          jobId: data.jobId
        });
        return;
      }

      try {
        const result = processMeshJob(data);
        self.postMessage(
          { type: 'result', data: result },
          result.transferables
        );
      } catch (error) {
        self.postMessage({
          type: 'error',
          error: error.message,
          jobId: data.jobId
        });
      }
      break;

    default:
      console.warn('[MeshWorker] Unknown message type:', type);
  }
};

