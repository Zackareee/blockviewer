//! Instance Batching for WASM Model Mesher
//!
//! Collects repeated block models into instance batches for GPU instancing.
//! This significantly reduces draw calls for common blocks like grass, flowers,
//! torches, etc.
//!
//! Phase 3.3 of the performance architecture overhaul.

use std::collections::{HashMap, HashSet};
use crate::grid::{BlockStateGrid, LightGrid};
use crate::types::{SectionKey, SECTION_VOLUME, block_index_to_coords, block_index_in_section};

/// Instanceable block hashes (computed from block names)
/// These blocks can use GPU instancing instead of individual mesh generation
static mut INSTANCEABLE_HASHES: Option<HashSet<u64>> = None;

/// Instance batch for a single block type
#[derive(Debug, Clone)]
pub struct InstanceBatch {
    /// Hash of the base geometry (state string hash)
    pub geometry_hash: u64,
    /// Block name for debugging
    pub block_name: String,
    /// World positions [x, y, z] for each instance
    pub positions: Vec<[f32; 3]>,
    /// Y-rotation for each instance (0-3 for 90° increments)
    pub rotations: Vec<u8>,
    /// Tint type for each instance (0=none, 1=grass, 2=foliage, etc.)
    pub tint_types: Vec<u8>,
    /// Light values [sky, block] for each instance
    pub lights: Vec<[u8; 2]>,
    /// Texture index for this block type
    pub texture_index: u16,
}

impl InstanceBatch {
    pub fn new(geometry_hash: u64, block_name: String, texture_index: u16) -> Self {
        Self {
            geometry_hash,
            block_name,
            positions: Vec::new(),
            rotations: Vec::new(),
            tint_types: Vec::new(),
            lights: Vec::new(),
            texture_index,
        }
    }
    
    pub fn add_instance(&mut self, position: [f32; 3], rotation: u8, tint_type: u8, light: [u8; 2]) {
        self.positions.push(position);
        self.rotations.push(rotation);
        self.tint_types.push(tint_type);
        self.lights.push(light);
    }
    
    pub fn len(&self) -> usize {
        self.positions.len()
    }
    
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }
    
    /// Serialize to binary format for transfer to JavaScript
    /// Format:
    ///   [geometry_hash: u64]
    ///   [texture_index: u16]
    ///   [count: u32]
    ///   [positions: count * 3 * f32]
    ///   [rotations: count * u8]
    ///   [tint_types: count * u8]
    ///   [lights: count * 2 * u8]
    pub fn serialize(&self) -> Vec<u8> {
        let count = self.positions.len();
        // 8 (hash) + 2 (tex) + 4 (count) + count * (12 + 1 + 1 + 2) = 14 + count * 16
        let size = 14 + count * 16;
        let mut data = vec![0u8; size];
        let mut offset = 0;
        
        // Write geometry hash
        data[offset..offset + 8].copy_from_slice(&self.geometry_hash.to_le_bytes());
        offset += 8;
        
        // Write texture index
        data[offset..offset + 2].copy_from_slice(&self.texture_index.to_le_bytes());
        offset += 2;
        
        // Write count
        data[offset..offset + 4].copy_from_slice(&(count as u32).to_le_bytes());
        offset += 4;
        
        // Write positions
        for pos in &self.positions {
            for c in pos {
                data[offset..offset + 4].copy_from_slice(&c.to_le_bytes());
                offset += 4;
            }
        }
        
        // Write rotations
        for rot in &self.rotations {
            data[offset] = *rot;
            offset += 1;
        }
        
        // Write tint types
        for tint in &self.tint_types {
            data[offset] = *tint;
            offset += 1;
        }
        
        // Write lights
        for light in &self.lights {
            data[offset] = light[0];
            data[offset + 1] = light[1];
            offset += 2;
        }
        
        data
    }
}

/// Result of instance collection
pub struct InstanceCollectionResult {
    /// Instance batches grouped by geometry hash
    pub batches: Vec<InstanceBatch>,
    /// State hashes that should NOT be processed by regular model meshing
    /// (because they're handled by instancing)
    pub instanced_hashes: HashSet<u64>,
}

/// Minimum number of instances to benefit from GPU instancing
const INSTANCING_THRESHOLD: usize = 4;

