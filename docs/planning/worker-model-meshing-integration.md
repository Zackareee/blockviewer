# Worker Model Meshing Integration Plan

## Executive Summary

This plan details how to complete the V3 worker integration so that model blocks (stairs, slabs, plants, etc.) appear **simultaneously** with solid blocks instead of lagging behind.

## Current Problem

```
Timeline: Chunk Loading

Main Thread                    Worker
─────────────────────────────────────────────────────────────
                               [Decode NBT]
                               [WASM Solid Mesh] ←── FAST
                               [Serialize grids]
        ↓ transfer
[Create solid mesh] ────────── User sees solid blocks
[Idle: model mesh] ←────────── SLOW (main thread)
[Idle: model mesh]
[Create model mesh] ─────────── User sees partial blocks (LATE!)
```

**Result**: Solid blocks appear first, partial blocks pop in 100-500ms later.

## Solution Architecture

```
Timeline: After Integration

Main Thread                    Worker
─────────────────────────────────────────────────────────────
                               [Decode NBT + populate ModelStateGrid]
                               [WASM Solid Mesh]
                               [WASM Model Mesh V3] ←── NOW IN WORKER!
        ↓ transfer (all meshes together)
[Create solid mesh]
[Create model mesh] ─────────── User sees EVERYTHING at once!
```

**Result**: All geometry appears simultaneously.

---

## Step 1: Priority Inversion (Quick Win)

### Goal
Even before V3 is fully integrated, we can improve perceived performance by sending model meshes FIRST.

### Changes Required

#### 1.1 Worker: Mesh Models Before Serializing Grids

```javascript
// In processSuperChunk(), move model meshing before grid serialization
// Current order:
//   1. WASM solid/water/lava/glass meshing
//   2. Serialize grids
//   3. Send result

// New order:
//   1. WASM solid/water/lava/glass meshing
//   2. WASM model meshing (V3) ← NEW
//   3. Send result (no grid serialization needed!)
```

#### 1.2 Main Thread: Create Model Meshes First

```javascript
// In _createMeshesFromWorkerResult(), change order:
// Current: solid → water → lava → glass → models
// New: models → solid → water → lava → glass

// This ensures model geometry is visible ASAP
```

### Estimated Impact
- **Before**: Models appear 100-500ms after solid blocks
- **After**: Models appear 0-50ms after solid blocks (transfer time only)

---

## Step 2: Complete V3 Worker Integration (Main Focus)

### Overview

The V3 infrastructure is complete but not connected. We need to:

1. ✅ Load baked-models.bin in workers
2. ✅ Initialize BlockModelRegistry in worker WASM
3. 🔲 Populate ModelStateGrid during chunk decoding
4. 🔲 Call mesh_models_v3 in worker
5. 🔲 Return model meshes from worker
6. 🔲 Remove grid serialization (no longer needed)

### Phase 2.1: Worker Initialization with Baked Models

**File: `src/mesh/workers/SuperChunkWorkerPool.js`**

```javascript
// Add baked models to worker initialization
async initialize(blockRegistryData, stateRegistryData, wasmLookups, modelGeometryData, bakedModelsData) {
  this.initData = {
    blockRegistry: blockRegistryData,
    stateRegistry: stateRegistryData,
    wasmLookups: wasmLookups,
    modelGeometry: modelGeometryData,
    bakedModels: bakedModelsData,      // NEW: Raw ArrayBuffer of baked-models.bin
    manifest: manifestData,             // NEW: block-model-manifest.json
  };
  // ...
}
```

**File: `src/mesh/workers/SuperChunkWorker.js`**

```javascript
// Worker state additions
let modelStateLookup = null;       // From ModelStateLookup.js
let bakedModelsLoaded = false;

// In message handler 'init':
if (data.bakedModels && wasmModule) {
  wasmModule.init_block_model_registry(new Uint8Array(data.bakedModels));
  bakedModelsLoaded = true;
  console.log('[SuperChunkWorker] V3 block model registry initialized');
}

if (data.manifest) {
  modelStateLookup = new ModelStateLookup();
  modelStateLookup.init(data.manifest);
  console.log('[SuperChunkWorker] ModelStateLookup initialized');
}
```

