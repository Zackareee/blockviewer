# Minecraft Shaders - Deep Dive Reference

This document provides comprehensive documentation of Minecraft's shader system, focusing on lighting, ambient occlusion, and block rendering.

## Table of Contents
1. [Shader Architecture](#shader-architecture)
2. [Lighting System](#lighting-system)
3. [Lightmap Generation](#lightmap-generation)
4. [Ambient Occlusion](#ambient-occlusion)
5. [Block/Terrain Rendering](#blockterrain-rendering)
6. [Uniform Buffer Objects](#uniform-buffer-objects)
7. [Shader Include Files](#shader-include-files)

---

## Shader Architecture

### File Structure
```
assets/minecraft/shaders/
├── core/           # Main rendering shaders
│   ├── terrain.vsh/fsh      # Chunk terrain rendering
│   ├── block.vsh/fsh        # Block entity rendering
│   ├── entity.vsh/fsh       # Entity rendering
│   ├── lightmap.fsh         # Lightmap texture generation
│   └── ...
├── include/        # Reusable GLSL modules
│   ├── light.glsl           # Directional lighting
│   ├── fog.glsl             # Fog calculations
│   ├── globals.glsl         # Global uniforms
│   ├── projection.glsl      # Projection matrix
│   ├── chunksection.glsl    # Chunk section data
│   └── dynamictransforms.glsl # Dynamic transforms
└── post/           # Post-processing shaders
```

### Shader Types
| Extension | Purpose |
|-----------|---------|
| `.vsh` | Vertex shader |
| `.fsh` | Fragment shader |
| `.glsl` | Include file (no main()) |

### Import System
Minecraft uses `#moj_import` directives:
```glsl
#moj_import <minecraft:light.glsl>
#moj_import <minecraft:fog.glsl>
```

---

## Lighting System

### Overview
Minecraft uses a **two-component lighting system**:

1. **Sky Light (0-15)** - Light from the sky, affected by day/night cycle
2. **Block Light (0-15)** - Light from light-emitting blocks (torches, glowstone, etc.)

These are combined in a **16x16 lightmap texture** sampled at runtime.

### Light Data Flow
```
World Light Data (per-block)
    ↓
Packed as UV2 attribute (ivec2)
    ↓
Vertex Shader: sample lightmap texture
    ↓
Fragment Shader: multiply with albedo color
```

### UV2 Attribute Format
```glsl
in ivec2 UV2;  // Light coordinates
// UV2.x = block light level (0-240, step 16)
// UV2.y = sky light level (0-240, step 16)
```

The UV2 values are scaled: `actual_level = UV2 / 16` where level ∈ [0, 15].

### Lightmap Sampling
```glsl
vec4 minecraft_sample_lightmap(sampler2D lightMap, ivec2 uv) {
    return texture(lightMap, clamp((uv / 256.0) + 0.5 / 16.0, 
                                    vec2(0.5 / 16.0), 
                                    vec2(15.5 / 16.0)));
}
```

**Key points:**
- Lightmap is a 16x16 texture
- X axis = block light (0-15)
- Y axis = sky light (0-15)
- UV is clamped to avoid sampling outside valid range
- 0.5/16.0 offset centers sampling in each texel

---

## Lightmap Generation

The `lightmap.fsh` shader generates the 16x16 lightmap texture every frame.

### Uniform Block
```glsl
layout(std140) uniform LightmapInfo {
    float AmbientLightFactor;   // Dimension ambient (Nether/End = 0.1)
    float SkyFactor;            // Sky light multiplier (day/night)
    float BlockFactor;          // Block light multiplier
    float NightVisionFactor;    // Night vision effect (0-1)
    float DarknessScale;        // Darkness effect intensity
    float DarkenWorldFactor;    // World darkening (thunder)
    float BrightnessFactor;     // Brightness gamma setting
    vec3 SkyLightColor;         // Sky light RGB
    vec3 AmbientColor;          // Ambient light RGB
};
```

### Brightness Curve
```glsl
float get_brightness(float level) {
    return level / (4.0 - 3.0 * level);
}
```

This creates a **non-linear brightness curve** where:
- Level 0 → 0.0 brightness
- Level 0.5 → 0.2 brightness
- Level 1.0 → 1.0 brightness (clamped)

**Plotted curve:**
```
Brightness
1.0 |               *
0.8 |           *
0.6 |       *
0.4 |    *
0.2 |  *
0.0 |*
    +------------------
    0   0.25  0.5  0.75  1.0  Level
```

### Block Light Color
Block light has a distinctive warm/orange tint:
```glsl
vec3 color = vec3(
    block_brightness,                                           // R: full
    block_brightness * ((block_brightness * 0.6 + 0.4) * 0.6 + 0.4),  // G: reduced
    block_brightness * (block_brightness * block_brightness * 0.6 + 0.4)  // B: cubic falloff
);
```

At full block light (15):
- R: 1.0
- G: ~0.85
- B: ~0.64

This gives torchlight its characteristic orange glow.

### Sky Light Application
```glsl
color += lightmapInfo.SkyLightColor * sky_brightness;
```

Sky light color is provided by the game based on:
- Time of day
- Weather
- Dimension

### Special Effects
1. **Night Vision**: Scales colors up uniformly until one channel hits 1.0
2. **Darkness Effect**: Subtracts `DarknessScale` from all channels (Warden)
3. **Gamma Correction**: `notGamma()` function applies brightness setting

---

## Ambient Occlusion

### Overview
Minecraft's AO is computed **per-vertex** on the CPU during mesh building, not in shaders. The AO value is baked into the vertex color.

### AO Algorithm (CPU-side)
For each vertex of a block face:

1. Identify the 3 corner neighbors (side1, side2, corner) relative to that vertex
2. Check if each neighbor is a solid, opaque block
3. Calculate AO level:

```java
// Simplified AO calculation
if (side1 && side2) {
    // Both sides solid = maximum occlusion
    aoLevel = 0;
} else {
    // Count solid neighbors
    aoLevel = 3 - (side1 + side2 + corner);
}
// aoLevel: 0 = darkest, 3 = brightest
```

### AO Levels
| AO Level | Multiplier | Condition |
|----------|------------|-----------|
| 3 | 1.0 | No solid neighbors |
| 2 | ~0.8 | 1 solid neighbor |
| 1 | ~0.6 | 2 solid neighbors |
| 0 | ~0.2 | Both sides solid (corner blocked) |

### Vertex Winding Fix
When AO values at diagonal corners differ significantly, Minecraft flips the quad's triangle winding to avoid the "diagonal shadow" artifact:

```java
// If AO at corners 0,2 differs significantly from 1,3
// Flip the winding order to put the edge on the darker diagonal
if (ao[0] + ao[2] < ao[1] + ao[3]) {
    // Flip quad triangulation
}
```

### AO-Transparent Blocks
Certain blocks don't block AO even though they have geometry:
- Glass and glass panes
- Leaves
- Ice
- Slime blocks
- Honey blocks
- Fences, walls
- All non-full-cube blocks

---

## Block/Terrain Rendering

### terrain.vsh (Chunk Rendering)
```glsl
in vec3 Position;   // Block-relative position
in vec4 Color;      // Vertex color (includes AO, biome tint)
in vec2 UV0;        // Texture coordinates
in ivec2 UV2;       // Light coordinates (block, sky)
in vec3 Normal;     // Face normal

uniform sampler2D Sampler2;  // Lightmap texture

void main() {
    // Position includes chunk offset
    vec3 pos = Position + (ChunkPosition - CameraBlockPos) + CameraOffset;
    gl_Position = ProjMat * ModelViewMat * vec4(pos, 1.0);
    
    // Sample lightmap and multiply with vertex color
    vertexColor = Color * minecraft_sample_lightmap(Sampler2, UV2);
    texCoord0 = UV0;
}
```

### terrain.fsh
```glsl
void main() {
    // Sample block texture with RGSS anti-aliasing
    vec4 color = sampleRGSS(Sampler0, texCoord0, 1.0f / TextureSize);
    
    // Apply vertex color (light + AO + tint)
    color *= vertexColor;
    
    // Apply fog
    fragColor = apply_fog(color, ...);
}
```

### block.vsh/fsh (Block Entities)
Similar to terrain but uses `ModelOffset` instead of chunk positioning:
```glsl
vec3 pos = Position + ModelOffset;
```

---

## Uniform Buffer Objects

### Global Uniforms (globals.glsl)
```glsl
layout(std140) uniform Globals {
    ivec3 CameraBlockPos;  // Camera's block coordinates
    vec3 CameraOffset;     // Sub-block camera offset
    vec2 ScreenSize;       // Viewport dimensions
    float GlintAlpha;      // Enchantment glint alpha
    float GameTime;        // Game tick (0-24000 cycle)
    int MenuBlurRadius;    // Menu blur amount
    int UseRgss;           // Use RGSS anti-aliasing
};
```

### Chunk Section Uniforms (chunksection.glsl)
```glsl
layout(std140) uniform ChunkSection {
    mat4 ModelViewMat;      // View matrix for this chunk
    float ChunkVisibility;  // Fade factor for chunk loading
    ivec2 TextureSize;      // Block atlas size
    ivec3 ChunkPosition;    // Chunk world position
};
```

### Fog Uniforms (fog.glsl)
```glsl
layout(std140) uniform Fog {
    vec4 FogColor;
    float FogEnvironmentalStart;  // Biome fog start
    float FogEnvironmentalEnd;    // Biome fog end
    float FogRenderDistanceStart; // Render distance fog start
    float FogRenderDistanceEnd;   // Render distance fog end
    float FogSkyEnd;              // Sky fog distance
    float FogCloudsEnd;           // Cloud fog distance
};
```

### Lighting Uniforms (light.glsl)
```glsl
layout(std140) uniform Lighting {
    vec3 Light0_Direction;  // Primary light direction
    vec3 Light1_Direction;  // Secondary light direction
};
```

**Note:** These are for **entity lighting** (smooth shading), not block lighting.

---

## Shader Include Files

### light.glsl - Directional Lighting
Used for entities and items, not terrain.

```glsl
#define MINECRAFT_LIGHT_POWER   (0.6)
#define MINECRAFT_AMBIENT_LIGHT (0.4)

vec4 minecraft_mix_light(vec3 lightDir0, vec3 lightDir1, vec3 normal, vec4 color) {
    vec2 light = vec2(dot(lightDir0, normal), dot(lightDir1, normal));
    float lightAccum = min(1.0, (light.x + light.y) * MINECRAFT_LIGHT_POWER + MINECRAFT_AMBIENT_LIGHT);
    return vec4(color.rgb * lightAccum, color.a);
}
```

Key values:
- Light power: 60% of dot product
- Ambient: 40% minimum brightness
- Two lights allow for fill lighting

### fog.glsl - Fog Calculations
```glsl
vec4 apply_fog(vec4 inColor, ...) {
    float fogValue = max(
        linear_fog_value(sphericalDistance, envStart, envEnd),
        linear_fog_value(cylindricalDistance, renderStart, renderEnd)
    );
    return vec4(mix(inColor.rgb, fogColor.rgb, fogValue * fogColor.a), inColor.a);
}
```

Two fog types combined:
1. **Spherical** - Environmental fog (water, lava, powder snow)
2. **Cylindrical** - Render distance fog (ignores vertical distance)

---

## Key Insights for Implementation

### Replicating Minecraft's Look

1. **Use the brightness curve**: `level / (4.0 - 3.0 * level)`
2. **Block light is warm**: Apply RGB multipliers (1.0, 0.85, 0.64)
3. **AO is per-vertex**: Calculate on CPU, bake into vertex color
4. **AO-aware merging**: Don't merge faces with different AO values
5. **Lightmap is 16x16**: Pre-compute, sample in shader
6. **Light levels are discrete**: 0-15, not continuous

### Common Mistakes

1. ❌ Calculating AO in fragment shader (too slow, wrong result)
2. ❌ Linear light falloff (should be non-linear curve)
3. ❌ White block light (should be orange-tinted)
4. ❌ Merging faces with different AO (causes banding)
5. ❌ Sampling light at face center (should be per-vertex)

### Performance Tips

1. Bake AO into vertex color at mesh build time
2. Use a single lightmap texture, sample per-vertex
3. Greedy mesh only when AO values match
4. Use ivec2 for light UVs to avoid floating-point precision issues

