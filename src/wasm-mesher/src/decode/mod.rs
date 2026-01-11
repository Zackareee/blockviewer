//! Decode module - NBT parsing and chunk decoding
//!
//! This module handles:
//! - Decompression of zlib/gzip compressed chunk data
//! - NBT parsing using fastnbt/serde
//! - Decoding chunk sections into BinaryGrid format
//! - Extracting light data into LightGrid format

pub mod nbt;
pub mod palette;

use crate::grid::{BinaryGrid, LightGrid};
use crate::registry;
use crate::types::{SECTION_SIZE, SECTION_VOLUME, MIN_Y, AXIS_X, AXIS_Z, AXIS_Y};
use flate2::read::{GzDecoder, ZlibDecoder};
use std::io::Read;

pub use nbt::ChunkData;

/// Compression types used in Minecraft region files
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CompressionType {
    Gzip = 1,
    Zlib = 2,
    Uncompressed = 3,
}

impl CompressionType {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(CompressionType::Gzip),
            2 => Some(CompressionType::Zlib),
            3 => Some(CompressionType::Uncompressed),
            _ => None,
        }
    }
}

/// Decompress chunk data based on compression type
pub fn decompress(data: &[u8], compression_type: CompressionType) -> Result<Vec<u8>, String> {
    match compression_type {
        CompressionType::Gzip => {
            let mut decoder = GzDecoder::new(data);
            let mut decompressed = Vec::new();
            decoder.read_to_end(&mut decompressed)
                .map_err(|e| format!("Gzip decompression failed: {}", e))?;
            Ok(decompressed)
        }
        CompressionType::Zlib => {
            let mut decoder = ZlibDecoder::new(data);
            let mut decompressed = Vec::new();
            decoder.read_to_end(&mut decompressed)
                .map_err(|e| format!("Zlib decompression failed: {}", e))?;
            Ok(decompressed)
        }
        CompressionType::Uncompressed => {
            Ok(data.to_vec())
        }
    }
}

/// Parse NBT data into ChunkData structure
pub fn parse_nbt(data: &[u8]) -> Result<ChunkData, String> {
    fastnbt::from_bytes(data)
        .map_err(|e| format!("NBT parsing failed: {}", e))
}

/// Air block names for quick lookup
const AIR_BLOCKS: &[&str] = &[
    "minecraft:air", "minecraft:cave_air", "minecraft:void_air",
    "air", "cave_air", "void_air"
];

/// Check if a block name is air
#[inline]
fn is_air_block(name: &str) -> bool {
    AIR_BLOCKS.contains(&name) || name.ends_with(":air")
}

/// Blocks that need axis rotation (logs, pillars, etc.)
fn is_rotatable_block(name: &str) -> bool {
    name.contains("_log") || 
    name.contains("_wood") ||
    name.contains("_stem") ||
    name.contains("_hyphae") ||
    name.contains("quartz_pillar") ||
    name.contains("purpur_pillar") ||
    name.contains("bone_block") ||
    name.contains("hay_block") ||
    name.contains("basalt") ||
    name.contains("deepslate") ||
    name.contains("chain") ||
    name.contains("muddy_mangrove_roots")
}

/// Directional blocks (furnace, loom, carved_pumpkin, etc.)
fn is_directional_block(name: &str) -> bool {
    name.contains("furnace") ||
    name.contains("smoker") ||
    name == "minecraft:loom" || name == "loom" ||
    name.contains("carved_pumpkin") ||
    name.contains("jack_o_lantern")
}

/// Facing direction values
const FACING_NORTH: u8 = 0;
const FACING_EAST: u8 = 1;
const FACING_SOUTH: u8 = 2;
const FACING_WEST: u8 = 3;

/// Decode a single chunk into grids
/// 
/// This is the main entry point for chunk decoding.
/// Returns (blocks_decoded, BinaryGrid, LightGrid)
pub fn decode_chunk(
    chunk_data: &ChunkData,
    chunk_x: i32,
    chunk_z: i32,
) -> (u32, BinaryGrid, LightGrid) {
    let (blocks, grid, light_grid, _state_grid) = decode_chunk_with_states(chunk_data, chunk_x, chunk_z);
    (blocks, grid, light_grid)
}