/// Compute FNV-1a hash of a string (matches registry.rs implementation)
fn hash_string(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    use fnv::FnvHasher;
    
    let mut hasher = FnvHasher::default();
    s.hash(&mut hasher);
    hasher.finish()
}

/// Initialize the set of instanceable block hashes
pub fn init_instanceable_blocks(block_names: &[&str]) {
    let hashes: HashSet<u64> = block_names.iter()
        .map(|name| hash_string(&format!("minecraft:{}", name)))
        .collect();
    
    unsafe {
        INSTANCEABLE_HASHES = Some(hashes);
    }
}

/// Check if a state hash represents an instanceable block
#[inline]
pub fn is_instanceable(state_hash: u64) -> bool {
    unsafe {
        INSTANCEABLE_HASHES.as_ref()
            .map(|set| set.contains(&state_hash))
            .unwrap_or(false)
    }
}

/// Collect instances from state grid
/// 
/// Iterates through the state grid and collects all instanceable blocks
/// into batches grouped by their state hash.
pub fn collect_instances(
    state_grid: &BlockStateGrid,
    light_grid: &LightGrid,
    offset_x: i32,
    offset_y: i32,
    offset_z: i32,
) -> InstanceCollectionResult {
    let mut batches_map: HashMap<u64, InstanceBatch> = HashMap::new();
    let mut instanced_hashes = HashSet::new();
    
    // First pass: count instances per state hash
    let mut counts: HashMap<u64, usize> = HashMap::new();
    
    for (key, section) in state_grid.iter_sections_with_states() {
        for i in 0..SECTION_VOLUME {
            let state_hash = section[i];
            if state_hash != 0 {
                *counts.entry(state_hash).or_insert(0) += 1;
            }
        }
    }
    
    // Identify which hashes have enough instances
    for (hash, count) in &counts {
        if *count >= INSTANCING_THRESHOLD && is_instanceable(*hash) {
            instanced_hashes.insert(*hash);
        }
    }
    
    // Second pass: collect instance data
    for (key, section) in state_grid.iter_sections_with_states() {
        let base_x = key.chunk_x * 16;
        let base_y = key.section_y * 16 - 64; // World Y offset
        let base_z = key.chunk_z * 16;
        
        for i in 0..SECTION_VOLUME {
            let state_hash = section[i];
            if state_hash == 0 || !instanced_hashes.contains(&state_hash) {
                continue;
            }
            
            // Get local coordinates
            let lx = (i & 15) as i32;
            let ly = ((i >> 8) & 15) as i32;
            let lz = ((i >> 4) & 15) as i32;
            
            // World position (with offset applied)
            let wx = (base_x + lx - offset_x) as f32;
            let wy = (base_y + ly - offset_y) as f32;
            let wz = (base_z + lz - offset_z) as f32;
            
            // Get light
            let world_x = base_x + lx;
            let world_y = base_y + ly;
            let world_z = base_z + lz;
            let light = light_grid.get_light(world_x, world_y, world_z);
            
            // Get or create batch
            let batch = batches_map.entry(state_hash).or_insert_with(|| {
                InstanceBatch::new(state_hash, String::new(), 0)
            });
            
            // Add instance (rotation = 0, tint_type = 1 for plants)
            batch.add_instance(
                [wx, wy, wz],
                0, // rotation
                1, // tint_type (grass/foliage)
                [light.sky_light, light.block_light]
            );
        }
    }
    
    // Convert to vector
    let batches: Vec<InstanceBatch> = batches_map.into_values()
        .filter(|b| !b.is_empty())
        .collect();
    
    InstanceCollectionResult {
        batches,
        instanced_hashes,
    }
}

/// Serialize all instance batches to binary format
pub fn serialize_instances(batches: &[InstanceBatch]) -> Vec<u8> {
    // Format:
    //   [batch_count: u32]
    //   [batch_data...]
    
    let batch_count = batches.len() as u32;
    let mut data = Vec::new();
    
    // Write batch count
    data.extend_from_slice(&batch_count.to_le_bytes());
    
    // Write each batch
    for batch in batches {
        let batch_data = batch.serialize();
        // Prefix with length
        let len = batch_data.len() as u32;
        data.extend_from_slice(&len.to_le_bytes());
        data.extend(batch_data);
    }
    
    data
}
