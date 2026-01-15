# Worker-Based Model Meshing Implementation Plan

## Executive Summary

This document describes the challenges and detailed approach for moving Minecraft block model meshing from the main JavaScript thread to Web Workers using WebAssembly (WASM). The goal is to achieve identical visual output while eliminating main-thread model meshing overhead.

## Current Architecture

### Main Thread vs Worker Responsibilities

```
┌──────────────────────────────────────────────────────────────────┐
│                        MAIN THREAD                                │
├──────────────────────────────────────────────────────────────────┤
│ • Three.js scene management                                       │
│ • Material creation and shader compilation                        │
│ • Mesh creation (BufferGeometry, Mesh objects)                   │
│ • Camera/controls handling                                        │
│ • StateRegistry with geometry resolvers                          │
│ • Model meshing from worker grids (CURRENT BOTTLENECK)           │
│ • Particle systems and effects                                    │
└──────────────────────────────────────────────────────────────────┘
                               ↕
┌──────────────────────────────────────────────────────────────────┐
│                     WEB WORKERS (x7)                              │
├──────────────────────────────────────────────────────────────────┤
│ • NBT parsing and chunk decoding                                  │
│ • Binary grid population                                          │
│ • Light grid population                                           │
│ • State grid population (state ID assignment)                     │
│ • WASM greedy meshing (solid, water, lava, glass)                │
│ • Light propagation                                               │
│ • Grid serialization for transfer                                 │
└──────────────────────────────────────────────────────────────────┘
```

### Current Model Meshing Flow

1. **Worker decodes chunks**: Populates `grid`, `stateGrid`, `lightGrid`
2. **Worker does WASM solid meshing**: Solid/water/lava/glass → mesh buffers
3. **Worker serializes grids**: `{ grid, stateGrid, lightGrid, states }` → main thread
4. **Main thread model meshing**: `_buildModelMeshesFromWorkerGrids()` (EXPENSIVE)
   - Deserializes grids
   - Remaps worker state IDs to main thread state IDs
   - Calls `stateRegistry.precomputeAll()` (resolves model JSON, computes geometry)
   - Calls `buildModelMeshesWithInstancing()` (iterates state grid, emits vertices)
5. **Main thread creates Three.js meshes**: BufferGeometry → Mesh

## The Core Problem: State ID Mismatch

### What is a State ID?

Each unique (blockName, properties) combination gets a numeric "state ID":

```javascript
// Examples of block states:
"oak_stairs|facing=north,half=bottom,shape=straight" → StateID 42
"oak_stairs|facing=south,half=top,shape=inner_left"  → StateID 153
"stone_slab|type=top"                                 → StateID 89
"stone_slab|type=bottom"                              → StateID 90
"short_grass|"                                        → StateID 12
```

### The Mismatch Problem

```
┌───────────────────────────────────────────────────────────────────────┐
│                       MAIN THREAD                                      │
├───────────────────────────────────────────────────────────────────────┤
│ 1. preregisterNonCubeBlocks() - registers DEFAULT states only:        │
│    "oak_stairs|" → ID 5                                               │
│    "stone_slab|" → ID 6                                               │
│                                                                       │
│ 2. precomputeAll() - computes geometry for registered states          │
│                                                                       │
│ 3. initModelRegistryV2() - sends to WASM:                             │
│    WASM Model Registry: { 5: oak_stairs_geom, 6: stone_slab_geom }   │
│                                                                       │
│ 4. exportForWorker() - sends states to workers                        │
│    Only exports states WITH geometry (those from step 1)              │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│                          WORKER                                        │
├───────────────────────────────────────────────────────────────────────┤
│ 1. importFromData() - imports main thread states:                     │
│    lookup: { "oak_stairs|" → 5, "stone_slab|" → 6 }                  │
│    nextId: 7                                                          │
│                                                                       │
│ 2. decodeChunk() - encounters block in world:                         │
│    "oak_stairs[facing=north,half=bottom,shape=straight]"             │
│                                                                       │
│ 3. stateRegistry.register() - checks lookup:                          │
│    Key: "oak_stairs|facing=north,half=bottom,shape=straight"         │
│    NOT FOUND in lookup! → Creates NEW ID 7                           │
│                                                                       │
│ 4. State grid contains ID 7, not ID 5                                 │
│                                                                       │
│ 5. WASM mesher: get_model_entry_v2(7) → None! Block not rendered     │
└───────────────────────────────────────────────────────────────────────┘
```

