# Minecraft Ambient Occlusion - Implementation Reference

This document provides detailed technical information about Minecraft's ambient occlusion (AO) system, including the exact algorithm used and how to replicate it.

## Overview

Minecraft's AO creates soft shadows at block corners and edges. It's computed **per-vertex during mesh building** (CPU-side), not in shaders.

---

## The AO Algorithm

### Conceptual Model

For each vertex of a block face, we check 3 neighboring blocks:
- **Side1**: Block adjacent along one axis of the face
- **Side2**: Block adjacent along the other axis of the face  
- **Corner**: Block at the diagonal corner

```
Face: TOP (+Y), vertex at corner (0, 1, 0)

Looking down at the face from above:
    
         +Z
          ↑
    [Side2][Corner]
    [Block][Side1] → +X
    
Side1 = block at (+1, 0, 0) relative to vertex
Side2 = block at (0, 0, +1) relative to vertex
Corner = block at (+1, 0, +1) relative to vertex
```

### AO Calculation

```java
public int calculateAO(boolean side1Solid, boolean side2Solid, boolean cornerSolid) {
    if (side1Solid && side2Solid) {
        // Corner is completely blocked - darkest
        return 0;
    }
    // Count open neighbors (max 3)
    return 3 - (side1Solid ? 1 : 0) - (side2Solid ? 1 : 0) - (cornerSolid ? 1 : 0);
}
```

| Side1 | Side2 | Corner | AO Level | Brightness |
|-------|-------|--------|----------|------------|
| false | false | false  | 3        | 100%       |
| true  | false | false  | 2        | ~80%       |
| false | true  | false  | 2        | ~80%       |
| false | false | true   | 2        | ~80%       |
| true  | true  | *      | 0        | ~20%       |
| true  | false | true   | 1        | ~60%       |
| false | true  | true   | 1        | ~60%       |

*When both sides are solid, the corner is blocked regardless of its actual state.

### AO to Brightness Conversion

```java
// Minecraft's AO brightness values
float[] aoBrightness = {0.2f, 0.6f, 0.8f, 1.0f};
// Index by AO level: 0=darkest, 3=brightest

float brightness = aoBrightness[aoLevel];
```

---

## Vertex-to-Neighbor Mapping

### TOP Face (+Y normal)

```
Face vertices (looking down from +Y):
    
    V0(x,y,z+1) -------- V1(x+1,y,z+1)
         |                    |
         |      FACE          |
         |                    |
    V3(x,y,z) ---------- V2(x+1,y,z)
    
Sample Y = y (one block above the face, in the air space)
```

| Vertex | Position | Side1 Offset | Side2 Offset | Corner Offset |
|--------|----------|--------------|--------------|---------------|
| V0 | (x, y, z+1) | (-1, 0, 0) | (0, 0, +1) | (-1, 0, +1) |
| V1 | (x+1, y, z+1) | (+1, 0, 0) | (0, 0, +1) | (+1, 0, +1) |
| V2 | (x+1, y, z) | (+1, 0, 0) | (0, 0, -1) | (+1, 0, -1) |
| V3 | (x, y, z) | (-1, 0, 0) | (0, 0, -1) | (-1, 0, -1) |

### BOTTOM Face (-Y normal)

```
Face vertices (looking up from -Y):
    
    V0(x,y,z) ---------- V1(x+1,y,z)
         |                    |
         |      FACE          |
         |                    |
    V3(x,y,z+1) -------- V2(x+1,y,z+1)
    
Sample Y = y - 1 (one block below the face)
```

### NORTH Face (-Z normal)

```
Face vertices (looking from -Z toward +Z):
    
    V0(x,y+1,z) -------- V1(x+1,y+1,z)
         |                    |
         |      FACE          |
         |                    |
    V3(x,y,z) ---------- V2(x+1,y,z)
    
Sample Z = z - 1 (one block in front of face)
```

### SOUTH Face (+Z normal)

