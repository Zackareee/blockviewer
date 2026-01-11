# Block Viewer Architecture

## Thread & Worker Architecture

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
│  │  - TextureAtlas building                                                     ││
│  │  - ParticleAtlas building                                                    ││
│  │  - BlockRegistry initialization                                              ││
│  │  - StateRegistry pre-registration                                            ││
│  │  - WASM module initialization                                                ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ postMessage (ArrayBuffers)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         SUPER CHUNK WORKER POOL (7 workers)                      │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                          Per-Worker Pipeline                                 ││
│  │                                                                              ││
│  │  1. Receive compressed chunk data                                            ││
│  │  2. Decompress (zlib via pako or native)                                     ││
│  │  3. Parse NBT                                                                ││
│  │  4. Decode blocks to BinaryGrid + BlockStateGrid + LightGrid                 ││
│  │  5. Propagate light (if Minecraft light data missing)                        ││
│  │  6. WASM Greedy Meshing (solid/water/lava/glass)                             ││
│  │  7. WASM Model Meshing (slabs/stairs/plants/etc)                             ││
│  │  8. Return transferable ArrayBuffers                                         ││
│  │                                                                              ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  Each worker has its own:                                                        │
│  - WASM module instance                                                          │
│  - Block registry copy                                                           │
│  - State registry copy                                                           │
│  - Model geometry registry                                                       │
│  - Lookup tables (SharedArrayBuffer when available)                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Chunk Loading

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  ZIP File   │────▶│  Extract    │────▶│  Region     │────▶│  Chunk      │
│  (.zip)     │     │  r.X.Z.mca  │     │  Parser     │     │  Headers    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                                                   │
                                                                   ▼
                                              ┌────────────────────────────────┐
                                              │  SuperChunkWorkerPool.dispatch │
                                              │  (compressed chunk bytes)      │
                                              └────────────────────────────────┘
                                                                   │
                                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              WORKER (off main thread)                            │