/// Decode a single chunk into grids including state grid for model blocks
/// 
/// Returns (blocks_decoded, BinaryGrid, LightGrid, BlockStateGrid)
pub fn decode_chunk_with_states(
    chunk_data: &ChunkData,
    chunk_x: i32,
    chunk_z: i32,
) -> (u32, BinaryGrid, LightGrid, crate::grid::BlockStateGrid) {
    let mut grid = BinaryGrid::new();
    let mut light_grid = LightGrid::new();
    let mut state_grid = crate::grid::BlockStateGrid::new();
    let mut total_blocks = 0u32;

    // Get sections from modern or legacy format
    let sections = if let Some(ref sections) = chunk_data.sections {
        sections.clone()
    } else if let Some(ref level) = chunk_data.level {
        level.sections.clone().unwrap_or_default()
    } else {
        return (0, grid, light_grid, state_grid);
    };

    for section in &sections {
        total_blocks += decode_section_with_states(section, chunk_x, chunk_z, &mut grid, &mut light_grid, &mut state_grid);
    }

    (total_blocks, grid, light_grid, state_grid)
}

/// Decode a single section into the grid
fn decode_section(
    section: &nbt::Section,
    chunk_x: i32,
    chunk_z: i32,
    grid: &mut BinaryGrid,
    light_grid: &mut LightGrid,
) -> u32 {
    let section_y = section.y as i32;
    let base_y = section_y * SECTION_SIZE as i32;
    
    // Skip sections outside valid range
    if base_y < MIN_Y || base_y >= 321 {
        return 0;
    }
    
    // Convert to internal section index (0-based from MIN_Y)
    let internal_section_y = section_y - (MIN_Y / SECTION_SIZE as i32);
    
    // Decode light data
    decode_light_data(section, chunk_x, chunk_z, internal_section_y, light_grid);
    
    // Modern format (1.18+) with block_states
    if let Some(ref block_states) = section.block_states {
        return decode_modern_section(
            block_states,
            chunk_x,
            chunk_z,
            internal_section_y,
            grid,
        );
    }
    
    // Legacy format (1.13-1.17) with Palette and BlockStates
    if section.palette.is_some() && section.block_states_legacy.is_some() {
        return decode_legacy_section(
            section.palette.as_ref().unwrap(),
            section.block_states_legacy.as_ref().unwrap(),
            chunk_x,
            chunk_z,
            internal_section_y,
            grid,
        );
    }
    
    // Very old format (pre-1.13) with Blocks array
    if let Some(ref blocks) = section.blocks {
        return decode_pre113_section(
            blocks,
            section.add.as_ref(),
            chunk_x,
            chunk_z,
            internal_section_y,
            grid,
        );
    }
    
    0
}

/// Decode a single section into the grid with state grid for model blocks
fn decode_section_with_states(
    section: &nbt::Section,
    chunk_x: i32,
    chunk_z: i32,
    grid: &mut BinaryGrid,
    light_grid: &mut LightGrid,
    state_grid: &mut crate::grid::BlockStateGrid,
) -> u32 {
    let section_y = section.y as i32;
    let base_y = section_y * SECTION_SIZE as i32;
    
    // Skip sections outside valid range
    if base_y < MIN_Y || base_y >= 321 {
        return 0;
    }
    
    // Convert to internal section index (0-based from MIN_Y)
    let internal_section_y = section_y - (MIN_Y / SECTION_SIZE as i32);
    
    // Decode light data
    decode_light_data(section, chunk_x, chunk_z, internal_section_y, light_grid);
    
    // Modern format (1.18+) with block_states
    if let Some(ref block_states) = section.block_states {
        return decode_modern_section_with_states(
            block_states,
            chunk_x,
            chunk_z,
            internal_section_y,
            grid,
            state_grid,
        );
    }
    
    // Legacy format (1.13-1.17) with Palette and BlockStates
    if section.palette.is_some() && section.block_states_legacy.is_some() {
        return decode_legacy_section(
            section.palette.as_ref().unwrap(),
            section.block_states_legacy.as_ref().unwrap(),
            chunk_x,
            chunk_z,
            internal_section_y,
            grid,
        );
    }
    
    // Very old format (pre-1.13) with Blocks array
    if let Some(ref blocks) = section.blocks {
        return decode_pre113_section(
            blocks,
            section.add.as_ref(),
            chunk_x,
            chunk_z,
            internal_section_y,
            grid,
        );
    }
    
    0
}

