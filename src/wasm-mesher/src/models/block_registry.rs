//! Block Model Registry - Block-name-based geometry lookup
//!
//! This registry uses block names and variant indices for geometry lookup,
//! solving the state ID mismatch problem between main thread and workers.
//!
//! Binary format (loaded from baked-models.bin):
//! [header]
//!   u32: magic (0x424B4D44 = "BKMD")
//!   u32: version
//!   u32: block count
//! 
//! [block index] (for each block)
//!   u16: block name length
//!   bytes: block name (UTF-8)
//!   u32: offset to block data from start of data section
//! 
//! [block data] (for each block)
//!   u8: variant count
//!   u8: flags (hasRandomRotation, hasPositionOffset, isTransparent)
//!   [variant] (for each variant)
//!     u8: variant key length
//!     bytes: variant key (UTF-8)
//!     u16: face count
//!     [face] (for each face)
//!       u8: direction
//!       u8: cullface (0xFF = no cull)
//!       u8: tint type
//!       u16: texture index
//!       f32[12]: vertices (4 vertices × 3 components)
//!       f32[8]: uvs (4 vertices × 2 components)
//!       f32[3]: normal

use std::collections::HashMap;
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;

/// Flag bits for block model behavior
pub mod block_flags {
    /// Apply position-based Y rotation (plants, cross models)
    pub const HAS_RANDOM_ROTATION: u8 = 0x01;
    /// Apply position-based XZ offset (small plants)
    pub const HAS_POSITION_OFFSET: u8 = 0x02;
    /// Render in transparent pass
    pub const IS_TRANSPARENT: u8 = 0x04;
    /// No directional shading (cross-model plants, etc.)
    pub const NO_SHADE: u8 = 0x08;
    /// Has inner opaque cube with transparent outer shell (slime_block, honey_block)
    /// Faces with cullface go to transparent mesh, faces without go to opaque
    pub const HAS_INNER_CUBE: u8 = 0x10;
}

/// Face direction constants
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FaceDirection {
    Down = 0,
    Up = 1,
    North = 2,
    South = 3,
    West = 4,
    East = 5,
    None = 6,
}

impl From<u8> for FaceDirection {
    fn from(v: u8) -> Self {
        match v {
            0 => FaceDirection::Down,
            1 => FaceDirection::Up,
            2 => FaceDirection::North,
            3 => FaceDirection::South,
            4 => FaceDirection::West,
            5 => FaceDirection::East,
            _ => FaceDirection::None,
        }
    }
}

/// A single face in a model
#[derive(Clone)]
pub struct BakedFace {
    pub direction: FaceDirection,
    pub cullface: Option<FaceDirection>, // None if no culling
    pub tint_type: u8,
    pub texture_index: u16,
    pub vertices: [[f32; 3]; 4],
    pub uvs: [[f32; 2]; 4],
    pub normal: [f32; 3],
}

/// A geometry variant for a block
#[derive(Clone)]
pub struct BlockVariant {
    pub key: String,
    pub faces: Vec<BakedFace>,
}

/// All data for a single block type
pub struct BlockModelData {
    pub name: String,
    pub flags: u8,
    pub variants: Vec<BlockVariant>,
    /// Variant key → index mapping for fast lookup
    pub variant_lookup: HashMap<String, usize>,
}

impl BlockModelData {
    /// Get a variant by key, or the first variant if not found
    pub fn get_variant(&self, key: &str) -> Option<&BlockVariant> {
        if let Some(&idx) = self.variant_lookup.get(key) {
            self.variants.get(idx)
        } else if !self.variants.is_empty() {
            Some(&self.variants[0])
        } else {
            None
        }
    }
    
    /// Get variant by index
    pub fn get_variant_by_index(&self, idx: u8) -> Option<&BlockVariant> {
        self.variants.get(idx as usize)
    }
    
    pub fn has_random_rotation(&self) -> bool {
        self.flags & block_flags::HAS_RANDOM_ROTATION != 0
    }
    
    pub fn has_position_offset(&self) -> bool {
        self.flags & block_flags::HAS_POSITION_OFFSET != 0
    }
    
    pub fn is_transparent(&self) -> bool {
        self.flags & block_flags::IS_TRANSPARENT != 0
    }
    
    pub fn has_no_shade(&self) -> bool {
        self.flags & block_flags::NO_SHADE != 0
    }
    
    pub fn has_inner_cube(&self) -> bool {
        self.flags & block_flags::HAS_INNER_CUBE != 0
    }
}

