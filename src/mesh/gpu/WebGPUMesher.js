/**
 * WebGPUMesher - GPU Compute Shader Meshing (Phase 5)
 * 
 * Uses WebGPU compute shaders to perform greedy meshing directly on the GPU.
 * This eliminates the CPU→GPU data transfer bottleneck by generating mesh
 * data directly in GPU memory.
 * 
 * Architecture:
 * 1. Upload block grid and light data to GPU storage buffers
 * 2. Run visibility pass (determine which faces are visible)
 * 3. Run greedy merge pass (merge adjacent faces into quads)
 * 4. Run vertex generation pass (emit vertex data to output buffers)
 * 5. Read back only the vertex counts (data stays on GPU for rendering)
 * 
 * This approach keeps mesh data on the GPU, avoiding the expensive transfer
 * that currently dominates meshing time.
 */

import { detectWebGPU } from '../../utils/CapabilityDetector.js';

// Workgroup sizes - tuned for typical GPU architectures
const WORKGROUP_SIZE = 64;
const SECTION_SIZE = 16;
const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE;

// Shader source for face visibility detection
const VISIBILITY_SHADER = /* wgsl */`
// Block grid storage - sparse section format
struct Section {
  data: array<u32, 4096>, // 16x16x16 blocks
}

@group(0) @binding(0) var<storage, read> block_grid: array<Section>;
@group(0) @binding(1) var<storage, read> block_lookup: array<u32>; // Block ID -> flags
@group(0) @binding(2) var<storage, read_write> face_visibility: array<atomic<u32>>; // 6 bits per block

// Lookup flags
const FLAG_OPAQUE: u32 = 1u;
const FLAG_TRANSPARENT: u32 = 2u;
const FLAG_FLUID: u32 = 4u;
const FLAG_GLASS: u32 = 8u;
const FLAG_SLAB: u32 = 16u;

// Face directions
const FACE_NEG_X: u32 = 0u;
const FACE_POS_X: u32 = 1u;
const FACE_NEG_Y: u32 = 2u;
const FACE_POS_Y: u32 = 3u;
const FACE_NEG_Z: u32 = 4u;
const FACE_POS_Z: u32 = 5u;

fn get_block(section_idx: u32, x: u32, y: u32, z: u32) -> u32 {
  let idx = x + y * 16u + z * 256u;
  return block_grid[section_idx].data[idx];
}

fn is_opaque(block_id: u32) -> bool {
  return (block_lookup[block_id] & FLAG_OPAQUE) != 0u;
}

fn should_render_face(this_block: u32, neighbor_block: u32) -> bool {
  // Render face if this block is solid and neighbor is not opaque
  if (!is_opaque(this_block & 0xFFFu)) {
    return false;
  }
  return !is_opaque(neighbor_block & 0xFFFu);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let section_idx = global_id.z;
  let block_idx = global_id.x + global_id.y * 16u;
  
  if (block_idx >= 4096u) {
    return;
  }
  
  let x = block_idx % 16u;
  let y = (block_idx / 16u) % 16u;
  let z = block_idx / 256u;
  
  let this_block = get_block(section_idx, x, y, z);
  if (this_block == 0u) {
    return; // Air block
  }
  
  var visibility: u32 = 0u;
  
  // Check all 6 faces
  // -X face
  if (x == 0u || should_render_face(this_block, get_block(section_idx, x - 1u, y, z))) {
    visibility |= (1u << FACE_NEG_X);
  }
  // +X face
  if (x == 15u || should_render_face(this_block, get_block(section_idx, x + 1u, y, z))) {
    visibility |= (1u << FACE_POS_X);
  }
  // -Y face
  if (y == 0u || should_render_face(this_block, get_block(section_idx, x, y - 1u, z))) {
    visibility |= (1u << FACE_NEG_Y);
  }
  // +Y face
  if (y == 15u || should_render_face(this_block, get_block(section_idx, x, y + 1u, z))) {
    visibility |= (1u << FACE_POS_Y);
  }
  // -Z face
  if (z == 0u || should_render_face(this_block, get_block(section_idx, x, y, z - 1u))) {
    visibility |= (1u << FACE_NEG_Z);
  }
  // +Z face
  if (z == 15u || should_render_face(this_block, get_block(section_idx, x, y, z + 1u))) {
    visibility |= (1u << FACE_POS_Z);
  }
  
  // Store visibility bits
  let output_idx = section_idx * 4096u + block_idx;
  atomicStore(&face_visibility[output_idx], visibility);
}
`;

