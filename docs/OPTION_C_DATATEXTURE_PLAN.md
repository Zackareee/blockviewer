# Option C: DataTexture Unified Rendering - Implementation Plan

## Executive Summary

This document outlines the complete implementation plan for migrating from the current
BufferGeometry-per-chunk architecture to a unified DataTexture-based rendering system.
This is expected to reduce draw calls from 200+ to 6 and enable 40M+ triangles at 60 FPS.

## Current Architecture Analysis

### Mesh Types Per Super-Chunk
Currently, each super-chunk creates up to 8 separate Three.js meshes:
1. `solid` - Opaque cube blocks (stone, dirt, wood)
2. `glass` - Transparent cube blocks (glass, ice, leaves)
3. `water` - Animated water fluid
4. `lava` - Animated lava fluid
5. `modelOpaque` - Opaque partial blocks (stairs, slabs, torches)
6. `modelTransparent` - Transparent partial blocks (glass panes)
7. `modelOverlay` - Overlay faces (grass top overlay)
8. `modelTranslucent` - Translucent blocks (slime, honey)

With 80+ super-chunks at 8-chunk render distance: **~500 draw calls**

### Current Vertex Attributes
Each vertex has 12 attributes totaling ~72 bytes:

| Attribute | Components | Type | Bytes |
|-----------|------------|------|-------|
| position | 3 | float32 | 12 |
| normal | 3 | float32 | 12 |
| color | 3 | float32 | 12 |
| modelUV | 2 | float32 | 8 |
| texIndex | 1 | float32 | 4 |
| texRotation | 1 | float32 | 4 |
| tintType | 1 | float32 | 4 |
| shadeFlag | 1 | float32 | 4 |
| singleSided | 1 | float32 | 4 |
| skyLight | 1 | float32 | 4 |
| blockLight | 1 | float32 | 4 |
| **Total** | | | **72** |

For 40M triangles (120M vertices): **8.6 GB of vertex data**

### Current Data Flow
```
WASM Mesher → ArrayBuffer → Worker Message → Main Thread → BufferGeometry → Draw Call
```

---

## DataTexture Architecture

### Core Concept
Pack all vertex data into GPU textures. The vertex shader fetches attributes
using `texelFetch()` with computed texture coordinates based on `gl_VertexID`.

### Texture Layout

#### 1. Position Texture (RGBA32F, 4096x4096)
- Each texel stores xyz position + objectID
- 16.7M vertices per texture = 5.5M triangles
- Multiple textures for larger scenes

```
Layout:
  Column 0-4095: Vertex X,Y,Z + ObjectID packed
  Row 0: Vertices 0-4095
  Row 1: Vertices 4096-8191
  ...
  Max: 16.7M vertices
```

#### 2. Attribute Texture (RGBA32F, 4096x4096)
- Stores normals, texIndex, lighting in packed format
- Normal: xyz packed into RGB (3 floats)
- texIndex + tintType packed into A (4 bytes)

```
Layout:
  R: normal.x
  G: normal.y
  B: normal.z
  A: packed(texIndex:16, tintType:8, skyLight:4, blockLight:4)
```

#### 3. UV Texture (RG16F, 4096x4096)
- Model UVs for non-cube blocks
- Half-precision for 2x compression

#### 4. Object Matrix Texture (RGBA32F, 256x256)
- 4 texels per super-chunk (mat4)
- Stores world-space offset matrix
- Supports 16,384 super-chunks

#### 5. Visibility Texture (R8, 256x256)
- One byte per super-chunk
- Updated each frame from frustum culling
- 0x00 = hidden, 0xFF = visible

### Quantized Positions (Phase 1)

Convert from 32-bit float to 16-bit unsigned integer positions:

```rust
// In WASM mesher
struct QuantizedVertex {
    x: u16,  // 0-65535 maps to 0.0-32.0 blocks (super-chunk size)
    y: u16,  // 0-65535 maps to -64.0-320.0 (world height)
    z: u16,  // 0-65535 maps to 0.0-32.0 blocks
}

fn quantize_position(world_x: f32, world_y: f32, world_z: f32, 
                     chunk_origin_x: f32, chunk_origin_z: f32) -> QuantizedVertex {
    // Convert to local super-chunk space
    let local_x = world_x - chunk_origin_x;
    let local_z = world_z - chunk_origin_z;
    
    // Quantize to 16-bit
    QuantizedVertex {
        x: ((local_x / 32.0) * 65535.0).clamp(0.0, 65535.0) as u16,
        y: (((world_y + 64.0) / 384.0) * 65535.0).clamp(0.0, 65535.0) as u16,
        z: ((local_z / 32.0) * 65535.0).clamp(0.0, 65535.0) as u16,
    }
}
```

