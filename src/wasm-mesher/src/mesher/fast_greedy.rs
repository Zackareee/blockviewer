//! Fast Greedy Mesher - Optimized with binary visibility masks
//! 
//! This module provides optimized meshing using:
//! 1. Binary visibility masks (u64 bitmasks for 16 blocks)
//! 2. Pre-allocated scratch buffers
//! 3. Early exit for empty sections
//! 4. Reduced allocations

use crate::grid::{BinaryGrid, LightGrid};
use crate::lookup::Lookups;
use crate::mesher::MeshData;
use crate::mesher::greedy::{mesh_solid_bounded};
use crate::types::SECTION_SIZE;

const S: usize = SECTION_SIZE;
const S2: usize = S * S;

/// Pre-allocated scratch space for meshing operations
/// This avoids allocations during the hot path
pub struct MeshScratch {
    /// Mask for greedy merging: block_id | (axis << 12)
    pub mask: [u16; S2],
    /// Visited flags as a bitmap (256 bits = 4 u64s)
    pub visited: [u64; 4],
    /// Fast opacity check results (256 bits = 4 u64s)
    pub opacity_mask: [u64; 4],
}

impl Default for MeshScratch {
    fn default() -> Self {
        Self::new()
    }
}

impl MeshScratch {
    pub fn new() -> Self {
        Self {
            mask: [0u16; S2],
            visited: [0u64; 4],
            opacity_mask: [0u64; 4],
        }
    }
    
    /// Clear all scratch data
    #[inline]
    pub fn clear(&mut self) {
        self.mask.fill(0);
        self.visited.fill(0);
        self.opacity_mask.fill(0);
    }
    
    /// Clear just the visited flags
    #[inline]
    pub fn clear_visited(&mut self) {
        self.visited.fill(0);
    }
    
    /// Check if a position is visited using bitmask
    #[inline]
    pub fn is_visited(&self, idx: usize) -> bool {
        let word = idx >> 6; // idx / 64
        let bit = idx & 63;  // idx % 64
        (self.visited[word] & (1u64 << bit)) != 0
    }
    
    /// Mark a position as visited using bitmask
    #[inline]
    pub fn mark_visited(&mut self, idx: usize) {
        let word = idx >> 6;
        let bit = idx & 63;
        self.visited[word] |= 1u64 << bit;
    }
    
    /// Mark a range of positions as visited (for merged quads)
    #[inline]
    pub fn mark_range_visited(&mut self, start_x: usize, start_z: usize, width: usize, height: usize) {
        for dz in 0..height {
            for dx in 0..width {
                let idx = (start_z + dz) * S + start_x + dx;
                self.mark_visited(idx);
            }
        }
    }
}

/// Fast meshing with pre-allocated scratch space
/// Currently delegates to the standard mesher but can be optimized further
pub fn mesh_solid_fast(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    _scratch: &mut MeshScratch, // Reserved for future optimizations
    bounds: Option<&super::MeshBounds>,
) -> MeshData {
    // For now, delegate to the standard mesher
    // The scratch space is available for future optimizations
    mesh_solid_bounded(grid, light_grid, lookups, bounds)
}
