//! Ambient Occlusion calculation
//!
//! Implements Minecraft's 3-neighbor AO algorithm for each vertex.
//! For each corner vertex, check 3 adjacent blocks: side1, side2, corner.
//! AO level = 3 - count(solid neighbors), with special case when both sides are solid.

use crate::grid::{BinaryGrid, LightGrid};
use crate::lookup::Lookups;
use crate::types::Face;

/// AO brightness levels (0=darkest, 3=brightest)
/// These match Minecraft's actual AO values
pub const AO_BRIGHTNESS: [f32; 4] = [0.2, 0.6, 0.8, 1.0];

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
    
    /// Compare with tolerance (for greedy meshing - allows merging faces with similar AO)
    pub fn matches_tolerant(&self, other: &FaceAO) -> bool {
        // Check if any vertex differs by more than 1 level
        let diff0 = (self.v0 as i8 - other.v0 as i8).abs();
        let diff1 = (self.v1 as i8 - other.v1 as i8).abs();
        let diff2 = (self.v2 as i8 - other.v2 as i8).abs();
        let diff3 = (self.v3 as i8 - other.v3 as i8).abs();
        
        diff0 <= 1 && diff1 <= 1 && diff2 <= 1 && diff3 <= 1
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
/// Sample Z = block_z - 1 (one block in front of face, in the air space)
pub fn get_north_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    // Sample in the air space in front of the north face (z - 1)
    let z = block_z - 1;

    let up = is_solid_for_ao(grid, lookups, block_x, block_y + 1, z);
    let down = is_solid_for_ao(grid, lookups, block_x, block_y - 1, z);
    let west = is_solid_for_ao(grid, lookups, block_x - 1, block_y, z);
    let east = is_solid_for_ao(grid, lookups, block_x + 1, block_y, z);
    let up_west = is_solid_for_ao(grid, lookups, block_x - 1, block_y + 1, z);
    let up_east = is_solid_for_ao(grid, lookups, block_x + 1, block_y + 1, z);
    let down_west = is_solid_for_ao(grid, lookups, block_x - 1, block_y - 1, z);
    let down_east = is_solid_for_ao(grid, lookups, block_x + 1, block_y - 1, z);

    // North face vertex order (looking from -Z toward +Z):
    // V0: bottom-left - neighbors: west, down, down_west
    // V1: bottom-right - neighbors: east, down, down_east
    // V2: top-right - neighbors: east, up, up_east
    // V3: top-left - neighbors: west, up, up_west
    FaceAO {
        v0: vertex_ao(west, down, down_west),
        v1: vertex_ao(east, down, down_east),
        v2: vertex_ao(east, up, up_east),
        v3: vertex_ao(west, up, up_west),
    }
}

