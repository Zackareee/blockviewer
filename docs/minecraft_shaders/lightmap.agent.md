# Minecraft Lightmap System - Implementation Reference

This document details how Minecraft generates and uses its lightmap texture for block and entity lighting.

## Overview

The lightmap is a **16x16 texture** that encodes the combined effect of:
- Block light (X axis: 0-15)
- Sky light (Y axis: 0-15)
- Time of day
- Dimension-specific ambient light
- Weather effects
- Special effects (night vision, darkness)

---

## Lightmap Coordinates

### UV2 Attribute

Vertices carry light data as `ivec2 UV2`:
```glsl
in ivec2 UV2;
// UV2.x = block light * 16 (0, 16, 32, ..., 240)
// UV2.y = sky light * 16 (0, 16, 32, ..., 240)
```

### Sampling

```glsl
vec4 minecraft_sample_lightmap(sampler2D lightMap, ivec2 uv) {
    return texture(lightMap, clamp(
        (uv / 256.0) + 0.5 / 16.0,      // Center in texel
        vec2(0.5 / 16.0),                // Min clamp
        vec2(15.5 / 16.0)                // Max clamp
    ));
}
```

**Why 256?** UV2 ranges 0-240 in steps of 16. Dividing by 256 maps to 0-0.9375, then we add 0.5/16 (≈0.03125) to center in each texel.

---

## Lightmap Generation Shader

### Uniforms

```glsl
layout(std140) uniform LightmapInfo {
    float AmbientLightFactor;   // 0.0 = Overworld, 0.1 = Nether/End
    float SkyFactor;            // Sky light brightness (0-1)
    float BlockFactor;          // Block light brightness (usually 1.0)
    float NightVisionFactor;    // Night vision intensity (0-1)
    float DarknessScale;        // Darkness effect from Warden (0-1)
    float DarkenWorldFactor;    // Thunder darkening (0-1)
    float BrightnessFactor;     // Brightness gamma setting (0-1)
    vec3 SkyLightColor;         // RGB of sky light
    vec3 AmbientColor;          // RGB of ambient light
};
```

### The Brightness Curve

Minecraft uses a non-linear curve for light levels:

```glsl
float get_brightness(float level) {
    return level / (4.0 - 3.0 * level);
}
```

**Derivation:**
This is a rational function that:
- Maps 0 → 0
- Maps 1 → 1
- Has strong falloff at low levels (0.5 → 0.2)

**Table of values:**
| Light Level | Brightness |
|-------------|------------|
| 0 (0/15) | 0.000 |
| 1 (1/15) | 0.018 |
| 2 (2/15) | 0.038 |
| 3 (3/15) | 0.063 |
| 4 (4/15) | 0.091 |
| 5 (5/15) | 0.125 |
| 7 (7/15) | 0.212 |
| 10 (10/15) | 0.400 |
| 12 (12/15) | 0.571 |
| 14 (14/15) | 0.824 |
| 15 (15/15) | 1.000 |

---

## Block Light Color

Block light has a characteristic warm/orange tint:

```glsl
float block_brightness = get_brightness(blockLevel) * BlockFactor;

vec3 color = vec3(
    block_brightness,
    block_brightness * ((block_brightness * 0.6 + 0.4) * 0.6 + 0.4),
    block_brightness * (block_brightness * block_brightness * 0.6 + 0.4)
);
```

### Color Breakdown

| Channel | Formula | At max brightness |
|---------|---------|-------------------|
| Red | `brightness` | 1.0 |
| Green | `brightness * ((brightness * 0.6 + 0.4) * 0.6 + 0.4)` | ~0.856 |
| Blue | `brightness * (brightness³ * 0.6 + 0.4)` | ~0.640 |

**Result:** Block light is warm orange-yellow, transitioning to white at maximum.

### JavaScript Implementation

```javascript
function getBlockLightColor(level) {
    const b = level / (4.0 - 3.0 * level); // Brightness
    return {
        r: b,
        g: b * ((b * 0.6 + 0.4) * 0.6 + 0.4),
        b: b * (b * b * b * 0.6 + 0.4)
    };
}
```

---

## Sky Light

