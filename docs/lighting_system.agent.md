# Block Viewer Lighting System

This document describes how the lighting system works in Block Viewer, including the sky light and block light propagation, smooth vertex lighting, and common bugs with their fixes.

## Overview

Block Viewer replicates Minecraft's lighting system with two types of light:

1. **Sky Light (0-15)**: Natural daylight from the sun. Full brightness (15) outdoors, decreases in shadows and underground.
2. **Block Light (0-15)**: Light from torches, glowstone, lava, and other light-emitting blocks.

Both light types are stored per-block in a `LightGrid` and applied to mesh vertices during the greedy meshing process.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `src/mesh/LightGrid.js` | Sparse storage for light values (main thread) |
| `src/mesh/LightPropagator.js` | Sky light flood-fill propagation |
| `src/mesh/BlockLightPropagator.js` | Block light flood-fill propagation (main thread) |
| `src/mesh/FastMesher.js` | Greedy mesher with smooth light sampling (JavaScript) |
| `src/mesh/workers/SuperChunkWorker.js` | Worker with light grid, propagation, and meshing |
| `src/wasm-mesher/src/mesher/ao.rs` | WASM light sampling and AO calculations |
| `src/wasm-mesher/src/mesher/greedy.rs` | WASM greedy mesher with light-based merge checking |
| `src/wasm-mesher/src/grid/light_grid.rs` | WASM light grid implementation |
| `src/viewer/materials/TexturedMaterial.js` | Shader that samples lightmap texture |
| `src/mesh/LightmapGenerator.js` | Generates the 16x16 lightmap texture |

### Data Flow

```
1. Chunk Loading
   └── ChunkStreamer loads region files
       └── Chunks decoded by ChunkDecoder (extracts SkyLight/BlockLight from NBT)

2. Light Propagation (if no Minecraft light data)
   ├── propagateSkyLight() - Heightmap-based flood fill
   └── propagateBlockLight() - BFS from light sources

3. Meshing
   ├── WASM Mesher (fast path)
   │   └── Samples light per-vertex with smooth AO
   └── JavaScript Mesher (fallback)
       └── sampleVertexLight() / sampleSmoothLight()

4. Rendering
   └── Shader samples lightmap texture using (blockLight, skyLight) UV
```

---

## Light Storage Format

Light values are stored in a `Uint8Array` with one byte per block:

```
Byte format: [block_light (4 bits)] [sky_light (4 bits)]
             High nibble            Low nibble

Example: 0xE7 = block light 14, sky light 7
```

### LightGrid Class

```javascript
class LightGrid {
  sections: Map<string, Uint8Array>  // Section key -> 4096 bytes
  hasMinecraftLightData: boolean     // True if loaded from NBT
  minChunkX, maxChunkX, ...          // Bounds for smart defaults
}
```

**Key Methods:**
- `getLight(x, y, z)` → `{ skyLight: 0-15, blockLight: 0-15 }`
- `getSkyLight(x, y, z)` → `0-15`
- `setSkyLight(x, y, z, level)`
- `getBlockLight(x, y, z)` → `0-15`
- `setBlockLight(x, y, z, level)`

---

## Sky Light Propagation

Implemented in `LightPropagator.js` and the worker's `propagateSkyLight()`.

### Algorithm

1. **Build Heightmap**: For each (X, Z) column, find the highest opaque block
2. **Set Initial Light**: All positions above the heightmap get `skyLight = 15`
3. **BFS Flood Fill**: Light spreads from sunlit areas into shadows
   - Light decreases by 1 per block traveled
   - Opaque blocks stop light completely
   - Glass/transparent blocks allow light through
   - Water slightly attenuates (opacity 1)

```javascript
// Heightmap determines which blocks receive direct sunlight
if (worldY > heightmap[x, z]) {
  skyLight = 15;  // Full sunlight
} else {
  skyLight = 0;   // Start dark, propagation will fill in
}
```

---

## Block Light Propagation

Implemented in `BlockLightPropagator.js` and the worker's `propagateBlockLight()`.

### Light Emission Levels

| Block | Light Level |
|-------|-------------|
| Beacon, Glowstone, Sea Lantern | 15 |
| Torch, End Rod | 14 |
| Furnace (lit) | 13 |
| Nether Portal | 11 |
| Soul Torch, Crying Obsidian | 10 |
| Redstone Torch, Ender Chest | 7 |
| Magma Block | 3 |
| Candle (single) | 3 |

### Algorithm

1. **Find Light Sources**: Scan all blocks for light-emitting blocks
2. **Initialize**: Set block light at each source to its emission level
3. **BFS Flood Fill**: Light spreads to neighbors
   - Light decreases by 1 per block
   - Opaque blocks stop propagation
   - Water slightly attenuates

---

