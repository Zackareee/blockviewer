# Loading World Files (.zip)

## Overview
Users can load a zipped Minecraft world save. The application scans for all dimensions (Overworld, Nether, End, custom) and shows a picker if multiple are available. Region files are lazy-loaded on demand.

## Entry Point
**File:** `src/App.jsx`
**Function:** `handleFileUpload` → `scanDimensionsFromZip`

## Flow

### 1. Zip File Detection
```javascript
// In handleFileUpload
if (file.name.toLowerCase().endsWith('.zip')) {
  const result = await scanDimensionsFromZip(file);
  // result = { zip, dimensions: [...] }
}
```

### 2. Scan for All Dimensions
**Function:** `scanDimensionsFromZip`

The function scans for ALL dimension region folders:
```javascript
// Minecraft dimension paths:
// - Overworld: region/ or worldname/region/
// - Nether: DIM-1/region/ or worldname/DIM-1/region/
// - The End: DIM1/region/ or worldname/DIM1/region/
// - Custom: dimensions/namespace/name/region/

const dimensionMap = new Map(); // path → { id, name, files }

for (const [path, file] of Object.entries(zip.files)) {
  if (!path.endsWith('.mca')) continue;
  
  const regionIdx = path.lastIndexOf('region/');
  const regionPath = path.substring(0, regionIdx + 'region/'.length);
  
  // Determine dimension from path
  if (regionPath.includes('DIM-1/')) {
    dimensionId = 'the_nether';
  } else if (regionPath.includes('DIM1/')) {
    dimensionId = 'the_end';
  } else if (regionPath.includes('dimensions/')) {
    // Custom dimension
  } else {
    dimensionId = 'overworld';
  }
  
  dimensionMap.get(regionPath).files.push(file);
}
```

### 3. Dimension Selection
If multiple dimensions found, show picker modal:
```javascript
if (dimensions.length === 1) {
  // Single dimension - load directly
  const lazyFiles = createLazyRegionFiles(dimensions[0].files);
  filesToProcess.push(...lazyFiles);
} else if (dimensions.length > 1) {
  // Multiple dimensions - show picker UI
  setDimensionPicker({
    show: true,
    dimensions,
    pendingZip: result.zip,
    isAddMode: false,
  });
  return; // Wait for user selection
}
```

### 4. Create Lazy-Loading File Objects
After dimension is selected (or if only one exists):
```javascript
const createLazyRegionFiles = (dimensionFiles) => {
  return dimensionFiles.map(({ filename, zipFile }) => {
    let cachedBuffer = null;
    
    return {
      name: filename,
      arrayBuffer: async () => {
        if (cachedBuffer) return cachedBuffer;
        cachedBuffer = await zipFile.async('arraybuffer');
        return cachedBuffer;
      },
    };
  });
};
```

### 5. Handle Dimension Selection
```javascript
const handleDimensionSelect = async (dimension) => {
  setDimensionPicker({ show: false, ... });
  const lazyFiles = createLazyRegionFiles(dimension.files);
  await processRegionFiles(lazyFiles, isAddMode);
};
```

### 6. On-Demand Extraction
When a region is actually needed, the `arrayBuffer()` method extracts from zip:
```javascript
const buffer = await regionInfo.file.arrayBuffer();  // Extraction happens here!
```

## Key Files Involved
| File | Purpose |
|------|---------|
| `src/App.jsx` | Zip scanning, dimension picker, lazy file creation |
| `src/App.jsx::scanDimensionsFromZip` | Scan zip for all dimensions |
| `src/App.jsx::handleDimensionSelect` | Handle user dimension selection |
| `src/App.css` | Dimension picker modal styling |
| `jszip` | External library for zip file reading |

## Dimension Picker UI
When multiple dimensions are detected, a modal appears:
- Shows each dimension with icon (🌍 Overworld, 🔥 Nether, 🌌 End, ✨ Custom)
- Displays region count for each dimension
- User clicks to select and load

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