Sky light is cleaner, using the provided sky light color:

```glsl
float sky_brightness = get_brightness(skyLevel) * SkyFactor;
color += SkyLightColor * sky_brightness;
```

### SkyFactor by Time

| Time | SkyFactor (approx) |
|------|-------------------|
| Noon | 1.0 |
| Sunset/Sunrise | 0.5 |
| Night | 0.0 |

### SkyLightColor

Typically white `(1, 1, 1)` during day, but can be tinted:
- Orange during sunset
- Blue-ish during night
- Gray during rain/thunder

---

## Dimension Differences

### Overworld
```
AmbientLightFactor = 0.0
SkyFactor = varies by time
```

### Nether
```
AmbientLightFactor = 0.1
SkyFactor = 0.0 (no sky)
AmbientColor = (0.6, 0.3, 0.3) // Reddish
```

### The End
```
AmbientLightFactor = 0.1
SkyFactor = 0.0 (no sky)
AmbientColor = (0.4, 0.4, 0.5) // Purplish
```

---

## Special Effects

### Ambient Light Mixing

```glsl
color = mix(color, AmbientColor, AmbientLightFactor);
```

This adds dimension-specific ambient coloring.

### Baseline Gray

```glsl
color = mix(color, vec3(0.75), 0.04);
```

A subtle 4% mix toward gray to prevent pure black.

### World Darkening (Thunder)

```glsl
if (AmbientLightFactor == 0.0) {
    vec3 darkened_color = color * vec3(0.7, 0.6, 0.6);
    color = mix(color, darkened_color, DarkenWorldFactor);
}
```

During thunderstorms, reduces brightness with a blue-gray tint.

### Night Vision

```glsl
if (NightVisionFactor > 0.0) {
    float max_component = max(color.r, max(color.g, color.b));
    if (max_component < 1.0) {
        vec3 bright_color = color / max_component;
        color = mix(color, bright_color, NightVisionFactor);
    }
}
```

Scales all channels until one hits 1.0, preserving color ratios.

### Darkness Effect (Warden)

```glsl
if (AmbientLightFactor == 0.0) {
    color = color - vec3(DarknessScale);
}
```

Simply subtracts from all channels, creating true darkness.

### Gamma/Brightness Setting

```glsl
vec3 notGamma(vec3 color) {
    float maxComponent = max(max(color.x, color.y), color.z);
    float maxInverted = 1.0f - maxComponent;
    float maxScaled = 1.0f - maxInverted * maxInverted * maxInverted * maxInverted;
    return color * (maxScaled / maxComponent);
}

color = mix(color, notGamma(color), BrightnessFactor);
```

This applies a non-linear gamma curve based on the brightness slider.

---

## Complete Lightmap Generation

### GLSL (Minecraft's actual code)

```glsl
void main() {
    // Get discrete light levels from UV
    float blockLevel = floor(texCoord.x * 16) / 15;
    float skyLevel = floor(texCoord.y * 16) / 15;
    
    // Apply brightness curve
    float block_brightness = get_brightness(blockLevel) * BlockFactor;
    float sky_brightness = get_brightness(skyLevel) * SkyFactor;
    
    // Block light color (warm)
    vec3 color = vec3(
        block_brightness,
        block_brightness * ((block_brightness * 0.6 + 0.4) * 0.6 + 0.4),
        block_brightness * (block_brightness * block_brightness * 0.6 + 0.4)
    );
    
    // Mix with ambient
    color = mix(color, AmbientColor, AmbientLightFactor);
    
    // Add sky light
    color += SkyLightColor * sky_brightness;
    
    // Baseline gray mix
    color = mix(color, vec3(0.75), 0.04);
    
    // Thunder darkening
    if (AmbientLightFactor == 0.0) {
        vec3 darkened = color * vec3(0.7, 0.6, 0.6);
        color = mix(color, darkened, DarkenWorldFactor);
    }
    
    // Night vision
    if (NightVisionFactor > 0.0) {
        float maxC = max(color.r, max(color.g, color.b));
        if (maxC < 1.0) {
            color = mix(color, color / maxC, NightVisionFactor);
        }
    }
    
    // Darkness
    if (AmbientLightFactor == 0.0) {
        color -= vec3(DarknessScale);
    }
    
    // Clamp and gamma
    color = clamp(color, 0.0, 1.0);
    color = mix(color, notGamma(color), BrightnessFactor);
    color = mix(color, vec3(0.75), 0.04);
    
    fragColor = vec4(color, 1.0);
}
```