### Phase 2.2: ModelStateGrid Population During Decode

**Current decode flow:**
```javascript
function decodeChunk(chunk, grid, blockRegistry, stateGrid, stateRegistry, lightGrid) {
  // For each block in section:
  //   - Get palette entry (block name + properties)
  //   - Register in stateRegistry → get stateId
  //   - Store blockId in grid
  //   - Store stateId in stateGrid
}
```

**New decode flow with ModelStateGrid:**
```javascript
// Add ModelStateGrid parameter
function decodeChunk(chunk, grid, blockRegistry, stateGrid, stateRegistry, lightGrid, modelStateGrid) {
  // For each block in section:
  //   - Get palette entry (block name + properties)
  //   - Register in stateRegistry → get stateId
  //   - Store blockId in grid
  //   - Store stateId in stateGrid
  //   
  //   // NEW: Populate ModelStateGrid for model blocks
  //   if (modelStateLookup.isModelBlock(blockName)) {
  //     const modelState = modelStateLookup.getModelState(blockName, properties);
  //     modelStateGrid.set(worldX, worldY, worldZ, modelState);
  //   }
}
```

**File: `src/mesh/workers/SuperChunkWorker.js`**

Add new `WorkerModelStateGrid` class:

```javascript
class WorkerModelStateGrid {
  constructor() {
    this.sections = new Map(); // SectionKey → Uint32Array(4096)
  }
  
  set(worldX, worldY, worldZ, modelState) {
    const chunkX = worldX >> 4;
    const chunkZ = worldZ >> 4;
    const sectionY = (worldY + 64) >> 4;
    const key = this._packKey(chunkX, chunkZ, sectionY);
    
    let section = this.sections.get(key);
    if (!section) {
      section = new Uint32Array(4096);
      this.sections.set(key, section);
    }
    
    const localX = worldX & 0xF;
    const localY = (worldY + 64) & 0xF;
    const localZ = worldZ & 0xF;
    const idx = localY * 256 + localZ * 16 + localX;
    
    section[idx] = modelState;
  }
  
  serialize() {
    // Format: [sectionCount: u32][sections...]
    // Section: [key: u64][data: u32 × 4096]
    const sectionCount = this.sections.size;
    const totalSize = 4 + sectionCount * (8 + 4096 * 4);
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const u32View = new Uint32Array(buffer);
    
    view.setUint32(0, sectionCount, true);
    let offset = 4;
    
    for (const [key, data] of this.sections) {
      // Write packed key as two u32s (BigInt not needed)
      view.setUint32(offset, key & 0xFFFFFFFF, true);
      view.setUint32(offset + 4, Math.floor(key / 0x100000000), true);
      offset += 8;
      
      // Write section data
      for (let i = 0; i < 4096; i++) {
        view.setUint32(offset, data[i], true);
        offset += 4;
      }
    }
    
    return new Uint8Array(buffer);
  }
  
  _packKey(chunkX, chunkZ, sectionY) {
    // Pack: chunk_x (24 bits) | chunk_z (24 bits) | section_y (16 bits)
    const cx = (chunkX + 0x800000) & 0xFFFFFF;
    const cz = (chunkZ + 0x800000) & 0xFFFFFF;
    const sy = sectionY & 0xFFFF;
    return (cx * 0x10000000000) + (cz * 0x10000) + sy;
  }
}
```

### Phase 2.3: WASM Model Meshing in Worker

**File: `src/mesh/workers/SuperChunkWorker.js`**

Replace grid serialization with direct model meshing:

