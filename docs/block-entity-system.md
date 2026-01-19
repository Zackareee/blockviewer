# Block Entity Model System

This document describes the block entity model extraction and rendering system for the Block Viewer.

## Overview

Block entities in Minecraft are special blocks that have additional rendering beyond standard cube models:
- **Chests** (single, double left/right, trapped, ender, christmas)
- **Beds** (16 colors, head and foot parts)
- **Signs** (12 wood types, standing and wall variants)
- **Hanging Signs** (12 wood types)
- **Skulls/Heads** (skeleton, wither skeleton, zombie, creeper, player, dragon, piglin)
- **Banners** (16 colors, standing and wall, with pattern support)
- **Shulker Boxes** (17 colors including default)
- **Bells**
- **Conduits**
- **Decorated Pots**
- **Enchanting Table Book**
- **Lectern Book**

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     EXTRACTION PIPELINE                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────┐    ┌─────────────────────┐    ┌────────────┐ │
│  │ Minecraft JAR    │───▶│ extract-block-      │───▶│ JSON       │ │
│  │ (.class files)   │    │ entities.py         │    │ Models     │ │
│  └──────────────────┘    └─────────────────────┘    └────────────┘ │
│                                                            │        │
│  ┌──────────────────┐                                     ▼        │
│  │ Entity Textures  │───▶ build-entity-atlas.js ───▶ entity-atlas.png
│  └──────────────────┘                                              │
│                                                                      │
│  ┌─────────────────────┐    ┌──────────────────────────────────────┐│
│  │ JSON Models         │───▶│ bake-block-entities.js              ││
│  │ block-entity-       │    │                                      ││
│  │ models.json         │    │ Outputs:                             ││
│  └─────────────────────┘    │ - baked-block-entities.bin (WASM)   ││
│                             │ - baked-block-entities.json (JS)    ││
│                             └──────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     RUNTIME PIPELINE                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────┐    ┌─────────────────────┐                    │
│  │ Block Data       │    │ BlockEntityLoader.js│                    │
│  │ (with NBT)       │───▶│ resolveBlockEntity  │───▶ Entity State   │
│  └──────────────────┘    │ Variant()           │     (packed u32)   │
│                          └─────────────────────┘                    │
│                                                                      │
│  ┌──────────────────┐    ┌─────────────────────┐    ┌────────────┐ │
│  │ Entity States    │───▶│ WASM Block Entity   │───▶│ Mesh       │ │
│  │ (EntityStateGrid)│    │ Mesher              │    │ Geometry   │ │
│  └──────────────────┘    └─────────────────────┘    └────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Scripts

### extract-block-entities.py

Python script that extracts block entity model definitions.

```bash
python3 scripts/extract-block-entities.py
```

**Input:**
- `minecraft_versions/1.21.11_unobfuscated.jar` (optional verification)
- `textures/1.21.11+Template/assets/minecraft/models/entity/*.json` (existing models)

**Output:**
- `public/assets/block-entity-models.json` - Model geometry
- `public/assets/block-entity-manifest.json` - Block → model mapping

### bake-block-entities.js

Node.js script that converts JSON models to binary format for WASM.

```bash
node scripts/bake-block-entities.js
```

**Input:**
- `public/assets/block-entity-models.json`

**Output:**
- `public/assets/baked-block-entities.bin` - Binary for WASM
- `public/assets/baked-block-entities.json` - JSON for JavaScript

### build-entity-atlas.js

Builds the entity texture atlas.

```bash
node scripts/build-entity-atlas.js
```

**Output:**
- `public/assets/entity-atlas.png`
- `public/assets/entity-atlas-manifest.json`

## Data Formats

### block-entity-manifest.json

Maps block names to model configurations:

```json
{
  "version": 1,
  "block_entities": {
    "chest": {
      "models": {
        "single": "chest_single",
        "double_left": "chest_double_left",
        "double_right": "chest_double_right"
      },
      "texture_variants": {
        "normal": "entity/chest/normal",
        "normal_left": "entity/chest/normal_left"
      },
      "rotation_source": "facing",
      "variant_from": "nbt:type"
    },
    "red_bed": {
      "models": {
        "head": "bed_head",
        "foot": "bed_foot"
      },
      "texture_variants": {
        "default": "entity/bed/red"
      },
      "rotation_source": "facing",
      "variant_from": "block_state:part"
    }
  }
}
```

### block-entity-models.json

Contains geometry data for each model:

