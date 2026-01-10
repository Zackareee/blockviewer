/**
 * GPUMeshAdapter - Bridges WebGPU compute output to Three.js rendering
 * 
 * This adapter enables GPU-generated mesh data to be used directly by Three.js
 * without expensive CPU readback. When WebGPU and Three.js share the same GPU
 * context, buffers can be used directly.
 * 
 * For non-shared contexts, provides efficient readback paths.
 */

import * as THREE from 'three';

/**
 * Configuration for the GPU mesh adapter
 */
const CONFIG = {
  // Maximum vertices per chunk mesh (determines buffer allocation)
  MAX_VERTICES_PER_CHUNK: 65536,
  // Maximum indices per chunk mesh
  MAX_INDICES_PER_CHUNK: 98304, // 65536 * 1.5
  // Use mapped buffers when available (faster for frequent updates)
  USE_MAPPED_BUFFERS: true,
};

/**
 * Vertex attribute layout matching our shader output
 */
const VERTEX_ATTRIBUTES = {
  position: { size: 3, type: 'float32' },
  normal: { size: 3, type: 'float32' },
  color: { size: 3, type: 'float32' },
  uv: { size: 2, type: 'float32' },
  texIndex: { size: 1, type: 'float32' },
  light: { size: 1, type: 'uint32' }, // Packed sky/block light
};

/**
 * Calculate bytes per vertex from attribute layout
 */
function calculateVertexStride() {
  let stride = 0;
  for (const attr of Object.values(VERTEX_ATTRIBUTES)) {
    const typeSize = attr.type === 'float32' ? 4 : 4; // Both f32 and u32 are 4 bytes
    stride += attr.size * typeSize;
  }
  return stride;
}

const BYTES_PER_VERTEX = calculateVertexStride();

/**
 * GPUMeshAdapter - Main class for GPU-to-Three.js mesh conversion
 */
export class GPUMeshAdapter {
  constructor() {
    this.device = null;
    this.initialized = false;
    
    // Staging buffers for readback (when direct sharing isn't possible)
    this.stagingBuffers = {
      vertices: null,
      indices: null,
    };
    
    // Reusable geometry pool
    this.geometryPool = [];
    this.maxPoolSize = 32;
  }
  
