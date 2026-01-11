//! Model State Grid - Compact representation of block model states
//!
//! Uses a 32-bit packed format that encodes:
//! - Block index (12 bits): Index into BlockModelRegistry
//! - Variant index (8 bits): Which variant of the block
//! - Rotation (4 bits): Y-rotation in 90° increments (0, 1, 2, 3 = 0°, 90°, 180°, 270°)
//! - Flags (8 bits): Additional state flags (flipped, waterlogged, lit, etc.)
//!
//! This format allows workers to encode block states without needing
//! to match state IDs with the main thread.

use std::collections::HashMap;
use crate::types::SectionKey;

/// Packed model state (32 bits)
/// 
/// Bit layout:
/// - [0-11]: Block index (12 bits, 4096 blocks max)
/// - [12-19]: Variant index (8 bits, 256 variants max)
/// - [20-23]: Rotation (4 bits, 0-3 = 0°/90°/180°/270°)
/// - [24-31]: Flags (8 bits)
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
#[repr(transparent)]
pub struct ModelState(pub u32);

/// Flag bits for model state
pub mod state_flags {
    /// Block is vertically flipped (half=top for stairs)
    pub const FLIPPED: u8 = 0x01;
    /// Block is waterlogged
    pub const WATERLOGGED: u8 = 0x02;
    /// Block is lit (torches, lanterns)
    pub const LIT: u8 = 0x04;
    /// Block is powered (redstone)
    pub const POWERED: u8 = 0x08;
    /// Block is open (doors, trapdoors)
    pub const OPEN: u8 = 0x10;
    /// Block has overlay (grass side overlay)
    pub const HAS_OVERLAY: u8 = 0x20;
}

impl ModelState {
    /// Create a new model state
    pub fn new(block_idx: u16, variant_idx: u8, rotation: u8, flags: u8) -> Self {
        let packed = (block_idx as u32 & 0xFFF)
            | ((variant_idx as u32 & 0xFF) << 12)
            | ((rotation as u32 & 0xF) << 20)
            | ((flags as u32 & 0xFF) << 24);
        Self(packed)
    }
    
    /// Create an empty (air) model state
    pub fn empty() -> Self {
        Self(0)
    }
    
    /// Check if this is an empty state (no block)
    pub fn is_empty(&self) -> bool {
        self.0 == 0
    }
    
    /// Get block index (0-4095)
    pub fn block_index(&self) -> u16 {
        (self.0 & 0xFFF) as u16
    }
    
    /// Get variant index (0-255)
    pub fn variant_index(&self) -> u8 {
        ((self.0 >> 12) & 0xFF) as u8
    }
    
    /// Get rotation (0-3, representing 0°/90°/180°/270°)
    pub fn rotation(&self) -> u8 {
        ((self.0 >> 20) & 0xF) as u8
    }
    
    /// Get rotation in degrees
    pub fn rotation_degrees(&self) -> i32 {
        (self.rotation() as i32) * 90
    }
    
    /// Get flags byte
    pub fn flags(&self) -> u8 {
        ((self.0 >> 24) & 0xFF) as u8
    }
    
    /// Check if block is vertically flipped
    pub fn is_flipped(&self) -> bool {
        self.flags() & state_flags::FLIPPED != 0
    }
    
    /// Check if block is waterlogged
    pub fn is_waterlogged(&self) -> bool {
        self.flags() & state_flags::WATERLOGGED != 0
    }
    
    /// Check if block is lit
    pub fn is_lit(&self) -> bool {
        self.flags() & state_flags::LIT != 0
    }
    
    /// Check if block is powered
    pub fn is_powered(&self) -> bool {
        self.flags() & state_flags::POWERED != 0
    }
    
    /// Check if block is open
    pub fn is_open(&self) -> bool {
        self.flags() & state_flags::OPEN != 0
    }
}

/// Model state grid - stores ModelState for each block position
pub struct ModelStateGrid {
    sections: HashMap<SectionKey, Box<[ModelState; 4096]>>,
}

impl ModelStateGrid {
    pub fn new() -> Self {
        Self {
            sections: HashMap::new(),
        }
    }
    
