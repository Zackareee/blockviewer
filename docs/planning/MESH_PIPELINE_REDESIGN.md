# Mesh Pipeline Redesign Plan

## Executive Summary

This document outlines a complete redesign of the meshing and loading pipeline to achieve Minecraft-level performance. The current implementation suffers from:

1. **Excessive memory usage** - 72 bytes per vertex, many separate mesh objects
2. **Too many draw calls** - 6-8 meshes per super-chunk × hundreds of super-chunks
3. **Complex coordination overhead** - Multiple worker pools, queue systems, message passing
4. **Inefficient data transfer** - WASM→JS→Three.js with multiple copies

The goal is to replicate Minecraft's efficient approach: compact vertex formats, minimal draw calls, streamlined meshing, and smart culling.

---

## Current Architecture Problems

### Memory Analysis

**Per-Vertex Data (Current):**
```
positions:      3 × f32 = 12 bytes
normals:        3 × f32 = 12 bytes
colors:         3 × f32 = 12 bytes
uvs:            2 × f32 = 8 bytes
tex_indices:    1 × f32 = 4 bytes
tex_rotations:  1 × f32 = 4 bytes
tint_types:     1 × f32 = 4 bytes
sky_light:      1 × f32 = 4 bytes
block_light:    1 × f32 = 4 bytes
indices:        ~1.5 × u32 = 6 bytes
─────────────────────────────
TOTAL:          ~70 bytes/vertex
```

For a typical detailed region (500K vertices): **35MB of vertex data alone**

**Mesh Object Overhead:**
- Each super-chunk creates up to 8 separate meshes: solid, water, lava, glass, modelOpaque, modelTransparent, modelOverlay, modelTranslucent
- Each mesh has Three.js overhead: geometry, material binding, scene graph node
- 100 super-chunks = 800 potential mesh objects = 800 draw calls

### Pipeline Complexity

```
Current Flow:
MCA File → Chunk Decode → Binary Grid → WASM Serialize → WASM Mesh
    ↓
MeshResult → JS Copy → BufferGeometry → Mesh → Scene
    ↓
Per-chunk: 6-8 meshes created
```

**Problems:**
1. WASM→JS boundary requires data copy
2. Multiple mesh creations per chunk
3. Worker pool coordination overhead
4. Queue system adds latency

---

## Target Architecture: Minecraft-Inspired

### Minecraft's Approach

1. **Chunk Sections (16×16×16)** as the unit of meshing
2. **Compact Vertex Format** - Position quantized, attributes packed
3. **Render Types** for batching - All solid blocks in one pass, all transparent in another
4. **VBO per Section** - Single buffer, single draw call
5. **AO + Lighting baked** into vertex attributes at mesh time
6. **Greedy Meshing** to reduce triangle count

### Target Vertex Format (20 bytes vs 70 bytes)

```rust
#[repr(C, packed)]
struct PackedVertex {
    // Position: 6 bytes (quantized u16 relative to chunk)
    x: u16,  // 0-65535 → 0.0-16.0 blocks
    y: u16,  // 0-65535 → -64 to 320
    z: u16,  // 0-65535 → 0.0-16.0 blocks
    
    // Normal + Texture: 4 bytes
    // Bits [31:24] = normal_packed (6 possible values encoded as 0-5)
    // Bits [23:8]  = tex_index (0-65535)
    // Bits [7:0]   = tex_rotation (0-3) + tint_type (0-15) + flags
    normal_tex: u32,
    
    // UV: 4 bytes (half-float)
    uv_packed: u32,
    
    // Light + AO: 2 bytes
    // Bits [15:12] = sky_light (0-15)
    // Bits [11:8]  = block_light (0-15)
    // Bits [7:0]   = AO value or color index
    light_ao: u16,
    
    // Padding/Reserved: 4 bytes (can store color index or other data)
    reserved: u32,
}
// Total: 20 bytes (71% reduction)
```

