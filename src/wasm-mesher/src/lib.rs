//! WASM Mesher - High-performance Minecraft chunk meshing
//!
//! This crate provides WebAssembly bindings for generating mesh geometry
//! from Minecraft chunk data. It implements:
//! - Greedy meshing for solid blocks with AO and lighting
//! - Fluid meshing for water/lava with proper height interpolation
//! - Model meshing for non-cube blocks (slabs, stairs, etc.)

mod grid;
mod lookup;
mod mesher;
mod types;

use wasm_bindgen::prelude::*;

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
#[wasm_bindgen]
pub fn mesh_chunk(
    grid_data: &[u8],
    light_data: &[u8],
    state_data: &[u8],
    lookup_ptr: *const u8,
    lookup_len: usize,
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
    let lookups = unsafe { lookup::Lookups::from_ptr(lookup_ptr, lookup_len) };

    // Run meshers
    let solid_result = mesher::greedy::mesh_solid(&grid, light_grid.as_ref(), &lookups);
    let fluid_result = mesher::fluid::mesh_fluids(&grid, light_grid.as_ref(), &lookups);
    let glass_result = mesher::greedy::mesh_glass(&grid, light_grid.as_ref(), &lookups);

    MeshResult {
        solid: solid_result,
        water: fluid_result.water,
        lava: fluid_result.lava,
        glass: glass_result,
    }
}

/// Result containing all mesh buffers
#[wasm_bindgen]
pub struct MeshResult {
    solid: mesher::MeshData,
    water: mesher::MeshData,
    lava: mesher::MeshData,
    glass: mesher::MeshData,
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
    pub fn glass_indices(&self) -> Vec<u32> {
        self.glass.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn glass_vertex_count(&self) -> u32 {
        self.glass.vertex_count
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

