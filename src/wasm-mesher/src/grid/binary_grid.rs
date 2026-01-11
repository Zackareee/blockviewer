//! BinaryGrid - Sparse voxel storage for block data
//!
//! Uses 16-bit values per block:
//! - Bits 0-11: Block ID (4096 unique blocks)
//! - Bits 12-15: Fluid level / metadata

use std::collections::HashMap;
use crate::types::{
    SectionKey, SECTION_SIZE, SECTION_VOLUME, BLOCK_ID_MASK, LEVEL_MASK, LEVEL_SHIFT,
    SLAB_MASK, SLAB_SHIFT, block_index_in_section, world_y_to_section,
};

/// Sparse binary grid for block storage
pub struct BinaryGrid {
    /// Sections stored by packed key
    sections: HashMap<u64, Box<[u16; SECTION_VOLUME]>>,
}

impl BinaryGrid {
    pub fn new() -> Self {
        Self {
            sections: HashMap::new(),
        }
    }

    /// Import from serialized byte data
    /// Format: [num_sections: u32][section_key: u64, data: [u16; 4096]]...
    pub fn from_bytes(data: &[u8]) -> Self {
        let mut grid = Self::new();
        
        if data.len() < 4 {
            return grid;
        }

        let num_sections = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        let mut offset = 4;

        for _ in 0..num_sections {
            if offset + 8 + SECTION_VOLUME * 2 > data.len() {
                break;
            }

            // Read section key (packed u64)
            let key = u64::from_le_bytes([
                data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
            ]);
            offset += 8;

            // Read section data
            let mut section = Box::new([0u16; SECTION_VOLUME]);
            for i in 0..SECTION_VOLUME {
                section[i] = u16::from_le_bytes([
                    data[offset + i * 2],
                    data[offset + i * 2 + 1],
                ]);
            }
            offset += SECTION_VOLUME * 2;

            grid.sections.insert(key, section);
        }

        grid
    }

    /// Get a section by key
    #[inline]
    pub fn get_section(&self, key: &SectionKey) -> Option<&[u16; SECTION_VOLUME]> {
        self.sections.get(&key.to_packed()).map(|s| s.as_ref())
    }

    /// Get a section by packed key
    #[inline]
    pub fn get_section_by_packed(&self, packed: u64) -> Option<&[u16; SECTION_VOLUME]> {
        self.sections.get(&packed).map(|s| s.as_ref())
    }

    /// Get block value at world coordinates
    #[inline]
    pub fn get_block(&self, world_x: i32, world_y: i32, world_z: i32) -> u16 {
        let chunk_x = world_x.div_euclid(SECTION_SIZE as i32);
        let chunk_z = world_z.div_euclid(SECTION_SIZE as i32);
        let section_y = world_y_to_section(world_y);

        let local_x = world_x.rem_euclid(SECTION_SIZE as i32) as usize;
        let local_y = world_y.rem_euclid(SECTION_SIZE as i32) as usize;
        let local_z = world_z.rem_euclid(SECTION_SIZE as i32) as usize;

        let key = SectionKey::new(chunk_x, chunk_z, section_y);
        if let Some(section) = self.get_section(&key) {
            let idx = block_index_in_section(local_x, local_y, local_z);
            section[idx]
        } else {
            0 // Air
        }
    }

    /// Get block ID at world coordinates
    #[inline]
    pub fn get_block_id(&self, world_x: i32, world_y: i32, world_z: i32) -> u16 {
        self.get_block(world_x, world_y, world_z) & BLOCK_ID_MASK
    }

    /// Get fluid level at world coordinates
    #[inline]
    pub fn get_level(&self, world_x: i32, world_y: i32, world_z: i32) -> u8 {
        ((self.get_block(world_x, world_y, world_z) & LEVEL_MASK) >> LEVEL_SHIFT) as u8
    }

    /// Get slab type at world coordinates
    #[inline]
    pub fn get_slab_type(&self, world_x: i32, world_y: i32, world_z: i32) -> u8 {
        ((self.get_block(world_x, world_y, world_z) & SLAB_MASK) >> SLAB_SHIFT) as u8
    }

    /// Iterate over all sections
    pub fn iter_sections(&self) -> impl Iterator<Item = (SectionKey, &[u16; SECTION_VOLUME])> {
        self.sections.iter().map(|(packed, section)| {
            (SectionKey::from_packed(*packed), section.as_ref())
        })
    }

    /// Get or create a section for writing
    /// Returns a mutable reference to the section data
    pub fn get_or_create_section(&mut self, chunk_x: i32, chunk_z: i32, section_y: i32) -> &mut [u16; SECTION_VOLUME] {
        let key = SectionKey::new(chunk_x, chunk_z, section_y);
        let packed = key.to_packed();
        
        self.sections.entry(packed)
            .or_insert_with(|| Box::new([0u16; SECTION_VOLUME]))
            .as_mut()
    }

    /// Get a mutable section by key (for internal use)
    #[inline]
    pub fn get_section_mut(&mut self, key: &SectionKey) -> Option<&mut [u16; SECTION_VOLUME]> {
        self.sections.get_mut(&key.to_packed()).map(|s| s.as_mut())
    }

    /// Get neighbor section for a given section key and direction
    #[inline]
    pub fn get_neighbor_section(
        &self,
        key: &SectionKey,
        dx: i32,
        dy: i32,
        dz: i32,
    ) -> Option<&[u16; SECTION_VOLUME]> {
        let neighbor_key = SectionKey::new(
            key.chunk_x + dx,
            key.chunk_z + dz,
            key.section_y + dy,
        );
        self.get_section(&neighbor_key)
    }

    /// Merge another grid into this one (copies all sections)
    pub fn merge_from(&mut self, other: &BinaryGrid) {
        for (packed, section) in &other.sections {
            self.sections.insert(*packed, section.clone());
        }
    }
}

impl Default for BinaryGrid {
    fn default() -> Self {
        Self::new()
    }
}

