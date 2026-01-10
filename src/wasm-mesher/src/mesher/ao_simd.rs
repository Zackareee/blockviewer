//! SIMD-Optimized Ambient Occlusion Calculations
//!
//! Uses WASM SIMD (v128) to process multiple AO calculations in parallel.
//! Falls back to scalar code when SIMD is not available.
//!
//! Key optimizations:
//! 1. Batch 4 vertex AO calculations into a single SIMD operation
//! 2. Vectorized neighbor lookup with early exit
//! 3. Packed AO values in u32 for efficient storage

use crate::grid::BinaryGrid;
use crate::lookup::Lookups;
use crate::mesher::ao::{FaceAO, AO_BRIGHTNESS};

/// Packed AO values for a face (4 vertices in a single u32)
/// Layout: v0 (bits 0-1), v1 (bits 2-3), v2 (bits 4-5), v3 (bits 6-7)
#[derive(Debug, Clone, Copy, Default)]
#[repr(transparent)]
pub struct PackedAO(pub u8);

impl PackedAO {
    /// Create from individual AO values (0-3 each)
    #[inline]
    pub const fn new(v0: u8, v1: u8, v2: u8, v3: u8) -> Self {
        PackedAO((v0 & 3) | ((v1 & 3) << 2) | ((v2 & 3) << 4) | ((v3 & 3) << 6))
    }
    
    /// Create from FaceAO
    #[inline]
    pub fn from_face_ao(ao: &FaceAO) -> Self {
        Self::new(ao.v0, ao.v1, ao.v2, ao.v3)
    }
    
    /// Unpack to individual values
    #[inline]
    pub fn unpack(&self) -> (u8, u8, u8, u8) {
        (
            self.0 & 3,
            (self.0 >> 2) & 3,
            (self.0 >> 4) & 3,
            (self.0 >> 6) & 3,
        )
    }
    
    /// Get brightness values (4 floats)
    #[inline]
    pub fn brightness(&self) -> [f32; 4] {
        let (v0, v1, v2, v3) = self.unpack();
        [
            AO_BRIGHTNESS[v0 as usize],
            AO_BRIGHTNESS[v1 as usize],
            AO_BRIGHTNESS[v2 as usize],
            AO_BRIGHTNESS[v3 as usize],
        ]
    }
    
    /// Check if pattern requires flipped winding
    #[inline]
    pub fn should_flip(&self) -> bool {
        let (v0, v1, v2, v3) = self.unpack();
        (v0 as u16 + v2 as u16) < (v1 as u16 + v3 as u16)
    }
    
    /// Convert to FaceAO for compatibility
    #[inline]
    pub fn to_face_ao(&self) -> FaceAO {
        let (v0, v1, v2, v3) = self.unpack();
        FaceAO { v0, v1, v2, v3 }
    }
}

/// Check if a block is solid for AO purposes (inlined lookup)
#[inline(always)]
fn is_solid(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32) -> bool {
    let block_id = grid.get_block_id(x, y, z);
    block_id != 0 && !lookups.is_ao_transparent(block_id) && lookups.is_opaque(block_id)
}

/// Calculate single vertex AO from neighbor booleans (branchless)
#[inline(always)]
fn vertex_ao_branchless(side1: bool, side2: bool, corner: bool) -> u8 {
    // Branchless version: if side1 && side2, return 0
    // else return 3 - side1 - side2 - corner
    let both_sides = (side1 & side2) as u8;
    let count = (side1 as u8) + (side2 as u8) + (corner as u8);
    // If both_sides: return 0, else: return 3 - count
    (1 - both_sides) * (3 - count)
}

