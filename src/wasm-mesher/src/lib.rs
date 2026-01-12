//! WASM Mesher - High-performance Minecraft chunk meshing
//!
//! This crate provides WebAssembly bindings for generating mesh geometry
//! from Minecraft chunk data. It implements:
//! - NBT parsing and chunk decoding (unified pipeline)
//! - Greedy meshing for solid blocks with AO and lighting
//! - Fluid meshing for water/lava with proper height interpolation
//! - Model meshing for non-cube blocks (slabs, stairs, etc.)

mod decode;
mod grid;
mod lookup;
mod mesher;
mod models;
pub mod registry;
mod types;

use wasm_bindgen::prelude::*;

// Re-export registry init functions
pub use registry::init_block_registry;
pub use models::registry::{init_state_registry, init_model_registry, init_model_registry_v2, is_hash_model_registry_initialized};

// V3: Block-name-based registry exports
pub use models::block_registry::init_block_model_registry;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

/// Initialize the WASM module (call once on startup)
#[wasm_bindgen]
pub fn init() {
    // Set up better panic messages in debug mode
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Initialize Rayon thread pool for parallel meshing
/// Only available when built with the "parallel" feature
/// Must be called before any parallel meshing operations
/// Returns a Promise that resolves when the pool is ready
#[cfg(feature = "parallel")]
#[wasm_bindgen]
pub fn init_thread_pool(num_threads: usize) -> js_sys::Promise {
    wasm_bindgen_rayon::init_thread_pool(num_threads)
}

/// Check if parallel meshing is available
#[wasm_bindgen]
pub fn is_parallel_available() -> bool {
    #[cfg(feature = "parallel")]
    { true }
    #[cfg(not(feature = "parallel"))]
    { false }
}

/// Main entry point for meshing a chunk
/// 
/// Takes serialized grid data and returns mesh buffers
/// Optional bounds limit which blocks generate geometry (neighbors used for lookups only)
#[wasm_bindgen]
pub fn mesh_chunk(
    grid_data: &[u8],
    light_data: &[u8],
    state_data: &[u8],
    lookup_ptr: *const u8,
    lookup_len: usize,
) -> MeshResult {
    mesh_chunk_with_bounds(grid_data, light_data, state_data, lookup_ptr, lookup_len, None)
}

/// Mesh chunk with explicit bounds
/// Bounds format: [min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z]
#[wasm_bindgen]
pub fn mesh_chunk_bounded(
    grid_data: &[u8],
    light_data: &[u8],
    state_data: &[u8],
    lookup_ptr: *const u8,
    lookup_len: usize,
    min_chunk_x: i32,
    min_chunk_z: i32,
    max_chunk_x: i32,
    max_chunk_z: i32,
) -> MeshResult {
    let bounds = Some(mesher::MeshBounds {
        min_chunk_x,
        min_chunk_z,
        max_chunk_x,
        max_chunk_z,
    });
    mesh_chunk_with_bounds(grid_data, light_data, state_data, lookup_ptr, lookup_len, bounds)
}

/// Mesh a single chunk in streaming mode (for deferred boundary repair)
/// NOTE: Streaming mode is deprecated - use mesh_chunk_bounded instead
#[wasm_bindgen]
pub fn mesh_chunk_streaming(
    _grid_data: &[u8],
    _light_data: &[u8],
    _chunk_x: i32,
    _chunk_z: i32,
) -> StreamingMeshResultWasm {
    // Streaming mode is no longer supported - return empty result
    StreamingMeshResultWasm::empty()
}

fn mesh_chunk_with_bounds(
    grid_data: &[u8],
    light_data: &[u8],
    state_data: &[u8],
    _lookup_ptr: *const u8,
    _lookup_len: usize,
    bounds: Option<mesher::MeshBounds>,
) -> MeshResult {
    // Import grids from serialized data
    let grid = grid::BinaryGrid::from_bytes(grid_data);
    let light_grid = if !light_data.is_empty() {
        Some(grid::LightGrid::from_bytes(light_data))
    } else {
        None
    };
    let state_grid = if !state_data.is_empty() {
        Some(grid::BlockStateGrid::from_bytes(state_data))
    } else {
        None
    };

    // Get lookup tables from static memory
    let lookups = match lookup::Lookups::get() {
        Some(l) => l,
        None => {
            // Return empty meshes if lookups not initialized
            return MeshResult {
                solid: mesher::MeshData::new(),
                water: mesher::MeshData::new(),
                lava: mesher::MeshData::new(),
                glass: mesher::MeshData::new(),
                model_opaque: models::geometry::ModelMeshData::new(),
                model_transparent: models::geometry::ModelMeshData::new(),
                model_overlay: models::geometry::ModelMeshData::new(),
            };
        }
    };

    // Run meshers with optional bounds
    let solid_result = mesher::greedy::mesh_solid_bounded(&grid, light_grid.as_ref(), &lookups, bounds.as_ref());
    let fluid_result = mesher::fluid::mesh_fluids_bounded(&grid, light_grid.as_ref(), &lookups, bounds.as_ref());
    let glass_result = mesher::greedy::mesh_glass_bounded(&grid, light_grid.as_ref(), &lookups, bounds.as_ref());
    
    // Model meshing using hash-based registry (if state grid provided and registry initialized)
    let (model_opaque, model_transparent, model_overlay) = if let Some(ref sg) = state_grid {
        if models::registry::is_hash_model_registry_initialized() {
            let model_result = models::mesher::mesh_models_bounded(&grid, sg, light_grid.as_ref(), &lookups, bounds.as_ref());
            (model_result.opaque, model_result.transparent, model_result.overlay)
        } else {
            (models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new())
        }
    } else {
        (models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new())
    };

    MeshResult {
        solid: solid_result,
        water: fluid_result.water,
        lava: fluid_result.lava,
        glass: glass_result,
        model_opaque,
        model_transparent,
        model_overlay,
    }
}

/// V3 Model meshing - uses block-name-based registry with ModelStateGrid
/// This is the preferred API for worker-based rendering
#[wasm_bindgen]
pub fn mesh_models_v3(
    grid_data: &[u8],
    light_data: &[u8],
    model_state_data: &[u8],
    min_chunk_x: i32,
    min_chunk_z: i32,
    max_chunk_x: i32,
    max_chunk_z: i32,
) -> ModelMeshResultWasm {
    // Import grids from serialized data
    let grid = grid::BinaryGrid::from_bytes(grid_data);
    let light_grid = if !light_data.is_empty() {
        Some(grid::LightGrid::from_bytes(light_data))
    } else {
        None
    };
    
    // Parse model state grid
    let model_state_grid = match grid::ModelStateGrid::from_bytes(model_state_data) {
        Ok(g) => g,
        Err(e) => {
            web_sys::console::error_1(&format!("[WASM] Failed to parse model state grid: {}", e).into());
            return ModelMeshResultWasm::empty();
        }
    };
    
    // Get lookup tables
    let lookups = match lookup::Lookups::get() {
        Some(l) => l,
        None => {
            web_sys::console::error_1(&"[WASM] Lookup tables not initialized".into());
            return ModelMeshResultWasm::empty();
        }
    };
    
    let bounds = Some(mesher::MeshBounds {
        min_chunk_x,
        min_chunk_z,
        max_chunk_x,
        max_chunk_z,
    });
    
    // Run V3 model mesher
    let result = models::mesher_v3::mesh_models_v3(
        &grid,
        &model_state_grid,
        light_grid.as_ref(),
        &lookups,
        bounds.as_ref(),
    );
    
    ModelMeshResultWasm::from_result(result)
}

/// Model mesh result for V3 API
#[wasm_bindgen]
pub struct ModelMeshResultWasm {
    opaque: models::geometry::ModelMeshData,
    transparent: models::geometry::ModelMeshData,
    overlay: models::geometry::ModelMeshData,
    beacon_positions: Vec<i32>, // Packed as [x, y, z, x, y, z, ...]
}

#[wasm_bindgen]
impl ModelMeshResultWasm {
    pub fn empty() -> Self {
        Self {
            opaque: models::geometry::ModelMeshData::new(),
            transparent: models::geometry::ModelMeshData::new(),
            overlay: models::geometry::ModelMeshData::new(),
            beacon_positions: Vec::new(),
        }
    }
    
    fn from_result(result: models::mesher::ModelMeshResult) -> Self {
        let beacon_positions: Vec<i32> = result.beacon_positions.iter()
            .flat_map(|bp| vec![bp.x, bp.y, bp.z])
            .collect();
        
        Self {
            opaque: result.opaque,
            transparent: result.transparent,
            overlay: result.overlay,
            beacon_positions,
        }
    }
    
    // Opaque mesh accessors
    pub fn opaque_positions(&self) -> Vec<f32> { self.opaque.positions.clone() }
    pub fn opaque_normals(&self) -> Vec<f32> { self.opaque.normals.clone() }
    pub fn opaque_uvs(&self) -> Vec<f32> { self.opaque.uvs.clone() }
    pub fn opaque_colors(&self) -> Vec<f32> { self.opaque.colors.clone() }
    pub fn opaque_indices(&self) -> Vec<u32> { self.opaque.indices.clone() }
    pub fn opaque_tex_indices(&self) -> Vec<f32> { self.opaque.tex_indices.clone() }
    pub fn opaque_tint_types(&self) -> Vec<f32> { self.opaque.tint_types.clone() }
    pub fn opaque_sky_light(&self) -> Vec<f32> { self.opaque.sky_light.clone() }
    pub fn opaque_block_light(&self) -> Vec<f32> { self.opaque.block_light.clone() }
    pub fn opaque_shade_flags(&self) -> Vec<f32> { self.opaque.shade_flags.clone() }
    pub fn opaque_position_count(&self) -> u32 { self.opaque.positions.len() as u32 }
    pub fn opaque_index_count(&self) -> u32 { self.opaque.indices.len() as u32 }
    pub fn opaque_vertex_count(&self) -> u32 { (self.opaque.positions.len() / 3) as u32 }
    
    // Transparent mesh accessors
    pub fn transparent_positions(&self) -> Vec<f32> { self.transparent.positions.clone() }
    pub fn transparent_normals(&self) -> Vec<f32> { self.transparent.normals.clone() }
    pub fn transparent_uvs(&self) -> Vec<f32> { self.transparent.uvs.clone() }
    pub fn transparent_colors(&self) -> Vec<f32> { self.transparent.colors.clone() }
    pub fn transparent_indices(&self) -> Vec<u32> { self.transparent.indices.clone() }
    pub fn transparent_tex_indices(&self) -> Vec<f32> { self.transparent.tex_indices.clone() }
    pub fn transparent_tint_types(&self) -> Vec<f32> { self.transparent.tint_types.clone() }
    pub fn transparent_sky_light(&self) -> Vec<f32> { self.transparent.sky_light.clone() }
    pub fn transparent_block_light(&self) -> Vec<f32> { self.transparent.block_light.clone() }
    pub fn transparent_shade_flags(&self) -> Vec<f32> { self.transparent.shade_flags.clone() }
    pub fn transparent_position_count(&self) -> u32 { self.transparent.positions.len() as u32 }
    pub fn transparent_index_count(&self) -> u32 { self.transparent.indices.len() as u32 }
    pub fn transparent_vertex_count(&self) -> u32 { (self.transparent.positions.len() / 3) as u32 }
    
    // Overlay mesh accessors
    pub fn overlay_positions(&self) -> Vec<f32> { self.overlay.positions.clone() }
    pub fn overlay_normals(&self) -> Vec<f32> { self.overlay.normals.clone() }
    pub fn overlay_uvs(&self) -> Vec<f32> { self.overlay.uvs.clone() }
    pub fn overlay_colors(&self) -> Vec<f32> { self.overlay.colors.clone() }
    pub fn overlay_indices(&self) -> Vec<u32> { self.overlay.indices.clone() }
    pub fn overlay_tex_indices(&self) -> Vec<f32> { self.overlay.tex_indices.clone() }
    pub fn overlay_tint_types(&self) -> Vec<f32> { self.overlay.tint_types.clone() }
    pub fn overlay_sky_light(&self) -> Vec<f32> { self.overlay.sky_light.clone() }
    pub fn overlay_block_light(&self) -> Vec<f32> { self.overlay.block_light.clone() }
    pub fn overlay_shade_flags(&self) -> Vec<f32> { self.overlay.shade_flags.clone() }
    pub fn overlay_position_count(&self) -> u32 { self.overlay.positions.len() as u32 }
    pub fn overlay_index_count(&self) -> u32 { self.overlay.indices.len() as u32 }
    pub fn overlay_vertex_count(&self) -> u32 { (self.overlay.positions.len() / 3) as u32 }
    
    // Beacon positions
    pub fn beacon_positions(&self) -> Vec<i32> { self.beacon_positions.clone() }
    pub fn beacon_count(&self) -> u32 { (self.beacon_positions.len() / 3) as u32 }
}

// ============================================================================
// Zero-Copy Meshing API (Phase 4: SharedArrayBuffer)
// ============================================================================

/// Metadata for zero-copy mesh result - only counts, no data copying
#[wasm_bindgen]
pub struct MeshSizes {
    // Solid mesh sizes
    pub solid_position_count: u32,
    pub solid_index_count: u32,
    pub solid_vertex_count: u32,
    // Water mesh sizes
    pub water_position_count: u32,
    pub water_index_count: u32,
    pub water_vertex_count: u32,
    // Lava mesh sizes  
    pub lava_position_count: u32,
    pub lava_index_count: u32,
    pub lava_vertex_count: u32,
    // Glass mesh sizes
    pub glass_position_count: u32,
    pub glass_index_count: u32,
    pub glass_vertex_count: u32,
    // Model opaque sizes
    pub model_opaque_position_count: u32,
    pub model_opaque_index_count: u32,
    pub model_opaque_vertex_count: u32,
    // Model transparent sizes
    pub model_transparent_position_count: u32,
    pub model_transparent_index_count: u32,
    pub model_transparent_vertex_count: u32,
}

/// Pre-compute mesh sizes before allocating buffers
#[wasm_bindgen]
pub fn compute_mesh_sizes(
    grid_data: &[u8],
    light_data: &[u8],
    state_data: &[u8],
    min_chunk_x: i32,
    min_chunk_z: i32,
    max_chunk_x: i32,
    max_chunk_z: i32,
) -> MeshSizes {
    let bounds = Some(mesher::MeshBounds {
        min_chunk_x,
        min_chunk_z,
        max_chunk_x,
        max_chunk_z,
    });
    
    // Run meshing to get sizes (we'll cache the result for write_mesh_data)
    let result = mesh_chunk_with_bounds(grid_data, light_data, state_data, std::ptr::null(), 0, bounds);
    
    // Store result in thread-local for subsequent write call
    CACHED_RESULT.with(|cache| {
        *cache.borrow_mut() = Some(result);
    });
    
    // Get sizes from cached result
    CACHED_RESULT.with(|cache| {
        let cache = cache.borrow();
        let result = cache.as_ref().unwrap();
        
        MeshSizes {
            solid_position_count: result.solid.positions.len() as u32,
            solid_index_count: result.solid.indices.len() as u32,
            solid_vertex_count: result.solid.vertex_count,
            water_position_count: result.water.positions.len() as u32,
            water_index_count: result.water.indices.len() as u32,
            water_vertex_count: result.water.vertex_count,
            lava_position_count: result.lava.positions.len() as u32,
            lava_index_count: result.lava.indices.len() as u32,
            lava_vertex_count: result.lava.vertex_count,
            glass_position_count: result.glass.positions.len() as u32,
            glass_index_count: result.glass.indices.len() as u32,
            glass_vertex_count: result.glass.vertex_count,
            model_opaque_position_count: result.model_opaque.positions.len() as u32,
            model_opaque_index_count: result.model_opaque.indices.len() as u32,
            model_opaque_vertex_count: result.model_opaque.vertex_count,
            model_transparent_position_count: result.model_transparent.positions.len() as u32,
            model_transparent_index_count: result.model_transparent.indices.len() as u32,
            model_transparent_vertex_count: result.model_transparent.vertex_count,
        }
    })
}

// Thread-local cache for mesh result between compute_mesh_sizes and write_mesh_data calls
std::thread_local! {
    static CACHED_RESULT: std::cell::RefCell<Option<MeshResult>> = std::cell::RefCell::new(None);
}

/// Write cached mesh data to pre-allocated JS typed arrays (zero-copy path)
/// Call this immediately after compute_mesh_sizes with appropriately sized arrays.
/// 
/// Buffer layout per mesh type:
/// - positions: Float32Array (vertex_count * 3)
/// - normals: Float32Array (vertex_count * 3)
/// - colors: Float32Array (vertex_count * 3)
/// - tex_indices: Float32Array (vertex_count)
/// - tex_rotations: Float32Array (vertex_count) 
/// - tint_types: Float32Array (vertex_count)
/// - packed_light: Uint8Array (vertex_count)
/// - indices: Uint32Array (index_count)
#[wasm_bindgen]
pub fn write_mesh_to_buffers(
    // Solid buffers
    solid_positions: &mut [f32],
    solid_normals: &mut [f32],
    solid_colors: &mut [f32],
    solid_tex_indices: &mut [f32],
    solid_tex_rotations: &mut [f32],
    solid_tint_types: &mut [f32],
    solid_packed_light: &mut [u8],
    solid_indices: &mut [u32],
    // Water buffers
    water_positions: &mut [f32],
    water_normals: &mut [f32],
    water_colors: &mut [f32],
    water_uvs: &mut [f32],
    water_tex_indices: &mut [f32],
    water_packed_light: &mut [u8],
    water_indices: &mut [u32],
    // Lava buffers
    lava_positions: &mut [f32],
    lava_normals: &mut [f32],
    lava_colors: &mut [f32],
    lava_uvs: &mut [f32],
    lava_tex_indices: &mut [f32],
    lava_packed_light: &mut [u8],
    lava_indices: &mut [u32],
    // Glass buffers
    glass_positions: &mut [f32],
    glass_normals: &mut [f32],
    glass_colors: &mut [f32],
    glass_tex_indices: &mut [f32],
    glass_tex_rotations: &mut [f32],
    glass_tint_types: &mut [f32],
    glass_packed_light: &mut [u8],
    glass_indices: &mut [u32],
) -> bool {
    CACHED_RESULT.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(result) = cache.take() {
            // Copy solid mesh data
            if !result.solid.positions.is_empty() {
                solid_positions[..result.solid.positions.len()].copy_from_slice(&result.solid.positions);
                solid_normals[..result.solid.normals.len()].copy_from_slice(&result.solid.normals);
                solid_colors[..result.solid.colors.len()].copy_from_slice(&result.solid.colors);
                solid_tex_indices[..result.solid.tex_indices.len()].copy_from_slice(&result.solid.tex_indices);
                solid_tex_rotations[..result.solid.tex_rotations.len()].copy_from_slice(&result.solid.tex_rotations);
                solid_tint_types[..result.solid.tint_types.len()].copy_from_slice(&result.solid.tint_types);
                solid_packed_light[..result.solid.packed_light.len()].copy_from_slice(&result.solid.packed_light);
                solid_indices[..result.solid.indices.len()].copy_from_slice(&result.solid.indices);
            }
            
            // Copy water mesh data
            if !result.water.positions.is_empty() {
                water_positions[..result.water.positions.len()].copy_from_slice(&result.water.positions);
                water_normals[..result.water.normals.len()].copy_from_slice(&result.water.normals);
                water_colors[..result.water.colors.len()].copy_from_slice(&result.water.colors);
                water_uvs[..result.water.uvs.len()].copy_from_slice(&result.water.uvs);
                water_tex_indices[..result.water.tex_indices.len()].copy_from_slice(&result.water.tex_indices);
                water_packed_light[..result.water.packed_light.len()].copy_from_slice(&result.water.packed_light);
                water_indices[..result.water.indices.len()].copy_from_slice(&result.water.indices);
            }
            
            // Copy lava mesh data
            if !result.lava.positions.is_empty() {
                lava_positions[..result.lava.positions.len()].copy_from_slice(&result.lava.positions);
                lava_normals[..result.lava.normals.len()].copy_from_slice(&result.lava.normals);
                lava_colors[..result.lava.colors.len()].copy_from_slice(&result.lava.colors);
                lava_uvs[..result.lava.uvs.len()].copy_from_slice(&result.lava.uvs);
                lava_tex_indices[..result.lava.tex_indices.len()].copy_from_slice(&result.lava.tex_indices);
                lava_packed_light[..result.lava.packed_light.len()].copy_from_slice(&result.lava.packed_light);
                lava_indices[..result.lava.indices.len()].copy_from_slice(&result.lava.indices);
            }
            
            // Copy glass mesh data
            if !result.glass.positions.is_empty() {
                glass_positions[..result.glass.positions.len()].copy_from_slice(&result.glass.positions);
                glass_normals[..result.glass.normals.len()].copy_from_slice(&result.glass.normals);
                glass_colors[..result.glass.colors.len()].copy_from_slice(&result.glass.colors);
                glass_tex_indices[..result.glass.tex_indices.len()].copy_from_slice(&result.glass.tex_indices);
                glass_tex_rotations[..result.glass.tex_rotations.len()].copy_from_slice(&result.glass.tex_rotations);
                glass_tint_types[..result.glass.tint_types.len()].copy_from_slice(&result.glass.tint_types);
                glass_packed_light[..result.glass.packed_light.len()].copy_from_slice(&result.glass.packed_light);
                glass_indices[..result.glass.indices.len()].copy_from_slice(&result.glass.indices);
            }
            
            true
        } else {
            false
        }
    })
}