```json
{
  "version": 1,
  "models": {
    "chest_single": {
      "texture_size": [64, 64],
      "elements": [
        {
          "from": [1.0, 0.0, 1.0],
          "to": [15.0, 10.0, 15.0],
          "faces": {
            "down": {"uv": [0.4375, 0.296875, 0.65625, 0.515625], "texture": "#texture"},
            "up": {"uv": [0.21875, 0.296875, 0.4375, 0.515625], "texture": "#texture"},
            // ...
          }
        }
      ],
      "metadata": {"normalized_uvs": true}
    }
  }
}
```

### baked-block-entities.bin (Binary Format)

```
[header]
  u32: magic (0x424C454E = "BLEN")
  u32: version (2)
  u32: model count

[model index] (for each model)
  u16: model name length
  bytes: model name
  u32: offset to model data

[model data] (for each model)
  u16: texture_width
  u16: texture_height
  u16: element count
  [element]
    f32[3]: from (x, y, z) in block space 0-1
    f32[3]: to (x, y, z)
    u8: face_mask (bits for which faces exist)
    [face] (for each set bit)
      f32[4]: uv (u1, v1, u2, v2) normalized 0-1
```

## Entity State Packing

Entity state is packed into a 32-bit integer for efficient storage:

```
Bits 0-7:   Entity type index (256 types max)
Bits 8-15:  Variant index (256 variants max)
Bits 16-19: Y rotation (0-15)
Bits 20-23: Color index (0-15)
Bits 24-31: Flags
```

### Rotation Encoding

For most blocks using `facing`:
- 0 = North
- 1 = East  
- 2 = South
- 3 = West

For signs/banners/skulls using `rotation` (16 values):
- 0 = South (0°)
- 4 = West (90°)
- 8 = North (180°)
- 12 = East (270°)

## WASM Integration

### Rust Types

```rust
// src/wasm-mesher/src/entities/block_entity_registry.rs
pub struct BlockEntityModel {
    pub name: String,
    pub texture_width: u16,
    pub texture_height: u16,
    pub elements: Vec<BlockElement>,
}

pub struct BlockElement {
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub faces: Vec<ElementFace>,
}
```

### JavaScript API

```javascript
import { 
  initBlockEntities,
  isBlockEntity,
  resolveBlockEntityVariant,
  packEntityState 
} from './assets';

// Initialize the system
await initBlockEntities();

// Check if a block needs entity rendering
if (isBlockEntity('chest')) {
  const blockState = { facing: 'north', type: 'single' };
  const nbt = { type: 'single' };
  
  const variant = resolveBlockEntityVariant('chest', blockState, nbt);
  // { modelIndex: 0, modelName: 'chest_single', rotation: 0, ... }
  
  const packed = packEntityState(
    variant.modelIndex,
    variant.variantIndex,
    variant.rotation,
    variant.color,
    variant.flags
  );
}
```

## Adding New Block Entities

1. **Add model definition** in `extract-block-entities.py`:
   ```python
   def create_my_entity() -> LayerDefinition:
       layer = LayerDefinition()
       layer.material = MaterialDefinition(64, 64)
       # Add cubes...
       return layer
   
   MODEL_DEFINITIONS['my_entity'] = create_my_entity
   ```

2. **Add block mapping** in `BLOCK_ENTITY_MAPPING`:
   ```python
   'my_block': {
       'models': {'default': 'my_entity'},
       'texture_variants': {'default': 'entity/my_texture'},
       'rotation_source': 'facing',
   }
   ```

3. **Add texture** to `build-entity-atlas.js`:
   ```javascript
   'entity/my_texture': 'my_folder/my_texture.png',
   ```

4. **Regenerate assets**:
   ```bash
   python3 scripts/extract-block-entities.py
   node scripts/bake-block-entities.js
   node scripts/build-entity-atlas.js
   ```

## Version Compatibility

The extraction system is designed to be forward-compatible:

1. Model definitions are stored as Python functions with explicit geometry
2. When Minecraft updates, re-run the extraction with the new JAR
3. Existing JSON models in `textures/.../models/entity/` are preferred over computed geometry
4. UV coordinates are normalized (0-1) for any texture size

## Limitations

### Banners
Banners with patterns are not fully supported in the static extraction pipeline. Banner patterns are dynamically composited at runtime using:
- Base color texture
- Pattern overlay textures (tinted)
- GPU compositing

The current implementation provides the banner pole/crossbar model only.

### Animated Entities
Some block entities have animations that are not supported:
- Chest lid opening
- Shulker box opening
- Bell swinging
- Book page turning

These render in their default (closed/still) state.

### Player Heads
Custom player head textures require skin loading, which is not implemented. Player heads use the default Steve texture.
