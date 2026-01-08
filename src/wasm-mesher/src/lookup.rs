//! Block property lookup tables
//!
//! These tables are initialized once from JavaScript and stored in static memory
//! for fast access during meshing.

use std::sync::OnceLock;

/// Maximum block ID (12-bit = 4096)
const MAX_BLOCK_ID: usize = 4096;

/// Lookup tables for block properties
pub struct Lookups {
    pub is_opaque: &'static [u8],
    pub is_non_cube: &'static [u8],
    pub is_slab: &'static [u8],
    pub is_fluid: &'static [u8],
    pub is_glass: &'static [u8],
    pub is_ao_transparent: &'static [u8],
    pub is_rotatable: &'static [u8],    // Blocks that can have axis rotation (logs, pillars)
    pub is_directional: &'static [u8],  // Blocks with horizontal facing (furnace, loom, etc.)
    pub color_r: &'static [f32],
    pub color_g: &'static [f32],
    pub color_b: &'static [f32],
    pub face_tint_types: &'static [u8],
    pub texture_indices: &'static [f32],
    // Fluid-specific data
    pub water_still_idx: f32,
    pub water_flow_idx: f32,
    pub lava_still_idx: f32,
    pub lava_flow_idx: f32,
    pub water_color: (f32, f32, f32),
    pub lava_color: (f32, f32, f32),
}

/// Static storage for lookup tables
static LOOKUP_STORAGE: OnceLock<LookupStorage> = OnceLock::new();

struct LookupStorage {
    is_opaque: Vec<u8>,
    is_non_cube: Vec<u8>,
    is_slab: Vec<u8>,
    is_fluid: Vec<u8>,
    is_glass: Vec<u8>,
    is_ao_transparent: Vec<u8>,
    is_rotatable: Vec<u8>,
    is_directional: Vec<u8>,
    color_r: Vec<f32>,
    color_g: Vec<f32>,
    color_b: Vec<f32>,
    face_tint_types: Vec<u8>,
    texture_indices: Vec<f32>,
    // Fluid-specific data
    water_still_idx: f32,
    water_flow_idx: f32,
    lava_still_idx: f32,
    lava_flow_idx: f32,
    water_color: (f32, f32, f32),
    lava_color: (f32, f32, f32),
}

impl Lookups {
    /// Create lookups from static storage
    pub fn get() -> Option<Self> {
        LOOKUP_STORAGE.get().map(|storage| Self {
            is_opaque: &storage.is_opaque,
            is_non_cube: &storage.is_non_cube,
            is_slab: &storage.is_slab,
            is_fluid: &storage.is_fluid,
            is_glass: &storage.is_glass,
            is_ao_transparent: &storage.is_ao_transparent,
            is_rotatable: &storage.is_rotatable,
            is_directional: &storage.is_directional,
            color_r: &storage.color_r,
            color_g: &storage.color_g,
            color_b: &storage.color_b,
            face_tint_types: &storage.face_tint_types,
            texture_indices: &storage.texture_indices,
            water_still_idx: storage.water_still_idx,
            water_flow_idx: storage.water_flow_idx,
            lava_still_idx: storage.lava_still_idx,
            lava_flow_idx: storage.lava_flow_idx,
            water_color: storage.water_color,
            lava_color: storage.lava_color,
        })
    }

    /// Unsafe: create from raw pointer (for legacy API)
    pub unsafe fn from_ptr(_ptr: *const u8, _len: usize) -> Self {
        Self::get().expect("Lookups not initialized - call init_lookups first")
    }

    /// Check if block is opaque
    #[inline]
    pub fn is_opaque(&self, block_id: u16) -> bool {
        self.is_opaque.get(block_id as usize).copied().unwrap_or(0) != 0
    }

    /// Check if block is a non-cube (model block)
    #[inline]
    pub fn is_non_cube(&self, block_id: u16) -> bool {
        self.is_non_cube.get(block_id as usize).copied().unwrap_or(0) != 0
    }

    /// Check if block is a slab
    #[inline]
    pub fn is_slab(&self, block_id: u16) -> bool {
        self.is_slab.get(block_id as usize).copied().unwrap_or(0) != 0
    }

    /// Get fluid type (0=none, 1=water, 2=lava)
    #[inline]
    pub fn fluid_type(&self, block_id: u16) -> u8 {
        self.is_fluid.get(block_id as usize).copied().unwrap_or(0)
    }

    /// Check if block is glass/transparent
    #[inline]
    pub fn is_glass(&self, block_id: u16) -> bool {
        self.is_glass.get(block_id as usize).copied().unwrap_or(0) != 0
    }

    /// Check if block is AO transparent (doesn't block light for AO)
    #[inline]
    pub fn is_ao_transparent(&self, block_id: u16) -> bool {
        self.is_ao_transparent.get(block_id as usize).copied().unwrap_or(1) != 0
    }

