/**
 * MultipartMesher - Worker-compatible multipart block meshing
 * 
 * Calls the existing ModelMesher with multipartOnly=true to handle:
 * - Fences, walls, glass panes, iron bars
 * - Redstone wire, tripwire
 * - Vines, glow lichen, fire
 * - Chorus plant, bamboo, mushroom blocks, brewing stand
 * 
 * This runs in the worker thread, eliminating main thread meshing.
 */

import { buildModelMeshesWithInstancing, isMultipartBlock } from '../ModelMesher.js';

/**
 * Build meshes for multipart blocks only
 * 
 * @param {WorkerBinaryGrid} grid - Block data grid
 * @param {WorkerBlockStateGrid} stateGrid - State grid
 * @param {WorkerBlockRegistry} blockRegistry - Block registry
 * @param {WorkerStateRegistry} stateRegistry - State registry with geometry
 * @param {Object} offset - World offset {x, y, z}
 * @param {Object} options - Meshing options
 * @param {Object} options.textureIndexLookup - Texture atlas lookup
 * @param {Object} options.lightGrid - Light grid for per-vertex lighting
 * @param {Object} options.bounds - Chunk bounds to mesh
 * @param {Object} options.tintTypeLookup - Biome tinting lookup
 * @returns {Object|null} Mesh data with opaque, transparent, overlay, particleEmitters
 */
export function buildMultipartMeshes(grid, stateGrid, blockRegistry, stateRegistry, offset, options = {}) {
  const {
    textureIndexLookup = null,
    lightGrid = null,
    bounds = null,
    tintTypeLookup = null,
  } = options;

  // Check if state registry has any geometry (required for meshing)
  if (!stateRegistry || !stateRegistry.states || stateRegistry.states.length === 0) {
    return null;
  }

  // Build mesher options - multipartOnly=true to only mesh multipart blocks
  // V3 WASM handles non-multipart blocks (stairs, slabs, etc.)
  const mesherOptions = {
    textureIndexLookup,
    lightGrid,
    bounds,
    multipartOnly: true,
    collectEmitters: true,
  };

  try {
    const result = buildModelMeshesWithInstancing(
      grid,
      stateGrid,
      blockRegistry,
      stateRegistry,
      offset,
      mesherOptions
    );

    if (!result) return null;

    // Convert to format expected by worker (with vertexCount)
    const output = {};

    // Opaque mesh
    if (result.opaque && result.positions && result.positions.length > 0) {
      output.opaque = {
        positions: result.positions,
        normals: result.normals,
        uvs: result.modelUVs,
        colors: result.colors,
        texIndices: result.texIndices,
        tintTypes: result.tintTypes,
        skyLight: result.skyLight,
        blockLight: result.blockLight,
        shadeFlags: result.shadeFlags,
        indices: result.indices,
        vertexCount: result.positions.length / 3,
      };
    }

    // Transparent mesh (glass panes, iron bars)
    if (result.transparent && result.transparent.positions && result.transparent.positions.length > 0) {
      output.transparent = {
        positions: result.transparent.positions,
        normals: result.transparent.normals,
        uvs: result.transparent.modelUVs,
        colors: result.transparent.colors,
        texIndices: result.transparent.texIndices,
        tintTypes: result.transparent.tintTypes,
        skyLight: result.transparent.skyLight,
        blockLight: result.transparent.blockLight,
        shadeFlags: result.transparent.shadeFlags,
        indices: result.transparent.indices,
        vertexCount: result.transparent.positions.length / 3,
      };
    }

    // Overlay mesh (torch glow panels)
    if (result.overlay && result.overlay.positions && result.overlay.positions.length > 0) {
      output.overlay = {
        positions: result.overlay.positions,
        normals: result.overlay.normals,
        uvs: result.overlay.modelUVs,
        colors: result.overlay.colors,
        texIndices: result.overlay.texIndices,
        tintTypes: result.overlay.tintTypes,
        skyLight: result.overlay.skyLight,
        blockLight: result.overlay.blockLight,
        shadeFlags: result.overlay.shadeFlags,
        indices: result.overlay.indices,
        vertexCount: result.overlay.positions.length / 3,
      };
    }

    // Particle emitters
    if (result.particleEmitters && result.particleEmitters.length > 0) {
      output.particleEmitters = result.particleEmitters;
    }

    return output;
  } catch (err) {
    console.warn('[MultipartMesher] Error building multipart meshes:', err.message);
    return null;
  }
}

