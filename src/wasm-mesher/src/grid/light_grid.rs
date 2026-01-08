//! LightGrid - Sparse storage for per-block light values
//!
//! Each byte stores:
//! - Lower 4 bits: Sky light (0-15)
//! - Upper 4 bits: Block light (0-15)

use std::collections::HashMap;
use crate::types::{
    SectionKey, SECTION_SIZE, SECTION_VOLUME, block_index_in_section, world_y_to_section,
};

/// Maximum light level
pub const MAX_LIGHT: u8 = 15;

/// Light values for a single block
#[derive(Debug, Clone, Copy, Default)]
pub struct LightValue {
    pub sky_light: u8,
    pub block_light: u8,
}

impl LightValue {
    pub fn new(sky: u8, block: u8) -> Self {
        Self {
            sky_light: sky.min(MAX_LIGHT),
            block_light: block.min(MAX_LIGHT),
        }
    }

    /// Pack into single byte
    pub fn pack(&self) -> u8 {
        (self.block_light << 4) | self.sky_light
    }

    /// Unpack from single byte
    pub fn unpack(byte: u8) -> Self {
        Self {
            sky_light: byte & 0x0F,
            block_light: (byte >> 4) & 0x0F,
        }
    }
}

/// Sparse light grid
pub struct LightGrid {
    /// Sections stored by packed key
    sections: HashMap<u64, Box<[u8; SECTION_VOLUME]>>,
    /// True if this grid contains Minecraft's pre-computed light data
    /// When true, missing sections default to 0 (dark)
    /// When false (fallback mode), missing sections default to MAX_LIGHT
    has_minecraft_data: bool,
    /// Public flag for decode module to set
    pub has_minecraft_light_data: bool,
}

impl LightGrid {
    pub fn new() -> Self {
        Self {
            sections: HashMap::new(),
            has_minecraft_data: false,
            has_minecraft_light_data: false,
        }
    }

    /// Import from serialized byte data
    /// Format: [num_sections: u32][section_key: u64, data: [u8; 4096]]...
    pub fn from_bytes(data: &[u8]) -> Self {
        let mut grid = Self::new();
        
        if data.len() < 4 {
            return grid;
        }

        let num_sections = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        let mut offset = 4;

        for _ in 0..num_sections {
            if offset + 8 + SECTION_VOLUME > data.len() {
                break;
            }

            // Read section key (packed u64)
            let key = u64::from_le_bytes([
                data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
            ]);
            offset += 8;

            // Read section data
            let mut section = Box::new([0u8; SECTION_VOLUME]);
            section.copy_from_slice(&data[offset..offset + SECTION_VOLUME]);
            offset += SECTION_VOLUME;

            grid.sections.insert(key, section);
        }

        // If we loaded any sections, we have Minecraft light data
        // Missing sections should default to 0 (dark), not MAX_LIGHT
        grid.has_minecraft_data = !grid.sections.is_empty();

        grid
    }

    /// Get a section by key
    #[inline]
    pub fn get_section(&self, key: &SectionKey) -> Option<&[u8; SECTION_VOLUME]> {
        self.sections.get(&key.to_packed()).map(|s| s.as_ref())
    }

    /// Get a section by packed key
    #[inline]
    pub fn get_section_by_packed(&self, packed: u64) -> Option<&[u8; SECTION_VOLUME]> {
        self.sections.get(&packed).map(|s| s.as_ref())
    }

    /// Get light at world coordinates
    #[inline]
    pub fn get_light(&self, world_x: i32, world_y: i32, world_z: i32) -> LightValue {
        let chunk_x = world_x.div_euclid(SECTION_SIZE as i32);
        let chunk_z = world_z.div_euclid(SECTION_SIZE as i32);
        let section_y = world_y_to_section(world_y);

        let local_x = world_x.rem_euclid(SECTION_SIZE as i32) as usize;
        let local_y = world_y.rem_euclid(SECTION_SIZE as i32) as usize;
        let local_z = world_z.rem_euclid(SECTION_SIZE as i32) as usize;

        let key = SectionKey::new(chunk_x, chunk_z, section_y);
        if let Some(section) = self.get_section(&key) {
            let idx = block_index_in_section(local_x, local_y, local_z);
            LightValue::unpack(section[idx])
        } else {
            // If we have Minecraft light data, missing sections are dark (caves, unlit areas)
            // If we don't have data (fallback mode), assume full sky light (outdoor)
            if self.has_minecraft_data {
                LightValue::new(0, 0)
            } else {
                LightValue::new(MAX_LIGHT, 0)
            }
        }
    }

    /// Get sky light at world coordinates
    #[inline]
    pub fn get_sky_light(&self, world_x: i32, world_y: i32, world_z: i32) -> u8 {
        self.get_light(world_x, world_y, world_z).sky_light
    }

    /// Get block light at world coordinates
    #[inline]
    pub fn get_block_light(&self, world_x: i32, world_y: i32, world_z: i32) -> u8 {
        self.get_light(world_x, world_y, world_z).block_light
    }

    /// Iterate over all sections
    pub fn iter_sections(&self) -> impl Iterator<Item = (SectionKey, &[u8; SECTION_VOLUME])> {
        self.sections.iter().map(|(packed, section)| {
            (SectionKey::from_packed(*packed), section.as_ref())
        })
    }

    /// Get neighbor section
    #[inline]
    pub fn get_neighbor_section(
        &self,
        key: &SectionKey,
        dx: i32,
        dy: i32,
        dz: i32,
    ) -> Option<&[u8; SECTION_VOLUME]> {
        let neighbor_key = SectionKey::new(
            key.chunk_x + dx,
            key.chunk_z + dz,
            key.section_y + dy,
        );
        self.get_section(&neighbor_key)
    }

    /// Check if grid has any sections
    pub fn is_empty(&self) -> bool {
        self.sections.is_empty()
    }

    /// Get or create a section for writing
    /// Returns a mutable reference to the section data
    pub fn get_or_create_section(&mut self, chunk_x: i32, chunk_z: i32, section_y: i32) -> &mut [u8; SECTION_VOLUME] {
        let key = SectionKey::new(chunk_x, chunk_z, section_y);
        let packed = key.to_packed();
        
        self.sections.entry(packed)
            .or_insert_with(|| Box::new([0u8; SECTION_VOLUME]))
            .as_mut()
    }
}

impl Default for LightGrid {
    fn default() -> Self {
        Self::new()
    }
}

