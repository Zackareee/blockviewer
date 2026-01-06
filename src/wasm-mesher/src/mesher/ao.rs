//! Ambient Occlusion calculation
//!
//! Implements Minecraft's 3-neighbor AO algorithm for each vertex.
//! For each corner vertex, check 3 adjacent blocks: side1, side2, corner.
//! AO level = 3 - count(solid neighbors), with special case when both sides are solid.

use crate::grid::{BinaryGrid, LightGrid};
use crate::lookup::Lookups;
use crate::types::{Face, BLOCK_ID_MASK};

/// AO brightness levels (0=darkest, 3=brightest)
pub const AO_BRIGHTNESS: [f32; 4] = [0.5, 0.7, 0.85, 1.0];

/// Vertex AO values for a face (4 corners)
#[derive(Debug, Clone, Copy, Default)]
pub struct FaceAO {
    pub v0: u8,
    pub v1: u8,
    pub v2: u8,
    pub v3: u8,
}

impl FaceAO {
    /// Check if AO pattern requires flipped winding for better interpolation
    /// Flip when v0+v2 < v1+v3 (diagonal should go through darker corners)
    pub fn should_flip(&self) -> bool {
        (self.v0 as u16 + self.v2 as u16) < (self.v1 as u16 + self.v3 as u16)
    }

    /// Get brightness values
    pub fn brightness(&self) -> [f32; 4] {
        [
            AO_BRIGHTNESS[self.v0 as usize],
            AO_BRIGHTNESS[self.v1 as usize],
            AO_BRIGHTNESS[self.v2 as usize],
            AO_BRIGHTNESS[self.v3 as usize],
        ]
    }

    /// Check if all corners have same AO (can merge in greedy meshing)
    pub fn is_uniform(&self) -> bool {
        self.v0 == self.v1 && self.v1 == self.v2 && self.v2 == self.v3
    }

    /// Compare with another AO pattern
    pub fn matches(&self, other: &FaceAO) -> bool {
        self.v0 == other.v0 && self.v1 == other.v1 && 
        self.v2 == other.v2 && self.v3 == other.v3
    }
}

/// Check if a block is solid for AO purposes
#[inline]
fn is_solid_for_ao(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32) -> bool {
    let block_id = grid.get_block_id(x, y, z);
    if block_id == 0 {
        return false;
    }
    if lookups.is_ao_transparent(block_id) {
        return false;
    }
    lookups.is_opaque(block_id)
}

/// Calculate single vertex AO from 3 neighbors
/// Returns AO level 0-3 (0=darkest, 3=brightest)
#[inline]
fn vertex_ao(side1: bool, side2: bool, corner: bool) -> u8 {
    if side1 && side2 {
        0 // Both sides solid = maximum occlusion
    } else {
        3 - (side1 as u8 + side2 as u8 + corner as u8)
    }
}

/// Calculate AO for TOP face (+Y)
/// Vertices: V0(SW), V1(SE), V2(NE), V3(NW)
pub fn get_top_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    let y = block_y + 1; // Sample in air above block

    // V0 (Southwest corner): check West, South, Southwest
    let west = is_solid_for_ao(grid, lookups, block_x - 1, y, block_z);
    let south = is_solid_for_ao(grid, lookups, block_x, y, block_z + 1);
    let south_west = is_solid_for_ao(grid, lookups, block_x - 1, y, block_z + 1);
    let v0 = vertex_ao(west, south, south_west);

    // V1 (Southeast corner): check East, South, Southeast
    let east = is_solid_for_ao(grid, lookups, block_x + 1, y, block_z);
    let south_east = is_solid_for_ao(grid, lookups, block_x + 1, y, block_z + 1);
    let v1 = vertex_ao(east, south, south_east);

    // V2 (Northeast corner): check East, North, Northeast
    let north = is_solid_for_ao(grid, lookups, block_x, y, block_z - 1);
    let north_east = is_solid_for_ao(grid, lookups, block_x + 1, y, block_z - 1);
    let v2 = vertex_ao(east, north, north_east);

    // V3 (Northwest corner): check West, North, Northwest
    let north_west = is_solid_for_ao(grid, lookups, block_x - 1, y, block_z - 1);
    let v3 = vertex_ao(west, north, north_west);

    FaceAO { v0, v1, v2, v3 }
}

/// Calculate AO for BOTTOM face (-Y)
/// Vertices: V0(NW), V1(NE), V2(SE), V3(SW)
pub fn get_bottom_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    let y = block_y - 1; // Sample below block

    let west = is_solid_for_ao(grid, lookups, block_x - 1, y, block_z);
    let east = is_solid_for_ao(grid, lookups, block_x + 1, y, block_z);
    let north = is_solid_for_ao(grid, lookups, block_x, y, block_z - 1);
    let south = is_solid_for_ao(grid, lookups, block_x, y, block_z + 1);
    let north_west = is_solid_for_ao(grid, lookups, block_x - 1, y, block_z - 1);
    let north_east = is_solid_for_ao(grid, lookups, block_x + 1, y, block_z - 1);
    let south_west = is_solid_for_ao(grid, lookups, block_x - 1, y, block_z + 1);
    let south_east = is_solid_for_ao(grid, lookups, block_x + 1, y, block_z + 1);

    FaceAO {
        v0: vertex_ao(west, north, north_west),
        v1: vertex_ao(east, north, north_east),
        v2: vertex_ao(east, south, south_east),
        v3: vertex_ao(west, south, south_west),
    }
}

