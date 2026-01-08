# JavaScript Meshing

## Overview
JavaScript meshing is the fallback when WASM is unavailable. It uses the same greedy meshing algorithm but implemented in pure JavaScript.

## When Active
- WASM failed to load or is disabled
- `SuperChunkManager.useWasm = false`
- Fallback path in `_buildSuperChunkMainThread()`

## Key Components

### FastMesher
**File:** `src/mesh/FastMesher.js`
- Greedy meshing for solid blocks, fluids, and glass
- Handles AO (ambient occlusion) calculation
- Per-vertex smooth lighting

### ModelMesher
**File:** `src/mesh/ModelMesher.js`
- Non-cube blocks (slabs, stairs, fences, flowers, etc.)
- Uses Minecraft's JSON model format
- GPU instancing for repeated blocks

## Flow

### 1. Main Thread Meshing Path
```javascript
// SuperChunkManager._buildSuperChunkMainThread()
async _buildSuperChunkMainThread(superChunk, grid, stateGrid, lightGrid, offset) {
  const textureIndexLookup = this.chunkManager.getTextureIndexLookup?.() || null;
  const collectEmitters = this.chunkManager.particleQuality !== 'off';
  
  // Skip lightGrid when smooth lighting disabled
  const effectiveLightGrid = this.chunkManager.smoothLightingEnabled ? lightGrid : null;
  const mesherOptions = { textureIndexLookup, lightGrid: effectiveLightGrid, collectEmitters };
  
  // Build solid/fluid/glass meshes
  const { solid, water, lava, glass } = buildGridMeshes(grid, this.registry, offset, mesherOptions);
  
  // Create and add meshes
  if (solid?.positions.length > 0) {
    const mesh = this._createMesh(solid, solidMaterial, solidGroup);
    superChunk.meshes.push(mesh);
  }
  // ... water, lava, glass
  
  // Build model meshes if enabled
  if (this.enableModelMeshes && stateGrid) {
    const modelResult = buildModelMeshesWithInstancing(grid, stateGrid, ...);
    // ... add model meshes
  }
}
```

### 2. FastMesher.buildGridMeshes()
```javascript
// FastMesher.js
export function buildGridMeshes(grid, registry, offset, options) {
  const { textureIndexLookup, lightGrid } = options;
  
  // Build lookup tables for block properties
  const { isOpaque, isNonCube, colorR, colorG, colorB, ... } = getCachedLookupTables(registry);
  
  // Pre-allocate arrays for mesh data
  const sPos = new Float32Array(maxVertices * 3);
  const sNorm = new Float32Array(maxVertices * 3);
  const sCol = new Float32Array(maxVertices * 3);
  // ... more arrays
  
  // Process each section (16x16x16 chunk section)
  for (const [sectionKey, section] of grid.sections) {
    // Greedy mesh each face direction
    // Face 0: Top (+Y)
    // Face 1: Bottom (-Y)
    // Face 2: East (+X)
    // Face 3: West (-X)
    // Face 4: South (+Z)
    // Face 5: North (-Z)
    
    for (each face direction) {
      // Build mask of exposed faces
      // Greedy merge adjacent faces with same properties
      // Emit vertices for merged quads
    }
  }
  
  return {
    solid: trimMesh(sPos, sNorm, sCol, ...),
    water: fluidMeshes.water,
    lava: fluidMeshes.lava,
    glass: trimMesh(gPos, gNorm, gCol, ...),
  };
}
```