/// Decode light data from section
fn decode_light_data(
    section: &nbt::Section,
    chunk_x: i32,
    chunk_z: i32,
    internal_section_y: i32,
    light_grid: &mut LightGrid,
) {
    let has_sky = section.sky_light.is_some();
    let has_block = section.block_light.is_some();
    
    if !has_sky && !has_block {
        return;
    }
    
    light_grid.has_minecraft_light_data = true;
    let light_section = light_grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
    
    // Unpack sky light (nibble-packed: 2048 bytes -> 4096 values)
    // ByteArray values are i8, but we treat them as unsigned bytes
    if let Some(ref sky_light) = section.sky_light {
        if sky_light.len() >= 2048 {
            for i in 0..4096 {
                let byte_idx = i / 2;
                let nibble_idx = i % 2;
                // Convert i8 to u8 for bit operations
                let byte = sky_light[byte_idx] as u8;
                let sky = if nibble_idx == 0 {
                    byte & 0x0F
                } else {
                    (byte >> 4) & 0x0F
                };
                light_section[i] = (light_section[i] & 0xF0) | sky;
            }
        }
    }
    
    // Unpack block light
    if let Some(ref block_light) = section.block_light {
        if block_light.len() >= 2048 {
            for i in 0..4096 {
                let byte_idx = i / 2;
                let nibble_idx = i % 2;
                let byte = block_light[byte_idx] as u8;
                let block = if nibble_idx == 0 {
                    byte & 0x0F
                } else {
                    (byte >> 4) & 0x0F
                };
                light_section[i] = (light_section[i] & 0x0F) | (block << 4);
            }
        }
    }
}

/// Decode modern format section (1.18+)
fn decode_modern_section(
    block_states: &nbt::BlockStates,
    chunk_x: i32,
    chunk_z: i32,
    internal_section_y: i32,
    grid: &mut BinaryGrid,
) -> u32 {
    let palette = match &block_states.palette {
        Some(p) if !p.is_empty() => p,
        _ => return 0,
    };
    
    // Preprocess palette
    let processed = preprocess_palette(palette);
    
    // Single block type section (no data array needed)
    if palette.len() == 1 || block_states.data.is_none() {
        if processed.is_air[0] {
            return 0;
        }
        
        let value = build_block_value(
            processed.block_ids[0],
            processed.levels[0],
            processed.axis_values[0],
        );
        
        let section = grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
        section.fill(value);
        return SECTION_VOLUME as u32;
    }
    
    // Unpack block indices
    let data = block_states.data.as_ref().unwrap();
    let bits_per_block = std::cmp::max(4, (palette.len() as f64).log2().ceil() as usize);
    let indices = palette::unpack_block_indices(&data[..], bits_per_block, SECTION_VOLUME);
    
    let section = grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
    let mut blocks_decoded = 0u32;
    
    for i in 0..SECTION_VOLUME {
        let palette_index = indices[i] as usize;
        
        if palette_index < palette.len() && !processed.is_air[palette_index] {
            let value = build_block_value(
                processed.block_ids[palette_index],
                processed.levels[palette_index],
                processed.axis_values[palette_index],
            );
            section[i] = value;
            blocks_decoded += 1;
        }
    }
    
    blocks_decoded
}