### Target Mesh Architecture

```
New Flow:
MCA File → WASM (Decode + Mesh in one call)
    ↓
Packed Vertex Buffer (SharedArrayBuffer)
    ↓
Single BufferGeometry per super-chunk
    ↓
BatchedMesh or single Mesh with render groups
```

**Key Changes:**
1. **Unified mesh per super-chunk** - One geometry with groups for different render passes
2. **Zero-copy transfer** - SharedArrayBuffer directly usable by Three.js
3. **No separate model mesh** - Bake model blocks into main geometry
4. **GPU-driven culling** - Frustum culling in shader for sections

---

## Multi-Stage Implementation Plan

### Phase 1: Unified Buffer Format

**Goal:** Reduce memory by 70% with packed vertex format

**Tasks:**
1. ✅ Already have `PackedVertex` and `PackedMeshData` in Rust (see `mesher/mod.rs`)
2. Create JavaScript decoder for packed format
3. Create `PackedGeometry` Three.js helper that creates BufferGeometry from packed data
4. Add shader support for unpacking quantized positions and packed attributes

**Shader Changes:**
```glsl
// Vertex shader unpacking
attribute vec3 position;  // Quantized as u16 → needs decode
attribute uint normalTex;  // Packed normal + texture
attribute uint uvPacked;   // Half-float UVs
attribute uint lightAo;    // Light + AO

vec3 decodePosition(vec3 quantized, vec3 chunkOrigin) {
    return quantized / 4096.0 + chunkOrigin;
}

vec3 decodeNormal(uint packed) {
    uint idx = packed >> 24;
    // 6 possible normals for cube faces
    const vec3 normals[6] = vec3[6](
        vec3(0, 1, 0),   // UP
        vec3(0, -1, 0),  // DOWN
        vec3(1, 0, 0),   // EAST
        vec3(-1, 0, 0),  // WEST
        vec3(0, 0, 1),   // SOUTH
        vec3(0, 0, -1)   // NORTH
    );
    return normals[idx];
}
```

**Deliverables:**
- `src/mesh/PackedGeometry.js` - Decoder and geometry builder
- `src/viewer/materials/PackedMaterial.js` - Shader with unpacking
- Modified WASM to output packed format

---

### Phase 2: Unified Mesh Per Super-Chunk

**Goal:** Reduce draw calls by 8x (one mesh instead of 8)

**Architecture:**
```javascript
class UnifiedChunkGeometry {
    // Single BufferGeometry with groups
    // Group 0: Solid opaque blocks (render first)
    // Group 1: Model blocks (slabs, stairs, etc.)
    // Group 2: Transparent blocks (glass)
    // Group 3: Translucent blocks (water, ice)
    
    groups: [
        { start: 0, count: solidCount, materialIndex: 0 },
        { start: solidCount, count: modelCount, materialIndex: 0 },
        { start: solidCount + modelCount, count: glassCount, materialIndex: 1 },
        { start: offset, count: waterCount, materialIndex: 2 },
    ]
}
```

**Tasks:**
1. Modify WASM mesher to output unified buffer with section markers
2. Create `UnifiedChunkMesh` class that uses a single geometry
3. Implement render order sorting for transparent sections
4. Add depth peeling or OIT for correct transparency

**Key Insight from xeokit:**
- Use a single `SceneModel` with batched geometry
- Quantize positions relative to chunk origin
- Store per-section metadata for culling

**Deliverables:**
- `src/viewer/UnifiedChunkMesh.js` - Single mesh per super-chunk
- Modified WASM to output unified packed buffer

---

### Phase 3: Streaming & Chunk Section Culling

**Goal:** Load only visible sections, cull occluded sections

**Architecture:**
```
World Chunks (24 sections each, -4 to +19)
       ↓
Frustum Culling (skip sections outside view)
       ↓
Distance LOD (reduce detail for far sections)
       ↓
Occlusion Culling (skip sections behind terrain)
       ↓
Render visible sections only
```

