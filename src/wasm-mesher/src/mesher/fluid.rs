//! Fluid Mesher - Water and lava mesh generation
//!
//! Implements Minecraft-accurate fluid rendering:
//! - Per-vertex corner height interpolation
//! - Flow direction calculation for UV rotation
//! - Level-based height calculation
//! - Waterlogged block support

use crate::grid::{BinaryGrid, LightGrid};
use crate::lookup::Lookups;
use crate::mesher::{MeshData, FluidMeshResult};
use crate::types::{
    Face, SECTION_SIZE, BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT,
    FluidType, section_to_world_y, block_index_in_section,
};

const S: usize = SECTION_SIZE;

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

/// Check if a block is waterlogged (level == 8 on a non-fluid block)
#[inline]
fn is_waterlogged(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32) -> bool {
    let block = grid.get_block(x, y, z);
    let block_id = block & BLOCK_ID_MASK;
    let level = ((block & LEVEL_MASK) >> LEVEL_SHIFT) as u8;
    
    // Waterlogged = non-fluid block with level 8
    lookups.fluid_type(block_id) == 0 && level == 8
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
    let level = ((block & LEVEL_MASK) >> LEVEL_SHIFT) as u8;

    // Check for waterlogged blocks (water only)
    if fluid_type == FluidType::Water && ft == 0 && level == 8 {
        return 0; // Waterlogged = source water
    }

    if ft != fluid_type as u8 {
        return 255; // Not this fluid type
    }

    level
}

/// Check if position has same fluid type (including waterlogged for water)
#[inline]
fn is_same_fluid(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32, fluid_type: FluidType) -> bool {
    get_fluid_level(grid, lookups, x, y, z, fluid_type) != 255
}

/// Check if position has fluid above
#[inline]
fn has_fluid_above(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32, fluid_type: FluidType) -> bool {
    is_same_fluid(grid, lookups, x, y + 1, z, fluid_type)
}

/// Check if block is solid (blocks fluid rendering)
#[inline]
fn is_solid(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32) -> bool {
    let block = grid.get_block(x, y, z);
    let block_id = block & BLOCK_ID_MASK;
    let level = ((block & LEVEL_MASK) >> LEVEL_SHIFT) as u8;
    
    // Opaque AND not waterlogged AND not a non-cube
    lookups.is_opaque(block_id) && level != 8 && !lookups.is_non_cube(block_id)
}

/// Calculate corner height using Minecraft's algorithm
fn get_corner_height(
    grid: &BinaryGrid,
    lookups: &Lookups,
    world_x: i32,
    world_y: i32,
    world_z: i32,
    corner_x: i32,
    corner_z: i32,
    fluid_type: FluidType,
) -> f32 {
    // The corner at (world_x + corner_x, world_z + corner_z)
    // is shared by 4 blocks
    let cx = world_x + corner_x;
    let cz = world_z + corner_z;
    
    // The 4 blocks sharing this corner
    let blocks = [
        (cx - 1, cz - 1),
        (cx, cz - 1),
        (cx - 1, cz),
        (cx, cz),
    ];
    
    let mut total_height = 0.0f32;
    let mut count = 0;
    
    for (bx, bz) in blocks {
        // Check if there's fluid above - if so, corner is fully submerged
        if has_fluid_above(grid, lookups, bx, world_y, bz, fluid_type) {
            return 1.0;
        }
        
        let level = get_fluid_level(grid, lookups, bx, world_y, bz, fluid_type);
        
        if level != 255 {
            // Block has fluid of the same type
            total_height += get_fluid_height(level);
            count += 1;
        } else {
            // Check if it's solid or air
            // Solid blocks don't count, air counts as 0
            if !is_solid(grid, lookups, bx, world_y, bz) {
                total_height += 0.0;
                count += 1;
            }
        }
    }
    
    if count == 0 {
        // All 4 blocks are solid - use center height
        let level = get_fluid_level(grid, lookups, world_x, world_y, world_z, fluid_type);
        return get_fluid_height(if level == 255 { 0 } else { level });
    }
    
    total_height / count as f32
}

/// Should we render a side face?
#[inline]
fn should_render_side(
    grid: &BinaryGrid,
    lookups: &Lookups,
    x: i32,
    y: i32,
    z: i32,
    dx: i32,
    dy: i32,
    dz: i32,
    fluid_type: FluidType,
) -> bool {
    let nx = x + dx;
    let ny = y + dy;
    let nz = z + dz;
    
    // Don't render if neighbor is same fluid type (including waterlogged)
    if is_same_fluid(grid, lookups, nx, ny, nz, fluid_type) {
        return false;
    }
    
    // Don't render if neighbor is solid
    if is_solid(grid, lookups, nx, ny, nz) {
        return false;
    }
    
    true
}