/// Decode modern format section with state grid for model blocks
fn decode_modern_section_with_states(
    block_states: &nbt::BlockStates,
    chunk_x: i32,
    chunk_z: i32,
    internal_section_y: i32,
    grid: &mut BinaryGrid,
    state_grid: &mut crate::grid::BlockStateGrid,
) -> u32 {
    let palette = match &block_states.palette {
        Some(p) if !p.is_empty() => p,
        _ => return 0,
    };
    
    // Preprocess palette including state strings
    let processed = preprocess_palette_with_states(palette);
    
    // Single block type section (no data array needed)
    if palette.len() == 1 || block_states.data.is_none() {
        if processed.is_air[0] {
            return 0;
        }
        
        let value = build_block_value(
            processed.block_ids[0],
            processed.levels[0],
            processed.axis_values[0],
        );
        
        let section = grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
        section.fill(value);
        
        // If it's a model block, fill state grid too
        if processed.state_ids[0] != 0 {
            for i in 0..SECTION_VOLUME {
                state_grid.set_state(chunk_x, chunk_z, internal_section_y, i, processed.state_ids[0]);
            }
        }
        
        return SECTION_VOLUME as u32;
    }
    
    // Unpack block indices
    let data = block_states.data.as_ref().unwrap();
    let bits_per_block = std::cmp::max(4, (palette.len() as f64).log2().ceil() as usize);
    let indices = palette::unpack_block_indices(&data[..], bits_per_block, SECTION_VOLUME);
    
    let section = grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
    let mut blocks_decoded = 0u32;
    let mut has_states = false;
    
    for i in 0..SECTION_VOLUME {
        let palette_index = indices[i] as usize;
        
        if palette_index < palette.len() && !processed.is_air[palette_index] {
            let value = build_block_value(
                processed.block_ids[palette_index],
                processed.levels[palette_index],
                processed.axis_values[palette_index],
            );
            section[i] = value;
            blocks_decoded += 1;
            
            // Store state ID for model blocks
            let state_id = processed.state_ids[palette_index];
            if state_id != 0 {
                state_grid.set_state(chunk_x, chunk_z, internal_section_y, i, state_id);
                has_states = true;
            }
        }
    }
    
    // Log state counts for debugging (only occasionally)
    if has_states {
        // State IDs were stored
    }
    
    blocks_decoded
}

/// Decode legacy format section (1.13-1.17)
fn decode_legacy_section(
    palette: &[nbt::PaletteEntry],
    block_data: &fastnbt::LongArray,
    chunk_x: i32,
    chunk_z: i32,
    internal_section_y: i32,
    grid: &mut BinaryGrid,
) -> u32 {
    if palette.is_empty() {
        return 0;
    }
    
    let processed = preprocess_palette(palette);
    
    // Single block type section
    if palette.len() == 1 {
        if processed.is_air[0] {
            return 0;
        }
        
        let value = build_block_value(
            processed.block_ids[0],
            processed.levels[0],
            processed.axis_values[0],
        );
        
        let section = grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
        section.fill(value);
        return SECTION_VOLUME as u32;
    }
    
    let bits_per_block = std::cmp::max(4, (palette.len() as f64).log2().ceil() as usize);
    let indices = palette::unpack_block_indices(&block_data[..], bits_per_block, SECTION_VOLUME);
    
    let section = grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
    let mut blocks_decoded = 0u32;
    
    for i in 0..SECTION_VOLUME {
        let palette_index = indices[i] as usize;
        
        if palette_index < palette.len() && !processed.is_air[palette_index] {
            let value = build_block_value(
                processed.block_ids[palette_index],
                processed.levels[palette_index],
                processed.axis_values[palette_index],
            );
            section[i] = value;
            blocks_decoded += 1;
        }
    }
    
    blocks_decoded
}

