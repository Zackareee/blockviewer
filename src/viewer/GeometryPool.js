/**
 * GeometryPool - Pre-allocated BufferGeometry pool for mesh reuse
 * 
 * Reduces GC pressure by reusing BufferGeometry objects instead of
 * creating new ones for each chunk. When chunks unload, their geometries
 * are returned to the pool instead of being disposed.
 * 
 * Features:
 * - Pre-allocates geometries with max-size buffers
 * - Uses drawRange to render only valid vertices
 * - Automatic resizing if a mesh exceeds max capacity
 * - Separate pools for different mesh types (different attribute sets)
 */

import * as THREE from 'three';

// Default max vertices per geometry (can be exceeded, will allocate new)
const DEFAULT_MAX_VERTICES = 100000;
const DEFAULT_MAX_INDICES = 200000;

// Pool sizes by type
const POOL_SIZES = {
  solid: 50,      // Most common
  water: 20,
  lava: 10,
  glass: 20,
  model: 30,
  transparent: 15,
  overlay: 10,
};

/**
 * Create a pre-allocated BufferGeometry with all standard attributes
 */
function createPooledGeometry(maxVertices, maxIndices, includeModelUV = false) {
  const geometry = new THREE.BufferGeometry();
  
  // Core attributes
  geometry.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array(maxVertices * 3), 3
  ));
  geometry.setAttribute('normal', new THREE.BufferAttribute(
    new Float32Array(maxVertices * 3), 3
  ));
  geometry.setAttribute('color', new THREE.BufferAttribute(
    new Float32Array(maxVertices * 3), 3
  ));
  
  // Texture attributes
  if (includeModelUV) {
    geometry.setAttribute('modelUV', new THREE.BufferAttribute(
      new Float32Array(maxVertices * 2), 2
    ));
  }
  geometry.setAttribute('texIndex', new THREE.BufferAttribute(
    new Float32Array(maxVertices), 1
  ));
  geometry.setAttribute('tintType', new THREE.BufferAttribute(
    new Float32Array(maxVertices), 1
  ));
  
  // Lighting attributes
  geometry.setAttribute('skyLight', new THREE.BufferAttribute(
    new Float32Array(maxVertices), 1
  ));
  geometry.setAttribute('blockLight', new THREE.BufferAttribute(
    new Float32Array(maxVertices), 1
  ));
  
  // Index buffer
  geometry.setIndex(new THREE.BufferAttribute(
    new Uint32Array(maxIndices), 1
  ));
  
  // Initially render nothing
  geometry.setDrawRange(0, 0);
  
  // Store max capacities for bounds checking
  geometry.userData.maxVertices = maxVertices;
  geometry.userData.maxIndices = maxIndices;
  geometry.userData.pooled = true;
  
  return geometry;
}

/**
 * GeometryPool - Manages reusable BufferGeometry instances
 */
export class GeometryPool {
  constructor(options = {}) {
    this.maxVertices = options.maxVertices || DEFAULT_MAX_VERTICES;
    this.maxIndices = options.maxIndices || DEFAULT_MAX_INDICES;
    
    // Separate pools for different geometry types
    this.pools = new Map();
    
    // Track total allocations for debugging
    this.totalAllocated = 0;
    this.totalReused = 0;
    this.totalOversized = 0;
    
    // Initialize pools
    this._initPools();
  }
  
  _initPools() {
    for (const [type, size] of Object.entries(POOL_SIZES)) {
      this.pools.set(type, []);
      // Pre-allocate geometries
      const includeModelUV = type === 'model' || type === 'transparent' || type === 'overlay';
      for (let i = 0; i < size; i++) {
        const geom = createPooledGeometry(this.maxVertices, this.maxIndices, includeModelUV);
        this.pools.get(type).push(geom);
        this.totalAllocated++;
      }
    }
    
    console.log(`[GeometryPool] Initialized with ${this.totalAllocated} pre-allocated geometries`);
  }
  
