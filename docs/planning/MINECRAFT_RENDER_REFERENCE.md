# Minecraft Java Rendering Reference

This document summarizes how Minecraft Java handles chunk rendering, meshing, and vertex formats based on analysis of version 1.21.x.

## Chunk Architecture

### Chunk Sections
- World divided into 16×16×16 block sections (not full 16×256×16 chunks)
- Each section is independently meshable and cullable
- Sections can be updated individually when blocks change
- Section Y range: -4 to +19 (for -64 to +320 world height)

### Section States
1. **Empty** - All air, no mesh needed
2. **Full** - All opaque, can occlude other sections
3. **Partial** - Mixed blocks, needs full meshing
4. **Dirty** - Block changed, needs remesh

## Vertex Format

### ChunkBuilder.Buffers
Each chunk section has:
- `vertexBuffer` (GpuBuffer) - Vertex data
- `indexBuffer` (nullable) - Index data
- `indexCount` - Number of indices
- `indexType` - u16 or u32 indices

### Vertex Elements (VertexFormat)
Standard terrain vertex contains:
```
Position:    3 × float (12 bytes)
UV:          2 × float (8 bytes)
Color:       4 × u8 (4 bytes) - includes AO
Light:       2 × i16 (4 bytes) - sky + block
Normal:      3 × i8 + 1 padding (4 bytes)
───────────────────────────────────
Total:       ~32 bytes per vertex
```

Note: Minecraft uses interleaved vertex format for better cache locality.

### Light Encoding
- UV2 attribute: `ivec2` where:
  - `UV2.x` = block light level (0-240, step 16)
  - `UV2.y` = sky light level (0-240, step 16)
- Actual level = UV2 / 16, giving 0-15 range
- Sampled against 16×16 lightmap texture

### Color/AO Encoding
- Vertex color includes:
  - Biome tint (grass, leaves, water)
  - Ambient occlusion factor
  - Pre-multiplied together during meshing

## Meshing Pipeline

### Build Process
1. Block changes trigger section marking as dirty
2. Section data traversed to find visible faces
3. For each face:
   - Check if neighbor blocks face (face culling)
   - Calculate UV coordinates
   - Calculate AO from 3 corner neighbors
   - Sample light from adjacent blocks
   - Add to vertex buffer

### Greedy Meshing
Minecraft uses basic face culling but NOT aggressive greedy meshing:
- Each block face is rendered separately
- Faces are culled only against solid neighbors
- No merging of adjacent same-type faces

This differs from our approach which uses greedy merging. Minecraft relies more on:
- GPU efficiency at drawing many quads
- Simpler meshing = faster rebuild times
- Per-block flexibility for animations, updates

### Face Culling Rules
```java
// Simplified face visibility check
boolean shouldRenderFace(Block block, Direction dir, BlockState neighbor) {
    if (neighbor.isOpaque() && neighbor.isSolidRender()) {
        return false; // Face hidden by solid neighbor
    }
    if (block == neighbor && block.skipRendering()) {
        return false; // Same block type, skip (e.g., glass-glass)
    }
    return true;
}
```

## Render Types

Minecraft batches geometry by render type:

### Solid
- Fully opaque blocks
- Rendered first (front-to-back for early Z)
- No blending

### Cutout
- Blocks with transparency in texture (leaves, glass panes)
- Alpha test, no blending
- Rendered after solid

### Cutout Mipped
- Same as cutout but with mipmaps
- Used for blocks that look bad without mipmaps

### Translucent
- Water, ice, stained glass
- Alpha blending enabled
- Rendered back-to-front (sorted)

### Tripwire
- Special for tripwire texture
- Very thin, needs special handling

## Buffer Upload Strategy

### Static Geometry
- Section mesh uploaded once
- Stays on GPU until section changes
- Reuses same buffer if size fits

### glBufferData vs glBufferSubData
Recent changes (1.21.5) switched to glBufferSubData:
```java
// Old approach - orphan and replace
glBufferData(target, size, data, usage);

// New approach - update in place
glBufferSubData(target, offset, size, data);
```

**Important:** glBufferSubData can cause pipeline stalls on some drivers (especially macOS). Monitor for this issue.

## Shader System