/// Decode pre-1.13 format section
fn decode_pre113_section(
    blocks: &fastnbt::ByteArray,
    add: Option<&fastnbt::ByteArray>,
    chunk_x: i32,
    chunk_z: i32,
    internal_section_y: i32,
    grid: &mut BinaryGrid,
) -> u32 {
    let section = grid.get_or_create_section(chunk_x, chunk_z, internal_section_y);
    let mut blocks_decoded = 0u32;
    
    for i in 0..SECTION_VOLUME {
        let mut block_id = (blocks[i] as u8) as u16;
        
        if let Some(add_array) = add {
            let add_index = i >> 1;
            if add_index < add_array.len() {
                let add_value = add_array[add_index] as u8;
                if i % 2 == 0 {
                    block_id |= ((add_value & 0x0F) as u16) << 8;
                } else {
                    block_id |= ((add_value & 0xF0) as u16) << 4;
                }
            }
        }
        
        if block_id != 0 {
            // For legacy blocks, try to look up using legacy_ prefix
            let legacy_name = format!("minecraft:legacy_{}", block_id);
            let resolved_id = registry::get_block_id(&legacy_name);
            section[i] = resolved_id & 0x0FFF;
            blocks_decoded += 1;
        }
    }
    
    blocks_decoded
}

/// Preprocessed palette data
struct ProcessedPalette {
    block_ids: Vec<u16>,
    is_air: Vec<bool>,
    levels: Vec<i8>,
    axis_values: Vec<u8>,
}

/// Preprocessed palette data with state hashes for model blocks
struct ProcessedPaletteWithStates {
    block_ids: Vec<u16>,
    is_air: Vec<bool>,
    levels: Vec<i8>,
    axis_values: Vec<u8>,
    state_ids: Vec<u64>, // State hash for model blocks (0 = not a model block)
}

/// Preprocess palette entries
fn preprocess_palette(palette: &[nbt::PaletteEntry]) -> ProcessedPalette {
    let len = palette.len();
    let mut block_ids = Vec::with_capacity(len);
    let mut is_air = Vec::with_capacity(len);
    let mut levels = Vec::with_capacity(len);
    let mut axis_values = Vec::with_capacity(len);
    
    for entry in palette {
        let name = &entry.name;
        
        // Get block ID from registry
        let block_id = registry::get_block_id(name);
        block_ids.push(block_id);
        is_air.push(is_air_block(name));
        
        // Extract fluid level
        let level = if name.contains("water") || name.contains("lava") {
            entry.properties.as_ref()
                .and_then(|p| p.level.as_ref())
                .and_then(|l| l.parse::<i8>().ok())
                .unwrap_or(0)
        } else if entry.properties.as_ref().map(|p| p.waterlogged.as_deref() == Some("true")).unwrap_or(false) {
            8 // Waterlogged marker
        } else {
            -1 // Not a fluid
        };
        levels.push(level);
        
        // Extract axis for rotatable blocks
        let axis = if is_rotatable_block(name) {
            match entry.properties.as_ref().and_then(|p| p.axis.as_deref()) {
                Some("x") => AXIS_X,
                Some("z") => AXIS_Z,
                _ => AXIS_Y,
            }
        } else if is_directional_block(name) {
            match entry.properties.as_ref().and_then(|p| p.facing.as_deref()) {
                Some("east") => FACING_EAST,
                Some("south") => FACING_SOUTH,
                Some("west") => FACING_WEST,
                _ => FACING_NORTH,
            }
        } else {
            0
        };
        axis_values.push(axis);
    }
    
    ProcessedPalette {
        block_ids,
        is_air,
        levels,
        axis_values,
    }
}

