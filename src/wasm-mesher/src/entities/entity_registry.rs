//! Entity Model Registry
//!
//! Loads and stores pre-baked entity model geometry from binary format.
//! Similar to BlockModelRegistry but for entity models.
//!
//! Binary format (baked-entities.bin):
//! ```text
//! [header]
//!   u32: magic (0x454E5459 = "ENTY")
//!   u32: version
//!   u32: entity type count
//!
//! [entity type index] (for each entity type)
//!   u16: entity type name length
//!   bytes: entity type name
//!   u32: offset to entity data
//!
//! [entity data] (for each entity type)
//!   u8: variant count
//!   u8: flags (has16Rotations, hasColorVariants, etc.)
//!   u8: rotation_source
//!   u16: base_texture_index
//!   [variant] (for each variant)
//!     u8: variant key length
//!     bytes: variant key
//!     u16: face count
//!     [face]
//!       u8: direction
//!       f32[12]: vertices (4 × 3)
//!       f32[8]: uvs (4 × 2)
//!       f32[3]: normal
//! ```

use std::collections::HashMap;
use std::sync::RwLock;
use wasm_bindgen::prelude::*;

/// Entity flags bitfield
pub const FLAG_HAS_16_ROTATIONS: u8 = 0x01;
pub const FLAG_HAS_COLOR_VARIANTS: u8 = 0x02;
pub const FLAG_HAS_MIRROR: u8 = 0x04;
pub const FLAG_NO_SHADE: u8 = 0x08;
pub const FLAG_IS_WALL_MOUNTED: u8 = 0x10;

/// Rotation source encoding
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationSource {
    Facing = 0,      // 4 rotations from facing property
    Rotation = 1,    // 16 rotations from rotation property
    Nbt = 2,         // Rotation stored in NBT
    None = 3,        // No rotation
}

impl RotationSource {
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => RotationSource::Facing,
            1 => RotationSource::Rotation,
            2 => RotationSource::Nbt,
            _ => RotationSource::None,
        }
    }
}

/// Face direction
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaceDirection {
    Down = 0,
    Up = 1,
    North = 2,
    South = 3,
    West = 4,
    East = 5,
}

impl FaceDirection {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(FaceDirection::Down),
            1 => Some(FaceDirection::Up),
            2 => Some(FaceDirection::North),
            3 => Some(FaceDirection::South),
            4 => Some(FaceDirection::West),
            5 => Some(FaceDirection::East),
            _ => None,
        }
    }
    
    pub fn normal(&self) -> [f32; 3] {
        match self {
            FaceDirection::Down => [0.0, -1.0, 0.0],
            FaceDirection::Up => [0.0, 1.0, 0.0],
            FaceDirection::North => [0.0, 0.0, -1.0],
            FaceDirection::South => [0.0, 0.0, 1.0],
            FaceDirection::West => [-1.0, 0.0, 0.0],
            FaceDirection::East => [1.0, 0.0, 0.0],
        }
    }
}

/// A single face of an entity model
#[derive(Debug, Clone)]
pub struct EntityFace {
    pub direction: FaceDirection,
    pub vertices: [[f32; 3]; 4],
    pub uvs: [[f32; 2]; 4],
    pub normal: [f32; 3],
}

/// A variant of an entity model (e.g., "single", "double_left")
#[derive(Debug, Clone)]
pub struct EntityVariant {
    pub key: String,
    pub faces: Vec<EntityFace>,
}

/// An entity model type (e.g., "chest", "skull")
#[derive(Debug, Clone)]
pub struct EntityModel {
    pub name: String,
    pub flags: u8,
    pub rotation_source: RotationSource,
    pub base_texture_index: u16,
    pub variants: Vec<EntityVariant>,
}

impl EntityModel {
    pub fn has_16_rotations(&self) -> bool {
        (self.flags & FLAG_HAS_16_ROTATIONS) != 0
    }
    
    pub fn has_color_variants(&self) -> bool {
        (self.flags & FLAG_HAS_COLOR_VARIANTS) != 0
    }
    