/// Calculate AO for SOUTH face (+Z)
/// Sample Z = block_z + 1 (one block behind face, in the air space)
pub fn get_south_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    // Sample in the air space behind the south face (z + 1)
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
/// Sample X = block_x + 1 (one block to the right of face, in the air space)
pub fn get_east_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    // Sample in the air space to the east of the face (x + 1)
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
/// Sample X = block_x - 1 (one block to the left of face, in the air space)
pub fn get_west_face_ao(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> FaceAO {
    // Sample in the air space to the west of the face (x - 1)
    let x = block_x - 1;

    let up = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z);
    let down = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z);
    let north = is_solid_for_ao(grid, lookups, x, block_y, block_z - 1);
    let south = is_solid_for_ao(grid, lookups, x, block_y, block_z + 1);
    let up_north = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z - 1);
    let up_south = is_solid_for_ao(grid, lookups, x, block_y + 1, block_z + 1);
    let down_north = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z - 1);
    let down_south = is_solid_for_ao(grid, lookups, x, block_y - 1, block_z + 1);

    // West face vertices (looking from -X toward +X):
    // V0: bottom-back (at x, y, z) - check North, Down, DownNorth
    // V1: bottom-front (at x, y, z+1) - check South, Down, DownSouth
    // V2: top-front (at x, y+1, z+1) - check South, Up, UpSouth
    // V3: top-back (at x, y+1, z) - check North, Up, UpNorth
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
/// Samples 4 blocks around the vertex corner and averages non-solid block light
pub fn sample_smooth_vertex_light(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    vertex_x: i32,
    vertex_y: i32,
    vertex_z: i32,
    ao_level: u8,
    plane: Plane,
) -> (f32, f32) {
    let ao_brightness = AO_BRIGHTNESS[ao_level as usize];
    
    let lg = match light_grid {
        Some(lg) => lg,
        None => return (15.0 * ao_brightness, 0.0),
    };
    
    // Sample 4 blocks touching this vertex corner
    let mut total_sky = 0.0f32;
    let mut total_block = 0.0f32;
    let mut count = 0;
    
    // Get offsets based on plane
    let offsets: [(i32, i32, i32); 4] = match plane {
        Plane::XZ => [
            (-1, 0, -1), (0, 0, -1), (-1, 0, 0), (0, 0, 0)
        ],
        Plane::YZ => [
            (0, -1, -1), (0, 0, -1), (0, -1, 0), (0, 0, 0)
        ],
        Plane::XY => [
            (-1, -1, 0), (0, -1, 0), (-1, 0, 0), (0, 0, 0)
        ],
    };
    
    for (dx, dy, dz) in offsets {
        let bx = vertex_x + dx;
        let by = vertex_y + dy;
        let bz = vertex_z + dz;
        
        let block_id = grid.get_block_id(bx, by, bz);
        
        // Only sample from non-solid blocks (air spaces)
        if block_id == 0 || lookups.is_ao_transparent(block_id) || !lookups.is_opaque(block_id) {
            let light = lg.get_light(bx, by, bz);
            total_sky += light.sky_light as f32;
            total_block += light.block_light as f32;
            count += 1;
        }
    }
    
    // Average or fallback to direct sample
    let (avg_sky, avg_block) = if count > 0 {
        (total_sky / count as f32, total_block / count as f32)
    } else {
        let light = lg.get_light(vertex_x, vertex_y, vertex_z);
        (light.sky_light as f32, light.block_light as f32)
    };
    
    (avg_sky * ao_brightness, avg_block * ao_brightness)
}

/// Plane for light sampling
#[derive(Clone, Copy)]
pub enum Plane {
    XZ, // Top/Bottom faces
    YZ, // East/West faces
    XY, // North/South faces
}

/// Get block light value for face (used for merge comparison)
/// Returns (sky_light, block_light) at the air block adjacent to the face
#[inline]
pub fn get_face_light(
    light_grid: Option<&LightGrid>,
    face_x: i32,
    face_y: i32,
    face_z: i32,
) -> (u8, u8) {
    match light_grid {
        Some(lg) => {
            let light = lg.get_light(face_x, face_y, face_z);
            (light.sky_light, light.block_light)
        }
        None => (15, 0),
    }
}

/// Check if two blocks have compatible light for merging
/// Returns true if they can be merged (same or similar light)
#[inline]
pub fn light_matches(
    light_grid: Option<&LightGrid>,
    x1: i32, y1: i32, z1: i32,
    x2: i32, y2: i32, z2: i32,
) -> bool {
    let (sky1, block1) = get_face_light(light_grid, x1, y1, z1);
    let (sky2, block2) = get_face_light(light_grid, x2, y2, z2);
    
    // Must have exact same light values to merge
    sky1 == sky2 && block1 == block2
}

/// Tolerance for light merging in greedy meshing
/// 0 = exact match required for smooth lighting, prevents blocky appearance
const LIGHT_TOLERANCE: u8 = 0;

/// Check if two light values are within tolerance for merging
#[inline]
pub fn light_within_tolerance(sky1: u8, block1: u8, sky2: u8, block2: u8) -> bool {
    let sky_diff = (sky1 as i16 - sky2 as i16).unsigned_abs() as u8;
    let block_diff = (block1 as i16 - block2 as i16).unsigned_abs() as u8;
    sky_diff <= LIGHT_TOLERANCE && block_diff <= LIGHT_TOLERANCE
}

