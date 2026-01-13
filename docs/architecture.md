# Block Viewer Architecture

A comprehensive guide to the Block Viewer rendering pipeline, threading model, and data flow.

## Table of Contents

- [System Overview](#system-overview)
- [Thread Architecture](#thread-architecture)
- [File Loading Pipeline](#file-loading-pipeline)
- [Meshing Strategies](#meshing-strategies)
- [Chunk Loading Modes](#chunk-loading-modes)
- [Rendering Pipeline](#rendering-pipeline)
- [Data Structures](#data-structures)
- [Key Components](#key-components)

---

## System Overview

Block Viewer is a web-based Minecraft world renderer that displays `.mca` region files using Three.js and WebGL. It replicates Minecraft's rendering pipeline including block meshing, lighting, ambient occlusion, and texture atlases.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           BLOCK VIEWER ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│   │  .mca/.zip  │────▶│   Parsing   │────▶│   Meshing   │────▶│  Rendering  │   │
│   │   Files     │     │   (NBT)     │     │ (WASM/JS)   │     │  (WebGL)    │   │
│   └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘   │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐  │
│   │                         Texture Pack System                               │  │
│   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │  │
│   │  │ Block    │  │ Model    │  │ Texture  │  │ Particle │                  │  │
│   │  │ States   │  │ Resolver │  │ Atlas    │  │ Atlas    │                  │  │
│   │  └──────────┘  └──────────┘  └──────────┘  └──────────┘                  │  │
│   └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐  │
│   │                          Worker Pool (7 workers)                          │  │
│   │    Parallel NBT parsing, decompression, and mesh generation              │  │
│   └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Thread Architecture

The application distributes work across multiple threads to maintain 60fps rendering while loading chunk data.

### Main Thread Responsibilities

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MAIN THREAD                                         │
│                                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │   React UI   │  │  Three.js    │  │   Camera     │  │   Particle System    │ │
│  │  Components  │  │  Renderer    │  │  Controls    │  │   (GPU Instancing)   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────────┘ │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                        ChunkStreamer / SuperChunkManager                     ││
│  │  - Coordinates chunk loading                                                 ││
│  │  - Dispatches work to workers                                                ││
│  │  - Creates Three.js meshes from worker results (~2ms per super-chunk)        ││
│  │  - Manages chunk visibility based on camera distance                         ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                           Asset Loading (One-time)                           ││
│  │  - TextureAtlas building                   - ParticleAtlas building          ││
│  │  - BlockRegistry initialization            - StateRegistry pre-registration  ││
│  │  - WASM module initialization              - Lightmap texture generation     ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ postMessage (ArrayBuffers)
                                      ▼
```

### Worker Pool Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         SUPER CHUNK WORKER POOL (7 workers)                      │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                          Per-Worker Pipeline                                 ││
│  │                                                                              ││
│  │  1. Receive compressed chunk data                                            ││
│  │  2. Decompress (zlib via pako)                                               ││
│  │  3. Parse NBT (chunk sections, palettes, light arrays)                       ││
│  │  4. Decode blocks to BinaryGrid + BlockStateGrid + LightGrid                 ││
│  │  5. Propagate light (if Minecraft light data missing)                        ││
│  │  6. WASM Greedy Meshing (solid/water/lava/glass)                             ││
│  │  7. WASM Model Meshing (slabs/stairs/plants/etc)                             ││
│  │  8. Return transferable ArrayBuffers                                         ││
│  │                                                                              ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  Each worker has its own:                                                        │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │ - WASM module instance          - Block registry copy                        ││
│  │ - State registry copy           - Model geometry registry                    ││
│  │ - Lookup tables (SharedArrayBuffer when available)                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Task Distribution Summary

| Task | Thread | Timing | Notes |
|------|--------|--------|-------|
| React UI updates | Main | Variable | React reconciliation |
| Three.js mesh creation | Main | ~2ms per super-chunk | Creates BufferGeometry + Mesh |
| WebGL buffer uploads | Main | ~1-5ms | GPU transfer (first frame only) |
| Particle system update | Main | ~0.5ms/frame | Instance buffer updates |
| Camera controls | Main | ~0.1ms/frame | Input handling |
| Scene management | Main | ~0.1ms per mesh | Add/remove meshes |
| NBT parsing | Worker | ~5-20ms | Decompression + parsing |
| Light propagation | Worker | ~1-3ms | BFS flood fill |
| Greedy meshing | Worker | ~2-10ms | WASM accelerated |
| Model meshing | Worker | ~1-5ms | Non-cube blocks |

---

## File Loading Pipeline

Block Viewer supports two file input formats, both converging to the same internal processing.

### File Format Decision Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FILE INPUT FLOW                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                          User selects file(s)                                    │
│                                  │                                               │
│                                  ▼                                               │
│                    ┌───────────────────────────┐                                 │
│                    │   What file type?         │                                 │
│                    └───────────────────────────┘                                 │
│                          │               │                                       │
│                   .mca/.mcr          .zip                                        │
│                          │               │                                       │
│                          ▼               ▼                                       │
│             ┌─────────────────┐  ┌─────────────────┐                             │
│             │ Direct Loading  │  │ Scan Dimensions │                             │
│             │ parseRegionCoords│  │ scanDimensionsFromZip                       │
│             └─────────────────┘  └─────────────────┘                             │
│                          │               │                                       │
│                          │               ▼                                       │
│                          │    ┌─────────────────┐                                │
│                          │    │ Multiple dims?  │                                │
│                          │    └─────────────────┘                                │
│                          │          │yes     │no                                 │
│                          │          ▼        │                                   │
│                          │   ┌────────────┐  │                                   │
│                          │   │ Dimension  │  │                                   │
│                          │   │ Picker UI  │  │                                   │
│                          │   └────────────┘  │                                   │
│                          │          │        │                                   │
│                          └──────────┴────────┘                                   │
│                                     │                                            │
│                                     ▼                                            │
│                    ┌───────────────────────────┐                                 │
│                    │ Create Lazy File Objects  │                                 │
│                    │ { name, arrayBuffer() }   │                                 │
│                    └───────────────────────────┘                                 │
│                                     │                                            │
│                                     ▼                                            │
│                    ┌───────────────────────────┐                                 │
│                    │     processRegionFiles    │                                 │
│                    │ Extract regionX, regionZ  │                                 │
│                    └───────────────────────────┘                                 │
│                                     │                                            │
│                                     ▼                                            │
│                    ┌───────────────────────────┐                                 │
│                    │ setRegionFiles([ {...} ]) │                                 │
│                    │  → triggers RegionViewer  │                                 │
│                    └───────────────────────────┘                                 │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Loading .mca Files Directly

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         DIRECT .mca FILE LOADING                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  File: r.-1.2.mca                                                                │
│              │                                                                   │
│              ▼                                                                   │
│  ┌───────────────────────────┐                                                   │
│  │  parseRegionCoords()      │                                                   │
│  │  r\.(-?\d+)\.(-?\d+)\.mca │                                                   │
│  │  → { x: -1, z: 2 }        │                                                   │
│  └───────────────────────────┘                                                   │
│              │                                                                   │
│              ▼                                                                   │
│  ┌───────────────────────────┐                                                   │
│  │  Region Info Object       │                                                   │
│  │  {                        │                                                   │
│  │    file: File,            │     File API reference                            │
│  │    regionX: -1,           │     Region X coordinate                           │
│  │    regionZ: 2,            │     Region Z coordinate                           │
│  │  }                        │                                                   │
│  └───────────────────────────┘                                                   │
│              │                                                                   │
│              │   Each region = 32×32 chunks = 512×512 blocks                     │
│              ▼                                                                   │
│  ┌───────────────────────────┐                                                   │
│  │  ChunkStreamer receives   │                                                   │
│  │  regions for streaming    │                                                   │
│  └───────────────────────────┘                                                   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Loading .zip World Saves

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            .zip WORLD LOADING                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  world.zip                                                                       │
│      │                                                                           │
│      ▼                                                                           │
│  ┌───────────────────────────┐                                                   │
│  │  JSZip.loadAsync(file)    │   Reads zip metadata only (fast)                  │
│  └───────────────────────────┘                                                   │
│      │                                                                           │
│      ▼                                                                           │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                    Scan for Dimension Folders                              │  │
│  │                                                                            │  │
│  │   Standard Paths:                                                          │  │
│  │   ├── region/              → Overworld                                     │  │
│  │   ├── DIM-1/region/        → Nether                                        │  │
│  │   ├── DIM1/region/         → The End                                       │  │
│  │   └── dimensions/namespace/name/region/ → Custom dimensions                │  │
│  │                                                                            │  │
│  │   Also handles nested structures:                                          │  │
│  │   └── WorldName/region/    → World folder wrapper                          │  │
│  │   └── saves/World/region/  → Deep nesting                                  │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│      │                                                                           │
│      ▼                                                                           │
│  ┌───────────────────────────┐                                                   │
│  │  dimensions.length > 1?   │                                                   │
│  └───────────────────────────┘                                                   │
│      │yes              │no                                                       │
│      ▼                 ▼                                                         │
│  ┌─────────────┐  ┌─────────────┐                                                │
│  │ Dimension   │  │ Auto-select │                                                │
│  │ Picker UI   │  │ single dim  │                                                │
│  │             │  └─────────────┘                                                │
│  │ 🌍 Overworld│        │                                                        │
│  │ 🔥 Nether   │        │                                                        │
│  │ 🌌 The End  │        │                                                        │
│  │ ✨ Custom   │        │                                                        │
│  └─────────────┘        │                                                        │
│      │                  │                                                        │
│      └────────┬─────────┘                                                        │
│               ▼                                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                      Create Lazy File Objects                              │  │
│  │                                                                            │  │
│  │   {                                                                        │  │
│  │     name: 'r.0.0.mca',                                                     │  │
│  │     arrayBuffer: async () => {                                             │  │
│  │       if (cachedBuffer) return cachedBuffer;                               │  │
│  │       cachedBuffer = await zipFile.async('arraybuffer');  // Extract here  │  │
│  │       return cachedBuffer;                                                 │  │
│  │     }                                                                      │  │
│  │   }                                                                        │  │
│  │                                                                            │  │
│  │   Benefits:                                                                │  │
│  │   ✓ Fast initial load (metadata only)                                     │  │
│  │   ✓ Memory efficient (extract on demand)                                  │  │
│  │   ✓ Caching prevents re-extraction                                        │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Meshing Strategies

Block Viewer supports two meshing implementations with automatic fallback.

### WASM vs JavaScript Decision Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           MESHING STRATEGY SELECTION                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                       SuperChunk marked dirty                                    │
│                                │                                                 │
│                                ▼                                                 │
│                     scheduleIdleRebuild()                                        │
│                                │                                                 │
│                                ▼                                                 │
│                    ┌───────────────────────┐                                     │
│                    │   WASM available?     │                                     │
│                    │   wasmInitialized &&  │                                     │
│                    │   isWasmAvailable()   │                                     │
│                    └───────────────────────┘                                     │
│                         │yes          │no                                        │
│                         ▼             ▼                                          │
│              ┌─────────────────┐  ┌─────────────────┐                            │
│              │ WASM Pipeline   │  │ JavaScript      │                            │
│              │ (Rust/WASM)     │  │ Fallback        │                            │
│              │                 │  │                 │                            │
│              │ - 3-5x faster   │  │ - Works always  │                            │
│              │ - No GC pauses  │  │ - Easier debug  │                            │
│              │ - Efficient mem │  │ - More GC       │                            │
│              └─────────────────┘  └─────────────────┘                            │
│                         │                 │                                      │
│                         └────────┬────────┘                                      │
│                                  ▼                                               │
│                    ┌───────────────────────┐                                     │
│                    │ Model meshes enabled? │                                     │
│                    │ (slabs, stairs, etc.) │                                     │
│                    └───────────────────────┘                                     │
│                         │yes          │no                                        │
│                         ▼             │                                          │
│              ┌─────────────────┐      │                                          │
│              │ WASM Model      │      │                                          │
│              │ Mesher V3       │      │                                          │
│              │ (pre-baked      │      │                                          │
│              │  geometry)      │      │                                          │
│              └─────────────────┘      │                                          │
│                         │             │                                          │
│                         └──────┬──────┘                                          │
│                                ▼                                                 │
│                    Create Three.js meshes                                        │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### WASM Meshing Pipeline (Default)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              WASM MESHER (Rust)                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                            Input Data                                        ││
│  │                                                                              ││
│  │  BinaryGrid          BlockStateGrid        LightGrid                         ││
│  │  ┌──────────┐        ┌──────────┐         ┌──────────┐                      ││
│  │  │ Block ID │        │ State ID │         │Sky|Block │                      ││
│  │  │ + flags  │        │ (non-cube│         │  Light   │                      ││
│  │  │ 16-bit   │        │  blocks) │         │ 4+4 bits │                      ││
│  │  └──────────┘        └──────────┘         └──────────┘                      ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                         Greedy Mesher (fast_greedy.rs)                       ││
│  │                                                                              ││
│  │  For each block type (solid, water, lava, glass):                            ││
│  │  1. Identify visible faces (neighbor culling)                                ││
│  │  2. Merge adjacent coplanar faces into larger quads                          ││
│  │  3. Calculate per-vertex:                                                    ││
│  │     - Position (world coords)     - Texture index (atlas)                    ││
│  │     - Normal                      - AO level (0-4)                           ││
│  │     - UV (atlas coords)           - Sky + Block light                        ││
│  │  4. Generate triangle indices                                                ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                         Model Mesher V3 (mesher_v3.rs)                       ││
│  │                                                                              ││
│  │  For each non-cube block (state ID in BlockStateGrid):                       ││
│  │  1. Look up pre-baked geometry from BlockModelRegistry                       ││
│  │  2. Apply position-based transforms:                                         ││
│  │     - Random Y rotation (plants, cross-models)                               ││
│  │     - Random XZ offset (small plants)                                        ││
│  │  3. Check face culling against neighbors                                     ││
│  │  4. Emit to correct mesh (opaque/transparent/overlay)                        ││
│  │  5. Collect particle emitters and beacon positions                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                            Output Meshes                                     ││
│  │                                                                              ││
│  │  MeshResult {                                                                ││
│  │    solid:       MeshData,    // Opaque full blocks                           ││
│  │    water:       MeshData,    // Water (animated, transparent)                ││
│  │    lava:        MeshData,    // Lava (animated, emissive)                    ││
│  │    glass:       MeshData,    // Glass/leaves (alpha-tested)                  ││
│  │    modelOpaque: MeshData,    // Non-cube opaque (slabs, stairs)              ││
│  │    modelTrans:  MeshData,    // Non-cube transparent (glass panes)           ││
│  │    modelOverlay:MeshData,    // Overlays (grass side tint)                   ││
│  │  }                                                                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### JavaScript Fallback Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          JAVASCRIPT MESHING FALLBACK                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  When WASM is unavailable (loading fails, explicitly disabled, or unsupported)  │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                        FastMesher.js                                         ││
│  │                                                                              ││
│  │  buildGridMeshes(grid, registry, offset, options)                            ││
│  │                                                                              ││
│  │  Same algorithm as WASM but in pure JavaScript:                              ││
│  │  1. Build lookup tables from registry                                        ││
│  │  2. Pre-allocate typed arrays for mesh data                                  ││
│  │  3. For each section (16×16×16):                                             ││
│  │     - Build mask of exposed faces                                            ││
│  │     - Greedy merge adjacent faces                                            ││
│  │     - Emit vertices with AO + smooth lighting                                ││
│  │  4. Return trimmed mesh arrays                                               ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                        ModelMesher.js                                        ││
│  │                                                                              ││
│  │  buildModelMeshesWithInstancing(grid, stateGrid, registry, ...)              ││
│  │                                                                              ││
│  │  For non-cube blocks:                                                        ││
│  │  1. Resolve block state → model variant                                      ││
│  │  2. Get precomputed geometry from StateRegistry                              ││
│  │  3. Collect instances per variant                                            ││
│  │  4. Build instanced geometry with per-instance attributes                    ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  Trade-offs:                                                                     │
│  ┌────────────────────────────────┬────────────────────────────────────────────┐│
│  │ Advantages                     │ Disadvantages                               ││
│  ├────────────────────────────────┼────────────────────────────────────────────┤│
│  │ ✓ No WASM loading overhead     │ ✗ 3-5x slower than WASM                    ││
│  │ ✓ Easier to debug              │ ✗ More GC pressure                         ││
│  │ ✓ Works in all browsers        │ ✗ Can block main thread                    ││
│  └────────────────────────────────┴────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### WASM Module Structure

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    src/wasm-mesher/src/ (Rust Source)                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  lib.rs                         # WASM exports and FFI boundary                  │
│  ├── lookup.rs                  # Block property lookup tables                   │
│  ├── types.rs                   # Shared type definitions                        │
│  │                                                                               │
│  ├── decode/                    # NBT parsing (in-worker)                        │
│  │   ├── nbt.rs                 # NBT format parser                              │
│  │   └── palette.rs             # Block palette decompression                    │
│  │                                                                               │
│  ├── grid/                      # Sparse grid data structures                    │
│  │   ├── binary_grid.rs         # Block ID storage (16-bit packed)               │
│  │   ├── light_grid.rs          # Sky + block light (8-bit packed)               │
│  │   ├── state_grid.rs          # Block state IDs for model blocks               │
│  │   └── model_state_grid.rs    # Model-specific state data                      │
│  │                                                                               │
│  ├── mesher/                    # Greedy meshing algorithms                      │
│  │   ├── fast_greedy.rs         # Main greedy mesher                             │
│  │   ├── ao.rs                  # Ambient occlusion calculation                  │
│  │   ├── ao_simd.rs             # SIMD-optimized AO (when available)             │
│  │   ├── fluid.rs               # Water/lava meshing                             │
│  │   └── binary_cull.rs         # Face culling against neighbors                 │
│  │                                                                               │
│  └── models/                    # Non-cube block meshing                         │
│      ├── block_registry.rs      # Pre-baked model geometry registry              │
│      ├── mesher_v3.rs           # V3 model mesher (current)                      │
│      ├── geometry.rs            # Geometry data structures                       │
│      ├── instancing.rs          # GPU instancing support                         │
│      └── position_hash.rs       # Position-based random rotation                 │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Chunk Loading Modes

### Chunk Streaming (Default)

Player-centric progressive loading that mimics Minecraft's chunk loading behavior.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CHUNK STREAMING                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                          Player position + view direction                        │
│                                      │                                           │
│                                      ▼                                           │
│                         ┌───────────────────────┐                                │
│                         │  _queueChunksAroundPlayer()                           │
│                         │  Priority = distance² + directional bonus             │
│                         └───────────────────────┘                                │
│                                      │                                           │
│                                      ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                         DISTANCE ZONES                                     │  │
│  │                                                                            │  │
│  │              Render Distance        Load Distance      Unload Distance     │  │
│  │                   (8)                  (10)               (11)             │  │
│  │                    │                    │                   │              │  │
│  │    ┌───────────────┼────────────────────┼───────────────────┼──────────┐  │  │
│  │    │               │                    │                   │          │  │  │
│  │    │   VISIBLE     │     LOADED BUT     │      UNLOAD       │  NOT     │  │  │
│  │    │               │      HIDDEN        │      ZONE         │ LOADED   │  │  │
│  │    │  mesh.visible │   mesh.visible     │   Meshes removed  │          │  │  │
│  │    │    = true     │     = false        │                   │          │  │  │
│  │    │               │                    │                   │          │  │  │
│  │    └───────────────┼────────────────────┼───────────────────┼──────────┘  │  │
│  │                    │                    │                   │              │  │
│  │                                                                            │  │
│  │  Benefits:                                                                 │  │
│  │  ✓ Instant visibility toggle when moving (pre-loaded chunks)              │  │
│  │  ✓ Predictive loading in view direction                                   │  │
│  │  ✓ Memory efficient (unload distant chunks)                               │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                      │                                           │
│                                      ▼                                           │
│                         ┌───────────────────────┐                                │
│                         │   ChunkPriorityQueue  │                                │
│                         │   Min-heap by priority│                                │
│                         └───────────────────────┘                                │
│                                      │                                           │
│                                      ▼                                           │
│                         ┌───────────────────────┐                                │
│                         │   _processQueue()     │                                │
│                         │   Load N concurrent   │                                │
│                         └───────────────────────┘                                │
│                                      │                                           │
│                                      ▼                                           │
│                         ┌───────────────────────┐                                │
│                         │   SuperChunkManager   │                                │
│                         │   2×2 chunk grouping  │                                │
│                         └───────────────────────┘                                │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Super-Chunk Grouping

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SUPER-CHUNK SYSTEM                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  Standard Minecraft chunks are grouped into 2×2 "super-chunks" for meshing:     │
│                                                                                  │
│       Region (32×32 chunks)                 Super-Chunk (2×2 chunks)             │
│  ┌─────────────────────────────┐      ┌────────────────────────────┐            │
│  │ ┌─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┐  │      │  ┌───────────┬───────────┐ │            │
│  │ ├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤  │      │  │ Chunk     │ Chunk     │ │            │
│  │ ├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤  │      │  │ (0,0)     │ (1,0)     │ │            │
│  │ ├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤  │      │  │ 16×256×16 │ 16×256×16 │ │            │
│  │ ├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤  │      │  ├───────────┼───────────┤ │            │
│  │ ├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤  │  →   │  │ Chunk     │ Chunk     │ │            │
│  │ ├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤  │      │  │ (0,1)     │ (1,1)     │ │            │
│  │ ├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤  │      │  │ 16×256×16 │ 16×256×16 │ │            │
│  │ └─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┘  │      │  └───────────┴───────────┘ │            │
│  └─────────────────────────────┘      └────────────────────────────┘            │
│                                               = 32×256×32 blocks                 │
│                                                                                  │
│  Benefits:                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │ ✓ Greedy meshing works across chunk boundaries → fewer triangles            ││
│  │ ✓ Hidden faces between chunks are properly culled                           ││
│  │ ✓ Fewer mesh objects = fewer WebGL draw calls                               ││
│  │ ✓ Faster rebuilds than full regions (responsive loading)                    ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Rendering Pipeline

### Render Order

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              RENDER ORDER                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   Order │ Layer              │ Depth Write │ Blending      │ Notes              │
│  ───────┼────────────────────┼─────────────┼───────────────┼──────────────────  │
│    1    │ Sky                │ No          │ None          │ Background         │
│    2    │ Solid blocks       │ Yes         │ None          │ Opaque geometry    │
│    3    │ Model opaque       │ Yes         │ None          │ Slabs, stairs      │
│    4    │ Model overlay      │ Yes         │ Alpha test    │ Grass side tint    │
│    5    │ Glass/leaves       │ Yes         │ Alpha test    │ Cutout textures    │
│    6    │ Model transparent  │ No          │ Alpha blend   │ Glass panes        │
│    7    │ Water              │ No          │ Alpha blend   │ Animated, sorted   │
│    8    │ Lava               │ No          │ Additive      │ Animated, emissive │
│    9    │ Particles          │ No          │ Additive      │ GPU instanced      │
│   10    │ Beacon beams       │ No          │ Additive      │ Vertical quads     │
│   11    │ Clouds             │ No          │ Alpha blend   │ Minecraft clouds   │
│   12    │ UI overlay         │ N/A         │ N/A           │ React components   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Lighting Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LIGHTING PIPELINE                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  1. Light Data Sources                                                       ││
│  │                                                                              ││
│  │     Minecraft Chunk Data        OR        Light Propagation                  ││
│  │     ┌──────────────────┐                  ┌──────────────────┐               ││
│  │     │ SkyLight array   │                  │ BFS from sky     │               ││
│  │     │ BlockLight array │                  │ BFS from emitters│               ││
│  │     │ (4 bits each)    │                  │ (fallback)       │               ││
│  │     └──────────────────┘                  └──────────────────┘               ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  2. Per-Vertex Light Sampling (Smooth Lighting)                              ││
│  │                                                                              ││
│  │     For each vertex (at corner of face):                                     ││
│  │     1. Sample 4 neighboring blocks (including self)                          ││
│  │     2. Average non-solid neighbor light values                               ││
│  │     3. Store as vertex attribute (skyLight, blockLight)                      ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  3. Lightmap Texture (16×16)                                                 ││
│  │                                                                              ││
│  │     ┌────────────────────────────────────┐                                   ││
│  │     │      Sky Light (0-15) →            │  Brightness curve:                ││
│  │     │  ┌─────────────────────────────┐   │  level / (4.0 - 3.0 * level)      ││
│  │     │  │                             │   │                                   ││
│  │     │  │    Precomputed colors       │ ▲ │  Block light: warm orange tint    ││
│  │     │  │    combining sky+block      │ │ │  r = brightness                   ││
│  │     │  │    with brightness curve    │ │ │  g = brightness × warm_g          ││
│  │     │  │                             │ │ │  b = brightness × warm_b          ││
│  │     │  └─────────────────────────────┘   │                                   ││
│  │     │                      Block Light ↑ │                                   ││
│  │     └────────────────────────────────────┘                                   ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  4. Fragment Shader                                                          ││
│  │                                                                              ││
│  │     finalColor = textureColor                                                ││
│  │                × aoFactor           (ambient occlusion: 0.4 - 1.0)           ││
│  │                × lightmapSample     (from 16×16 lightmap texture)            ││
│  │                × directionalShade   (face-based: up=1.0, down=0.5)           ││
│  │                × tintColor          (biome grass/foliage/water)              ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Ambient Occlusion

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           AMBIENT OCCLUSION                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  Per-vertex AO calculation based on neighboring solid blocks:                    │
│                                                                                  │
│                           VERTEX                                                 │
│                              │                                                   │
│              ┌───────────────┼───────────────┐                                   │
│              │               │               │                                   │
│           SIDE1           CORNER          SIDE2                                  │
│              │               │               │                                   │
│              ▼               ▼               ▼                                   │
│        ┌─────────┐     ┌─────────┐     ┌─────────┐                               │
│        │ Check   │     │ Check   │     │ Check   │                               │
│        │ Neighbor│     │ Neighbor│     │ Neighbor│                               │
│        └────┬────┘     └────┬────┘     └────┬────┘                               │
│             │               │               │                                    │
│             └───────────────┴───────────────┘                                    │
│                             │                                                    │
│                             ▼                                                    │
│                  ┌──────────────────────┐                                        │
│                  │   AO Calculation     │                                        │
│                  │                      │                                        │
│                  │ if (side1 && side2)  │                                        │
│                  │   ao = 0 (darkest)   │                                        │
│                  │ else                 │                                        │
│                  │   ao = 3 - side1 -   │                                        │
│                  │        side2 - corner│                                        │
│                  └──────────────────────┘                                        │
│                             │                                                    │
│                             ▼                                                    │
│                  ┌──────────────────────┐                                        │
│                  │   AO Factors         │                                        │
│                  │                      │                                        │
│                  │ ao=0 → 0.40 (dark)   │                                        │
│                  │ ao=1 → 0.65          │                                        │
│                  │ ao=2 → 0.80          │                                        │
│                  │ ao=3 → 0.90          │                                        │
│                  │ ao=4 → 1.00 (bright) │                                        │
│                  └──────────────────────┘                                        │
│                                                                                  │
│  Quad Triangulation (AO-aware flip):                                             │
│  ┌───────────────────────────────────────┐                                       │
│  │                                       │                                       │
│  │  If ao0 + ao2 > ao1 + ao3:            │                                       │
│  │    Triangulate: (0,1,2), (0,2,3)      │  Prevents "diagonal shadow"           │
│  │  Else:                                │  artifacts on merged quads            │
│  │    Triangulate: (1,2,3), (1,3,0)      │                                       │
│  │                                       │                                       │
│  └───────────────────────────────────────┘                                       │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Structures

### Grid Storage

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              GRID DATA STRUCTURES                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  All grids use sparse storage - only non-empty sections are allocated:          │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  BinaryGrid                                                                  ││
│  │  HashMap<SectionKey, [u16; 4096]>                                            ││
│  │                                                                              ││
│  │  16-bit packed value:                                                        ││
│  │  ┌─────────────────────────────────────────────────────────────┐             ││
│  │  │ bit 15 │ bit 14 │ bit 13 │ bit 12 │ bits 11-0            │             ││
│  │  │ opaque │non-cube│ fluid  │reserved│     block ID (0-4095) │             ││
│  │  └─────────────────────────────────────────────────────────────┘             ││
│  │                                                                              ││
│  │  Section key: (sectionY << 16) | (chunkZ << 8) | chunkX                      ││
│  │  Index in section: (y & 15) << 8 | (z & 15) << 4 | (x & 15)                  ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  LightGrid                                                                   ││
│  │  HashMap<SectionKey, [u8; 4096]>                                             ││
│  │                                                                              ││
│  │  8-bit packed value:                                                         ││
│  │  ┌─────────────────────────────────┐                                         ││
│  │  │ bits 7-4      │ bits 3-0       │                                         ││
│  │  │ skyLight 0-15 │ blockLight 0-15│                                         ││
│  │  └─────────────────────────────────┘                                         ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  BlockStateGrid                                                              ││
│  │  HashMap<SectionKey, [u16; 4096]>                                            ││
│  │                                                                              ││
│  │  State ID for non-cube blocks (registered in StateRegistry)                  ││
│  │  0 = no model (full cube or air)                                             ││
│  │  1+ = lookup into pre-baked model geometry                                   ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Shared Memory (When Available)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         SHARED MEMORY ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  When SharedArrayBuffer is available (COOP/COEP headers present):               │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  SharedArrayBuffer Lookup Tables                                             ││
│  │  Zero-copy sharing between main thread and all workers                       ││
│  │                                                                              ││
│  │  isOpaque[4096]           Uint8Array   - Block opacity flags                 ││
│  │  isNonCube[4096]          Uint8Array   - Non-cube block flags                ││
│  │  isFluid[4096]            Uint8Array   - Fluid block flags                   ││
│  │  isAOTransparent[4096]    Uint8Array   - AO transparency flags               ││
│  │  blockColors[4096×3]      Float32Array - Average block colors                ││
│  │  textureIndices[4096×6]   Uint16Array  - Texture atlas indices per face      ││
│  │  faceTintTypes[4096×6]    Uint8Array   - Tint type per face                  ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  Fallback (no SharedArrayBuffer):                                               │
│  - Each worker receives a copy of lookup tables during initialization           │
│  - Slightly higher memory usage but functionally identical                      │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Components

### File Structure

```
src/
├── App.jsx                      # Main application, file handling, state
├── main.jsx                     # React entry point
│
├── assets/                      # Resource loading & processing
│   ├── TextureAtlas.js          # Atlas building + UV calculation
│   ├── ParticleAtlas.js         # Particle texture atlas
│   ├── TexturePackManager.js    # Resource pack loading
│   ├── BlockstateResolver.js    # Blockstate → model variant
│   ├── ModelResolver.js         # Model inheritance resolution
│   ├── ModelGeometry.js         # Pre-baked model geometry
│   ├── StateRegistry.js         # Block state → geometry caching
│   └── TextureIndexLookup.js    # Block → texture mapping
│
├── mesh/                        # Meshing & data structures
│   ├── BinaryGrid.js            # Block ID storage
│   ├── BlockStateGrid.js        # Block state storage
│   ├── LightGrid.js             # Light data storage
│   ├── BlockRegistry.js         # Block name ↔ ID mapping
│   ├── ChunkDecoder.js          # NBT → grid conversion
│   ├── FastMesher.js            # JS greedy mesher (fallback)
│   ├── ModelMesher.js           # JS model mesher (fallback)
│   ├── FluidMesher.js           # Water/lava special handling
│   ├── LightPropagator.js       # Sky light BFS
│   ├── BlockLightPropagator.js  # Block light BFS
│   ├── LightmapGenerator.js     # 16×16 lightmap texture
│   │
│   ├── wasm/
│   │   ├── WasmMesher.js        # JS ↔ WASM bridge
│   │   └── pkg/                 # Compiled WASM module
│   │
│   └── workers/
│       ├── SuperChunkWorker.js      # Full pipeline worker
│       ├── SuperChunkWorkerPool.js  # Worker pool management
│       ├── MeshWorker.js            # Mesh-only worker
│       └── DecodeWorker.js          # Decode-only worker
│
├── viewer/                      # Three.js scene management
│   ├── RegionViewer.jsx         # Main Three.js canvas component
│   ├── ChunkManager.js          # Scene + material management
│   ├── ChunkStreamer.js         # Player-centric chunk loading
│   ├── SuperChunkManager.js     # 2×2 chunk grouping + meshing
│   ├── SpectatorControls.js     # Minecraft-style camera
│   ├── SkyRenderer.js           # Sky/sun/moon rendering
│   └── materials/
│       └── TexturedMaterial.js  # Main block material with lightmap
│
├── wasm-mesher/                 # Rust WASM source
│   └── src/
│       ├── lib.rs               # WASM exports
│       ├── mesher/              # Greedy meshing
│       ├── models/              # Model meshing + registry
│       ├── grid/                # Sparse grid types
│       └── decode/              # NBT parsing
│
├── particles/                   # Particle effects
│   ├── ParticleSystem.js        # GPU-instanced particles
│   ├── ParticleEmitter.js       # Block emitter configs
│   └── SharedParticlePool.js    # Particle buffer management
│
└── utils/                       # Utilities
    ├── mcaParser.js             # Region file parsing
    ├── nbtParser.js             # NBT format parsing
    ├── CapabilityDetector.js    # Hardware capability detection
    └── SharedMemoryPool.js      # SharedArrayBuffer management
```

### Component Interactions

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           COMPONENT INTERACTION MAP                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                              ┌──────────┐                                        │
│                              │  App.jsx │                                        │
│                              │  (State) │                                        │
│                              └────┬─────┘                                        │
│                                   │                                              │
│          ┌────────────────────────┼────────────────────────┐                     │
│          │                        │                        │                     │
│          ▼                        ▼                        ▼                     │
│   ┌─────────────┐         ┌─────────────┐          ┌─────────────┐               │
│   │TexturePack  │         │RegionViewer │          │   React UI  │               │
│   │  Manager    │         │  (Three.js) │          │ Components  │               │
│   └──────┬──────┘         └──────┬──────┘          └─────────────┘               │
│          │                       │                                               │
│          ▼                       │                                               │
│   ┌─────────────┐                │                                               │
│   │TextureAtlas │                │                                               │
│   └──────┬──────┘                │                                               │
│          │                       │                                               │
│          └───────────┬───────────┘                                               │
│                      │                                                           │
│                      ▼                                                           │
│              ┌─────────────┐                                                     │
│              │ChunkStreamer│───────────────────────────┐                         │
│              └──────┬──────┘                           │                         │
│                     │                                  │                         │
│          ┌──────────┴──────────┐                       ▼                         │
│          │                     │             ┌──────────────────┐                │
│          ▼                     ▼             │SuperChunkWorker  │                │
│   ┌─────────────┐      ┌─────────────┐       │      Pool        │                │
│   │ChunkManager │      │SuperChunk   │       │  (7 workers)     │                │
│   │ (materials) │      │  Manager    │◄─────►│                  │                │
│   └──────┬──────┘      └─────────────┘       │ ┌──────────────┐ │                │
│          │                                   │ │ WASM Module  │ │                │
│          │                                   │ │ (per worker) │ │                │
│          ▼                                   │ └──────────────┘ │                │
│   ┌─────────────┐                            └──────────────────┘                │
│   │Three.js     │                                                                │
│   │  Scene      │                                                                │
│   └─────────────┘                                                                │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Performance Characteristics

| Metric | Typical Value | Notes |
|--------|---------------|-------|
| Initial WASM load | ~50-100ms | One-time module initialization |
| Region parse | ~50-200ms | Depends on chunk count |
| Super-chunk mesh (WASM) | ~5-15ms | Full decode + mesh |
| Super-chunk mesh (JS) | ~20-50ms | 3-5x slower than WASM |
| Mesh creation (main) | ~2ms | BufferGeometry + Three.js Mesh |
| Target frame time | ~16.6ms | 60fps rendering |
| Worker count | 7 | navigator.hardwareConcurrency - 1 |
| Chunk load concurrency | 1-8 | User configurable |

---

## Configuration Options

### Render Settings (App.jsx state)

```javascript
// Core settings
chunkStreamingEnabled   // true = streaming mode, false = load all
enableModelMeshes       // true = render slabs/stairs/flowers/etc
enableLighting          // true = smooth lighting, false = flat

// Quality settings
renderDistance          // chunks visible around player (default: 8)
particleQuality         // 'all', 'decreased', 'minimal', 'off'
particleDistance        // particle render distance in chunks
fogEnabled              // Minecraft-style distance fog
cloudsEnabled           // Render clouds
continuousGlass         // Connected glass textures (no borders)

// Performance settings
chunkLoadingSpeed       // 1-8, concurrent chunks to load
targetResolution        // 'native', 720, 1080, 1440, 2160

// Visual settings
timeOfDay               // 0-1 (0=midnight, 0.5=noon)
brightness              // 0-100 (Minecraft brightness slider)
fov                     // Field of view in degrees
enableRGSS              // Rotated Grid Super-Sampling AA
```

---

*Last updated: January 2026*