    pub fn is_wall_mounted(&self) -> bool {
        (self.flags & FLAG_IS_WALL_MOUNTED) != 0
    }
    
    pub fn no_shade(&self) -> bool {
        (self.flags & FLAG_NO_SHADE) != 0
    }
    
    /// Get variant by key
    pub fn get_variant(&self, key: &str) -> Option<&EntityVariant> {
        self.variants.iter().find(|v| v.key == key)
    }
    
    /// Get default variant
    pub fn default_variant(&self) -> Option<&EntityVariant> {
        self.variants.first()
    }
}

/// Registry of all entity models
pub struct EntityModelRegistry {
    models: HashMap<String, EntityModel>,
    name_to_index: HashMap<String, usize>,
    models_by_index: Vec<String>,
}

impl EntityModelRegistry {
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
        if magic != 0x454E5459 {
            return Err(format!("Invalid magic: expected 0x454E5459, got 0x{:08X}", magic));
        }
        offset += 4;
        
        let version = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        if version != 1 {
            return Err(format!("Unsupported version: {}", version));
        }
        offset += 4;
        
        let entity_count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
        offset += 4;
        
        // Read entity index
        let mut entity_offsets = Vec::with_capacity(entity_count);
        let mut entity_names = Vec::with_capacity(entity_count);
        
        for _ in 0..entity_count {
            if offset + 2 > data.len() {
                return Err("Truncated entity index".to_string());
            }
            
            let name_len = u16::from_le_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;
            
            if offset + name_len + 4 > data.len() {
                return Err("Truncated entity name".to_string());
            }
            
            let name = String::from_utf8_lossy(&data[offset..offset + name_len]).to_string();
            offset += name_len;
            
            let data_offset = u32::from_le_bytes([
                data[offset], data[offset + 1], data[offset + 2], data[offset + 3]
            ]) as usize;
            offset += 4;
            
            entity_names.push(name);
            entity_offsets.push(data_offset);
        }
        
        // Data section starts here
        let data_start = offset;
        
        // Read entity data
        let mut registry = Self::new();
        
        for i in 0..entity_count {
            let entity_offset = data_start + entity_offsets[i];
            let entity = Self::read_entity_data(data, entity_offset, &entity_names[i])?;
            
            registry.name_to_index.insert(entity.name.clone(), i);
            registry.models_by_index.push(entity.name.clone());
            registry.models.insert(entity.name.clone(), entity);
        }
        