// Vertex generation shader (simplified - full version would include greedy merging)
const VERTEX_GEN_SHADER = /* wgsl */`
struct Vertex {
  position: vec3<f32>,
  normal: vec3<f32>,
  color: vec3<f32>,
  uv: vec2<f32>,
  tex_index: f32,
  light: u32, // Packed: sky << 4 | block
}

struct Section {
  data: array<u32, 4096>,
}

struct VertexOutput {
  vertices: array<Vertex>,
}

struct CounterBuffer {
  solid_vertices: atomic<u32>,
  solid_indices: atomic<u32>,
}

@group(0) @binding(0) var<storage, read> block_grid: array<Section>;
@group(0) @binding(1) var<storage, read> face_visibility: array<u32>;
@group(0) @binding(2) var<storage, read> light_grid: array<u32>; // Packed light
@group(0) @binding(3) var<storage, read> texture_lookup: array<u32>; // Block ID -> texture index
@group(0) @binding(4) var<storage, read_write> output_vertices: array<Vertex>;
@group(0) @binding(5) var<storage, read_write> output_indices: array<u32>;
@group(0) @binding(6) var<storage, read_write> counters: CounterBuffer;

// Face normal vectors
const NORMALS: array<vec3<f32>, 6> = array<vec3<f32>, 6>(
  vec3<f32>(-1.0, 0.0, 0.0),  // -X
  vec3<f32>(1.0, 0.0, 0.0),   // +X
  vec3<f32>(0.0, -1.0, 0.0),  // -Y
  vec3<f32>(0.0, 1.0, 0.0),   // +Y
  vec3<f32>(0.0, 0.0, -1.0),  // -Z
  vec3<f32>(0.0, 0.0, 1.0),   // +Z
);

// AO levels: 3 = full brightness, 0 = maximum occlusion
// Maps to colors: [1.0, 0.9, 0.8, 0.65, 0.4]
const AO_BRIGHTNESS: array<f32, 5> = array<f32, 5>(1.0, 0.9, 0.8, 0.65, 0.4);

// Check if block at position is opaque (for AO)
fn is_block_opaque_at(section_idx: u32, x: i32, y: i32, z: i32) -> bool {
  // Bounds check
  if (x < 0 || x >= 16 || y < 0 || y >= 16 || z < 0 || z >= 16) {
    return false; // Treat out-of-bounds as air
  }
  
  let idx = u32(x) + u32(y) * 16u + u32(z) * 256u;
  let block = block_grid[section_idx].data[idx];
  return block != 0u; // Simplified: non-air is opaque
}

// Calculate AO for a single vertex corner
// side1, side2: the two adjacent side blocks
// corner: the diagonal corner block
fn calculate_vertex_ao(side1: bool, side2: bool, corner: bool) -> u32 {
  if (side1 && side2) {
    return 0u; // Maximum occlusion
  }
  var ao = 3u;
  if (side1) { ao = ao - 1u; }
  if (side2) { ao = ao - 1u; }
  if (corner) { ao = ao - 1u; }
  return ao;
}

// Get AO for all 4 vertices of a top face (+Y)
fn get_top_face_ao(section_idx: u32, x: i32, y: i32, z: i32) -> vec4<u32> {
  let y_above = y + 1;
  
  // V0 (SW corner): check W, S, SW
  let v0_west = is_block_opaque_at(section_idx, x - 1, y_above, z);
  let v0_south = is_block_opaque_at(section_idx, x, y_above, z + 1);
  let v0_sw = is_block_opaque_at(section_idx, x - 1, y_above, z + 1);
  let ao0 = calculate_vertex_ao(v0_west, v0_south, v0_sw);
  
  // V1 (SE corner): check E, S, SE
  let v1_east = is_block_opaque_at(section_idx, x + 1, y_above, z);
  let v1_south = is_block_opaque_at(section_idx, x, y_above, z + 1);
  let v1_se = is_block_opaque_at(section_idx, x + 1, y_above, z + 1);
  let ao1 = calculate_vertex_ao(v1_east, v1_south, v1_se);
  
  // V2 (NE corner): check E, N, NE
  let v2_east = is_block_opaque_at(section_idx, x + 1, y_above, z);
  let v2_north = is_block_opaque_at(section_idx, x, y_above, z - 1);
  let v2_ne = is_block_opaque_at(section_idx, x + 1, y_above, z - 1);
  let ao2 = calculate_vertex_ao(v2_east, v2_north, v2_ne);
  
  // V3 (NW corner): check W, N, NW
  let v3_west = is_block_opaque_at(section_idx, x - 1, y_above, z);
  let v3_north = is_block_opaque_at(section_idx, x, y_above, z - 1);
  let v3_nw = is_block_opaque_at(section_idx, x - 1, y_above, z - 1);
  let ao3 = calculate_vertex_ao(v3_west, v3_north, v3_nw);
  
  return vec4<u32>(ao0, ao1, ao2, ao3);
}

// Get AO brightness for a vertex
fn ao_to_brightness(ao: u32) -> f32 {
  return AO_BRIGHTNESS[min(ao, 4u)];
}

fn emit_face(block_x: f32, block_y: f32, block_z: f32, face: u32, tex_idx: u32, light: u32) {
  // Allocate 4 vertices atomically
  let vertex_offset = atomicAdd(&counters.solid_vertices, 4u);
  let index_offset = atomicAdd(&counters.solid_indices, 6u);
  
  let normal = NORMALS[face];
  let color = vec3<f32>(1.0, 1.0, 1.0);
  
  // Calculate vertex positions based on face direction
  // This is simplified - full version would have proper UV mapping per face
  var positions: array<vec3<f32>, 4>;
  
  if (face == 0u) { // -X
    positions = array<vec3<f32>, 4>(
      vec3<f32>(block_x, block_y, block_z),
      vec3<f32>(block_x, block_y + 1.0, block_z),
      vec3<f32>(block_x, block_y + 1.0, block_z + 1.0),
      vec3<f32>(block_x, block_y, block_z + 1.0),
    );
  } else if (face == 1u) { // +X
    positions = array<vec3<f32>, 4>(
      vec3<f32>(block_x + 1.0, block_y, block_z + 1.0),
      vec3<f32>(block_x + 1.0, block_y + 1.0, block_z + 1.0),
      vec3<f32>(block_x + 1.0, block_y + 1.0, block_z),
      vec3<f32>(block_x + 1.0, block_y, block_z),
    );
  } else if (face == 2u) { // -Y
    positions = array<vec3<f32>, 4>(
      vec3<f32>(block_x, block_y, block_z),
      vec3<f32>(block_x, block_y, block_z + 1.0),
      vec3<f32>(block_x + 1.0, block_y, block_z + 1.0),
      vec3<f32>(block_x + 1.0, block_y, block_z),
    );
  } else if (face == 3u) { // +Y
    positions = array<vec3<f32>, 4>(
      vec3<f32>(block_x, block_y + 1.0, block_z + 1.0),
      vec3<f32>(block_x, block_y + 1.0, block_z),
      vec3<f32>(block_x + 1.0, block_y + 1.0, block_z),
      vec3<f32>(block_x + 1.0, block_y + 1.0, block_z + 1.0),
    );
  } else if (face == 4u) { // -Z
    positions = array<vec3<f32>, 4>(
      vec3<f32>(block_x + 1.0, block_y, block_z),
      vec3<f32>(block_x + 1.0, block_y + 1.0, block_z),
      vec3<f32>(block_x, block_y + 1.0, block_z),
      vec3<f32>(block_x, block_y, block_z),
    );
  } else { // +Z
    positions = array<vec3<f32>, 4>(
      vec3<f32>(block_x, block_y, block_z + 1.0),
      vec3<f32>(block_x, block_y + 1.0, block_z + 1.0),
      vec3<f32>(block_x + 1.0, block_y + 1.0, block_z + 1.0),
      vec3<f32>(block_x + 1.0, block_y, block_z + 1.0),
    );
  }
  
  // UV coordinates
  let uvs = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0),
  );
  
  // Write vertices
  for (var i = 0u; i < 4u; i = i + 1u) {
    output_vertices[vertex_offset + i] = Vertex(
      positions[i],
      normal,
      color,
      uvs[i],
      f32(tex_idx),
      light,
    );
  }
  
  // Write indices (two triangles: 0-1-2, 0-2-3)
  let base = vertex_offset;
  output_indices[index_offset + 0u] = base;
  output_indices[index_offset + 1u] = base + 1u;
  output_indices[index_offset + 2u] = base + 2u;
  output_indices[index_offset + 3u] = base;
  output_indices[index_offset + 4u] = base + 2u;
  output_indices[index_offset + 5u] = base + 3u;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let section_idx = global_id.z;
  let block_idx = global_id.x + global_id.y * 16u;
  
  if (block_idx >= 4096u) {
    return;
  }
  
  let x = block_idx % 16u;
  let y = (block_idx / 16u) % 16u;
  let z = block_idx / 256u;
  
  let visibility_idx = section_idx * 4096u + block_idx;
  let visibility = face_visibility[visibility_idx];
  
  if (visibility == 0u) {
    return;
  }
  
  let block = block_grid[section_idx].data[block_idx];
  let block_id = block & 0xFFFu;
  let tex_idx = texture_lookup[block_id];
  let light = light_grid[visibility_idx];
  
  // World position (assuming section origin is passed separately)
  let world_x = f32(x);
  let world_y = f32(y);
  let world_z = f32(z);
  
  // Emit faces for each visible direction
  for (var face = 0u; face < 6u; face = face + 1u) {
    if ((visibility & (1u << face)) != 0u) {
      emit_face(world_x, world_y, world_z, face, tex_idx, light);
    }
  }
}
`;

