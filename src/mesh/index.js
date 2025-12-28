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
 * - Unified worker pipeline for streaming hundreds of regions
 * - Water/Lava render at 50% opacity (extensible to other blocks)
 * 
 * Performance Target: 3 seconds per region for full pipeline
 * 
 * Future-Ready:
 * - Color system designed for easy texture atlas migration
 * - Block IDs map to colors which can later map to UV coordinates
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

// Streaming (new - efficient loading for hundreds of regions)
export { StreamingRegionLoader, createStreamingLoader } from './StreamingRegionLoader.js';

// Default export
export { RegionMeshBuilder as default } from './RegionMeshBuilder.js';