/**
 * Combine V3 model meshes with multipart meshes
 * Merges typed arrays from both sources into single mesh data
 * 
 * @param {Object} v3Meshes - Meshes from WASM V3 mesher
 * @param {Object} multipartMeshes - Meshes from JS multipart mesher
 * @returns {Object} Combined meshes
 */
export function combineMeshes(v3Meshes, multipartMeshes) {
  const result = {
    modelOpaque: null,
    modelTransparent: null,
    modelTranslucent: null,
    modelOverlay: null,
    particleEmitters: [],
  };

  // Combine opaque meshes
  const opaqueA = v3Meshes?.modelOpaque;
  const opaqueB = multipartMeshes?.opaque;
  result.modelOpaque = mergeMeshData(opaqueA, opaqueB);

  // Combine transparent meshes
  const transA = v3Meshes?.modelTransparent;
  const transB = multipartMeshes?.transparent;
  result.modelTransparent = mergeMeshData(transA, transB);

  // Translucent meshes (slime, honey) - only from V3, multipart doesn't have these
  if (v3Meshes?.modelTranslucent && v3Meshes.modelTranslucent.vertexCount > 0) {
    result.modelTranslucent = v3Meshes.modelTranslucent;
  }

  // Combine overlay meshes
  const overlayA = v3Meshes?.modelOverlay;
  const overlayB = multipartMeshes?.overlay;
  result.modelOverlay = mergeMeshData(overlayA, overlayB);

  // Combine particle emitters
  if (multipartMeshes?.particleEmitters) {
    result.particleEmitters = multipartMeshes.particleEmitters;
  }

  return result;
}

/**
 * Merge two mesh data objects into one
 * @param {Object|null} a - First mesh data (or null)
 * @param {Object|null} b - Second mesh data (or null)
 * @returns {Object|null} Merged mesh data
 */
function mergeMeshData(a, b) {
  // If one is null/empty, return the other
  if (!a || !a.vertexCount || a.vertexCount === 0) {
    return b && b.vertexCount > 0 ? b : null;
  }
  if (!b || !b.vertexCount || b.vertexCount === 0) {
    return a;
  }

  // Both have data - merge them
  const totalVerts = a.vertexCount + b.vertexCount;
  const totalIndicesA = a.indices ? a.indices.length : 0;
  const totalIndicesB = b.indices ? b.indices.length : 0;

  // Merge positions
  const positions = new Float32Array(totalVerts * 3);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);

  // Merge normals
  const normals = new Float32Array(totalVerts * 3);
  normals.set(a.normals);
  normals.set(b.normals, a.normals.length);

  // Merge UVs
  const uvs = new Float32Array(totalVerts * 2);
  uvs.set(a.uvs);
  uvs.set(b.uvs, a.uvs.length);

  // Merge colors
  const colors = new Float32Array(totalVerts * 3);
  colors.set(a.colors);
  colors.set(b.colors, a.colors.length);

  // Merge texIndices
  const texIndices = new Float32Array(totalVerts);
  texIndices.set(a.texIndices);
  texIndices.set(b.texIndices, a.texIndices.length);

  // Merge tintTypes
  const tintTypes = new Float32Array(totalVerts);
  tintTypes.set(a.tintTypes);
  tintTypes.set(b.tintTypes, a.tintTypes.length);

  // Merge skyLight
  const skyLight = new Float32Array(totalVerts);
  skyLight.set(a.skyLight);
  skyLight.set(b.skyLight, a.skyLight.length);

  // Merge blockLight
  const blockLight = new Float32Array(totalVerts);
  blockLight.set(a.blockLight);
  blockLight.set(b.blockLight, a.blockLight.length);

  // Merge shadeFlags
  const shadeFlags = new Float32Array(totalVerts);
  shadeFlags.set(a.shadeFlags);
  shadeFlags.set(b.shadeFlags, a.shadeFlags.length);

  // Merge indices (offset B's indices by A's vertex count)
  const indices = new Uint32Array(totalIndicesA + totalIndicesB);
  indices.set(a.indices);
  for (let i = 0; i < totalIndicesB; i++) {
    indices[totalIndicesA + i] = b.indices[i] + a.vertexCount;
  }

  return {
    positions,
    normals,
    uvs,
    colors,
    texIndices,
    tintTypes,
    skyLight,
    blockLight,
    shadeFlags,
    indices,
    vertexCount: totalVerts,
  };
}

// Re-export isMultipartBlock for use elsewhere
export { isMultipartBlock };