// Greedy merge shader - merges adjacent faces of the same block type
const GREEDY_MERGE_SHADER = /* wgsl */`
// Workgroup shared memory for greedy merging
var<workgroup> slice_mask: array<u32, 256>; // 16x16 slice of block IDs
var<workgroup> slice_visited: array<u32, 8>; // Bit flags for visited (256 bits)

struct Section {
  data: array<u32, 4096>,
}

struct MergedQuad {
  x: u32,       // Start X position
  y: u32,       // Start Y position  
  z: u32,       // Slice position (layer)
  width: u32,   // Quad width
  height: u32,  // Quad height
  block_id: u32,
  face: u32,
  ao: u32,      // Packed AO for 4 corners
}

@group(0) @binding(0) var<storage, read> block_grid: array<Section>;
@group(0) @binding(1) var<storage, read> face_visibility: array<u32>;
@group(0) @binding(2) var<storage, read_write> merged_quads: array<MergedQuad>;
@group(0) @binding(3) var<storage, read_write> quad_count: atomic<u32>;

fn is_visited(idx: u32) -> bool {
  let word = idx / 32u;
  let bit = idx % 32u;
  return (slice_visited[word] & (1u << bit)) != 0u;
}

fn mark_visited(idx: u32) {
  let word = idx / 32u;
  let bit = idx % 32u;
  atomicOr(&slice_visited[word], 1u << bit);
}

// Build mask for a Y-slice (for top/bottom faces)
fn build_slice_mask_y(section_idx: u32, layer_y: u32, face: u32) {
  let tid = workgroupUniformLoad(&slice_mask[0]); // Sync point
  
  // Each thread processes multiple cells
  for (var i = 0u; i < 256u; i = i + 64u) {
    let local_idx = i + (tid % 64u);
    if (local_idx < 256u) {
      let x = local_idx % 16u;
      let z = local_idx / 16u;
      let block_idx = x + layer_y * 16u + z * 256u;
      
      let visibility_idx = section_idx * 4096u + block_idx;
      let visibility = face_visibility[visibility_idx];
      
      // Check if this face is visible
      if ((visibility & (1u << face)) != 0u) {
        let block = block_grid[section_idx].data[block_idx];
        slice_mask[local_idx] = block & 0xFFFu; // Store block ID
      } else {
        slice_mask[local_idx] = 0u;
      }
    }
  }
  
  // Clear visited flags
  for (var i = 0u; i < 8u; i = i + 1u) {
    slice_visited[i] = 0u;
  }
  
  workgroupBarrier();
}

// Greedy merge within a slice
fn greedy_merge_slice(section_idx: u32, layer: u32, face: u32) {
  let tid = 0u; // Would be workgroup local id
  
  // Each thread tries to create quads starting from different positions
  for (var start = 0u; start < 256u; start = start + 1u) {
    if (is_visited(start) || slice_mask[start] == 0u) {
      continue;
    }
    
    let block_id = slice_mask[start];
    let start_x = start % 16u;
    let start_z = start / 16u;
    
    // Expand width (+X)
    var width = 1u;
    while (start_x + width < 16u) {
      let check_idx = start_z * 16u + start_x + width;
      if (is_visited(check_idx) || slice_mask[check_idx] != block_id) {
        break;
      }
      width = width + 1u;
    }
    
    // Expand height (+Z)
    var height = 1u;
    loop {
      if (start_z + height >= 16u) {
        break;
      }
      
      var row_ok = true;
      for (var dx = 0u; dx < width; dx = dx + 1u) {
        let check_idx = (start_z + height) * 16u + start_x + dx;
        if (is_visited(check_idx) || slice_mask[check_idx] != block_id) {
          row_ok = false;
          break;
        }
      }
      
      if (!row_ok) {
        break;
      }
      height = height + 1u;
    }
    
    // Mark all cells as visited
    for (var dz = 0u; dz < height; dz = dz + 1u) {
      for (var dx = 0u; dx < width; dx = dx + 1u) {
        let idx = (start_z + dz) * 16u + start_x + dx;
        mark_visited(idx);
      }
    }
    
    // Output merged quad
    let quad_idx = atomicAdd(&quad_count, 1u);
    merged_quads[quad_idx] = MergedQuad(
      start_x,
      layer,
      start_z,
      width,
      height,
      block_id,
      face,
      0u, // AO would be calculated separately
    );
  }
}

@compute @workgroup_size(1) // Serial for now, parallel version needs more complex sync
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let section_idx = global_id.z;
  let face = global_id.x; // 0-5 for each face direction
  
  // Process each layer for this face
  if (face == 3u) { // +Y (top) face - iterate Y layers
    for (var y = 0u; y < 16u; y = y + 1u) {
      build_slice_mask_y(section_idx, y, face);
      greedy_merge_slice(section_idx, y, face);
    }
  }
  // Similar for other face directions...
}
`;