/// Preprocess palette entries with state ID resolution for model blocks
fn preprocess_palette_with_states(palette: &[nbt::PaletteEntry]) -> ProcessedPaletteWithStates {
    // Debug: track if we've logged sample hashes
    static LOGGED_STAIRS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    static LOGGED_SLABS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    
    let len = palette.len();
    let mut block_ids = Vec::with_capacity(len);
    let mut is_air = Vec::with_capacity(len);
    let mut levels = Vec::with_capacity(len);
    let mut axis_values = Vec::with_capacity(len);
    let mut state_ids = Vec::with_capacity(len);
    
    // Get lookups for is_non_cube check
    let lookups = crate::lookup::Lookups::get();
    
    for entry in palette {
        let name = &entry.name;
        
        // Get block ID from registry
        let block_id = registry::get_block_id(name);
        block_ids.push(block_id);
        is_air.push(is_air_block(name));
        
        // Extract fluid level
        let level = if name.contains("water") || name.contains("lava") {
            entry.properties.as_ref()
                .and_then(|p| p.level.as_ref())
                .and_then(|l| l.parse::<i8>().ok())
                .unwrap_or(0)
        } else if entry.properties.as_ref().map(|p| p.waterlogged.as_deref() == Some("true")).unwrap_or(false) {
            8 // Waterlogged marker
        } else {
            -1 // Not a fluid
        };
        levels.push(level);
        
        // Extract axis for rotatable blocks
        let axis = if is_rotatable_block(name) {
            match entry.properties.as_ref().and_then(|p| p.axis.as_deref()) {
                Some("x") => AXIS_X,
                Some("z") => AXIS_Z,
                _ => AXIS_Y,
            }
        } else if is_directional_block(name) {
            match entry.properties.as_ref().and_then(|p| p.facing.as_deref()) {
                Some("east") => FACING_EAST,
                Some("south") => FACING_SOUTH,
                Some("west") => FACING_WEST,
                _ => FACING_NORTH,
            }
        } else {
            0
        };
        axis_values.push(axis);
        
        // Check if this is a model block (non-cube) and compute state hash
        let state_hash = if let Some(ref lookups) = lookups {
            if lookups.is_non_cube(block_id) {
                // Build state string and compute hash for model lookup
                let state_string = build_state_string(name, entry.properties.as_ref());
                let hash = crate::models::registry::hash_state_string(&state_string);
                
                // Debug: Log first few stairs and slabs state strings for hash verification
                if name.contains("stairs") && LOGGED_STAIRS.load(std::sync::atomic::Ordering::Relaxed) < 3 {
                    LOGGED_STAIRS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    web_sys::console::log_1(&format!(
                        "[WASM Decode] Stairs lookup: \"{}\" -> 0x{:016x}",
                        state_string, hash
                    ).into());
                }
                if name.contains("_slab") && LOGGED_SLABS.load(std::sync::atomic::Ordering::Relaxed) < 3 {
                    LOGGED_SLABS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    web_sys::console::log_1(&format!(
                        "[WASM Decode] Slab lookup: \"{}\" -> 0x{:016x}",
                        state_string, hash
                    ).into());
                }
                
                hash
            } else {
                0
            }
        } else {
            0
        };
        state_ids.push(state_hash);
    }
    
    ProcessedPaletteWithStates {
        block_ids,
        is_air,
        levels,
        axis_values,
        state_ids,
    }
}