### JavaScript Implementation

```javascript
function generateLightmap(params) {
    const {
        skyFactor = 1.0,
        blockFactor = 1.0,
        ambientLightFactor = 0.0,
        skyLightColor = [1, 1, 1],
        ambientColor = [0, 0, 0],
        nightVisionFactor = 0.0,
        darknessScale = 0.0,
        darkenWorldFactor = 0.0,
        brightnessFactor = 0.0
    } = params;
    
    const data = new Uint8Array(16 * 16 * 4);
    
    for (let sky = 0; sky < 16; sky++) {
        for (let block = 0; block < 16; block++) {
            const blockLevel = block / 15;
            const skyLevel = sky / 15;
            
            const blockBrightness = getBrightness(blockLevel) * blockFactor;
            const skyBrightness = getBrightness(skyLevel) * skyFactor;
            
            // Block light color
            let r = blockBrightness;
            let g = blockBrightness * ((blockBrightness * 0.6 + 0.4) * 0.6 + 0.4);
            let b = blockBrightness * (blockBrightness * blockBrightness * blockBrightness * 0.6 + 0.4);
            
            // Ambient mix
            r = mix(r, ambientColor[0], ambientLightFactor);
            g = mix(g, ambientColor[1], ambientLightFactor);
            b = mix(b, ambientColor[2], ambientLightFactor);
            
            // Sky light
            r += skyLightColor[0] * skyBrightness;
            g += skyLightColor[1] * skyBrightness;
            b += skyLightColor[2] * skyBrightness;
            
            // Baseline gray
            r = mix(r, 0.75, 0.04);
            g = mix(g, 0.75, 0.04);
            b = mix(b, 0.75, 0.04);
            
            // Clamp
            r = Math.min(1, Math.max(0, r));
            g = Math.min(1, Math.max(0, g));
            b = Math.min(1, Math.max(0, b));
            
            // Store
            const idx = (sky * 16 + block) * 4;
            data[idx + 0] = Math.floor(r * 255);
            data[idx + 1] = Math.floor(g * 255);
            data[idx + 2] = Math.floor(b * 255);
            data[idx + 3] = 255;
        }
    }
    
    return data;
}

function getBrightness(level) {
    return level / (4.0 - 3.0 * level);
}

function mix(a, b, t) {
    return a * (1 - t) + b * t;
}
```

---

## Using the Lightmap

### Vertex Shader

```glsl
in ivec2 UV2;
uniform sampler2D Sampler2; // Lightmap

out vec4 vertexColor;

void main() {
    // Sample lightmap using light coordinates
    vec4 lightColor = minecraft_sample_lightmap(Sampler2, UV2);
    
    // Multiply with vertex color (includes AO, biome tint)
    vertexColor = Color * lightColor;
}
```

### Fragment Shader

```glsl
in vec4 vertexColor;

void main() {
    // Sample texture
    vec4 texColor = texture(Sampler0, texCoord0);
    
    // Apply lighting
    vec4 color = texColor * vertexColor;
    
    // Apply fog
    fragColor = apply_fog(color, ...);
}
```

---

## Light Propagation (World Data)

The lightmap shader only handles rendering. Light values in the world are computed separately:

### Sky Light
- Starts at 15 at y > highest solid block
- Decreases by 1 for each block of air below solid
- Spreads horizontally, decreasing by 1 per block

### Block Light
- Emitted by light sources (torch=14, glowstone=15, etc.)
- Decreases by 1 per block distance
- Blocked by opaque blocks

### Light Opacity
Some blocks reduce light more:
- Water: -1 per block
- Ice: -1 per block
- Leaves: -1 per block
- Tinted glass: -1 per block

The resulting values (0-15 for each) are stored per-block and passed as UV2 to shaders.