**Implementation Approach:**

1. **Section-based LOD:**
   - LOD 0: Full detail (near camera)
   - LOD 1: Skip cross-plants, reduce model complexity
   - LOD 2: Solid blocks only, simplified shapes
   - LOD 3: Single-color cubes (very distant)

2. **GPU Frustum Culling:**
   - Store section bounding boxes in uniform buffer
   - Compute shader marks visible sections
   - Only draw visible section ranges

3. **Occlusion Hints:**
   - Track which sections have only solid blocks (potential occluders)
   - Use hierarchical Z-buffer for occlusion culling

**Deliverables:**
- `src/viewer/SectionCuller.js` - Section-level culling
- `src/viewer/LODManager.js` - Distance-based LOD switching
- WASM changes for LOD-aware meshing (already partially exists)

---

### Phase 4: Three.js Optimizations

**Goal:** Apply all recommended Three.js performance patterns

**Changes to Apply:**

1. **Renderer Settings:**
```javascript
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.antialias = false;  // Use FXAA post-process if needed
renderer.powerPreference = 'high-performance';
```

2. **Matrix Auto-Update:**
```javascript
// For static meshes (chunks don't move)
mesh.matrixAutoUpdate = false;
mesh.updateMatrix();  // Call once when created
```

3. **Static Shadows:**
```javascript
// Update shadow map only when chunks change, not every frame
renderer.shadowMap.autoUpdate = false;
// Call renderer.shadowMap.needsUpdate = true only when needed
```

4. **Geometry Disposal:**
```javascript
// Aggressive disposal of off-screen chunks
geometry.dispose();
material.dispose();
```

5. **Texture Atlas Optimization:**
```javascript
// Use compressed textures (KTX2/Basis)
// Single atlas per render pass
// Mipmaps with proper filtering
```

6. **Frustum Culling Optimization:**
```javascript
// Pre-compute bounding spheres
geometry.computeBoundingSphere();
mesh.frustumCulled = true;
```

**Deliverables:**
- `src/viewer/RendererOptimizer.js` - Apply all optimizations
- Updated material creation with optimized settings

---

### Phase 5: BatchedMesh Investigation

**Goal:** Evaluate Three.js BatchedMesh for chunk rendering

**Research Findings:**

**Pros:**
- Single draw call for many geometries
- Per-instance frustum culling built-in
- Dynamic add/remove geometries

**Cons:**
- High CPU overhead at scale (1000s of instances)
- No multi-material support (would need separate for water/glass)
- Limited buffer management

**Recommendation:**
BatchedMesh is not ideal for chunk rendering because:
1. Chunks have different materials (solid vs transparent)
2. High instance count causes CPU overhead
3. Our unified mesh approach is simpler and more efficient

**Alternative: IndirectBatchedMesh (WebGPU)**
When WebGPU is available, use GPU-driven rendering:
- Indirect draw commands
- GPU culling via compute shader
- Minimal CPU overhead

---

### Phase 6: Memory Budget & Streaming

**Goal:** Stay under a memory budget, stream chunks dynamically

**Memory Budget:**
```
Target: 512MB total for world data
- Visible chunks: 256MB (packed vertices)
- Texture atlas: 128MB
- Block registry: 32MB
- Buffer pool: 64MB
- Headroom: 32MB
```

**Streaming Strategy:**
1. **Priority Loading:**
   - Load chunks near camera first
   - Load visible chunks before hidden
   - Load at LOD 0 near, LOD 2 far

2. **Eviction Policy:**
   - LRU eviction for distant chunks
   - Keep chunk data compressed in memory, decompress on demand
   - Pool and reuse geometry buffers

3. **Buffer Pooling:**
```javascript
class GeometryPool {
    // Pre-allocate buffers for common sizes
    // Small: 1K vertices (mostly air chunks)
    // Medium: 8K vertices (typical terrain)
    // Large: 32K vertices (detailed areas)
    
    acquire(size) { /* return pooled or new buffer */ }
    release(buffer) { /* return to pool */ }
}
```

