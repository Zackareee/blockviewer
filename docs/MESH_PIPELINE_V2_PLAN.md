# Mesh Pipeline V2 - Complete Redesign Plan

## Executive Summary

This document outlines a complete redesign of the block viewer's meshing pipeline to achieve:
- **Target**: 30+ FPS with 8 chunk render distance while moving
- **Current**: ~5 FPS, 40M+ triangles, 4GB+ memory

### Root Cause Analysis

**91% of triangles come from model meshes**, primarily:
1. **Cross-pattern blocks** (grass, flowers, dead bush, saplings) - 4 faces each, cannot be greedy-merged
2. **Partial blocks** (stairs, slabs, walls, fences) - complex geometry, 10-30 triangles each

The current pipeline generates every face for every model block regardless of distance, leading to exponential triangle growth.

---

## Benchmark: Minecraft's Approach

Based on analysis of Minecraft 1.21.11 source code:

### Key Architecture
```
SectionRenderDispatcher
├── SectionCompiler (async worker threads)
│   ├── ChunkSectionLayer (solid, cutout, translucent)
│   └── CompiledSectionMesh (cached geometry)
├── RenderRegionCache (neighbor data)
└── VisGraph (occlusion culling)
```

### Minecraft's Optimizations
1. **Palette compression** - Block states stored efficiently
2. **Layer separation** - Solid, cutout (leaves/grass), translucent (water/glass)
3. **Async compilation** - Worker threads build meshes
4. **Face culling** - Skip hidden faces (solid neighbors)
5. **Frustum culling** - Skip off-screen sections
6. **Occlusion culling** - Skip sections behind terrain
7. **Priority queues** - Build visible/close chunks first

### Critical Insight: Minecraft's Triangle Counts
Minecraft achieves ~1-5M visible triangles at 16 chunk render distance because:
- Cross-pattern blocks use **backface culling** (only 2 visible faces, not 4)
- Distant chunks use **mip-mapped textures** reducing visual complexity
- **No LOD system** - Minecraft renders all detail but with efficient culling

---

## Phase 1: Pipeline Cleanup & Foundation

### Goals
- Remove redundant meshing paths
- Establish clean data flow
- Set up benchmarking infrastructure

### Tasks

#### 1.1 Remove Obsolete Meshers
```
DELETE:
- src/mesh/UnifiedMesher.js          # Unused
- src/mesh/UnifiedMeshPipeline.js    # Unused
- src/mesh/SimplifiedMesher.js       # Unused LOD approach
- src/mesh/ParallelMesher.js         # Replaced by workers
- src/mesh/RegionMeshBuilder.js      # Replaced by SuperChunk
- src/mesh/gpu/GpuMesher.js          # Unused WebGPU prototype
- src/mesh/gpu/WebGPUMesher.js       # Unused WebGPU prototype
- src/mesh/MeshPatcher.js            # Complex, rarely used
- src/viewer/ChunkManager.js         # Replaced by SuperChunkManager
```

#### 1.2 Simplify Worker Pipeline
Current: `SuperChunkWorkerPool` → `SuperChunkWorker` → Complex branching
Target: Single unified worker with clear stages

#### 1.3 Establish Metrics
- Triangle count per mesh type (solid, model, water, etc.)
- Memory usage per chunk
- Time per meshing stage
- FPS during load and movement

### Expected Impact
- Reduced code complexity
- Clearer performance profiling
- Foundation for optimization

---

## Phase 2: Model Mesh Optimization (HIGH PRIORITY)

### Problem Statement
91% of triangles = 36M+ triangles from model meshes at 8 chunk distance

### Solution: Distance-Based Model Culling

#### 2.1 Aggressive Distance Culling
```javascript
// LOD levels for model blocks
const MODEL_LOD_CONFIG = {
  // Distance in blocks from camera
  0: { distance: 0,   skip: [] },                    // Full detail
  1: { distance: 32,  skip: ['cross'] },             // Skip grass/flowers
  2: { distance: 64,  skip: ['cross', 'plant'] },    // Skip all plants
  3: { distance: 96,  skip: ['cross', 'plant', 'small'] }, // Skip small models
  4: { distance: 128, skip: ['all_models'] },        // Solid only
};
```

