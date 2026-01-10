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
pub use models::registry::{init_state_registry, init_model_registry, init_hash_model_registry};

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
            };
        }
    };

    // Run meshers with optional bounds
    let solid_result = mesher::greedy::mesh_solid_bounded(&grid, light_grid.as_ref(), &lookups, bounds.as_ref());
    let fluid_result = mesher::fluid::mesh_fluids_bounded(&grid, light_grid.as_ref(), &lookups, bounds.as_ref());
    let glass_result = mesher::greedy::mesh_glass_bounded(&grid, light_grid.as_ref(), &lookups, bounds.as_ref());
    
    // Model meshing using hash-based registry (if state grid provided and registry initialized)
    let (model_opaque, model_transparent) = if let Some(ref sg) = state_grid {
        if models::registry::is_hash_model_registry_initialized() {
            let model_result = models::mesher::mesh_models_bounded(&grid, sg, light_grid.as_ref(), &lookups, bounds.as_ref());
            (model_result.opaque, model_result.transparent)
        } else {
            (models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new())
        }
    } else {
        (models::geometry::ModelMeshData::new(), models::geometry::ModelMeshData::new())
    };

    MeshResult {
        solid: solid_result,
        water: fluid_result.water,
        lava: fluid_result.lava,
        glass: glass_result,
        model_opaque,
        model_transparent,
    }
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

