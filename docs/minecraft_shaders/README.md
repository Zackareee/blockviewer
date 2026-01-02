# Minecraft Shader Documentation

This directory contains comprehensive documentation of Minecraft's shader and lighting system, extracted from version 1.21.11.

## Documentation Files

| File | Description |
|------|-------------|
| [`agent.md`](./agent.md) | **Main reference** - Shader architecture, lighting pipeline, UV2 format, uniform blocks |
| [`ambient_occlusion.agent.md`](./ambient_occlusion.agent.md) | **AO deep dive** - Algorithm, neighbor mapping, AO-transparent blocks, greedy meshing |
| [`lightmap.agent.md`](./lightmap.agent.md) | **Lightmap generation** - Brightness curve, block light color, sky light, special effects |

## Extracted Shaders

### Core Shaders (`core/`)

| Shader | Purpose | Key Features |
|--------|---------|--------------|
| `terrain.vsh/fsh` | Chunk/terrain rendering | Lightmap sampling, RGSS anti-aliasing |
| `block.vsh/fsh` | Block entity rendering | Similar to terrain but with ModelOffset |
| `entity.vsh/fsh` | Entity rendering | Directional lighting, per-face lighting |
| `lightmap.fsh` | Lightmap texture generation | Brightness curve, block/sky light mixing |
| `particle.vsh/fsh` | Particle rendering | Standard lightmap |

### Include Files (`include/`)

| File | Contents |
|------|----------|
| `light.glsl` | Directional lighting for entities (`MINECRAFT_LIGHT_POWER = 0.6`) |
| `fog.glsl` | Fog calculations (spherical + cylindrical) |
| `globals.glsl` | Global uniforms (CameraBlockPos, GameTime, etc.) |
| `chunksection.glsl` | Chunk section uniforms (ModelViewMat, ChunkPosition) |
| `projection.glsl` | Projection matrix and helpers |

## Quick Reference

### Brightness Curve
```glsl
float brightness = level / (4.0 - 3.0 * level);
```

### Block Light Color (Warm Orange)
```glsl
vec3 color = vec3(
    b,
    b * ((b * 0.6 + 0.4) * 0.6 + 0.4),
    b * (b * b * b * 0.6 + 0.4)
);
```

### UV2 Light Coordinates
```glsl
// UV2.x = block light * 16 (0-240)
// UV2.y = sky light * 16 (0-240)
vec4 light = texture(lightmap, (UV2 / 256.0) + 0.5 / 16.0);
```

### AO Calculation
```java
if (side1 && side2) return 0;  // Darkest
return 3 - side1 - side2 - corner;  // 0-3
```

### AO Brightness
```java
float[] aoBrightness = {0.2f, 0.6f, 0.8f, 1.0f};
```

## Directory Structure

```
docs/minecraft_shaders/
├── README.md                      # This file
├── agent.md                       # Main shader reference
├── ambient_occlusion.agent.md     # AO implementation details
├── lightmap.agent.md              # Lightmap generation
├── core/                          # Extracted GLSL vertex/fragment shaders
│   ├── terrain.vsh
│   ├── terrain.fsh
│   ├── block.vsh
│   ├── block.fsh
│   ├── entity.vsh
│   ├── entity.fsh
│   ├── lightmap.fsh
│   └── ... (70+ more shaders)
└── include/                       # Reusable GLSL modules
    ├── light.glsl
    ├── fog.glsl
    ├── globals.glsl
    ├── chunksection.glsl
    ├── projection.glsl
    └── ...
```

## Using This Documentation

1. **Understanding lighting**: Start with `agent.md` for overview, then `lightmap.agent.md` for details
2. **Implementing AO**: Read `ambient_occlusion.agent.md` - has complete algorithm with code
3. **Shader reference**: Look at actual shaders in `core/` and `include/`
4. **Quick formulas**: Use this README's quick reference section

