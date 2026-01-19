//! Block Entity Registry
//!
//! Loads and stores pre-baked block entity model geometry from the binary format
//! produced by bake-block-entities.js.
//!
//! Binary format (baked-block-entities.bin):
//! ```text
//! [header]
//!   u32: magic (0x424C454E = "BLEN")
//!   u32: version
//!   u32: model count
//!
//! [model index] (for each model)
//!   u16: model name length
//!   bytes: model name
//!   u32: offset to model data
//!
//! [model data] (for each model)
//!   u16: texture_width
//!   u16: texture_height
//!   u16: element count
//!   [element]
//!     f32[3]: from (x, y, z) in block space 0-1
//!     f32[3]: to (x, y, z)
//!     u8: face_mask (bits for which faces exist)
//!     [face] (for each set bit in face_mask)
//!       f32[4]: uv (u1, v1, u2, v2) normalized 0-1
//! ```

use std::collections::HashMap;
use std::sync::RwLock;
use wasm_bindgen::prelude::*;

/// Face direction encoding
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaceDir {
    Down = 0,
    Up = 1,
    North = 2,
    South = 3,
    West = 4,
    East = 5,
}

impl FaceDir {
    pub fn from_mask_index(i: u8) -> Option<Self> {
        match i {
            0 => Some(FaceDir::Down),
            1 => Some(FaceDir::Up),
            2 => Some(FaceDir::North),
            3 => Some(FaceDir::South),
            4 => Some(FaceDir::West),
            5 => Some(FaceDir::East),
            _ => None,
        }
    }
    
    pub fn normal(&self) -> [f32; 3] {
        match self {
            FaceDir::Down => [0.0, -1.0, 0.0],
            FaceDir::Up => [0.0, 1.0, 0.0],
            FaceDir::North => [0.0, 0.0, -1.0],
            FaceDir::South => [0.0, 0.0, 1.0],
            FaceDir::West => [-1.0, 0.0, 0.0],
            FaceDir::East => [1.0, 0.0, 0.0],
        }
    }
}

/// A face of an element
#[derive(Debug, Clone)]
pub struct ElementFace {
    pub direction: FaceDir,
    pub uv: [f32; 4], // u1, v1, u2, v2
}

/// An element (cube) in a model
#[derive(Debug, Clone)]
pub struct BlockElement {
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub faces: Vec<ElementFace>,
}

impl BlockElement {
    /// Get vertices for a face based on from/to bounds
    pub fn get_face_vertices(&self, dir: FaceDir) -> [[f32; 3]; 4] {
        let [x1, y1, z1] = self.from;
        let [x2, y2, z2] = self.to;
        
        match dir {
            FaceDir::Down => [
                [x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]
            ],
            FaceDir::Up => [
                [x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]
            ],
            FaceDir::North => [
                [x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]
            ],
            FaceDir::South => [
                [x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]
            ],
            FaceDir::West => [
                [x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]
            ],
            FaceDir::East => [
                [x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]
            ],
        }
    }
    
    /// Get UV coordinates for a face vertex
    pub fn get_face_uvs(&self, face: &ElementFace) -> [[f32; 2]; 4] {
        let [u1, v1, u2, v2] = face.uv;
        
        // Standard UV mapping for quad vertices
        [
            [u1, v1], // top-left
            [u2, v1], // top-right
            [u2, v2], // bottom-right
            [u1, v2], // bottom-left
        ]
    }
}

/// A block entity model
#[derive(Debug, Clone)]
pub struct BlockEntityModel {
    pub name: String,
    pub texture_width: u16,
    pub texture_height: u16,
    pub elements: Vec<BlockElement>,
}

/// Registry of all block entity models
pub struct BlockEntityRegistry {
    models: HashMap<String, BlockEntityModel>,
    name_to_index: HashMap<String, usize>,
    models_by_index: Vec<String>,
}

impl BlockEntityRegistry {
    pub fn new() -> Self {
        Self {
            models: HashMap::new(),
            name_to_index: HashMap::new(),
            models_by_index: Vec::new(),
        }
    }
    
    /// Load registry from binary data
    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < 12 {
            return Err("Data too short for header".to_string());
        }
        
        let mut offset = 0;
        
        // Read header
        let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if magic != 0x424C454E {
            return Err(format!("Invalid magic: expected 0x424C454E (BLEN), got 0x{:08X}", magic));
        }
        offset += 4;
        
        let version = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        if version != 2 {
            return Err(format!("Unsupported version: {}", version));
        }
        offset += 4;
        
        let model_count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
        offset += 4;
        
        // Read model index
        let mut model_offsets = Vec::with_capacity(model_count);
        let mut model_names = Vec::with_capacity(model_count);
        
        for _ in 0..model_count {
            if offset + 2 > data.len() {
                return Err("Truncated model index".to_string());
            }
            
            let name_len = u16::from_le_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;
            
            if offset + name_len + 4 > data.len() {
                return Err("Truncated model name".to_string());
            }
            
            let name = String::from_utf8_lossy(&data[offset..offset + name_len]).to_string();
            offset += name_len;
            
            let data_offset = u32::from_le_bytes([
                data[offset], data[offset + 1], data[offset + 2], data[offset + 3]
            ]) as usize;
            offset += 4;
            
            model_names.push(name);
            model_offsets.push(data_offset);
        }
        
        // Data section starts here
        let data_start = offset;
        
        // Read models
        let mut registry = Self::new();
        
        for i in 0..model_count {
            let model_offset = data_start + model_offsets[i];
            let model = Self::read_model_data(data, model_offset, &model_names[i])?;
            
            registry.name_to_index.insert(model.name.clone(), i);
            registry.models_by_index.push(model.name.clone());
            registry.models.insert(model.name.clone(), model);
        }
        
