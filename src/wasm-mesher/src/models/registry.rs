//! State and Model Registry
//!
//! Maps block state strings to state IDs and stores model geometry.
//! Initialized once from JavaScript at startup.

use std::collections::HashMap;
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;
use super::geometry::ModelGeometry;

/// State registry: maps state strings to state IDs
static STATE_REGISTRY: OnceLock<StateRegistry> = OnceLock::new();

/// Model registry: maps state IDs to model geometry
static MODEL_REGISTRY: OnceLock<ModelRegistry> = OnceLock::new();

/// State registry containing state string → ID mappings
pub struct StateRegistry {
    /// Full state string to ID mapping
    /// Format: "minecraft:oak_stairs[facing=north,half=bottom,shape=straight]"
    state_to_id: HashMap<String, u16>,
    /// Block name to list of state IDs (for blocks needing models)
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
        
        // Also index by block name
        if let Some(bracket_pos) = state_string.find('[') {
            let block_name = &state_string[..bracket_pos];
            self.block_to_states
                .entry(block_name.to_string())
                .or_default()
                .push(state_id);
        } else {
            // No properties, just block name
            self.block_to_states
                .entry(state_string.to_string())
                .or_default()
                .push(state_id);
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
    fn default() -> Self {
        Self::new()
    }
}

/// Model registry containing state ID → geometry mappings
pub struct ModelRegistry {
    /// State ID to model geometry
    models: HashMap<u16, ModelGeometry>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self {
            models: HashMap::new(),
        }
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
    fn default() -> Self {
        Self::new()
    }
}

/// Initialize state registry from JavaScript
/// 
/// Called once at startup with all state strings and their IDs.
/// 
/// # Arguments
/// * `state_strings` - Newline-separated state strings
/// * `state_ids` - Corresponding state IDs
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

/// Get state ID from state string
/// Returns 0 if not found
pub fn get_state_id(state_string: &str) -> u16 {
    STATE_REGISTRY
        .get()
        .and_then(|r| r.get_id(state_string))
        .unwrap_or(0)
}

/// Build state string from block name and properties
pub fn build_state_string(name: &str, properties: &[(String, String)]) -> String {
    if properties.is_empty() {
        return name.to_string();
    }
    
    // Sort properties alphabetically for consistent ordering
    let mut sorted_props: Vec<_> = properties.iter().collect();
    sorted_props.sort_by(|a, b| a.0.cmp(&b.0));
    
    let props_str: Vec<String> = sorted_props
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect();
    
    format!("{}[{}]", name, props_str.join(","))
}

/// Check if state registry is initialized
pub fn is_state_registry_initialized() -> bool {
    STATE_REGISTRY.get().is_some()
}

/// Initialize model registry from JavaScript
/// 
/// Called once after state registry with serialized model geometry.
/// 
/// # Arguments
/// * `state_ids` - State IDs for each model
/// * `geometry_data` - Serialized model geometry (binary format)
#[wasm_bindgen]
pub fn init_model_registry(state_ids: Vec<u16>, geometry_data: Vec<u8>) {
    let mut registry = ModelRegistry::new();
    
    // Deserialize geometry data
    // Format per model:
    //   [num_faces: u16]
    //   [face data...]
    // 
    // Face format:
    //   [direction: u8] (0=down, 1=up, 2=north, 3=south, 4=west, 5=east, 6=none)
    //   [vertices: 4 * 3 * f32] (48 bytes)
    //   [uvs: 4 * 2 * f32] (32 bytes)
    //   [texture_index: u16]
    //   [tint_type: u8]
    //   [cull_face: u8] (which direction to check for culling, 255=none)
    
    let mut offset = 0;
    
    for &state_id in &state_ids {
        if offset + 2 > geometry_data.len() {
            break;
        }
        
        let num_faces = u16::from_le_bytes([geometry_data[offset], geometry_data[offset + 1]]) as usize;
        offset += 2;
        
        let mut faces = Vec::with_capacity(num_faces);
        
        for _ in 0..num_faces {
            if offset + 84 > geometry_data.len() {
                break;
            }
            
            let direction = geometry_data[offset];
            offset += 1;
            
            // Read 4 vertices (each 3 f32s)
            let mut vertices = [[0.0f32; 3]; 4];
            for v in 0..4 {
                for c in 0..3 {
                    vertices[v][c] = f32::from_le_bytes([
                        geometry_data[offset],
                        geometry_data[offset + 1],
                        geometry_data[offset + 2],
                        geometry_data[offset + 3],
                    ]);
                    offset += 4;
                }
            }
            
            // Read 4 UVs (each 2 f32s)
            let mut uvs = [[0.0f32; 2]; 4];
            for v in 0..4 {
                for c in 0..2 {
                    uvs[v][c] = f32::from_le_bytes([
                        geometry_data[offset],
                        geometry_data[offset + 1],
                        geometry_data[offset + 2],
                        geometry_data[offset + 3],
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
                direction,
                vertices,
                uvs,
                texture_index,
                tint_type,
                cull_face,
            });
        }
        
        registry.add(state_id, ModelGeometry {
            faces,
            is_full_cube: false, // Will be computed from faces
            is_transparent: false,
        });
    }
    
    let count = registry.len();
    let _ = MODEL_REGISTRY.set(registry);
    
    web_sys::console::log_1(&format!("[WASM] Model registry initialized with {} models", count).into());
}

/// Get model geometry for a state ID
pub fn get_model_geometry(state_id: u16) -> Option<&'static ModelGeometry> {
    MODEL_REGISTRY.get().and_then(|r| r.get(state_id))
}

/// Check if model registry is initialized
pub fn is_model_registry_initialized() -> bool {
    MODEL_REGISTRY.get().is_some()
}

