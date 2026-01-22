# Critical Fix: Model Triangle Explosion

## Problem Statement

With 8-chunk render distance:
- **40 million triangles** total
- **91% from model meshes** (36.4M triangles)
- **5 FPS** render performance
- **4GB+ memory** usage

The solid block meshing is fine. The problem is model blocks.

## Root Cause Analysis

### Why So Many Model Triangles?

1. **No LOD applied** - `mesh_models_v3` doesn't use the `lod_level` parameter
2. **Every block renders at full detail** - A grass cross is 8 triangles, a stair is 30+ triangles
3. **No distance culling** - Model blocks at edge of render distance are full detail
4. **Instancing not working** - GPU instancing code exists but isn't being used effectively

### Math: Triangle Count

For a typical grassy area (50% model blocks):
- 8-chunk radius = 17×17 = 289 chunks
- 289 chunks × 16×256×16 blocks = ~19 million blocks per region
- ~50% model blocks = ~10 million model blocks
- Average ~4 triangles per model block = **40 million triangles** ✓

This matches the observed behavior exactly.

## Solution: Aggressive Model LOD

### LOD Levels to Implement

| LOD | Distance | What to Skip | Triangle Reduction |
|-----|----------|--------------|-------------------|
| 0 | 0-32 blocks | Nothing | 0% |
| 1 | 32-64 blocks | Small plants (1-block) | ~40% |
| 2 | 64-128 blocks | All cross-models, flowers | ~70% |
| 3 | 128+ blocks | All models except stairs/slabs | ~90% |

### Distance-Based Section Selection

Instead of meshing everything at LOD 0, apply LOD per super-chunk:

```javascript
// In SuperChunkWorker.js
const distanceToCamera = calculateDistance(superChunk, cameraPosition);
const lodLevel = 
    distanceToCamera < 32 ? 0 :
    distanceToCamera < 64 ? 1 :
    distanceToCamera < 128 ? 2 : 3;

// Call WASM with LOD
wasmModule.mesh_models_v3_with_lod(
    gridData, lightData, modelStateData,
    bounds.minChunkX, bounds.minChunkZ, bounds.maxChunkX, bounds.maxChunkZ,
    lodLevel  // <-- ADD THIS
);
```

### Blocks to Skip by LOD

**LOD 1 - Skip small 1-block plants:**
- short_grass, fern
- poppy, dandelion, blue_orchid, allium, azure_bluet
- red_tulip, orange_tulip, white_tulip, pink_tulip
- oxeye_daisy, cornflower, lily_of_the_valley, wither_rose
- dead_bush
- small mushrooms
- saplings

**LOD 2 - Skip all cross-models:**
- All LOD 1 blocks
- tall_grass, large_fern (2-block tall)
- nether_sprouts, crimson_roots, warped_roots
- hanging_roots
- torch (keep torches visible for navigation)

**LOD 3 - Essential structures only:**
- stairs (need for navigation)
- slabs (structural)
- doors (need to see)
- fences/walls (structural)
- Skip everything else

## Implementation Plan

### Phase 1: Add LOD to WASM Meshing (Immediate Impact)

1. **Update `mesh_models_v3` to accept LOD**:
```rust
// In lib.rs
#[wasm_bindgen]
pub fn mesh_models_v3(
    grid_data: &[u8],
    light_data: &[u8],
    model_state_data: &[u8],
    min_chunk_x: i32,
    min_chunk_z: i32,
    max_chunk_x: i32,
    max_chunk_z: i32,
    lod_level: u8,  // ADD THIS
) -> ModelMeshResultWasm
```

2. **Implement LOD filtering in mesher_v3.rs**:
```rust
// In mesh_models_v3
fn should_skip_for_lod(block_name: &str, lod_level: u8) -> bool {
    match lod_level {
        0 => false,  // Full detail
        1 => is_small_plant(block_name),
        2 => is_cross_model(block_name),
        3 => !is_structural_model(block_name),
        _ => false,
    }
}
```

3. **Update SuperChunkWorker.js to pass LOD**:
```javascript
// Calculate LOD based on distance
const lodLevel = getLodForDistance(superChunkCenter, cameraPos);
wasmModule.mesh_models_v3(
    ...,
    lodLevel
);
```

### Phase 2: GPU Instancing for Remaining Plants

For LOD 0 chunks (near camera), use GPU instancing for repeated blocks:

1. **Collect instances instead of meshing**:
```rust
// In collect_model_instances
if is_instanceable_block(block_name) {
    instances.push(InstanceData { pos, rotation, tint, light });
    return; // Don't add to mesh
}
```

2. **Render with InstancedMesh**:
```javascript
const grassInstancedMesh = new THREE.InstancedMesh(
    grassGeometry,  // Single cross geometry
    grassMaterial,
    instanceCount
);
```

### Phase 3: Section-Based Culling

Skip entire sections that are:
- Below camera and far away
- Above camera (underground chunks)
- Behind solid terrain

## Expected Results

| Metric | Current | After Fix | Improvement |
|--------|---------|-----------|-------------|
| Model triangles | 36.4M | ~5M | 86% reduction |
| Total triangles | 40M | ~9M | 78% reduction |
| FPS | 5 | 30+ | 6x improvement |
| Memory | 4GB | <1GB | 75% reduction |

## Implementation Priority

1. **LOD in WASM** - Biggest immediate impact, simplest change
2. **Update worker** - Pass LOD parameter
3. **GPU instancing** - Reduces remaining triangle count
4. **Section culling** - Further optimization

## Code Changes Required

### Files to Modify

1. `src/wasm-mesher/src/lib.rs` - Add LOD parameter to mesh_models_v3
2. `src/wasm-mesher/src/models/mesher_v3.rs` - Implement LOD filtering
3. `src/mesh/workers/SuperChunkWorker.js` - Pass LOD, calculate distance
4. `src/mesh/workers/SuperChunkWorkerPool.js` - Track camera position for LOD

### New Functions

```rust
// mesher_v3.rs
fn get_lod_category(block_name: &str) -> LodCategory {
    // 0 = always render, 1 = skip at LOD 1, 2 = skip at LOD 2, 3 = only at LOD 0
}

fn should_skip_for_lod(category: LodCategory, lod_level: u8) -> bool {
    category as u8 <= lod_level
}
```

```javascript
// SuperChunkWorker.js
function calculateLodLevel(superChunkX, superChunkZ, cameraX, cameraZ) {
    const dx = (superChunkX * 32 + 16) - cameraX;
    const dz = (superChunkZ * 32 + 16) - cameraZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    if (dist < 32) return 0;
    if (dist < 64) return 1;
    if (dist < 128) return 2;
    return 3;
}
```

## Timeline

This fix can be implemented in a single session:
1. WASM changes (30 min)
2. Worker changes (15 min)
3. Rebuild and test (15 min)

Total: ~1 hour for 80%+ triangle reduction.