│                                                                                  │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│  │ Decompress  │────▶│ Parse NBT   │────▶│ Decode      │────▶│ Light       │   │
│  │ (zlib)      │     │ (sections)  │     │ Blocks      │     │ Propagation │   │
│  └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘   │
│                                                                   │              │
│                                                                   ▼              │
│                                         ┌─────────────────────────────────────┐ │
│                                         │     WASM Meshing Pipeline           │ │
│                                         │                                     │ │
│                                         │  ┌─────────────┐  ┌─────────────┐  │ │
│                                         │  │   Greedy    │  │   Model     │  │ │
│                                         │  │   Mesher    │  │   Mesher    │  │ │
│                                         │  │ (FastMesher)│  │ (ModelMesher│  │ │
│                                         │  └─────────────┘  └─────────────┘  │ │
│                                         │         │                │          │ │
│                                         │         ▼                ▼          │ │
│                                         │  ┌─────────────────────────────────┐│ │
│                                         │  │ Mesh Data (TypedArrays)         ││ │
│                                         │  │ - positions, normals, uvs       ││ │
│                                         │  │ - colors, texIndices, light     ││ │
│                                         │  │ - indices                       ││ │
│                                         │  └─────────────────────────────────┘│ │
│                                         └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
                                                                   │
                                                                   │ Transferables
                                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MAIN THREAD                                         │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                        _createMesh (~2ms)                                    ││
│  │  - Create BufferGeometry                                                     ││
│  │  - Attach attributes (position, normal, uv, color, etc.)                     ││
│  │  - Create THREE.Mesh with material                                           ││
│  │  - Add to scene                                                              ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                        Three.js Renderer                                     ││
│  │  - WebGL draw calls                                                          ││
│  │  - GPU uploads (first frame only per mesh)                                   ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## WASM Meshing Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              WASM MESHER (Rust)                                  │
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
│  │                         Greedy Mesher                                        ││
│  │                                                                              ││
│  │  For each block type (solid, water, lava, glass):                            ││
│  │  1. Identify visible faces (neighbor culling)                                ││
│  │  2. Merge adjacent coplanar faces into larger quads                          ││
│  │  3. Calculate per-vertex:                                                    ││
│  │     - Position (world coords)                                                ││
│  │     - Normal                                                                 ││
│  │     - UV (atlas coords)                                                      ││
│  │     - Texture index                                                          ││
│  │     - AO level (0-4)                                                         ││
│  │     - Sky + Block light                                                      ││
│  │     - Tint type (grass/foliage/water)                                        ││
│  │  4. Generate triangle indices                                                ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                         Model Mesher V2                                      ││
│  │                                                                              ││
│  │  For each non-cube block (state ID in BlockStateGrid):                       ││
│  │  1. Look up pre-baked geometry from ModelRegistryV2                          ││
│  │  2. Apply position-based transforms:                                         ││
│  │     - Random Y rotation (plants, cross-models)                               ││
│  │     - Random XZ offset (small plants)                                        ││
│  │  3. Check face culling against neighbors                                     ││
│  │  4. Emit to correct mesh (opaque/transparent/overlay)                        ││
│  │  5. Collect particle emitters and beacons                                    ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                            Output                                            ││
│  │                                                                              ││
│  │  MeshResult {                                                                ││
│  │    solid:       MeshData,    // Opaque blocks                                ││
│  │    water:       MeshData,    // Water (animated)                             ││
│  │    lava:        MeshData,    // Lava (animated)                              ││
│  │    glass:       MeshData,    // Glass/leaves (alpha-tested)                  ││
│  │    modelOpaque: MeshData,    // Non-cube opaque (slabs, stairs)              ││
│  │    modelTrans:  MeshData,    // Non-cube transparent (glass panes)           ││
│  │    modelOverlay:MeshData,    // Overlays (grass side overlay)                ││
│  │  }                                                                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Ambient Occlusion

```
                           VERTEX
                              │
              ┌───────────────┼───────────────┐
              │               │               │
           SIDE1           CORNER          SIDE2
              │               │               │
              ▼               ▼               ▼
        ┌─────────┐     ┌─────────┐     ┌─────────┐
        │ Check   │     │ Check   │     │ Check   │
        │ Neighbor│     │ Neighbor│     │ Neighbor│
        └────┬────┘     └────┬────┘     └────┬────┘
             │               │               │
             └───────────────┴───────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │   AO Calculation     │
                  │                      │
                  │ if (side1 && side2)  │
                  │   ao = 0 (darkest)   │
                  │ else                 │
                  │   ao = 3 - side1 -   │
                  │        side2 - corner│
                  └──────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │   AO Factors         │
                  │                      │
                  │ ao=0 → 0.40 (dark)   │
                  │ ao=1 → 0.65          │
                  │ ao=2 → 0.80          │
                  │ ao=3 → 0.90          │
                  │ ao=4 → 1.00 (bright) │
                  └──────────────────────┘

Quad Triangulation (AO-aware):
┌───────────────────────────────────────┐
│                                       │
│  If ao0 + ao2 > ao1 + ao3:            │
│    Triangulate: (0,1,2), (0,2,3)      │
│  Else:                                │
│    Triangulate: (1,2,3), (1,3,0)      │
│                                       │
│  This prevents "diagonal shadow"      │
│  artifacts on merged quads            │
└───────────────────────────────────────┘
```

---

## Texture Atlas

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          TEXTURE ATLAS BUILDING                                  │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  1. Load Resource Pack                                                       ││
│  │     - Parse pack.mcmeta                                                      ││
│  │     - Load block textures from assets/minecraft/textures/block/              ││
│  │     - Load models from assets/minecraft/models/block/                        ││
│  │     - Load blockstates from assets/minecraft/blockstates/                    ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  2. Collect Textures                                                         ││
│  │     - Walk all blockstate → model → texture references                       ││
│  │     - Deduplicate                                                            ││
│  │     - Handle animated textures (water, lava, fire)                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  3. Build Atlas                                                              ││
│  │                                                                              ││
│  │     ┌─────────────────────────────────────────┐                              ││
│  │     │  1024×1024 or 2048×2048 texture         │                              ││
│  │     │  ┌───┬───┬───┬───┬───┬───┐              │                              ││
│  │     │  │ 0 │ 1 │ 2 │ 3 │ 4 │...│   56×56     │                              ││
│  │     │  ├───┼───┼───┼───┼───┼───┤   tiles     │                              ││
│  │     │  │56 │57 │58 │...│   │   │              │                              ││
│  │     │  ├───┼───┼───┼───┼───┼───┤              │                              ││
│  │     │  │...│   │   │   │   │   │              │                              ││
│  │     │  └───┴───┴───┴───┴───┴───┘              │                              ││
│  │     │                                          │                              ││
│  │     │  Each tile: 16×16 texture + 1px border  │                              ││
│  │     │  Border = mipmapping/filtering padding   │                              ││
│  │     └─────────────────────────────────────────┘                              ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  4. Build Lookup Tables                                                      ││
│  │     - textureIndexLookup: block ID + face → atlas tile index                 ││
│  │     - Used by mesher to compute UV coordinates                               ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Lighting System

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LIGHTING PIPELINE                                   │
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
│  │  2. Per-Vertex Light Sampling                                                ││
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
│  │     │      Sky Light (0-15) →            │                                   ││
│  │     │  ┌─────────────────────────────┐   │                                   ││
│  │     │  │                             │   │                                   ││
│  │     │  │    Precomputed colors       │ ▲ │                                   ││
│  │     │  │    combining sky+block      │ │ │                                   ││
│  │     │  │    with brightness curve    │ │ │                                   ││
│  │     │  │                             │ │ │                                   ││
│  │     │  └─────────────────────────────┘   │                                   ││
│  │     │                      Block Light    │                                   ││
│  │     └────────────────────────────────────┘                                   ││
│  │                                                                              ││
│  │     Brightness curve: level / (4.0 - 3.0 * level)                            ││
│  │     Block light color: warm orange tint                                      ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  4. Fragment Shader                                                          ││
│  │                                                                              ││
│  │     finalColor = textureColor                                                ││
│  │                × aoFactor                   (ambient occlusion)              ││
│  │                × lightmapSample             (from lightmap texture)          ││
│  │                × directionalShade           (face-based: up=1.0, down=0.5)   ││
│  │                × tintColor                  (biome grass/foliage/water)      ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Particle System

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              PARTICLE SYSTEM                                     │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  GPU Instancing Architecture                                                 ││
│  │                                                                              ││
│  │  Single draw call renders up to 5000 particles per type:                     ││
│  │  - Instance attribute: position, velocity, age, size, etc.                   ││
│  │  - Vertex shader: billboard expansion + animation                            ││
│  │  - Fragment shader: atlas lookup + fade                                      ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  Particle Atlas (1024×1024)                                                  ││
│  │                                                                              ││
│  │  - All particle textures packed into single atlas                            ││
│  │  - 32×32 tiles (30 tiles per row)                                            ││
│  │  - Animated particles: multiple frames packed sequentially                   ││
│  │  - Frame selection in shader based on particle age                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  Block Emitters (from WASM meshing)                                          ││
│  │                                                                              ││
│  │  Collected during model meshing:                                             ││
│  │  - Torches → flame + smoke                                                   ││
│  │  - Candles → small_flame + smoke                                             ││
│  │  - Campfires → big_smoke + embers                                            ││
│  │  - Nether portals → portal particles                                         ││
│  │                                                                              ││
│  │  Each emitter has:                                                           ││
│  │  - Position (world coords)                                                   ││
│  │  - Block type (determines particle type + spawn rate)                        ││
│  │  - Offset pattern (specific spawn points within block)                       ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Render Order

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              RENDER ORDER                                        │
│                                                                                  │
│  1. Sky (background)                                                             │
│  2. Solid blocks (opaque)                                                        │
│  3. Model opaque (slabs, stairs, etc.)                                           │
│  4. Model overlay (grass side overlay)                                           │
│  5. Model transparent (glass panes)                                              │
│  6. Glass/leaves (alpha-tested)                                                  │
│  7. Water (transparent, animated)                                                │
│  8. Lava (transparent, animated, emissive)                                       │
│  9. Particles (additive blending)                                                │
│ 10. Beacon beams (additive)                                                      │
│ 11. Clouds (if enabled)                                                          │
│ 12. UI overlay                                                                   │
│                                                                                  │
│  Depth writing:                                                                  │
│  - Opaque: write + test                                                          │
│  - Transparent: test only (sorted back-to-front)                                 │
│  - Additive: test only                                                           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Memory Layout

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SHARED MEMORY (when available)                      │
│                                                                                  │
│  SharedArrayBuffer for lookup tables:                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  isOpaque[4096]      - Block opacity flags                                   ││
│  │  isNonCube[4096]     - Non-cube block flags                                  ││
│  │  isFluid[4096]       - Fluid block flags                                     ││
│  │  isAOTransparent[4096] - AO transparency flags                               ││
│  │  blockColors[4096×3] - Average block colors (for map)                        ││
│  │  textureIndices[4096×6] - Texture atlas indices per face                     ││
│  │  faceTintTypes[4096×6] - Tint type per face                                  ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  Zero-copy sharing between main thread and all workers                           │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              PER-WORKER MEMORY                                   │
│                                                                                  │
│  BinaryGrid (sparse sections):                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  HashMap<SectionKey, [u16; 4096]>                                            ││
│  │  - 16-bit packed: blockId (12 bits) + flags (4 bits)                         ││
│  │  - Only non-air sections stored                                              ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  LightGrid (sparse sections):                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  HashMap<SectionKey, [u8; 4096]>                                             ││
│  │  - 8-bit packed: skyLight (4 bits) + blockLight (4 bits)                     ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  BlockStateGrid (sparse sections):                                               │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │  HashMap<SectionKey, [u16; 4096]>                                            ││
│  │  - State ID for non-cube blocks only                                         ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## What Still Runs on Main Thread

| Task | Location | Timing | Notes |
|------|----------|--------|-------|
| Three.js mesh creation | `_createMesh()` | ~2ms per super-chunk | Creates BufferGeometry + Mesh |
| WebGL buffer uploads | First render of mesh | ~1-5ms | GPU transfer |
| Particle system update | `ParticleSystem.update()` | ~0.5ms/frame | Instance buffer updates |
| Camera controls | `OrbitControls` | ~0.1ms/frame | Input handling |
| React UI updates | Component renders | Variable | React reconciliation |
| Scene management | Add/remove meshes | ~0.1ms per mesh | Scene graph updates |

**Optimization opportunities:**
1. Batch mesh creation across frames (already using requestIdleCallback)
2. Pre-allocate BufferGeometry pools
3. Use OffscreenCanvas for rendering (experimental)

---

## File Structure

```
src/
├── assets/
│   ├── TextureAtlas.js        # Atlas building + UV calculation
│   ├── ParticleAtlas.js       # Particle texture atlas
│   ├── BlockRegistry.js       # Block ID → info mapping
│   ├── StateRegistry.js       # Block state → geometry caching
│   ├── ModelGeometry.js       # Pre-baked model geometry
│   ├── BlockstateResolver.js  # Blockstate → model variant
│   └── ModelResolver.js       # Model inheritance resolution
├── mesh/
│   ├── wasm/
│   │   ├── WasmMesher.js      # WASM bridge (JS side)
│   │   └── pkg/               # Compiled WASM module
│   ├── workers/
│   │   ├── SuperChunkWorker.js    # Full pipeline worker
│   │   └── SuperChunkWorkerPool.js # Worker pool management
│   ├── FastMesher.js          # JS greedy mesher (fallback)
│   ├── ModelMesher.js         # JS model mesher (fallback)
│   ├── ChunkDecoder.js        # NBT → grid conversion
│   └── LightGrid.js           # Light data storage
├── viewer/
│   ├── ChunkManager.js        # Scene + material management
│   ├── ChunkStreamer.js       # Chunk loading coordinator
│   └── SuperChunkManager.js   # 2×2 chunk grouping + meshing
├── wasm-mesher/               # Rust WASM source
│   └── src/
│       ├── lib.rs             # WASM exports
│       ├── mesher/            # Greedy meshing
│       ├── models/            # Model meshing + registry
│       └── grid/              # Sparse grid types
└── particles/
    ├── ParticleSystem.js      # GPU-instanced particles
    └── ParticleEmitter.js     # Block emitter configs
```
