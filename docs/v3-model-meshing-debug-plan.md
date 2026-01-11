# V3 Model Meshing Debug Plan

## Executive Summary

The V3 model meshing infrastructure is complete but not producing correct geometry. This document outlines a systematic debugging plan to identify and fix the issues.

## Progress Summary (Updated)

### Completed
1. **Phase 5: Block Index Alignment** - FIXED
   - Root cause identified: Baking script skipped blocks with 0 variants
   - This caused manifest (1163 blocks) and baked binary (907 blocks) to be misaligned
   - Fix: Modified `bake-model-geometry.js` to include ALL blocks
   - Validation script created: `scripts/validate-v3-alignment.js`

2. **Phase 1: Build-time Data** - VERIFIED
   - `baked-models.bin`: 1163 blocks, magic=0x424B4D44, version=1
   - `block-model-manifest.json`: 1163 blocks with variants

3. **Phase 4: WASM Logging** - ADDED
   - Logging added to `mesher_v3.rs` to track blocks found/meshed

### Bugs Fixed
1. Added missing `isModelBlock()` method to `ModelStateLookup.js`
2. Added missing `size` getter to `WorkerModelStateGrid`
3. Fixed WASM file not being synced to worker-accessible path
4. Fixed duplicate `section_count` method in Rust `model_state_grid.rs`
5. Updated build script to sync WASM to all required locations

### Outstanding Issue
**V3 meshing produces 0 vertices** despite:
- Registry initializing correctly (1163 blocks)
- Build-time data verified correct
- Block indices now aligned

**Next Debug Steps:** Continue with Phase 3 (serialization verification)

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BUILD TIME                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  analyze-block-models.js         bake-model-geometry.js                     │
│         │                               │                                   │
│         ▼                               ▼                                   │
│  block-model-manifest.json ──────► baked-models.bin                        │
│  (1.1 MB, 1163 blocks)              (1.9 MB, pre-baked geometry)           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME (Worker)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. INITIALIZATION                                                          │
│     ┌────────────────────┐    ┌─────────────────────┐                      │
│     │ baked-models.bin   │───►│ BlockModelRegistry  │ (WASM)               │
│     └────────────────────┘    │ - Parses binary     │                      │
│                               │ - Stores geometry   │                      │
│     ┌────────────────────┐    └─────────────────────┘                      │
│     │ manifest.json      │───►┌─────────────────────┐                      │
│     └────────────────────┘    │ ModelStateLookup    │ (JS)                 │
│                               │ - Block → Index     │                      │
│                               │ - Variant mapping   │                      │
│                               └─────────────────────┘                      │
│                                                                             │
│  2. CHUNK DECODING                                                          │
│     ┌────────────────────┐    ┌─────────────────────┐                      │
│     │ NBT Palette Entry  │───►│ ModelStateLookup    │                      │
│     │ {Name, Properties} │    │ .getModelState()    │                      │
│     └────────────────────┘    └──────────┬──────────┘                      │
│                                          │                                  │
│                                          ▼                                  │
│                               ┌─────────────────────┐                      │
│                               │ WorkerModelStateGrid│                      │
│                               │ - Uint32Array[4096] │                      │
│                               │ - Per-section       │                      │
│                               └─────────────────────┘                      │
│                                                                             │
│  3. MESHING                                                                 │
│     ┌─────────────────────────────────────────────────────────────────┐    │
│     │  wasmMeshModelsV3(grid, lightGrid, modelStateGrid, bounds)      │    │
│     │                                                                 │    │
│     │  1. Serialize BinaryGrid → Uint8Array                          │    │
│     │  2. Serialize LightGrid → Uint8Array                           │    │
│     │  3. Serialize ModelStateGrid → Uint8Array  ◄── POTENTIAL BUG   │    │
│     │  4. Call wasm.mesh_models_v3(...)                              │    │
│     │  5. Extract Float32Array results                               │    │
│     └─────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME (WASM)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  mesh_models_v3(grid_data, light_data, model_state_data, bounds)           │
│                                                                             │
│  1. Deserialize ModelStateGrid from bytes  ◄── POTENTIAL BUG               │
│  2. For each section with model states:                                     │
│     a. Unpack ModelState (block_idx, variant_idx, rotation, flags)         │
│     b. Look up BlockModelData in registry  ◄── POTENTIAL BUG               │
│     c. Get variant geometry                                                 │
│     d. Apply rotation/flip transforms                                       │
│     e. Calculate AO/lighting                                                │
│     f. Emit faces to opaque/transparent/overlay buffers                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Known Issues