### 3. Greedy Meshing Algorithm
```javascript
// For each layer in a direction:
for (let ly = 0; ly < 16; ly++) {
  // Build mask of faces to render
  mask.fill(0);
  for (let j = 0; j < 256; j++) {
    const value = section[sliceBase + j];
    if (!isFullCube(value)) continue;
    
    // Check if neighbor blocks the face
    const nValue = getNeighborValue();
    if (isOpaque[nValue & 0xFFF]) continue;
    
    // Face is exposed - add to mask
    mask[j] = value;
  }
  
  // Greedy merge: find rectangles of same block type
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; ) {
      const val = mask[y * 16 + x];
      if (!val) { x++; continue; }
      
      // Find width of run
      let w = 1;
      while (x + w < 16 && mask[y * 16 + x + w] === val) w++;
      
      // Find height of rectangle
      let h = 1;
      while (y + h < 16 && canExtend(x, y, w, h, val)) h++;
      
      // Clear merged cells from mask
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          mask[(y + dy) * 16 + x + dx] = 0;
      
      // Emit quad with size w x h
      emitQuad(x, y, w, h, val);
      
      x += w;
    }
  }
}
```

### 4. Smooth Light Sampling
When `lightGrid` is provided:
```javascript
// Per-vertex smooth lighting
if (lightGrid) {
  const l0 = sampleVertexLight(lightGrid, x, y, z+h, ao[0], grid, isOpaque, 'xz');
  const l1 = sampleVertexLight(lightGrid, x+w, y, z+h, ao[1], grid, isOpaque, 'xz');
  const l2 = sampleVertexLight(lightGrid, x+w, y, z, ao[2], grid, isOpaque, 'xz');
  const l3 = sampleVertexLight(lightGrid, x, y, z, ao[3], grid, isOpaque, 'xz');
  
  skyL0 = l0.skyLight; blockL0 = l0.blockLight;
  // ... for all vertices
}
```

When `lightGrid` is null (smooth lighting disabled):
- Default values used: skyLight=15, blockLight=0
- Calculation skipped for performance

### 5. ModelMesher
```javascript
// ModelMesher.js
export function buildModelMeshesWithInstancing(grid, stateGrid, registry, stateRegistry, offset, options) {
  const { textureIndexLookup, lightGrid, collectEmitters } = options;
  
  // Collect instances of each model variant
  const instanceMap = new Map(); // variantKey → [positions]
  
  for (const [key, state] of stateGrid.states) {
    // Resolve block state to model variant
    const variant = stateRegistry.getVariant(state);
    
    // Get precomputed geometry for this variant
    const geometry = stateRegistry.getGeometrySync(variant);
    
    // Add instance
    instanceMap.get(variantKey).push({ x, y, z, rotation, ... });
  }
  
  // Build instanced geometry
  for (const [variantKey, instances] of instanceMap) {
    // Create geometry with per-instance attributes
    // Position, rotation, tint, light level
  }
  
  return { opaque, transparent, overlay, particleEmitters };
}
```

## Performance Characteristics

### Advantages of JS Meshing
1. No WASM loading overhead
2. Easier to debug
3. Works in all browsers

### Disadvantages vs WASM
1. Slower (~3-5x for large regions)
2. More GC pressure
3. Can block main thread

## When JS Meshing is Used
1. WASM module failed to load
2. Explicitly disabled (`useWasm: false`)
3. Model meshes (always JS, even when WASM handles solid blocks)

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
       ↓no
_buildSuperChunkMainThread()
       ↓
buildGridMeshes()  ← FastMesher.js
       ↓
  ┌─────────────────┐
  │ For each section │
  │   For each face  │
  │     Build mask   │
  │     Greedy merge │
  │     Emit quads   │
  └─────────────────┘
       ↓
Mesh data: positions, normals, UVs, colors, light
       ↓
Create Three.js BufferGeometry
       ↓
buildModelMeshesWithInstancing()  ← ModelMesher.js
       ↓
Add all meshes to scene
```

## Key Files
| File | Purpose |
|------|---------|
| `src/mesh/FastMesher.js` | Greedy meshing, AO, smooth lighting |
| `src/mesh/ModelMesher.js` | Non-cube blocks with instancing |
| `src/mesh/FluidMesher.js` | Water and lava special handling |
| `src/mesh/AOCalculator.js` | Ambient occlusion helpers |
| `src/mesh/LightGrid.js` | Light data storage |
| `src/mesh/BinaryGrid.js` | Block data storage |
| `src/mesh/BlockStateGrid.js` | Block state storage for models |

