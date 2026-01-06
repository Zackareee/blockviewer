//! Common types used across the mesher

/// Section size (Minecraft uses 16x16x16 sections)
pub const SECTION_SIZE: usize = 16;
pub const SECTION_VOLUME: usize = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE; // 4096

/// Block data bit masks
pub const BLOCK_ID_MASK: u16 = 0x0FFF;     // Bits 0-11 (4096 unique blocks)
pub const LEVEL_MASK: u16 = 0xF000;         // Bits 12-15 (16 levels)
pub const LEVEL_SHIFT: u16 = 12;
pub const SLAB_MASK: u16 = 0xC000;          // Bits 14-15 (4 slab types)
pub const SLAB_SHIFT: u16 = 14;
pub const SLAB_NONE: u8 = 0;
pub const SLAB_BOTTOM: u8 = 1;
pub const SLAB_TOP: u8 = 2;
pub const SLAB_DOUBLE: u8 = 3;

/// Y bounds (Minecraft 1.18+: -64 to 320 inclusive)
pub const MIN_Y: i32 = -64;
pub const MAX_Y: i32 = 321; // Exclusive upper bound (blocks can exist at Y=320)
pub const Y_SECTIONS: usize = ((MAX_Y - MIN_Y + SECTION_SIZE as i32 - 1) / SECTION_SIZE as i32) as usize; // 25 sections

/// Face directions
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Face {
    Up = 0,
    Down = 1,
    North = 2,
    South = 3,
    East = 4,
    West = 5,
}

impl Face {
    /// Get the normal vector for this face
    pub fn normal(&self) -> (f32, f32, f32) {
        match self {
            Face::Up => (0.0, 1.0, 0.0),
            Face::Down => (0.0, -1.0, 0.0),
            Face::North => (0.0, 0.0, -1.0),
            Face::South => (0.0, 0.0, 1.0),
            Face::East => (1.0, 0.0, 0.0),
            Face::West => (-1.0, 0.0, 0.0),
        }
    }

    /// Get the offset to the neighbor block for this face
    pub fn offset(&self) -> (i32, i32, i32) {
        match self {
            Face::Up => (0, 1, 0),
            Face::Down => (0, -1, 0),
            Face::North => (0, 0, -1),
            Face::South => (0, 0, 1),
            Face::East => (1, 0, 0),
            Face::West => (-1, 0, 0),
        }
    }
}

/// Fluid types
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FluidType {
    None = 0,
    Water = 1,
    Lava = 2,
}

/// Section key for sparse storage
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SectionKey {
    pub chunk_x: i32,
    pub chunk_z: i32,
    pub section_y: i32,
}

impl SectionKey {
    pub fn new(chunk_x: i32, chunk_z: i32, section_y: i32) -> Self {
        Self { chunk_x, chunk_z, section_y }
    }

    /// Create from packed u64 key
    pub fn from_packed(packed: u64) -> Self {
        Self {
            chunk_x: ((packed >> 40) as i32) - 0x800000,
            chunk_z: ((packed >> 16) as i32 & 0xFFFFFF) - 0x800000,
            section_y: (packed as i16) as i32,
        }
    }

    /// Pack into u64 for HashMap key
    pub fn to_packed(&self) -> u64 {
        let cx = (self.chunk_x + 0x800000) as u64;
        let cz = (self.chunk_z + 0x800000) as u64;
        let sy = (self.section_y as i16) as u16 as u64;
        (cx << 40) | (cz << 16) | sy
    }
}

/// Convert world Y coordinate to section index
#[inline]
pub fn world_y_to_section(world_y: i32) -> i32 {
    (world_y - MIN_Y) / SECTION_SIZE as i32
}

/// Convert section index to world Y base coordinate
#[inline]
pub fn section_to_world_y(section_y: i32) -> i32 {
    section_y * SECTION_SIZE as i32 + MIN_Y
}

/// Calculate block index within a section (YZX order)
#[inline]
pub fn block_index_in_section(local_x: usize, local_y: usize, local_z: usize) -> usize {
    local_y * SECTION_SIZE * SECTION_SIZE + local_z * SECTION_SIZE + local_x
}

/// Extract local coordinates from section index
#[inline]
pub fn index_to_local(index: usize) -> (usize, usize, usize) {
    let local_y = index / (SECTION_SIZE * SECTION_SIZE);
    let rem = index % (SECTION_SIZE * SECTION_SIZE);
    let local_z = rem / SECTION_SIZE;
    let local_x = rem % SECTION_SIZE;
    (local_x, local_y, local_z)
}

