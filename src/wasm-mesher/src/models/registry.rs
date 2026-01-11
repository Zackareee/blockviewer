//! State and Model Registry
//!
//! Maps block state strings to state IDs and stores model geometry.
//! Initialized once from JavaScript at startup.

use std::collections::HashMap;
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;
use super::geometry::ModelGeometry;

/// Model flags - bit flags for special handling
pub mod flags {
    /// Apply position-based Y rotation (plants, cross models)
    pub const MODEL_ROTATION: u8 = 0x01;
    /// Apply position-based XZ offset (small plants)
    pub const POSITION_OFFSET: u8 = 0x02;
    /// Render in transparent pass
    pub const IS_TRANSPARENT: u8 = 0x04;
    /// Render in overlay pass
    pub const IS_OVERLAY: u8 = 0x08;
}

// ============================================================================
// Type definitions (before statics)
// ============================================================================

/// State registry containing state string -> ID mappings
pub struct StateRegistry {
    state_to_id: HashMap<String, u16>,
    block_to_states: HashMap<String, Vec<u16>>,
}

impl StateRegistry {
    pub fn new() -> Self {
        Self {
            state_to_id: HashMap::new(),
            block_to_states: HashMap::new(),
        }
    }

    pub fn add(&mut self, state_string: &str, state_id: u16) {
        self.state_to_id.insert(state_string.to_string(), state_id);
        if let Some(bracket_pos) = state_string.find('[') {
            let block_name = &state_string[..bracket_pos];
            self.block_to_states.entry(block_name.to_string()).or_default().push(state_id);
        } else {
            self.block_to_states.entry(state_string.to_string()).or_default().push(state_id);
        }
    }

    pub fn get_id(&self, state_string: &str) -> Option<u16> {
        self.state_to_id.get(state_string).copied()
    }

    pub fn len(&self) -> usize {
        self.state_to_id.len()
    }
}

impl Default for StateRegistry {
    fn default() -> Self { Self::new() }
}

/// Model registry containing state ID -> geometry mappings
pub struct ModelRegistry {
    models: HashMap<u16, ModelGeometry>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self { models: HashMap::new() }
    }

    pub fn add(&mut self, state_id: u16, geometry: ModelGeometry) {
        self.models.insert(state_id, geometry);
    }

    pub fn get(&self, state_id: u16) -> Option<&ModelGeometry> {
        self.models.get(&state_id)
    }

    pub fn len(&self) -> usize {
        self.models.len()
    }
}

impl Default for ModelRegistry {
    fn default() -> Self { Self::new() }
}

/// Enhanced model entry with metadata for rotation/offset handling
pub struct ModelEntryV2 {
    pub geometry: ModelGeometry,
    pub block_name: String,
    pub flags: u8,
}

impl ModelEntryV2 {
    pub fn needs_rotation(&self) -> bool {
        self.flags & flags::MODEL_ROTATION != 0
    }
    
    pub fn needs_offset(&self) -> bool {
        self.flags & flags::POSITION_OFFSET != 0
    }
    
    pub fn is_transparent(&self) -> bool {
        self.flags & flags::IS_TRANSPARENT != 0
    }
    
    pub fn is_overlay(&self) -> bool {
        self.flags & flags::IS_OVERLAY != 0
    }
}

/// V2 Model registry with enhanced metadata
pub struct ModelRegistryV2 {
    models: HashMap<u16, ModelEntryV2>,
}

impl ModelRegistryV2 {
    pub fn new() -> Self {
        Self { models: HashMap::new() }
    }

    pub fn add(&mut self, state_id: u16, entry: ModelEntryV2) {
        self.models.insert(state_id, entry);
    }

    pub fn get(&self, state_id: u16) -> Option<&ModelEntryV2> {
        self.models.get(&state_id)
    }

    pub fn len(&self) -> usize {
        self.models.len()
    }
}

impl Default for ModelRegistryV2 {
    fn default() -> Self { Self::new() }
}

// ============================================================================
// Static registries
// ============================================================================

static STATE_REGISTRY: OnceLock<StateRegistry> = OnceLock::new();
static MODEL_REGISTRY: OnceLock<ModelRegistry> = OnceLock::new();
static MODEL_REGISTRY_V2: OnceLock<ModelRegistryV2> = OnceLock::new();

// ============================================================================
// V1 Registry Functions
// ============================================================================

#[wasm_bindgen]
pub fn init_state_registry(state_strings: String, state_ids: Vec<u16>) {
    let mut registry = StateRegistry::new();
    for (state_str, state_id) in state_strings.lines().zip(state_ids.iter()) {
        registry.add(state_str, *state_id);
    }
    let count = registry.len();
    let _ = STATE_REGISTRY.set(registry);
    web_sys::console::log_1(&format!("[WASM] State registry initialized with {} states", count).into());
}

pub fn get_state_id(state_string: &str) -> u16 {
    STATE_REGISTRY.get().and_then(|r| r.get_id(state_string)).unwrap_or(0)
}

pub fn build_state_string(name: &str, properties: &[(String, String)]) -> String {
    if properties.is_empty() {
        return name.to_string();
    }
    let mut sorted_props: Vec<_> = properties.iter().collect();
    sorted_props.sort_by(|a, b| a.0.cmp(&b.0));
    let props_str: Vec<String> = sorted_props.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
    format!("{}[{}]", name, props_str.join(","))
}