**Shader decoding:**
```glsl
vec3 decodePosition(uvec3 quantized, vec3 chunkOrigin) {
    vec3 local = vec3(quantized) / 65535.0;
    local.x *= 32.0;  // Super-chunk width
    local.y = local.y * 384.0 - 64.0;  // World height
    local.z *= 32.0;  // Super-chunk depth
    return local + chunkOrigin;
}
```

---

## Implementation Phases

### Phase 1: Quantized Output + Packed Attributes (2-3 days)

**Goal**: Reduce per-vertex memory by 60% without changing rendering

**Files to modify:**
- `src/wasm-mesher/src/mesher/mod.rs` - Add QuantizedMeshData struct
- `src/wasm-mesher/src/mesher/greedy.rs` - Output quantized positions
- `src/wasm-mesher/src/models/mesher_v3.rs` - Output quantized positions
- `src/wasm-mesher/src/lib.rs` - Export quantized mesh functions

**New vertex format:**
```rust
pub struct PackedVertex {
    // Position: 6 bytes (3x u16)
    pub x: u16,
    pub y: u16,
    pub z: u16,
    
    // Normal: 3 bytes (packed as snorm8 xyz)
    pub normal_packed: u32,  // Actually only 3 bytes used
    
    // Attributes: 4 bytes
    pub tex_index: u16,      // 0-4096 atlas indices
    pub packed_attrs: u16,   // tintType:4, texRot:2, shade:1, singleSided:1, sky:4, block:4
}
```

**Memory comparison:**
| Format | Bytes/vertex | 40M tris | Reduction |
|--------|--------------|----------|-----------|
| Current | 72 | 8.6 GB | - |
| Packed | 16 | 1.9 GB | **78%** |

**Deliverables:**
1. WASM exports `mesh_chunk_packed()` function
2. Worker parses packed output
3. Main thread unpacks to standard BufferGeometry (temporary)
4. Benchmark: No visual change, 30-50% memory reduction

---

### Phase 2: GeometryTextureManager (2-3 days)

**Goal**: Create infrastructure for packing geometry into DataTextures

**Files to create:**
- `src/viewer/GeometryTextureManager.js`

**GeometryTextureManager API:**
```javascript
class GeometryTextureManager {
    constructor(maxVertices = 16 * 1024 * 1024) {
        // Allocate DataTextures
        this.positionTexture = new THREE.DataTexture(
            new Float32Array(4096 * 4096 * 4),
            4096, 4096,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        this.attributeTexture = ...;
        this.uvTexture = ...;
        this.objectMatrixTexture = ...;
        this.visibilityTexture = ...;
        
        // Free list for vertex allocation
        this.allocator = new VertexAllocator(maxVertices);
        
        // Object registry
        this.objects = new Map(); // objectId -> { offset, count, superChunk }
    }
    
    // Allocate space for a super-chunk's geometry
    allocateObject(superChunkKey, vertexCount) {
        const offset = this.allocator.alloc(vertexCount);
        const objectId = this.nextObjectId++;
        this.objects.set(objectId, { offset, count: vertexCount, key: superChunkKey });
        return objectId;
    }
    
    // Upload geometry data to textures
    uploadGeometry(objectId, packedVertices, chunkOrigin) {
        const obj = this.objects.get(objectId);
        const baseOffset = obj.offset;
        
        // Write to position texture
        for (let i = 0; i < obj.count; i++) {
            const texelX = (baseOffset + i) % 4096;
            const texelY = Math.floor((baseOffset + i) / 4096);
            // Write position + objectId to RGBA
        }
        
        this.positionTexture.needsUpdate = true;
    }
    
    // Free a super-chunk's geometry
    freeObject(objectId) {
        const obj = this.objects.get(objectId);
        this.allocator.free(obj.offset, obj.count);
        this.objects.delete(objectId);
    }
    
    // Update visibility based on frustum culling
    updateVisibility(camera, frustum) {
        const data = this.visibilityTexture.image.data;
        for (const [objectId, obj] of this.objects) {
            const visible = frustum.containsPoint(obj.center) ? 255 : 0;
            data[objectId] = visible;
        }
        this.visibilityTexture.needsUpdate = true;
    }
}
```

**Deliverables:**
1. GeometryTextureManager class
2. VertexAllocator with free-list management
3. DataTexture creation and update methods
4. Unit tests for allocation/deallocation

---

### Phase 3: DataTextureMaterial (3-4 days)

**Goal**: Create shader material that reads from DataTextures

**Files to create:**
- `src/viewer/materials/DataTextureMaterial.js`

