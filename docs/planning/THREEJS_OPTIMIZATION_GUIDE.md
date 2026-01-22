# Three.js Optimization Guide for Block Viewer

Based on research from xeokit-sdk, engine_fragment, and Three.js best practices.

## Quick Wins (Apply Immediately)

### 1. Renderer Settings

```javascript
// In RegionViewer.jsx or wherever renderer is created
const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,  // Use FXAA post-process instead
    powerPreference: 'high-performance',
    stencil: false,    // Not needed for blocks
    depth: true,
});

// Limit pixel ratio for performance
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

// Disable automatic clear if using custom render order
renderer.autoClear = false;
```

### 2. Matrix Auto-Update

```javascript
// Chunks don't move, so disable automatic matrix updates
mesh.matrixAutoUpdate = false;
mesh.updateMatrix();  // Call once when creating mesh

// Same for the group containing chunks
chunkGroup.matrixAutoUpdate = false;
chunkGroup.updateMatrix();

// If you need to move a chunk later:
mesh.position.set(x, y, z);
mesh.updateMatrix();  // Manual update
```

### 3. Static Shadows

```javascript
// Shadow maps don't need updating every frame
renderer.shadowMap.autoUpdate = false;

// Only update when chunks change
function onChunksChanged() {
    renderer.shadowMap.needsUpdate = true;
}
```

### 4. Frustum Culling Setup

```javascript
// Ensure bounding spheres are computed
geometry.computeBoundingSphere();
geometry.computeBoundingBox();

// Enable frustum culling (default, but be explicit)
mesh.frustumCulled = true;

// For better culling, compute tighter bounds
// after modifying geometry
```

### 5. Object Pooling

```javascript
// Reuse geometries instead of creating new ones
class GeometryPool {
    constructor() {
        this.available = [];
        this.inUse = new Set();
    }
    
    acquire(vertexCount, indexCount) {
        // Find suitable pooled geometry
        const suitable = this.available.find(g => 
            g.attributes.position.count >= vertexCount &&
            g.index.count >= indexCount
        );
        
        if (suitable) {
            this.available.splice(this.available.indexOf(suitable), 1);
            this.inUse.add(suitable);
            return suitable;
        }
        
        // Create new if none available
        return this.createGeometry(vertexCount, indexCount);
    }
    
    release(geometry) {
        this.inUse.delete(geometry);
        this.available.push(geometry);
    }
}
```

## Geometry Optimization

### 1. Interleaved Buffer Attributes

```javascript
// Instead of separate arrays for each attribute,
// use interleaved buffers for better cache performance

const stride = 32; // bytes per vertex
const interleavedBuffer = new THREE.InterleavedBuffer(data, stride / 4);

geometry.setAttribute('position', 
    new THREE.InterleavedBufferAttribute(interleavedBuffer, 3, 0)
);
geometry.setAttribute('normal', 
    new THREE.InterleavedBufferAttribute(interleavedBuffer, 3, 3)
);
geometry.setAttribute('uv', 
    new THREE.InterleavedBufferAttribute(interleavedBuffer, 2, 6)
);
```

### 2. Index Buffer Optimization

```javascript
// Use Uint16 when possible (< 65536 vertices)
if (vertexCount < 65536) {
    geometry.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
} else {
    geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
}
```

### 3. Buffer Usage Hints

```javascript
// For static geometry (chunks)
attribute.usage = THREE.StaticDrawUsage;

// For dynamic geometry (if needed)
attribute.usage = THREE.DynamicDrawUsage;

// After modifying:
attribute.needsUpdate = true;
```

### 4. Geometry Groups for Multi-Pass Rendering

```javascript
// Single geometry with groups for different materials
geometry.addGroup(0, solidCount, 0);           // Material 0: solid
geometry.addGroup(solidCount, glassCount, 1);  // Material 1: glass
geometry.addGroup(offset, waterCount, 2);       // Material 2: water

// Use with multi-material mesh
const mesh = new THREE.Mesh(geometry, [
    solidMaterial,
    glassMaterial,
    waterMaterial
]);
```

## Material Optimization

### 1. Share Materials

```javascript
// BAD: New material per mesh
meshes.forEach(mesh => {
    mesh.material = new THREE.MeshBasicMaterial({ map: atlas });
});

// GOOD: Shared material
const sharedMaterial = new THREE.MeshBasicMaterial({ map: atlas });
meshes.forEach(mesh => {
    mesh.material = sharedMaterial;
});
```

