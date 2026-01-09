# Non-Streaming Loading (Load All at Once)

## Overview
When chunk streaming is disabled, the application loads and meshes entire regions at once before rendering. This is the legacy loading mode.

## When Active
- `enableChunkStreaming` prop is `false`
- State: `chunkStreamingEnabled = false` in App.jsx

## Entry Point
**File:** `src/viewer/RegionViewer.jsx`
**Effect at line ~808**

## Key Components

### ChunkManager
**File:** `src/viewer/ChunkManager.js`
- Manages scene, materials, and mesh groups
- Handles full region loading via `loadRegions()`

### RegionMeshBuilder
**File:** `src/mesh/RegionMeshBuilder.js`
- Decodes all chunks from a region
- Builds meshes for solid, fluid, glass, and model blocks
- Returns complete mesh data for Three.js

## Flow

### 1. Effect Triggers on Region Change
```javascript
// RegionViewer.jsx
useEffect(() => {
  const manager = managerRef.current;
  if (!manager || !regions || regions.length === 0) return;
  if (enableChunkStreaming) return; // Skip if streaming enabled
  
  // Wait for texture atlas
  if (!textureAtlas) return;
  
  loadRegions();
}, [regions, parseRegion, textureAtlas, enableChunkStreaming]);
```

### 2. Parse Regions
```javascript
const loadRegions = async () => {
  // Parse each region file (.mca)
  const parsedRegions = await Promise.all(
    regions.map(async (region) => {
      const buffer = await region.file.arrayBuffer();
      const chunks = await parseRegion(buffer);
      return {
        chunks,
        regionX: region.regionX,
        regionZ: region.regionZ,
      };
    })
  );
  
  // Load into ChunkManager
  await manager.loadRegions(parsedRegions, { enableModelMeshes, enableLOD });
};
```

### 3. ChunkManager.loadRegions()
**File:** `src/viewer/ChunkManager.js`

```javascript
async loadRegions(regions, options) {
  const { enableModelMeshes = true, enableLOD = true } = options;
  
  for (const region of regions) {
    // Offset chunks to world coordinates
    const offsetChunks = region.chunks.map(chunk => ({
      ...chunk,
      x: chunk.x + region.regionX * 32,
      z: chunk.z + region.regionZ * 32,
    }));
    
    // Build meshes using RegionMeshBuilder
    const meshBuilder = new RegionMeshBuilder({
      textureIndexLookup: this.getTextureIndexLookup(),
    });
    
    const result = await meshBuilder.buildRegion(offsetChunks, {
      centerMesh: false,
      generateLOD: shouldGenerateLOD,
      enableModelMeshes,
      collectEmitters: this.particleQuality !== 'off',
      smoothLighting: this.smoothLightingEnabled,
    });
    
    // Add meshes to scene
    if (result.solidMesh) this._addMesh(result.solidMesh, 'solid');
    if (result.waterMesh) this._addMesh(result.waterMesh, 'water');
    // ... etc
  }
}
```

### 4. RegionMeshBuilder.buildRegion()
**File:** `src/mesh/RegionMeshBuilder.js`

```javascript
async buildRegion(chunks, options) {
  // Phase 1: Decode all chunks into BinaryGrid
  const grid = new BinaryGrid();
  const stateGrid = new BlockStateGrid();
  const lightGrid = new LightGrid();
  
  for (const chunk of chunks) {
    decodeChunk(chunk, grid, registry, stateGrid, stateRegistry, lightGrid);
  }
  
  // Phase 1b: Light propagation (if no Minecraft light data)
  if (lightGrid.sections.size === 0) {
    propagateSkyLight(grid, lightGrid, registry);
    propagateBlockLight(grid, lightGrid, registry);
  }
  
  // Phase 2: Build meshes (greedy meshing)
  const mesherOptions = { textureIndexLookup, lightGrid };
  const { solid, water, lava, glass } = buildGridMeshes(grid, registry, offset, mesherOptions);
  
  // Phase 3: Build model meshes (slabs, stairs, etc.)
  if (enableModelMeshes) {
    const modelResult = buildModelMeshesWithInstancing(...);
  }
  
  // Return mesh data
  return {
    solidMesh: createGeometry(solid),
    waterMesh: createGeometry(water),
    // ...
  };
}
```

## Differences from Streaming

| Aspect | Non-Streaming | Streaming |
|--------|---------------|-----------|
| Initial Load | All regions parsed | Only nearby chunks |
| Memory Usage | Higher (all data loaded) | Lower (on-demand) |
| Load Time | Longer upfront | Progressive |
| Camera Freedom | Instant after load | Chunks load as you move |
| Suitable For | Small worlds, static views | Large worlds, exploration |

## Progress Reporting
Non-streaming mode shows detailed progress:
```javascript
// Build stages
const stages = ['parsing', 'decoding', 'meshing', 'adding', 'particles', 'complete'];

// Progress callbacks
meshBuilder.onProgress = (stage, current, total, message) => {
  setBuildProgress({ stage, stageProgress: (current / total) * 100, ... });
};
```

## When to Use Non-Streaming
1. Small worlds (1-4 regions)
2. Static rendering / screenshots
3. Debugging mesh issues
4. When you need everything loaded before interacting

## Configuration
```jsx
<RegionViewer
  regions={regionFiles}
  enableChunkStreaming={false}  // Disable streaming
  enableLOD={true}              // Level of detail for distant blocks
  enableModelMeshes={true}      // Slabs, stairs, flowers, etc.
/>
```

## Data Flow Diagram
```
Regions array set
       ↓
RegionViewer effect triggers
       ↓
Wait for textureAtlas
       ↓
Parse all region files (.mca → chunks)
       ↓
ChunkManager.loadRegions()
       ↓
For each region:
  ├── Offset chunks to world coords
  ├── RegionMeshBuilder.buildRegion()
  │     ├── decodeChunk() for all chunks
  │     ├── Light propagation
  │     ├── buildGridMeshes() (FastMesher)
  │     └── buildModelMeshes()
  └── Add meshes to scene
       ↓
Complete - all chunks visible
```