**Vertex Shader:**
```glsl
uniform sampler2D uPositions;     // Position + objectID
uniform sampler2D uAttributes;    // Normal + packed attrs
uniform sampler2D uUVs;           // Model UVs
uniform sampler2D uObjectMatrix;  // Per-object transforms
uniform sampler2D uVisibility;    // Per-object visibility

uniform vec2 uTextureSize;        // 4096x4096
uniform float uObjectsPerRow;     // Objects per row in matrix texture

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying float vTexIndex;
varying float vTintType;
varying vec2 vLightUV;

void main() {
    // Calculate texture coordinates for this vertex
    int vertexID = gl_VertexID;
    ivec2 posTexCoord = ivec2(vertexID % 4096, vertexID / 4096);
    
    // Fetch position and objectID
    vec4 posData = texelFetch(uPositions, posTexCoord, 0);
    vec3 localPos = posData.xyz;
    int objectID = int(posData.w);
    
    // Check visibility
    ivec2 visCoord = ivec2(objectID % 256, objectID / 256);
    float visible = texelFetch(uVisibility, visCoord, 0).r;
    if (visible < 0.5) {
        gl_Position = vec4(0.0, 0.0, 0.0, 0.0);  // Discarded by GPU
        return;
    }
    
    // Fetch object matrix
    int matrixBase = objectID * 4;
    vec4 matRow0 = texelFetch(uObjectMatrix, ivec2(matrixBase % 256, matrixBase / 256), 0);
    vec4 matRow1 = texelFetch(uObjectMatrix, ivec2((matrixBase+1) % 256, (matrixBase+1) / 256), 0);
    vec4 matRow2 = texelFetch(uObjectMatrix, ivec2((matrixBase+2) % 256, (matrixBase+2) / 256), 0);
    vec4 matRow3 = texelFetch(uObjectMatrix, ivec2((matrixBase+3) % 256, (matrixBase+3) / 256), 0);
    mat4 objectMatrix = mat4(matRow0, matRow1, matRow2, matRow3);
    
    // Transform to world space
    vWorldPos = (objectMatrix * vec4(localPos, 1.0)).xyz;
    
    // Fetch and decode attributes
    vec4 attrData = texelFetch(uAttributes, posTexCoord, 0);
    vNormal = normalize(attrData.xyz * 2.0 - 1.0);  // Decode snorm
    
    // Unpack attributes from attrData.w
    int packed = floatBitsToInt(attrData.w);
    vTexIndex = float((packed >> 16) & 0xFFFF);
    vTintType = float((packed >> 12) & 0xF);
    float skyLight = float((packed >> 8) & 0xF);
    float blockLight = float((packed >> 4) & 0xF);
    vLightUV = vec2((blockLight + 0.5) / 16.0, (skyLight + 0.5) / 16.0);
    
    // Fetch model UVs if needed
    vUV = texelFetch(uUVs, posTexCoord, 0).xy;
    
    // Final position
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
}
```

**Fragment Shader:**
Reuse existing TexturedMaterial fragment shader logic for texture sampling,
biome tinting, lightmap, fog, etc.

**Deliverables:**
1. DataTextureMaterial class extending THREE.ShaderMaterial
2. Vertex shader with texture fetching
3. Fragment shader (port from TexturedMaterial)
4. Integration with existing lightmap and atlas textures

---

### Phase 4: Integration + Single Draw Call (3-4 days)

**Goal**: Wire everything together for unified rendering

**Files to modify:**
- `src/viewer/SuperChunkManager.js` - Use GeometryTextureManager
- `src/viewer/ChunkManager.js` - Add DataTexture rendering path

**Architecture:**
```
SuperChunkWorkerPool
    ↓ (packed vertices)
GeometryTextureManager.uploadGeometry()
    ↓ (DataTextures)
DataTextureMaterial (single Mesh with massive gl.drawArrays)
    ↓
GPU renders all geometry in 1-6 draw calls
```

**Integration Steps:**

1. **Create unified mesh per material type:**
```javascript
// In ChunkManager or a new UnifiedRenderer
this.solidMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),  // Empty - vertices come from texture
    new DataTextureMaterial({ type: 'solid', geoManager: this.geoManager })
);
this.solidMesh.frustumCulled = false;  // We do our own culling
scene.add(this.solidMesh);
```

2. **Modify mesh creation:**
```javascript
// OLD: _createMeshFromData creates BufferGeometry
// NEW: Upload to GeometryTextureManager
async _createMeshesFromWorkerResult(superChunk, result) {
    const gm = this.geometryTextureManager;
    
    if (result.solid) {
        const objectId = gm.allocateObject(superChunk.key, result.solid.vertexCount);
        gm.uploadGeometry(objectId, result.solid.packedVertices, superChunk.origin);
        superChunk.solidObjectId = objectId;
    }
    // ... repeat for other mesh types
}
```