```
Sample Z = z + 1 (one block behind face)
```

### EAST Face (+X normal)

```
Sample X = x + 1 (one block to the right of face)
```

### WEST Face (-X normal)

```
Sample X = x - 1 (one block to the left of face)
```

---

## Smooth Light Sampling

In addition to AO, Minecraft samples light from 4 neighboring blocks and averages them for each vertex. This creates smooth light gradients.

### Algorithm

```java
float[] sampleSmoothLight(int x, int y, int z, Direction face) {
    // Get the 4 blocks touching this vertex corner
    // in the plane perpendicular to the face normal
    
    float totalSky = 0;
    float totalBlock = 0;
    int count = 0;
    
    for (each of 4 neighbor positions) {
        Block block = getBlock(neighborX, neighborY, neighborZ);
        if (block.isTransparentForLighting()) {
            Light light = getLight(neighborX, neighborY, neighborZ);
            totalSky += light.sky;
            totalBlock += light.block;
            count++;
        }
    }
    
    if (count == 0) {
        // Fallback to direct sample
        Light light = getLight(x, y, z);
        return new float[]{light.sky, light.block};
    }
    
    return new float[]{totalSky / count, totalBlock / count};
}
```

### Combining AO and Light

The final vertex brightness is:
```java
float finalBrightness = smoothLightLevel * aoBrightness[aoLevel];
```

This is applied to the vertex color, which is then interpolated across the face by the GPU.

---

## AO-Transparent Blocks

These blocks should NOT contribute to AO calculations (treat as air):

### Full List
- Air (block ID 0)
- All glass types (glass, stained glass, tinted glass)
- Glass panes
- Ice (regular, packed, blue)
- Leaves (all types)
- Slime block
- Honey block
- Barrier (invisible)
- Light block (invisible)
- Structure void

### Non-Cube Blocks
All non-full-cube blocks are AO-transparent:
- Slabs (all positions)
- Stairs
- Fences and walls
- Doors and trapdoors
- Signs
- Torches
- Flowers and plants
- Rails
- Redstone components
- Ladders
- Chains
- Lanterns
- Candles
- Etc.

### Detection Logic
```java
boolean isAOTransparent(Block block) {
    if (block.isAir()) return true;
    if (block.isGlass()) return true;
    if (block.isLeaves()) return true;
    if (block.isIce()) return true;
    if (!block.isFullCube()) return true;
    if (block == Blocks.SLIME_BLOCK) return true;
    if (block == Blocks.HONEY_BLOCK) return true;
    return false;
}
```

---

## Greedy Meshing with AO

### The Problem

When greedy meshing merges multiple block faces into one quad, only the 4 corner vertices get AO values. The GPU interpolates between these corners, but if the AO varies in the middle of the merged face, visual artifacts (banding) occur.

```
Merged 4x4 face with varying AO:

    V0(AO=3)---------------V1(AO=3)
         |                    |
         |  Actual terrain    |
         |  has AO=1 here     |
         |      ↓             |
    V3(AO=3)---------------V2(AO=1)
    
GPU interpolates, but misses the AO=1 in the middle
→ Creates visible diagonal bands
```

### The Solution

Only merge faces if their **shared edge vertices have matching AO values**.

```java
boolean canMerge(Face face1, Face face2) {
    // Get shared edge vertices
    int[] shared1 = face1.getSharedEdgeAO(direction);
    int[] shared2 = face2.getSharedEdgeAO(direction);
    
    return shared1[0] == shared2[0] && shared1[1] == shared2[1];
}
```

### Implementation Steps

1. For each potential merge, compute AO at the shared edge vertices
2. Compare AO values at the shared positions
3. Only merge if AO matches exactly
4. This naturally breaks merges at terrain edges where AO varies

---

## Quad Triangulation

### The Problem

When a quad has different AO values at opposite corners, the triangulation direction affects which diagonal gets the shadow:

