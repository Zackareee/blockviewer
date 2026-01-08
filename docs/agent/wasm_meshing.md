# WASM Meshing

## Overview
WASM meshing uses a Rust-compiled WebAssembly module for high-performance greedy meshing. It's the preferred meshing path and is enabled by default.

## When Active
- WASM module successfully loaded
- `SuperChunkManager.useWasm = true` (default)
- `SuperChunkManager.wasmInitialized = true`

## Key Components

### Rust WASM Module
**Location:** `src/wasm-mesher/`
- Source: `src/wasm-mesher/src/lib.rs`
- Built with wasm-pack to `src/mesh/wasm/pkg/`

### JavaScript Bridge
**File:** `src/mesh/wasm/WasmMesher.js`
- Loads and initializes WASM module
- Serializes grid data for WASM consumption
- Extracts mesh results from WASM memory

## Flow

### 1. WASM Initialization
```javascript
// ChunkStreamer.initializeWasm()
async initializeWasm() {
  const success = await this.superChunkManager.initializeWasm();
  if (success) {
    // Initialize block registry for unified pipeline
    initBlockRegistry(this.registry);
  }
}

// SuperChunkManager._doInitializeWasm()
async _doInitializeWasm() {
  // Load WASM module
  const wasmLoaded = await initWasmMesher();
  
  // Build lookup tables from registry
  const lookups = buildLookupTables(this.registry, textureIndexLookup);
  
  // Initialize lookups in WASM memory
  initWasmLookups(lookups);
  
  this.wasmInitialized = true;
}
```

### 2. WASM Module Loading
```javascript
// WasmMesher.js
export async function initWasmMesher() {
  const wasm = await import('./pkg/wasm_mesher.js');
  await wasm.default(); // Initialize WASM
  wasm.init();          // Call Rust init function
  
  wasmModule = wasm;
  wasmInitialized = true;
}
```

### 3. Lookup Table Initialization
WASM needs lookup tables to know block properties:
```javascript
export function initLookups(lookups) {
  wasmModule.init_lookups(
    lookups.isOpaque,        // Uint8Array[4096]
    lookups.isNonCube,       // Uint8Array[4096]
    lookups.colorR,          // Float32Array[4096]
    lookups.colorG,          // Float32Array[4096]
    lookups.colorB,          // Float32Array[4096]
    lookups.texIndices,      // Uint16Array[4096 * 6]
    lookups.tintTypes,       // Uint8Array[4096 * 6]
    // ... more arrays
  );
}
```

### 4. Super-Chunk Meshing with WASM
```javascript
// SuperChunkManager._buildSuperChunkWithWasm()
async _buildSuperChunkWithWasm(superChunk, grid, stateGrid, lightGrid, offset) {
  // Calculate bounds (only mesh blocks within these chunks)
  const bounds = {
    minChunkX: superChunk.superX * 2,
    minChunkZ: superChunk.superZ * 2,
    maxChunkX: superChunk.superX * 2 + 1,
    maxChunkZ: superChunk.superZ * 2 + 1,
  };
  
  // Skip lightGrid when smooth lighting disabled
  const effectiveLightGrid = this.chunkManager.smoothLightingEnabled ? lightGrid : null;
  
  // Call WASM mesher
  const meshResult = wasmMeshChunk(grid, effectiveLightGrid, stateGrid, bounds);
  
  // Create Three.js meshes from WASM results
  if (meshResult.solid?.positions.length > 0) {
    const mesh = this._createMesh(meshResult.solid, solidMaterial, solidGroup);
    superChunk.meshes.push(mesh);
  }
  // ... water, lava, glass
}
```

### 5. Grid Serialization
The JavaScript grids must be serialized for WASM:
```javascript
// WasmMesher.js
export function meshChunk(grid, lightGrid, stateGrid, bounds) {
  // Serialize grids to Uint8Array format
  const gridData = serializeGrid(grid);
  const lightData = lightGrid ? serializeLightGrid(lightGrid) : new Uint8Array(0);
  const stateData = stateGrid ? serializeStateGrid(stateGrid) : new Uint8Array(0);
  
  // Call WASM with serialized data
  let result;
  if (bounds) {
    result = wasmModule.mesh_chunk_bounded(
      gridData, lightData, stateData, null, 0,
      bounds.minChunkX, bounds.minChunkZ, bounds.maxChunkX, bounds.maxChunkZ
    );
  } else {
    result = wasmModule.mesh_chunk(gridData, lightData, stateData, null, 0);
  }
  
  // Extract mesh data from WASM result
  return {
    solid: {
      positions: new Float32Array(result.solid_positions),
      normals: new Float32Array(result.solid_normals),
      colors: new Float32Array(result.solid_colors),
      texIndices: new Float32Array(result.solid_tex_indices),
      // ... more attributes
    },
    water: { /* ... */ },
    lava: { /* ... */ },
    glass: { /* ... */ },
  };
}
```

## WASM vs JS Meshing Decision
```javascript
// SuperChunkManager._rebuildSuperChunk()
if (this.useWasm && this.wasmInitialized && isWasmAvailable()) {
  await this._buildSuperChunkWithWasm(superChunk, grid, stateGrid, lightGrid, offset);
}
else if (this.useWorkers && this.workerPoolInitialized) {
  await this._buildSuperChunkWithWorker(...);  // Workers (disabled)
}
else {
  await this._buildSuperChunkMainThread(...);  // JS fallback
}
```

## Unified Pipeline
When WASM and block registry are initialized, the "unified pipeline" is active:
```javascript
export function isUnifiedPipelineReady() {
  return isWasmAvailable() && blockRegistryInitialized;
}

// Benefits:
// - NBT chunk parsing can happen in WASM (faster)
// - Compressed chunk data passed directly to WASM
// - Less JavaScript ↔ WASM data transfer
```

## Model Meshing Still Uses JS
WASM only handles greedy meshing (solid blocks, fluids, glass). Model meshes (slabs, stairs, flowers) still use JavaScript:
```javascript
// After WASM meshing, if model meshes enabled:
if (this.enableModelMeshes && stateGrid && this.stateRegistry) {
  const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, ...);
  // Add model meshes...
}
```

## Performance Benefits
1. **Faster Greedy Meshing**: Rust is ~3-5x faster than JS for tight loops
2. **Efficient Memory**: Direct array buffers, no GC pauses
3. **Parallel-Ready**: WASM can be run in workers (future)

## Fallback Behavior
If WASM fails to load:
```javascript
if (!wasmLoaded) {
  console.warn('[SuperChunkManager] WASM mesher not available, using JavaScript fallback');
  this.useWasm = false;
  return false;
}
```

## Data Flow Diagram
```
SuperChunk marked dirty
       ↓
scheduleIdleRebuild()
       ↓
rebuildDirty()
       ↓
_rebuildSuperChunk()
       ↓
  ┌───────────────────────┐
  │ WASM available?       │
  └───────────────────────┘
       ↓yes
_buildSuperChunkWithWasm()
       ↓
serializeGrid() → Uint8Array
       ↓
wasmModule.mesh_chunk_bounded()
       ↓
Rust greedy meshing in WASM
       ↓
Return positions, normals, UVs, etc.
       ↓
Create Three.js BufferGeometry
       ↓
Add mesh to scene
```

## Key Files
| File | Purpose |
|------|---------|
| `src/wasm-mesher/src/lib.rs` | Rust WASM implementation |
| `src/mesh/wasm/WasmMesher.js` | JS ↔ WASM bridge |
| `src/viewer/SuperChunkManager.js` | Orchestrates WASM meshing |