#### 2.2 Cross-Pattern Block Instancing
Instead of generating 4 faces per grass block:
```javascript
// Collect all grass positions
const grassPositions = collectBlockType('short_grass');

// Create single InstancedMesh with 4-face geometry
const grassMesh = new THREE.InstancedMesh(crossGeometry, material, grassPositions.length);
grassMesh.setMatrixAt(i, matrix);  // Per-instance transform
```

Benefits:
- 1 draw call for all grass (vs 1000s)
- GPU handles culling efficiently
- Reduced memory (shared geometry)

#### 2.3 Block Categories for Culling
```javascript
const BLOCK_CATEGORIES = {
  // Never cull - essential for visual coherence
  ESSENTIAL: ['stairs', 'slab', 'wall', 'fence', 'door', 'trapdoor'],
  
  // Cull at medium distance (32-64 blocks)
  VEGETATION: ['short_grass', 'tall_grass', 'fern', 'large_fern',
               'poppy', 'dandelion', 'blue_orchid', /* ...flowers... */],
  
  // Cull at short distance (16-32 blocks)
  DECORATIVE: ['torch', 'lantern', 'candle', 'flower_pot', 'button'],
  
  // Keep but simplify
  COMPLEX: ['chest', 'bed', 'brewing_stand'],
};
```

### Expected Impact
- **Triangle reduction**: 36M → ~5-8M (70-80% reduction)
- **Memory reduction**: Shared instanced geometry
- **Draw call reduction**: Many → few per block type

---

## Phase 3: Solid Block Mesh Optimization

### Current Issues
- Multiple meshes per super-chunk (solid, water, lava, glass)
- Separate meshes for each section (16-24 per chunk)
- Draw call overhead

### Solution: Unified Batched Mesh

#### 3.1 Single Mesh Per Render Layer
```javascript
// Per super-chunk (32x384x32 blocks)
const RENDER_LAYERS = {
  opaque: {
    material: solidMaterial,
    blocks: ['stone', 'dirt', 'grass_block', /* solid blocks */],
  },
  cutout: {
    material: cutoutMaterial,
    blocks: ['leaves', 'glass', 'ice'],  // Alpha test
  },
  translucent: {
    material: waterMaterial,
    blocks: ['water', 'stained_glass'],  // Alpha blend
  },
};
```

#### 3.2 Quantized Vertices (Memory Optimization)
```javascript
// Current: 12 bytes per position (3x float32)
// Optimized: 6 bytes per position (3x uint16)

// Position relative to super-chunk origin
const quantize = (worldPos, chunkOrigin) => {
  return {
    x: Math.round((worldPos.x - chunkOrigin.x) * 256), // 0.00390625 precision
    y: Math.round((worldPos.y - chunkOrigin.y) * 256),
    z: Math.round((worldPos.z - chunkOrigin.z) * 256),
  };
};
```

Memory savings: **50% reduction** in position data

#### 3.3 Packed Vertex Attributes
```
Current vertex: 72 bytes
  - position: 12 bytes (vec3)
  - normal: 12 bytes (vec3)
  - uv: 8 bytes (vec2)
  - uv2 (atlas): 8 bytes (vec2)
  - color: 4 bytes (rgba)
  - light: 8 bytes (sky + block)
  - ao: 4 bytes
  - tint: 4 bytes
  - etc.

Optimized vertex: 24 bytes
  - position: 6 bytes (3x uint16 quantized)
  - normal: 1 byte (face index 0-5)
  - texIndex: 2 bytes (uint16)
  - uv: 2 bytes (packed)
  - light: 1 byte (packed sky/block)
  - ao: 1 byte
  - tint: 1 byte (type index)
  - reserved: 2 bytes
```

### Expected Impact
- **Memory**: 66% reduction in vertex data
- **Bandwidth**: Faster GPU uploads
- **Draw calls**: Minimal (3-6 per super-chunk)

---

## Phase 4: Chunk Loading Optimization