  /**
   * Pre-warm pooled geometries by uploading them to GPU
   * This should be called once after the renderer is initialized
   * to avoid GPU upload stalls during gameplay.
   * 
   * @param {THREE.WebGLRenderer} renderer - The Three.js renderer
   * @param {THREE.Scene} scene - A scene to temporarily add meshes to
   * @param {THREE.Camera} camera - Camera for rendering
   * @param {THREE.Material} material - A basic material for warmup renders
   */
  warmupGPU(renderer, scene, camera, material) {
    if (!renderer || !scene || !camera) {
      console.warn('[GeometryPool] Cannot warmup GPU: missing renderer, scene, or camera');
      return;
    }
    
    // Use a basic material if none provided
    const warmupMaterial = material || new THREE.MeshBasicMaterial({ visible: false });
    
    console.log('[GeometryPool] Starting GPU warmup...');
    const startTime = performance.now();
    let warmedUp = 0;
    
    // Create temporary group for warmup meshes
    const warmupGroup = new THREE.Group();
    warmupGroup.visible = false;
    scene.add(warmupGroup);
    
    // Add one mesh from each pool type
    for (const [type, pool] of this.pools) {
      if (pool.length > 0) {
        const geom = pool[0]; // Just peek, don't remove
        
        // Set a minimal draw range to force buffer upload
        geom.setDrawRange(0, 3);
        
        // Create temporary mesh
        const mesh = new THREE.Mesh(geom, warmupMaterial);
        mesh.frustumCulled = false;
        warmupGroup.add(mesh);
        warmedUp++;
      }
    }
    
    // Render once to trigger GPU buffer uploads
    const oldClearColor = renderer.getClearColor(new THREE.Color());
    const oldClearAlpha = renderer.getClearAlpha();
    
    try {
      // Render with clear to trigger all GPU uploads
      renderer.render(scene, camera);
    } catch (e) {
      console.warn('[GeometryPool] GPU warmup render failed:', e.message);
    }
    
    // Clean up
    for (const mesh of warmupGroup.children) {
      mesh.geometry.setDrawRange(0, 0); // Reset draw range
    }
    scene.remove(warmupGroup);
    
    // Dispose temporary material if we created it
    if (!material) {
      warmupMaterial.dispose();
    }
    
    const elapsed = performance.now() - startTime;
    console.log(`[GeometryPool] GPU warmup complete: ${warmedUp} geometries in ${elapsed.toFixed(1)}ms`);
  }
  
  /**
   * Check if GPU warmup has been performed
   * @returns {boolean}
   */
  get isWarmedUp() {
    return this._warmedUp === true;
  }
  
  /**
   * Acquire a geometry from the pool
   * @param {string} type - Geometry type (solid, water, lava, glass, model, transparent, overlay)
   * @param {number} vertexCount - Required vertex count
   * @param {number} indexCount - Required index count
   * @returns {THREE.BufferGeometry}
   */
  acquire(type, vertexCount, indexCount) {
    const pool = this.pools.get(type);
    
    if (pool && pool.length > 0) {
      const geom = pool.pop();
      
      // Check if it has enough capacity
      if (geom.userData.maxVertices >= vertexCount && 
          geom.userData.maxIndices >= indexCount) {
        this.totalReused++;
        return geom;
      }
      
      // Geometry is too small, dispose and create larger
      geom.dispose();
      this.totalOversized++;
    }
    
    // Create new geometry with required size (plus buffer)
    const includeModelUV = type === 'model' || type === 'transparent' || type === 'overlay';
    const maxVerts = Math.max(vertexCount * 1.5, this.maxVertices);
    const maxInds = Math.max(indexCount * 1.5, this.maxIndices);
    
    const geom = createPooledGeometry(maxVerts, maxInds, includeModelUV);
    this.totalAllocated++;
    
    return geom;
  }
  
  /**
   * Return a geometry to the pool for reuse
   * @param {string} type - Geometry type
   * @param {THREE.BufferGeometry} geometry - Geometry to return
   */
  release(type, geometry) {
    if (!geometry || !geometry.userData.pooled) {
      // Non-pooled geometry, just dispose
      if (geometry) geometry.dispose();
      return;
    }
    
    const pool = this.pools.get(type);
    if (!pool) {
      geometry.dispose();
      return;
    }
    
    // Reset draw range
    geometry.setDrawRange(0, 0);
    
    // Return to pool (if not too many)
    const maxPoolSize = (POOL_SIZES[type] || 10) * 2;
    if (pool.length < maxPoolSize) {
      pool.push(geometry);
    } else {
      // Pool is full, dispose
      geometry.dispose();
    }
  }
  