  /**
   * Initialize the adapter with a WebGPU device
   * @param {GPUDevice} device - WebGPU device from WebGPUMesher
   */
  initialize(device) {
    this.device = device;
    this.initialized = true;
    
    // Create staging buffers for readback
    this.stagingBuffers.vertices = device.createBuffer({
      label: 'Vertex Staging',
      size: CONFIG.MAX_VERTICES_PER_CHUNK * BYTES_PER_VERTEX,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    
    this.stagingBuffers.indices = device.createBuffer({
      label: 'Index Staging',
      size: CONFIG.MAX_INDICES_PER_CHUNK * 4, // u32 indices
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }
  
  /**
   * Convert GPU mesh data to Three.js BufferGeometry
   * 
   * @param {GPUBuffer} vertexBuffer - GPU buffer containing vertex data
   * @param {GPUBuffer} indexBuffer - GPU buffer containing index data
   * @param {number} vertexCount - Number of vertices
   * @param {number} indexCount - Number of indices
   * @returns {Promise<THREE.BufferGeometry>}
   */
  async createGeometry(vertexBuffer, indexBuffer, vertexCount, indexCount) {
    if (!this.initialized) {
      throw new Error('GPUMeshAdapter not initialized');
    }
    
    // Copy GPU buffers to staging buffers
    const commandEncoder = this.device.createCommandEncoder();
    
    commandEncoder.copyBufferToBuffer(
      vertexBuffer, 0,
      this.stagingBuffers.vertices, 0,
      vertexCount * BYTES_PER_VERTEX
    );
    
    commandEncoder.copyBufferToBuffer(
      indexBuffer, 0,
      this.stagingBuffers.indices, 0,
      indexCount * 4
    );
    
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Map staging buffers for CPU access
    await this.stagingBuffers.vertices.mapAsync(GPUMapMode.READ, 0, vertexCount * BYTES_PER_VERTEX);
    await this.stagingBuffers.indices.mapAsync(GPUMapMode.READ, 0, indexCount * 4);
    
    const vertexData = new Float32Array(this.stagingBuffers.vertices.getMappedRange().slice());
    const indexData = new Uint32Array(this.stagingBuffers.indices.getMappedRange().slice());
    
    this.stagingBuffers.vertices.unmap();
    this.stagingBuffers.indices.unmap();
    
    // Create Three.js geometry
    return this._buildGeometry(vertexData, indexData, vertexCount);
  }
  
  /**
   * Build Three.js geometry from interleaved vertex data
   * @private
   */
  _buildGeometry(vertexData, indexData, vertexCount) {
    // Get or create geometry from pool
    let geometry = this.geometryPool.pop();
    if (!geometry) {
      geometry = new THREE.BufferGeometry();
    }
    
    // Calculate stride in floats
    const strideFloats = BYTES_PER_VERTEX / 4;
    
    // Extract attributes from interleaved data
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const texIndices = new Float32Array(vertexCount);
    const lights = new Float32Array(vertexCount);
    
    for (let i = 0; i < vertexCount; i++) {
      const base = i * strideFloats;
      
      // Position (3 floats)
      positions[i * 3] = vertexData[base];
      positions[i * 3 + 1] = vertexData[base + 1];
      positions[i * 3 + 2] = vertexData[base + 2];
      
      // Normal (3 floats)
      normals[i * 3] = vertexData[base + 3];
      normals[i * 3 + 1] = vertexData[base + 4];
      normals[i * 3 + 2] = vertexData[base + 5];
      
      // Color (3 floats)
      colors[i * 3] = vertexData[base + 6];
      colors[i * 3 + 1] = vertexData[base + 7];
      colors[i * 3 + 2] = vertexData[base + 8];
      
      // UV (2 floats)
      uvs[i * 2] = vertexData[base + 9];
      uvs[i * 2 + 1] = vertexData[base + 10];
      
      // Tex index (1 float)
      texIndices[i] = vertexData[base + 11];
      
      // Light (1 u32 as float - will be unpacked in shader)
      lights[i] = vertexData[base + 12];
    }
    
    // Set attributes
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('aTexIndex', new THREE.BufferAttribute(texIndices, 1));
    geometry.setAttribute('aPackedLight', new THREE.BufferAttribute(lights, 1));
    
    // Set index
    geometry.setIndex(new THREE.BufferAttribute(indexData, 1));
    
    // Compute bounding box/sphere for culling
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    
    return geometry;
  }
  
  /**
   * Create geometry from TypedArrays (fallback path)
   * @param {Object} meshData - Mesh data with separate attribute arrays
   * @returns {THREE.BufferGeometry}
   */
  createGeometryFromArrays(meshData) {
    const geometry = this.geometryPool.pop() || new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(meshData.positions), 3
    ));
    geometry.setAttribute('normal', new THREE.BufferAttribute(
      new Float32Array(meshData.normals), 3
    ));
    geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(meshData.colors), 3
    ));
    geometry.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array(meshData.uvs), 2
    ));
    geometry.setAttribute('aTexIndex', new THREE.BufferAttribute(
      new Float32Array(meshData.texIndices), 1
    ));
    
    if (meshData.packedLight) {
      geometry.setAttribute('aPackedLight', new THREE.BufferAttribute(
        new Float32Array(meshData.packedLight), 1
      ));
    }
    
    geometry.setIndex(new THREE.BufferAttribute(
      new Uint32Array(meshData.indices), 1
    ));
    
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    
    return geometry;
  }
  
  /**
   * Return geometry to pool for reuse
   * @param {THREE.BufferGeometry} geometry
   */
  releaseGeometry(geometry) {
    if (this.geometryPool.length < this.maxPoolSize) {
      // Clear attributes but keep the geometry object
      geometry.deleteAttribute('position');
      geometry.deleteAttribute('normal');
      geometry.deleteAttribute('color');
      geometry.deleteAttribute('uv');
      geometry.deleteAttribute('aTexIndex');
      geometry.deleteAttribute('aPackedLight');
      geometry.setIndex(null);
      
      this.geometryPool.push(geometry);
    } else {
      geometry.dispose();
    }
  }
  
  /**
   * Clean up GPU resources
   */
  dispose() {
    if (this.stagingBuffers.vertices) {
      this.stagingBuffers.vertices.destroy();
    }
    if (this.stagingBuffers.indices) {
      this.stagingBuffers.indices.destroy();
    }
    
    for (const geometry of this.geometryPool) {
      geometry.dispose();
    }
    this.geometryPool = [];
    
    this.initialized = false;
  }
}

// Singleton instance
let adapterInstance = null;

/**
 * Get the global GPU mesh adapter
 * @returns {GPUMeshAdapter}
 */
export function getGPUMeshAdapter() {
  if (!adapterInstance) {
    adapterInstance = new GPUMeshAdapter();
  }
  return adapterInstance;
}

export default {
  GPUMeshAdapter,
  getGPUMeshAdapter,
  CONFIG,
};