/**
 * WebGPU Mesher class - manages GPU resources and compute pipelines
 */
export class WebGPUMesher {
  constructor() {
    this.device = null;
    this.adapter = null;
    this.visibilityPipeline = null;
    this.vertexGenPipeline = null;
    this.initialized = false;
    
    // Buffer pools
    this.gridBuffers = new Map();
    this.outputBuffers = null;
  }
  
  /**
   * Initialize WebGPU device and pipelines
   * @returns {Promise<boolean>} True if initialization successful
   */
  async initialize() {
    if (this.initialized) return true;
    
    const gpuCaps = await detectWebGPU();
    if (!gpuCaps.available) {
      console.warn('[WebGPUMesher] WebGPU not available:', gpuCaps.reason);
      return false;
    }
    
    try {
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        console.warn('[WebGPUMesher] No GPU adapter available');
        return false;
      }
      
      this.device = await this.adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: 128 * 1024 * 1024, // 128MB for large worlds
          maxBufferSize: 128 * 1024 * 1024,
        },
      });
      
      if (!this.device) {
        console.warn('[WebGPUMesher] Failed to get GPU device');
        return false;
      }
      
      // Create visibility detection pipeline
      const visibilityModule = this.device.createShaderModule({
        label: 'Visibility Detection',
        code: VISIBILITY_SHADER,
      });
      
      this.visibilityPipeline = this.device.createComputePipeline({
        label: 'Visibility Pipeline',
        layout: 'auto',
        compute: {
          module: visibilityModule,
          entryPoint: 'main',
        },
      });
      
      // Create vertex generation pipeline
      const vertexGenModule = this.device.createShaderModule({
        label: 'Vertex Generation',
        code: VERTEX_GEN_SHADER,
      });
      
      this.vertexGenPipeline = this.device.createComputePipeline({
        label: 'Vertex Gen Pipeline',
        layout: 'auto',
        compute: {
          module: vertexGenModule,
          entryPoint: 'main',
        },
      });
      
      // Pre-allocate output buffers
      this.allocateOutputBuffers();
      
      this.initialized = true;
      console.log('[WebGPUMesher] Initialized successfully');
      return true;
    } catch (error) {
      console.error('[WebGPUMesher] Initialization failed:', error);
      return false;
    }
  }
  
  /**
   * Allocate output buffers for mesh data
   */
  allocateOutputBuffers() {
    // Estimate max vertices/indices for a super-chunk
    // A super-chunk is 2x2 chunks = 32x384x32 blocks
    // Worst case: every block has 6 visible faces = ~100M faces
    // Typical case: ~1-5% faces visible = ~500K-2.5M vertices
    const MAX_VERTICES = 4 * 1024 * 1024; // 4M vertices
    const MAX_INDICES = 6 * 1024 * 1024; // 6M indices
    
    const vertexSize = 4 * (3 + 3 + 3 + 2 + 1 + 1); // pos, normal, color, uv, tex, light = 52 bytes
    
    this.outputBuffers = {
      vertices: this.device.createBuffer({
        label: 'Output Vertices',
        size: MAX_VERTICES * vertexSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      indices: this.device.createBuffer({
        label: 'Output Indices',
        size: MAX_INDICES * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      counters: this.device.createBuffer({
        label: 'Counters',
        size: 8, // 2x u32: vertex count, index count
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
      readback: this.device.createBuffer({
        label: 'Counter Readback',
        size: 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
    };
  }
  
  /**
   * Upload grid data to GPU
   * @param {Uint16Array} gridData - Serialized grid data
   * @param {Uint8Array} lightData - Serialized light data
   * @param {Uint32Array} lookupData - Block lookup table
   * @param {Uint32Array} textureData - Texture index lookup
   * @returns {Object} GPU buffer handles
   */
  uploadGridData(gridData, lightData, lookupData, textureData) {
    // Create and upload block grid buffer
    const gridBuffer = this.device.createBuffer({
      label: 'Block Grid',
      size: gridData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(gridBuffer, 0, gridData);
    
    // Create and upload light grid buffer
    const lightBuffer = this.device.createBuffer({
      label: 'Light Grid',
      size: lightData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(lightBuffer, 0, lightData);
    
    // Create and upload lookup buffer
    const lookupBuffer = this.device.createBuffer({
      label: 'Block Lookup',
      size: lookupData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(lookupBuffer, 0, lookupData);
    
    // Create and upload texture lookup buffer
    const textureBuffer = this.device.createBuffer({
      label: 'Texture Lookup',
      size: textureData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(textureBuffer, 0, textureData);
    
    return { gridBuffer, lightBuffer, lookupBuffer, textureBuffer };
  }
  
  /**
   * Run the meshing pipeline on the GPU
   * @param {Object} buffers - GPU buffers from uploadGridData
   * @param {number} sectionCount - Number of sections to process
   * @returns {Promise<Object>} Mesh result with vertex/index counts
   */
  async mesh(buffers, sectionCount) {
    if (!this.initialized) {
      throw new Error('WebGPUMesher not initialized');
    }
    
    // Create visibility buffer
    const visibilityBuffer = this.device.createBuffer({
      label: 'Face Visibility',
      size: sectionCount * SECTION_VOLUME * 4, // u32 per block
      usage: GPUBufferUsage.STORAGE,
    });
    
    // Reset counters
    this.device.queue.writeBuffer(this.outputBuffers.counters, 0, new Uint32Array([0, 0]));
    
    // Create bind groups
    const visibilityBindGroup = this.device.createBindGroup({
      layout: this.visibilityPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.gridBuffer } },
        { binding: 1, resource: { buffer: buffers.lookupBuffer } },
        { binding: 2, resource: { buffer: visibilityBuffer } },
      ],
    });
    
    const vertexGenBindGroup = this.device.createBindGroup({
      layout: this.vertexGenPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.gridBuffer } },
        { binding: 1, resource: { buffer: visibilityBuffer } },
        { binding: 2, resource: { buffer: buffers.lightBuffer } },
        { binding: 3, resource: { buffer: buffers.textureBuffer } },
        { binding: 4, resource: { buffer: this.outputBuffers.vertices } },
        { binding: 5, resource: { buffer: this.outputBuffers.indices } },
        { binding: 6, resource: { buffer: this.outputBuffers.counters } },
      ],
    });
    
    // Create command encoder
    const commandEncoder = this.device.createCommandEncoder();
    
    // Visibility pass
    const visibilityPass = commandEncoder.beginComputePass();
    visibilityPass.setPipeline(this.visibilityPipeline);
    visibilityPass.setBindGroup(0, visibilityBindGroup);
    // Dispatch: 64 blocks per workgroup, 4096 blocks per section
    const visibilityDispatchX = Math.ceil(64 / WORKGROUP_SIZE);
    const visibilityDispatchY = 64;
    visibilityPass.dispatchWorkgroups(visibilityDispatchX, visibilityDispatchY, sectionCount);
    visibilityPass.end();
    
    // Vertex generation pass
    const vertexPass = commandEncoder.beginComputePass();
    vertexPass.setPipeline(this.vertexGenPipeline);
    vertexPass.setBindGroup(0, vertexGenBindGroup);
    vertexPass.dispatchWorkgroups(visibilityDispatchX, visibilityDispatchY, sectionCount);
    vertexPass.end();
    
    // Copy counters for readback
    commandEncoder.copyBufferToBuffer(
      this.outputBuffers.counters, 0,
      this.outputBuffers.readback, 0,
      8
    );
    
    // Submit and wait
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Read back counters
    await this.outputBuffers.readback.mapAsync(GPUMapMode.READ);
    const counterData = new Uint32Array(this.outputBuffers.readback.getMappedRange().slice());
    this.outputBuffers.readback.unmap();
    
    const [vertexCount, indexCount] = counterData;
    
    // Clean up temporary buffers
    visibilityBuffer.destroy();
    
    return {
      vertexCount,
      indexCount,
      // Output buffers stay on GPU - can be used directly for rendering
      vertexBuffer: this.outputBuffers.vertices,
      indexBuffer: this.outputBuffers.indices,
    };
  }
  
  /**
   * Mesh a super-chunk using GPU compute shaders
   * Main entry point for WebGPU meshing path
   * 
   * @param {BinaryGrid} grid - Block grid
   * @param {LightGrid} lightGrid - Light data
   * @param {BlockStateGrid} stateGrid - Block state grid (unused for solid blocks)
   * @param {Object} bounds - Mesh bounds {minChunkX, minChunkZ, maxChunkX, maxChunkZ}
   * @returns {Promise<Object>} Mesh result with GPU buffers
   */
  async meshSuperChunk(grid, lightGrid, stateGrid, bounds) {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) {
        throw new Error('Failed to initialize WebGPU');
      }
    }
    
    // Serialize grid data for GPU upload
    const gridData = this.serializeGridForGPU(grid, bounds);
    const lightData = this.serializeLightForGPU(lightGrid, bounds);
    
    // Build lookup tables
    const lookupData = this.buildLookupTable();
    const textureData = this.buildTextureTable();
    
    // Upload to GPU
    const buffers = this.uploadGridData(gridData, lightData, lookupData, textureData);
    
    // Count sections in bounds
    const sectionCount = this.countSectionsInBounds(grid, bounds);
    
    // Run meshing pipeline
    const result = await this.mesh(buffers, sectionCount);
    
    // Clean up input buffers
    buffers.gridBuffer.destroy();
    buffers.lightBuffer.destroy();
    buffers.lookupBuffer.destroy();
    buffers.textureBuffer.destroy();
    
    return result;
  }
  
  /**
   * Serialize a BinaryGrid for GPU upload
   * @private
   */
  serializeGridForGPU(grid, bounds) {
    const sections = [];
    for (const [key, section] of grid.iter_sections()) {
      if (bounds) {
        const chunkX = key.chunk_x;
        const chunkZ = key.chunk_z;
        if (chunkX < bounds.minChunkX || chunkX > bounds.maxChunkX ||
            chunkZ < bounds.minChunkZ || chunkZ > bounds.maxChunkZ) {
          continue;
        }
      }
      // Convert u16 section to u32 for GPU
      const u32Section = new Uint32Array(4096);
      for (let i = 0; i < 4096; i++) {
        u32Section[i] = section[i];
      }
      sections.push(u32Section);
    }
    
    // Flatten all sections into one buffer
    const totalSize = sections.length * 4096 * 4;
    const buffer = new Uint32Array(totalSize / 4);
    let offset = 0;
    for (const section of sections) {
      buffer.set(section, offset);
      offset += 4096;
    }
    
    return buffer;
  }
  
  /**
   * Serialize a LightGrid for GPU upload
   * @private
   */
  serializeLightForGPU(lightGrid, bounds) {
    if (!lightGrid) {
      // Return empty buffer if no light data
      return new Uint32Array(1);
    }
    
    const sections = [];
    for (const [key, section] of lightGrid.iter_sections()) {
      if (bounds) {
        const chunkX = key.chunk_x;
        const chunkZ = key.chunk_z;
        if (chunkX < bounds.minChunkX || chunkX > bounds.maxChunkX ||
            chunkZ < bounds.minChunkZ || chunkZ > bounds.maxChunkZ) {
          continue;
        }
      }
      // Pack light data: sky << 4 | block
      const packedSection = new Uint32Array(4096);
      for (let i = 0; i < 4096; i++) {
        // Light grid stores raw light values
        packedSection[i] = section[i];
      }
      sections.push(packedSection);
    }
    
    const totalSize = sections.length * 4096 * 4;
    const buffer = new Uint32Array(Math.max(totalSize / 4, 1));
    let offset = 0;
    for (const section of sections) {
      buffer.set(section, offset);
      offset += 4096;
    }
    
    return buffer;
  }
  
  /**
   * Build block lookup table for GPU
   * @private
   */
  buildLookupTable() {
    // Create a lookup table for block properties
    // Flags: opaque, transparent, fluid, glass, slab
    const lookup = new Uint32Array(4096); // Support up to 4096 block IDs
    
    // Default: air is not opaque
    lookup[0] = 0;
    
    // Mark stone and other common solid blocks as opaque
    // This is a simplified version - full implementation would use registry
    for (let i = 1; i < 256; i++) {
      lookup[i] = 1; // FLAG_OPAQUE
    }
    
    return lookup;
  }
  
  /**
   * Build texture index lookup table for GPU
   * @private
   */
  buildTextureTable() {
    // Map block IDs to texture indices
    // Simplified version - full implementation would use texture atlas
    const textures = new Uint32Array(4096);
    for (let i = 0; i < 4096; i++) {
      textures[i] = i % 256; // Simple modulo mapping
    }
    return textures;
  }
  
  /**
   * Count sections within bounds
   * @private
   */
  countSectionsInBounds(grid, bounds) {
    let count = 0;
    for (const [key] of grid.iter_sections()) {
      if (bounds) {
        const chunkX = key.chunk_x;
        const chunkZ = key.chunk_z;
        if (chunkX >= bounds.minChunkX && chunkX <= bounds.maxChunkX &&
            chunkZ >= bounds.minChunkZ && chunkZ <= bounds.maxChunkZ) {
          count++;
        }
      } else {
        count++;
      }
    }
    return Math.max(count, 1);
  }
  
  /**
   * Clean up GPU resources
   */
  dispose() {
    if (this.outputBuffers) {
      this.outputBuffers.vertices.destroy();
      this.outputBuffers.indices.destroy();
      this.outputBuffers.counters.destroy();
      this.outputBuffers.readback.destroy();
    }
    
    for (const buffer of this.gridBuffers.values()) {
      buffer.destroy();
    }
    this.gridBuffers.clear();
    
    if (this.device) {
      this.device.destroy();
    }
    
    this.initialized = false;
  }
}

// Singleton instance
let webGPUMesherInstance = null;

/**
 * Get the global WebGPU mesher instance
 * @returns {WebGPUMesher}
 */
export function getWebGPUMesher() {
  if (!webGPUMesherInstance) {
    webGPUMesherInstance = new WebGPUMesher();
  }
  return webGPUMesherInstance;
}

/**
 * Check if WebGPU meshing is available and initialize if so
 * @returns {Promise<boolean>}
 */
export async function initWebGPUMeshing() {
  const mesher = getWebGPUMesher();
  return await mesher.initialize();
}

export default {
  WebGPUMesher,
  getWebGPUMesher,
  initWebGPUMeshing,
};
