# WASM Model Mesher Plan

## Problem Statement

Model meshes (slabs, stairs, fences, doors, plants, etc.) are currently generated in JavaScript. These are often **more complex than solid blocks**:

- Each model can have multiple faces with arbitrary orientations
- State-dependent geometry (open/closed doors, stair shapes, fence connections)
- Requires model geometry lookup and face culling
- More CPU-intensive per block than greedy-meshable cubes

## Current Architecture (JS)

```
JS: Parse NBT → Decode to Grid + StateGrid → ModelMesher.js → Mesh Buffers
                                                    ↓
                                           StateRegistry.js (model lookup)
                                                    ↓
                                           BlockstateResolver.js (state → model)
                                                    ↓
                                           ModelResolver.js (model → geometry)
```

**Key data structures:**

- `BlockStateGrid`: Maps block positions → state IDs (u16)
- `StateRegistry`: Maps state IDs → model geometry
- Model geometry: faces with positions, UVs, normals, texture references

## Proposed WASM Architecture

```
JS: Parse NBT → Extract Palette + State Strings → WASM: Decode + Model Mesh
                        ↓
              Init model registry once (geometry data)
```

### Phase 1: State Registry in WASM

Create `src/wasm-mesher/src/models/registry.rs`:

```rust
/// Model geometry for a single block state
pub struct ModelGeometry {
    /// Faces grouped by direction (for culling)
    pub faces: Vec<ModelFace>,
    /// Whether this model is full cube (for neighbor culling)
    pub is_full_cube: bool,
    /// Whether model is transparent (affects neighbor face culling)
    pub is_transparent: bool,
}

pub struct ModelFace {
    pub direction: Face,         // Which face this belongs to (for culling)
    pub vertices: [[f32; 3]; 4], // 4 corners
    pub uvs: [[f32; 2]; 4],      // UV coordinates
    pub texture_index: u16,      // Texture atlas index
    pub tint_type: u8,           // 0=none, 1=grass, 2=foliage, 3=water
}

/// Initialize model registry from JS
/// Called once after loading block models
#[wasm_bindgen]
pub fn init_model_registry(
    state_ids: &[u16],           // State ID for each model
    geometry_data: &[u8],        // Serialized model geometry
) { ... }
```

### Phase 2: Block State Decoding in WASM

Update `src/wasm-mesher/src/decode/mod.rs`:

```rust
/// Extended decode result with state grid
pub struct DecodeResult {
    pub blocks_decoded: u32,
    pub grid: BinaryGrid,
    pub light_grid: LightGrid,
    pub state_grid: BlockStateGrid,  // NEW: state IDs for model blocks
}

/// Decode palette entry to state ID
fn resolve_state_id(name: &str, properties: &BlockProperties) -> u16 {
    // Build state string: "minecraft:oak_stairs[facing=north,half=bottom,shape=straight]"
    // Look up in state registry
    STATE_REGISTRY.get_state_id(name, properties)
}
```

### Phase 3: Model Mesher in WASM

Create `src/wasm-mesher/src/mesher/model.rs`:

```rust
/// Mesh non-cube blocks (slabs, stairs, fences, etc.)
pub fn mesh_models(
    grid: &BinaryGrid,
    state_grid: &BlockStateGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    bounds: Option<&MeshBounds>,
) -> ModelMeshResult {
    let mut result = ModelMeshResult::new();
    
    for (key, section) in state_grid.iter_sections() {
        if !in_bounds(key, bounds) { continue; }
        
        for i in 0..SECTION_VOLUME {
            let state_id = section[i];
            if state_id == 0 { continue; }
            
            let (x, y, z) = index_to_world(key, i);
            
            // Get model geometry
            let model = MODEL_REGISTRY.get(state_id);
            if model.is_none() { continue; }
            
            // Cull faces based on neighbors
            for face in &model.faces {
                if should_cull_face(grid, x, y, z, face.direction) {
                    continue;
                }
                
                // Add face to mesh
                emit_face(&mut result, face, x, y, z, light_grid);
            }
        }
    }
    
    result
}
```

### Phase 4: Particle Emitter Collection

```rust
/// Block types that emit particles
static PARTICLE_EMITTERS: &[(&str, ParticleType)] = &[
    ("minecraft:torch", ParticleType::Flame),
    ("minecraft:campfire", ParticleType::CampfireSmoke),
    ("minecraft:lava", ParticleType::LavaDroplets),
    // ...
];

/// Collect particle emitter positions during decode
pub fn collect_emitters(
    grid: &BinaryGrid,
    bounds: Option<&MeshBounds>,
) -> Vec<ParticleEmitter> {
    // Iterate grid, check block types, return positions + types
}
```

## Implementation Steps

### Step 1: Serialize Model Geometry (JS → WASM)

In `StateRegistry.js`, add method to export all model geometry:

```javascript
export function serializeModelGeometry() {
  const stateIds = [];
  const geometryChunks = [];
  
  for (const [stateId, model] of stateRegistry.entries()) {
    stateIds.push(stateId);
    geometryChunks.push(serializeModel(model));
  }
  
  return {
    stateIds: new Uint16Array(stateIds),
    geometryData: concatenateGeometry(geometryChunks),
  };
}
```

