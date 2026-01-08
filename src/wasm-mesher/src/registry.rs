//! Block Registry - Maps block names to numeric IDs
//!
//! This registry is initialized once from JavaScript with the block name-to-ID
//! mappings from BlockRegistry.js. It provides fast HashMap-based lookups
//! during chunk decoding.

use std::collections::HashMap;
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;

/// Static storage for the block registry
static BLOCK_REGISTRY: OnceLock<BlockRegistry> = OnceLock::new();

/// Block registry containing name-to-ID mappings
pub struct BlockRegistry {
    /// Name to ID mapping (e.g., "minecraft:stone" -> 1)
    name_to_id: HashMap<String, u16>,
    /// Short name to ID mapping (e.g., "stone" -> 1)
    short_name_to_id: HashMap<String, u16>,
    /// ID to name mapping (reverse lookup)
    id_to_name: HashMap<u16, String>,
}

impl BlockRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            name_to_id: HashMap::new(),
            short_name_to_id: HashMap::new(),
            id_to_name: HashMap::new(),
        }
    }
    
    /// Add a block name to ID mapping
    pub fn add(&mut self, name: &str, id: u16) {
        self.name_to_id.insert(name.to_string(), id);
        self.id_to_name.insert(id, name.to_string());
        
        // Also add short name (without minecraft: prefix)
        if let Some(short) = name.strip_prefix("minecraft:") {
            self.short_name_to_id.insert(short.to_string(), id);
        }
    }
    
    /// Get block name from ID
    pub fn get_name(&self, id: u16) -> Option<&str> {
        self.id_to_name.get(&id).map(|s| s.as_str())
    }
    
    /// Get block ID from name
    pub fn get_id(&self, name: &str) -> u16 {
        // Try full name first
        if let Some(&id) = self.name_to_id.get(name) {
            return id;
        }
        
        // Try short name
        if let Some(&id) = self.short_name_to_id.get(name) {
            return id;
        }
        
        // Try adding minecraft: prefix
        let prefixed = format!("minecraft:{}", name);
        if let Some(&id) = self.name_to_id.get(&prefixed) {
            return id;
        }
        
        // Default to air (0)
        0
    }
}

impl Default for BlockRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Initialize the block registry from JavaScript
/// 
/// This should be called once after the BlockRegistry is loaded in JS.
/// The names and ids arrays must have the same length.
/// 
/// # Arguments
/// * `names` - Array of block names (e.g., ["minecraft:air", "minecraft:stone", ...])
/// * `ids` - Array of corresponding block IDs
#[wasm_bindgen]
pub fn init_block_registry(names: Vec<String>, ids: Vec<u16>) {
    let mut registry = BlockRegistry::new();
    
    for (name, id) in names.into_iter().zip(ids.into_iter()) {
        registry.add(&name, id);
    }
    
    let count = registry.name_to_id.len();
    
    // Set the global registry (ignore if already set)
    let _ = BLOCK_REGISTRY.set(registry);
    
    // Log success
    web_sys::console::log_1(&format!("[WASM] Block registry initialized with {} blocks", count).into());
}

/// Get block ID from name (internal function)
/// 
/// Returns 0 (air) if the block is not found or registry is not initialized.
pub fn get_block_id(name: &str) -> u16 {
    BLOCK_REGISTRY
        .get()
        .map(|r| r.get_id(name))
        .unwrap_or(0)
}

/// Get block name from ID (internal function)
/// 
/// Returns None if the block is not found or registry is not initialized.
pub fn get_block_name(id: u16) -> Option<String> {
    BLOCK_REGISTRY
        .get()
        .and_then(|r| r.get_name(id))
        .map(|s| s.to_string())
}

/// Check if the registry is initialized
pub fn is_initialized() -> bool {
    BLOCK_REGISTRY.get().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_registry_lookup() {
        let mut registry = BlockRegistry::new();
        registry.add("minecraft:stone", 1);
        registry.add("minecraft:dirt", 2);
        
        assert_eq!(registry.get_id("minecraft:stone"), 1);
        assert_eq!(registry.get_id("stone"), 1);
        assert_eq!(registry.get_id("minecraft:dirt"), 2);
        assert_eq!(registry.get_id("unknown"), 0);
    }
}