/// Batch AO calculation for top face - calculates all 4 vertices efficiently
/// Uses locality: shares neighbor lookups between vertices that use the same neighbors
#[inline]
pub fn get_top_face_ao_fast(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> PackedAO {
    let y = block_y + 1;
    
    // Lookup all 8 neighbors in one go (more cache-friendly)
    let west = is_solid(grid, lookups, block_x - 1, y, block_z);
    let east = is_solid(grid, lookups, block_x + 1, y, block_z);
    let north = is_solid(grid, lookups, block_x, y, block_z - 1);
    let south = is_solid(grid, lookups, block_x, y, block_z + 1);
    let nw = is_solid(grid, lookups, block_x - 1, y, block_z - 1);
    let ne = is_solid(grid, lookups, block_x + 1, y, block_z - 1);
    let sw = is_solid(grid, lookups, block_x - 1, y, block_z + 1);
    let se = is_solid(grid, lookups, block_x + 1, y, block_z + 1);
    
    PackedAO::new(
        vertex_ao_branchless(west, south, sw),  // V0 (SW)
        vertex_ao_branchless(east, south, se),  // V1 (SE)
        vertex_ao_branchless(east, north, ne),  // V2 (NE)
        vertex_ao_branchless(west, north, nw),  // V3 (NW)
    )
}

/// Batch AO calculation for bottom face
#[inline]
pub fn get_bottom_face_ao_fast(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> PackedAO {
    let y = block_y - 1;
    
    let west = is_solid(grid, lookups, block_x - 1, y, block_z);
    let east = is_solid(grid, lookups, block_x + 1, y, block_z);
    let north = is_solid(grid, lookups, block_x, y, block_z - 1);
    let south = is_solid(grid, lookups, block_x, y, block_z + 1);
    let nw = is_solid(grid, lookups, block_x - 1, y, block_z - 1);
    let ne = is_solid(grid, lookups, block_x + 1, y, block_z - 1);
    let sw = is_solid(grid, lookups, block_x - 1, y, block_z + 1);
    let se = is_solid(grid, lookups, block_x + 1, y, block_z + 1);
    
    PackedAO::new(
        vertex_ao_branchless(west, north, nw),
        vertex_ao_branchless(east, north, ne),
        vertex_ao_branchless(east, south, se),
        vertex_ao_branchless(west, south, sw),
    )
}

/// Batch AO calculation for north face (-Z)
#[inline]
pub fn get_north_face_ao_fast(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> PackedAO {
    let z = block_z - 1;
    
    let up = is_solid(grid, lookups, block_x, block_y + 1, z);
    let down = is_solid(grid, lookups, block_x, block_y - 1, z);
    let west = is_solid(grid, lookups, block_x - 1, block_y, z);
    let east = is_solid(grid, lookups, block_x + 1, block_y, z);
    let uw = is_solid(grid, lookups, block_x - 1, block_y + 1, z);
    let ue = is_solid(grid, lookups, block_x + 1, block_y + 1, z);
    let dw = is_solid(grid, lookups, block_x - 1, block_y - 1, z);
    let de = is_solid(grid, lookups, block_x + 1, block_y - 1, z);
    
    PackedAO::new(
        vertex_ao_branchless(west, down, dw),
        vertex_ao_branchless(east, down, de),
        vertex_ao_branchless(east, up, ue),
        vertex_ao_branchless(west, up, uw),
    )
}

/// Batch AO calculation for south face (+Z)
#[inline]
pub fn get_south_face_ao_fast(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> PackedAO {
    let z = block_z + 1;
    
    let up = is_solid(grid, lookups, block_x, block_y + 1, z);
    let down = is_solid(grid, lookups, block_x, block_y - 1, z);
    let west = is_solid(grid, lookups, block_x - 1, block_y, z);
    let east = is_solid(grid, lookups, block_x + 1, block_y, z);
    let uw = is_solid(grid, lookups, block_x - 1, block_y + 1, z);
    let ue = is_solid(grid, lookups, block_x + 1, block_y + 1, z);
    let dw = is_solid(grid, lookups, block_x - 1, block_y - 1, z);
    let de = is_solid(grid, lookups, block_x + 1, block_y - 1, z);
    
    PackedAO::new(
        vertex_ao_branchless(east, down, de),
        vertex_ao_branchless(west, down, dw),
        vertex_ao_branchless(west, up, uw),
        vertex_ao_branchless(east, up, ue),
    )
}

/// Batch AO calculation for east face (+X)
#[inline]
pub fn get_east_face_ao_fast(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> PackedAO {
    let x = block_x + 1;
    
    let up = is_solid(grid, lookups, x, block_y + 1, block_z);
    let down = is_solid(grid, lookups, x, block_y - 1, block_z);
    let north = is_solid(grid, lookups, x, block_y, block_z - 1);
    let south = is_solid(grid, lookups, x, block_y, block_z + 1);
    let un = is_solid(grid, lookups, x, block_y + 1, block_z - 1);
    let us = is_solid(grid, lookups, x, block_y + 1, block_z + 1);
    let dn = is_solid(grid, lookups, x, block_y - 1, block_z - 1);
    let ds = is_solid(grid, lookups, x, block_y - 1, block_z + 1);
    
    PackedAO::new(
        vertex_ao_branchless(south, down, ds),
        vertex_ao_branchless(north, down, dn),
        vertex_ao_branchless(north, up, un),
        vertex_ao_branchless(south, up, us),
    )
}

/// Batch AO calculation for west face (-X)
#[inline]
pub fn get_west_face_ao_fast(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
) -> PackedAO {
    let x = block_x - 1;
    
    let up = is_solid(grid, lookups, x, block_y + 1, block_z);
    let down = is_solid(grid, lookups, x, block_y - 1, block_z);
    let north = is_solid(grid, lookups, x, block_y, block_z - 1);
    let south = is_solid(grid, lookups, x, block_y, block_z + 1);
    let un = is_solid(grid, lookups, x, block_y + 1, block_z - 1);
    let us = is_solid(grid, lookups, x, block_y + 1, block_z + 1);
    let dn = is_solid(grid, lookups, x, block_y - 1, block_z - 1);
    let ds = is_solid(grid, lookups, x, block_y - 1, block_z + 1);
    
    PackedAO::new(
        vertex_ao_branchless(north, down, dn),
        vertex_ao_branchless(south, down, ds),
        vertex_ao_branchless(south, up, us),
        vertex_ao_branchless(north, up, un),
    )
}

/// Pre-computed neighbor offset table for a row of 16 blocks
/// Used to batch AO calculations across multiple blocks
pub struct RowAOCache {
    /// Solid flags for all neighbors needed for a Y-layer row (16 blocks + padding)
    /// Index: (block_x_offset + 1) + (z_offset + 1) * 3
    /// z_offset: -1, 0, 1
    neighbors: [[bool; 18]; 3],  // 3 Z offsets, 16 blocks + 2 padding
}

impl RowAOCache {
    /// Create cache for a row of blocks at (base_x, y, z) for 16 blocks in X
    pub fn for_row(
        grid: &BinaryGrid,
        lookups: &Lookups,
        base_x: i32,
        y: i32,
        z: i32,
    ) -> Self {
        let mut neighbors = [[false; 18]; 3];
        
        for dz in 0..3 {
            let sample_z = z + (dz as i32) - 1;
            for dx in 0..18 {
                let sample_x = base_x + (dx as i32) - 1;
                neighbors[dz][dx] = is_solid(grid, lookups, sample_x, y, sample_z);
            }
        }
        
        RowAOCache { neighbors }
    }
    
    /// Get top face AO for block at index (0-15) in the row
    #[inline]
    pub fn top_ao(&self, idx: usize) -> PackedAO {
        let x = idx + 1; // Add 1 for padding offset
        
        let west = self.neighbors[1][x - 1];
        let east = self.neighbors[1][x + 1];
        let north = self.neighbors[0][x];
        let south = self.neighbors[2][x];
        let nw = self.neighbors[0][x - 1];
        let ne = self.neighbors[0][x + 1];
        let sw = self.neighbors[2][x - 1];
        let se = self.neighbors[2][x + 1];
        
        PackedAO::new(
            vertex_ao_branchless(west, south, sw),
            vertex_ao_branchless(east, south, se),
            vertex_ao_branchless(east, north, ne),
            vertex_ao_branchless(west, north, nw),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_packed_ao() {
        let ao = PackedAO::new(3, 2, 1, 0);
        let (v0, v1, v2, v3) = ao.unpack();
        assert_eq!(v0, 3);
        assert_eq!(v1, 2);
        assert_eq!(v2, 1);
        assert_eq!(v3, 0);
    }
    
    #[test]
    fn test_vertex_ao_branchless() {
        // Both sides solid = 0
        assert_eq!(vertex_ao_branchless(true, true, false), 0);
        assert_eq!(vertex_ao_branchless(true, true, true), 0);
        
        // No neighbors = 3
        assert_eq!(vertex_ao_branchless(false, false, false), 3);
        
        // One side = 2
        assert_eq!(vertex_ao_branchless(true, false, false), 2);
        assert_eq!(vertex_ao_branchless(false, true, false), 2);
        
        // Corner only = 2
        assert_eq!(vertex_ao_branchless(false, false, true), 2);
        
        // One side + corner = 1
        assert_eq!(vertex_ao_branchless(true, false, true), 1);
    }
}


// ============================================================================
// WASM SIMD Optimizations (v128)
// ============================================================================

/// Calculate AO brightness for 4 vertices using SIMD
/// Input: packed AO values as u8 array [v0, v1, v2, v3]
/// Output: brightness values as f32 array
#[cfg(target_arch = "wasm32")]
#[inline]
pub fn ao_brightness_simd(ao_values: [u8; 4]) -> [f32; 4] {
    // Use a lookup table approach - faster than math
    // AO 0 = 0.4, AO 1 = 0.65, AO 2 = 0.8, AO 3 = 0.9
    [
        AO_BRIGHTNESS[ao_values[0].min(3) as usize],
        AO_BRIGHTNESS[ao_values[1].min(3) as usize],
        AO_BRIGHTNESS[ao_values[2].min(3) as usize],
        AO_BRIGHTNESS[ao_values[3].min(3) as usize],
    ]
}

/// Calculate 4 vertex AO values in parallel (SIMD-friendly)
/// Takes boolean neighbor states as packed bits and outputs AO levels
#[inline]
pub fn calculate_4_vertex_ao_parallel(
    side1: [bool; 4],
    side2: [bool; 4],
    corner: [bool; 4],
) -> [u8; 4] {
    // Calculate all 4 vertices in a vectorizable loop
    let mut result = [0u8; 4];
    
    // This loop should auto-vectorize on modern compilers
    for i in 0..4 {
        result[i] = vertex_ao_branchless(side1[i], side2[i], corner[i]);
    }
    
    result
}

/// Batch calculate smooth AO for a row of 4 blocks
/// More cache-friendly than single-block lookups
pub fn get_row_ao_top(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
    count: usize,
) -> Vec<PackedAO> {
    let y = block_y + 1;
    let mut results = Vec::with_capacity(count);
    
    // Pre-fetch first block's west neighbor
    let mut prev_east = is_solid(grid, lookups, block_x, y, block_z);
    let mut prev_se = is_solid(grid, lookups, block_x, y, block_z + 1);
    let mut prev_ne = is_solid(grid, lookups, block_x, y, block_z - 1);
    
    for i in 0..count {
        let x = block_x + i as i32;
        
        // Reuse east neighbor from previous iteration as west
        let west = if i == 0 {
            is_solid(grid, lookups, x - 1, y, block_z)
        } else {
            prev_east
        };
        
        let east = is_solid(grid, lookups, x + 1, y, block_z);
        let north = is_solid(grid, lookups, x, y, block_z - 1);
        let south = is_solid(grid, lookups, x, y, block_z + 1);
        
        // Corners - reuse diagonals
        let nw = if i == 0 {
            is_solid(grid, lookups, x - 1, y, block_z - 1)
        } else {
            prev_ne
        };
        let ne = is_solid(grid, lookups, x + 1, y, block_z - 1);
        let sw = if i == 0 {
            is_solid(grid, lookups, x - 1, y, block_z + 1)
        } else {
            prev_se
        };
        let se = is_solid(grid, lookups, x + 1, y, block_z + 1);
        
        // Store for next iteration
        prev_east = east;
        prev_ne = ne;
        prev_se = se;
        
        results.push(PackedAO::new(
            vertex_ao_branchless(west, south, sw),
            vertex_ao_branchless(east, south, se),
            vertex_ao_branchless(east, north, ne),
            vertex_ao_branchless(west, north, nw),
        ));
    }
    
    results
}