    /// Deserialize from binary data
    /// 
    /// Format:
    /// [u32: section count]
    /// For each section:
    ///   [u64: packed section key]
    ///   [u32 × 4096: model states]
    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < 4 {
            return Err("Data too short".into());
        }
        
        let section_count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        
        let expected_size = 4 + section_count * (8 + 4096 * 4);
        if data.len() < expected_size {
            return Err(format!(
                "Data too short: expected {} bytes, got {}",
                expected_size, data.len()
            ));
        }
        
        let mut grid = ModelStateGrid::new();
        let mut offset = 4;
        
        for _ in 0..section_count {
            let packed = u64::from_le_bytes([
                data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
            ]);
            offset += 8;
            
            // Unpack section key
            let chunk_x = ((packed >> 40) & 0xFFFFFF) as i32 - 0x800000;
            let chunk_z = ((packed >> 16) & 0xFFFFFF) as i32 - 0x800000;
            let section_y = (packed & 0xFFFF) as i16 as i32;
            
            let key = SectionKey { chunk_x, chunk_z, section_y };
            
            // Read states
            let mut section = Box::new([ModelState::empty(); 4096]);
            for i in 0..4096 {
                section[i] = ModelState(u32::from_le_bytes([
                    data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                ]));
                offset += 4;
            }
            
            grid.sections.insert(key, section);
        }
        
        Ok(grid)
    }
    
    /// Get a model state at world coordinates
    pub fn get(&self, x: i32, y: i32, z: i32) -> ModelState {
        let chunk_x = x >> 4;
        let chunk_z = z >> 4;
        let section_y = (y + 64) >> 4;
        
        let local_x = (x & 0xF) as usize;
        let local_y = ((y + 64) & 0xF) as usize;
        let local_z = (z & 0xF) as usize;
        
        let key = SectionKey { chunk_x, chunk_z, section_y };
        
        if let Some(section) = self.sections.get(&key) {
            let idx = local_y * 256 + local_z * 16 + local_x;
            section[idx]
        } else {
            ModelState::empty()
        }
    }
    
    /// Set a model state at world coordinates
    pub fn set(&mut self, x: i32, y: i32, z: i32, state: ModelState) {
        let chunk_x = x >> 4;
        let chunk_z = z >> 4;
        let section_y = (y + 64) >> 4;
        
        let local_x = (x & 0xF) as usize;
        let local_y = ((y + 64) & 0xF) as usize;
        let local_z = (z & 0xF) as usize;
        
        let key = SectionKey { chunk_x, chunk_z, section_y };
        
        let section = self.sections.entry(key).or_insert_with(|| {
            Box::new([ModelState::empty(); 4096])
        });
        
        let idx = local_y * 256 + local_z * 16 + local_x;
        section[idx] = state;
    }
    
    /// Iterate over all sections
    pub fn iter_sections(&self) -> impl Iterator<Item = (&SectionKey, &[ModelState; 4096])> {
        self.sections.iter().map(|(k, v)| (k, v.as_ref()))
    }
    
    /// Iterate over sections that have non-empty states
    pub fn iter_sections_with_states(&self) -> impl Iterator<Item = (&SectionKey, &[ModelState; 4096])> {
        self.sections.iter()
            .filter(|(_, section)| section.iter().any(|s| !s.is_empty()))
            .map(|(k, v)| (k, v.as_ref()))
    }
    
    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.sections.is_empty()
    }
    
    /// Get section count
    pub fn section_count(&self) -> usize {
        self.sections.len()
    }
}

impl Default for ModelStateGrid {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_model_state_packing() {
        let state = ModelState::new(100, 5, 2, state_flags::FLIPPED | state_flags::LIT);
        
        assert_eq!(state.block_index(), 100);
        assert_eq!(state.variant_index(), 5);
        assert_eq!(state.rotation(), 2);
        assert_eq!(state.rotation_degrees(), 180);
        assert!(state.is_flipped());
        assert!(state.is_lit());
        assert!(!state.is_waterlogged());
    }
    
    #[test]
    fn test_empty_state() {
        let state = ModelState::empty();
        assert!(state.is_empty());
        assert_eq!(state.block_index(), 0);
    }
}