```javascript
async function processSuperChunk(data) {
  const { chunks, neighbors, bounds } = data;
  
  // ... existing decode logic ...
  
  const grid = new WorkerBinaryGrid();
  const stateGrid = new WorkerBlockStateGrid();
  const lightGrid = new WorkerLightGrid();
  const modelStateGrid = new WorkerModelStateGrid(); // NEW
  
  // Decode with ModelStateGrid population
  for (const chunk of chunkResults) {
    if (chunk) {
      decodedChunks.push(chunk);
      decodeChunk(chunk, grid, blockRegistry, stateGrid, stateRegistry, lightGrid, modelStateGrid);
    }
  }
  
  // ... neighbor handling ...
  
  // Build solid/fluid meshes (existing)
  let gridMeshes = wasmMeshChunk(grid, lightGrid, bounds);
  
  // NEW: Build model meshes using V3
  let modelMeshes = null;
  if (bakedModelsLoaded && modelStateGrid.sections.size > 0) {
    const serializedModelStateGrid = modelStateGrid.serialize();
    const serializedGrid = grid.serializeForWasm();
    const serializedLightGrid = lightGrid.serializeForWasm();
    
    modelMeshes = wasmModule.mesh_models_v3(
      serializedGrid,
      serializedLightGrid,
      serializedModelStateGrid,
      bounds.minChunkX,
      bounds.minChunkZ,
      bounds.maxChunkX,
      bounds.maxChunkZ
    );
  }
  
  // Build result with model meshes included
  const result = {
    solid: gridMeshes.solid,
    water: gridMeshes.water,
    lava: gridMeshes.lava,
    glass: gridMeshes.glass,
    // NEW: Include model meshes from worker
    modelOpaque: modelMeshes ? extractModelMesh(modelMeshes, 'opaque') : null,
    modelTransparent: modelMeshes ? extractModelMesh(modelMeshes, 'transparent') : null,
    modelOverlay: modelMeshes ? extractModelMesh(modelMeshes, 'overlay') : null,
    beaconPositions: modelMeshes ? modelMeshes.beacon_positions() : [],
    // REMOVED: grids (no longer needed!)
  };
  
  return { result, transferables, stats };
}

function extractModelMesh(wasmResult, type) {
  const prefix = type;
  return {
    positions: new Float32Array(wasmResult[`${prefix}_positions`]()),
    normals: new Float32Array(wasmResult[`${prefix}_normals`]()),
    uvs: new Float32Array(wasmResult[`${prefix}_uvs`]()),
    colors: new Float32Array(wasmResult[`${prefix}_colors`]()),
    texIndices: new Float32Array(wasmResult[`${prefix}_tex_indices`]()),
    tintTypes: new Float32Array(wasmResult[`${prefix}_tint_types`]()),
    skyLight: new Float32Array(wasmResult[`${prefix}_sky_light`]()),
    blockLight: new Float32Array(wasmResult[`${prefix}_block_light`]()),
    indices: new Uint32Array(wasmResult[`${prefix}_indices`]()),
    vertexCount: wasmResult[`${prefix}_vertex_count`](),
  };
}
```

### Phase 2.4: Main Thread Changes

**File: `src/viewer/SuperChunkManager.js`**

Remove main-thread model meshing path:

```javascript
// BEFORE: _createMeshesFromWorkerResult
_createMeshesFromWorkerResult(result, superChunkKey) {
  // Create solid mesh...
  // Create water mesh...
  // Create lava mesh...
  // Create glass mesh...
  
  // OLD: Queue model mesh building from grids
  if (result.grids) {
    this._queueModelMeshBuild(superChunkKey, result.grids, ...);
  }
}

// AFTER: _createMeshesFromWorkerResult
_createMeshesFromWorkerResult(result, superChunkKey) {
  // Create solid mesh...
  // Create water mesh...
  // Create lava mesh...
  // Create glass mesh...
  
  // NEW: Model meshes come directly from worker
  if (result.modelOpaque && result.modelOpaque.vertexCount > 0) {
    this._createMesh('modelOpaque', result.modelOpaque, superChunkKey);
  }
  if (result.modelTransparent && result.modelTransparent.vertexCount > 0) {
    this._createMesh('modelTransparent', result.modelTransparent, superChunkKey);
  }
  if (result.modelOverlay && result.modelOverlay.vertexCount > 0) {
    this._createMesh('modelOverlay', result.modelOverlay, superChunkKey);
  }
}
```

**File: `src/viewer/ChunkStreamer.js`**

Load baked models during initialization:

```javascript
async _initSuperChunkManager() {
  // ... existing init ...
  
  // Load baked models
  const bakedModelsResponse = await fetch('/assets/baked-models.bin');
  const bakedModelsBuffer = await bakedModelsResponse.arrayBuffer();
  
  const manifestResponse = await fetch('/assets/block-model-manifest.json');
  const manifest = await manifestResponse.json();
  
  // Pass to worker pool
  await this.workerPool.initialize(
    blockRegistryData,
    stateRegistryData,
    wasmLookups,
    modelGeometryData,
    bakedModelsBuffer,  // NEW
    manifest            // NEW
  );
}
```