### Why Pre-Registration Fails

Block states can have MANY property combinations:

| Block | Properties | Possible Combinations |
|-------|-----------|----------------------|
| Stairs | facing(4) × half(2) × shape(5) × waterlogged(2) | **80 states** |
| Slab | type(3) × waterlogged(2) | **6 states** |
| Fence | north(2) × south(2) × east(2) × west(2) × waterlogged(2) | **32 states** |
| Wall | up(2) × north(3) × south(3) × east(3) × west(3) × waterlogged(2) | **324 states** |
| Redstone Wire | north(3) × south(3) × east(3) × west(3) × power(16) | **1296 states** |

Pre-registering ALL combinations is impractical:
- Would require loading world data first to know which states exist
- Memory overhead for thousands of geometry variants
- Many states share the same base geometry (just rotated/flipped)

## Previous Attempt Failures

### Attempt 1: Worker WASM Model Meshing with State IDs

**Approach**: Pass state grid to WASM, look up geometry by state ID

**Failure**: State ID mismatch - worker creates different IDs than WASM expects

**Symptoms**:
- Partial blocks (stairs, slabs) missing entirely
- Only default-state blocks rendered
- ~28% pixel mismatch in regression tests

### Attempt 2: Block Name Fallback Lookup

**Approach**: Add `block_name_to_state` HashMap to WASM registry, fall back to block name lookup when state ID not found

**Failure**: WASM mesher only has state ID from state grid, not block name

**Challenge**: Would need to serialize block name mapping for each state ID in the grid

## Proposed Solution: Block-Name-Keyed Geometry Registry

### Key Insight

**Different property combinations of the same block share the SAME base geometry!**

```
oak_stairs[facing=north,half=bottom] → base geometry + rotation transform
oak_stairs[facing=south,half=top]   → base geometry + rotation transform
oak_stairs[facing=west,half=bottom] → base geometry + rotation transform
```

The differences are:
1. **Y-rotation**: Based on `facing` property
2. **Vertical flip**: Based on `half=top` property
3. **Shape variants**: `shape=inner_left`, `shape=outer_right`, etc.

### Architecture Changes