### 1. V3 Meshing Returns Empty/Invalid Geometry
**Symptom**: When V3 is enabled, model blocks don't appear (28% pixel mismatch in tests).

**Possible Causes**:
- ModelStateGrid serialization format mismatch between JS and Rust
- Block index mismatch between manifest and baked registry
- Variant key mismatch
- Geometry not being emitted correctly

---

## Debug Plan

### Phase 1: Verify Data Flow (Build Time → Runtime)

#### Step 1.1: Verify baked-models.bin Structure

**File**: `scripts/bake-model-geometry.js`

Add validation logging:
```javascript
// After writing baked-models.bin, read it back and verify
const bakedData = fs.readFileSync('public/assets/baked-models.bin');
const view = new DataView(bakedData.buffer);
console.log('[Bake] Binary stats:');
console.log(`  Total size: ${bakedData.byteLength} bytes`);
console.log(`  Block count: ${view.getUint32(0, true)}`);
// Dump first few blocks for verification
```

**Expected**: Block count should match manifest (1163 blocks).

#### Step 1.2: Verify BlockModelRegistry Loading in WASM

**File**: `src/wasm-mesher/src/models/block_registry.rs`

Add debug logging in `init_block_model_registry`:
```rust
pub fn init_block_model_registry(data: Vec<u8>) -> bool {
    console::log_1(&format!("[WASM] init_block_model_registry: {} bytes", data.len()).into());
    
    let mut registry = BlockModelRegistry::new();
    match registry.load_from_binary(&data) {
        Ok(()) => {
            console::log_1(&format!("[WASM] Loaded {} blocks", registry.len()).into());
            // Log first few block names for verification
            for (i, block) in registry.blocks.iter().take(5).enumerate() {
                console::log_1(&format!("[WASM] Block {}: {} ({} variants)", 
                    i, block.name, block.variants.len()).into());
            }
            // ...
        }
        Err(e) => {
            console::error_1(&format!("[WASM] Failed to load: {}", e).into());
            false
        }
    }
}
```

**Expected**: Should log 1163 blocks loaded with correct names.

---

### Phase 2: Verify Runtime State Grid Population

#### Step 2.1: Verify ModelStateLookup Initialization

**File**: `src/mesh/workers/ModelStateLookup.js`

Add validation in `init()`:
```javascript
init(manifest, textureNameToIndex) {
    // ... existing code ...
    
    // Debug: Log first few blocks and their indices
    console.log('[ModelStateLookup] Sample blocks:');
    let count = 0;
    for (const [name, index] of this.blockNameToIndex) {
        if (count++ < 5) {
            console.log(`  ${name} → index ${index}`);
        }
    }
    
    this.initialized = true;
    console.log(`[ModelStateLookup] Initialized with ${blockIndex} blocks`);
}
```

**Expected**: Block names should match those in WASM registry, indices should be 0-based sequential.

#### Step 2.2: Verify getModelState Output

**File**: `src/mesh/workers/ModelStateLookup.js`

Add debug for a specific known block:
```javascript
getModelState(blockName, properties = {}) {
    const result = /* ... existing calculation ... */;
    
    // Debug specific blocks
    if (blockName === 'stone_slab' || blockName === 'oak_stairs') {
        console.log(`[ModelStateLookup] ${blockName}:`, {
            blockIndex: this.blockNameToIndex.get(blockName),
            properties,
            packedResult: result.toString(16),
            unpacked: {
                blockIdx: result & 0xFFF,
                variantIdx: (result >> 12) & 0xFF,
                rotation: (result >> 20) & 0xF,
                flags: (result >> 24) & 0xFF,
            }
        });
    }
    
    return result;
}
```

**Expected**: Block index should match WASM registry, variant index should be valid.

#### Step 2.3: Verify WorkerModelStateGrid Population

**File**: `src/mesh/workers/SuperChunkWorker.js`

Add logging in `decodeChunk()`:
```javascript
// After populating modelStateGrid
if (modelStates && modelStates.some(ms => ms !== 0)) {
    const nonZeroCount = modelStates.filter(ms => ms !== 0).length;
    console.log(`[decodeChunk] Section has ${nonZeroCount} model blocks`);
}
```

And in `processSuperChunk()`:
```javascript
// After decoding all chunks
console.log(`[processSuperChunk] ModelStateGrid sections: ${modelStateGrid?.sections?.size ?? 0}`);
if (modelStateGrid) {
    let totalModelBlocks = 0;
    for (const [key, section] of modelStateGrid.sections) {
        const count = section.filter(s => s !== 0).length;
        if (count > 0) {
            totalModelBlocks += count;
            console.log(`  Section ${key}: ${count} model blocks`);
        }
    }
    console.log(`[processSuperChunk] Total model blocks: ${totalModelBlocks}`);
}
```

