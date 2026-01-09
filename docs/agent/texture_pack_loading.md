# Texture Pack Loading

## Overview
The application supports two texture modes:
1. **Vanilla Textures (Default)**: Bundled Minecraft 1.21.11 texture pack
2. **Custom Texture Packs**: User-uploaded .zip resource packs

## Entry Points
**File:** `src/App.jsx`
- `loadDefaultTexturePack()` - Loads bundled vanilla textures
- `handleTexturePackUpload()` - Handles custom pack upload

## Texture Modes
```javascript
// src/assets/index.js
export const TEXTURE_MODE = {
  SOLID_COLOR: 'solid',      // Fallback: colored blocks without textures
  DEFAULT_PACK: 'default',   // Bundled vanilla 1.21.11 textures
  CUSTOM_PACK: 'custom',     // User-uploaded resource pack
};
```

## Flow 1: Default (Vanilla) Texture Pack

### Automatic Loading
Default pack loads automatically on startup:
```javascript
useEffect(() => {
  if (textureMode === TEXTURE_MODE.DEFAULT_PACK && !texturePackInfo) {
    loadDefaultTexturePack();
  }
}, [textureMode]);
```

### Loading Steps
```javascript
const loadDefaultTexturePack = async () => {
  // 1. Get pack manager singleton
  const pm = getDefaultPackManager();
  await pm.loadDefaultPack();  // Loads from /textures/minecraft.zip
  
  // 2. Preload all block models for data-driven texture mapping
  const modelResolver = getModelResolver();
  await modelResolver.preloadAllModels(pm);
  
  // 3. Initialize blockstate resolver
  const blockstateResolver = getBlockstateResolver();
  blockstateResolver.setPackManager(pm);
  
  // 4. Initialize ModelTextureMapper
  const modelTextureMapper = getModelTextureMapper();
  modelTextureMapper.init(modelResolver, blockstateResolver);
  
  // 5. Build texture atlas (stitches all textures into one image)
  const atlas = getTextureAtlas();
  await atlas.build(pm);
  
  // 6. Pre-register blocks to registry
  const blockRegistry = getBlockRegistry();
  for (const blockName of Object.keys(BLOCK_COLORS)) {
    blockRegistry.registerBlock(blockName);
  }
  
  // 7. Build TextureIndexLookup (blockId, face) → atlas index
  atlas.buildTextureIndexLookup(blockRegistry);
  
  // 8. Build particle atlas for flames, smoke, etc.
  const pAtlas = getParticleAtlas();
  await pAtlas.build(pm);
  
  // 9. Store results in state
  setTextureAtlas(atlas.getMaterialData());
  setParticleAtlas(pAtlas);
  setPackManager(pm);
};
```

## Flow 2: Custom Texture Pack

### User Upload
```javascript
const handleTexturePackUpload = async (event) => {
  const file = event.target.files?.[0];
  
  // 1. Ensure default pack is loaded as fallback
  const defaultPack = getDefaultPackManager();
  if (!defaultPack.isLoaded) {
    await defaultPack.loadDefaultPack();
  }
  
  // 2. Load custom pack
  const customPack = getCustomPackManager();
  await customPack.loadFromZip(file, file.name.replace('.zip', ''));
  
  // 3. Apply random rotation overrides from pack
  const rotationRegistry = getRandomRotationRegistry();
  rotationRegistry.clearPackOverrides();
  const packRotationBlocks = customPack.getRandomRotationBlocks();
  if (packRotationBlocks) {
    rotationRegistry.addPackOverrides(packRotationBlocks);
  }
  
  // 4. Re-initialize all resolvers with custom pack
  // (same steps as default pack, but with customPack)
  // ...
  
  // 5. Update state
  setTextureMode(TEXTURE_MODE.CUSTOM_PACK);
};
```

## Key Components

### TexturePackManager
**File:** `src/assets/TexturePackManager.js`
- Loads and parses resource pack zips
- Provides texture lookup by path
- Handles pack metadata (pack.mcmeta)

### TextureAtlas
**File:** `src/assets/TextureAtlas.js`
- Stitches individual textures into single atlas image
- Provides UV coordinate mapping
- Builds TextureIndexLookup for shader usage

### TextureIndexLookup
**File:** `src/assets/TextureIndexLookup.js`
- Maps `(blockId, faceIndex)` → atlas texture index
- Used by meshers to assign correct texture to each face
- Pre-computed for performance

### ModelResolver / BlockstateResolver
**Files:** `src/assets/ModelResolver.js`, `src/assets/BlockstateResolver.js`
- Parse Minecraft's JSON model format
- Resolve block states to model variants
- Extract face textures for each block

## Data Flow
```
Pack Manager (loads .zip)
       ↓
Model Resolver (parses block models)
       ↓
Blockstate Resolver (handles variants)
       ↓
Texture Atlas (stitches textures)
       ↓
TextureIndexLookup (blockId → atlas index)
       ↓
Materials receive atlas + lookup
       ↓
Meshers use lookup during mesh generation
```

## Texture Atlas Structure
The atlas is a single large texture (typically 4096x4096) containing all block textures:
```
┌────────────────────────────────────┐
│ stone  │ dirt   │ grass  │ oak    │
├────────┼────────┼────────┼────────┤
│ cobble │ sand   │ gravel │ iron   │
├────────┼────────┼────────┼────────┤
│  ...   │  ...   │  ...   │  ...   │
└────────────────────────────────────┘
```

Each texture gets an index, and the shader uses this to calculate UV coordinates.

## When Textures Affect Meshing
The `textureAtlas` state change triggers mesh rebuilding in RegionViewer:
```javascript
// In RegionViewer.jsx
useEffect(() => {
  // Wait for textureAtlas to be ready
  if (!textureAtlas) return;
  
  // Rebuild meshes with new texture indices
  // ...
}, [chunks, textureAtlas, ...]);
```

## Fallback Behavior
If texture loading fails:
```javascript
} catch (err) {
  console.error('[App] Failed to load default texture pack:', err);
  setError('Failed to load default texture pack');
  setTextureMode(TEXTURE_MODE.SOLID_COLOR);  // Fallback to colored blocks
}
```