```
┌──────────────────────────────────────────────────────────────────────┐
│                    NEW WASM MODEL REGISTRY                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Block Name Index (HashMap<String, u16>):                            │
│    "oak_stairs"   → index 0                                          │
│    "stone_slab"   → index 1                                          │
│    "short_grass"  → index 2                                          │
│                                                                       │
│  Block Geometry Array (Vec<BlockModelData>):                         │
│    [0] oak_stairs:                                                   │
│        - base_geometry: ModelGeometry (full stair shape)             │
│        - shape_variants: { straight, inner_left, outer_left, ... }   │
│        - has_facing: true                                            │
│        - has_half: true                                              │
│        - flags: MODEL_ROTATION | ...                                 │
│                                                                       │
│    [1] stone_slab:                                                   │
│        - variants: { top, bottom, double }                           │
│        - has_type: true                                              │
│                                                                       │
│    [2] short_grass:                                                  │
│        - base_geometry: ModelGeometry (cross pattern)                │
│        - flags: MODEL_ROTATION | POSITION_OFFSET                     │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    NEW STATE GRID FORMAT                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Per-block entry (32 bits instead of 16):                            │
│    ┌──────────┬──────────┬──────────┬──────────┐                     │
│    │ block_id │ variant  │ rotation │ flags    │                     │
│    │ 12 bits  │ 8 bits   │ 4 bits   │ 8 bits   │                     │
│    └──────────┴──────────┴──────────┴──────────┘                     │
│                                                                       │
│  Where:                                                              │
│    - block_id: Index into Block Geometry Array                       │
│    - variant: Index into block's variant array (shape/type)         │
│    - rotation: Y-rotation (0, 90, 180, 270 degrees)                  │
│    - flags: half=top, waterlogged, powered, lit, etc.               │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Implementation Steps

#### Phase 1: Model Geometry Extraction and Baking

**Goal**: Pre-compute ALL geometry variants for each block type at build time

##### 1.1 Block Model Analysis (`scripts/analyze-block-models.js`)

Create a build-time script that:
1. Parses all blockstate JSON files
2. Identifies unique model variants for each block
3. Extracts which properties affect geometry vs rotation
4. Generates a manifest of block → variants

```javascript
// Output: block-model-manifest.json
{
  "oak_stairs": {
    "geometryProperties": ["shape"],  // These affect actual geometry
    "rotationProperties": ["facing"], // These only rotate the model
    "flipProperties": ["half"],       // These flip the model vertically
    "variants": {
      "straight": { "model": "block/oak_stairs" },
      "inner_left": { "model": "block/oak_stairs_inner" },
      "inner_right": { "model": "block/oak_stairs_inner", "y": 90 },
      "outer_left": { "model": "block/oak_stairs_outer" },
      "outer_right": { "model": "block/oak_stairs_outer", "y": 90 }
    }
  },
  "stone_slab": {
    "geometryProperties": ["type"],
    "variants": {
      "bottom": { "model": "block/stone_slab" },
      "top": { "model": "block/stone_slab_top" },
      "double": { "model": "block/stone" }
    }
  }
}
```

##### 1.2 Geometry Pre-Baking (`scripts/bake-model-geometry.js`)

Generate binary geometry data for each variant:

```javascript
// Output: baked-models.bin
// Format per block:
// [block_name_len: u8][block_name: bytes]
// [num_variants: u8]
// [variant_data...]
//
// Variant data:
// [variant_name_len: u8][variant_name: bytes]
// [num_faces: u16]
// [face_data...] (same format as current)
```

##### 1.3 Load Baked Geometry at Runtime

Instead of resolving models dynamically, load the pre-baked binary:

```javascript
// In WasmMesher.js
async function loadBakedModels() {
  const response = await fetch('/assets/baked-models.bin');
  const buffer = await response.arrayBuffer();
  wasmModule.init_model_registry_from_baked(new Uint8Array(buffer));
}
```

#### Phase 2: New WASM Model Registry

##### 2.1 Rust Data Structures

```rust
// src/wasm-mesher/src/models/registry.rs

/// Property-based variant key (for geometry selection)
#[derive(Hash, Eq, PartialEq, Clone)]
pub struct VariantKey {
    // Only properties that affect geometry, not rotation
    // e.g., for stairs: just "shape"
    // e.g., for slabs: just "type"
    properties: Vec<(String, String)>,
}

/// Geometry for a single block variant
pub struct BlockVariant {
    pub geometry: ModelGeometry,
    pub flags: u8,
}

/// All data for a single block type
pub struct BlockModelData {
    pub block_name: String,
    pub variants: HashMap<VariantKey, BlockVariant>,
    pub default_variant: VariantKey,
    
    // Property interpretation
    pub facing_property: Option<String>,    // Property for Y-rotation
    pub half_property: Option<String>,      // Property for vertical flip
    pub rotation_property: Option<String>,  // Property for explicit rotation value
}

/// The new registry - keyed by block name
pub struct BlockModelRegistry {
    // Block name → index
    name_to_index: HashMap<String, u16>,
    // Index → block data
    blocks: Vec<BlockModelData>,
}

impl BlockModelRegistry {
    pub fn get_by_name(&self, name: &str) -> Option<&BlockModelData> {
        self.name_to_index.get(name)
            .and_then(|&idx| self.blocks.get(idx as usize))
    }
    
    pub fn get_variant(&self, name: &str, properties: &[(String, String)]) -> Option<&BlockVariant> {
        let block = self.get_by_name(name)?;
        let key = block.make_variant_key(properties);
        block.variants.get(&key)
            .or_else(|| block.variants.get(&block.default_variant))
    }
}
```

##### 2.2 New State Grid Format

```rust
// src/wasm-mesher/src/grid/model_state_grid.rs

/// Packed model state (32 bits)
#[derive(Clone, Copy, Default)]
pub struct ModelState {
    // Bit layout:
    // [0-11]: Block index (12 bits, 4096 blocks)
    // [12-19]: Variant index (8 bits, 256 variants)
    // [20-23]: Rotation (4 bits, 0/90/180/270)
    // [24-31]: Flags (8 bits: half, waterlogged, lit, powered, etc.)
    packed: u32,
}