### 2. Shader Compilation Caching

```javascript
// Pre-compile shaders before first render
renderer.compile(scene, camera);

// Or use manual compilation
renderer.compileAsync(scene, camera).then(() => {
    // Ready to render
});
```

### 3. Avoid Unnecessary Features

```javascript
// Disable features you don't need
material.fog = false;           // If not using fog
material.flatShading = true;    // Minecraft-style block shading
material.vertexColors = true;   // We use vertex colors
```

### 4. Custom Shader Optimization

```glsl
// In vertex shader - minimize varying outputs
varying vec3 vPosition;  // Only if needed in fragment
varying vec2 vUv;

// In fragment shader - early discard for alpha test
void main() {
    vec4 texColor = texture2D(map, vUv);
    if (texColor.a < 0.5) discard;  // Early out
    
    // Rest of shading...
}
```

## Draw Call Reduction

### 1. Merge Geometries

```javascript
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Merge chunks with same material
const mergedGeometry = mergeGeometries(
    chunksInRegion.map(c => c.geometry),
    false  // Don't use groups
);

const regionMesh = new THREE.Mesh(mergedGeometry, sharedMaterial);
```

### 2. InstancedMesh for Repeated Blocks

```javascript
// For blocks with identical geometry (torches, flowers, etc.)
const instancedMesh = new THREE.InstancedMesh(
    blockGeometry,
    blockMaterial,
    instanceCount
);

// Set transforms
const matrix = new THREE.Matrix4();
positions.forEach((pos, i) => {
    matrix.setPosition(pos.x, pos.y, pos.z);
    instancedMesh.setMatrixAt(i, matrix);
});
instancedMesh.instanceMatrix.needsUpdate = true;
```

### 3. BatchedMesh (Use with Caution)

```javascript
// BatchedMesh for different geometries, same material
const batchedMesh = new THREE.BatchedMesh(
    maxGeometryCount,
    maxVertexCount,
    maxIndexCount,
    material
);

// Add geometries
const geoId = batchedMesh.addGeometry(geometry);

// Add instances of geometry
const instanceId = batchedMesh.addInstance(geoId);
batchedMesh.setMatrixAt(instanceId, matrix);

// Note: BatchedMesh has CPU overhead at scale
// Test performance before committing
```

## Memory Management

### 1. Dispose Resources

```javascript
function disposeChunk(chunk) {
    if (chunk.geometry) {
        chunk.geometry.dispose();
    }
    // Don't dispose shared materials!
    // material.dispose() only if unique to this mesh
    
    // Remove from parent
    chunk.parent?.remove(chunk);
}
```

### 2. Texture Disposal

```javascript
// When switching worlds or clearing
function disposeWorld() {
    scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
    });
    
    // Dispose textures
    textureAtlas.dispose();
    lightmapTexture.dispose();
}
```

### 3. Buffer Attribute Trimming

```javascript
// After setting geometry, trim unused capacity
geometry.deleteAttribute('color');  // If not using vertex colors
geometry.computeBoundingSphere();
geometry.computeBoundingBox();
```

## Render Loop Optimization

### 1. Throttle Updates

```javascript
// Don't update every frame if not needed
let needsRender = true;

function requestRender() {
    needsRender = true;
}

function animate() {
    requestAnimationFrame(animate);
    
    if (needsRender || cameraMoving) {
        renderer.render(scene, camera);
        needsRender = false;
    }
}
```

### 2. Visibility Checking

```javascript
// Skip expensive operations for off-screen chunks
camera.updateMatrixWorld();
frustum.setFromProjectionMatrix(
    projScreenMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
    )
);

chunks.forEach(chunk => {
    chunk.visible = frustum.intersectsObject(chunk);
});
```

### 3. LOD (Level of Detail)

```javascript
const lod = new THREE.LOD();

// High detail near
lod.addLevel(detailedMesh, 0);
// Medium detail
lod.addLevel(simplifiedMesh, 100);
// Low detail far
lod.addLevel(boxMesh, 300);

scene.add(lod);
```

## Texture Optimization

### 1. Texture Atlas

```javascript
// Single large texture instead of many small
const atlas = new THREE.TextureLoader().load('block-atlas.png');
atlas.minFilter = THREE.NearestMipmapLinearFilter;  // Minecraft look
atlas.magFilter = THREE.NearestFilter;
atlas.generateMipmaps = true;
atlas.colorSpace = THREE.SRGBColorSpace;
```

### 2. Compressed Textures

