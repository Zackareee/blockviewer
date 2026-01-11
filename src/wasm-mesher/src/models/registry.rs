//! State and Model Registry
//!
//! Maps block state strings to state IDs and stores model geometry.
//! Supports both:
//! 1. State ID based lookup (legacy, requires synchronized IDs)
//! 2. String hash based lookup (new, works across threads without sync)
//!
//! The hash-based approach uses FNV-1a hashing for deterministic lookups.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;
use fnv::FnvHasher;
use wasm_bindgen::prelude::*;
use super::geometry::ModelGeometry;

/// State registry: maps state strings to state IDs
static STATE_REGISTRY: OnceLock<StateRegistry> = OnceLock::new();

/// Model registry: maps state IDs to model geometry (legacy)
static MODEL_REGISTRY: OnceLock<ModelRegistry> = OnceLock::new();

/// Hash-based model registry: maps state string hashes to model geometry
static HASH_MODEL_REGISTRY: OnceLock<HashModelRegistry> = OnceLock::new();

// ============================================================================
// FNV-1a Hash Function
// ============================================================================

/// Compute FNV-1a 64-bit hash of a state string
/// This is deterministic and produces the same hash for the same string
/// regardless of which thread/worker computes it.
/// 
/// IMPORTANT: This uses direct byte hashing (NOT str.hash()) to match JavaScript.
/// The JavaScript implementation hashes bytes directly without the 0xff suffix
/// that Rust's str.hash() adds.
#[inline]
pub fn hash_state_string(state: &str) -> u64 {
    // FNV-1a constants
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    
    let mut hash = FNV_OFFSET_BASIS;
    
    for byte in state.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    
    // Add 0xff suffix to match JavaScript implementation (which adds it for Rust compatibility)
    hash ^= 0xFF;
    hash = hash.wrapping_mul(FNV_PRIME);
    
    hash
}

/// Build a canonical state string from block name and sorted properties
/// Format: "minecraft:oak_stairs[facing=north,half=bottom,shape=straight]"
pub fn build_canonical_state_string(name: &str, properties: &[(String, String)]) -> String {
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

// ============================================================================
// State Registry (legacy - state string to ID mapping)
// ============================================================================

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

// ============================================================================
// Model Registry (legacy - state ID to geometry)
// ============================================================================

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

// ============================================================================
// Hash-based Model Registry (new - hash to geometry)
// ============================================================================

/// Hash-based model registry using FNV-1a hashed state strings
pub struct HashModelRegistry {
    /// State string hash → model geometry
    models: HashMap<u64, ModelGeometry>,
    /// For debugging: track which state strings we have
    debug_states: Vec<String>,
}

impl HashModelRegistry {
    pub fn new() -> Self {
        Self {
            models: HashMap::with_capacity(8192),
            debug_states: Vec::new(),
        }
    }

    /// Add geometry by state string (computes hash internally)
    pub fn add_by_string(&mut self, state_string: &str, geometry: ModelGeometry) {
        let hash = hash_state_string(state_string);
        self.models.insert(hash, geometry);
        #[cfg(debug_assertions)]
        self.debug_states.push(state_string.to_string());
    }

    /// Add geometry by pre-computed hash
    pub fn add_by_hash(&mut self, hash: u64, geometry: ModelGeometry) {
        self.models.insert(hash, geometry);
    }

    /// Look up geometry by state string
    pub fn get_by_string(&self, state_string: &str) -> Option<&ModelGeometry> {
        let hash = hash_state_string(state_string);
        self.models.get(&hash)
    }

    /// Look up geometry by pre-computed hash
    pub fn get_by_hash(&self, hash: u64) -> Option<&ModelGeometry> {
        self.models.get(&hash)
    }

    pub fn len(&self) -> usize {
        self.models.len()
    }

    pub fn is_empty(&self) -> bool {
        self.models.is_empty()
    }
}

impl Default for HashModelRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// WASM Bindings - Legacy State Registry
// ============================================================================

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

/// Build state string from block name and properties (legacy alias)
pub fn build_state_string(name: &str, properties: &[(String, String)]) -> String {
    build_canonical_state_string(name, properties)
}

/// Check if state registry is initialized
pub fn is_state_registry_initialized() -> bool {
    STATE_REGISTRY.get().is_some()
}

// ============================================================================
// WASM Bindings - Legacy Model Registry (by state ID)
// ============================================================================

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
            // Face size: 1 (direction) + 48 (vertices) + 32 (uvs) + 2 (texture) + 1 (tint) + 1 (cull) = 85 bytes
            if offset + 85 > geometry_data.len() {
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
            is_full_cube: false,
            is_transparent: false,
        });
    }
    
    let count = registry.len();
    let _ = MODEL_REGISTRY.set(registry);
    
    web_sys::console::log_1(&format!("[WASM] Model registry initialized with {} models", count).into());
}

/// Get model geometry for a state ID (legacy)
pub fn get_model_geometry(state_id: u16) -> Option<&'static ModelGeometry> {
    MODEL_REGISTRY.get().and_then(|r| r.get(state_id))
}

/// Check if model registry is initialized
pub fn is_model_registry_initialized() -> bool {
    MODEL_REGISTRY.get().is_some()
}

// ============================================================================
// WASM Bindings - Hash-based Model Registry (new)
// ============================================================================