impl ModelState {
    pub fn new(block_idx: u16, variant_idx: u8, rotation: u8, flags: u8) -> Self {
        Self {
            packed: (block_idx as u32 & 0xFFF)
                  | ((variant_idx as u32 & 0xFF) << 12)
                  | ((rotation as u32 & 0xF) << 20)
                  | ((flags as u32 & 0xFF) << 24),
        }
    }
    
    pub fn block_index(&self) -> u16 { (self.packed & 0xFFF) as u16 }
    pub fn variant_index(&self) -> u8 { ((self.packed >> 12) & 0xFF) as u8 }
    pub fn rotation(&self) -> u8 { ((self.packed >> 20) & 0xF) as u8 }
    pub fn is_flipped(&self) -> bool { (self.packed >> 24) & 0x01 != 0 }
    pub fn is_waterlogged(&self) -> bool { (self.packed >> 25) & 0x01 != 0 }
}

pub struct ModelStateGrid {
    sections: HashMap<SectionKey, Box<[ModelState; 4096]>>,
}
```

#### Phase 3: Worker State Grid Population

##### 3.1 Block Name to Index Lookup

Workers need a mapping from block name → block index:

```javascript
// In SuperChunkWorker.js

// Received from main thread at init
let blockNameToIndex = new Map();  // "oak_stairs" → 5
let blockVariantLookup = new Map(); // "oak_stairs" → { "straight": 0, "inner_left": 1, ... }

function initBlockModelLookup(data) {
  for (const [name, idx] of data.nameToIndex) {
    blockNameToIndex.set(name, idx);
  }
  for (const [name, variants] of data.variants) {
    blockVariantLookup.set(name, new Map(Object.entries(variants)));
  }
}
```

##### 3.2 Decoding Properties to ModelState

```javascript
// In SuperChunkWorker.js - during chunk decoding

function getModelState(blockName, properties) {
  const blockIdx = blockNameToIndex.get(blockName);
  if (blockIdx === undefined) return 0; // Not a model block
  
  const variants = blockVariantLookup.get(blockName);
  if (!variants) return 0;
  
  // Get variant index based on geometry-affecting properties
  const variantKey = getVariantKey(blockName, properties);
  const variantIdx = variants.get(variantKey) ?? 0;
  
  // Get rotation from facing property
  const rotation = getRotationFromFacing(properties.facing);
  
  // Pack flags
  let flags = 0;
  if (properties.half === 'top') flags |= 0x01;
  if (properties.waterlogged === 'true') flags |= 0x02;
  if (properties.lit === 'true') flags |= 0x04;
  
  // Pack into 32-bit value
  return (blockIdx & 0xFFF)
       | ((variantIdx & 0xFF) << 12)
       | ((rotation & 0xF) << 20)
       | ((flags & 0xFF) << 24);
}

function getVariantKey(blockName, properties) {
  // Block-specific logic to extract geometry-affecting properties
  switch (blockName) {
    case 'oak_stairs':
    case 'stone_stairs':
    // ... all stair types
      return properties.shape || 'straight';
    
    case 'stone_slab':
    case 'oak_slab':
    // ... all slab types
      return properties.type || 'bottom';
    
    default:
      return '';
  }
}

function getRotationFromFacing(facing) {
  switch (facing) {
    case 'north': return 0;
    case 'east': return 1;  // 90°
    case 'south': return 2; // 180°
    case 'west': return 3;  // 270°
    default: return 0;
  }
}
```

#### Phase 4: WASM Model Meshing with New Format

##### 4.1 Updated Mesher

```rust
// src/wasm-mesher/src/models/mesher.rs