/// Build a state string from block name and properties
/// MUST capture ALL properties defined in BlockProperties struct to match JS hash computation
fn build_state_string(name: &str, properties: Option<&nbt::BlockProperties>) -> String {
    match properties {
        Some(props) => {
            let mut prop_strs: Vec<String> = Vec::new();
            
            // Collect ALL properties from BlockProperties struct
            // Order doesn't matter here since we sort at the end
            if let Some(v) = &props.age { prop_strs.push(format!("age={}", v)); }
            if let Some(v) = &props.attached { prop_strs.push(format!("attached={}", v)); }
            if let Some(v) = &props.attachment { prop_strs.push(format!("attachment={}", v)); }
            if let Some(v) = &props.axis { prop_strs.push(format!("axis={}", v)); }
            if let Some(v) = &props.berries { prop_strs.push(format!("berries={}", v)); }
            if let Some(v) = &props.bites { prop_strs.push(format!("bites={}", v)); }
            if let Some(v) = &props.bloom { prop_strs.push(format!("bloom={}", v)); }
            if let Some(v) = &props.bottom { prop_strs.push(format!("bottom={}", v)); }
            if let Some(v) = &props.can_summon { prop_strs.push(format!("can_summon={}", v)); }
            if let Some(v) = &props.candles { prop_strs.push(format!("candles={}", v)); }
            if let Some(v) = &props.charges { prop_strs.push(format!("charges={}", v)); }
            if let Some(v) = &props.conditional { prop_strs.push(format!("conditional={}", v)); }
            if let Some(v) = &props.cracked { prop_strs.push(format!("cracked={}", v)); }
            if let Some(v) = &props.crafting { prop_strs.push(format!("crafting={}", v)); }
            if let Some(v) = &props.delay { prop_strs.push(format!("delay={}", v)); }
            if let Some(v) = &props.disarmed { prop_strs.push(format!("disarmed={}", v)); }
            if let Some(v) = &props.distance { prop_strs.push(format!("distance={}", v)); }
            if let Some(v) = &props.down { prop_strs.push(format!("down={}", v)); }
            if let Some(v) = &props.drag { prop_strs.push(format!("drag={}", v)); }
            if let Some(v) = &props.dusted { prop_strs.push(format!("dusted={}", v)); }
            if let Some(v) = &props.east { prop_strs.push(format!("east={}", v)); }
            if let Some(v) = &props.eggs { prop_strs.push(format!("eggs={}", v)); }
            if let Some(v) = &props.enabled { prop_strs.push(format!("enabled={}", v)); }
            if let Some(v) = &props.extended { prop_strs.push(format!("extended={}", v)); }
            if let Some(v) = &props.eye { prop_strs.push(format!("eye={}", v)); }
            if let Some(v) = &props.facing { prop_strs.push(format!("facing={}", v)); }
            if let Some(v) = &props.flower_amount { prop_strs.push(format!("flower_amount={}", v)); }
            if let Some(v) = &props.half { prop_strs.push(format!("half={}", v)); }
            if let Some(v) = &props.hanging { prop_strs.push(format!("hanging={}", v)); }
            if let Some(v) = &props.has_book { prop_strs.push(format!("has_book={}", v)); }
            if let Some(v) = &props.has_bottle_0 { prop_strs.push(format!("has_bottle_0={}", v)); }
            if let Some(v) = &props.has_bottle_1 { prop_strs.push(format!("has_bottle_1={}", v)); }
            if let Some(v) = &props.has_bottle_2 { prop_strs.push(format!("has_bottle_2={}", v)); }
            if let Some(v) = &props.hatch { prop_strs.push(format!("hatch={}", v)); }
            if let Some(v) = &props.hinge { prop_strs.push(format!("hinge={}", v)); }
            if let Some(v) = &props.honey_level { prop_strs.push(format!("honey_level={}", v)); }
            if let Some(v) = &props.in_wall { prop_strs.push(format!("in_wall={}", v)); }
            if let Some(v) = &props.instrument { prop_strs.push(format!("instrument={}", v)); }
            if let Some(v) = &props.last_interaction_book_slot { prop_strs.push(format!("last_interaction_book_slot={}", v)); }
            if let Some(v) = &props.layers { prop_strs.push(format!("layers={}", v)); }
            if let Some(v) = &props.level { prop_strs.push(format!("level={}", v)); }
            if let Some(v) = &props.lit { prop_strs.push(format!("lit={}", v)); }
            if let Some(v) = &props.locked { prop_strs.push(format!("locked={}", v)); }
            if let Some(v) = &props.mode { prop_strs.push(format!("mode={}", v)); }
            if let Some(v) = &props.moisture { prop_strs.push(format!("moisture={}", v)); }
            if let Some(v) = &props.north { prop_strs.push(format!("north={}", v)); }
            if let Some(v) = &props.note { prop_strs.push(format!("note={}", v)); }
            if let Some(v) = &props.ominous { prop_strs.push(format!("ominous={}", v)); }
            if let Some(v) = &props.open { prop_strs.push(format!("open={}", v)); }
            if let Some(v) = &props.orientation { prop_strs.push(format!("orientation={}", v)); }
            if let Some(v) = &props.part { prop_strs.push(format!("part={}", v)); }
            if let Some(v) = &props.persistent { prop_strs.push(format!("persistent={}", v)); }
            if let Some(v) = &props.pickles { prop_strs.push(format!("pickles={}", v)); }
            if let Some(v) = &props.power { prop_strs.push(format!("power={}", v)); }
            if let Some(v) = &props.powered { prop_strs.push(format!("powered={}", v)); }
            if let Some(v) = &props.rotation { prop_strs.push(format!("rotation={}", v)); }
            if let Some(v) = &props.sculk_sensor_phase { prop_strs.push(format!("sculk_sensor_phase={}", v)); }
            if let Some(v) = &props.shape { prop_strs.push(format!("shape={}", v)); }
            if let Some(v) = &props.short { prop_strs.push(format!("short={}", v)); }
            if let Some(v) = &props.shrieking { prop_strs.push(format!("shrieking={}", v)); }
            if let Some(v) = &props.signal_fire { prop_strs.push(format!("signal_fire={}", v)); }
            if let Some(v) = &props.slot_0_occupied { prop_strs.push(format!("slot_0_occupied={}", v)); }
            if let Some(v) = &props.slot_1_occupied { prop_strs.push(format!("slot_1_occupied={}", v)); }
            if let Some(v) = &props.slot_2_occupied { prop_strs.push(format!("slot_2_occupied={}", v)); }
            if let Some(v) = &props.slot_3_occupied { prop_strs.push(format!("slot_3_occupied={}", v)); }
            if let Some(v) = &props.slot_4_occupied { prop_strs.push(format!("slot_4_occupied={}", v)); }
            if let Some(v) = &props.slot_5_occupied { prop_strs.push(format!("slot_5_occupied={}", v)); }
            if let Some(v) = &props.snowy { prop_strs.push(format!("snowy={}", v)); }
            if let Some(v) = &props.south { prop_strs.push(format!("south={}", v)); }
            if let Some(v) = &props.thickness { prop_strs.push(format!("thickness={}", v)); }
            if let Some(v) = &props.tilt { prop_strs.push(format!("tilt={}", v)); }
            if let Some(v) = &props.tip { prop_strs.push(format!("tip={}", v)); }
            if let Some(v) = &props.trial_spawner_state { prop_strs.push(format!("trial_spawner_state={}", v)); }
            if let Some(v) = &props.triggered { prop_strs.push(format!("triggered={}", v)); }
            if let Some(v) = &props.slab_type { prop_strs.push(format!("type={}", v)); }
            if let Some(v) = &props.unstable { prop_strs.push(format!("unstable={}", v)); }
            if let Some(v) = &props.up { prop_strs.push(format!("up={}", v)); }
            if let Some(v) = &props.vault_state { prop_strs.push(format!("vault_state={}", v)); }
            if let Some(v) = &props.vertical_direction { prop_strs.push(format!("vertical_direction={}", v)); }
            if let Some(v) = &props.waterlogged { prop_strs.push(format!("waterlogged={}", v)); }
            if let Some(v) = &props.west { prop_strs.push(format!("west={}", v)); }
            
            if prop_strs.is_empty() {
                name.to_string()
            } else {
                // Sort for consistent ordering (matches JS Object.keys().sort())
                prop_strs.sort();
                format!("{}[{}]", name, prop_strs.join(","))
            }
        }
        None => name.to_string(),
    }
}

/// Build a block value from components
#[inline]
fn build_block_value(block_id: u16, level: i8, axis: u8) -> u16 {
    let metadata = if level >= 0 {
        level as u8
    } else if axis > 0 {
        axis
    } else {
        0
    };
    
    (block_id & 0x0FFF) | (((metadata & 0xF) as u16) << 12)
}


