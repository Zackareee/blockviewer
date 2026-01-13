# AOv3: Unified Lighting System Plan

This document outlines a comprehensive overhaul of the lighting system to provide consistent, accurate ambient occlusion and smooth lighting for both full cube blocks and model blocks (slabs, stairs, walls, fences, etc.).

## Goals

1. **Unified lighting approach** - Same algorithm concepts for full cubes and model blocks
2. **Accurate AO** - Replicate Minecraft's 3-neighbor AO algorithm where applicable
3. **Smooth light interpolation** - Per-vertex bilinear light sampling for gradient blending
4. **Dimension-aware** - Proper handling of Overworld, Nether, and End lighting
5. **No visual artifacts** - No black faces, no incorrect shadows, no blocky light gradients

---

## Current System Analysis

### Full Cube Blocks (FastMesher)
- ✅ Correct 3-neighbor AO per vertex (side1, side2, corner)
- ✅ Smooth light sampling from 4 adjacent blocks
- ✅ AO brightness curve: `[0.5, 0.7, 0.85, 1.0]` for levels 0-3
- ✅ Greedy meshing respects AO boundaries
- ✅ Quad triangulation flip based on AO diagonal

### Model Blocks (WASM mesher_v3.rs / JS ModelMesher.js)
- ✅ Per-vertex bilinear light interpolation (recent fix)
- ⚠️ Self-AO (0.92 multiplier for internal faces) is too simplistic
- ❌ No neighbor-based AO calculation
- ❌ No consideration of adjacent solid blocks creating shadows
- ❌ Inconsistent with full cube lighting near boundaries

### Current Issues
1. **Model block faces touching solid blocks don't show AO shadows**
   - A slab's top face next to a full block should have darker vertices where they meet
   
2. **Self-AO is uniform across all internal faces**
   - Stair internal corners should be darker than flat internal faces
   
3. **No AO from model blocks onto adjacent blocks**
   - Stairs don't cast AO shadows onto neighboring blocks

---

## AOv3 Architecture

### Principle: Face-Aware Vertex Lighting

For each vertex of any face (full cube or model block):
1. **Light Sampling**: Bilinear interpolation from 4 adjacent air blocks in the face's plane
2. **Geometry AO**: Check 3 neighbors (side1, side2, corner) for occlusion
3. **Self-AO**: For model block internal faces, apply mild self-shadow
4. **Combine**: `finalLight = smoothLight * geometryAO * selfAO`

### Component Breakdown

#### 1. Light Grid (Existing - No Changes Needed)
- `LightGrid.js` / `light_grid.rs` - Sparse storage of sky/block light
- Already handles missing sections correctly (dark for underground, bright for unknown)

#### 2. Lightmap Texture (Existing - No Changes Needed)
- `LightmapGenerator.js` - 16x16 lightmap with dimension-specific parameters
- Already handles time-of-day, dimension ambient, block light warmth

#### 3. Bilinear Light Sampling (Recently Fixed ✅)

```javascript
// Sample smooth light at vertex position
function sampleSmoothLightAtVertex(lightGrid, vx, vy, vz, faceDir) {
  // Offset into air space in front of face
  const [sampleX, sampleY, sampleZ] = offsetByNormal(vx, vy, vz, faceDir, 0.5);
  
  // Bilinear interpolation in the plane perpendicular to face normal
  // Uses floor(pos) and floor(pos)+1 for the 4 sample points
  // Weight by fractional position
  return bilinearInterpolate(lightGrid, sampleX, sampleY, sampleZ, faceDir);
}
```

#### 4. Geometry AO for Model Blocks (NEW)

For boundary faces (those with `cullface` property), check 3 neighbors just like full cubes:

```javascript
// For a model face with cullface="up" (e.g., slab top)
function calculateVertexAO(vertexWorldPos, faceDir, blockGrid, isAOTransparent) {
  // Vertex is at a corner of the face
  // Check 3 neighbors in the plane perpendicular to face normal
  
  // Example for UP face vertex at (x+0, y+1, z+0):
  // side1 = block at (-1, 0, 0) relative to vertex = West
  // side2 = block at (0, 0, -1) relative to vertex = North  
  // corner = block at (-1, 0, -1) = Northwest
  
  const side1Solid = isSolidForAO(side1Pos);
  const side2Solid = isSolidForAO(side2Pos);
  const cornerSolid = isSolidForAO(cornerPos);
  
  if (side1Solid && side2Solid) return 0; // Maximum occlusion
  return 3 - side1Solid - side2Solid - cornerSolid;
}

const AO_BRIGHTNESS = [0.5, 0.7, 0.85, 1.0]; // Same as full cubes
```