    /// Check if block is rotatable (logs, pillars, etc.)
    #[inline]
    pub fn is_rotatable(&self, block_id: u16) -> bool {
        self.is_rotatable.get(block_id as usize).copied().unwrap_or(0) != 0
    }

    /// Check if block is directional (furnace, loom, pumpkins, etc.)
    #[inline]
    pub fn is_directional(&self, block_id: u16) -> bool {
        self.is_directional.get(block_id as usize).copied().unwrap_or(0) != 0
    }

    /// Get block color
    #[inline]
    pub fn color(&self, block_id: u16) -> (f32, f32, f32) {
        let id = block_id as usize;
        (
            self.color_r.get(id).copied().unwrap_or(1.0),
            self.color_g.get(id).copied().unwrap_or(1.0),
            self.color_b.get(id).copied().unwrap_or(1.0),
        )
    }

    /// Get tint type for a face (block_id * 6 + face)
    #[inline]
    pub fn face_tint_type(&self, block_id: u16, face: u8) -> u8 {
        let idx = block_id as usize * 6 + face as usize;
        self.face_tint_types.get(idx).copied().unwrap_or(0)
    }

    /// Get texture index for a face (block_id * 6 + face)
    #[inline]
    pub fn texture_index(&self, block_id: u16, face: u8) -> f32 {
        let idx = block_id as usize * 6 + face as usize;
        self.texture_indices.get(idx).copied().unwrap_or(0.0)
    }

    /// Get water texture index (still or flow)
    #[inline]
    pub fn water_texture(&self, flowing: bool) -> f32 {
        if flowing { self.water_flow_idx } else { self.water_still_idx }
    }

    /// Get lava texture index (still or flow)
    #[inline]
    pub fn lava_texture(&self, flowing: bool) -> f32 {
        if flowing { self.lava_flow_idx } else { self.lava_still_idx }
    }

    /// Get water color (Minecraft default: #3F76E4)
    #[inline]
    pub fn get_water_color(&self) -> (f32, f32, f32) {
        self.water_color
    }

    /// Get lava color (Minecraft: #FF6600)
    #[inline]
    pub fn get_lava_color(&self) -> (f32, f32, f32) {
        self.lava_color
    }

    /// Check if block is a particle emitter
    /// For now, this checks against known particle-emitting blocks
    #[inline]
    pub fn is_particle_emitter(&self, block_id: u16) -> bool {
        // Get block name from registry
        if let Some(name) = crate::registry::get_block_name(block_id) {
            // Check for known particle emitters
            name.contains("torch") ||
            name.contains("campfire") ||
            name.contains("candle") ||
            name.contains("fire") ||
            name == "minecraft:lava" ||
            name.contains("redstone_ore") ||
            name.contains("spawner") ||
            name.contains("enchanting_table") ||
            name.contains("end_portal") ||
            name.contains("brewing_stand") ||
            name.contains("dragon_egg")
        } else {
            false
        }
    }
}

/// Initialize lookup tables from JavaScript
/// Returns a pointer that can be passed back to mesh_chunk
pub fn init_lookups(
    is_opaque: &[u8],
    is_non_cube: &[u8],
    is_slab: &[u8],
    is_fluid: &[u8],
    is_glass: &[u8],
    is_ao_transparent: &[u8],
    is_rotatable: &[u8],
    is_directional: &[u8],
    color_r: &[f32],
    color_g: &[f32],
    color_b: &[f32],
    face_tint_types: &[u8],
    texture_indices: &[f32],
    water_still_idx: f32,
    water_flow_idx: f32,
    lava_still_idx: f32,
    lava_flow_idx: f32,
) -> *const u8 {
    let storage = LookupStorage {
        is_opaque: is_opaque.to_vec(),
        is_non_cube: is_non_cube.to_vec(),
        is_slab: is_slab.to_vec(),
        is_fluid: is_fluid.to_vec(),
        is_glass: is_glass.to_vec(),
        is_ao_transparent: is_ao_transparent.to_vec(),
        is_rotatable: is_rotatable.to_vec(),
        is_directional: is_directional.to_vec(),
        color_r: color_r.to_vec(),
        color_g: color_g.to_vec(),
        color_b: color_b.to_vec(),
        face_tint_types: face_tint_types.to_vec(),
        texture_indices: texture_indices.to_vec(),
        water_still_idx,
        water_flow_idx,
        lava_still_idx,
        lava_flow_idx,
        // Minecraft default water color: #3F76E4
        water_color: (0.247, 0.463, 0.894),
        // Minecraft lava color: #FF6600
        lava_color: (1.0, 0.4, 0.0),
    };

    let _ = LOOKUP_STORAGE.set(storage);
    
    // Return a dummy pointer - the actual data is in static storage
    std::ptr::null()
}

