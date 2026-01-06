//! Fluid Mesher - Water and lava mesh generation
//!
//! Implements Minecraft-accurate fluid rendering:
//! - Per-vertex corner height interpolation
//! - Flow direction calculation for UV rotation
//! - Level-based height calculation

use crate::grid::{BinaryGrid, LightGrid};
use crate::lookup::Lookups;
use crate::mesher::{MeshData, FluidMeshResult};
use crate::types::{
    Face, SectionKey, SECTION_SIZE, SECTION_VOLUME, BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT,
    FluidType, section_to_world_y, block_index_in_section,
};

const S: usize = SECTION_SIZE;
const S2: usize = S * S;
const S3: usize = SECTION_VOLUME;

/// Initial buffer size
const INITIAL_CAPACITY: usize = 4096;

/// Convert fluid level to height (0.0 to 1.0)
#[inline]
fn get_fluid_height(level: u8) -> f32 {
    if level >= 8 {
        1.0 // Falling fluid
    } else if level == 0 {
        8.0 / 9.0 // Source block (~0.889)
    } else {
        (8 - level) as f32 / 9.0
    }
}

/// Get fluid level at position (returns 255 if not matching fluid type)
#[inline]
fn get_fluid_level(
    grid: &BinaryGrid,
    lookups: &Lookups,
    x: i32,
    y: i32,
    z: i32,
    fluid_type: FluidType,
) -> u8 {
    let block = grid.get_block(x, y, z);
    let block_id = block & BLOCK_ID_MASK;
    let ft = lookups.fluid_type(block_id);

    // Check for waterlogged blocks
    if fluid_type == FluidType::Water && ft == 0 {
        let level = ((block & LEVEL_MASK) >> LEVEL_SHIFT) as u8;
        if level == 8 {
            return 0; // Waterlogged = source
        }
    }

    if ft != fluid_type as u8 {
        return 255; // Not this fluid type
    }

    ((block & LEVEL_MASK) >> LEVEL_SHIFT) as u8
}

/// Check if position has same fluid type
#[inline]
fn is_same_fluid(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32, fluid_type: FluidType) -> bool {
    get_fluid_level(grid, lookups, x, y, z, fluid_type) != 255
}

/// Calculate corner height by averaging adjacent blocks
fn get_corner_height(
    grid: &BinaryGrid,
    lookups: &Lookups,
    corner_x: i32,
    corner_y: i32,
    corner_z: i32,
    fluid_type: FluidType,
) -> f32 {
    // Check if there's fluid above - if so, full height
    for dx in -1..=0 {
        for dz in -1..=0 {
            if is_same_fluid(grid, lookups, corner_x + dx, corner_y + 1, corner_z + dz, fluid_type) {
                return 1.0;
            }
        }
    }

    // Average heights of 4 adjacent blocks
    let mut total_height = 0.0f32;
    let mut count = 0;

    for dx in -1..=0 {
        for dz in -1..=0 {
            let level = get_fluid_level(grid, lookups, corner_x + dx, corner_y, corner_z + dz, fluid_type);
            if level != 255 {
                total_height += get_fluid_height(level);
                count += 1;
            }
        }
    }

    if count > 0 {
        total_height / count as f32
    } else {
        0.0
    }
}

/// Mesh all fluids in the grid
pub fn mesh_fluids(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
) -> FluidMeshResult {
    let mut water = MeshData::with_capacity(INITIAL_CAPACITY, INITIAL_CAPACITY * 6 / 4);
    let mut lava = MeshData::with_capacity(INITIAL_CAPACITY / 4, INITIAL_CAPACITY / 4 * 6 / 4);

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
                    
                    let fluid_type_raw = lookups.fluid_type(block_id);
                    let fluid_type = match fluid_type_raw {
                        1 => FluidType::Water,
                        2 => FluidType::Lava,
                        _ => continue,
                    };

                    let level = ((block & LEVEL_MASK) >> LEVEL_SHIFT) as u8;
                    let world_x = base_x + lx as i32;
                    let world_y = base_y + ly as i32;
                    let world_z = base_z + lz as i32;

                    let mesh = if fluid_type == FluidType::Water { &mut water } else { &mut lava };

                    // Generate faces
                    mesh_fluid_block(
                        grid,
                        light_grid,
                        lookups,
                        world_x,
                        world_y,
                        world_z,
                        level,
                        fluid_type,
                        mesh,
                    );
                }
            }
        }
    }

    FluidMeshResult { water, lava }
}

