# Streaming Binary Voxel Mesh Pipeline

A high-performance Minecraft region rendering system designed for extreme scalability.

## Goals

- **Load single region in <3 seconds** (millions of blocks)
- **Support 20+ concurrent regions** with minimal performance impact
- **Zero GC pressure** through binary data paths
- **Future-proof** for non-cube block meshes (stairs, slabs, fences)
- **Preserve fluid rendering** with height-aware water/lava

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         STREAMING MESH PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌─────────────────────────┐   │
│  │ Region File  │───▶│ Decode Worker    │───▶│ Binary Block Grid       │   │
│  │ (.mca)       │    │ Pool             │    │ (Uint16Array)           │   │
│  └──────────────┘    └──────────────────┘    └───────────┬─────────────┘   │
│                                                          │                  │
│                                              ┌───────────▼─────────────┐   │
│                                              │ Mesh Worker Pool        │   │
│                                              │ ┌─────────────────────┐ │   │
│                                              │ │ Binary Face Culling │ │   │
│                                              │ │ Greedy Meshing      │ │   │
│                                              │ │ Fluid Height Calc   │ │   │
│                                              │ └─────────────────────┘ │   │
│                                              └───────────┬─────────────┘   │
│                                                          │                  │
│                                              ┌───────────▼─────────────┐   │
│                                              │ Transferable Buffers    │   │
│                                              │ (Zero-copy to GPU)      │   │
│                                              └───────────┬─────────────┘   │
│                                                          │                  │
│  ┌───────────────────────────────────────────────────────▼─────────────┐   │
│  │                        THREE.JS SCENE                                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │   │
│  │  │ Solid Mesh  │  │ Water Mesh  │  │ Lava Mesh   │  │ Custom     │  │   │
│  │  │ (Greedy)    │  │ (Height)    │  │ (Height)    │  │ (Instanced)│  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. BlockRegistry (`BlockRegistry.js`)

Central registry mapping block names to numeric IDs and rendering properties.

```javascript
const registry = new BlockRegistry();

// Lookup by name
const blockId = registry.getBlockId('minecraft:stone'); // Returns numeric ID
const info = registry.getBlockInfo(blockId);
// { id: 5, name: 'minecraft:stone', category: 'solid', color: 0x808080, isOpaque: true }

// Categories determine meshing strategy:
// - 'solid': Greedy meshing (opaque cubes)
// - 'transparent': Greedy meshing (separate pass, non-opaque)
// - 'fluid': Height-aware fluid meshing
// - 'custom': Instanced rendering with pre-baked geometry (future)
```

### 2. BinaryGrid (`BinaryGrid.js`)

Compact binary representation of block data for a region.

```javascript
// Memory layout per block: 2 bytes (Uint16)
// Bits 0-11:  Block type ID (0-4095 unique block types)
// Bits 12-15: Fluid level (0-15) or block metadata

// Grid dimensions for a region:
// - 512 x 384 x 512 blocks (32 chunks × 16 blocks × 24 Y-sections)
// - Using sparse storage: only non-air chunks allocated

const grid = new BinaryGrid();
grid.setBlock(x, y, z, blockId, level);
const blockId = grid.getBlock(x, y, z);
const level = grid.getLevel(x, y, z);
```

### 3. ChunkDecoder (`ChunkDecoder.js`)

Decodes Minecraft NBT chunk data directly into binary grid format.

```javascript
// Worker-based parallel decoding
const decoder = new ChunkDecoder(workerCount);

// Decode all chunks from parsed MCA file
const grid = await decoder.decodeRegion(chunks, registry);
// Returns: BinaryGrid with all blocks populated
```

### 4. BinaryGreedyMesher (`BinaryGreedyMesher.js`)

Optimized greedy meshing operating directly on binary grid data.

Key optimizations:
- No object allocation in hot paths
- Typed array output (transferable)
- Parallel face processing per axis

```javascript
const mesher = new BinaryGreedyMesher(registry);

// Build mesh for a chunk column (16x384x16 blocks)
const result = mesher.buildChunkMesh(grid, chunkX, chunkZ, offset);
// Returns: { positions, normals, colors, indices } as Float32Array/Uint32Array
```

### 5. FluidMesher (`FluidMesher.js`)

Height-aware meshing for water and lava with corner interpolation.

```javascript
const fluidMesher = new FluidMesher(registry);

// Build water mesh with sloped surfaces
const waterMesh = fluidMesher.buildFluidMesh(grid, 'water', offset);

// Build lava mesh
const lavaMesh = fluidMesher.buildFluidMesh(grid, 'lava', offset);
```

### 6. RegionMeshBuilder (`RegionMeshBuilder.js`)

Orchestrates the full pipeline from region file to GPU-ready meshes.

```javascript
const builder = new RegionMeshBuilder({
  workerCount: 8,
  onProgress: (phase, current, total) => { ... },
  onChunkReady: (chunkMesh) => { ... }, // For streaming updates
});

// Load and mesh a region
const result = await builder.buildRegion(mcaFile, regionX, regionZ);
// Returns: { solidMesh, waterMesh, lavaMesh, stats }
```