### Step 2: WASM State/Model Registry

```rust
// src/wasm-mesher/src/models/mod.rs
mod registry;
mod geometry;

pub use registry::{init_model_registry, get_model_geometry};
pub use geometry::{ModelGeometry, ModelFace};
```

### Step 3: State Grid in WASM

```rust
// src/wasm-mesher/src/grid/state_grid.rs
pub struct BlockStateGrid {
    sections: HashMap<u64, Box<[u16; SECTION_VOLUME]>>,
}
```

### Step 4: State Resolution During Decode

```rust
// During palette preprocessing, resolve state strings to state IDs
fn preprocess_palette_with_states(palette: &[PaletteEntry]) -> ProcessedPaletteWithStates {
    // For model blocks, compute state ID from name + properties
    // Store in ProcessedPaletteWithStates.state_ids
}
```

### Step 5: Model Mesher Entry Point

```rust
#[wasm_bindgen]
pub fn process_chunk_with_models(
    compressed_data: &[u8],
    compression_type: u8,
    chunk_x: i32,
    chunk_z: i32,
) -> ProcessedChunkWithModels {
    // ... decompress, parse, decode ...
    
    // Mesh solids (existing)
    let solid = mesh_solid(&grid, light_grid.as_ref(), &lookups, bounds);
    
    // Mesh models (NEW)
    let models = mesh_models(&grid, &state_grid, light_grid.as_ref(), &lookups, bounds);
    
    // Collect particle emitters (NEW)
    let emitters = collect_emitters(&grid, bounds);
    
    ProcessedChunkWithModels {
        solid, water, lava, glass,
        models,
        emitters,
    }
}
```

## Data Transfer Optimization

### Option A: Pre-bake Models in WASM Memory

Initialize all ~2000 model geometries once at startup:

- JS serializes all models → ~2-5MB
- WASM stores in static memory
- Zero per-chunk model lookup cost

### Option B: Lazy Model Loading

Only transfer models as needed:

- Smaller initial load
- Cache hits for common blocks
- Slightly slower first render

**Recommendation: Option A** - Minecraft has finite models, pre-baking is worth the upfront cost.

## File Changes Summary

| File | Change Type | Description |

|------|-------------|-------------|

| `src/wasm-mesher/Cargo.toml` | Modify | Add dependencies if needed |

| `src/wasm-mesher/src/lib.rs` | Modify | Add model module, new entry points |

| `src/wasm-mesher/src/models/mod.rs` | **Create** | Model module |

| `src/wasm-mesher/src/models/registry.rs` | **Create** | State → Model registry |

| `src/wasm-mesher/src/models/geometry.rs` | **Create** | Model geometry types |

| `src/wasm-mesher/src/models/mesher.rs` | **Create** | Model meshing algorithm |

| `src/wasm-mesher/src/grid/state_grid.rs` | Modify | Add WASM state grid |

| `src/wasm-mesher/src/decode/mod.rs` | Modify | Decode block states |

| `src/assets/StateRegistry.js` | Modify | Add geometry serialization |

| `src/mesh/wasm/WasmMesher.js` | Modify | Add model registry init |

| `src/viewer/SuperChunkManager.js` | Modify | Use WASM model mesher |

## Expected Performance Impact

| Metric | Current (JS) | After (WASM) |

|--------|--------------|--------------|

| Model decode time | ~40-80ms | ~10-20ms |

| Model mesh time | ~60-120ms | ~15-30ms |

| Memory copies | 2 (grid + state) | 0 (internal) |

| Total model processing | ~100-200ms | ~25-50ms |

## Risk Mitigation

| Risk | Mitigation |

|------|------------|

| Model geometry size | Use compact binary format, ~50 bytes/face |

| State string complexity | Pre-compute state IDs in JS, pass as lookup table |

| WASM binary bloat | Models stored as data, not code |

| Fallback needed | Keep JS ModelMesher.js as fallback |

## Implementation Order

1. **Create state grid in WASM** (extends existing grid module)
2. **Add state resolution to decoder** (extends existing decode)
3. **Create model registry** (new module, init from JS)
4. **Implement model mesher** (new module)
5. **Add particle emitter collection** (simple block type check)
6. **Update JS integration** (init registry, use new entry point)
7. **Remove JS fallback** (after validation)

---

## Quick Start: Minimal Implementation

For fastest time-to-value, implement in this order:

### Week 1: State Grid + State Resolution

- Add `BlockStateGrid` to WASM
- Decode block states during `decode_chunk`
- Return state grid in `ProcessedChunk`

### Week 2: Model Registry

- Serialize model geometry in JS
- `init_model_registry()` in WASM
- Store models in static HashMap

### Week 3: Model Mesher

- Implement `mesh_models()` 
- Face culling against solid blocks
- Light sampling at vertices

### Week 4: Integration + Particles

- Update `SuperChunkManager` to use new pipeline
- Add particle emitter collection
- Performance validation