```javascript
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const ktx2Loader = new KTX2Loader()
    .setTranscoderPath('basis/')
    .detectSupport(renderer);

ktx2Loader.load('atlas.ktx2', texture => {
    material.map = texture;
});
```

### 3. Anisotropic Filtering

```javascript
// Improves texture quality at angles
const maxAniso = renderer.capabilities.getMaxAnisotropy();
texture.anisotropy = Math.min(4, maxAniso);  // 4 is usually enough
```

## xeokit Insights to Apply

### 1. RTC (Relative-To-Center) Coordinates

```javascript
// Store positions relative to chunk center
// Prevents floating-point precision issues at large coordinates

const chunkOrigin = new THREE.Vector3(
    chunkX * 16 + 8,  // Center of chunk
    0,
    chunkZ * 16 + 8
);

// Positions in geometry are relative to origin
// Chunk mesh position is at origin
chunk.position.copy(chunkOrigin);
```

### 2. Quantized Positions

```javascript
// Pack positions as u16 relative to chunk
// Decode in shader

// In JavaScript:
const quantized = new Uint16Array(vertexCount * 3);
for (let i = 0; i < vertexCount; i++) {
    quantized[i * 3 + 0] = Math.round(positions[i * 3 + 0] * 4096);
    quantized[i * 3 + 1] = Math.round(positions[i * 3 + 1] * 4096);
    quantized[i * 3 + 2] = Math.round(positions[i * 3 + 2] * 4096);
}

// In shader:
attribute vec3 position;  // Actually u16 × 3
uniform vec3 chunkOrigin;
uniform float quantScale;  // 1.0 / 4096.0

vec3 worldPos = position * quantScale + chunkOrigin;
```

### 3. Data Textures for Large Attribute Sets

```javascript
// Store per-instance data in texture instead of attributes
const dataTexture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType
);

// Sample in shader by instance ID
uniform sampler2D instanceData;
vec4 data = texture2D(instanceData, vec2(instanceId / width, 0.5));
```

## engine_fragment Insights to Apply

### 1. Worker-Based Processing

```javascript
// Keep meshing off main thread
const worker = new Worker('meshWorker.js');

worker.postMessage({ type: 'mesh', chunkData });

worker.onmessage = (e) => {
    const { positions, indices } = e.data;
    // Create geometry on main thread
    updateGeometry(positions, indices);
};
```

### 2. Tile-Based Loading

```javascript
// Load chunks in priority order
class ChunkLoader {
    constructor() {
        this.queue = new PriorityQueue((a, b) => 
            a.distanceToCamera - b.distanceToCamera
        );
    }
    
    queueChunk(chunkKey, priority) {
        this.queue.add({ chunkKey, priority });
    }
    
    processQueue() {
        const chunk = this.queue.poll();
        if (chunk) {
            this.loadChunk(chunk.chunkKey);
        }
    }
}
```

### 3. Deferred Updates

```javascript
// Don't update visibility every frame
let visibilityDirty = false;

controls.addEventListener('change', () => {
    visibilityDirty = true;
});

function updateVisibility() {
    if (!visibilityDirty) return;
    visibilityDirty = false;
    
    // Expensive visibility calculations
    updateChunkVisibility();
}
```

## Performance Monitoring

```javascript
// Monitor draw calls
renderer.info.render.calls

// Monitor triangles
renderer.info.render.triangles

// Monitor textures
renderer.info.memory.textures

// Monitor geometries
renderer.info.memory.geometries

// Log periodically
setInterval(() => {
    console.log('Draw calls:', renderer.info.render.calls);
    console.log('Triangles:', renderer.info.render.triangles);
    console.log('Geometries:', renderer.info.memory.geometries);
}, 5000);
```

## Summary Checklist

- [ ] Set pixel ratio to 1.5 max
- [ ] Disable antialias (use FXAA if needed)
- [ ] Disable matrixAutoUpdate on static meshes
- [ ] Disable shadowMap.autoUpdate
- [ ] Compute and cache bounding spheres
- [ ] Share materials between meshes
- [ ] Use geometry groups for multi-material
- [ ] Use InstancedMesh for repeated blocks
- [ ] Dispose geometries when unloading chunks
- [ ] Use compressed textures (KTX2)
- [ ] Use RTC coordinates for large worlds
- [ ] Quantize positions for compact vertex format
- [ ] Process mesh data in workers
- [ ] Load chunks by priority (nearest first)
- [ ] Monitor draw calls and memory