```
Standard triangulation:      Flipped triangulation:
    
    V0-------V1               V0-------V1
    |\       |                |       /|
    | \   T2 |                | T1   / |
    |  \     |                |     /  |
    |T1 \    |                |    /T2 |
    V3-------V2               V3-------V2
    
Diagonal: V0-V2               Diagonal: V1-V3
```

### The Fix

Compare AO sums of opposite corners and flip if needed:

```java
void triangulateQuad(int[] ao) {
    // ao[0..3] = AO values at V0, V1, V2, V3
    
    if (ao[0] + ao[2] > ao[1] + ao[3]) {
        // Use standard triangulation (V0-V2 diagonal)
        emitTriangle(V0, V1, V2);
        emitTriangle(V0, V2, V3);
    } else {
        // Flip triangulation (V1-V3 diagonal)
        emitTriangle(V1, V2, V3);
        emitTriangle(V1, V3, V0);
    }
}
```

This ensures the edge is placed along the darker diagonal, making shadows look more natural.

---

## Code Example: Complete AO Calculation

```javascript
/**
 * Calculate AO for all 4 vertices of a TOP face
 * @param {number} x, y, z - Block position
 * @param {Function} isSolid - Returns true if block is solid for AO
 * @returns {number[]} AO levels for V0, V1, V2, V3
 */
function calculateTopFaceAO(x, y, z, isSolid) {
    // Sample one block above the face
    const sy = y + 1;
    
    // Precompute neighbor solidity
    const n = isSolid(x, sy, z - 1);    // North
    const s = isSolid(x, sy, z + 1);    // South
    const e = isSolid(x + 1, sy, z);    // East
    const w = isSolid(x - 1, sy, z);    // West
    const ne = isSolid(x + 1, sy, z - 1);
    const nw = isSolid(x - 1, sy, z - 1);
    const se = isSolid(x + 1, sy, z + 1);
    const sw = isSolid(x - 1, sy, z + 1);
    
    // V0: corner at (x, y+1, z+1) - check W, S, SW
    const ao0 = calculateCornerAO(w, s, sw);
    
    // V1: corner at (x+1, y+1, z+1) - check E, S, SE
    const ao1 = calculateCornerAO(e, s, se);
    
    // V2: corner at (x+1, y+1, z) - check E, N, NE
    const ao2 = calculateCornerAO(e, n, ne);
    
    // V3: corner at (x, y+1, z) - check W, N, NW
    const ao3 = calculateCornerAO(w, n, nw);
    
    return [ao0, ao1, ao2, ao3];
}

function calculateCornerAO(side1, side2, corner) {
    if (side1 && side2) {
        return 0;  // Maximum occlusion
    }
    return 3 - (side1 ? 1 : 0) - (side2 ? 1 : 0) - (corner ? 1 : 0);
}

// Convert AO level to brightness multiplier
const AO_BRIGHTNESS = [0.2, 0.6, 0.8, 1.0];
function aoToBrightness(aoLevel) {
    return AO_BRIGHTNESS[aoLevel];
}
```

---

## Debugging AO Issues

### Common Symptoms and Causes

| Symptom | Likely Cause |
|---------|--------------|
| Diagonal banding on merged faces | Not checking AO during greedy merge |
| Black corners on partial blocks | Not treating partial blocks as AO-transparent |
| No shadows at block junctions | AO calculation disabled or using wrong neighbor positions |
| Harsh/pixelated shadows | Not using smooth light averaging |
| Shadows on wrong faces | Sampling at wrong Y level (should be above face, not inside block) |

### Debug Visualization

Temporarily render AO levels as colors:
```javascript
const aoColors = [
    [0.2, 0.0, 0.0],  // AO=0: Dark red
    [0.6, 0.3, 0.0],  // AO=1: Orange
    [0.8, 0.8, 0.0],  // AO=2: Yellow
    [0.0, 1.0, 0.0],  // AO=3: Green
];
```