        Ok(registry)
    }
    
    fn read_entity_data(data: &[u8], mut offset: usize, name: &str) -> Result<EntityModel, String> {
        if offset + 5 > data.len() {
            return Err(format!("Truncated entity data for {}", name));
        }
        
        let variant_count = data[offset] as usize;
        offset += 1;
        
        let flags = data[offset];
        offset += 1;
        
        let rotation_source = RotationSource::from_u8(data[offset]);
        offset += 1;
        
        let base_texture_index = u16::from_le_bytes([data[offset], data[offset + 1]]);
        offset += 2;
        
        // Read variants
        let mut variants = Vec::with_capacity(variant_count);
        
        for _ in 0..variant_count {
            if offset + 1 > data.len() {
                return Err(format!("Truncated variant data for {}", name));
            }
            
            let key_len = data[offset] as usize;
            offset += 1;
            
            if offset + key_len + 2 > data.len() {
                return Err(format!("Truncated variant key for {}", name));
            }
            
            let key = String::from_utf8_lossy(&data[offset..offset + key_len]).to_string();
            offset += key_len;
            
            let face_count = u16::from_le_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;
            
            // Read faces
            // Each face: direction(1) + vertices(48) + uvs(32) + normal(12) = 93 bytes
            let mut faces = Vec::with_capacity(face_count);
            
            for _ in 0..face_count {
                if offset + 93 > data.len() {
                    return Err(format!("Truncated face data for {}", name));
                }
                
                let direction = match FaceDirection::from_u8(data[offset]) {
                    Some(d) => d,
                    None => return Err(format!("Invalid face direction: {}", data[offset])),
                };
                offset += 1;
                
                // Read vertices (4 × 3 floats)
                let mut vertices = [[0.0f32; 3]; 4];
                for v in 0..4 {
                    for c in 0..3 {
                        vertices[v][c] = f32::from_le_bytes([
                            data[offset], data[offset + 1], data[offset + 2], data[offset + 3]
                        ]);
                        offset += 4;
                    }
                }
                
                // Read UVs (4 × 2 floats)
                let mut uvs = [[0.0f32; 2]; 4];
                for v in 0..4 {
                    for c in 0..2 {
                        uvs[v][c] = f32::from_le_bytes([
                            data[offset], data[offset + 1], data[offset + 2], data[offset + 3]
                        ]);
                        offset += 4;
                    }
                }
                
                // Read normal (3 floats)
                let mut normal = [0.0f32; 3];
                for c in 0..3 {
                    normal[c] = f32::from_le_bytes([
                        data[offset], data[offset + 1], data[offset + 2], data[offset + 3]
                    ]);
                    offset += 4;
                }
                
                faces.push(EntityFace {
                    direction,
                    vertices,
                    uvs,
                    normal,
                });
            }
            
            variants.push(EntityVariant { key, faces });
        }
        
        Ok(EntityModel {
            name: name.to_string(),
            flags,
            rotation_source,
            base_texture_index,
            variants,
        })
    }
    
    /// Get entity model by name
    pub fn get(&self, name: &str) -> Option<&EntityModel> {
        self.models.get(name)
    }
    
    /// Get entity model by index
    pub fn get_by_index(&self, index: usize) -> Option<&EntityModel> {
        self.models_by_index.get(index)
            .and_then(|name| self.models.get(name))
    }
    
    /// Get index for entity name
    pub fn get_index(&self, name: &str) -> Option<usize> {
        self.name_to_index.get(name).copied()
    }
    
    /// Get number of entity types
    pub fn len(&self) -> usize {
        self.models.len()
    }
    
    /// Check if registry is empty
    pub fn is_empty(&self) -> bool {
        self.models.is_empty()
    }
}

// Global registry instance
static ENTITY_REGISTRY: RwLock<Option<EntityModelRegistry>> = RwLock::new(None);

/// Initialize the entity model registry from binary data
#[wasm_bindgen]
pub fn init_entity_model_registry(data: Vec<u8>) -> bool {
    match EntityModelRegistry::from_bytes(&data) {
        Ok(registry) => {
            let count = registry.len();
            if let Ok(mut global) = ENTITY_REGISTRY.write() {
                *global = Some(registry);
                web_sys::console::log_1(&format!(
                    "[WASM] Entity registry initialized with {} entity types", count
                ).into());
                true
            } else {
                false
            }
        }
        Err(e) => {
            web_sys::console::error_1(&format!(
                "[WASM] Failed to init entity registry: {}", e
            ).into());
            false
        }
    }
}

/// Check if entity registry is initialized
#[wasm_bindgen]
pub fn is_entity_registry_initialized() -> bool {
    ENTITY_REGISTRY.read()
        .map(|r| r.is_some())
        .unwrap_or(false)
}

/// Get access to the global entity registry
pub fn get_entity_registry() -> Option<EntityRegistryRef> {
    let guard = ENTITY_REGISTRY.read().ok()?;
    if guard.is_some() {
        Some(EntityRegistryRef { guard })
    } else {
        None
    }
}

// Wrapper to return Option of registry from RwLockReadGuard
pub struct EntityRegistryRef {
    guard: std::sync::RwLockReadGuard<'static, Option<EntityModelRegistry>>,
}

impl std::ops::Deref for EntityRegistryRef {
    type Target = EntityModelRegistry;
    
    fn deref(&self) -> &Self::Target {
        self.guard.as_ref().unwrap()
    }
}