**Expected**: Should show non-zero model block counts.

---

### Phase 3: Verify Serialization/Deserialization

#### Step 3.1: Verify ModelStateGrid Serialization (JS → WASM)

**File**: `src/mesh/workers/SuperChunkWorker.js`

Add logging in `WorkerModelStateGrid.serializeForWasm()`:
```javascript
serializeForWasm() {
    const nonEmptySections = /* ... existing ... */;
    
    console.log(`[ModelStateGrid.serializeForWasm] Serializing ${nonEmptySections.length} sections`);
    
    // Log first section details
    if (nonEmptySections.length > 0) {
        const first = nonEmptySections[0];
        const nonZeroStates = first.section.filter(s => s !== 0);
        console.log(`  First section (${first.key}): ${nonZeroStates.length} non-zero states`);
        console.log(`  Sample states:`, nonZeroStates.slice(0, 3).map(s => s.toString(16)));
    }
    
    const buffer = /* ... existing serialization ... */;
    
    console.log(`[ModelStateGrid.serializeForWasm] Total bytes: ${buffer.byteLength}`);
    return new Uint8Array(buffer);
}
```

**Expected**: Should show sections with model states, reasonable byte count.

#### Step 3.2: Verify ModelStateGrid Deserialization (WASM)

**File**: `src/wasm-mesher/src/grid/model_state_grid.rs`

Add logging in `from_bytes()`:
```rust
pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
    console::log_1(&format!("[ModelStateGrid] Parsing {} bytes", data.len()).into());
    
    let section_count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    console::log_1(&format!("[ModelStateGrid] Section count: {}", section_count).into());
    
    // ... existing parsing ...
    
    // Log stats after parsing
    let total_states: usize = grid.sections.values()
        .map(|s| s.iter().filter(|st| !st.is_empty()).count())
        .sum();
    console::log_1(&format!("[ModelStateGrid] Parsed {} sections, {} total states", 
        grid.sections.len(), total_states).into());
    
    Ok(grid)
}
```

**Expected**: Section count should match JS side, total states should be non-zero.

---

### Phase 4: Verify Meshing Logic

#### Step 4.1: Verify mesh_models_v3 Receives Data

**File**: `src/wasm-mesher/src/lib.rs`

Add logging at the start of `mesh_models_v3`:
```rust
pub fn mesh_models_v3(...) -> ModelMeshResultWasm {
    console::log_1(&format!("[mesh_models_v3] grid: {} bytes, light: {} bytes, model_state: {} bytes",
        grid_data.len(), light_data.len(), model_state_data.len()).into());
    console::log_1(&format!("[mesh_models_v3] bounds: ({},{}) to ({},{})", 
        min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z).into());
    
    // ... existing code ...
}
```

#### Step 4.2: Verify Block Lookup in Mesher

**File**: `src/wasm-mesher/src/models/mesher_v3.rs`

Add logging in `mesh_models_v3`:
```rust
pub fn mesh_models_v3(...) -> ModelMeshResult {
    let registry = match get_block_model_registry() {
        Some(r) => {
            console::log_1(&format!("[mesher_v3] Registry has {} blocks", r.len()).into());
            r
        }
        None => {
            console::warn_1(&"[mesher_v3] No registry!".into());
            return ModelMeshResult::default();
        }
    };
    
    let mut blocks_processed = 0;
    let mut faces_emitted = 0;
    
    for (key, section) in model_state_grid.iter_sections_with_states() {
        // ... existing loop ...
        
        for local_y in 0..SECTION_SIZE {
            for local_z in 0..SECTION_SIZE {
                for local_x in 0..SECTION_SIZE {
                    let state = section[idx];
                    if state.is_empty() { continue; }
                    
                    blocks_processed += 1;
                    
                    let block_idx = state.block_index();
                    let block = match registry.get_by_index(block_idx) {
                        Some(b) => b,
                        None => {
                            if blocks_processed <= 3 {
                                console::warn_1(&format!("[mesher_v3] No block at index {}", block_idx).into());
                            }
                            continue;
                        }
                    };
                    
                    // ... rest of processing ...
                    
                    faces_emitted += variant.faces.len();
                }
            }
        }
    }
    
    console::log_1(&format!("[mesher_v3] Processed {} blocks, emitted {} faces", 
        blocks_processed, faces_emitted).into());
    console::log_1(&format!("[mesher_v3] Result: {} opaque verts, {} transparent verts",
        result.opaque.positions.len() / 3, result.transparent.positions.len() / 3).into());
    
    result
}
```

