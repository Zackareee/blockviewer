//! BlockStateGrid - Sparse storage for block state IDs
//!
//! Used for non-cube blocks that need full state information
//! (slabs, stairs, fences, etc.)

use std::collections::{HashMap, HashSet};
use crate::types::{
    SectionKey, SECTION_SIZE, SECTION_VOLUME, block_index_in_section, world_y_to_section,
};

/// Sparse state grid
pub struct BlockStateGrid {
    /// Sections stored by packed key
    sections: HashMap<u64, Box<[u16; SECTION_VOLUME]>>,
    /// Track which sections have any states
    has_states: HashSet<u64>,
}

impl BlockStateGrid {
    pub fn new() -> Self {
        Self {
            sections: HashMap::new(),
            has_states: HashSet::new(),
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
            let mut has_any = false;
            for i in 0..SECTION_VOLUME {
                let val = u16::from_le_bytes([
                    data[offset + i * 2],
                    data[offset + i * 2 + 1],
                ]);
                section[i] = val;
                if val != 0 {
                    has_any = true;
                }
            }
            offset += SECTION_VOLUME * 2;

            grid.sections.insert(key, section);
            if has_any {
                grid.has_states.insert(key);
            }
        }

        grid
    }

    /// Get a section by key
    #[inline]
    pub fn get_section(&self, key: &SectionKey) -> Option<&[u16; SECTION_VOLUME]> {
        self.sections.get(&key.to_packed()).map(|s| s.as_ref())
    }

    /// Get state ID at world coordinates
    #[inline]
    pub fn get_state(&self, world_x: i32, world_y: i32, world_z: i32) -> u16 {
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
            0 // No state
        }
    }

    /// Check if a section has any non-zero states
    #[inline]
    pub fn section_has_states(&self, key: &SectionKey) -> bool {
        self.has_states.contains(&key.to_packed())
    }

    /// Iterate over sections that have states
    pub fn iter_sections_with_states(&self) -> impl Iterator<Item = (SectionKey, &[u16; SECTION_VOLUME])> {
        self.has_states.iter().filter_map(|packed| {
            self.sections.get(packed).map(|section| {
                (SectionKey::from_packed(*packed), section.as_ref())
            })
        })
    }

    /// Check if grid has any states
    pub fn is_empty(&self) -> bool {
        self.has_states.is_empty()
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

    /// Set state at a specific position in the section
    /// Also marks the section as having states if value is non-zero
    #[inline]
    pub fn set_state(&mut self, chunk_x: i32, chunk_z: i32, section_y: i32, index: usize, state_id: u16) {
        let key = SectionKey::new(chunk_x, chunk_z, section_y);
        let packed = key.to_packed();
        
        let section = self.sections.entry(packed)
            .or_insert_with(|| Box::new([0u16; SECTION_VOLUME]));
        section[index] = state_id;
        
        if state_id != 0 {
            self.has_states.insert(packed);
        }
    }

    /// Iterate over all sections (not just those with states)
    pub fn iter_sections(&self) -> impl Iterator<Item = (SectionKey, &[u16; SECTION_VOLUME])> {
        self.sections.iter().map(|(packed, section)| {
            (SectionKey::from_packed(*packed), section.as_ref())
        })
    }

    /// Merge another grid into this one (copies all sections)
    pub fn merge_from(&mut self, other: &BlockStateGrid) {
        for (packed, section) in &other.sections {
            self.sections.insert(*packed, section.clone());
            if other.has_states.contains(packed) {
                self.has_states.insert(*packed);
            }
        }
    }
}

impl Default for BlockStateGrid {
    fn default() -> Self {
        Self::new()
    }
}