3. **Update draw count per frame:**
```javascript
// Before render
const totalVertices = this.geoManager.getTotalVertexCount('solid');
this.solidMesh.geometry.setDrawRange(0, totalVertices);
```

**Deliverables:**
1. Modified SuperChunkManager using GeometryTextureManager
2. Unified meshes per material type (solid, glass, water, etc.)
3. Frustum culling via visibility texture
4. Benchmark: 200+ draw calls → 6 draw calls

---

### Phase 5: Dynamic Updates + Polish (2-3 days)

**Goal**: Handle chunk loading/unloading efficiently

**Challenges:**
1. **Fragmentation**: As chunks unload, holes appear in texture
2. **Partial updates**: Need efficient texture sub-region updates
3. **GPU stalls**: Large texture uploads can stall GPU

**Solutions:**

1. **Defragmentation:**
```javascript
class GeometryTextureManager {
    defragment() {
        // Compact all geometry to remove holes
        // Update objectId mappings
        // Single large texture update
    }
    
    shouldDefragment() {
        return this.fragmentationRatio > 0.3;  // 30% wasted space
    }
}
```

2. **Double buffering:**
```javascript
class GeometryTextureManager {
    constructor() {
        this.positionTextures = [
            this.createPositionTexture(),
            this.createPositionTexture()
        ];
        this.activeBuffer = 0;
    }
    
    swap() {
        this.activeBuffer = 1 - this.activeBuffer;
    }
}
```

3. **Incremental updates:**
```javascript
// Use gl.texSubImage2D for partial updates
uploadGeometryIncremental(objectId, vertices) {
    const gl = this.renderer.getContext();
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture.__webglTexture);
    gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        startX, startY, width, height,
        gl.RGBA, gl.FLOAT, data
    );
}
```

**Deliverables:**
1. Defragmentation system
2. Double-buffered textures
3. Incremental upload support
4. Performance profiling and optimization

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| WebGL2 texture limits | High | Low | Use texture arrays, check limits at init |
| Precision loss from quantization | Medium | Medium | Test visual quality, use per-chunk offsets |
| GPU stalls from large uploads | High | Medium | Incremental updates, double buffering |
| Debugging difficulty | Medium | High | Comprehensive logging, debug visualization |
| Browser compatibility | Medium | Low | Already require WebGL2 |

---

## Performance Targets

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| Draw calls | 200+ | 6 | **97%** |
| CPU frame time | 8ms | 1ms | **87%** |
| Memory (vertices) | 8.6GB | 1.9GB | **78%** |
| Triangles @ 60fps | 8M | 40M | **5x** |

---

## Testing Strategy

1. **Unit tests**: VertexAllocator, GeometryTextureManager
2. **Visual regression**: Ensure no rendering differences
3. **Performance benchmarks**: Draw calls, frame time, memory
4. **Stress tests**: Maximum chunk loading, rapid movement
5. **Edge cases**: Empty chunks, single block, max render distance

---

## File Summary

### New Files to Create
- `src/viewer/GeometryTextureManager.js` - Texture packing/management
- `src/viewer/materials/DataTextureMaterial.js` - Shader material
- `src/viewer/VertexAllocator.js` - Free-list allocator
- `test/GeometryTextureManager.test.js` - Unit tests

### Files to Modify
- `src/wasm-mesher/src/mesher/mod.rs` - Packed vertex output
- `src/wasm-mesher/src/mesher/greedy.rs` - Quantized positions
- `src/wasm-mesher/src/models/mesher_v3.rs` - Quantized positions
- `src/wasm-mesher/src/lib.rs` - New exports
- `src/mesh/workers/SuperChunkWorker.js` - Parse packed vertices
- `src/viewer/SuperChunkManager.js` - Integration
- `src/viewer/ChunkManager.js` - Unified mesh rendering

---

## Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Quantized Output | 2-3 days | None |
| Phase 2: GeometryTextureManager | 2-3 days | Phase 1 |
| Phase 3: DataTextureMaterial | 3-4 days | Phase 2 |
| Phase 4: Integration | 3-4 days | Phase 3 |
| Phase 5: Polish | 2-3 days | Phase 4 |
| **Total** | **12-17 days** | |

---

## Success Criteria

1. ✓ Draw calls reduced from 200+ to ≤10
2. ✓ Memory usage reduced by 50%+
3. ✓ 40M triangles rendering at 60 FPS
4. ✓ No visual regressions in block rendering
5. ✓ All existing tests pass
6. ✓ Chunk load/unload works smoothly
