/**
 * Mesh System - High-Performance Minecraft Region Rendering
 * 
 * This module provides a complete pipeline for loading and rendering
 * Minecraft region files (.mca) with extreme scalability.
 * 
 * Key Features:
 * - Binary voxel storage (no object allocation)
 * - Parallel chunk decoding and meshing
 * - Greedy meshing for solid blocks
 * - Height-aware fluid rendering
 * - Multi-region management
 * 
 * Usage:
 * ```javascript
 * import { RegionManager } from './mesh';
 * import { parseMCAFile } from './utils/mcaParser';
 * 
 * const manager = new RegionManager(scene);
 * const chunks = await parseMCAFile(file);
 * await manager.loadRegion(chunks, 0, 0);
 * ```
 */

// Core data structures
export { BlockRegistry, BlockCategory, getBlockRegistry, resetBlockRegistry } from './BlockRegistry.js';
export { BinaryGrid, SECTION_SIZE, MIN_Y, MAX_Y, worldYToSection, sectionToWorldY } from './BinaryGrid.js';

// Decoding
export { ChunkDecoder, decodeChunk, decodeRegion } from './ChunkDecoder.js';

// Meshing
export { BinaryGreedyMesher, buildSolidMesh } from './BinaryGreedyMesher.js';
export { FluidMesher, buildWaterMesh, buildLavaMesh } from './FluidMesher.js';
export { buildGridMeshes } from './FastMesher.js';
export { buildGridMeshesParallel } from './ParallelMesher.js';

// Pipeline
export { RegionMeshBuilder, buildRegionMeshes } from './RegionMeshBuilder.js';
export { RegionManager } from './RegionManager.js';

// Default export
export { RegionManager as default } from './RegionManager.js';