        Ok(registry)
    }
    
    fn read_model_data(data: &[u8], mut offset: usize, name: &str) -> Result<BlockEntityModel, String> {
        if offset + 6 > data.len() {
            return Err(format!("Truncated model data for {}", name));
        }
        
        let texture_width = u16::from_le_bytes([data[offset], data[offset + 1]]);
        offset += 2;
        
        let texture_height = u16::from_le_bytes([data[offset], data[offset + 1]]);
        offset += 2;
        
        let element_count = u16::from_le_bytes([data[offset], data[offset + 1]]) as usize;
        offset += 2;
        
        let mut elements = Vec::with_capacity(element_count);
        
        for _ in 0..element_count {
            if offset + 25 > data.len() {
                return Err(format!("Truncated element data for {}", name));
            }
            
            // From (3 floats)
            let from = [
                f32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]),
                f32::from_le_bytes([data[offset+4], data[offset+5], data[offset+6], data[offset+7]]),
                f32::from_le_bytes([data[offset+8], data[offset+9], data[offset+10], data[offset+11]]),
            ];
            offset += 12;
            
            // To (3 floats)
            let to = [
                f32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]),
                f32::from_le_bytes([data[offset+4], data[offset+5], data[offset+6], data[offset+7]]),
                f32::from_le_bytes([data[offset+8], data[offset+9], data[offset+10], data[offset+11]]),
            ];
            offset += 12;
            
            // Face mask
            let face_mask = data[offset];
            offset += 1;
            
            // Read faces
            let mut faces = Vec::new();
            for bit in 0..6 {
                if (face_mask & (1 << bit)) != 0 {
                    if offset + 16 > data.len() {
                        return Err(format!("Truncated face data for {}", name));
                    }
                    
                    let direction = FaceDir::from_mask_index(bit)
                        .ok_or_else(|| format!("Invalid face direction: {}", bit))?;
                    
                    let uv = [
                        f32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]),
                        f32::from_le_bytes([data[offset+4], data[offset+5], data[offset+6], data[offset+7]]),
                        f32::from_le_bytes([data[offset+8], data[offset+9], data[offset+10], data[offset+11]]),
                        f32::from_le_bytes([data[offset+12], data[offset+13], data[offset+14], data[offset+15]]),
                    ];
                    offset += 16;
                    
                    faces.push(ElementFace { direction, uv });
                }
            }
            
            elements.push(BlockElement { from, to, faces });
        }
        
        Ok(BlockEntityModel {
            name: name.to_string(),
            texture_width,
            texture_height,
            elements,
        })
    }
    
    /// Get model by name
    pub fn get(&self, name: &str) -> Option<&BlockEntityModel> {
        self.models.get(name)
    }
    
    /// Get model by index
    pub fn get_by_index(&self, index: usize) -> Option<&BlockEntityModel> {
        self.models_by_index.get(index)
            .and_then(|name| self.models.get(name))
    }
    
    /// Get index for model name
    pub fn get_index(&self, name: &str) -> Option<usize> {
        self.name_to_index.get(name).copied()
    }
    
    /// Get number of models
    pub fn len(&self) -> usize {
        self.models.len()
    }
    
    /// Check if registry is empty
    pub fn is_empty(&self) -> bool {
        self.models.is_empty()
    }
    
    /// Iterate over all models
    pub fn iter(&self) -> impl Iterator<Item = (&String, &BlockEntityModel)> {
        self.models.iter()
    }
}

impl Default for BlockEntityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// Global registry instance
static BLOCK_ENTITY_REGISTRY: RwLock<Option<BlockEntityRegistry>> = RwLock::new(None);

/// Initialize the block entity registry from binary data
#[wasm_bindgen]
pub fn init_block_entity_registry(data: Vec<u8>) -> bool {
    match BlockEntityRegistry::from_bytes(&data) {
        Ok(registry) => {
            let count = registry.len();
            if let Ok(mut global) = BLOCK_ENTITY_REGISTRY.write() {
                *global = Some(registry);
                web_sys::console::log_1(&format!(
                    "[WASM] Block entity registry initialized with {} models", count
                ).into());
                true
            } else {
                false
            }
        }
        Err(e) => {
            web_sys::console::error_1(&format!(
                "[WASM] Failed to init block entity registry: {}", e
            ).into());
            false
        }
    }
}

/// Check if block entity registry is initialized
#[wasm_bindgen]
pub fn is_block_entity_registry_initialized() -> bool {
    BLOCK_ENTITY_REGISTRY.read()
        .map(|r| r.is_some())
        .unwrap_or(false)
}

/// Get access to the global block entity registry
pub fn get_block_entity_registry() -> Option<BlockEntityRegistryRef> {
    let guard = BLOCK_ENTITY_REGISTRY.read().ok()?;
    if guard.is_some() {
        Some(BlockEntityRegistryRef { guard })
    } else {
        None
    }
}

/// Wrapper to return Option of registry from RwLockReadGuard
pub struct BlockEntityRegistryRef {
    guard: std::sync::RwLockReadGuard<'static, Option<BlockEntityRegistry>>,
}

impl std::ops::Deref for BlockEntityRegistryRef {
    type Target = BlockEntityRegistry;
    
    fn deref(&self) -> &Self::Target {
        self.guard.as_ref().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_face_dir_from_mask() {
        assert_eq!(FaceDir::from_mask_index(0), Some(FaceDir::Down));
        assert_eq!(FaceDir::from_mask_index(1), Some(FaceDir::Up));
        assert_eq!(FaceDir::from_mask_index(5), Some(FaceDir::East));
        assert_eq!(FaceDir::from_mask_index(6), None);
    }
}
