//! Binary Face Culling - Fast visibility determination using bitmasks
//!
//! Uses u64 bitmasks to process 64 blocks at once for face visibility.
//! This avoids individual block lookups for each face, significantly
//! reducing the number of operations needed.
//!
//! Key insight: A face is visible if the block is solid AND the neighbor is not solid.
//! Using bitmasks: visible_faces = solid_mask & ~neighbor_solid_mask

use crate::lookup::Lookups;
use crate::types::BLOCK_ID_MASK;

/// Size of a section (16x16x16)
const S: usize = 16;

/// Generate a solid block mask for a row of 16 blocks
/// Each bit represents whether that block is solid (opaque, full cube)
#[inline]
pub fn row_solid_mask(section: &[u16; 4096], base_idx: usize, lookups: &Lookups) -> u16 {
    let mut mask = 0u16;
    for i in 0..S {
        let value = section[base_idx + i];
        let block_id = value & BLOCK_ID_MASK;
        if block_id != 0 && lookups.is_opaque(block_id) && !lookups.is_non_cube(block_id) {
            mask |= 1 << i;
        }
    }
    mask
}

/// Generate visible face masks for a row of 16 blocks in X direction
/// Returns (visible_east, visible_west) where each bit indicates face visibility
#[inline]
pub fn row_x_visibility(solid_mask: u16) -> (u16, u16) {
    // East face (+X): visible when block is solid and block to the right is not
    // Need to check: solid[i] && !solid[i+1]
    let solid_shifted_left = solid_mask << 1;  // solid[i+1] in bit i
    let visible_east = solid_mask & !solid_shifted_left;
    
    // West face (-X): visible when block is solid and block to the left is not
    // Need to check: solid[i] && !solid[i-1]
    let solid_shifted_right = solid_mask >> 1;  // solid[i-1] in bit i
    let visible_west = solid_mask & !solid_shifted_right;
    
    (visible_east, visible_west)
}

/// Count visible faces in a section using binary masks
/// Returns approximate face count for capacity estimation
pub fn estimate_visible_faces(section: &[u16; 4096], lookups: &Lookups) -> usize {
    let mut total = 0;
    
    for y in 0..S {
        for z in 0..S {
            let base = y * S * S + z * S;
            let solid = row_solid_mask(section, base, lookups);
            
            // Count X-direction faces
            let (east, west) = row_x_visibility(solid);
            total += east.count_ones() as usize + west.count_ones() as usize;
            
            // For Y/Z we need adjacent row comparison
            // This is a simplified estimate
            total += solid.count_ones() as usize * 2; // Rough Y/Z estimate
        }
    }
    
    total
}

/// Visibility masks for an entire section layer (16x16 blocks)
/// Packed as u64 groups where each group covers 4 rows of 16 blocks
pub struct LayerMasks {
    /// Solid block masks for each row (16 rows of 16 blocks = 256 bits total)
    pub solid: [u16; S],
}

impl LayerMasks {
    /// Create masks for a Y layer
    pub fn for_layer(section: &[u16; 4096], y: usize, lookups: &Lookups) -> Self {
        let mut solid = [0u16; S];
        let slice_base = y * S * S;
        
        for z in 0..S {
            solid[z] = row_solid_mask(section, slice_base + z * S, lookups);
        }
        
        LayerMasks { solid }
    }
    
    /// Get combined solid mask as u64 for first 4 rows (64 bits)
    #[inline]
    pub fn solid_u64(&self, start_row: usize) -> u64 {
        ((self.solid[start_row] as u64) |
         ((self.solid[start_row + 1] as u64) << 16) |
         ((self.solid[start_row + 2] as u64) << 32) |
         ((self.solid[start_row + 3] as u64) << 48))
    }
    
    /// Check if entire layer has no solid blocks
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.solid.iter().all(|&m| m == 0)
    }
    
    /// Get visible faces for X direction (+X, -X) for a row
    /// Returns bitmask of visible faces
    #[inline]
    pub fn x_visible(&self, z: usize) -> (u16, u16) {
        row_x_visibility(self.solid[z])
    }
    
    /// Get visible faces for Z direction (+Z, -Z) for a row
    /// Compares adjacent rows in Z
    #[inline]
    pub fn z_visible(&self, z: usize) -> (u16, u16) {
        let current = self.solid[z];
        
        // South face (+Z): visible when current is solid and next row is not
        let next = if z < S - 1 { self.solid[z + 1] } else { 0 };
        let visible_south = current & !next;
        
        // North face (-Z): visible when current is solid and prev row is not  
        let prev = if z > 0 { self.solid[z - 1] } else { 0 };
        let visible_north = current & !prev;
        
        (visible_south, visible_north)
    }
}