/// Initialize hash-based model registry from JavaScript
/// 
/// This uses state string hashes for lookup, eliminating the need for
/// synchronized state IDs between main thread and workers.
/// 
/// # Arguments
/// * `state_strings` - Newline-separated state strings
/// * `geometry_data` - Serialized model geometry (binary format, same as init_model_registry)
#[wasm_bindgen]
pub fn init_hash_model_registry(state_strings: String, geometry_data: Vec<u8>) {
    let mut registry = HashModelRegistry::new();
    let state_lines: Vec<&str> = state_strings.lines().collect();
    
    // Debug: collect sample stairs/slabs for hash verification
    let mut stairs_samples: Vec<(String, u64)> = Vec::new();
    let mut slab_samples: Vec<(String, u64)> = Vec::new();
    
    // Deserialize geometry data (same format as init_model_registry)
    let mut offset = 0;
    let mut state_idx = 0;
    
    while offset + 2 <= geometry_data.len() && state_idx < state_lines.len() {
        let state_string = state_lines[state_idx];
        state_idx += 1;
        
        // Debug: collect sample hashes for stairs and slabs
        let hash = hash_state_string(state_string);
        if state_string.contains("stairs") && stairs_samples.len() < 3 {
            stairs_samples.push((state_string.to_string(), hash));
        }
        if state_string.contains("_slab") && slab_samples.len() < 3 {
            slab_samples.push((state_string.to_string(), hash));
        }
        
        let num_faces = u16::from_le_bytes([geometry_data[offset], geometry_data[offset + 1]]) as usize;
        offset += 2;
        
        let mut faces = Vec::with_capacity(num_faces);
        
        for _ in 0..num_faces {
            // Face size: 1 (direction) + 48 (vertices) + 32 (uvs) + 2 (texture) + 1 (tint) + 1 (cull) = 85 bytes
            if offset + 85 > geometry_data.len() {
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
        
        registry.add_by_string(state_string, ModelGeometry {
            faces,
            is_full_cube: false,
            is_transparent: false,
        });
    }
    
    let count = registry.len();
    let _ = HASH_MODEL_REGISTRY.set(registry);
    
    // Debug: Log sample stairs hashes for verification
    if !stairs_samples.is_empty() {
        for (state_str, hash) in &stairs_samples {
            web_sys::console::log_1(&format!(
                "[WASM Registry] Stairs registered: \"{}\" -> 0x{:016x}",
                state_str, hash
            ).into());
        }
    }
    if !slab_samples.is_empty() {
        for (state_str, hash) in &slab_samples {
            web_sys::console::log_1(&format!(
                "[WASM Registry] Slab registered: \"{}\" -> 0x{:016x}",
                state_str, hash
            ).into());
        }
    }
    
    web_sys::console::log_1(&format!("[WASM] Hash-based model registry initialized with {} models", count).into());
}

/// Initialize hash-based model registry with pre-computed hashes
/// 
/// More efficient than init_hash_model_registry as hashes are pre-computed
/// on the JavaScript side.
/// 
/// # Arguments
/// * `state_hashes` - Array of 64-bit FNV-1a hashes of state strings
/// * `geometry_data` - Serialized model geometry (binary format)
#[wasm_bindgen]
pub fn init_hash_model_registry_precomputed(state_hashes: Vec<u64>, geometry_data: Vec<u8>) {
    let mut registry = HashModelRegistry::new();
    
    let mut offset = 0;
    let mut hash_idx = 0;
    
    while offset + 2 <= geometry_data.len() && hash_idx < state_hashes.len() {
        let state_hash = state_hashes[hash_idx];
        hash_idx += 1;
        
        let num_faces = u16::from_le_bytes([geometry_data[offset], geometry_data[offset + 1]]) as usize;
        offset += 2;
        
        let mut faces = Vec::with_capacity(num_faces);
        
        for _ in 0..num_faces {
            // Face size: 1 (direction) + 48 (vertices) + 32 (uvs) + 2 (texture) + 1 (tint) + 1 (cull) = 85 bytes
            if offset + 85 > geometry_data.len() {
                break;
            }
            
            let direction = geometry_data[offset];
            offset += 1;
            
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
        
        registry.add_by_hash(state_hash, ModelGeometry {
            faces,
            is_full_cube: false,
            is_transparent: false,
        });
    }
    
    let count = registry.len();
    
    // Log first 5 registered hashes for debugging
    let sample_hashes: Vec<String> = registry.models.keys()
        .take(5)
        .map(|h| format!("0x{:016x}", h))
        .collect();
    web_sys::console::log_1(&format!("[WASM] Hash-based model registry: {} models, sample hashes: {:?}", count, sample_hashes).into());
    
    let _ = HASH_MODEL_REGISTRY.set(registry);
    
    web_sys::console::log_1(&format!("[WASM] Hash-based model registry initialized with {} models (precomputed hashes)", count).into());
}

/// Get model geometry by state string hash
pub fn get_model_geometry_by_hash(hash: u64) -> Option<&'static ModelGeometry> {
    HASH_MODEL_REGISTRY.get().and_then(|r| r.get_by_hash(hash))
}

/// Get model geometry by state string (computes hash internally)
pub fn get_model_geometry_by_string(state_string: &str) -> Option<&'static ModelGeometry> {
    HASH_MODEL_REGISTRY.get().and_then(|r| r.get_by_string(state_string))
}

/// Check if hash-based model registry is initialized
pub fn is_hash_model_registry_initialized() -> bool {
    HASH_MODEL_REGISTRY.get().map(|r| !r.is_empty()).unwrap_or(false)
}

/// Get the number of models in the hash-based registry
pub fn get_hash_model_registry_size() -> usize {
    HASH_MODEL_REGISTRY.get().map(|r| r.len()).unwrap_or(0)
}

/// Expose hash function to JavaScript for pre-computing hashes
#[wasm_bindgen]
pub fn compute_state_hash(state_string: &str) -> u64 {
    hash_state_string(state_string)
}

/// Compute multiple state hashes at once (more efficient for bulk operations)
#[wasm_bindgen]
pub fn compute_state_hashes(state_strings: String) -> Vec<u64> {
    state_strings.lines().map(hash_state_string).collect()
}