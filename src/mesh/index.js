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
 */

// Core data structures
export { BlockRegistry, BlockCategory, getBlockRegistry, resetBlockRegistry } from './BlockRegistry.js';
export { BinaryGrid, SECTION_SIZE, MIN_Y, MAX_Y, worldYToSection, sectionToWorldY } from './BinaryGrid.js';

// Decoding
export { ChunkDecoder, decodeChunk, decodeRegion } from './ChunkDecoder.js';

// Meshing
export { buildGridMeshes } from './FastMesher.js';
export { buildGridMeshesParallel } from './ParallelMesher.js';

// Pipeline
export { RegionMeshBuilder, buildRegionMeshes } from './RegionMeshBuilder.js';

// Default export
export { RegionMeshBuilder as default } from './RegionMeshBuilder.js';