#### 5. Self-AO for Internal Faces

For faces without `cullface` (internal faces like stair corners):

```javascript
function calculateSelfAO(face, adjacentFaces) {
  // Simple case: uniform self-shadow
  if (!face.cullface) {
    return 0.92; // Mild darkening for internal geometry
  }
  return 1.0; // Boundary faces get full brightness (AO from geometry instead)
}
```

#### 6. AO-Transparent Block Classification

Blocks that don't cause AO occlusion:
- Air (block ID 0)
- Glass (all types)
- Leaves
- Non-cube blocks (slabs, stairs, fences, plants, etc.)
- Water, ice, slime block, honey block

```javascript
// Already implemented in BlockRegistry
function isAOTransparent(blockId) {
  return blockId === 0 || 
         isGlass[blockId] ||
         isLeaves[blockId] ||
         isNonCube[blockId] ||
         SPECIAL_AO_TRANSPARENT.has(blockId);
}
```

---

## Implementation Plan

### Phase 1: Unify AO Calculation Logic

**Task 1.1: Create shared AO helper in WASM**

Add to `src/wasm-mesher/src/mesher/ao.rs`:

```rust
/// Calculate AO level for a vertex based on 3 neighbors
/// Returns 0-3 (0 = darkest, 3 = brightest)
pub fn calculate_vertex_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    vertex_x: i32, vertex_y: i32, vertex_z: i32,
    side1_offset: (i32, i32, i32),
    side2_offset: (i32, i32, i32),
) -> u8 {
    let is_ao_solid = |x, y, z| {
        let block_id = grid.get_block_id(x, y, z);
        if block_id == 0 { return false; }
        if lookups.is_ao_transparent[block_id as usize] { return false; }
        lookups.is_opaque[block_id as usize]
    };
    
    let side1 = is_ao_solid(
        vertex_x + side1_offset.0,
        vertex_y + side1_offset.1,
        vertex_z + side1_offset.2
    );
    let side2 = is_ao_solid(
        vertex_x + side2_offset.0,
        vertex_y + side2_offset.1,
        vertex_z + side2_offset.2
    );
    
    if side1 && side2 { return 0; } // Maximum occlusion
    
    let corner = is_ao_solid(
        vertex_x + side1_offset.0 + side2_offset.0,
        vertex_y + side1_offset.1 + side2_offset.1,
        vertex_z + side1_offset.2 + side2_offset.2
    );
    
    3 - (side1 as u8) - (side2 as u8) - (corner as u8)
}
```

**Task 1.2: Update mesher_v3.rs to use geometry AO for boundary faces**

```rust
fn calculate_face_ao_v3(...) -> [VertexLight; 4] {
    // ... existing bilinear light sampling ...
    
    for (i, vertex) in face.vertices.iter().enumerate() {
        let (sky, block) = sample_smooth_light_at_vertex(...);
        
        // Determine AO based on face type
        let ao = if face.cullface.is_some() {
            // Boundary face: calculate geometry AO
            let ao_level = calculate_vertex_ao_for_face(
                grid, lookups, vertex_world_pos, face_dir, vertex_corner
            );
            AO_BRIGHTNESS[ao_level as usize]
        } else {
            // Internal face: use self-AO
            0.92
        };
        
        result[i] = VertexLight { sky, block, ao };
    }
    
    result
}
```

**Task 1.3: Update JS ModelMesher with same logic**

Mirror the WASM changes in JavaScript for consistency.

### Phase 2: Ensure Consistent Lookups

**Task 2.1: Verify isAOTransparent includes all non-cubes**

Ensure `BlockRegistry.js` correctly classifies:
- All stair variants
- All slab variants
- All wall variants
- All fence/fence_gate variants
- All door/trapdoor variants
- Signs, banners, torches
- Rails, redstone components
- Plants, crops, flowers

