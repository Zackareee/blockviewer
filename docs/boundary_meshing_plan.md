# Boundary Meshing Fix Plan

## Problem Statement

When super chunks are meshed independently and then rebuilt when neighbors load, **overlapping geometry is created at boundaries**. This causes:

1. **Transparency issues**: Glass and water become more opaque as multiple identical faces overlap
2. **Excessive meshing work**: Entire super chunks are rebuilt just to fix 1-block boundary strips
3. **Pop-in**: Visual artifacts until neighbors load and trigger rebuilds

## Root Cause Analysis

Current flow:
1. Super chunk A is meshed without neighbor data → boundary faces may be incorrect
2. Super chunk B loads adjacent to A
3. A triggers a rebuild to include B's data for:
   - Water level calculation (water needs neighbor water levels)
   - Face culling (don't render faces against solid blocks)
   - Light sampling (smooth lighting at boundaries)
4. **Both A and B now have geometry for the shared boundary** → duplicate faces

## Solution Options

### Option 1: Pre-Load Boundary Block Data ⭐ RECOMMENDED

**Core idea**: Before meshing a super chunk, read only the 1-block-thick boundary strip from adjacent MCA/ZIP data. This gives the mesher all the neighbor info it needs without requiring neighbors to be fully decoded.

**How it works**:
1. When preparing to mesh super chunk at (sx, sz):
   - Identify 8 adjacent super chunks
   - For each that isn't fully loaded: parse just boundary sections from MCA
   - Store in grid as "neighbor-only" blocks (not meshed, only for lookups)
2. Mesh as normal - boundary data is already present
3. **No rebuild needed** when neighbors load

**Boundary data needed per edge**:
- 2 chunks × 16 blocks × 384 height = 12,288 blocks per edge
- 4 edges + 4 corners = ~100K blocks of boundary data per super chunk
- Much smaller than full neighbor chunks (4 × 65K = 260K blocks)

**Pros**:
- Single-pass meshing, no rebuilds
- No duplicate geometry possible
- Works with streaming loading
- Minimal memory overhead

**Cons**:
- Need to parse NBT for boundary sections (some CPU overhead)
- Slight latency increase for initial mesh (negligible vs rebuild cost)

---

### Option 2: Boundary Face Ownership Rules

**Core idea**: Define deterministic rules for which chunk "owns" each boundary face. Each face is only ever emitted by one chunk.

**Rules**:
- Face at boundary X: owned by chunk with smaller X coordinate
- Face at boundary Z: owned by chunk with smaller Z coordinate
- When meshing, skip faces you don't own

**Pros**:
- No duplicate geometry by definition
- Simple rule-based logic
- No rebuilds needed

**Cons**:
- Boundary faces missing until neighbor loads (visible holes)
- Holes are worse UX than current transparency issues
- Doesn't solve water level problem

---

### Option 3: Deferred Boundary Patch Meshes

**Core idea**: Initially skip boundary faces, then add them as small "patch" meshes when neighbor data becomes available.

**How it works**:
1. Initial mesh: mark boundary faces as "deferred", don't emit geometry
2. When neighbor loads: generate a small patch mesh with just the boundary faces
3. Attach patch mesh to super chunk

**Pros**:
- No duplicate geometry
- Minimal extra work (only boundary faces)
- Patch meshes are tiny

**Cons**:
- Still has pop-in (faces appear when neighbor loads)
- Increases mesh count per super chunk
- Doesn't help with water levels

---

### Option 4: Conservative Initial Mesh + Surgical Repair

**Core idea**: Make pessimistic assumptions for missing neighbors, then surgically fix only boundary geometry.

**How it works**:
1. Initial mesh without neighbor: assume air/water on all boundaries
2. When neighbor loads: identify affected boundary blocks
3. Generate replacement geometry for just those blocks
4. Swap boundary geometry (don't rebuild entire super chunk)

**Pros**:
- Reduces rebuild scope dramatically
- Single mesh swap operation

**Cons**:
- Complex geometry tracking
- Still some pop-in for corrections

---

## Recommended Implementation: Option 1 (Pre-Load Boundary Data)

### Phase 1: Boundary Data Extraction

Add ability to read sparse boundary blocks from MCA files:

```javascript
// In region loading, when chunk X,Z is requested:
// Also check if adjacent super chunks need boundary data

async function loadBoundaryStrip(regionFile, chunkX, chunkZ, edge) {
  // Parse only the outer 1-block sections needed
  // Return sparse block data for boundary
}
```

### Phase 2: Modify Super Chunk Worker

Before meshing, inject boundary block data into the grid:

```javascript
// In SuperChunkWorker.processSuperChunk():
async function processSuperChunk(data) {
  const { chunks, boundaryData, bounds } = data;
  
  // Decode main chunks
  for (const chunk of chunks) {
    decodeChunk(chunk, grid, ...);
  }
  
  // Inject boundary data (blocks only, no mesh generation)
  for (const boundary of boundaryData) {
    injectBoundaryBlocks(boundary, grid);
  }
  
  // Mesh with complete boundary info - no rebuild needed
  const meshes = meshChunk(grid, bounds);
}
```

### Phase 3: Remove Rebuild-on-Neighbor Logic

Simplify SuperChunkManager:

```javascript
// Remove or disable:
// - boundaryDirtySet
// - _markNeighborsDirtyAfterBuild()
// - repairBoundaries()

// Super chunks are now "done" after first build
```

### Phase 4: Optimize Boundary Extraction

For efficiency, boundary data can be:
1. Cached per-region (amortized across super chunks)
2. Loaded lazily only when super chunk is about to mesh
3. Discarded after meshing (not needed for rebuild)

---

## Implementation Steps

### Step 1: Add Boundary Block Parsing
- [ ] Create `BoundaryExtractor` class that can read specific blocks from NBT
- [ ] Add method to get 1-block strips from chunk edges
- [ ] Handle compressed chunk data without full decode

### Step 2: Integrate with Loading Pipeline  
- [ ] In `RegionLoader`, track which chunks have boundary data available
- [ ] In `SuperChunkManager._prepareChunksForWorker()`, include boundary data
- [ ] Pass boundary data to worker alongside main chunks

### Step 3: Worker-Side Boundary Injection
- [ ] In `SuperChunkWorker`, decode boundary blocks into grid (mesh bounds exclude them)
- [ ] Verify water levels are correct at boundaries
- [ ] Verify face culling is correct at boundaries

### Step 4: Disable Legacy Rebuild System
- [ ] Remove `boundaryDirtySet` rebuild triggers
- [ ] Keep `_includeNeighborData()` as fallback for fully-loaded neighbors
- [ ] Verify no transparency issues remain

### Step 5: Performance Optimization
- [ ] Profile boundary extraction overhead
- [ ] Consider caching boundary data at region level
- [ ] Consider parallel boundary extraction

---

## ROOT CAUSE FOUND: Race Condition Bug

### The Bug

There's a race condition in `rebuildDirtyParallel()` where multiple rebuilds can be triggered for the same super chunk:

```
Timeline:
1. Job A starts: oldMeshesA = [mesh1, mesh2], superChunk.meshes = []
2. Worker A processing... (takes ~50ms)
3. Job B triggered (neighbor loaded): oldMeshesB = [] (empty!), superChunk.meshes = []
4. Worker B processing...
5. Job A completes: adds [mesh3, mesh4] to superChunk.meshes, disposes oldMeshesA
6. Job B completes: adds [mesh5, mesh6] to superChunk.meshes (NOW HAS BOTH!)
   disposes oldMeshesB (empty, nothing removed)
```

**Result**: `superChunk.meshes` now contains TWO sets of nearly identical meshes!

### The Quick Fix

Add a "pending rebuild" flag to prevent concurrent rebuilds:

```javascript
// In SuperChunk class
this.rebuildPending = false;

// In rebuildDirtyParallel():
if (superChunk.rebuildPending) {
  continue; // Skip - already being rebuilt
}
superChunk.rebuildPending = true;

// After job completes:
superChunk.rebuildPending = false;
```

### Alternative: Cancel Previous Rebuild

Instead of skipping, cancel any in-progress rebuild when a new one is triggered:

```javascript
// Track job IDs per super chunk
this.pendingJobIds = new Map();

// When starting a new job:
const existingJobId = this.pendingJobIds.get(key);
if (existingJobId) {
  this.superChunkWorkerPool.cancelJob(existingJobId);
}
this.pendingJobIds.set(key, newJobId);

// When job completes:
if (this.pendingJobIds.get(key) === jobId) {
  // This is the latest job, process it
  this.pendingJobIds.delete(key);
} else {
  // Stale result, discard
  return;
}
```

---

## Implementation Priority

### Phase 0: Fix the Race Condition Bug (IMMEDIATE) ✅ DONE
- [x] Add `rebuildPending` flag to super chunks
- [x] Skip rebuilds if already pending in all paths:
  - `_rebuildDirtyParallel()`
  - `rebuildDirty()` sequential path
  - `repairBoundaries()`
  - `_processBoundaryRepairsImmediate()`
- [x] Clear flag on completion (and on error)

### Phase 1: Boundary Extractor (Created, Optional Use)
- [x] Created `BoundaryExtractor.js` for future use
- [x] Can extract 1-block boundary strips from NBT
- Note: Current neighbor collection system already handles this case

### Phase 2: Optimize Rebuild System ✅ DONE
- [x] Only mark cardinal neighbors (N/S/E/W), skip corners
  - Reduces rebuild overhead by 50% (4 instead of 8 neighbors)
- [x] Add `_disableNeighborRebuilds` option for maximum performance
- [x] Keep rebuilds as optional visual polish (not required for correctness)

---

## Alternative Quick Fix (If Full Solution Too Complex)

If the full solution is too complex for immediate implementation, a **quick fix** is:

### Boundary Face Deduplication

When rebuilding a super chunk due to neighbor changes:
1. Before adding new mesh, **remove old mesh first**
2. Ensure only ONE mesh exists per super chunk at any time

This doesn't fix the rebuild overhead but fixes the transparency issue immediately.

```javascript
// In repairBoundaries():
const oldMeshes = [...superChunk.meshes];
await this.buildSuperChunk(superChunk, false); // isFirstBuild = false
// Remove old meshes AFTER new ones are added
for (const mesh of oldMeshes) {
  // Remove from scene
}
```

**CHECK**: Verify current code already does this correctly. The bug may be that old meshes aren't being removed.