### Current Issues
- Chunks load synchronously blocking the render loop
- Boundary repairs cause cascade rebuilds
- Memory spikes during load

### Solution: Streaming Architecture

#### 4.1 Priority Queue Loading
```javascript
class ChunkLoadQueue {
  constructor() {
    this.queue = new PriorityQueue((a, b) => {
      // Priority: distance to camera, then visibility
      const distA = this.distanceToCamera(a);
      const distB = this.distanceToCamera(b);
      const visA = this.isInFrustum(a) ? 0 : 1;
      const visB = this.isInFrustum(b) ? 0 : 1;
      return (distA + visA * 1000) - (distB + visB * 1000);
    });
  }
  
  processFrame(budgetMs = 2) {
    const start = performance.now();
    while (this.queue.length && performance.now() - start < budgetMs) {
      const chunk = this.queue.pop();
      this.loadChunk(chunk);
    }
  }
}
```

#### 4.2 Deferred Boundary Updates
```javascript
// Instead of immediate neighbor rebuild:
chunkDirty.add(chunk);
chunkDirty.add(neighborNorth);  // Mark but don't rebuild

// Batch rebuild during idle time:
requestIdleCallback(() => {
  for (const chunk of chunkDirty) {
    this.rebuildChunk(chunk);
  }
  chunkDirty.clear();
});
```

#### 4.3 Mesh Buffer Pooling
```javascript
class MeshBufferPool {
  constructor() {
    // Pre-allocate common sizes
    this.pools = {
      small: [],  // < 10K vertices
      medium: [], // 10K - 100K vertices
      large: [],  // > 100K vertices
    };
  }
  
  acquire(size) {
    const pool = this.getPoolForSize(size);
    return pool.pop() || new Float32Array(size);
  }
  
  release(buffer) {
    const pool = this.getPoolForSize(buffer.length);
    if (pool.length < 10) {  // Limit pool size
      pool.push(buffer);
    }
  }
}
```

### Expected Impact
- **Smoother loading**: No frame spikes
- **Faster movement**: Chunks load ahead of camera
- **Lower memory**: Buffer reuse

---

## Phase 5: Rendering Optimizations (Three.js Specific)

### 5.1 Renderer Settings
```javascript
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.antialias = false;  // Disable for performance
renderer.powerPreference = 'high-performance';
renderer.sortObjects = false;  // Manual sort for transparency
```

### 5.2 Disable Auto Updates
```javascript
scene.matrixAutoUpdate = false;
scene.autoUpdate = false;

// Only update when needed
mesh.matrixWorldNeedsUpdate = true;
mesh.updateMatrix();
mesh.updateMatrixWorld(true);
```

### 5.3 Static Shadows
```javascript
// During movement: disable shadow updates
if (cameraMoving) {
  renderer.shadowMap.autoUpdate = false;
}

// When stopped: update once
if (cameraStopped) {
  renderer.shadowMap.needsUpdate = true;
}
```

### 5.4 Frustum Culling Optimization
```javascript
// Use bounding sphere for fast rejection
mesh.geometry.computeBoundingSphere();
mesh.frustumCulled = true;

// For instanced meshes: manual per-instance culling
instancedMesh.onBeforeRender = () => {
  updateVisibleInstances(instancedMesh, camera);
};
```

### 5.5 Material Optimization
```javascript
// Use single material with atlas
const material = new THREE.ShaderMaterial({
  uniforms: {
    atlas: { value: textureAtlas },
    lightmap: { value: lightmapTexture },
  },
  vertexShader: VERTEX_SHADER,
  fragmentShader: FRAGMENT_SHADER,
  transparent: false,  // Opaque pass first
});
```

### Expected Impact
- **FPS boost**: 10-30% from renderer settings
- **Reduced CPU**: No unnecessary matrix updates
- **Stable shadows**: No jitter during movement

---

## Phase 6: Memory Management