pub fn mesh_models_v3(
    grid: &BinaryGrid,
    model_state_grid: &ModelStateGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    registry: &BlockModelRegistry,
    bounds: Option<&MeshBounds>,
) -> ModelMeshResult {
    let mut result = ModelMeshResult::new();
    
    for (key, section) in model_state_grid.iter_sections() {
        if !is_in_bounds(key, bounds) { continue; }
        
        let base_x = key.chunk_x * 16;
        let base_y = key.section_y * 16 - 64;
        let base_z = key.chunk_z * 16;
        
        for idx in 0..4096 {
            let state = section[idx];
            if state.packed == 0 { continue; }
            
            let block_idx = state.block_index();
            let variant_idx = state.variant_index();
            let rotation = state.rotation();
            let is_flipped = state.is_flipped();
            
            // Get block data from registry by index
            let block = match registry.blocks.get(block_idx as usize) {
                Some(b) => b,
                None => continue,
            };
            
            // Get variant geometry by index
            let variant = match block.get_variant_by_index(variant_idx) {
                Some(v) => v,
                None => continue,
            };
            
            let (local_x, local_y, local_z) = index_to_local(idx);
            let world_x = base_x + local_x as i32;
            let world_y = base_y + local_y as i32;
            let world_z = base_z + local_z as i32;
            
            // Get light at this position
            let (sky_light, block_light) = get_light(light_grid, world_x, world_y, world_z);
            
            // Apply smooth lighting / AO per vertex
            let vertex_lights = calculate_vertex_lighting(
                &variant.geometry,
                world_x, world_y, world_z,
                light_grid, grid, lookups,
                rotation, is_flipped
            );
            
            // Select target mesh
            let target = if variant.flags & IS_OVERLAY != 0 {
                &mut result.overlay
            } else if variant.flags & IS_TRANSPARENT != 0 {
                &mut result.transparent
            } else {
                &mut result.opaque
            };
            
            // Emit faces with rotation/flip applied
            for (face_idx, face) in variant.geometry.faces.iter().enumerate() {
                if should_cull_face(grid, lookups, world_x, world_y, world_z, face, rotation) {
                    continue;
                }
                
                emit_face(
                    target,
                    face,
                    world_x as f32, world_y as f32, world_z as f32,
                    rotation,
                    is_flipped,
                    &vertex_lights[face_idx],
                    variant.flags,
                );
            }
        }
    }
    
    result
}
```

##### 4.2 Per-Vertex Smooth Lighting for Models

This is critical for visual quality - models need the same smooth lighting/AO as solid blocks:

```rust
// src/wasm-mesher/src/models/lighting.rs

/// Calculate per-vertex lighting with AO for model faces
fn calculate_vertex_lighting(
    geometry: &ModelGeometry,
    world_x: i32, world_y: i32, world_z: i32,
    light_grid: Option<&LightGrid>,
    grid: &BinaryGrid,
    lookups: &Lookups,
    rotation: u8,
    is_flipped: bool,
) -> Vec<[VertexLight; 4]> {
    let mut result = Vec::with_capacity(geometry.faces.len());
    
    for face in &geometry.faces {
        let mut vertex_lights = [VertexLight::default(); 4];
        
        for (v_idx, vertex) in face.vertices.iter().enumerate() {
            // Transform vertex position by rotation/flip
            let (vx, vy, vz) = transform_vertex(*vertex, rotation, is_flipped);
            
            // Get world position of this vertex
            let vwx = world_x as f32 + vx;
            let vwy = world_y as f32 + vy;
            let vwz = world_z as f32 + vz;
            
            // Sample smooth light at vertex position
            // Uses the face normal to determine which neighbors to sample
            let normal = transform_normal(face.normal, rotation, is_flipped);
            
            vertex_lights[v_idx] = sample_smooth_light_for_model(
                vwx, vwy, vwz,
                normal,
                light_grid,
                grid,
                lookups,
            );
        }
        
        result.push(vertex_lights);
    }
    
    result
}

