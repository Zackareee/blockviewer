//! Model Mesher - Non-cube block mesh generation
//!
//! This module handles meshing for non-cube blocks like slabs, stairs, fences, etc.
//! 
//! NOTE: Full model meshing requires pre-computed geometry data from JavaScript
//! (loaded from Minecraft's block model JSON files). For Phase 1, model meshing
//! remains on the JavaScript side, with this module providing placeholder support.
//!
//! Future work:
//! - Pass model geometry data to WASM during init
//! - Implement face culling logic for slabs/stairs
//! - Implement GPU instancing data collection

use crate::grid::{BinaryGrid, BlockStateGrid, LightGrid};
use crate::lookup::Lookups;
use crate::mesher::MeshData;
use crate::types::{SECTION_SIZE, section_to_world_y, block_index_in_section, BLOCK_ID_MASK};

const S: usize = SECTION_SIZE;

/// Model geometry data passed from JavaScript
/// This will be populated during init for future model meshing
pub struct ModelGeometryData {
    // Placeholder for future model geometry storage
    _initialized: bool,
}

impl ModelGeometryData {
    pub fn new() -> Self {
        Self { _initialized: false }
    }
}

/// Result from model meshing
#[derive(Debug, Default)]
pub struct ModelMeshResult {
    pub opaque: MeshData,
    pub transparent: MeshData,
    pub overlay: MeshData,
}

/// Mesh non-cube blocks
/// 
/// NOTE: For Phase 1, this returns empty meshes. Model meshing continues
/// on the JavaScript side until geometry data can be passed to WASM.
pub fn mesh_models(
    grid: &BinaryGrid,
    state_grid: Option<&BlockStateGrid>,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
) -> ModelMeshResult {
    // Phase 1: Return empty meshes - model meshing stays on JS side
    // This is because model geometry requires complex JSON parsing and
    // pre-computed vertex data that isn't easily serialized to WASM yet.
    
    ModelMeshResult::default()
}

/// Collect non-cube block positions for JS-side meshing
/// Returns a list of (x, y, z, state_id) for each non-cube block
pub fn collect_model_positions(
    grid: &BinaryGrid,
    state_grid: Option<&BlockStateGrid>,
    lookups: &Lookups,
) -> Vec<(i32, i32, i32, u16)> {
    let mut positions = Vec::new();

    for (key, section) in grid.iter_sections() {
        let base_x = key.chunk_x * S as i32;
        let base_y = section_to_world_y(key.section_y);
        let base_z = key.chunk_z * S as i32;

        for ly in 0..S {
            for lz in 0..S {
                for lx in 0..S {
                    let idx = block_index_in_section(lx, ly, lz);
                    let block = section[idx];
                    let block_id = block & BLOCK_ID_MASK;

                    if block_id == 0 {
                        continue;
                    }

                    // Check if this is a non-cube block
                    if lookups.is_non_cube(block_id) {
                        let world_x = base_x + lx as i32;
                        let world_y = base_y + ly as i32;
                        let world_z = base_z + lz as i32;

                        // Get state ID if available
                        let state_id = state_grid
                            .map(|sg| sg.get_state(world_x, world_y, world_z))
                            .unwrap_or(0);

                        positions.push((world_x, world_y, world_z, state_id));
                    }
                }
            }
        }
    }

    positions
}