**Task 2.2: Pass lookups correctly to model mesher**

Ensure the WASM model mesher receives the `is_ao_transparent` lookup table.

### Phase 3: Vertex Corner Mapping for Model Faces

**Task 3.1: Map model vertices to AO neighbor offsets**

For each of the 6 face directions, define which neighbors affect each vertex:

```rust
// For UP face, vertices are at corners of the face
// Vertex order in baked models: [V0, V1, V2, V3]
// V0 = (-X, +Z), V1 = (+X, +Z), V2 = (+X, -Z), V3 = (-X, -Z)

const AO_OFFSETS_UP: [[(i32, i32, i32); 2]; 4] = [
    [(-1, 0, 0), (0, 0, 1)],   // V0: check West, South
    [(1, 0, 0), (0, 0, 1)],    // V1: check East, South
    [(1, 0, 0), (0, 0, -1)],   // V2: check East, North
    [(-1, 0, 0), (0, 0, -1)],  // V3: check West, North
];
```

**Task 3.2: Handle rotated models**

When models are rotated (y_rotation), transform the AO neighbor offsets accordingly:

```rust
fn rotate_ao_offsets(offsets: [(i32, i32, i32); 2], y_rotation: u8) -> [(i32, i32, i32); 2] {
    // Apply same rotation as vertex positions
}
```

### Phase 4: Testing & Validation

**Task 4.1: Create visual test cases**

Add test locations to `regressionTests.config.js`:
- Slabs next to full blocks (should show corner shadows)
- Stairs in corners (should show graduated AO)
- Walls connecting to blocks (should show shadows)
- Underground with block light (should show warm tones)

**Task 4.2: Compare with Minecraft**

Screenshot comparison of key scenarios:
- Stair spiral with AO
- Slab floor with varying light
- Mixed partial/full blocks

---

## Shader Integration

No shader changes needed. The shader already:
1. Samples lightmap using per-vertex (skyLight, blockLight)
2. Multiplies by vertex color (which contains AO factor)
3. Applies biome tint and fog

```glsl
// modelVertexShader (existing)
vColor = vec3(vertexColor.rgb); // Contains AO

// modelFragmentShader (existing)
vec3 aoColor = vColor.rgb;
vec3 lightColor = texture2D(uLightmap, vLightUV).rgb;
vec3 finalColor = texColor.rgb * lightColor * aoColor;
```

---

## Performance Considerations

### Impact
- **Geometry AO calculation**: ~4 lookups per vertex × 4 vertices per face
- Additional lookups for is_ao_transparent check
- Bilinear interpolation (already implemented): 4 light samples per vertex

### Mitigation
- Cache is_ao_transparent as Uint8Array lookup table (already done)
- Avoid redundant block lookups by batching per-face
- WASM implementation is fast; JS is fallback only

### Estimated Impact
- Negligible for normal scenes
- Model meshing ~5-10% slower due to AO calculations
- Far outweighed by visual quality improvement

---

## Summary

| Component | Current State | AOv3 Change |
|-----------|--------------|-------------|
| Light Grid | ✅ Working | No change |
| Lightmap | ✅ Working | No change |
| Full Cube AO | ✅ Working | No change |
| Model Bilinear Light | ✅ Fixed | Keep as-is |
| Model Geometry AO | ❌ Missing | **Add for boundary faces** |
| Model Self-AO | ⚠️ Simplistic | Keep for internal faces |
| isAOTransparent | ⚠️ Partial | **Verify completeness** |
| Dimension Lighting | ✅ Working | No change |

### Files to Modify

1. `src/wasm-mesher/src/models/mesher_v3.rs` - Add geometry AO for boundary faces
2. `src/mesh/ModelMesher.js` - Mirror WASM changes
3. `src/mesh/BlockRegistry.js` - Verify isAOTransparent coverage
4. `test/e2e/regressionTests.config.js` - Add AO test cases

### Success Criteria

1. Slab next to full block shows corner shadows matching Minecraft
2. Stair internal corners are darker than external faces
3. Light gradients are smooth across all block types
4. No black faces on any block in any orientation
5. Underground areas are properly dark
6. Block light has warm orange tint everywhere