/// Calculate flow direction for UV rotation
fn get_flow_direction(
    grid: &BinaryGrid,
    lookups: &Lookups,
    x: i32,
    y: i32,
    z: i32,
    fluid_type: FluidType,
) -> (f32, f32) {
    let center_level = get_fluid_level(grid, lookups, x, y, z, fluid_type);
    if center_level == 255 || center_level >= 8 {
        return (0.0, 0.0); // No flow for falling fluid
    }
    
    let mut flow_x = 0.0f32;
    let mut flow_z = 0.0f32;
    
    // Check each cardinal direction
    let directions = [(1, 0), (-1, 0), (0, 1), (0, -1)];
    
    for (dx, dz) in directions {
        let nx = x + dx;
        let nz = z + dz;
        
        let neighbor_level = get_fluid_level(grid, lookups, nx, y, nz, fluid_type);
        
        // Check for drop (flowing waterfall effect)
        let block_below = grid.get_block(nx, y - 1, nz);
        let block_id_below = block_below & BLOCK_ID_MASK;
        let ft_below = lookups.fluid_type(block_id_below);
        let has_drop = block_below == 0 || ft_below == fluid_type as u8;
        
        if neighbor_level != 255 {
            // Both have fluid - flow towards lower level
            let level_diff = center_level as i32 - neighbor_level as i32;
            flow_x += dx as f32 * level_diff as f32;
            flow_z += dz as f32 * level_diff as f32;
        } else if has_drop {
            // Neighbor is empty with a drop - strong pull
            flow_x += dx as f32 * 2.0;
            flow_z += dz as f32 * 2.0;
        }
    }
    
    // Normalize
    let len = (flow_x * flow_x + flow_z * flow_z).sqrt();
    if len > 0.0001 {
        flow_x /= len;
        flow_z /= len;
    }
    
    (flow_x, flow_z)
}

