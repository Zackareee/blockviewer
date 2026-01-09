# Loading Region Files (.mca) Directly

## Overview
Users can load Minecraft region files (.mca) directly without needing a full world zip. This is the simpler path for loading individual regions.

## Entry Point
**File:** `src/App.jsx`
**Function:** `handleFileUpload`

## Flow

### 1. File Selection
```
User clicks "Choose Files" → file input accepts .mca/.mcr/.zip
↓
handleFileUpload(event) called
```

### 2. File Type Detection
```javascript
// In handleFileUpload
for (const file of files) {
  if (file.name.toLowerCase().endsWith('.zip')) {
    // → Goes to zip processing flow (see loading_world_files.md)
  } else {
    // Direct .mca file - add to processing list
    filesToProcess.push(file);
  }
}
```

### 3. Process Region Files
```javascript
// processRegionFiles(files, isAddMode = false)
const newRegionInfos = files.map(file => {
  const regionCoords = parseRegionCoords(file.name); // Extract r.X.Z.mca → {x, z}
  return { file, regionX, regionZ };
});

// Set as regionFiles state
setRegionFiles(isAddMode ? [...regionFiles, ...newRegionInfos] : newRegionInfos);
```

### 4. RegionViewer Receives Data
**File:** `src/viewer/RegionViewer.jsx`

The `regions` prop receives the array of `{ file, regionX, regionZ }` objects:
```jsx
<RegionViewer
  regions={regionFiles}  // Array of { file, regionX, regionZ }
  enableChunkStreaming={chunkStreamingEnabled}
  // ...other props
/>
```

### 5. Two Loading Paths Branch Here

#### Path A: Chunk Streaming Enabled (Default)
See: `chunk_streaming.md`
- ChunkStreamer extracts chunks from regions on-demand
- Player-centric loading around camera position

#### Path B: Chunk Streaming Disabled
See: `non_streaming_loading.md`
- Full regions loaded at once via ChunkManager
- All chunks meshed before rendering

## Key Files Involved
| File | Purpose |
|------|---------|
| `src/App.jsx` | File handling, state management |
| `src/App.jsx::parseRegionCoords` | Extract X,Z from filename `r.-1.2.mca` |
| `src/App.jsx::processRegionFiles` | Validate and store region info |
| `src/viewer/RegionViewer.jsx` | Receives regions, delegates to ChunkStreamer or ChunkManager |

## Data Flow Diagram
```
.mca file selected
       ↓
  handleFileUpload()
       ↓
  processRegionFiles()
       ↓
  setRegionFiles([ { file, regionX, regionZ } ])
       ↓
  RegionViewer receives `regions` prop
       ↓
  ┌─────────────────────────┐
  │ enableChunkStreaming?   │
  └─────────────────────────┘
       ↓yes              ↓no
  ChunkStreamer      ChunkManager.loadRegions()
  (player-centric)   (load all at once)
```

## Region Coordinate Parsing
The filename format `r.X.Z.mca` encodes the region position:
- `r.-1.2.mca` → Region at X=-1, Z=2
- Each region contains 32x32 chunks (512x512 blocks)

```javascript
const parseRegionCoords = (filename) => {
  const match = filename.match(/r\.(-?\d+)\.(-?\d+)\.mca$/i);
  if (match) {
    return { x: parseInt(match[1], 10), z: parseInt(match[2], 10) };
  }
  return { x: 0, z: 0 };
};
```


