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

/// Axis encoding for rotatable blocks (stored in bits 12-13)
pub const AXIS_SHIFT: u16 = 12;
pub const AXIS_MASK: u16 = 0x3000;          // Bits 12-13 (3 axis values)
pub const AXIS_Y: u8 = 0;                    // Default vertical orientation
pub const AXIS_X: u8 = 1;                    // East-west horizontal
pub const AXIS_Z: u8 = 2;                    // North-south horizontal

/// Facing encoding for directional blocks (uses same bits 12-13 as axis, mutually exclusive)
/// Facing values represent which direction the "front" face points
pub const FACING_SHIFT: u16 = 12;
pub const FACING_MASK: u16 = 0x3000;        // Bits 12-13 (4 facing values)
pub const FACING_NORTH: u8 = 0;              // Default: front faces -Z
pub const FACING_EAST: u8 = 1;               // Front faces +X
pub const FACING_SOUTH: u8 = 2;              // Front faces +Z
pub const FACING_WEST: u8 = 3;               // Front faces -X

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

/// Extract axis from block value (bits 12-13)
#[inline]
pub fn get_block_axis(block_value: u16) -> u8 {
    ((block_value & AXIS_MASK) >> AXIS_SHIFT) as u8
}

/// Extract facing from block value (bits 12-13) - same bits as axis, mutually exclusive
#[inline]
pub fn get_block_facing(block_value: u16) -> u8 {
    ((block_value & FACING_MASK) >> FACING_SHIFT) as u8
}

/// Remap face for directional blocks based on facing direction
/// TextureIndexLookup is built assuming north = front, so we remap the actual face
/// to get the correct texture when the block faces a different direction
/// 
/// facing=north (0): no remapping
/// facing=east  (1): rotate 90° clockwise
/// facing=south (2): rotate 180°
/// facing=west  (3): rotate 270° (90° counter-clockwise)
#[inline]
pub fn get_directional_face(facing: u8, actual_face: Face) -> Face {
    match facing {
        FACING_NORTH => actual_face, // Default orientation, no remapping
        FACING_EAST => {
            // Block faces east: east->north, north->west, west->south, south->east
            match actual_face {
                Face::North => Face::West,
                Face::East => Face::North,
                Face::South => Face::East,
                Face::West => Face::South,
                _ => actual_face, // Up/Down unchanged
            }
        }
        FACING_SOUTH => {
            // Block faces south: north->south, south->north, east->west, west->east
            match actual_face {
                Face::North => Face::South,
                Face::South => Face::North,
                Face::East => Face::West,
                Face::West => Face::East,
                _ => actual_face, // Up/Down unchanged
            }
        }
        FACING_WEST => {
            // Block faces west: west->north, north->east, east->south, south->west
            match actual_face {
                Face::North => Face::East,
                Face::East => Face::South,
                Face::South => Face::West,
                Face::West => Face::North,
                _ => actual_face, // Up/Down unchanged
            }
        }
        _ => actual_face,
    }
}

/// Get the effective face direction for texture lookup on a rotated block
/// Maps the actual face to the "logical" face for texture selection
#[inline]
pub fn get_rotated_face(axis: u8, face: Face) -> Face {
    if axis == AXIS_Y {
        return face; // No remapping for default orientation
    }
    
    if axis == AXIS_X {
        // Block is horizontal along X axis (east-west)
        // East/West are now the "end" faces (like top/bottom of upright block)
        match face {
            Face::East | Face::West => Face::Up, // Use top texture
            _ => Face::North, // Use side texture
        }
    } else if axis == AXIS_Z {
        // Block is horizontal along Z axis (north-south)
        // North/South are now the "end" faces
        match face {
            Face::North | Face::South => Face::Up, // Use top texture
            _ => Face::East, // Use side texture
        }
    } else {
        face
    }
}

/// Calculate texture rotation for a rotated block face
/// Matches Minecraft's cube_column model UV behavior
/// Returns: 0=0°, 1=90°, 2=180°, 3=270°
#[inline]
pub fn get_texture_rotation(axis: u8, face: Face) -> f32 {
    if axis == AXIS_Y {
        // Vertical logs: no rotation needed
        return 0.0;
    }
    
    if axis == AXIS_X {
        // Block is horizontal along X axis (east-west)
        match face {
            Face::East => 2.0,  // 180° rotation (from model's UP face rotation)
            Face::West => 0.0,  // No rotation
            _ => 1.0,           // All bark faces need 90° rotation
        }
    } else if axis == AXIS_Z {
        // Block is horizontal along Z axis (north-south)
        match face {
            Face::South => 2.0, // 180° rotation
            Face::North => 0.0, // No rotation
            Face::East | Face::West => 1.0, // 90° rotation for side bark
            _ => 0.0, // TOP/BOTTOM bark faces - no rotation
        }
    } else {
        0.0
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