/// Batch process face visibility for 64 blocks using SIMD-friendly operations
/// Uses layer masks to quickly determine which faces need to be rendered
pub struct BatchFaceVisibility {
    /// Layer masks for current and adjacent layers
    pub current: LayerMasks,
    pub above: Option<LayerMasks>,
    pub below: Option<LayerMasks>,
}

impl BatchFaceVisibility {
    /// Create visibility processor for a Y layer
    pub fn for_layer(
        section: &[u16; 4096],
        y: usize,
        lookups: &Lookups,
        neighbor_above: Option<&[u16; 4096]>,
        neighbor_below: Option<&[u16; 4096]>,
    ) -> Self {
        let current = LayerMasks::for_layer(section, y, lookups);
        
        let above = if y < S - 1 {
            Some(LayerMasks::for_layer(section, y + 1, lookups))
        } else {
            neighbor_above.map(|n| LayerMasks::for_layer(n, 0, lookups))
        };
        
        let below = if y > 0 {
            Some(LayerMasks::for_layer(section, y - 1, lookups))
        } else {
            neighbor_below.map(|n| LayerMasks::for_layer(n, S - 1, lookups))
        };
        
        BatchFaceVisibility { current, above, below }
    }
    
    /// Get visible Y faces (top/bottom) for a row
    /// Returns (visible_top, visible_bottom)
    #[inline]
    pub fn y_visible(&self, z: usize) -> (u16, u16) {
        let current = self.current.solid[z];
        
        let above = self.above.as_ref().map_or(0, |a| a.solid[z]);
        let below = self.below.as_ref().map_or(0, |b| b.solid[z]);
        
        let visible_top = current & !above;
        let visible_bottom = current & !below;
        
        (visible_top, visible_bottom)
    }
    
    /// Check if this layer has any visible faces
    #[inline]
    pub fn has_visible_faces(&self) -> bool {
        if self.current.is_empty() {
            return false;
        }
        
        // Any solid block with at least one non-solid neighbor has visible faces
        for z in 0..S {
            let (e, w) = self.current.x_visible(z);
            let (s, n) = self.current.z_visible(z);
            let (t, b) = self.y_visible(z);
            
            if e | w | s | n | t | b != 0 {
                return true;
            }
        }
        
        false
    }
    
    /// Iterate over visible face positions for this layer
    /// Yields (x, z, face_mask) where face_mask has bits set for visible faces
    /// Bit 0: +X, Bit 1: -X, Bit 2: +Y, Bit 3: -Y, Bit 4: +Z, Bit 5: -Z
    pub fn iter_visible_faces(&self) -> impl Iterator<Item = (usize, usize, u8)> + '_ {
        (0..S).flat_map(move |z| {
            let (e, w) = self.current.x_visible(z);
            let (s, n) = self.current.z_visible(z);
            let (t, b) = self.y_visible(z);
            
            (0..S).filter_map(move |x| {
                let bit = 1u16 << x;
                let mut face_mask = 0u8;
                
                if e & bit != 0 { face_mask |= 1; }  // +X
                if w & bit != 0 { face_mask |= 2; }  // -X
                if t & bit != 0 { face_mask |= 4; }  // +Y
                if b & bit != 0 { face_mask |= 8; }  // -Y
                if s & bit != 0 { face_mask |= 16; } // +Z
                if n & bit != 0 { face_mask |= 32; } // -Z
                
                if face_mask != 0 {
                    Some((x, z, face_mask))
                } else {
                    None
                }
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_row_x_visibility() {
        // All solid
        let (e, w) = row_x_visibility(0xFFFF);
        assert_eq!(e, 0x8000); // Only rightmost can have east visible
        assert_eq!(w, 0x0001); // Only leftmost can have west visible
        
        // Checkerboard
        let (e, w) = row_x_visibility(0xAAAA);
        // 1010 1010 1010 1010 - every other block is solid
        assert_eq!(e, 0xAAAA); // All solid blocks have east visible
        assert_eq!(w, 0xAAAA); // All solid blocks have west visible
        
        // Single block
        let (e, w) = row_x_visibility(0x0100);
        assert_eq!(e, 0x0100);
        assert_eq!(w, 0x0100);
    }
}