/// Write model mesh data to pre-allocated buffers
#[wasm_bindgen]
pub fn write_model_mesh_to_buffers(
    // Opaque model buffers
    opaque_positions: &mut [f32],
    opaque_normals: &mut [f32],
    opaque_colors: &mut [f32],
    opaque_uvs: &mut [f32],
    opaque_tex_indices: &mut [f32],
    opaque_packed_light: &mut [u8],
    opaque_indices: &mut [u32],
    // Transparent model buffers
    transparent_positions: &mut [f32],
    transparent_normals: &mut [f32],
    transparent_colors: &mut [f32],
    transparent_uvs: &mut [f32],
    transparent_tex_indices: &mut [f32],
    transparent_packed_light: &mut [u8],
    transparent_indices: &mut [u32],
) -> bool {
    // Model data is written during the main write_mesh_to_buffers call
    // This is a placeholder for future model-specific zero-copy path
    CACHED_RESULT.with(|cache| {
        let cache = cache.borrow();
        if let Some(result) = cache.as_ref() {
            // Copy opaque model mesh data
            if !result.model_opaque.positions.is_empty() {
                opaque_positions[..result.model_opaque.positions.len()].copy_from_slice(&result.model_opaque.positions);
                opaque_normals[..result.model_opaque.normals.len()].copy_from_slice(&result.model_opaque.normals);
                opaque_colors[..result.model_opaque.colors.len()].copy_from_slice(&result.model_opaque.colors);
                opaque_uvs[..result.model_opaque.uvs.len()].copy_from_slice(&result.model_opaque.uvs);
                opaque_tex_indices[..result.model_opaque.tex_indices.len()].copy_from_slice(&result.model_opaque.tex_indices);
                opaque_packed_light[..result.model_opaque.packed_light.len()].copy_from_slice(&result.model_opaque.packed_light);
                opaque_indices[..result.model_opaque.indices.len()].copy_from_slice(&result.model_opaque.indices);
            }
            
            // Copy transparent model mesh data
            if !result.model_transparent.positions.is_empty() {
                transparent_positions[..result.model_transparent.positions.len()].copy_from_slice(&result.model_transparent.positions);
                transparent_normals[..result.model_transparent.normals.len()].copy_from_slice(&result.model_transparent.normals);
                transparent_colors[..result.model_transparent.colors.len()].copy_from_slice(&result.model_transparent.colors);
                transparent_uvs[..result.model_transparent.uvs.len()].copy_from_slice(&result.model_transparent.uvs);
                transparent_tex_indices[..result.model_transparent.tex_indices.len()].copy_from_slice(&result.model_transparent.tex_indices);
                transparent_packed_light[..result.model_transparent.packed_light.len()].copy_from_slice(&result.model_transparent.packed_light);
                transparent_indices[..result.model_transparent.indices.len()].copy_from_slice(&result.model_transparent.indices);
            }
            
            true
        } else {
            false
        }
    })
}