/// Sample smooth light at a vertex position, considering face direction
fn sample_smooth_light_for_model(
    vx: f32, vy: f32, vz: f32,
    normal: [f32; 3],
    light_grid: Option<&LightGrid>,
    grid: &BinaryGrid,
    lookups: &Lookups,
) -> VertexLight {
    let light_grid = match light_grid {
        Some(lg) => lg,
        None => return VertexLight { sky: 15, block: 0, ao: 1.0 },
    };
    
    // Determine primary face direction from normal
    let (primary_axis, positive) = get_primary_axis(normal);
    
    // Sample 4 positions around the vertex in the plane perpendicular to normal
    // This gives smooth transitions at edges
    let (offsets, ao_neighbors) = get_vertex_sample_offsets(primary_axis, positive);
    
    let mut sky_sum = 0.0;
    let mut block_sum = 0.0;
    let mut count = 0.0;
    let mut solid_count = 0;
    
    for (dx, dy, dz) in offsets {
        let sx = (vx + dx).floor() as i32;
        let sy = (vy + dy).floor() as i32;
        let sz = (vz + dz).floor() as i32;
        
        // Check if position is solid (for AO)
        let block_id = grid.get(sx, sy, sz);
        if is_solid_for_ao(block_id, lookups) {
            solid_count += 1;
            continue;
        }
        
        let light = light_grid.get_light(sx, sy, sz);
        sky_sum += light.sky_light as f32;
        block_sum += light.block_light as f32;
        count += 1.0;
    }
    
    // Calculate AO factor from solid neighbor count
    let ao = calculate_ao_factor(solid_count);
    
    if count > 0.0 {
        VertexLight {
            sky: (sky_sum / count).round() as u8,
            block: (block_sum / count).round() as u8,
            ao,
        }
    } else {
        // All neighbors solid - use default dark
        VertexLight { sky: 0, block: 0, ao }
    }
}

/// AO factors matching Minecraft's algorithm
fn calculate_ao_factor(solid_count: u8) -> f32 {
    match solid_count {
        0 => 1.0,
        1 => 0.9,
        2 => 0.8,
        3 => 0.65,
        _ => 0.4,
    }
}
```

#### Phase 5: Serialization and Transfer

##### 5.1 Model State Grid Serialization

```javascript
// In SuperChunkWorker.js

function serializeModelStateGrid(modelStateGrid) {
  if (!modelStateGrid || modelStateGrid.sections.size === 0) {
    return new Uint8Array(4); // Just count = 0
  }
  
  const sections = [...modelStateGrid.sections.entries()];
  // 4 bytes per state × 4096 states per section + 8 byte key
  const totalSize = 4 + sections.length * (8 + 4096 * 4);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const u32View = new Uint32Array(buffer);
  
  view.setUint32(0, sections.length, true);
  
  let offset = 4;
  for (const [key, section] of sections) {
    // Pack section key
    // ... (same as current state grid)
    offset += 8;
    
    // Copy 32-bit states
    for (let i = 0; i < 4096; i++) {
      view.setUint32(offset, section[i], true);
      offset += 4;
    }
  }
  
  return new Uint8Array(buffer);
}
```

##### 5.2 Main Thread Initialization

```javascript
// In SuperChunkManager.js

async _initBlockModelRegistry() {
  // Load pre-baked model geometry
  const bakedModels = await fetch('/assets/baked-models.bin');
  const modelData = await bakedModels.arrayBuffer();
  
  // Initialize WASM registry
  wasmModule.init_block_model_registry(new Uint8Array(modelData));
  
  // Build lookup tables for workers
  const nameToIndex = new Map();
  const variantLookup = new Map();
  
  for (const [name, blockData] of wasmModule.get_block_model_info()) {
    nameToIndex.set(name, blockData.index);
    variantLookup.set(name, blockData.variants);
  }
  
  // Send to worker pool
  await this.workerPool.initialize({
    blockModelLookup: {
      nameToIndex: [...nameToIndex.entries()],
      variants: [...variantLookup.entries()],
    }
  });
}
```

## Ambient Occlusion for Models

### The Challenge

Model blocks have arbitrary geometry, not just axis-aligned faces. AO must be calculated for each vertex based on:

1. The vertex position (which neighbors to sample)
2. The face normal (which direction is "outward")
3. Neighboring solid blocks (which cause occlusion)

### Vertex-to-Neighbor Mapping

For each vertex, we sample a 2×2 area in the plane perpendicular to the face normal:

```
Face pointing UP (+Y):
    Sample around vertex at Y+1:
    ┌───┬───┐
    │ 1 │ 2 │   1 = (x-1, y+1, z-1)
    ├───┼───┤   2 = (x,   y+1, z-1)
    │ 3 │ 4 │   3 = (x-1, y+1, z)
    └───┴───┘   4 = (x,   y+1, z)