/// Convert flow direction to texture rotation (0-3)
#[inline]
fn flow_to_rotation(flow_x: f32, flow_z: f32) -> f32 {
    if flow_x.abs() < 0.01 && flow_z.abs() < 0.01 {
        return 0.0; // No flow
    }
    
    if flow_z.abs() >= flow_x.abs() {
        if flow_z > 0.0 { 0.0 } else { 2.0 } // South or North
    } else {
        if flow_x > 0.0 { 1.0 } else { 3.0 } // East or West
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

    // Get fluid colors from lookups
    let water_color = lookups.get_water_color();
    let lava_color = lookups.get_lava_color();

    for (key, section) in grid.iter_sections() {
        let base_x = key.chunk_x * S as i32;
        let base_y = section_to_world_y(key.section_y);
        let base_z = key.chunk_z * S as i32;

        for ly in 0..S {
            for lz in 0..S {
                for lx in 0..S {
                    let idx = block_index_in_section(lx, ly, lz);
                    let block = section[idx];
                    if block == 0 {
                        continue;
                    }
                    
                    let block_id = block & BLOCK_ID_MASK;
                    let level = ((block & LEVEL_MASK) >> LEVEL_SHIFT) as u8;
                    let fluid_type_raw = lookups.fluid_type(block_id);
                    
                    // Check for waterlogged blocks
                    let is_waterlogged_block = fluid_type_raw == 0 && level == 8;
                    
                    let (effective_fluid_type, effective_level) = if is_waterlogged_block {
                        (FluidType::Water, 0u8)
                    } else {
                        match fluid_type_raw {
                            1 => (FluidType::Water, level),
                            2 => (FluidType::Lava, level),
                            _ => continue,
                        }
                    };

                    let world_x = base_x + lx as i32;
                    let world_y = base_y + ly as i32;
                    let world_z = base_z + lz as i32;

                    let (mesh, color) = if effective_fluid_type == FluidType::Water {
                        (&mut water, water_color)
                    } else {
                        (&mut lava, lava_color)
                    };

                    mesh_fluid_block(
                        grid,
                        light_grid,
                        lookups,
                        world_x,
                        world_y,
                        world_z,
                        effective_level,
                        effective_fluid_type,
                        color,
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
    color: (f32, f32, f32),
    mesh: &mut MeshData,
) {
    let xf = x as f32;
    let yf = y as f32;
    let zf = z as f32;
    
    // Check if there's fluid above (including waterlogged)
    let fluid_above = has_fluid_above(grid, lookups, x, y, z, fluid_type);
    
    // Get flow direction for texture rotation
    let (flow_x, flow_z) = get_flow_direction(grid, lookups, x, y, z, fluid_type);
    let has_flow = flow_x.abs() > 0.01 || flow_z.abs() > 0.01;
    let rotation = if has_flow { flow_to_rotation(flow_x, flow_z) } else { 0.0 };
    
    // Get texture indices
    let (still_idx, flow_idx) = if fluid_type == FluidType::Water {
        (lookups.water_texture(false), lookups.water_texture(true))
    } else {
        (lookups.lava_texture(false), lookups.lava_texture(true))
    };

    // Get corner heights for top face
    let h00 = get_corner_height(grid, lookups, x, y, z, 0, 0, fluid_type);
    let h10 = get_corner_height(grid, lookups, x, y, z, 1, 0, fluid_type);
    let h01 = get_corner_height(grid, lookups, x, y, z, 0, 1, fluid_type);
    let h11 = get_corner_height(grid, lookups, x, y, z, 1, 1, fluid_type);

    // Top face - only if no fluid above
    if !fluid_above {
        let positions = [
            (xf, yf + h00, zf),
            (xf + 1.0, yf + h10, zf),
            (xf + 1.0, yf + h11, zf + 1.0),
            (xf, yf + h01, zf + 1.0),
        ];

        // Calculate normal from angled surface
        let v1 = (
            positions[2].0 - positions[0].0,
            positions[2].1 - positions[0].1,
            positions[2].2 - positions[0].2,
        );
        let v2 = (
            positions[3].0 - positions[1].0,
            positions[3].1 - positions[1].1,
            positions[3].2 - positions[1].2,
        );
        let mut normal = (
            v1.1 * v2.2 - v1.2 * v2.1,
            v1.2 * v2.0 - v1.0 * v2.2,
            v1.0 * v2.1 - v1.1 * v2.0,
        );
        let len = (normal.0 * normal.0 + normal.1 * normal.1 + normal.2 * normal.2).sqrt();
        if len > 0.0 {
            normal.0 /= len;
            normal.1 /= len;
            normal.2 /= len;
        } else {
            normal = (0.0, 1.0, 0.0);
        }

        let light = get_face_light(light_grid, x, y + 1, z);
        let tex_idx = if has_flow { flow_idx } else { still_idx };
        
        mesh.add_quad(
            positions,
            normal,
            color,
            tex_idx,
            rotation,
            0.0, // No tint type for fluids
            light,
            [0.0; 4], // No AO for fluids
            false,
        );
    }

    // Bottom face - only if no fluid/waterlogged below AND no solid block below
    let has_fluid_below = is_same_fluid(grid, lookups, x, y - 1, z, fluid_type);
    let solid_below = is_solid(grid, lookups, x, y - 1, z);
    if !has_fluid_below && !solid_below {
        let positions = [
            (xf, yf, zf),
            (xf + 1.0, yf, zf),
            (xf + 1.0, yf, zf + 1.0),
            (xf, yf, zf + 1.0),
        ];

        let light = get_face_light(light_grid, x, y - 1, z);
        
        mesh.add_quad(
            positions,
            Face::Down.normal(),
            color,
            still_idx,
            0.0,
            0.0,
            light,
            [0.0; 4],
            false,
        );
    }

    // Side faces - use corner heights
    let top_y_00 = if fluid_above { 1.0 } else { h00 };
    let top_y_10 = if fluid_above { 1.0 } else { h10 };
    let top_y_01 = if fluid_above { 1.0 } else { h01 };
    let top_y_11 = if fluid_above { 1.0 } else { h11 };

    // +X face (east)
    if should_render_side(grid, lookups, x, y, z, 1, 0, 0, fluid_type) {
        let positions = [
            (xf + 1.0, yf, zf),
            (xf + 1.0, yf, zf + 1.0),
            (xf + 1.0, yf + top_y_11, zf + 1.0),
            (xf + 1.0, yf + top_y_10, zf),
        ];
        let light = get_face_light(light_grid, x + 1, y, z);
        mesh.add_quad(positions, Face::East.normal(), color, flow_idx, 0.0, 0.0, light, [0.0; 4], false);
    }

    // -X face (west)
    if should_render_side(grid, lookups, x, y, z, -1, 0, 0, fluid_type) {
        let positions = [
            (xf, yf, zf + 1.0),
            (xf, yf, zf),
            (xf, yf + top_y_00, zf),
            (xf, yf + top_y_01, zf + 1.0),
        ];
        let light = get_face_light(light_grid, x - 1, y, z);
        mesh.add_quad(positions, Face::West.normal(), color, flow_idx, 0.0, 0.0, light, [0.0; 4], false);
    }

    // +Z face (south)
    if should_render_side(grid, lookups, x, y, z, 0, 0, 1, fluid_type) {
        let positions = [
            (xf + 1.0, yf, zf + 1.0),
            (xf, yf, zf + 1.0),
            (xf, yf + top_y_01, zf + 1.0),
            (xf + 1.0, yf + top_y_11, zf + 1.0),
        ];
        let light = get_face_light(light_grid, x, y, z + 1);
        mesh.add_quad(positions, Face::South.normal(), color, flow_idx, 0.0, 0.0, light, [0.0; 4], false);
    }

    // -Z face (north)
    if should_render_side(grid, lookups, x, y, z, 0, 0, -1, fluid_type) {
        let positions = [
            (xf, yf, zf),
            (xf + 1.0, yf, zf),
            (xf + 1.0, yf + top_y_10, zf),
            (xf, yf + top_y_00, zf),
        ];
        let light = get_face_light(light_grid, x, y, z - 1);
        mesh.add_quad(positions, Face::North.normal(), color, flow_idx, 0.0, 0.0, light, [0.0; 4], false);
    }
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