  /**
   * Copy mesh data into a pooled geometry
   * @param {THREE.BufferGeometry} geometry - Target geometry from pool
   * @param {Object} meshData - Source mesh data with typed arrays
   * @returns {boolean} Success
   */
  copyMeshData(geometry, meshData) {
    if (!meshData || !meshData.positions || meshData.positions.length === 0) {
      return false;
    }
    
    const vertexCount = meshData.positions.length / 3;
    const indexCount = meshData.indices ? meshData.indices.length : 0;
    
    // Check capacity
    if (vertexCount > geometry.userData.maxVertices ||
        indexCount > geometry.userData.maxIndices) {
      console.warn('[GeometryPool] Mesh exceeds geometry capacity');
      return false;
    }
    
    // Copy position data
    const posAttr = geometry.getAttribute('position');
    posAttr.array.set(meshData.positions);
    posAttr.needsUpdate = true;
    
    // Copy normal data
    if (meshData.normals && meshData.normals.length > 0) {
      const normAttr = geometry.getAttribute('normal');
      normAttr.array.set(meshData.normals);
      normAttr.needsUpdate = true;
    }
    
    // Copy color data
    if (meshData.colors && meshData.colors.length > 0) {
      const colorAttr = geometry.getAttribute('color');
      colorAttr.array.set(meshData.colors);
      colorAttr.needsUpdate = true;
    }
    
    // Copy UV data
    if (meshData.uvs && meshData.uvs.length > 0) {
      const uvAttr = geometry.getAttribute('modelUV');
      if (uvAttr) {
        uvAttr.array.set(meshData.uvs);
        uvAttr.needsUpdate = true;
      }
    }
    if (meshData.modelUVs && meshData.modelUVs.length > 0) {
      const uvAttr = geometry.getAttribute('modelUV');
      if (uvAttr) {
        uvAttr.array.set(meshData.modelUVs);
        uvAttr.needsUpdate = true;
      }
    }
    
    // Copy texture indices
    if (meshData.texIndices && meshData.texIndices.length > 0) {
      const texAttr = geometry.getAttribute('texIndex');
      texAttr.array.set(meshData.texIndices);
      texAttr.needsUpdate = true;
    }
    
    // Copy tint types
    if (meshData.tintTypes && meshData.tintTypes.length > 0) {
      const tintAttr = geometry.getAttribute('tintType');
      tintAttr.array.set(meshData.tintTypes);
      tintAttr.needsUpdate = true;
    }
    
    // Copy light data
    if (meshData.skyLight && meshData.skyLight.length > 0) {
      const skyAttr = geometry.getAttribute('skyLight');
      skyAttr.array.set(meshData.skyLight);
      skyAttr.needsUpdate = true;
    }
    if (meshData.blockLight && meshData.blockLight.length > 0) {
      const blockAttr = geometry.getAttribute('blockLight');
      blockAttr.array.set(meshData.blockLight);
      blockAttr.needsUpdate = true;
    }
    
    // Copy indices
    if (meshData.indices && meshData.indices.length > 0) {
      const indexAttr = geometry.getIndex();
      indexAttr.array.set(meshData.indices);
      indexAttr.needsUpdate = true;
    }
    
    // Set draw range to actual data size
    geometry.setDrawRange(0, indexCount);
    
    // Update bounding sphere/box for frustum culling
    geometry.computeBoundingSphere();
    
    return true;
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const stats = {
      totalAllocated: this.totalAllocated,
      totalReused: this.totalReused,
      totalOversized: this.totalOversized,
      reuseRate: this.totalReused / (this.totalReused + this.totalOversized + 1),
      poolSizes: {},
    };
    
    for (const [type, pool] of this.pools) {
      stats.poolSizes[type] = pool.length;
    }
    
    return stats;
  }
  
  /**
   * Dispose all pooled geometries
   */
  dispose() {
    for (const [, pool] of this.pools) {
      for (const geom of pool) {
        geom.dispose();
      }
      pool.length = 0;
    }
    
    console.log('[GeometryPool] Disposed all geometries');
  }
}

// Singleton instance
let globalPool = null;

/**
 * Get or create the global geometry pool
 */
export function getGeometryPool() {
  if (!globalPool) {
    globalPool = new GeometryPool();
  }
  return globalPool;
}

/**
 * Reset the global geometry pool
 */
export function resetGeometryPool() {
  if (globalPool) {
    globalPool.dispose();
    globalPool = null;
  }
}