### 6.1 Aggressive Disposal
```javascript
class ChunkManager {
  unloadChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    
    // Dispose Three.js objects
    chunk.mesh.geometry.dispose();
    chunk.mesh.material.dispose();  // If not shared
    
    // Remove from scene
    this.scene.remove(chunk.mesh);
    
    // Release buffers to pool
    this.bufferPool.release(chunk.positionBuffer);
    this.bufferPool.release(chunk.indexBuffer);
    
    // Clear references
    this.chunks.delete(key);
  }
}
```

### 6.2 Worker Memory Limits
```javascript
// In worker: track memory usage
let allocatedBytes = 0;
const MAX_WORKER_MEMORY = 256 * 1024 * 1024;  // 256MB per worker

function allocateBuffer(size) {
  if (allocatedBytes + size > MAX_WORKER_MEMORY) {
    // Force GC or reject allocation
    self.postMessage({ type: 'memory_pressure' });
    return null;
  }
  allocatedBytes += size;
  return new ArrayBuffer(size);
}
```

### 6.3 Texture Memory
```javascript
// Dispose unused textures
const textureCache = new Map();
const textureUsage = new Map();

function trackTextureUsage(texture) {
  textureUsage.set(texture, Date.now());
}

function cleanupTextures() {
  const now = Date.now();
  for (const [texture, lastUsed] of textureUsage) {
    if (now - lastUsed > 30000) {  // 30s unused
      texture.dispose();
      textureCache.delete(texture.name);
      textureUsage.delete(texture);
    }
  }
}
```

### Expected Impact
- **Memory**: 4GB → <1.5GB target
- **Stability**: No OOM crashes
- **Performance**: Less GC pressure

---

## Implementation Roadmap

### Week 1: Foundation
- [ ] Create mesh-pipeline-v2 branch ✅
- [ ] Remove obsolete meshers
- [ ] Establish baseline benchmarks
- [ ] Set up triangle/memory tracking

### Week 2: Model Optimization (Highest Impact)
- [ ] Implement distance-based model culling
- [ ] Add block category system
- [ ] Implement cross-pattern instancing
- [ ] Verify 70%+ triangle reduction

### Week 3: Solid Block Optimization
- [ ] Implement quantized vertices
- [ ] Pack vertex attributes
- [ ] Unify mesh per render layer
- [ ] Verify memory reduction

### Week 4: Loading & Rendering
- [ ] Implement priority queue loading
- [ ] Add buffer pooling
- [ ] Apply Three.js optimizations
- [ ] Tune for movement performance

### Week 5: Polish & Testing
- [ ] Memory leak testing
- [ ] Performance regression testing
- [ ] Visual quality verification
- [ ] Documentation update

---

## Success Metrics

| Metric | Current | Target | Method |
|--------|---------|--------|--------|
| Triangles (8 chunks) | 40M+ | <10M | Distance culling + instancing |
| FPS (stationary) | ~5 | 40+ | All optimizations |
| FPS (moving) | ~3 | 30+ | Priority loading + deferred updates |
| Memory | 4GB+ | <1.5GB | Quantized vertices + pooling + disposal |
| Load time (8 chunks) | 30s+ | <10s | Priority loading + buffer reuse |
| Draw calls | 400+ | <50 | Batched meshes + instancing |

---

## References

### External
- [xeokit-sdk](https://github.com/xeokit/xeokit-sdk) - BIM rendering with batching/instancing
- [engine_fragment](https://github.com/ThatOpen/engine_fragment) - Memory-efficient mesh handling
- [binary-greedy-meshing](https://github.com/cgerikj/binary-greedy-meshing) - Fast voxel meshing
- [Three.js Performance Tips](https://discoverthreejs.com/tips-and-tricks/)

### Minecraft Source (1.21.11)
- `net/minecraft/client/renderer/chunk/SectionCompiler.class`
- `net/minecraft/client/renderer/chunk/SectionRenderDispatcher.class`
- `net/minecraft/client/renderer/block/ModelBlockRenderer.class`

### Internal Documentation
- `docs/minecraft_shaders/agent.md` - Shader reference
- `docs/minecraft_shaders/ambient_occlusion.agent.md` - AO algorithm
- `docs/PERFORMANCE_OPTIMIZATION.md` - Previous optimization attempts
