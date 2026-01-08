# Chunk Streaming Mode

## Overview
Chunk streaming is the default and recommended loading mode. It loads chunks around the player's position instead of loading entire regions at once, providing a smooth Minecraft-like experience.

## When Active
- `enableChunkStreaming` prop is `true` (default)
- State: `chunkStreamingEnabled` in App.jsx

## Entry Point
**File:** `src/viewer/RegionViewer.jsx`
**Effect at line ~1027**

## Key Components

### ChunkStreamer
**File:** `src/viewer/ChunkStreamer.js`
- Main orchestrator for player-centric chunk loading
- Manages priority queue for chunk loading order
- Integrates with SuperChunkManager for mesh building

### SuperChunkManager
**File:** `src/viewer/SuperChunkManager.js`
- Groups chunks into 2x2 "super-chunks" for efficient meshing
- Handles WASM or JS meshing (see `wasm_meshing.md`, `js_meshing.md`)
- Manages mesh lifecycle

## Flow

### 1. Initialization
```javascript
// RegionViewer.jsx effect
const startStreaming = async () => {
  // Create or reuse ChunkStreamer
  let streamer = streamerRef.current;
  if (!streamer) {
    streamer = new ChunkStreamer(manager, {
      renderDistance: chunkStreamDistance,
      enableModelMeshes,
      onChunkLoaded: (x, z) => invalidate(),
    });
    streamerRef.current = streamer;
  }
  
  // Register region files for streaming
  await streamer.setRegions(regionInfos);
  
  // Determine spawn point (center of first region)
  const spawnX = (minRegionX + maxRegionX) / 2 * 512;
  const spawnZ = (minRegionZ + maxRegionZ) / 2 * 512;
  
  // Initial load around spawn
  await streamer.loadAroundPosition(spawnX, spawnZ);
};
```

### 2. Region Registration
```javascript
// ChunkStreamer.setRegions(regions)
async setRegions(regions) {
  this.regionFiles.clear();
  
  for (const region of regions) {
    const key = `${region.regionX},${region.regionZ}`;
    this.regionFiles.set(key, region);
  }
  
  // Initialize SuperChunkManager
  this._initSuperChunkManager();
  
  // Initialize WASM mesher (async, non-blocking)
  this._wasmInitPromise = this.initializeWasm();
}
```

### 3. Player Position Updates
```javascript
// Called from SpectatorControls via handleCameraUpdate
updatePlayerPosition(worldX, worldZ, yaw = null) {
  const chunkX = Math.floor(worldX / 16);
  const chunkZ = Math.floor(worldZ / 16);
  
  // Only update if player moved to new chunk
  if (chunkX === this.playerChunkX && chunkZ === this.playerChunkZ) {
    this._updateChunkVisibility();
    return;
  }
  
  this.playerChunkX = chunkX;
  this.playerChunkZ = chunkZ;
  
  // Queue chunks for loading (priority by distance + view direction)
  this._queueChunksAroundPlayer();
  
  // Unload distant chunks
  this._unloadDistantChunks();
  
  // Start processing queue
  if (!this.isProcessing) {
    this._processQueue();
  }
}
```

### 4. Priority Queue
Chunks are loaded based on priority:
```javascript
_queueChunksAroundPlayer(immediate = false) {
  // Spiral outward from player position
  for (let r = 0; r <= loadDistance; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        // Priority = Euclidean distance² + directional bonus
        const distSq = dx * dx + dz * dz;
        let priority = distSq;
        
        // Chunks in front of player get bonus (like Minecraft)
        priority += this._getDirectionalPriorityBonus(dx, dz);
        
        this.loadQueue.push({ chunkX, chunkZ, priority, ... });
      }
    }
  }
}
```

### 5. Chunk Loading
```javascript
async _loadChunk(item) {
  const { chunkX, chunkZ, regionX, regionZ } = item;
  
  // Get or parse region data
  let regionData = this.regionCache.get(regionX, regionZ);
  if (!regionData) {
    const buffer = await regionInfo.file.arrayBuffer();
    const chunks = await this._parseRegionBuffer(buffer, regionX, regionZ);
    this.regionCache.set(regionX, regionZ, buffer, chunks);
    regionData = { buffer, chunks };
  }
  
  // Find specific chunk
  const chunkData = regionData.chunks.find(c => c.x === localX && c.z === localZ);
  
  // Add to SuperChunkManager for batched meshing
  this.superChunkManager.addChunk(chunkX, chunkZ, chunkData);
  
  // Store loaded chunk reference
  this.loadedChunks.set(chunkKey, { meshes: [], data: chunkData });
}
```

### 6. Super-Chunk Meshing
See: `wasm_meshing.md` and `js_meshing.md`

SuperChunkManager groups chunks and builds meshes:
```javascript
// Chunks are grouped into 2x2 super-chunks
addChunk(chunkX, chunkZ, data) {
  const superX = Math.floor(chunkX / 2);
  const superZ = Math.floor(chunkZ / 2);
  const key = `${superX},${superZ}`;
  
  // Get or create super-chunk
  let superChunk = this.superChunks.get(key);
  if (!superChunk) {
    superChunk = new SuperChunk(superX, superZ);
    this.superChunks.set(key, superChunk);
  }
  
  // Add chunk data
  superChunk.chunks.set(`${chunkX},${chunkZ}`, data);
  
  // Mark dirty for rebuild
  this.dirtySet.add(key);
}
```

## Key Configuration

### Distances
```javascript
// ChunkStreamer constructor
this.renderDistance = baseRenderDistance;          // Visible chunks
this.loadDistance = baseRenderDistance + loadBuffer; // Pre-loaded chunks (buffer=2)
this.unloadDistance = this.loadDistance + 1;       // Cleanup threshold
```

### Concurrency
```javascript
// Controls how many chunks load simultaneously
this.concurrentChunks = options.concurrentChunks ?? 1; // 1=smooth, 8=fast
```

### Meshing Speed
```javascript
// How many super-chunks mesh per idle callback
this.meshingSpeed = 1; // 1=smooth, 4=fast
```

## Visibility vs Loading
Chunks can be in three states:
1. **Not Loaded**: Beyond loadDistance, no data
2. **Loaded + Hidden**: Between renderDistance and loadDistance, data loaded but `mesh.visible = false`
3. **Loaded + Visible**: Within renderDistance, fully rendered

This allows instant visibility toggle when moving:
```javascript
_updateChunkVisibility() {
  for (const [key, superChunk] of this.superChunks) {
    const dist = /* distance to player */;
    const shouldBeVisible = dist <= renderDistance + 1;
    
    for (const mesh of superChunk.meshes) {
      mesh.visible = shouldBeVisible;
    }
  }
}
```

## Data Flow Diagram
```
Player moves camera
       ↓
updatePlayerPosition(x, z)
       ↓
_queueChunksAroundPlayer()  ← Prioritized by distance + view direction
       ↓
_processQueue()
       ↓
_loadChunk() per chunk
       ↓
  ┌────────────────────────┐
  │ Region cached?         │
  └────────────────────────┘
       ↓no                ↓yes
  Parse .mca file     Use cached data
       ↓
  Extract chunk NBT
       ↓
  SuperChunkManager.addChunk()
       ↓
  Grouped into 2x2 super-chunk
       ↓
  scheduleIdleRebuild()
       ↓
  rebuildDirty() on idle
       ↓
  WASM or JS meshing (see respective docs)
       ↓
  Three.js mesh created and added to scene
```