Face pointing EAST (+X):
    Sample around vertex at X+1:
    Similar 2×2 in YZ plane
```

### AO-Transparent Blocks

Certain blocks should NOT cause AO darkening:
- Glass panes
- Leaves (with Fancy graphics)
- Fences and walls
- Flowers and grass

This list is stored in `Lookups::is_ao_transparent`.

## Risk Assessment and Mitigations

### Risk 1: Visual Regression

**Concern**: Model meshes look different after the change

**Mitigation**:
- Comprehensive regression test suite with pixel-level comparison
- Separate test cases for each block category (stairs, slabs, fences, plants)
- A/B comparison tool for visual inspection
- Keep JS fallback path for debugging

### Risk 2: Performance Regression

**Concern**: New format or algorithm is slower

**Mitigation**:
- Benchmark against current implementation
- Profile WASM with `console.time` / `performance.now`
- Optimize hot paths (vertex transformation, light sampling)
- Consider SIMD for batch operations

### Risk 3: Memory Overhead

**Concern**: Pre-baked geometry increases memory usage

**Mitigation**:
- Only bake geometry, not textures (already in atlas)
- Share geometry across variants where possible
- Compress baked data with gzip
- Lazy-load less common block models

### Risk 4: Complex State Mapping Bugs

**Concern**: Property-to-variant mapping has edge cases

**Mitigation**:
- Generate mapping from Minecraft source
- Validate against known block state combinations
- Unit tests for each block type's mapping logic
- Log warnings for unmapped states

## Implementation Timeline

### Week 1: Analysis and Tooling
- [ ] Build-time model analysis script
- [ ] Generate block-model-manifest.json
- [ ] Validate manifest against Minecraft wiki

### Week 2: Geometry Baking
- [ ] Implement geometry baking script
- [ ] Generate baked-models.bin
- [ ] Verify binary format correctness

### Week 3: WASM Registry
- [ ] New Rust data structures
- [ ] Binary loading in WASM
- [ ] Unit tests for registry

### Week 4: Model State Grid
- [ ] New 32-bit state format
- [ ] Worker-side state population
- [ ] Serialization/deserialization

### Week 5: WASM Meshing
- [ ] Implement mesh_models_v3
- [ ] Rotation/flip transformations
- [ ] Basic lighting (no AO)

### Week 6: Smooth Lighting and AO
- [ ] Per-vertex light sampling
- [ ] AO calculation
- [ ] Visual regression testing

### Week 7: Integration and Testing
- [ ] End-to-end integration
- [ ] Performance benchmarks
- [ ] Bug fixes and polish

### Week 8: Cleanup and Documentation
- [ ] Remove old code paths
- [ ] Update architecture docs
- [ ] Final testing

## Success Criteria

1. **All regression tests pass** with <0.1% pixel difference
2. **No model blocks missing** from the render
3. **Smooth lighting quality** matches main-thread implementation
4. **AO applied correctly** to all model vertices
5. **Performance improvement**: Model meshing time reduced by >50%
6. **Main thread freed**: No model mesh building on main thread
7. **Memory stable**: No memory leaks or excessive growth

## Appendix: Block Categories and Handling

### Simple Cross Models (Identical Geometry)
- short_grass, tall_grass, fern, dead_bush
- All flowers (poppy, dandelion, etc.)
- Saplings
- Small mushrooms
- **Handling**: Single geometry, position-based rotation

### Directional Models (Rotation Only)
- Torches (wall/standing)
- Ladders
- Signs
- Buttons
- Levers
- **Handling**: Single geometry per type, facing-based rotation

### Variant Models (Different Geometry)
- Stairs (5 shapes × rotation × flip)
- Slabs (top/bottom/double)
- Fences (16 combinations)
- Walls (complex combinations)
- Doors (many states)
- **Handling**: Variant lookup table, rotation applied after

### Multi-Part Models (Composed)
- Fences with connections
- Walls with connections
- Redstone wire
- **Handling**: Combine multiple geometries based on connection states

### Special Cases
- Beacons (particle emitters)
- Enchanting tables (animated book - skip for now)
- Beds (multi-block)
- Chests (multi-block, animated)
- **Handling**: Case-by-case implementation