### Terrain Shader (terrain.vsh/fsh)
```glsl
// Vertex inputs
in vec3 Position;   // Block-relative position
in vec4 Color;      // Vertex color (AO + biome tint)
in vec2 UV0;        // Texture coordinates
in ivec2 UV2;       // Light coordinates (block, sky)
in vec3 Normal;     // Face normal

// Uniforms
uniform sampler2D Sampler0;  // Block atlas
uniform sampler2D Sampler2;  // Lightmap

// Vertex processing
void main() {
    // Position includes chunk offset
    vec3 pos = Position + (ChunkPosition - CameraBlockPos) + CameraOffset;
    gl_Position = ProjMat * ModelViewMat * vec4(pos, 1.0);
    
    // Sample lightmap and multiply with vertex color (AO + tint)
    vertexColor = Color * minecraft_sample_lightmap(Sampler2, UV2);
    texCoord0 = UV0;
}
```

### Lightmap Sampling
```glsl
vec4 minecraft_sample_lightmap(sampler2D lightMap, ivec2 uv) {
    // Convert 0-240 to 0-1 range with offset for texel centering
    return texture(lightMap, clamp(
        (uv / 256.0) + 0.5 / 16.0,
        vec2(0.5 / 16.0),
        vec2(15.5 / 16.0)
    ));
}
```

## Ambient Occlusion

### Algorithm (CPU-side during meshing)
```java
// For each vertex of a face, check 3 neighbors
// side1, side2, corner - in plane perpendicular to face normal
int calculateAO(boolean side1, boolean side2, boolean corner) {
    if (side1 && side2) {
        return 0; // Maximum occlusion
    }
    return 3 - (side1 ? 1 : 0) - (side2 ? 1 : 0) - (corner ? 1 : 0);
}
// Returns 0-3, where 3 = brightest, 0 = darkest
```

### AO Levels
| Level | Condition | Color Multiplier |
|-------|-----------|-----------------|
| 3 | No solid neighbors | 1.0 |
| 2 | 1 solid neighbor | ~0.8 |
| 1 | 2 solid neighbors | ~0.6 |
| 0 | Both sides solid | ~0.2 |

### Quad Winding Fix
When diagonal AO values differ, flip triangle winding:
```java
// Prevents diagonal shadow artifacts
if (ao[0] + ao[2] < ao[1] + ao[3]) {
    // Flip: use 0-1-2, 0-2-3 instead of 0-1-2, 2-3-0
}
```

## Performance Insights

### What Makes Minecraft Fast

1. **Section-based Granularity**
   - Only remesh changed sections, not whole chunks
   - Sections can be culled independently

2. **Simple Meshing**
   - No complex greedy merging
   - Fast rebuild = responsive to block changes

3. **Batching by Render Type**
   - Minimize state changes
   - All solid blocks together

4. **Compact Vertex Format**
   - 32 bytes vs our 70 bytes
   - Better cache utilization

5. **Static Buffers**
   - Upload once, draw many frames
   - No per-frame buffer updates

6. **Chunk Distance Culling**
   - Don't render far chunks at all
   - Render distance setting

### What We Can Adopt

1. **Section-level meshing** instead of chunk-level
2. **Simpler vertex format** (pack more, use fewer floats)
3. **Render type batching** (group by material needs)
4. **Matrix auto-update off** (chunks don't move)
5. **Static shadow maps** (update only when chunks change)

### What We Do Differently

1. **Greedy meshing** - We merge faces for fewer triangles
   - Pro: Fewer vertices, less GPU work
   - Con: Slower meshing, can't update individual blocks

2. **Super-chunks** - We group 2×2 or 4×4 chunks
   - Pro: Fewer draw calls
   - Con: Larger update granularity

3. **WASM meshing** - Offload to WebAssembly
   - Pro: Fast native-like performance
   - Con: WASM↔JS boundary overhead

## Implementation Recommendations

### Short-term (Quick Wins)
1. Pack vertex format to 20-32 bytes
2. Disable matrix auto-update on chunk meshes
3. Reduce draw calls with unified mesh per super-chunk

### Medium-term (Significant Work)
1. Implement section-level culling
2. Add LOD for distant sections
3. Implement render type batching

### Long-term (Major Refactor)
1. Consider abandoning greedy meshing for faster rebuilds
2. Implement section-based updates (change 1 block = remesh 1 section)
3. GPU-driven culling and rendering (when WebGPU available)
