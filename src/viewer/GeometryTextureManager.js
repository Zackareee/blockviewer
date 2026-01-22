/**
 * GeometryTextureManager - Packs geometry into DataTextures for single-draw rendering
 * 
 * This is the core of Option C: DataTexture Unified Rendering.
 * 
 * Instead of creating separate BufferGeometry for each super-chunk, we pack all
 * vertex data into large DataTextures. The vertex shader fetches vertex attributes
 * using texelFetch() based on gl_VertexID.
 * 
 * Texture Layout:
 * - Position texture (RGBA32F): xyz position + objectID
 * - Attribute texture (RGBA32F): normal xyz + packed attributes
 * - UV texture (RG16F): model UVs for partial blocks
 * - Object matrix texture (RGBA32F): per-object world offset matrices
 * - Visibility texture (R8): per-object visibility flags
 * 
 * Benefits:
 * - Reduces draw calls from 200+ to 3-6
 * - Eliminates BufferGeometry creation overhead
 * - Enables GPU-based frustum culling via visibility texture
 */

import * as THREE from 'three';
import { VertexAllocator } from './VertexAllocator.js';

// Default texture size - can be smaller for initial allocation
const DEFAULT_TEXTURE_SIZE = 2048; // 2048x2048 = 4M vertices max per texture
const MAX_TEXTURE_SIZE = 4096; // Maximum WebGL texture size

// Maximum number of objects (super-chunks)
const MAX_OBJECTS = 256 * 256; // 65536 objects

/**
 * Calculate optimal texture dimensions for a given vertex count
 * Tries to keep textures roughly square for better cache performance
 */
function calculateTextureDimensions(maxVertices) {
  // Clamp to reasonable range
  const vertices = Math.max(1024, Math.min(maxVertices, MAX_TEXTURE_SIZE * MAX_TEXTURE_SIZE));
  
  // Calculate square root and round up to power of 2
  const sqrtSize = Math.sqrt(vertices);
  const size = Math.pow(2, Math.ceil(Math.log2(sqrtSize)));
  
  // Clamp to max texture size
  const width = Math.min(size, MAX_TEXTURE_SIZE);
  const height = Math.min(Math.ceil(vertices / width), MAX_TEXTURE_SIZE);
  
  return { width, height, maxVertices: width * height };
}

// Constants for packed vertex format (must match WASM PackedVertex)
const SUPER_CHUNK_SIZE_BLOCKS = 32.0;
const WORLD_HEIGHT_RANGE = 384.0;
const WORLD_MIN_Y = -64.0;

/**
 * GeometryTextureManager - Manages DataTextures for unified rendering
 */
export class GeometryTextureManager {
  /**
   * @param {THREE.WebGLRenderer} renderer - Three.js renderer for texture updates
   * @param {number} maxVertices - Maximum vertices to support (default 2M for memory efficiency)
   */
  constructor(renderer, maxVertices = 2 * 1024 * 1024) {
    this.renderer = renderer;
    
    // Calculate optimal texture dimensions for requested vertex count
    const dims = calculateTextureDimensions(maxVertices);
    this.textureWidth = dims.width;
    this.textureHeight = dims.height;
    this.maxVertices = dims.maxVertices;
    
    // Vertex allocator
    this.allocator = new VertexAllocator(this.maxVertices);
    
    // Object registry: objectId -> { offset, count, superChunkKey, center, visible }
    this.objects = new Map();
    
    // SuperChunk key -> objectId mapping for quick lookup
    this.keyToObjectId = new Map();
    
    // Create DataTextures
    this._createTextures();
    
    // Pending updates for batched upload
    this.pendingUpdates = [];
    
    // Stats
    this.uploadCount = 0;
    this.bytesUploaded = 0;
  }
  