### 7. RegionManager (`RegionManager.js`)

Manages multiple loaded regions with lifecycle control.

```javascript
const manager = new RegionManager(scene, {
  maxRegions: 25,
  maxConcurrentLoads: 4,
});

// Load a region
await manager.loadRegion(file, regionX, regionZ);

// Unload distant regions
manager.unloadRegion(regionX, regionZ);

// Get all meshes for a region
const meshes = manager.getRegion(regionX, regionZ);
```

## Binary Data Format

### Block Storage

Each block uses 16 bits (Uint16):

```
┌─────────────────────────────────────────┐
│ 15 14 13 12 │ 11 10 9 8 7 6 5 4 3 2 1 0 │
├─────────────┼───────────────────────────┤
│ Level/Meta  │      Block Type ID        │
└─────────────┴───────────────────────────┘
```

- **Block Type ID (12 bits)**: Supports 4096 unique block types
- **Level/Meta (4 bits)**: Fluid level (0-15) or block state metadata

### Chunk Storage

Chunks are stored sparsely - only non-empty sections allocate memory:

```javascript
// ChunkSection: 16x16x16 = 4096 blocks = 8KB
const SECTION_SIZE = 16 * 16 * 16 * 2; // 8192 bytes

// Sparse chunk map: only allocate sections with blocks
const sections = new Map(); // sectionY -> Uint16Array(4096)
```

### Mesh Output Format

Meshes are output as transferable typed arrays:

```javascript
{
  positions: Float32Array,  // [x,y,z, x,y,z, ...] - 3 floats per vertex
  normals: Float32Array,    // [nx,ny,nz, ...] - 3 floats per vertex
  colors: Float32Array,     // [r,g,b, r,g,b, ...] - 3 floats per vertex (0-1 range)
  indices: Uint32Array,     // Triangle indices
}
```

## Performance Characteristics

### Memory Usage

| Component | Size | Notes |
|-----------|------|-------|
| Block Registry | ~50KB | One-time allocation |
| Chunk Section | 8KB | Per non-empty section |
| Full Region (typical) | 20-80MB | Varies by terrain |
| Output Mesh | ~5-20MB | After greedy compression |

### Processing Time Targets

| Phase | Target | Notes |
|-------|--------|-------|
| Decompress + Decode | <500ms | Parallel workers |
| Greedy Meshing | <1500ms | Parallel per chunk |
| Fluid Meshing | <500ms | After solid mesh |
| GPU Upload | <200ms | Transferable buffers |
| **Total** | **<3000ms** | For full region |

### Scalability

| Metric | Target |
|--------|--------|
| Concurrent regions | 20+ |
| Max blocks in memory | 1+ billion |
| Worker pool size | 8-16 (hardware dependent) |
| GC pauses | <5ms |

## File Structure

```
src/mesh/
├── README.md                 # This file
├── BlockRegistry.js          # Block ID ↔ name mapping, colors, categories
├── BinaryGrid.js             # Sparse binary voxel storage
├── ChunkDecoder.js           # NBT → binary grid conversion
├── BinaryGreedyMesher.js     # Optimized greedy meshing
├── FluidMesher.js            # Water/lava height-aware meshing
├── RegionMeshBuilder.js      # Full pipeline orchestration
├── RegionManager.js          # Multi-region lifecycle
└── workers/
    ├── DecodeWorker.js       # Chunk decompression/decoding
    └── MeshWorker.js         # Greedy/fluid meshing
```

## Usage Example

```javascript
import { RegionManager } from './mesh/RegionManager';
import { parseMCAFile } from './utils/mcaParser';

// Initialize
const manager = new RegionManager(scene);

// Load region from file
const file = await fetch('r.0.0.mca').then(r => r.arrayBuffer());
const chunks = await parseMCAFile(file);

await manager.loadRegion(chunks, 0, 0, {
  onProgress: (phase, current, total) => {
    console.log(`${phase}: ${current}/${total}`);
  }
});

// Access meshes
const region = manager.getRegion(0, 0);
console.log(region.stats);
// { blocks: 2500000, triangles: 150000, loadTimeMs: 2340 }
```

## Migration from Legacy System

The new system replaces:
- `greedyMesher.js` → `BinaryGreedyMesher.js`
- `subchunkManager.js` → `BinaryGrid.js`
- `extractionWorkerManager.js` → `ChunkDecoder.js`
- `meshWorkerManager.js` → `RegionMeshBuilder.js`
- `pipelinedLoader.js` → `RegionMeshBuilder.js`

Legacy components remain available during transition.

## Future Enhancements

### Custom Block Meshes (Phase 2)
Support for non-cube blocks like stairs, slabs, fences:
- Pre-baked mesh templates in `CustomBlockMeshes.js`
- Instanced rendering for repeated blocks
- Block state → mesh variant mapping

### Level of Detail (Phase 3)
Distance-based mesh simplification:
- Near: Full detail greedy mesh
- Medium: Reduced face merging
- Far: Voxel-based simplified mesh

### Frustum Culling (Integrated)
Camera-aware chunk loading:
- Priority queue based on frustum intersection
- Background loading of off-screen chunks

