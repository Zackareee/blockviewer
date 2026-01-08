# Agent Reference Documentation

This folder contains documentation to help AI assistants understand the key code flows in the Block Viewer application.

## Quick Reference

### File Loading Flows
| Flow | Description | Doc |
|------|-------------|-----|
| **Region Files (.mca)** | Direct loading of Minecraft region files | [loading_region_files.md](./loading_region_files.md) |
| **World Files (.zip)** | Loading zipped Minecraft world saves | [loading_world_files.md](./loading_world_files.md) |
| **Texture Packs** | Vanilla and custom resource pack loading | [texture_pack_loading.md](./texture_pack_loading.md) |

### Chunk Loading Modes
| Mode | Description | Doc |
|------|-------------|-----|
| **Chunk Streaming** | Player-centric progressive loading (default) | [chunk_streaming.md](./chunk_streaming.md) |
| **Non-Streaming** | Load all regions at once (legacy) | [non_streaming_loading.md](./non_streaming_loading.md) |

### Meshing Pipelines
| Pipeline | Description | Doc |
|----------|-------------|-----|
| **WASM Meshing** | High-performance Rust/WebAssembly meshing | [wasm_meshing.md](./wasm_meshing.md) |
| **JS Meshing** | Pure JavaScript fallback | [js_meshing.md](./js_meshing.md) |

## Architecture Overview

```
User selects file(s)
       ↓
  ┌────────────────────┐
  │ .mca or .zip?      │
  └────────────────────┘
       ↓.mca           ↓.zip
  Direct loading    Lazy extraction
       ↓                 ↓
       └────────┬────────┘
                ↓
    Process region files
                ↓
        Store in state
                ↓
    ┌───────────────────────┐
    │ Chunk streaming mode? │
    └───────────────────────┘
       ↓yes              ↓no
   ChunkStreamer     ChunkManager
   (on-demand)       (all at once)
       ↓                 ↓
   SuperChunkManager    RegionMeshBuilder
       ↓                 ↓
    ┌────────────────────┐
    │ WASM available?    │
    └────────────────────┘
       ↓yes          ↓no
   WASM mesher    JS FastMesher
       ↓                ↓
       └────────┬───────┘
                ↓
    Three.js meshes created
                ↓
    Render in WebGL
```

## Key Files by Area

### Entry Points
- `src/App.jsx` - Main application, file handling, state management
- `src/viewer/RegionViewer.jsx` - Three.js canvas, camera, rendering

### Loading
- `src/viewer/ChunkStreamer.js` - Player-centric chunk streaming
- `src/viewer/ChunkManager.js` - Scene management, materials
- `src/viewer/SuperChunkManager.js` - 2x2 chunk grouping, mesh building

### Meshing
- `src/mesh/FastMesher.js` - JS greedy meshing
- `src/mesh/ModelMesher.js` - Non-cube block models
- `src/mesh/wasm/WasmMesher.js` - WASM bridge
- `src/wasm-mesher/src/lib.rs` - Rust WASM implementation

### Data Structures
- `src/mesh/BinaryGrid.js` - Block ID storage
- `src/mesh/BlockStateGrid.js` - Block state storage
- `src/mesh/LightGrid.js` - Light level storage
- `src/mesh/BlockRegistry.js` - Block name ↔ ID mapping

### Assets
- `src/assets/TexturePackManager.js` - Resource pack loading
- `src/assets/TextureAtlas.js` - Texture stitching
- `src/assets/TextureIndexLookup.js` - Block → texture mapping
- `src/assets/ModelResolver.js` - JSON model parsing
- `src/assets/BlockstateResolver.js` - Block state variants

## Common Configuration Props

### App.jsx State
```javascript
chunkStreamingEnabled   // true = streaming mode, false = load all
enableModelMeshes       // true = render slabs/stairs/etc
enableLighting          // true = smooth lighting, false = flat
renderDistance          // chunks visible around player
particleQuality         // 'all', 'decreased', 'minimal', 'off'
```

### RegionViewer Props
```javascript
regions                 // Array of { file, regionX, regionZ }
enableChunkStreaming    // Use ChunkStreamer
chunkStreamDistance     // Load radius in chunks
enableLOD               // Level of detail for distant blocks
textureAtlas            // Texture atlas material data
```

## Debugging Tips

1. **Check console for flow**: Key components log their state
   - `[ChunkStreamer]` - Streaming operations
   - `[SuperChunkManager]` - Mesh building
   - `[WasmMesher]` - WASM status

2. **WASM not loading**: Check browser console for WASM errors

3. **Meshes not appearing**: Verify textureAtlas is loaded before regions

4. **Performance issues**: Try disabling smooth lighting or reducing render distance