## Smooth Vertex Lighting

To avoid flat-shaded faces, light is sampled at each vertex corner and interpolated across the face.

### Vertex Light Sampling

For each vertex of a quad, sample light from the 4 adjacent blocks in the face's plane and average:

```javascript
// For a TOP face vertex at corner (x, y, z)
for (dx = -1 to 0) {
  for (dz = -1 to 0) {
    if (!isSolid(x + dx, y, z + dz)) {
      totalSky += getLight(x + dx, y, z + dz).skyLight;
      count++;
    }
  }
}
avgSky = totalSky / count;
```

### Ambient Occlusion (AO)

AO creates subtle shadows in corners where blocks meet. Each vertex checks 3 neighbors:

```
For each vertex, check: side1, side2, corner (diagonal)

AO Level = 3 - side1 - side2 - corner
         = 0 (darkest, both sides + corner blocked)
         = 3 (brightest, fully exposed)

Brightness multipliers: [0.50, 0.70, 0.85, 1.00]
```

---

## Greedy Meshing and Light

The greedy mesher combines adjacent faces of the same block type into larger quads. To preserve smooth lighting, faces can only merge if they have identical light values.

### Light Merge Check (WASM)

```rust
// src/wasm-mesher/src/mesher/ao.rs
const LIGHT_TOLERANCE: u8 = 0;  // Must be exact match

fn light_within_tolerance(sky1, block1, sky2, block2) -> bool {
    abs(sky1 - sky2) <= LIGHT_TOLERANCE &&
    abs(block1 - block2) <= LIGHT_TOLERANCE
}
```

### Light Merge Check (JavaScript)

```javascript
// src/mesh/FastMesher.js
function canMergeBlockLight(baseLight, checkLight, threshold = 0) {
  return Math.abs(baseLight.skyLight - checkLight.skyLight) <= threshold &&
         Math.abs(baseLight.blockLight - checkLight.blockLight) <= threshold;
}
```

**Important**: The tolerance MUST be 0 for smooth lighting. Any tolerance > 0 creates visible "steps" in light gradients.

---

## Shader Lightmap Sampling

The shader uses a 16x16 lightmap texture that encodes brightness based on light levels:

```glsl
// Vertex shader
vLightUV = vec2((blockLight + 0.5) / 16.0, (skyLight + 0.5) / 16.0);

// Fragment shader
float brightness = texture2D(lightmap, vLightUV).r;
```

The lightmap is generated by `LightmapGenerator.js` using Minecraft's brightness formula:

```javascript
// Sky light brightness (linear at noon)
const skyBrightness = level / 15.0;

// Block light brightness (warm orange tint)
const r = brightness;
const g = brightness * ((brightness * 0.6 + 0.4) * 0.6 + 0.4);
const b = brightness * (brightness * brightness * brightness * 0.6 + 0.4);
```

---

## Common Bugs and Fixes

### Bug 1: Black Faces on Partial Blocks at Super-Chunk Boundaries

**Symptoms**: Slabs, stairs, and other partial blocks show completely black faces at the edges where super-chunks meet.

**Root Cause**: When the `SuperChunkWorkerPool` builds model meshes on the main thread using serialized grids from the worker, neighbor chunk data wasn't always included. The `_collectNeighborDataForWorker()` function only included chunks with `isRawCompressed = true`, missing neighbors that were built via the main-thread path.

When `ModelMesher` sampled light for a partial block at the boundary, if the adjacent position's section didn't exist in the reconstructed grid, `getLight()` returned `{skyLight: 0, blockLight: 0}` (the new safe default), causing black faces.

**Files Affected**:
- `src/viewer/SuperChunkManager.js`
- `src/mesh/workers/SuperChunkWorker.js`

**Fix**:
1. Updated `_collectNeighborDataForWorker()` to handle both raw compressed AND pre-parsed NBT chunk data
2. Added `isParsed` flag to allow worker to handle pre-parsed data directly
3. Worker now decodes both types of neighbor data into grids

```javascript
// SuperChunkManager.js - Now handles both data types
if (chunkInfo.isRawCompressed && chunkInfo.data.compressedData) {
  // Raw compressed - worker will decompress
  neighbors.push({ compressedData, compressionType, ... });
} else if (chunkInfo.data && !chunkInfo.isRawCompressed) {
  // Pre-parsed NBT - pass directly
  neighbors.push({ parsedData: chunkInfo.data, isParsed: true, ... });
}
```

---

### Bug 2: Daylight Appearing Underground

**Symptoms**: Underground caves and tunnels show bright lighting as if exposed to sunlight, even deep underground.

**Root Cause**: The `LightGrid.getLight()` method returned `{skyLight: 15, blockLight: 0}` for missing sections. This was correct for empty air ABOVE terrain but wrong for underground areas where sections might be missing from the serialized grid.