### Phase 2.5: Remove Unused Code

Once V3 is working, remove:

1. Grid serialization in worker (no longer needed)
2. `_buildModelMeshesFromWorkerGrids` in SuperChunkManager
3. `_queueModelMeshBuild` and `_processModelMeshQueue`
4. `flushModelMeshQueue` in ChunkStreamer
5. State registry serialization for worker → main thread mapping

---

## Implementation Checklist

### Step 1: Priority Inversion
- [ ] Reorder mesh creation in `_createMeshesFromWorkerResult`
- [ ] Test: Model meshes should appear faster

### Step 2: V3 Worker Integration

#### 2.1: Worker Initialization
- [ ] Add `bakedModels` and `manifest` to worker init data
- [ ] Load baked models in worker message handler
- [ ] Initialize ModelStateLookup in worker
- [ ] Call `init_block_model_registry` in worker WASM

#### 2.2: ModelStateGrid Population
- [ ] Create `WorkerModelStateGrid` class
- [ ] Add `modelStateGrid` parameter to `decodeChunk`
- [ ] Populate ModelStateGrid for model blocks during decode
- [ ] Implement `serialize()` for WASM consumption

#### 2.3: Worker Model Meshing
- [ ] Call `mesh_models_v3` after solid meshing
- [ ] Extract model mesh data from WASM result
- [ ] Add model meshes to worker result
- [ ] Add model mesh buffers to transferables

#### 2.4: Main Thread Integration
- [ ] Load baked-models.bin in ChunkStreamer
- [ ] Pass baked models to worker pool
- [ ] Consume model meshes from worker result
- [ ] Remove grid-based model mesh building

#### 2.5: Cleanup
- [ ] Remove grid serialization
- [ ] Remove main-thread model meshing code
- [ ] Remove idle callback model mesh queue
- [ ] Update tests if needed

---

## Expected Results

### Before
```
Chunk appears:
[0ms]   Solid blocks visible
[50ms]  Water/lava visible
[150ms] Glass visible
[300ms] Partial blocks visible (LATE!)
```

### After
```
Chunk appears:
[0ms]   ALL geometry visible simultaneously
```

### Performance Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Model mesh creation | Main thread (blocking) | Worker thread | 100% off main thread |
| Model mesh latency | 100-500ms | 0ms | Eliminated |
| Main thread work | Decode + mesh | Mesh only | ~50% reduction |
| Memory transfer | Grids + meshes | Meshes only | ~30% reduction |

---

## Risk Mitigation

### Risk 1: Visual Regression
**Mitigation**: Run regression tests after each phase. Keep fallback path.

### Risk 2: Texture Index Mismatch
**Concern**: Baked texture indices might not match atlas indices
**Mitigation**: Texture indices in baked data are from the same texture atlas. Verify during testing.

### Risk 3: AO Mismatch
**Concern**: V3 AO might differ from main-thread AO
**Mitigation**: V3 uses the same 3-neighbor algorithm. Compare screenshots.

### Risk 4: Memory Usage
**Concern**: Workers hold baked model data (~2MB each)
**Mitigation**: Acceptable trade-off. Can share via SharedArrayBuffer if needed.

---

## Testing Plan

1. **Unit Test**: ModelStateGrid serialization/deserialization
2. **Unit Test**: ModelStateLookup property parsing
3. **Integration Test**: Worker produces model meshes
4. **Visual Test**: All regression tests pass
5. **Performance Test**: Measure chunk load latency before/after

---

## Timeline

| Phase | Description | Estimated Time |
|-------|-------------|----------------|
| 2.1 | Worker initialization | 1 hour |
| 2.2 | ModelStateGrid population | 2 hours |
| 2.3 | Worker model meshing | 2 hours |
| 2.4 | Main thread integration | 1 hour |
| 2.5 | Cleanup | 1 hour |
| Testing | Regression + performance | 1 hour |
| **Total** | | **~8 hours** |
