# Loading World Files (.zip)

## Overview
Users can load a zipped Minecraft world save. The application scans for region files inside the zip and creates lazy-loading File-like objects that extract data on-demand.

## Entry Point
**File:** `src/App.jsx`
**Function:** `handleFileUpload` → `scanRegionsFromZip`

## Flow

### 1. Zip File Detection
```javascript
// In handleFileUpload
if (file.name.toLowerCase().endsWith('.zip')) {
  const lazyRegions = await scanRegionsFromZip(file);
  filesToProcess.push(...lazyRegions);
}
```

### 2. Scan Zip Structure
**Function:** `scanRegionsFromZip`

The function scans for region files in common Minecraft world layouts:
```javascript
// Common patterns:
// - region/r.0.0.mca (direct in zip)
// - worldname/region/r.0.0.mca (world folder at root)

for (const path of Object.keys(zip.files)) {
  if (path.includes('region/') && path.endsWith('.mca')) {
    const idx = path.indexOf('region/');
    regionPrefix = path.substring(0, idx + 'region/'.length);
    break;
  }
}
```

### 3. Create Lazy-Loading File Objects
Instead of extracting all regions immediately (which would be slow and use lots of memory), lazy File-like objects are created:

```javascript
const lazyFiles = regionInfos.map(({ filename, zipFile }) => {
  let cachedBuffer = null;  // Cache for extracted data
  
  return {
    name: filename,
    // Lazy arrayBuffer() - only extracts when called
    arrayBuffer: async () => {
      if (cachedBuffer) return cachedBuffer;
      console.log(`Extracting ${filename} from zip on-demand...`);
      cachedBuffer = await zipFile.async('arraybuffer');
      return cachedBuffer;
    },
  };
});
```

### 4. Process as Region Files
The lazy files are then processed just like direct .mca files:
```javascript
await processRegionFiles(lazyRegions, false);
```

### 5. On-Demand Extraction
When a region is actually needed (e.g., when ChunkStreamer parses it), the `arrayBuffer()` method is called:

```javascript
// In ChunkStreamer._parseRegionBuffer or ChunkManager
const buffer = await regionInfo.file.arrayBuffer();  // Extracts from zip here!
```

## Key Files Involved
| File | Purpose |
|------|---------|
| `src/App.jsx` | Zip scanning, lazy file creation |
| `src/App.jsx::scanRegionsFromZip` | Scan zip structure, find region folder |
| `jszip` | External library for zip file reading |

## Benefits of Lazy Loading
1. **Fast Initial Load**: Only scans zip metadata, doesn't extract files
2. **Memory Efficient**: Only extracts regions as needed
3. **Caching**: Extracted data is cached for subsequent reads
4. **Streaming Compatible**: Works seamlessly with chunk streaming

## Supported Zip Structures
```
# Structure 1: Region folder at root
myworld.zip/
  └── region/
      ├── r.0.0.mca
      ├── r.0.1.mca
      └── r.-1.0.mca

# Structure 2: World folder wrapper
myworld.zip/
  └── MyWorld/
      └── region/
          ├── r.0.0.mca
          └── ...

# Structure 3: Deep nesting (also supported)
myworld.zip/
  └── saves/
      └── MyWorld/
          └── region/
              └── r.0.0.mca
```

## Error Handling
If no region folder is found:
```javascript
if (!regionPrefix) {
  console.log('[App] No region folder found in zip');
  return null;  // Results in error message to user
}

// In handleFileUpload:
if (!lazyRegions || lazyRegions.length === 0) {
  setError('No region files found in zip. Expected a world save with a region/ folder.');
}
```

## Data Flow Diagram
```
.zip file selected
       ↓
  scanRegionsFromZip(zipFile)
       ↓
  JSZip.loadAsync(zipFile)
       ↓
  Scan for "region/*.mca" paths
       ↓
  Create lazy File objects (no extraction yet)
       ↓
  processRegionFiles(lazyFiles)
       ↓
  setRegionFiles([...])
       ↓
  RegionViewer / ChunkStreamer
       ↓
  file.arrayBuffer() ← Extraction happens here!
```