When Minecraft light data was present (`hasMinecraftLightData = true`), missing sections within the loaded chunk bounds should default to dark (sky=0), not bright (sky=15).

**Files Affected**:
- `src/mesh/LightGrid.js`
- `src/mesh/workers/SuperChunkWorker.js`

**Fix**:
1. Added bounds tracking to `LightGrid` (`minChunkX`, `maxChunkX`, etc.)
2. Updated `getLight()` to check if position is within loaded bounds
3. If within bounds AND has Minecraft data, default to dark; otherwise default to bright

```javascript
// LightGrid.js - Smart default for missing sections
getLight(worldX, worldY, worldZ) {
  const section = this.getSection(chunkX, chunkZ, sectionY);
  if (!section) {
    const withinBounds = 
      chunkX >= this.minChunkX && chunkX <= this.maxChunkX &&
      chunkZ >= this.minChunkZ && chunkZ <= this.maxChunkZ;
    
    if (this.hasMinecraftLightData && withinBounds) {
      return { skyLight: 0, blockLight: 0 };  // Underground
    }
    return { skyLight: 15, blockLight: 0 };  // Outside bounds
  }
  // ... normal lookup
}
```

---

### Bug 3: Streaky/Blocky Lighting Near Light Sources

**Symptoms**: Light from torches creates harsh rectangular zones instead of smooth gradients. Visible "steps" in brightness near any light source.

**Root Cause**: The WASM greedy mesher had `LIGHT_TOLERANCE = 2` in `ao.rs`, allowing blocks with light values differing by up to ±2 to merge. This meant:

- Torch emits light level 14
- Adjacent blocks have levels 13, 12, 11, 10...
- With tolerance 2: blocks at 14, 13, 12 merge → blocks at 13, 12, 11 merge → etc.
- Creates large quads with same corner light values → visible rectangular "steps"

Additionally, the worker was missing `propagateBlockLight()` entirely, so block light wasn't being computed when Minecraft data wasn't present.

**Files Affected**:
- `src/wasm-mesher/src/mesher/ao.rs`
- `src/mesh/FastMesher.js`
- `src/mesh/workers/SuperChunkWorker.js`

**Fix**:
1. Changed `LIGHT_TOLERANCE` from `2` to `0` in WASM (requires rebuild: `npm run build:wasm:release`)
2. Changed JavaScript `canMergeBlockLight()` default threshold from `1` to `0`
3. Added `propagateBlockLight()` function to worker
4. Added `getBlockLight()` and `setBlockLight()` methods to worker's `LightGrid`

```rust
// ao.rs - Strict light matching
const LIGHT_TOLERANCE: u8 = 0;  // Was 2
```

```javascript
// FastMesher.js - Strict light matching
function canMergeBlockLight(baseLight, checkLight, threshold = 0) {
  // ...
}
```

**Result**: Each block with a different light level creates its own face, allowing smooth GPU interpolation between vertex light values.

---

## Testing Lighting

### Visual Tests

1. **Torch Test**: Place torches on flat terrain at night. Light should gradient smoothly outward with no visible rectangles.

2. **Underground Test**: Go underground below sea level. Should be completely dark (black) with no sky light.

3. **Boundary Test**: Look at partial blocks (slabs, farmland) at chunk/super-chunk boundaries. All faces should be lit, no black faces.

### Code Locations for Debugging

```javascript
// Log light values at a position
const light = lightGrid.getLight(x, y, z);
console.log(`Light at ${x},${y},${z}: sky=${light.skyLight}, block=${light.blockLight}`);

// Check if Minecraft data is present
console.log('Has MC light data:', lightGrid.hasMinecraftLightData);

// Log WASM mesher light tolerance (in Rust code)
// Check LIGHT_TOLERANCE constant in ao.rs
```

---

## Performance Considerations

### Light Propagation Cost

- Sky light propagation: ~O(visible blocks) BFS iterations
- Block light propagation: ~O(blocks within light range) per source
- Typically 10-50ms for a super-chunk

### Mesh Impact of Strict Light Matching

With `LIGHT_TOLERANCE = 0`, more faces are generated because blocks can't merge across light boundaries. This increases:
- Vertex count by ~20-50% near light sources
- Draw call time slightly

This tradeoff is necessary for smooth lighting. The visual quality improvement far outweighs the performance cost.

### Optimization Tips

1. **Use Minecraft Light Data**: When loading worlds saved by Minecraft, the NBT includes pre-computed light. This is faster than propagating ourselves.

2. **Batch Light Updates**: If dynamically changing light (e.g., placing torches), batch updates and re-mesh affected chunks together.

3. **Worker Pipeline**: The `SuperChunkWorkerPool` does all light propagation off the main thread.

