//! Entity State Grid
//!
//! Sparse grid storing entity state information for block entities.
//! Unlike regular blocks which use dense arrays, entities are sparse
//! (few per chunk) so we use a HashMap.
//!
//! ## EntityState Bit Layout (32 bits)
//!
//! ```text
//! [0-7]:   Entity type index (256 types max)
//! [8-15]:  Variant index (256 variants max)
//! [16-19]: Y rotation (0-15 for fine rotation, 0-3 for facing)
//! [20-23]: Color index (16 colors for beds/banners/shulkers)
//! [24-31]: Flags (hasBannerPatterns, isWallMounted, etc.)
//! ```
//!
//! ## Serialization Format
//!
//! ```text
//! u32: entity count
//! [entries]:
//!   i32: x (world coords)
//!   i32: y
//!   i32: z
//!   u32: entity state
//! ```

use std::collections::HashMap;

/// Packed entity state
pub type EntityState = u32;

/// Entity state flag bits
pub const FLAG_HAS_BANNER_PATTERNS: u32 = 1 << 24;
pub const FLAG_IS_WALL_MOUNTED: u32 = 1 << 25;
pub const FLAG_IS_LIT: u32 = 1 << 26;
pub const FLAG_IS_OPEN: u32 = 1 << 27;

/// Pack entity state from components
#[inline]
pub fn pack_entity_state(
    entity_type: u8,
    variant: u8,
    rotation: u8,
    color: u8,
    flags: u8,
) -> EntityState {
    (entity_type as u32)
        | ((variant as u32) << 8)
        | (((rotation & 0x0F) as u32) << 16)
        | (((color & 0x0F) as u32) << 20)
        | ((flags as u32) << 24)
}

/// Unpack entity type from state
#[inline]
pub fn unpack_entity_type(state: EntityState) -> u8 {
    (state & 0xFF) as u8
}

/// Unpack variant index from state
#[inline]
pub fn unpack_variant(state: EntityState) -> u8 {
    ((state >> 8) & 0xFF) as u8
}

/// Unpack rotation from state (0-15)
#[inline]
pub fn unpack_rotation(state: EntityState) -> u8 {
    ((state >> 16) & 0x0F) as u8
}

/// Unpack color index from state (0-15)
#[inline]
pub fn unpack_color(state: EntityState) -> u8 {
    ((state >> 20) & 0x0F) as u8
}

/// Unpack flags from state
#[inline]
pub fn unpack_flags(state: EntityState) -> u8 {
    ((state >> 24) & 0xFF) as u8
}

/// Check if state has banner patterns
#[inline]
pub fn has_banner_patterns(state: EntityState) -> bool {
    (state & FLAG_HAS_BANNER_PATTERNS) != 0
}

/// Check if entity is wall-mounted
#[inline]
pub fn is_wall_mounted(state: EntityState) -> bool {
    (state & FLAG_IS_WALL_MOUNTED) != 0
}

/// Position key for HashMap
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EntityPos {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

impl EntityPos {
    pub fn new(x: i32, y: i32, z: i32) -> Self {
        Self { x, y, z }
    }
}

/// Sparse grid of entity states
pub struct EntityStateGrid {
    entities: HashMap<EntityPos, EntityState>,
}

impl EntityStateGrid {
    pub fn new() -> Self {
        Self {
            entities: HashMap::new(),
        }
    }
    
    /// Create from serialized bytes
    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < 4 {
            return Err("Data too short".to_string());
        }
        
        let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        let mut offset = 4;
        
        let expected_size = 4 + count * 16; // 4 header + count * (3 i32 + 1 u32)
        if data.len() < expected_size {
            return Err(format!("Data truncated: expected {} bytes, got {}", expected_size, data.len()));
        }
        
        let mut grid = Self::new();
        
        for _ in 0..count {
            let x = i32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
            offset += 4;
            let y = i32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
            offset += 4;
            let z = i32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
            offset += 4;
            let state = u32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
            offset += 4;
            
            grid.entities.insert(EntityPos::new(x, y, z), state);
        }
        
        Ok(grid)
    }
    
    /// Serialize to bytes
    pub fn to_bytes(&self) -> Vec<u8> {
        let count = self.entities.len() as u32;
        let mut data = Vec::with_capacity(4 + self.entities.len() * 16);
        
        data.extend_from_slice(&count.to_le_bytes());
        
        for (pos, state) in &self.entities {
            data.extend_from_slice(&pos.x.to_le_bytes());
            data.extend_from_slice(&pos.y.to_le_bytes());
            data.extend_from_slice(&pos.z.to_le_bytes());
            data.extend_from_slice(&state.to_le_bytes());
        }
        
        data
    }
    
    /// Add an entity
    pub fn add(&mut self, x: i32, y: i32, z: i32, state: EntityState) {
        self.entities.insert(EntityPos::new(x, y, z), state);
    }
    
    /// Get entity at position
    pub fn get(&self, x: i32, y: i32, z: i32) -> Option<EntityState> {
        self.entities.get(&EntityPos::new(x, y, z)).copied()
    }
    
    /// Remove entity at position
    pub fn remove(&mut self, x: i32, y: i32, z: i32) -> Option<EntityState> {
        self.entities.remove(&EntityPos::new(x, y, z))
    }
    
    /// Get number of entities
    pub fn len(&self) -> usize {
        self.entities.len()
    }
    
    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.entities.is_empty()
    }
    
    /// Iterate over all entities
    pub fn iter(&self) -> impl Iterator<Item = (&EntityPos, &EntityState)> {
        self.entities.iter()
    }
    
    /// Iterate over entities in bounds
    pub fn iter_in_bounds(
        &self,
        min_x: i32,
        min_z: i32,
        max_x: i32,
        max_z: i32,
    ) -> impl Iterator<Item = (&EntityPos, &EntityState)> {
        self.entities.iter().filter(move |(pos, _)| {
            pos.x >= min_x && pos.x <= max_x && pos.z >= min_z && pos.z <= max_z
        })
    }
    
    /// Merge entities from another grid
    pub fn merge_from(&mut self, other: &EntityStateGrid) {
        for (pos, state) in &other.entities {
            self.entities.insert(*pos, *state);
        }
    }
    
    /// Clear all entities
    pub fn clear(&mut self) {
        self.entities.clear();
    }
}

impl Default for EntityStateGrid {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_pack_unpack() {
        let state = pack_entity_state(5, 2, 12, 3, 0x81);
        
        assert_eq!(unpack_entity_type(state), 5);
        assert_eq!(unpack_variant(state), 2);
        assert_eq!(unpack_rotation(state), 12);
        assert_eq!(unpack_color(state), 3);
        assert_eq!(unpack_flags(state), 0x81);
    }
    
    #[test]
    fn test_serialization() {
        let mut grid = EntityStateGrid::new();
        grid.add(10, 64, 20, pack_entity_state(1, 0, 4, 0, 0));
        grid.add(-5, 100, 30, pack_entity_state(2, 1, 8, 5, 0x01));
        
        let bytes = grid.to_bytes();
        let restored = EntityStateGrid::from_bytes(&bytes).unwrap();
        
        assert_eq!(restored.len(), 2);
        assert!(restored.get(10, 64, 20).is_some());
        assert!(restored.get(-5, 100, 30).is_some());
    }
}