  /**
   * Create all DataTextures
   */
  _createTextures() {
    const w = this.textureWidth;
    const h = this.textureHeight;
    
    // Position texture: RGBA32F (xyz position + objectID)
    // Using Float32Array for full precision
    this.positionData = new Float32Array(w * h * 4);
    this.positionTexture = new THREE.DataTexture(
      this.positionData,
      w, h,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.positionTexture.needsUpdate = true;
    this.positionTexture.magFilter = THREE.NearestFilter;
    this.positionTexture.minFilter = THREE.NearestFilter;
    this.positionTexture.generateMipmaps = false;
    
    // Attribute texture: RGBA32F (normal xyz + packed attrs)
    this.attributeData = new Float32Array(w * h * 4);
    this.attributeTexture = new THREE.DataTexture(
      this.attributeData,
      w, h,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.attributeTexture.needsUpdate = true;
    this.attributeTexture.magFilter = THREE.NearestFilter;
    this.attributeTexture.minFilter = THREE.NearestFilter;
    this.attributeTexture.generateMipmaps = false;
    
    // UV texture: RG16F (model UVs)
    // Using Float16 would be ideal but Three.js doesn't support it directly
    // Using Float32 for now, could optimize later
    this.uvData = new Float32Array(w * h * 2);
    this.uvTexture = new THREE.DataTexture(
      this.uvData,
      w, h,
      THREE.RGFormat,
      THREE.FloatType
    );
    this.uvTexture.needsUpdate = true;
    this.uvTexture.magFilter = THREE.NearestFilter;
    this.uvTexture.minFilter = THREE.NearestFilter;
    this.uvTexture.generateMipmaps = false;
    
    // Object matrix texture: RGBA32F (4 texels per object for mat4)
    // 256x256 = 65536 objects, 4 texels each = 16384 mat4s
    const matrixWidth = 256;
    const matrixHeight = 256 * 4; // 4 rows per object
    this.objectMatrixData = new Float32Array(matrixWidth * matrixHeight * 4);
    this.objectMatrixTexture = new THREE.DataTexture(
      this.objectMatrixData,
      matrixWidth, matrixHeight,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.objectMatrixTexture.needsUpdate = true;
    this.objectMatrixTexture.magFilter = THREE.NearestFilter;
    this.objectMatrixTexture.minFilter = THREE.NearestFilter;
    this.objectMatrixTexture.generateMipmaps = false;
    
    // Visibility texture: R8 (one byte per object)
    // 256x256 = 65536 objects
    this.visibilityData = new Uint8Array(256 * 256);
    this.visibilityTexture = new THREE.DataTexture(
      this.visibilityData,
      256, 256,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    this.visibilityTexture.needsUpdate = true;
    this.visibilityTexture.magFilter = THREE.NearestFilter;
    this.visibilityTexture.minFilter = THREE.NearestFilter;
    this.visibilityTexture.generateMipmaps = false;
    
    // Index texture: stores triangle indices
    // We'll use a large index buffer instead for now
    this.indexData = null;
    this.totalIndices = 0;
    
    console.log(`[GeometryTextureManager] Created textures: ${w}x${h} (${(this.maxVertices / 1e6).toFixed(1)}M vertices max)`);
  }
  
  /**
   * Allocate space for a super-chunk's geometry
   * 
   * @param {string} superChunkKey - Super-chunk identifier (e.g., "0,0")
   * @param {number} vertexCount - Number of vertices needed
   * @param {THREE.Vector3} center - Center position for frustum culling
   * @returns {number|null} - Object ID or null if allocation failed
   */
  allocateObject(superChunkKey, vertexCount, center) {
    // Check if already allocated
    if (this.keyToObjectId.has(superChunkKey)) {
      // Free the old allocation first
      this.freeObject(superChunkKey);
    }
    
    // Allocate vertex slots
    const objectId = this.allocator.allocate(vertexCount);
    if (objectId === null) {
      console.warn(`[GeometryTextureManager] Failed to allocate ${vertexCount} vertices for ${superChunkKey}`);
      return null;
    }
    
    const allocation = this.allocator.getAllocation(objectId);
    
    // Register the object
    this.objects.set(objectId, {
      offset: allocation.offset,
      count: allocation.count,
      superChunkKey,
      center: center.clone(),
      visible: true,
    });
    
    this.keyToObjectId.set(superChunkKey, objectId);
    
    // Set visibility to true by default
    this._setVisibility(objectId, true);
    
    return objectId;
  }
  
  /**
   * Upload geometry data to textures
   * 
   * @param {number} objectId - Object ID from allocateObject
   * @param {Object} packedData - Packed vertex data from worker
   * @param {THREE.Vector3} worldOffset - World position offset
   */
  uploadGeometry(objectId, packedData, worldOffset) {
    const obj = this.objects.get(objectId);
    if (!obj) {
      console.warn(`[GeometryTextureManager] Unknown object ID: ${objectId}`);
      return;
    }
    
    if (!packedData || !packedData.positions) {
      console.warn(`[GeometryTextureManager] Invalid packed data for object ${objectId}`);
      return;
    }
    
    const baseOffset = obj.offset;
    const vertexCount = Math.min(packedData.vertexCount || (packedData.positions.length / 3), obj.count);
    
    // Write vertex data to textures
    for (let i = 0; i < vertexCount; i++) {
      const texelIndex = baseOffset + i;
      
      // Position texture: xyz + objectID
      this.positionData[texelIndex * 4 + 0] = packedData.positions[i * 3 + 0];
      this.positionData[texelIndex * 4 + 1] = packedData.positions[i * 3 + 1];
      this.positionData[texelIndex * 4 + 2] = packedData.positions[i * 3 + 2];
      this.positionData[texelIndex * 4 + 3] = objectId;
      
      // Attribute texture: normal xyz + packed attributes
      this.attributeData[texelIndex * 4 + 0] = packedData.normals[i * 3 + 0];
      this.attributeData[texelIndex * 4 + 1] = packedData.normals[i * 3 + 1];
      this.attributeData[texelIndex * 4 + 2] = packedData.normals[i * 3 + 2];
      
      // Pack attributes into W component
      const texIndex = packedData.texIndices?.[i] || 0;
      const tintType = packedData.tintTypes?.[i] || 0;
      const skyLight = packedData.skyLight?.[i] || 15;
      const blockLight = packedData.blockLight?.[i] || 0;
      const texRotation = packedData.texRotations?.[i] || 0;
      
      // Pack into a single float (as integer bits)
      // Format: texIndex(16) | tintType(4) | texRot(2) | sky(4) | block(4) | unused(2)
      const packed = 
        ((texIndex & 0xFFFF) << 16) |
        ((tintType & 0xF) << 12) |
        ((texRotation & 0x3) << 10) |
        ((skyLight & 0xF) << 6) |
        ((blockLight & 0xF) << 2);
      
      // Store as float (will be decoded with floatBitsToInt in shader)
      const view = new DataView(new ArrayBuffer(4));
      view.setInt32(0, packed, true);
      this.attributeData[texelIndex * 4 + 3] = view.getFloat32(0, true);
      
      // UV texture
      if (packedData.uvs) {
        this.uvData[texelIndex * 2 + 0] = packedData.uvs[i * 2 + 0] || 0;
        this.uvData[texelIndex * 2 + 1] = packedData.uvs[i * 2 + 1] || 0;
      }
    }
    
    // Update object matrix (translation only for now)
    this._updateObjectMatrix(objectId, worldOffset);
    
    // Use incremental update if renderer context is available
    const gl = this.renderer?.getContext?.();
    if (gl && this.positionTexture.__webglTexture) {
      // Incremental update using texSubImage2D
      this._uploadTextureRegion(gl, this.positionTexture, this.positionData, baseOffset, vertexCount, 4);
      this._uploadTextureRegion(gl, this.attributeTexture, this.attributeData, baseOffset, vertexCount, 4);
      this._uploadTextureRegion(gl, this.uvTexture, this.uvData, baseOffset, vertexCount, 2);
    } else {
      // Fallback to full texture update
      this.positionTexture.needsUpdate = true;
      this.attributeTexture.needsUpdate = true;
      this.uvTexture.needsUpdate = true;
    }
    
    // Track stats
    this.uploadCount++;
    this.bytesUploaded += vertexCount * (4 * 4 + 4 * 4 + 2 * 4); // Position + Attribute + UV
  }
  
  /**
   * Upload a region of a texture using texSubImage2D for efficiency
   * 
   * @param {WebGLRenderingContext} gl - WebGL context
   * @param {THREE.DataTexture} texture - Three.js texture
   * @param {Float32Array} data - Full texture data array
   * @param {number} startVertex - Starting vertex index
   * @param {number} vertexCount - Number of vertices to upload
   * @param {number} componentsPerVertex - Components per texel (4 for RGBA, 2 for RG)
   */
  _uploadTextureRegion(gl, texture, data, startVertex, vertexCount, componentsPerVertex) {
    const textureWidth = this.textureWidth;
    
    // Calculate texture region bounds
    const startTexel = startVertex;
    const endTexel = startVertex + vertexCount;
    
    const startRow = Math.floor(startTexel / textureWidth);
    const endRow = Math.floor((endTexel - 1) / textureWidth);
    
    // For simplicity, upload full rows that contain the modified data
    const rowStart = startRow * textureWidth;
    const rowEnd = (endRow + 1) * textureWidth;
    const rowCount = endRow - startRow + 1;
    
    // Bind texture
    gl.bindTexture(gl.TEXTURE_2D, texture.__webglTexture);
    
    // Extract subarray for upload
    const subData = data.subarray(rowStart * componentsPerVertex, rowEnd * componentsPerVertex);
    
    // Upload using texSubImage2D
    const format = componentsPerVertex === 4 ? gl.RGBA : gl.RG;
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      0, startRow, // x, y offset
      textureWidth, rowCount, // width, height
      format, gl.FLOAT, subData
    );
  }
  
  /**
   * Update object transformation matrix
   */
  _updateObjectMatrix(objectId, offset) {
    // Each object gets 4 texels (one mat4 row per texel)
    // For now, just store translation (identity rotation/scale)
    const baseTexel = objectId * 4;
    const matrixWidth = 256;
    
    // Row 0: [1, 0, 0, 0]
    const row0 = (baseTexel % matrixWidth) + Math.floor(baseTexel / matrixWidth) * matrixWidth * 4;
    this.objectMatrixData[row0 * 4 + 0] = 1;
    this.objectMatrixData[row0 * 4 + 1] = 0;
    this.objectMatrixData[row0 * 4 + 2] = 0;
    this.objectMatrixData[row0 * 4 + 3] = 0;
    
    // Row 1: [0, 1, 0, 0]
    const row1 = row0 + matrixWidth;
    this.objectMatrixData[row1 * 4 + 0] = 0;
    this.objectMatrixData[row1 * 4 + 1] = 1;
    this.objectMatrixData[row1 * 4 + 2] = 0;
    this.objectMatrixData[row1 * 4 + 3] = 0;
    
    // Row 2: [0, 0, 1, 0]
    const row2 = row1 + matrixWidth;
    this.objectMatrixData[row2 * 4 + 0] = 0;
    this.objectMatrixData[row2 * 4 + 1] = 0;
    this.objectMatrixData[row2 * 4 + 2] = 1;
    this.objectMatrixData[row2 * 4 + 3] = 0;
    
    // Row 3: [tx, ty, tz, 1] (translation)
    const row3 = row2 + matrixWidth;
    this.objectMatrixData[row3 * 4 + 0] = offset?.x || 0;
    this.objectMatrixData[row3 * 4 + 1] = offset?.y || 0;
    this.objectMatrixData[row3 * 4 + 2] = offset?.z || 0;
    this.objectMatrixData[row3 * 4 + 3] = 1;
    
    this.objectMatrixTexture.needsUpdate = true;
  }
  
  /**
   * Set visibility for an object
   */
  _setVisibility(objectId, visible) {
    const idx = objectId % (256 * 256);
    this.visibilityData[idx] = visible ? 255 : 0;
    this.visibilityTexture.needsUpdate = true;
  }
  
  /**
   * Free a super-chunk's geometry
   * 
   * @param {string} superChunkKey - Super-chunk identifier
   * @returns {boolean} - True if freed successfully
   */
  freeObject(superChunkKey) {
    const objectId = this.keyToObjectId.get(superChunkKey);
    if (objectId === undefined) return false;
    
    // Free vertex slots
    this.allocator.free(objectId);
    
    // Remove from registries
    this.objects.delete(objectId);
    this.keyToObjectId.delete(superChunkKey);
    
    // Set visibility to 0
    this._setVisibility(objectId, false);
    
    return true;
  }
  
  /**
   * Update visibility based on frustum culling
   * 
   * @param {THREE.Frustum} frustum - Camera frustum
   */
  updateVisibility(frustum) {
    for (const [objectId, obj] of this.objects) {
      // Simple sphere-based frustum check
      const sphere = new THREE.Sphere(obj.center, 64); // 64 block radius
      obj.visible = frustum.intersectsSphere(sphere);
      this._setVisibility(objectId, obj.visible);
    }
    this.visibilityTexture.needsUpdate = true;
  }
  
  /**
   * Get the total number of vertices currently allocated
   * 
   * @returns {number}
   */
  getTotalVertexCount() {
    return this.allocator.usedVertices;
  }
  
  /**
   * Get the total number of visible vertices
   * 
   * @returns {number}
   */
  getVisibleVertexCount() {
    let count = 0;
    for (const [objectId, obj] of this.objects) {
      if (obj.visible) count += obj.count;
    }
    return count;
  }
  
  /**
   * Check if defragmentation is needed
   * 
   * @returns {boolean}
   */
  needsDefragmentation() {
    return this.allocator.getFragmentationRatio() > 0.3;
  }
  
  /**
   * Defragment textures (compact all allocations)
   * This requires copying texture data, so should be done sparingly
   */
  defragment() {
    const moves = this.allocator.defragment();
    
    if (moves.size === 0) return;
    
    console.log(`[GeometryTextureManager] Defragmenting ${moves.size} objects`);
    
    // Create temporary buffers
    const tempPosition = new Float32Array(this.positionData.length);
    const tempAttribute = new Float32Array(this.attributeData.length);
    const tempUV = new Float32Array(this.uvData.length);
    
    // Copy data to new locations
    for (const [objectId, move] of moves) {
      const { oldOffset, newOffset, count } = move;
      
      // Copy position data
      for (let i = 0; i < count; i++) {
        const srcIdx = (oldOffset + i) * 4;
        const dstIdx = (newOffset + i) * 4;
        tempPosition[dstIdx + 0] = this.positionData[srcIdx + 0];
        tempPosition[dstIdx + 1] = this.positionData[srcIdx + 1];
        tempPosition[dstIdx + 2] = this.positionData[srcIdx + 2];
        tempPosition[dstIdx + 3] = this.positionData[srcIdx + 3];
        
        tempAttribute[dstIdx + 0] = this.attributeData[srcIdx + 0];
        tempAttribute[dstIdx + 1] = this.attributeData[srcIdx + 1];
        tempAttribute[dstIdx + 2] = this.attributeData[srcIdx + 2];
        tempAttribute[dstIdx + 3] = this.attributeData[srcIdx + 3];
      }
      
      // Copy UV data
      for (let i = 0; i < count; i++) {
        const srcIdx = (oldOffset + i) * 2;
        const dstIdx = (newOffset + i) * 2;
        tempUV[dstIdx + 0] = this.uvData[srcIdx + 0];
        tempUV[dstIdx + 1] = this.uvData[srcIdx + 1];
      }
      
      // Update object offset
      const obj = this.objects.get(objectId);
      if (obj) obj.offset = newOffset;
    }
    
    // Swap buffers
    this.positionData.set(tempPosition);
    this.attributeData.set(tempAttribute);
    this.uvData.set(tempUV);
    
    // Mark all textures for update
    this.positionTexture.needsUpdate = true;
    this.attributeTexture.needsUpdate = true;
    this.uvTexture.needsUpdate = true;
  }
  
  /**
   * Get all textures for material binding
   * 
   * @returns {Object}
   */
  getTextures() {
    return {
      positionTexture: this.positionTexture,
      attributeTexture: this.attributeTexture,
      uvTexture: this.uvTexture,
      objectMatrixTexture: this.objectMatrixTexture,
      visibilityTexture: this.visibilityTexture,
    };
  }
  
  /**
   * Get statistics
   * 
   * @returns {Object}
   */
  getStats() {
    const allocatorStats = this.allocator.getStats();
    return {
      ...allocatorStats,
      objectCount: this.objects.size,
      visibleObjects: [...this.objects.values()].filter(o => o.visible).length,
      textureSize: `${this.textureWidth}x${this.textureHeight}`,
      uploadCount: this.uploadCount,
      bytesUploaded: this.bytesUploaded,
      bytesUploadedMB: (this.bytesUploaded / (1024 * 1024)).toFixed(2),
    };
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    this.positionTexture.dispose();
    this.attributeTexture.dispose();
    this.uvTexture.dispose();
    this.objectMatrixTexture.dispose();
    this.visibilityTexture.dispose();
    
    this.objects.clear();
    this.keyToObjectId.clear();
    this.allocator.reset();
    
    console.log('[GeometryTextureManager] Disposed');
  }
}