/// Clear the cached mesh result (call if you don't need to write it)
#[wasm_bindgen]
pub fn clear_cached_result() {
    CACHED_RESULT.with(|cache| {
        *cache.borrow_mut() = None;
    });
}

// ============================================================================
// Streaming Mode Result
// ============================================================================

/// Result from streaming mesh - includes boundary face info
#[wasm_bindgen]
pub struct StreamingMeshResultWasm {
    mesh: mesher::MeshData,
    boundary_neg_x_count: u32,
    boundary_pos_x_count: u32,
    boundary_neg_z_count: u32,
    boundary_pos_z_count: u32,
}

impl StreamingMeshResultWasm {
    pub fn empty() -> Self {
        Self {
            mesh: mesher::MeshData::new(),
            boundary_neg_x_count: 0,
            boundary_pos_x_count: 0,
            boundary_neg_z_count: 0,
            boundary_pos_z_count: 0,
        }
    }
    
}

#[wasm_bindgen]
impl StreamingMeshResultWasm {
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Vec<f32> { self.mesh.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn normals(&self) -> Vec<f32> { self.mesh.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn colors(&self) -> Vec<f32> { self.mesh.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn tex_indices(&self) -> Vec<f32> { self.mesh.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn tex_rotations(&self) -> Vec<f32> { self.mesh.tex_rotations.clone() }
    #[wasm_bindgen(getter)]
    pub fn tint_types(&self) -> Vec<f32> { self.mesh.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn packed_light(&self) -> Vec<u8> { self.mesh.packed_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u32> { self.mesh.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn vertex_count(&self) -> u32 { self.mesh.vertex_count }
    #[wasm_bindgen(getter)]
    pub fn boundary_neg_x_count(&self) -> u32 { self.boundary_neg_x_count }
    #[wasm_bindgen(getter)]
    pub fn boundary_pos_x_count(&self) -> u32 { self.boundary_pos_x_count }
    #[wasm_bindgen(getter)]
    pub fn boundary_neg_z_count(&self) -> u32 { self.boundary_neg_z_count }
    #[wasm_bindgen(getter)]
    pub fn boundary_pos_z_count(&self) -> u32 { self.boundary_pos_z_count }
}

/// Result containing all mesh buffers
#[wasm_bindgen]
pub struct MeshResult {
    solid: mesher::MeshData,
    water: mesher::MeshData,
    lava: mesher::MeshData,
    glass: mesher::MeshData,
    // Model meshes
    model_opaque: models::geometry::ModelMeshData,
    model_transparent: models::geometry::ModelMeshData,
    model_overlay: models::geometry::ModelMeshData,
}

#[wasm_bindgen]
impl MeshResult {
    /// Get solid mesh positions as Float32Array
    #[wasm_bindgen(getter)]
    pub fn solid_positions(&self) -> Vec<f32> {
        self.solid.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_normals(&self) -> Vec<f32> {
        self.solid.normals.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_colors(&self) -> Vec<f32> {
        self.solid.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_tex_indices(&self) -> Vec<f32> {
        self.solid.tex_indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_tex_rotations(&self) -> Vec<f32> {
        self.solid.tex_rotations.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_tint_types(&self) -> Vec<f32> {
        self.solid.tint_types.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_sky_light(&self) -> Vec<f32> {
        self.solid.sky_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_block_light(&self) -> Vec<f32> {
        self.solid.block_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_packed_light(&self) -> Vec<u8> {
        self.solid.packed_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_indices(&self) -> Vec<u32> {
        self.solid.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_vertex_count(&self) -> u32 {
        self.solid.vertex_count
    }

    // Water getters
    #[wasm_bindgen(getter)]
    pub fn water_positions(&self) -> Vec<f32> {
        self.water.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_normals(&self) -> Vec<f32> {
        self.water.normals.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_colors(&self) -> Vec<f32> {
        self.water.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_uvs(&self) -> Vec<f32> {
        self.water.uvs.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_tex_indices(&self) -> Vec<f32> {
        self.water.tex_indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_sky_light(&self) -> Vec<f32> {
        self.water.sky_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_block_light(&self) -> Vec<f32> {
        self.water.block_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_packed_light(&self) -> Vec<u8> {
        self.water.packed_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_indices(&self) -> Vec<u32> {
        self.water.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn water_vertex_count(&self) -> u32 {
        self.water.vertex_count
    }

    // Lava getters
    #[wasm_bindgen(getter)]
    pub fn lava_positions(&self) -> Vec<f32> {
        self.lava.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_normals(&self) -> Vec<f32> {
        self.lava.normals.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_colors(&self) -> Vec<f32> {
        self.lava.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_uvs(&self) -> Vec<f32> {
        self.lava.uvs.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_tex_indices(&self) -> Vec<f32> {
        self.lava.tex_indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_sky_light(&self) -> Vec<f32> {
        self.lava.sky_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_block_light(&self) -> Vec<f32> {
        self.lava.block_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_packed_light(&self) -> Vec<u8> {
        self.lava.packed_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_indices(&self) -> Vec<u32> {
        self.lava.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_vertex_count(&self) -> u32 {
        self.lava.vertex_count
    }

    // Glass getters
    #[wasm_bindgen(getter)]
    pub fn glass_positions(&self) -> Vec<f32> {
        self.glass.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_normals(&self) -> Vec<f32> {
        self.glass.normals.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_colors(&self) -> Vec<f32> {
        self.glass.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_tex_indices(&self) -> Vec<f32> {
        self.glass.tex_indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_tex_rotations(&self) -> Vec<f32> {
        self.glass.tex_rotations.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_tint_types(&self) -> Vec<f32> {
        self.glass.tint_types.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_sky_light(&self) -> Vec<f32> {
        self.glass.sky_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_block_light(&self) -> Vec<f32> {
        self.glass.block_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_packed_light(&self) -> Vec<u8> {
        self.glass.packed_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_indices(&self) -> Vec<u32> {
        self.glass.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_vertex_count(&self) -> u32 {
        self.glass.vertex_count
    }

    // Model opaque getters
    #[wasm_bindgen(getter)]
    pub fn model_opaque_positions(&self) -> Vec<f32> {
        self.model_opaque.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_normals(&self) -> Vec<f32> {
        self.model_opaque.normals.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_colors(&self) -> Vec<f32> {
        self.model_opaque.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_uvs(&self) -> Vec<f32> {
        self.model_opaque.uvs.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_tex_indices(&self) -> Vec<f32> {
        self.model_opaque.tex_indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_tint_types(&self) -> Vec<f32> {
        self.model_opaque.tint_types.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_sky_light(&self) -> Vec<f32> {
        self.model_opaque.sky_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_block_light(&self) -> Vec<f32> {
        self.model_opaque.block_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_packed_light(&self) -> Vec<u8> {
        self.model_opaque.packed_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_indices(&self) -> Vec<u32> {
        self.model_opaque.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_vertex_count(&self) -> u32 {
        self.model_opaque.vertex_count
    }

    // Model transparent getters
    #[wasm_bindgen(getter)]
    pub fn model_transparent_positions(&self) -> Vec<f32> {
        self.model_transparent.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_normals(&self) -> Vec<f32> {
        self.model_transparent.normals.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_colors(&self) -> Vec<f32> {
        self.model_transparent.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_uvs(&self) -> Vec<f32> {
        self.model_transparent.uvs.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_tex_indices(&self) -> Vec<f32> {
        self.model_transparent.tex_indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_tint_types(&self) -> Vec<f32> {
        self.model_transparent.tint_types.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_sky_light(&self) -> Vec<f32> {
        self.model_transparent.sky_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_block_light(&self) -> Vec<f32> {
        self.model_transparent.block_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_packed_light(&self) -> Vec<u8> {
        self.model_transparent.packed_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_indices(&self) -> Vec<u32> {
        self.model_transparent.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_vertex_count(&self) -> u32 {
        self.model_transparent.vertex_count
    }

    // Model overlay getters
    #[wasm_bindgen(getter)]
    pub fn model_overlay_positions(&self) -> Vec<f32> {
        self.model_overlay.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_normals(&self) -> Vec<f32> {
        self.model_overlay.normals.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_colors(&self) -> Vec<f32> {
        self.model_overlay.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_uvs(&self) -> Vec<f32> {
        self.model_overlay.uvs.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_tex_indices(&self) -> Vec<f32> {
        self.model_overlay.tex_indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_tint_types(&self) -> Vec<f32> {
        self.model_overlay.tint_types.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_sky_light(&self) -> Vec<f32> {
        self.model_overlay.sky_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_block_light(&self) -> Vec<f32> {
        self.model_overlay.block_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_packed_light(&self) -> Vec<u8> {
        self.model_overlay.packed_light.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_indices(&self) -> Vec<u32> {
        self.model_overlay.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_vertex_count(&self) -> u32 {
        self.model_overlay.vertex_count
    }
}

/// Initialize lookup tables from JS
/// Call this once after loading with block registry data
#[wasm_bindgen]
pub fn init_lookups(
    is_opaque: &[u8],
    is_non_cube: &[u8],
    is_slab: &[u8],
    is_fluid: &[u8],
    is_glass: &[u8],
    is_ao_transparent: &[u8],
    is_rotatable: &[u8],
    is_directional: &[u8],
    color_r: &[f32],
    color_g: &[f32],
    color_b: &[f32],
    face_tint_types: &[u8],
    texture_indices: &[f32],
    water_still_idx: f32,
    water_flow_idx: f32,
    lava_still_idx: f32,
    lava_flow_idx: f32,
) -> *const u8 {
    lookup::init_lookups(
        is_opaque,
        is_non_cube,
        is_slab,
        is_fluid,
        is_glass,
        is_ao_transparent,
        is_rotatable,
        is_directional,
        color_r,
        color_g,
        color_b,
        face_tint_types,
        texture_indices,
        water_still_idx,
        water_flow_idx,
        lava_still_idx,
        lava_flow_idx,
    )
}

// =============================================================================
// UNIFIED PIPELINE - Process compressed chunk directly to mesh
// =============================================================================

/// Process a compressed chunk directly to mesh buffers
/// 
/// This is the unified pipeline entry point that handles:
/// 1. Decompression (zlib/gzip)
/// 2. NBT parsing
/// 3. Chunk decoding to grids
/// 4. Greedy meshing
/// 
/// # Arguments
/// * `compressed_data` - Raw compressed chunk data from region file
/// * `compression_type` - Compression type: 1=gzip, 2=zlib, 3=uncompressed
/// * `chunk_x` - Chunk X coordinate in world space
/// * `chunk_z` - Chunk Z coordinate in world space
/// 
/// # Returns
/// ProcessedChunk containing mesh buffers and metadata
#[wasm_bindgen]
pub fn process_chunk(
    compressed_data: &[u8],
    compression_type: u8,
    chunk_x: i32,
    chunk_z: i32,
) -> ProcessedChunk {
    // Check prerequisites
    if !registry::is_initialized() {
        return ProcessedChunk::error("Block registry not initialized");
    }
    
    let lookups = match lookup::Lookups::get() {
        Some(l) => l,
        None => return ProcessedChunk::error("Lookup tables not initialized"),
    };
    
    // 1. Decompress
    let compression = match decode::CompressionType::from_u8(compression_type) {
        Some(c) => c,
        None => return ProcessedChunk::error(&format!("Unknown compression type: {}", compression_type)),
    };
    
    let decompressed = match decode::decompress(compressed_data, compression) {
        Ok(d) => d,
        Err(e) => return ProcessedChunk::error(&format!("Decompression failed: {}", e)),
    };
    
    // 2. Parse NBT
    let chunk_data = match decode::parse_nbt(&decompressed) {
        Ok(c) => c,
        Err(e) => return ProcessedChunk::error(&format!("NBT parsing failed: {}", e)),
    };
    
    // 3. Decode to grids (with state grid for model blocks)
    let (blocks_decoded, grid, light_grid, state_grid) = decode::decode_chunk_with_states(&chunk_data, chunk_x, chunk_z);
    
    // 4. Create bounds for single chunk
    let bounds = Some(mesher::MeshBounds {
        min_chunk_x: chunk_x,
        min_chunk_z: chunk_z,
        max_chunk_x: chunk_x,
        max_chunk_z: chunk_z,
    });
    
    // 5. Mesh solids, fluids, glass
    let light_ref = if light_grid.is_empty() { None } else { Some(&light_grid) };
    let solid_result = mesher::greedy::mesh_solid_bounded(&grid, light_ref, &lookups, bounds.as_ref());
    let fluid_result = mesher::fluid::mesh_fluids_bounded(&grid, light_ref, &lookups, bounds.as_ref());
    let glass_result = mesher::greedy::mesh_glass_bounded(&grid, light_ref, &lookups, bounds.as_ref());
    
    // 6. Mesh model blocks
    let model_result = models::mesher::mesh_models_bounded(&grid, &state_grid, light_ref, &lookups, bounds.as_ref());
    
    // 7. Collect particle emitters from the grid
    let particle_emitters = collect_particle_emitters(&grid, &lookups, bounds.as_ref());
    
    ProcessedChunk {
        success: true,
        error_message: String::new(),
        blocks_decoded,
        chunk_x,
        chunk_z,
        mesh: MeshResult {
            solid: solid_result,
            water: fluid_result.water,
            lava: fluid_result.lava,
            glass: glass_result,
            model_opaque: model_result.opaque,
            model_transparent: model_result.transparent,
            model_overlay: model_result.overlay,
        },
        particle_emitters,
    }
}

/// Collect particle emitter positions from the grid
fn collect_particle_emitters(
    grid: &grid::BinaryGrid,
    lookups: &lookup::Lookups,
    bounds: Option<&mesher::MeshBounds>,
) -> Vec<ParticleEmitterData> {
    let mut emitters = Vec::new();
    
    for (key, section) in grid.iter_sections() {
        // Check bounds
        if let Some(b) = bounds {
            if key.chunk_x < b.min_chunk_x || key.chunk_x > b.max_chunk_x ||
               key.chunk_z < b.min_chunk_z || key.chunk_z > b.max_chunk_z {
                continue;
            }
        }
        
        let base_x = key.chunk_x * 16;
        let base_y = key.section_y * 16 - 64;
        let base_z = key.chunk_z * 16;
        
        for local_y in 0..16 {
            for local_z in 0..16 {
                for local_x in 0..16 {
                    let idx = local_y * 256 + local_z * 16 + local_x;
                    let block_value = section[idx];
                    let block_id = (block_value & 0x0FFF) as u16;
                    
                    if block_id == 0 { continue; }
                    
                    // Check if this is a particle emitting block
                    if lookups.is_particle_emitter(block_id) {
                        emitters.push(ParticleEmitterData {
                            block_id,
                            x: base_x + local_x as i32,
                            y: base_y + local_y as i32,
                            z: base_z + local_z as i32,
                        });
                    }
                }
            }
        }
    }
    
    emitters
}

/// Particle emitter data
#[derive(Clone)]
pub struct ParticleEmitterData {
    pub block_id: u16,
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// Result of processing a compressed chunk
#[wasm_bindgen]
pub struct ProcessedChunk {
    success: bool,
    error_message: String,
    blocks_decoded: u32,
    chunk_x: i32,
    chunk_z: i32,
    mesh: MeshResult,
    particle_emitters: Vec<ParticleEmitterData>,
}

impl ProcessedChunk {
    fn error(msg: &str) -> Self {
        Self {
            success: false,
            error_message: msg.to_string(),
            blocks_decoded: 0,
            chunk_x: 0,
            chunk_z: 0,
            mesh: MeshResult {
                solid: mesher::MeshData::new(),
                water: mesher::MeshData::new(),
                lava: mesher::MeshData::new(),
                glass: mesher::MeshData::new(),
                model_opaque: models::geometry::ModelMeshData::new(),
                model_transparent: models::geometry::ModelMeshData::new(),
                model_overlay: models::geometry::ModelMeshData::new(),
            },
            particle_emitters: Vec::new(),
        }
    }
}

#[wasm_bindgen]
impl ProcessedChunk {
    /// Check if processing was successful
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool {
        self.success
    }
    
    /// Get error message if processing failed
    #[wasm_bindgen(getter)]
    pub fn error_message(&self) -> String {
        self.error_message.clone()
    }
    
    /// Number of non-air blocks decoded
    #[wasm_bindgen(getter)]
    pub fn blocks_decoded(&self) -> u32 {
        self.blocks_decoded
    }
    
    /// Chunk X coordinate
    #[wasm_bindgen(getter)]
    pub fn chunk_x(&self) -> i32 {
        self.chunk_x
    }
    
    /// Chunk Z coordinate
    #[wasm_bindgen(getter)]
    pub fn chunk_z(&self) -> i32 {
        self.chunk_z
    }
    
    // Delegate mesh getters to inner MeshResult
    #[wasm_bindgen(getter)]
    pub fn solid_positions(&self) -> Vec<f32> {
        self.mesh.solid_positions()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_normals(&self) -> Vec<f32> {
        self.mesh.solid_normals()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_colors(&self) -> Vec<f32> {
        self.mesh.solid_colors()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_tex_indices(&self) -> Vec<f32> {
        self.mesh.solid_tex_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_tex_rotations(&self) -> Vec<f32> {
        self.mesh.solid_tex_rotations()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_tint_types(&self) -> Vec<f32> {
        self.mesh.solid_tint_types()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_sky_light(&self) -> Vec<f32> {
        self.mesh.solid_sky_light()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_block_light(&self) -> Vec<f32> {
        self.mesh.solid_block_light()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_packed_light(&self) -> Vec<u8> {
        self.mesh.solid_packed_light()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_indices(&self) -> Vec<u32> {
        self.mesh.solid_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn solid_vertex_count(&self) -> u32 {
        self.mesh.solid_vertex_count()
    }

    #[wasm_bindgen(getter)]
    pub fn water_positions(&self) -> Vec<f32> {
        self.mesh.water_positions()
    }

    #[wasm_bindgen(getter)]
    pub fn water_normals(&self) -> Vec<f32> {
        self.mesh.water_normals()
    }

    #[wasm_bindgen(getter)]
    pub fn water_colors(&self) -> Vec<f32> {
        self.mesh.water_colors()
    }

    #[wasm_bindgen(getter)]
    pub fn water_uvs(&self) -> Vec<f32> {
        self.mesh.water_uvs()
    }

    #[wasm_bindgen(getter)]
    pub fn water_tex_indices(&self) -> Vec<f32> {
        self.mesh.water_tex_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn water_sky_light(&self) -> Vec<f32> {
        self.mesh.water_sky_light()
    }

    #[wasm_bindgen(getter)]
    pub fn water_block_light(&self) -> Vec<f32> {
        self.mesh.water_block_light()
    }

    #[wasm_bindgen(getter)]
    pub fn water_packed_light(&self) -> Vec<u8> {
        self.mesh.water_packed_light()
    }

    #[wasm_bindgen(getter)]
    pub fn water_indices(&self) -> Vec<u32> {
        self.mesh.water_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn water_vertex_count(&self) -> u32 {
        self.mesh.water_vertex_count()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_positions(&self) -> Vec<f32> {
        self.mesh.lava_positions()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_normals(&self) -> Vec<f32> {
        self.mesh.lava_normals()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_colors(&self) -> Vec<f32> {
        self.mesh.lava_colors()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_uvs(&self) -> Vec<f32> {
        self.mesh.lava_uvs()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_tex_indices(&self) -> Vec<f32> {
        self.mesh.lava_tex_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_sky_light(&self) -> Vec<f32> {
        self.mesh.lava_sky_light()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_block_light(&self) -> Vec<f32> {
        self.mesh.lava_block_light()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_packed_light(&self) -> Vec<u8> {
        self.mesh.lava_packed_light()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_indices(&self) -> Vec<u32> {
        self.mesh.lava_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn lava_vertex_count(&self) -> u32 {
        self.mesh.lava_vertex_count()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_positions(&self) -> Vec<f32> {
        self.mesh.glass_positions()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_normals(&self) -> Vec<f32> {
        self.mesh.glass_normals()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_colors(&self) -> Vec<f32> {
        self.mesh.glass_colors()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_tex_indices(&self) -> Vec<f32> {
        self.mesh.glass_tex_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_tex_rotations(&self) -> Vec<f32> {
        self.mesh.glass_tex_rotations()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_tint_types(&self) -> Vec<f32> {
        self.mesh.glass_tint_types()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_sky_light(&self) -> Vec<f32> {
        self.mesh.glass_sky_light()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_block_light(&self) -> Vec<f32> {
        self.mesh.glass_block_light()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_packed_light(&self) -> Vec<u8> {
        self.mesh.glass_packed_light()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_indices(&self) -> Vec<u32> {
        self.mesh.glass_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_vertex_count(&self) -> u32 {
        self.mesh.glass_vertex_count()
    }

    // Model opaque getters
    #[wasm_bindgen(getter)]
    pub fn model_opaque_positions(&self) -> Vec<f32> {
        self.mesh.model_opaque_positions()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_normals(&self) -> Vec<f32> {
        self.mesh.model_opaque_normals()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_colors(&self) -> Vec<f32> {
        self.mesh.model_opaque_colors()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_uvs(&self) -> Vec<f32> {
        self.mesh.model_opaque_uvs()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_tex_indices(&self) -> Vec<f32> {
        self.mesh.model_opaque_tex_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_tint_types(&self) -> Vec<f32> {
        self.mesh.model_opaque_tint_types()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_sky_light(&self) -> Vec<f32> {
        self.mesh.model_opaque_sky_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_block_light(&self) -> Vec<f32> {
        self.mesh.model_opaque_block_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_packed_light(&self) -> Vec<u8> {
        self.mesh.model_opaque_packed_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_indices(&self) -> Vec<u32> {
        self.mesh.model_opaque_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn model_opaque_vertex_count(&self) -> u32 {
        self.mesh.model_opaque_vertex_count()
    }

    // Model transparent getters
    #[wasm_bindgen(getter)]
    pub fn model_transparent_positions(&self) -> Vec<f32> {
        self.mesh.model_transparent_positions()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_normals(&self) -> Vec<f32> {
        self.mesh.model_transparent_normals()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_colors(&self) -> Vec<f32> {
        self.mesh.model_transparent_colors()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_uvs(&self) -> Vec<f32> {
        self.mesh.model_transparent_uvs()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_tex_indices(&self) -> Vec<f32> {
        self.mesh.model_transparent_tex_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_tint_types(&self) -> Vec<f32> {
        self.mesh.model_transparent_tint_types()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_sky_light(&self) -> Vec<f32> {
        self.mesh.model_transparent_sky_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_block_light(&self) -> Vec<f32> {
        self.mesh.model_transparent_block_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_packed_light(&self) -> Vec<u8> {
        self.mesh.model_transparent_packed_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_indices(&self) -> Vec<u32> {
        self.mesh.model_transparent_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn model_transparent_vertex_count(&self) -> u32 {
        self.mesh.model_transparent_vertex_count()
    }

    // Model overlay getters
    #[wasm_bindgen(getter)]
    pub fn model_overlay_positions(&self) -> Vec<f32> {
        self.mesh.model_overlay_positions()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_normals(&self) -> Vec<f32> {
        self.mesh.model_overlay_normals()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_colors(&self) -> Vec<f32> {
        self.mesh.model_overlay_colors()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_uvs(&self) -> Vec<f32> {
        self.mesh.model_overlay_uvs()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_tex_indices(&self) -> Vec<f32> {
        self.mesh.model_overlay_tex_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_tint_types(&self) -> Vec<f32> {
        self.mesh.model_overlay_tint_types()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_sky_light(&self) -> Vec<f32> {
        self.mesh.model_overlay_sky_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_block_light(&self) -> Vec<f32> {
        self.mesh.model_overlay_block_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_packed_light(&self) -> Vec<u8> {
        self.mesh.model_overlay_packed_light()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_indices(&self) -> Vec<u32> {
        self.mesh.model_overlay_indices()
    }

    #[wasm_bindgen(getter)]
    pub fn model_overlay_vertex_count(&self) -> u32 {
        self.mesh.model_overlay_vertex_count()
    }

    // Particle emitter getters
    #[wasm_bindgen(getter)]
    pub fn particle_emitter_count(&self) -> u32 {
        self.particle_emitters.len() as u32
    }

    /// Get particle emitter data as flat array: [block_id, x, y, z, ...]
    #[wasm_bindgen(getter)]
    pub fn particle_emitters(&self) -> Vec<i32> {
        let mut result = Vec::with_capacity(self.particle_emitters.len() * 4);
        for emitter in &self.particle_emitters {
            result.push(emitter.block_id as i32);
            result.push(emitter.x);
            result.push(emitter.y);
            result.push(emitter.z);
        }
        result
    }
}

// ============================================================================
// FUSED PIPELINE - Process compressed chunk to mesh in one WASM call
// ============================================================================

/// Process a compressed chunk directly to mesh data
/// 
/// This eliminates JS↔WASM boundary crossings by doing:
/// 1. Decompression (zlib/gzip)
/// 2. NBT parsing
/// 3. Chunk decoding to grids
/// 4. Meshing (solid, fluid, glass, models)
/// 
/// All in a single WASM function call.
/// 
/// compression_type: 1=gzip, 2=zlib, 3=uncompressed
#[wasm_bindgen]
pub fn process_chunk_complete(
    compressed_data: &[u8],
    compression_type: u8,
    chunk_x: i32,
    chunk_z: i32,
) -> FusedChunkResult {
    // Step 1: Decompress
    let comp_type = match decode::CompressionType::from_u8(compression_type) {
        Some(ct) => ct,
        None => return FusedChunkResult::error("Invalid compression type"),
    };
    
    let decompressed = match decode::decompress(compressed_data, comp_type) {
        Ok(data) => data,
        Err(e) => return FusedChunkResult::error(&format!("Decompression failed: {}", e)),
    };
    
    // Step 2: Parse NBT
    let chunk_data = match decode::parse_nbt(&decompressed) {
        Ok(data) => data,
        Err(e) => return FusedChunkResult::error(&format!("NBT parse failed: {}", e)),
    };
    
    // Step 3: Decode chunk to grids
    let (blocks_decoded, grid, light_grid, state_grid) = 
        decode::decode_chunk_with_states(&chunk_data, chunk_x, chunk_z);
    
    // Step 4: Get lookups
    let lookups = match lookup::Lookups::get() {
        Some(l) => l,
        None => return FusedChunkResult::error("Lookups not initialized"),
    };
    
    // Create bounds for single chunk
    let bounds = Some(mesher::MeshBounds {
        min_chunk_x: chunk_x,
        min_chunk_z: chunk_z,
        max_chunk_x: chunk_x,
        max_chunk_z: chunk_z,
    });
    
    // Step 5: Run all meshers
    let solid_result = mesher::greedy::mesh_solid_bounded(&grid, Some(&light_grid), &lookups, bounds.as_ref());
    let fluid_result = mesher::fluid::mesh_fluids_bounded(&grid, Some(&light_grid), &lookups, bounds.as_ref());
    let glass_result = mesher::greedy::mesh_glass_bounded(&grid, Some(&light_grid), &lookups, bounds.as_ref());
    
    // Model meshing
    let (model_opaque, model_transparent, model_overlay) = if models::registry::is_hash_model_registry_initialized() {
        let model_result = models::mesher::mesh_models_bounded(&grid, &state_grid, Some(&light_grid), &lookups, bounds.as_ref());
        (model_result.opaque, model_result.transparent, model_result.overlay)
    } else {
        (models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new())
    };
    
    FusedChunkResult {
        success: true,
        error_message: String::new(),
        blocks_decoded,
        chunk_x,
        chunk_z,
        solid: solid_result,
        water: fluid_result.water,
        lava: fluid_result.lava,
        glass: glass_result,
        model_opaque,
        model_transparent,
        model_overlay,
    }
}

/// Process multiple compressed chunks for a super-chunk in a single call
/// 
/// This is the ultimate fused pipeline - processes 4 chunks together
/// with proper neighbor handling for greedy meshing.
/// 
/// Input format: chunks as Vec of (compressed_data, compression_type, chunk_x, chunk_z)
#[wasm_bindgen]
pub fn process_super_chunk_complete(
    chunk_data_flat: &[u8],
    chunk_count: usize,
) -> FusedSuperChunkResult {
    // Parse the flat data format:
    // For each chunk: [4 bytes len][compressed_data...][1 byte compression][4 bytes x][4 bytes z]
    let mut offset = 0;
    let mut grids = Vec::with_capacity(chunk_count);
    let mut light_grids = Vec::with_capacity(chunk_count);
    let mut state_grids = Vec::with_capacity(chunk_count);
    let mut chunk_coords = Vec::with_capacity(chunk_count);
    let mut total_blocks = 0u32;
    
    for _ in 0..chunk_count {
        if offset + 4 > chunk_data_flat.len() {
            return FusedSuperChunkResult::error("Invalid chunk data format: truncated length");
        }
        
        // Read length (little-endian)
        let len = u32::from_le_bytes([
            chunk_data_flat[offset],
            chunk_data_flat[offset + 1],
            chunk_data_flat[offset + 2],
            chunk_data_flat[offset + 3],
        ]) as usize;
        offset += 4;
        
        if offset + len + 9 > chunk_data_flat.len() {
            return FusedSuperChunkResult::error("Invalid chunk data format: truncated data");
        }
        
        let compressed = &chunk_data_flat[offset..offset + len];
        offset += len;
        
        let compression_type = chunk_data_flat[offset];
        offset += 1;
        
        let chunk_x = i32::from_le_bytes([
            chunk_data_flat[offset],
            chunk_data_flat[offset + 1],
            chunk_data_flat[offset + 2],
            chunk_data_flat[offset + 3],
        ]);
        offset += 4;
        
        let chunk_z = i32::from_le_bytes([
            chunk_data_flat[offset],
            chunk_data_flat[offset + 1],
            chunk_data_flat[offset + 2],
            chunk_data_flat[offset + 3],
        ]);
        offset += 4;
        
        // Decompress
        let comp_type = match decode::CompressionType::from_u8(compression_type) {
            Some(ct) => ct,
            None => return FusedSuperChunkResult::error("Invalid compression type"),
        };
        
        let decompressed = match decode::decompress(compressed, comp_type) {
            Ok(data) => data,
            Err(e) => return FusedSuperChunkResult::error(&format!("Decompression failed: {}", e)),
        };
        
        // Parse NBT
        let chunk_nbt = match decode::parse_nbt(&decompressed) {
            Ok(data) => data,
            Err(e) => return FusedSuperChunkResult::error(&format!("NBT parse failed: {}", e)),
        };
        
        // Decode to grids
        let (blocks, grid, light_grid, state_grid) = 
            decode::decode_chunk_with_states(&chunk_nbt, chunk_x, chunk_z);
        
        total_blocks += blocks;
        grids.push(grid);
        light_grids.push(light_grid);
        state_grids.push(state_grid);
        chunk_coords.push((chunk_x, chunk_z));
    }
    
    // Merge grids
    let mut merged_grid = grid::BinaryGrid::new();
    let mut merged_light = grid::LightGrid::new();
    let mut merged_state = grid::BlockStateGrid::new();
    
    for (i, grid) in grids.into_iter().enumerate() {
        merged_grid.merge_from(&grid);
        merged_light.merge_from(&light_grids[i]);
        merged_state.merge_from(&state_grids[i]);
    }
    
    // Calculate bounds from chunk coords
    let min_x = chunk_coords.iter().map(|(x, _)| *x).min().unwrap_or(0);
    let max_x = chunk_coords.iter().map(|(x, _)| *x).max().unwrap_or(0);
    let min_z = chunk_coords.iter().map(|(_, z)| *z).min().unwrap_or(0);
    let max_z = chunk_coords.iter().map(|(_, z)| *z).max().unwrap_or(0);
    
    let bounds = Some(mesher::MeshBounds {
        min_chunk_x: min_x,
        min_chunk_z: min_z,
        max_chunk_x: max_x,
        max_chunk_z: max_z,
    });
    
    // Get lookups
    let lookups = match lookup::Lookups::get() {
        Some(l) => l,
        None => return FusedSuperChunkResult::error("Lookups not initialized"),
    };
    
    // Run meshers
    let solid_result = mesher::greedy::mesh_solid_bounded(&merged_grid, Some(&merged_light), &lookups, bounds.as_ref());
    let fluid_result = mesher::fluid::mesh_fluids_bounded(&merged_grid, Some(&merged_light), &lookups, bounds.as_ref());
    let glass_result = mesher::greedy::mesh_glass_bounded(&merged_grid, Some(&merged_light), &lookups, bounds.as_ref());
    
    let (model_opaque, model_transparent, model_overlay) = if models::registry::is_hash_model_registry_initialized() {
        let model_result = models::mesher::mesh_models_bounded(&merged_grid, &merged_state, Some(&merged_light), &lookups, bounds.as_ref());
        (model_result.opaque, model_result.transparent, model_result.overlay)
    } else {
        (models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new())
    };
    
    FusedSuperChunkResult {
        success: true,
        error_message: String::new(),
        blocks_decoded: total_blocks,
        chunk_count: chunk_count as u32,
        solid: solid_result,
        water: fluid_result.water,
        lava: fluid_result.lava,
        glass: glass_result,
        model_opaque,
        model_transparent,
        model_overlay,
    }
}

/// Result of fused single-chunk processing
#[wasm_bindgen]
pub struct FusedChunkResult {
    success: bool,
    error_message: String,
    blocks_decoded: u32,
    chunk_x: i32,
    chunk_z: i32,
    solid: mesher::MeshData,
    water: mesher::MeshData,
    lava: mesher::MeshData,
    glass: mesher::MeshData,
    model_opaque: models::geometry::ModelMeshData,
    model_transparent: models::geometry::ModelMeshData,
    model_overlay: models::geometry::ModelMeshData,
}

impl FusedChunkResult {
    fn error(msg: &str) -> Self {
        Self {
            success: false,
            error_message: msg.to_string(),
            blocks_decoded: 0,
            chunk_x: 0,
            chunk_z: 0,
            solid: mesher::MeshData::new(),
            water: mesher::MeshData::new(),
            lava: mesher::MeshData::new(),
            glass: mesher::MeshData::new(),
            model_opaque: models::geometry::ModelMeshData::new(),
            model_transparent: models::geometry::ModelMeshData::new(),
            model_overlay: models::geometry::ModelMeshData::new(),
        }
    }
}

#[wasm_bindgen]
impl FusedChunkResult {
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool { self.success }
    
    #[wasm_bindgen(getter)]
    pub fn error_message(&self) -> String { self.error_message.clone() }
    
    #[wasm_bindgen(getter)]
    pub fn blocks_decoded(&self) -> u32 { self.blocks_decoded }
    
    #[wasm_bindgen(getter)]
    pub fn chunk_x(&self) -> i32 { self.chunk_x }
    
    #[wasm_bindgen(getter)]
    pub fn chunk_z(&self) -> i32 { self.chunk_z }
    
    // Solid mesh getters
    #[wasm_bindgen(getter)]
    pub fn solid_positions(&self) -> Vec<f32> { self.solid.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_normals(&self) -> Vec<f32> { self.solid.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_colors(&self) -> Vec<f32> { self.solid.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_uvs(&self) -> Vec<f32> { self.solid.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_tex_indices(&self) -> Vec<f32> { self.solid.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_tex_rotations(&self) -> Vec<f32> { self.solid.tex_rotations.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_tint_types(&self) -> Vec<f32> { self.solid.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_sky_light(&self) -> Vec<f32> { self.solid.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_block_light(&self) -> Vec<f32> { self.solid.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_indices(&self) -> Vec<u32> { self.solid.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_vertex_count(&self) -> u32 { self.solid.vertex_count }
    
    // Water mesh getters
    #[wasm_bindgen(getter)]
    pub fn water_positions(&self) -> Vec<f32> { self.water.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_normals(&self) -> Vec<f32> { self.water.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_colors(&self) -> Vec<f32> { self.water.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_uvs(&self) -> Vec<f32> { self.water.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_tex_indices(&self) -> Vec<f32> { self.water.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_sky_light(&self) -> Vec<f32> { self.water.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_block_light(&self) -> Vec<f32> { self.water.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_indices(&self) -> Vec<u32> { self.water.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_vertex_count(&self) -> u32 { self.water.vertex_count }
    
    // Lava mesh getters
    #[wasm_bindgen(getter)]
    pub fn lava_positions(&self) -> Vec<f32> { self.lava.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_normals(&self) -> Vec<f32> { self.lava.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_colors(&self) -> Vec<f32> { self.lava.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_uvs(&self) -> Vec<f32> { self.lava.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_tex_indices(&self) -> Vec<f32> { self.lava.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_sky_light(&self) -> Vec<f32> { self.lava.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_block_light(&self) -> Vec<f32> { self.lava.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_indices(&self) -> Vec<u32> { self.lava.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_vertex_count(&self) -> u32 { self.lava.vertex_count }
    
    // Glass mesh getters
    #[wasm_bindgen(getter)]
    pub fn glass_positions(&self) -> Vec<f32> { self.glass.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_normals(&self) -> Vec<f32> { self.glass.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_colors(&self) -> Vec<f32> { self.glass.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_tex_indices(&self) -> Vec<f32> { self.glass.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_tex_rotations(&self) -> Vec<f32> { self.glass.tex_rotations.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_tint_types(&self) -> Vec<f32> { self.glass.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_sky_light(&self) -> Vec<f32> { self.glass.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_block_light(&self) -> Vec<f32> { self.glass.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_indices(&self) -> Vec<u32> { self.glass.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_vertex_count(&self) -> u32 { self.glass.vertex_count }
    
    // Model opaque mesh getters
    #[wasm_bindgen(getter)]
    pub fn model_opaque_positions(&self) -> Vec<f32> { self.model_opaque.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_normals(&self) -> Vec<f32> { self.model_opaque.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_colors(&self) -> Vec<f32> { self.model_opaque.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_uvs(&self) -> Vec<f32> { self.model_opaque.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_tex_indices(&self) -> Vec<f32> { self.model_opaque.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_tint_types(&self) -> Vec<f32> { self.model_opaque.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_sky_light(&self) -> Vec<f32> { self.model_opaque.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_block_light(&self) -> Vec<f32> { self.model_opaque.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_indices(&self) -> Vec<u32> { self.model_opaque.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_vertex_count(&self) -> u32 { self.model_opaque.vertex_count }
    
    // Model transparent mesh getters
    #[wasm_bindgen(getter)]
    pub fn model_transparent_positions(&self) -> Vec<f32> { self.model_transparent.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_normals(&self) -> Vec<f32> { self.model_transparent.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_colors(&self) -> Vec<f32> { self.model_transparent.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_uvs(&self) -> Vec<f32> { self.model_transparent.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_tex_indices(&self) -> Vec<f32> { self.model_transparent.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_tint_types(&self) -> Vec<f32> { self.model_transparent.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_sky_light(&self) -> Vec<f32> { self.model_transparent.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_block_light(&self) -> Vec<f32> { self.model_transparent.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_indices(&self) -> Vec<u32> { self.model_transparent.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_vertex_count(&self) -> u32 { self.model_transparent.vertex_count }
    
    // Model overlay mesh getters
    #[wasm_bindgen(getter)]
    pub fn model_overlay_positions(&self) -> Vec<f32> { self.model_overlay.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_normals(&self) -> Vec<f32> { self.model_overlay.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_colors(&self) -> Vec<f32> { self.model_overlay.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_uvs(&self) -> Vec<f32> { self.model_overlay.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_tex_indices(&self) -> Vec<f32> { self.model_overlay.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_tint_types(&self) -> Vec<f32> { self.model_overlay.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_sky_light(&self) -> Vec<f32> { self.model_overlay.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_block_light(&self) -> Vec<f32> { self.model_overlay.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_indices(&self) -> Vec<u32> { self.model_overlay.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_vertex_count(&self) -> u32 { self.model_overlay.vertex_count }
}

/// Result of fused super-chunk processing
#[wasm_bindgen]
pub struct FusedSuperChunkResult {
    success: bool,
    error_message: String,
    blocks_decoded: u32,
    chunk_count: u32,
    solid: mesher::MeshData,
    water: mesher::MeshData,
    lava: mesher::MeshData,
    glass: mesher::MeshData,
    model_opaque: models::geometry::ModelMeshData,
    model_transparent: models::geometry::ModelMeshData,
    model_overlay: models::geometry::ModelMeshData,
}

impl FusedSuperChunkResult {
    fn error(msg: &str) -> Self {
        Self {
            success: false,
            error_message: msg.to_string(),
            blocks_decoded: 0,
            chunk_count: 0,
            solid: mesher::MeshData::new(),
            water: mesher::MeshData::new(),
            lava: mesher::MeshData::new(),
            glass: mesher::MeshData::new(),
            model_opaque: models::geometry::ModelMeshData::new(),
            model_transparent: models::geometry::ModelMeshData::new(),
            model_overlay: models::geometry::ModelMeshData::new(),
        }
    }
}

#[wasm_bindgen]
impl FusedSuperChunkResult {
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool { self.success }
    
    #[wasm_bindgen(getter)]
    pub fn error_message(&self) -> String { self.error_message.clone() }
    
    #[wasm_bindgen(getter)]
    pub fn blocks_decoded(&self) -> u32 { self.blocks_decoded }
    
    #[wasm_bindgen(getter)]
    pub fn chunk_count(&self) -> u32 { self.chunk_count }
    
    // Solid mesh getters
    #[wasm_bindgen(getter)]
    pub fn solid_positions(&self) -> Vec<f32> { self.solid.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_normals(&self) -> Vec<f32> { self.solid.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_colors(&self) -> Vec<f32> { self.solid.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_uvs(&self) -> Vec<f32> { self.solid.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_tex_indices(&self) -> Vec<f32> { self.solid.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_tex_rotations(&self) -> Vec<f32> { self.solid.tex_rotations.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_tint_types(&self) -> Vec<f32> { self.solid.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_sky_light(&self) -> Vec<f32> { self.solid.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_block_light(&self) -> Vec<f32> { self.solid.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_indices(&self) -> Vec<u32> { self.solid.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn solid_vertex_count(&self) -> u32 { self.solid.vertex_count }
    
    // Water mesh getters
    #[wasm_bindgen(getter)]
    pub fn water_positions(&self) -> Vec<f32> { self.water.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_normals(&self) -> Vec<f32> { self.water.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_colors(&self) -> Vec<f32> { self.water.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_uvs(&self) -> Vec<f32> { self.water.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_tex_indices(&self) -> Vec<f32> { self.water.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_sky_light(&self) -> Vec<f32> { self.water.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_block_light(&self) -> Vec<f32> { self.water.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_indices(&self) -> Vec<u32> { self.water.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn water_vertex_count(&self) -> u32 { self.water.vertex_count }
    
    // Lava mesh getters
    #[wasm_bindgen(getter)]
    pub fn lava_positions(&self) -> Vec<f32> { self.lava.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_normals(&self) -> Vec<f32> { self.lava.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_colors(&self) -> Vec<f32> { self.lava.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_uvs(&self) -> Vec<f32> { self.lava.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_tex_indices(&self) -> Vec<f32> { self.lava.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_sky_light(&self) -> Vec<f32> { self.lava.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_block_light(&self) -> Vec<f32> { self.lava.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_indices(&self) -> Vec<u32> { self.lava.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn lava_vertex_count(&self) -> u32 { self.lava.vertex_count }
    
    // Glass mesh getters
    #[wasm_bindgen(getter)]
    pub fn glass_positions(&self) -> Vec<f32> { self.glass.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_normals(&self) -> Vec<f32> { self.glass.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_colors(&self) -> Vec<f32> { self.glass.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_tex_indices(&self) -> Vec<f32> { self.glass.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_tex_rotations(&self) -> Vec<f32> { self.glass.tex_rotations.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_tint_types(&self) -> Vec<f32> { self.glass.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_sky_light(&self) -> Vec<f32> { self.glass.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_block_light(&self) -> Vec<f32> { self.glass.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_indices(&self) -> Vec<u32> { self.glass.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn glass_vertex_count(&self) -> u32 { self.glass.vertex_count }
    
    // Model opaque mesh getters
    #[wasm_bindgen(getter)]
    pub fn model_opaque_positions(&self) -> Vec<f32> { self.model_opaque.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_normals(&self) -> Vec<f32> { self.model_opaque.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_colors(&self) -> Vec<f32> { self.model_opaque.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_uvs(&self) -> Vec<f32> { self.model_opaque.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_tex_indices(&self) -> Vec<f32> { self.model_opaque.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_tint_types(&self) -> Vec<f32> { self.model_opaque.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_sky_light(&self) -> Vec<f32> { self.model_opaque.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_block_light(&self) -> Vec<f32> { self.model_opaque.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_indices(&self) -> Vec<u32> { self.model_opaque.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_opaque_vertex_count(&self) -> u32 { self.model_opaque.vertex_count }
    
    // Model transparent mesh getters
    #[wasm_bindgen(getter)]
    pub fn model_transparent_positions(&self) -> Vec<f32> { self.model_transparent.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_normals(&self) -> Vec<f32> { self.model_transparent.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_colors(&self) -> Vec<f32> { self.model_transparent.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_uvs(&self) -> Vec<f32> { self.model_transparent.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_tex_indices(&self) -> Vec<f32> { self.model_transparent.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_tint_types(&self) -> Vec<f32> { self.model_transparent.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_sky_light(&self) -> Vec<f32> { self.model_transparent.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_block_light(&self) -> Vec<f32> { self.model_transparent.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_indices(&self) -> Vec<u32> { self.model_transparent.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_transparent_vertex_count(&self) -> u32 { self.model_transparent.vertex_count }
    
    // Model overlay mesh getters
    #[wasm_bindgen(getter)]
    pub fn model_overlay_positions(&self) -> Vec<f32> { self.model_overlay.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_normals(&self) -> Vec<f32> { self.model_overlay.normals.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_colors(&self) -> Vec<f32> { self.model_overlay.colors.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_uvs(&self) -> Vec<f32> { self.model_overlay.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_tex_indices(&self) -> Vec<f32> { self.model_overlay.tex_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_tint_types(&self) -> Vec<f32> { self.model_overlay.tint_types.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_sky_light(&self) -> Vec<f32> { self.model_overlay.sky_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_block_light(&self) -> Vec<f32> { self.model_overlay.block_light.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_indices(&self) -> Vec<u32> { self.model_overlay.indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn model_overlay_vertex_count(&self) -> u32 { self.model_overlay.vertex_count }
}