**Deliverables:**
- `src/viewer/MemoryManager.js` - Memory budget enforcement
- `src/viewer/GeometryPool.js` - Buffer pooling

---

## Implementation Order

1. **Phase 1** (Packed Format) - Immediate 70% memory reduction
2. **Phase 4** (Three.js Optimizations) - Quick wins, low risk
3. **Phase 2** (Unified Mesh) - Major draw call reduction
4. **Phase 6** (Memory Budget) - Prevent OOM issues
5. **Phase 3** (Section Culling) - Performance for large views
6. **Phase 5** (BatchedMesh) - Evaluate but likely skip

---

## Metrics to Track

| Metric | Current | Target |
|--------|---------|--------|
| Memory per super-chunk | ~5MB | ~1.5MB |
| Draw calls per frame | 500-800 | 50-100 |
| Time to first render | 2-5s | <1s |
| Sustained FPS | 30-40 | 60 |
| Vertex bytes per vertex | 70 | 20 |
| Meshes per super-chunk | 6-8 | 1-2 |

---

## Files to Modify/Remove

### Remove (obsolete after redesign):
- `src/mesh/FastMesher.js` - Replace with WASM-only path
- `src/mesh/ModelMesher.js` - Merge into unified mesher
- `src/mesh/workers/MeshWorker.js` - Simplify to single worker type
- `src/mesh/workers/MeshWorkerPool.js` - Replace with simpler pool
- `src/viewer/SuperChunkManager.js` - Rewrite as UnifiedChunkManager

### Create:
- `src/mesh/PackedGeometry.js`
- `src/viewer/UnifiedChunkMesh.js`
- `src/viewer/UnifiedChunkManager.js`
- `src/viewer/materials/PackedMaterial.js`
- `src/viewer/SectionCuller.js`
- `src/viewer/MemoryManager.js`
- `src/viewer/GeometryPool.js`
- `src/viewer/RendererOptimizer.js`

### Modify:
- `src/wasm-mesher/src/lib.rs` - Add unified packed output
- `src/wasm-mesher/src/mesher/mod.rs` - Use packed format throughout
- `src/viewer/RegionViewer.jsx` - Use new manager

---

## Comparison with Reference Implementations

### xeokit-sdk
**What to adopt:**
- SceneModel concept (unified geometry with metadata)
- Quantization + decode matrices
- RTC (Relative-To-Center) coordinates
- Data textures for attribute storage

**What to skip:**
- XKT file format (we have our own)
- BIM-specific features

### engine_fragment
**What to adopt:**
- FlatBuffers for compact serialization
- Worker-based processing
- Tile-based loading
- LOD switching per tile

**What to skip:**
- IFC import (not relevant)
- Heavy property system

### Minecraft Java
**What to adopt:**
- Chunk section as render unit
- Vertex format with packed attributes
- Render types for batching
- VBO per section
- Baked AO and lighting

**What to skip:**
- Entity rendering (different pipeline)
- Complex shader features (we're simpler)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Packed format shader complexity | Medium | Medium | Incremental testing, fallback to unpacked |
| Browser SharedArrayBuffer support | Low | High | Feature detection, fallback to copy |
| Three.js compatibility | Low | Medium | Use standard BufferGeometry API |
| Visual regressions | Medium | High | Side-by-side comparison tests |
| Performance regression during refactor | High | Medium | Keep old path available, toggle |

---

## Next Steps

1. **Create Phase 1 branch** and implement packed format decoder
2. **Add metrics collection** to measure before/after
3. **Implement PackedGeometry** class
4. **Create new shader** for packed attribute unpacking
5. **Test with simple scene** before full integration

The goal is to achieve Minecraft-level performance: fast loading, smooth rendering, low memory usage, all in the browser.