pub fn is_state_registry_initialized() -> bool {
    STATE_REGISTRY.get().is_some()
}

#[wasm_bindgen]
pub fn init_model_registry(state_ids: Vec<u16>, geometry_data: Vec<u8>) {
    let mut registry = ModelRegistry::new();
    let mut offset = 0;
    
    for &state_id in &state_ids {
        if offset + 2 > geometry_data.len() { break; }
        let num_faces = u16::from_le_bytes([geometry_data[offset], geometry_data[offset + 1]]) as usize;
        offset += 2;
        
        let mut faces = Vec::with_capacity(num_faces);
        for _ in 0..num_faces {
            if offset + 85 > geometry_data.len() { break; } // 85 bytes per face
            let direction = geometry_data[offset];
            offset += 1;
            
            let mut vertices = [[0.0f32; 3]; 4];
            for v in 0..4 {
                for c in 0..3 {
                    vertices[v][c] = f32::from_le_bytes([
                        geometry_data[offset], geometry_data[offset + 1],
                        geometry_data[offset + 2], geometry_data[offset + 3],
                    ]);
                    offset += 4;
                }
            }
            
            let mut uvs = [[0.0f32; 2]; 4];
            for v in 0..4 {
                for c in 0..2 {
                    uvs[v][c] = f32::from_le_bytes([
                        geometry_data[offset], geometry_data[offset + 1],
                        geometry_data[offset + 2], geometry_data[offset + 3],
                    ]);
                    offset += 4;
                }
            }
            
            let texture_index = u16::from_le_bytes([geometry_data[offset], geometry_data[offset + 1]]);
            offset += 2;
            let tint_type = geometry_data[offset];
            offset += 1;
            let cull_face = geometry_data[offset];
            offset += 1;
            
            faces.push(super::geometry::ModelFace {
                direction, vertices, uvs, texture_index, tint_type, cull_face,
            });
        }
        
        registry.add(state_id, ModelGeometry {
            faces, is_full_cube: false, is_transparent: false,
        });
    }
    
    let count = registry.len();
    let _ = MODEL_REGISTRY.set(registry);
    web_sys::console::log_1(&format!("[WASM] Model registry initialized with {} models", count).into());
}

pub fn get_model_geometry(state_id: u16) -> Option<&'static ModelGeometry> {
    MODEL_REGISTRY.get().and_then(|r| r.get(state_id))
}

pub fn is_model_registry_initialized() -> bool {
    MODEL_REGISTRY.get().is_some()
}

// ============================================================================
// V2 Registry Functions
// ============================================================================

#[wasm_bindgen]
pub fn init_model_registry_v2(
    state_ids: Vec<u16>,
    block_names: String,
    flags_data: Vec<u8>,
    geometry_data: Vec<u8>,
) {
    let mut registry = ModelRegistryV2::new();
    let names: Vec<&str> = block_names.lines().collect();
    let mut offset = 0;
    
    for (i, &state_id) in state_ids.iter().enumerate() {
        if offset + 2 > geometry_data.len() { break; }
        let block_name = names.get(i).unwrap_or(&"").to_string();
        let model_flags = *flags_data.get(i).unwrap_or(&0);
        
        let num_faces = u16::from_le_bytes([geometry_data[offset], geometry_data[offset + 1]]) as usize;
        offset += 2;
        
        let mut faces = Vec::with_capacity(num_faces);
        for _ in 0..num_faces {
            if offset + 85 > geometry_data.len() { break; } // 85 bytes per face
            let direction = geometry_data[offset];
            offset += 1;
            
            let mut vertices = [[0.0f32; 3]; 4];
            for v in 0..4 {
                for c in 0..3 {
                    vertices[v][c] = f32::from_le_bytes([
                        geometry_data[offset], geometry_data[offset + 1],
                        geometry_data[offset + 2], geometry_data[offset + 3],
                    ]);
                    offset += 4;
                }
            }
            
            let mut uvs = [[0.0f32; 2]; 4];
            for v in 0..4 {
                for c in 0..2 {
                    uvs[v][c] = f32::from_le_bytes([
                        geometry_data[offset], geometry_data[offset + 1],
                        geometry_data[offset + 2], geometry_data[offset + 3],
                    ]);
                    offset += 4;
                }
            }
            
            let texture_index = u16::from_le_bytes([geometry_data[offset], geometry_data[offset + 1]]);
            offset += 2;
            let tint_type = geometry_data[offset];
            offset += 1;
            let cull_face = geometry_data[offset];
            offset += 1;
            
            faces.push(super::geometry::ModelFace {
                direction, vertices, uvs, texture_index, tint_type, cull_face,
            });
        }
        
        let geometry = ModelGeometry {
            faces, is_full_cube: false, is_transparent: model_flags & flags::IS_TRANSPARENT != 0,
        };
        
        registry.add(state_id, ModelEntryV2 { geometry, block_name, flags: model_flags });
    }
    
    let count = registry.len();
    let _ = MODEL_REGISTRY_V2.set(registry);
    web_sys::console::log_1(&format!("[WASM] Model registry V2 initialized with {} models", count).into());
}

pub fn get_model_entry_v2(state_id: u16) -> Option<&'static ModelEntryV2> {
    MODEL_REGISTRY_V2.get().and_then(|r| r.get(state_id))
}

pub fn is_hash_model_registry_initialized() -> bool {
    MODEL_REGISTRY_V2.get().is_some()
}
