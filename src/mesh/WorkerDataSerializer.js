/**
 * WorkerDataSerializer - Serializes registry and lookup data for worker threads
 * 
 * Collects all the data needed to initialize MeshWorker instances:
 * - BlockRegistry export (block ID to info mapping)
 * - TextureIndexLookup indices array
 * - Biome tint type lookup array
 * - Random rotation lookup arrays
 * - Rotatable block lookup
 * - Side overlay data
 * 
 * This module centralizes the serialization logic so workers can be initialized
 * with a single data object containing everything needed for meshing.
 */

import { getBlockRegistry } from './BlockRegistry.js';
import { buildFaceTintTypeLookup } from '../data/biomeTinting.js';
import { getRandomRotationRegistry } from '../assets/RandomRotationRegistry.js';
import { isRotatableBlock, getBlockSideOverlay } from '../assets/BlockTextureRegistry.js';

/**
 * Build the complete initialization data for mesh workers
 * 
 * @param {Object} options - Options
 * @param {TextureIndexLookup} options.textureIndexLookup - Texture lookup instance
 * @param {BlockRegistry} options.registry - Block registry (defaults to global)
 * @returns {Object} Serialized data for worker initialization
 */
export function buildWorkerInitData(options = {}) {
  const { textureIndexLookup = null, registry = null } = options;
  
  const blockRegistry = registry || getBlockRegistry();
  const randomRotationRegistry = getRandomRotationRegistry();
  
  // Export BlockRegistry data
  const registryData = blockRegistry.export();
  
  // Get texture indices if available
  let textureIndices = null;
  let atlasInfo = null;
  let texturePathToIndex = null;
  
  if (textureIndexLookup) {
    textureIndices = textureIndexLookup.getIndicesArray();
    atlasInfo = textureIndexLookup.getAtlasInfo();
    
    // Convert path mapping to plain object for serialization
    if (textureIndexLookup.texturePathToIndex) {
      texturePathToIndex = Object.fromEntries(textureIndexLookup.texturePathToIndex);
    }
  }
  
  // Build face tint type lookup
  const faceTintTypeLookup = buildFaceTintTypeLookup(blockRegistry);
  
  // Build random rotation lookups
  const hasRandomRotation = randomRotationRegistry.buildLookupArray(blockRegistry);
  const isTopOnlyRotation = randomRotationRegistry.buildTopOnlyLookupArray(blockRegistry);
  const isHalfRotation = buildHalfRotationLookup(blockRegistry, randomRotationRegistry);
  
  // Build rotatable block lookup
  const rotatableData = buildRotatableLookup(blockRegistry);
  
  // Build side overlay data
  const sideOverlayData = buildSideOverlayLookup(blockRegistry, textureIndexLookup);
  
  return {
    registryData,
    textureIndices: textureIndices ? textureIndices.buffer.slice(0) : null,
    atlasInfo,
    texturePathToIndex,
    faceTintTypeLookup: faceTintTypeLookup.buffer.slice(0),
    randomRotationData: {
      hasRandomRotation: hasRandomRotation.buffer.slice(0),
      isTopOnlyRotation: isTopOnlyRotation.buffer.slice(0),
      isHalfRotation: isHalfRotation.buffer.slice(0),
    },
    rotatableData: rotatableData.buffer.slice(0),
    sideOverlayData: {
      needsSideOverlay: sideOverlayData.needsSideOverlay.buffer.slice(0),
      sideOverlayTexIdx: sideOverlayData.sideOverlayTexIdx.buffer.slice(0),
    },
  };
}

/**
 * Build half-rotation lookup (blocks that only use 0° and 180°)
 */
function buildHalfRotationLookup(registry, randomRotationRegistry) {
  const maxId = registry.idToInfo.length || 4096;
  const lookup = new Uint8Array(maxId);
  
  for (let id = 0; id < maxId; id++) {
    const info = registry.getBlockInfo(id);
    if (info && info.name && randomRotationRegistry.isHalfRotation(info.name)) {
      lookup[id] = 1;
    }
  }
  
  return lookup;
}

/**
 * Build rotatable block lookup (logs, pillars, etc.)
 */
function buildRotatableLookup(registry) {
  const maxId = registry.idToInfo.length || 4096;
  const lookup = new Uint8Array(maxId);
  
  for (let id = 0; id < maxId; id++) {
    const info = registry.getBlockInfo(id);
    if (info && info.name) {
      const name = info.name.replace('minecraft:', '');
      if (isRotatableBlock(name)) {
        lookup[id] = 1;
      }
    }
  }
  
  return lookup;
}

/**
 * Build side overlay lookup (for blocks like grass_block)
 */
function buildSideOverlayLookup(registry, textureIndexLookup) {
  const maxId = registry.idToInfo.length || 4096;
  const needsSideOverlay = new Uint8Array(maxId);
  const sideOverlayTexIdx = new Float32Array(maxId);
  
  for (let id = 0; id < maxId; id++) {
    const info = registry.getBlockInfo(id);
    if (info && info.name) {
      const name = info.name.replace('minecraft:', '');
      const overlayPath = getBlockSideOverlay(name);
      
      if (overlayPath && textureIndexLookup) {
        needsSideOverlay[id] = 1;
        sideOverlayTexIdx[id] = textureIndexLookup.getIndexByPath(overlayPath);
      }
    }
  }
  
  return { needsSideOverlay, sideOverlayTexIdx };
}

/**
 * Get the list of transferable ArrayBuffers from the init data
 * Use these for zero-copy transfer to workers
 */
export function getTransferables(initData) {
  const transferables = [];
  
  if (initData.textureIndices) {
    transferables.push(initData.textureIndices);
  }
  if (initData.faceTintTypeLookup) {
    transferables.push(initData.faceTintTypeLookup);
  }
  if (initData.randomRotationData) {
    if (initData.randomRotationData.hasRandomRotation) {
      transferables.push(initData.randomRotationData.hasRandomRotation);
    }
    if (initData.randomRotationData.isTopOnlyRotation) {
      transferables.push(initData.randomRotationData.isTopOnlyRotation);
    }
    if (initData.randomRotationData.isHalfRotation) {
      transferables.push(initData.randomRotationData.isHalfRotation);
    }
  }
  if (initData.rotatableData) {
    transferables.push(initData.rotatableData);
  }
  if (initData.sideOverlayData) {
    if (initData.sideOverlayData.needsSideOverlay) {
      transferables.push(initData.sideOverlayData.needsSideOverlay);
    }
    if (initData.sideOverlayData.sideOverlayTexIdx) {
      transferables.push(initData.sideOverlayData.sideOverlayTexIdx);
    }
  }
  
  return transferables;
}

export default { buildWorkerInitData, getTransferables };