**Expected**: Should show blocks being processed and faces being emitted.

---

### Phase 5: Verify Block Index Alignment

This is the **most likely cause** of the issue: the block index in the manifest (used by ModelStateLookup) might not match the block index in baked-models.bin (used by WASM registry).

#### Step 5.1: Compare Block Order

**Action**: Create a validation script that:
1. Reads `block-model-manifest.json` and extracts block names in order
2. Reads `baked-models.bin` header and extracts block names in order  
3. Compares the two lists

```javascript
// scripts/validate-v3-alignment.js
const fs = require('fs');

// Read manifest
const manifest = JSON.parse(fs.readFileSync('public/assets/block-model-manifest.json'));
const manifestBlocks = Object.keys(manifest.blocks);

// Read baked binary header
const baked = fs.readFileSync('public/assets/baked-models.bin');
const view = new DataView(baked.buffer);
let offset = 0;

const blockCount = view.getUint32(offset, true);
offset += 4;

const bakedBlocks = [];
for (let i = 0; i < blockCount; i++) {
    const nameLen = view.getUint16(offset, true);
    offset += 2;
    const name = new TextDecoder().decode(baked.slice(offset, offset + nameLen));
    offset += nameLen;
    bakedBlocks.push(name);
    
    // Skip variant count and variants data
    const variantCount = view.getUint16(offset, true);
    offset += 2;
    // ... skip variant data ...
}

// Compare
console.log('Manifest blocks:', manifestBlocks.length);
console.log('Baked blocks:', bakedBlocks.length);

for (let i = 0; i < Math.max(manifestBlocks.length, bakedBlocks.length); i++) {
    if (manifestBlocks[i] !== bakedBlocks[i]) {
        console.log(`MISMATCH at index ${i}:`);
        console.log(`  Manifest: ${manifestBlocks[i]}`);
        console.log(`  Baked: ${bakedBlocks[i]}`);
    }
}
```

**Expected**: All block names should match at the same indices.

---

### Phase 6: Test Fixes

After identifying the issue, implement fixes and verify:

1. **Unit test**: Add a test that meshes a single known block and verifies output
2. **Integration test**: Run regression tests with V3 enabled
3. **Performance test**: Compare V3 meshing time vs. main-thread meshing

---

## Quick Wins to Try First

1. **Add console logging to wasmMeshModelsV3**: See if it even gets called and what data it receives
2. **Check if modelStateGrid has any data**: Log `modelStateGrid.size` before calling mesh
3. **Check mesh_models_v3 return values**: Log vertex counts from the result

```javascript
// In SuperChunkWorker.js, in the V3 block:
if (v3Enabled) {
    console.log(`[V3] ModelStateGrid size: ${modelStateGrid.size}`);
    try {
        const modelMeshes = wasmMeshModelsV3(grid, lightGrid, modelStateGrid, bounds);
        console.log(`[V3] Result:`, {
            opaque: modelMeshes.modelOpaque?.vertexCount ?? 0,
            transparent: modelMeshes.modelTransparent?.vertexCount ?? 0,
            overlay: modelMeshes.modelOverlay?.vertexCount ?? 0,
        });
        // ...
    } catch (e) {
        console.error('[V3] Failed:', e);
    }
}
```

---

## Implementation Order

1. **Phase 5** - Verify block index alignment (most likely issue)
2. **Phase 4** - Add WASM logging to see what's happening
3. **Phase 3** - Verify serialization round-trip
4. **Phase 2** - Verify ModelStateGrid is being populated
5. **Phase 1** - Verify build-time data is correct

---

## Files to Modify

| File | Changes |
|------|---------|
| `scripts/validate-v3-alignment.js` | NEW - Validation script |
| `src/mesh/workers/SuperChunkWorker.js` | Add debug logging |
| `src/mesh/workers/ModelStateLookup.js` | Add debug logging |
| `src/wasm-mesher/src/models/block_registry.rs` | Add debug logging |
| `src/wasm-mesher/src/models/mesher_v3.rs` | Add debug logging |
| `src/wasm-mesher/src/grid/model_state_grid.rs` | Add debug logging |
| `src/wasm-mesher/src/lib.rs` | Add debug logging |

---

## Success Criteria

1. All regression tests pass with V3 enabled (< 0.1% pixel difference)
2. Console shows blocks being processed and faces being emitted
3. Model blocks appear simultaneously with solid blocks (no popping)