/// Calculate AO for NORTH face (-Z)
pub fn get_north_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    let z = block_z - 1;

    let up = is_solid_for_ao(grid, lookups, block_x, block_y + 1, z);
    let down = is_solid_for_ao(grid, lookups, block_x, block_y - 1, z);
    let west = is_solid_for_ao(grid, lookups, block_x - 1, block_y, z);
    let east = is_solid_for_ao(grid, lookups, block_x + 1, block_y, z);
    let up_west = is_solid_for_ao(grid, lookups, block_x - 1, block_y + 1, z);
    let up_east = is_solid_for_ao(grid, lookups, block_x + 1, block_y + 1, z);
    let down_west = is_solid_for_ao(grid, lookups, block_x - 1, block_y - 1, z);
    let down_east = is_solid_for_ao(grid, lookups, block_x + 1, block_y - 1, z);

    FaceAO {
        v0: vertex_ao(west, down, down_west),
        v1: vertex_ao(east, down, down_east),
        v2: vertex_ao(east, up, up_east),
        v3: vertex_ao(west, up, up_west),
    }
}

/// Calculate AO for SOUTH face (+Z)
pub fn get_south_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    let z = block_z + 1;

    let up = is_solid_for_ao(grid, lookups, block_x, block_y + 1, z);
    let down = is_solid_for_ao(grid, lookups, block_x, block_y - 1, z);
    let west = is_solid_for_ao(grid, lookups, block_x - 1, block_y, z);
    let east = is_solid_for_ao(grid, lookups, block_x + 1, block_y, z);
    let up_west = is_solid_for_ao(grid, lookups, block_x - 1, block_y + 1, z);
    let up_east = is_solid_for_ao(grid, lookups, block_x + 1, block_y + 1, z);
    let down_west = is_solid_for_ao(grid, lookups, block_x - 1, block_y - 1, z);
    let down_east = is_solid_for_ao(grid, lookups, block_x + 1, block_y - 1, z);

    FaceAO {
        v0: vertex_ao(east, down, down_east),
        v1: vertex_ao(west, down, down_west),
        v2: vertex_ao(west, up, up_west),
        v3: vertex_ao(east, up, up_east),
    }
}

/// Calculate AO for EAST face (+X)
pub fn get_east_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    let x = block_x + 1;

    let up = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z);
    let down = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z);
    let north = is_solid_for_ao(grid, lookups, x, block_y, block_z - 1);
    let south = is_solid_for_ao(grid, lookups, x, block_y, block_z + 1);
    let up_north = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z - 1);
    let up_south = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z + 1);
    let down_north = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z - 1);
    let down_south = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z + 1);

    FaceAO {
        v0: vertex_ao(south, down, down_south),
        v1: vertex_ao(north, down, down_north),
        v2: vertex_ao(north, up, up_north),
        v3: vertex_ao(south, up, up_south),
    }
}

/// Calculate AO for WEST face (-X)
pub fn get_west_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    let x = block_x - 1;

    let up = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z);
    let down = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z);
    let north = is_solid_for_ao(grid, lookups, x, block_y, block_z - 1);
    let south = is_solid_for_ao(grid, lookups, x, block_y, block_z + 1);
    let up_north = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z - 1);
    let up_south = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z + 1);
    let down_north = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z - 1);
    let down_south = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z + 1);

    FaceAO {
        v0: vertex_ao(north, down, down_north),
        v1: vertex_ao(south, down, down_south),
        v2: vertex_ao(south, up, up_south),
        v3: vertex_ao(north, up, up_north),
    }
}

/// Get AO for any face
pub fn get_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
    face: Face,
) -> FaceAO {
    match face {
        Face::Up => get_top_face_ao(grid, lookups, block_x, block_y, block_z),
        Face::Down => get_bottom_face_ao(grid, lookups, block_x, block_y, block_z),
        Face::North => get_north_face_ao(grid, lookups, block_x, block_y, block_z),
        Face::South => get_south_face_ao(grid, lookups, block_x, block_y, block_z),
        Face::East => get_east_face_ao(grid, lookups, block_x, block_y, block_z),
        Face::West => get_west_face_ao(grid, lookups, block_x, block_y, block_z),
    }
}

/// Sample smooth vertex light with AO applied
pub fn sample_vertex_light(
    light_grid: Option<&LightGrid>,
    ao_brightness: f32,
    world_x: i32,
    world_y: i32,
    world_z: i32,
) -> (f32, f32) {
    let (sky, block) = if let Some(lg) = light_grid {
        let light = lg.get_light(world_x, world_y, world_z);
        (light.sky_light as f32, light.block_light as f32)
    } else {
        (15.0, 0.0)
    };

    (sky * ao_brightness, block * ao_brightness)
}