/// Mesh a single fluid block
fn mesh_fluid_block(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    x: i32,
    y: i32,
    z: i32,
    level: u8,
    fluid_type: FluidType,
    mesh: &mut MeshData,
) {
    let block_id = grid.get_block_id(x, y, z);
    let color = lookups.color(block_id);

    // Get corner heights for top face
    let h00 = get_corner_height(grid, lookups, x, y, z, fluid_type);
    let h10 = get_corner_height(grid, lookups, x + 1, y, z, fluid_type);
    let h01 = get_corner_height(grid, lookups, x, y, z + 1, fluid_type);
    let h11 = get_corner_height(grid, lookups, x + 1, y, z + 1, fluid_type);

    // Top face - only if no fluid above
    if !is_same_fluid(grid, lookups, x, y + 1, z, fluid_type) {
        let positions = [
            (x as f32, y as f32 + h01, z as f32 + 1.0),
            ((x + 1) as f32, y as f32 + h11, z as f32 + 1.0),
            ((x + 1) as f32, y as f32 + h10, z as f32),
            (x as f32, y as f32 + h00, z as f32),
        ];

        let light = get_face_light(light_grid, x, y + 1, z);
        
        mesh.add_quad(
            positions,
            Face::Up.normal(),
            color,
            lookups.texture_index(block_id, Face::Up as u8),
            0.0,
            0.0,
            light,
            [0.0; 4],
            false,
        );
    }

    // Bottom face - only if no fluid below
    if !is_same_fluid(grid, lookups, x, y - 1, z, fluid_type) && !is_solid_below(grid, lookups, x, y, z) {
        let positions = [
            (x as f32, y as f32, z as f32),
            ((x + 1) as f32, y as f32, z as f32),
            ((x + 1) as f32, y as f32, z as f32 + 1.0),
            (x as f32, y as f32, z as f32 + 1.0),
        ];

        let light = get_face_light(light_grid, x, y - 1, z);
        
        mesh.add_quad(
            positions,
            Face::Down.normal(),
            color,
            lookups.texture_index(block_id, Face::Down as u8),
            0.0,
            0.0,
            light,
            [0.0; 4],
            false,
        );
    }

    // North face (-Z)
    if !is_same_fluid(grid, lookups, x, y, z - 1, fluid_type) && !is_solid(grid, lookups, x, y, z - 1) {
        let positions = [
            ((x + 1) as f32, y as f32, z as f32),
            (x as f32, y as f32, z as f32),
            (x as f32, y as f32 + h00, z as f32),
            ((x + 1) as f32, y as f32 + h10, z as f32),
        ];

        let light = get_face_light(light_grid, x, y, z - 1);
        
        mesh.add_quad(
            positions,
            Face::North.normal(),
            color,
            lookups.texture_index(block_id, Face::North as u8),
            0.0,
            0.0,
            light,
            [0.0; 4],
            false,
        );
    }

    // South face (+Z)
    if !is_same_fluid(grid, lookups, x, y, z + 1, fluid_type) && !is_solid(grid, lookups, x, y, z + 1) {
        let positions = [
            (x as f32, y as f32, z as f32 + 1.0),
            ((x + 1) as f32, y as f32, z as f32 + 1.0),
            ((x + 1) as f32, y as f32 + h11, z as f32 + 1.0),
            (x as f32, y as f32 + h01, z as f32 + 1.0),
        ];

        let light = get_face_light(light_grid, x, y, z + 1);
        
        mesh.add_quad(
            positions,
            Face::South.normal(),
            color,
            lookups.texture_index(block_id, Face::South as u8),
            0.0,
            0.0,
            light,
            [0.0; 4],
            false,
        );
    }

    // East face (+X)
    if !is_same_fluid(grid, lookups, x + 1, y, z, fluid_type) && !is_solid(grid, lookups, x + 1, y, z) {
        let positions = [
            ((x + 1) as f32, y as f32, z as f32 + 1.0),
            ((x + 1) as f32, y as f32, z as f32),
            ((x + 1) as f32, y as f32 + h10, z as f32),
            ((x + 1) as f32, y as f32 + h11, z as f32 + 1.0),
        ];

        let light = get_face_light(light_grid, x + 1, y, z);
        
        mesh.add_quad(
            positions,
            Face::East.normal(),
            color,
            lookups.texture_index(block_id, Face::East as u8),
            0.0,
            0.0,
            light,
            [0.0; 4],
            false,
        );
    }

    // West face (-X)
    if !is_same_fluid(grid, lookups, x - 1, y, z, fluid_type) && !is_solid(grid, lookups, x - 1, y, z) {
        let positions = [
            (x as f32, y as f32, z as f32),
            (x as f32, y as f32, z as f32 + 1.0),
            (x as f32, y as f32 + h01, z as f32 + 1.0),
            (x as f32, y as f32 + h00, z as f32),
        ];

        let light = get_face_light(light_grid, x - 1, y, z);
        
        mesh.add_quad(
            positions,
            Face::West.normal(),
            color,
            lookups.texture_index(block_id, Face::West as u8),
            0.0,
            0.0,
            light,
            [0.0; 4],
            false,
        );
    }
}

#[inline]
fn is_solid(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32) -> bool {
    let block_id = grid.get_block_id(x, y, z);
    lookups.is_opaque(block_id) && !lookups.is_non_cube(block_id)
}

#[inline]
fn is_solid_below(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32) -> bool {
    is_solid(grid, lookups, x, y - 1, z)
}

#[inline]
fn get_face_light(light_grid: Option<&LightGrid>, x: i32, y: i32, z: i32) -> [f32; 4] {
    if let Some(lg) = light_grid {
        let light = lg.get_light(x, y, z);
        [light.sky_light as f32; 4]
    } else {
        [15.0; 4]
    }
}