/// The block-name-based model registry
pub struct BlockModelRegistry {
    /// Block name → index
    name_to_index: HashMap<String, u16>,
    /// Index → block data
    blocks: Vec<BlockModelData>,
}

impl BlockModelRegistry {
    pub fn new() -> Self {
        Self {
            name_to_index: HashMap::new(),
            blocks: Vec::new(),
        }
    }
    
    /// Load from binary data
    pub fn load_from_binary(&mut self, data: &[u8]) -> Result<(), String> {
        if data.len() < 12 {
            return Err("Data too short for header".into());
        }
        
        let mut offset = 0;
        
        // Read header
        let magic = read_u32_le(data, &mut offset);
        if magic != 0x424B4D44 {
            return Err(format!("Invalid magic: 0x{:08X}", magic));
        }
        
        let version = read_u32_le(data, &mut offset);
        if version != 1 {
            return Err(format!("Unsupported version: {}", version));
        }
        
        let block_count = read_u32_le(data, &mut offset) as usize;
        
        // Read block index
        let mut block_index: Vec<(String, u32)> = Vec::with_capacity(block_count);
        
        for _ in 0..block_count {
            let name_len = read_u16_le(data, &mut offset) as usize;
            let name = String::from_utf8_lossy(&data[offset..offset + name_len]).to_string();
            offset += name_len;
            let data_offset = read_u32_le(data, &mut offset);
            block_index.push((name, data_offset));
        }
        
        let data_start = offset;
        
        // Read block data
        self.blocks.clear();
        self.name_to_index.clear();
        
        for (idx, (name, rel_offset)) in block_index.iter().enumerate() {
            offset = data_start + *rel_offset as usize;
            
            let variant_count = data[offset] as usize;
            offset += 1;
            
            let flags = data[offset];
            offset += 1;
            
            let mut variants = Vec::with_capacity(variant_count);
            let mut variant_lookup = HashMap::new();
            
            for v_idx in 0..variant_count {
                let key_len = data[offset] as usize;
                offset += 1;
                let key = String::from_utf8_lossy(&data[offset..offset + key_len]).to_string();
                offset += key_len;
                
                let face_count = read_u16_le(data, &mut offset) as usize;
                
                let mut faces = Vec::with_capacity(face_count);
                
                for _ in 0..face_count {
                    let direction = FaceDirection::from(data[offset]);
                    offset += 1;
                    
                    let cullface_byte = data[offset];
                    offset += 1;
                    let cullface = if cullface_byte == 0xFF {
                        None
                    } else {
                        Some(FaceDirection::from(cullface_byte))
                    };
                    
                    let tint_type = data[offset];
                    offset += 1;
                    
                    let texture_index = read_u16_le(data, &mut offset);
                    
                    // Read vertices (12 floats)
                    let mut vertices = [[0.0f32; 3]; 4];
                    for v in 0..4 {
                        for c in 0..3 {
                            vertices[v][c] = read_f32_le(data, &mut offset);
                        }
                    }
                    
                    // Read UVs (8 floats)
                    let mut uvs = [[0.0f32; 2]; 4];
                    for v in 0..4 {
                        for c in 0..2 {
                            uvs[v][c] = read_f32_le(data, &mut offset);
                        }
                    }
                    
                    // Read normal (3 floats)
                    let mut normal = [0.0f32; 3];
                    for c in 0..3 {
                        normal[c] = read_f32_le(data, &mut offset);
                    }
                    
                    faces.push(BakedFace {
                        direction,
                        cullface,
                        tint_type,
                        texture_index,
                        vertices,
                        uvs,
                        normal,
                    });
                }
                
                variant_lookup.insert(key.clone(), v_idx);
                variants.push(BlockVariant { key, faces });
            }
            
            self.name_to_index.insert(name.clone(), idx as u16);
            self.blocks.push(BlockModelData {
                name: name.clone(),
                flags,
                variants,
                variant_lookup,
            });
        }
        
        Ok(())
    }
    
    /// Get block data by name
    pub fn get_by_name(&self, name: &str) -> Option<&BlockModelData> {
        self.name_to_index.get(name)
            .and_then(|&idx| self.blocks.get(idx as usize))
    }
    
    /// Get block data by index
    pub fn get_by_index(&self, idx: u16) -> Option<&BlockModelData> {
        self.blocks.get(idx as usize)
    }
    
    /// Get block index by name
    pub fn get_index(&self, name: &str) -> Option<u16> {
        self.name_to_index.get(name).copied()
    }
    
    /// Get variant for a block with specific properties
    pub fn get_variant(&self, name: &str, variant_key: &str) -> Option<&BlockVariant> {
        self.get_by_name(name)
            .and_then(|block| block.get_variant(variant_key))
    }
    
    /// Get block count
    pub fn len(&self) -> usize {
        self.blocks.len()
    }
    
    /// Apply texture index remapping to all faces in the registry
    /// Returns the number of faces that were remapped
    pub fn apply_texture_remapping(&mut self, remapping: &[u16]) -> usize {
        let mut count = 0;
        for block in &mut self.blocks {
            for variant in &mut block.variants {
                for face in &mut variant.faces {
                    let old_idx = face.texture_index as usize;
                    if old_idx < remapping.len() {
                        face.texture_index = remapping[old_idx];
                        count += 1;
                    }
                }
            }
        }
        count
    }
    
    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }
    
    /// Get all block names
    pub fn block_names(&self) -> impl Iterator<Item = &str> {
        self.blocks.iter().map(|b| b.name.as_str())
    }
}

impl Default for BlockModelRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// Helper functions for reading binary data
fn read_u16_le(data: &[u8], offset: &mut usize) -> u16 {
    let val = u16::from_le_bytes([data[*offset], data[*offset + 1]]);
    *offset += 2;
    val
}

fn read_u32_le(data: &[u8], offset: &mut usize) -> u32 {
    let val = u32::from_le_bytes([
        data[*offset], data[*offset + 1], data[*offset + 2], data[*offset + 3]
    ]);
    *offset += 4;
    val
}

fn read_f32_le(data: &[u8], offset: &mut usize) -> f32 {
    let val = f32::from_le_bytes([
        data[*offset], data[*offset + 1], data[*offset + 2], data[*offset + 3]
    ]);
    *offset += 4;
    val
}

// Static registry instance
static BLOCK_MODEL_REGISTRY: OnceLock<BlockModelRegistry> = OnceLock::new();

/// Initialize the block model registry from baked binary data with optional texture remapping
/// 
/// If texture_remapping is provided (non-empty), it maps baked texture indices to atlas indices:
/// new_texture_index = remapping[original_texture_index]
#[wasm_bindgen]
pub fn init_block_model_registry(data: Vec<u8>, texture_remapping: Option<Vec<u16>>) -> bool {
    let mut registry = BlockModelRegistry::new();
    
    match registry.load_from_binary(&data) {
        Ok(()) => {
            // Apply texture remapping if provided
            if let Some(remapping) = texture_remapping {
                if !remapping.is_empty() {
                    let remapped_count = registry.apply_texture_remapping(&remapping);
                    web_sys::console::log_1(
                        &format!("[WASM] Applied texture remapping to {} faces", remapped_count).into()
                    );
                }
            }
            
            let count = registry.len();
            if BLOCK_MODEL_REGISTRY.set(registry).is_err() {
                web_sys::console::warn_1(&"Block model registry already initialized".into());
                return false;
            }
            web_sys::console::log_1(
                &format!("[WASM] Block model registry initialized with {} blocks", count).into()
            );
            true
        }
        Err(e) => {
            web_sys::console::error_1(&format!("[WASM] Failed to load block model registry: {}", e).into());
            false
        }
    }
}

/// Check if block model registry is initialized
#[wasm_bindgen]
pub fn is_block_model_registry_initialized() -> bool {
    BLOCK_MODEL_REGISTRY.get().is_some()
}

/// Get block index by name
#[wasm_bindgen]
pub fn get_block_model_index(name: &str) -> i32 {
    BLOCK_MODEL_REGISTRY.get()
        .and_then(|r| r.get_index(name))
        .map(|idx| idx as i32)
        .unwrap_or(-1)
}

/// Get variant count for a block
#[wasm_bindgen]
pub fn get_block_variant_count(name: &str) -> u32 {
    BLOCK_MODEL_REGISTRY.get()
        .and_then(|r| r.get_by_name(name))
        .map(|b| b.variants.len() as u32)
        .unwrap_or(0)
}

/// Get block flags by name
#[wasm_bindgen]
pub fn get_block_model_flags(name: &str) -> u8 {
    BLOCK_MODEL_REGISTRY.get()
        .and_then(|r| r.get_by_name(name))
        .map(|b| b.flags)
        .unwrap_or(0)
}

/// Internal: get registry reference
pub fn get_block_model_registry() -> Option<&'static BlockModelRegistry> {
    BLOCK_MODEL_REGISTRY.get()
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_registry_creation() {
        let registry = BlockModelRegistry::new();
        assert!(registry.is_empty());
    }
}
