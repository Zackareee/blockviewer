//! Model Mesher
//!
//! Meshes non-cube blocks (slabs, stairs, fences, etc.) using pre-baked model geometry.

use crate::grid::{BinaryGrid, LightGrid, LightValue, BlockStateGrid};
use crate::lookup::Lookups;
use crate::mesher::MeshBounds;
use crate::types::{SectionKey, SECTION_SIZE, SECTION_VOLUME, Face, block_index_in_section};
use super::geometry::{ModelMeshData, ModelFace};
use super::registry::get_model_geometry_by_hash;

/// Result from model meshing
pub struct ModelMeshResult {
    /// Opaque model faces
    pub opaque: ModelMeshData,
    /// Transparent model faces (glass panes, leaves, etc.)
    pub transparent: ModelMeshData,
    /// Overlay faces (grass overlay on grass block, etc.)
    pub overlay: ModelMeshData,
    /// Particle emitter positions
    pub particle_emitters: Vec<ParticleEmitter>,
    /// Beacon positions
    pub beacon_positions: Vec<BlockPosition>,
}

impl ModelMeshResult {
    pub fn new() -> Self {
        Self {
            opaque: ModelMeshData::new(),
            transparent: ModelMeshData::new(),
            overlay: ModelMeshData::new(),
            particle_emitters: Vec::new(),
            beacon_positions: Vec::new(),
        }
    }
}

impl Default for ModelMeshResult {
    fn default() -> Self {
        Self::new()
    }
}

/// A particle emitter position
#[derive(Debug, Clone)]
pub struct ParticleEmitter {
    pub block_type: u16,
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// A block position
#[derive(Debug, Clone)]
pub struct BlockPosition {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// Mesh all non-cube blocks in the state grid
pub fn mesh_models(
    grid: &BinaryGrid,
    state_grid: &BlockStateGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    bounds: Option<&MeshBounds>,
) -> ModelMeshResult {
    let mut result = ModelMeshResult::new();
    
    // Debug counters (only active once)
    static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let should_log = !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed);
    let mut total_hashes = 0u32;
    let mut found_models = 0u32;
    let mut misses_logged = 0u32;
    let mut faces_emitted = 0u32;
    let mut faces_culled = 0u32;
    
    // Log state grid and registry info once
    if should_log {
        let section_count = state_grid.iter_sections_with_states().count();
        let registry_size = super::registry::get_hash_model_registry_size();
        let registry_initialized = super::registry::is_hash_model_registry_initialized();
        web_sys::console::log_1(&format!(
            "[WASM ModelMesher] Registry: {} models, initialized={}. State grid: {} sections. bounds={:?}",
            registry_size, registry_initialized, section_count, 
            bounds.map(|b| (b.min_chunk_x, b.min_chunk_z, b.max_chunk_x, b.max_chunk_z))
        ).into());
    }
    
    // Iterate over sections with states
    for (key, section) in state_grid.iter_sections_with_states() {
        // Check bounds
        if let Some(b) = bounds {
            if key.chunk_x < b.min_chunk_x || key.chunk_x > b.max_chunk_x ||
               key.chunk_z < b.min_chunk_z || key.chunk_z > b.max_chunk_z {
                continue;
            }
        }
        
        let base_x = key.chunk_x * SECTION_SIZE as i32;
        let base_y = key.section_y * SECTION_SIZE as i32 - 64; // Adjust for world Y offset
        let base_z = key.chunk_z * SECTION_SIZE as i32;
        
        // Process each block in the section
        for local_y in 0..SECTION_SIZE {
            for local_z in 0..SECTION_SIZE {
                for local_x in 0..SECTION_SIZE {
                    let idx = block_index_in_section(local_x, local_y, local_z);
                    let state_hash = section[idx];
                    
                    if state_hash == 0 {
                        continue;
                    }
                    
                    total_hashes += 1;
                    
                    let world_x = base_x + local_x as i32;
                    let world_y = base_y + local_y as i32;
                    let world_z = base_z + local_z as i32;
                    
                    // Get model geometry by hash
                    let model = match get_model_geometry_by_hash(state_hash) {
                        Some(m) => {
                            found_models += 1;
                            m
                        },
                        None => {
                            // Log first 5 misses
                            if should_log && misses_logged < 5 {
                                misses_logged += 1;
                                web_sys::console::log_1(&format!(
                                    "[WASM ModelMesher] Hash miss #{}: 0x{:016x} at ({}, {}, {})",
                                    misses_logged, state_hash, world_x, world_y, world_z
                                ).into());
                            }
                            continue;
                        }
                    };
                    
                    // Get the model block's own light (fallback for faces without clear direction)
                    let own_light = if let Some(lg) = light_grid {
                        lg.get_light(world_x, world_y, world_z)
                    } else {
                        LightValue { sky_light: 15, block_light: 0 }
                    };
                    
                    // Process each face
                    for face in &model.faces {
                        // Check if face should be culled
                        if should_cull_face(grid, lookups, world_x, world_y, world_z, face) {
                            faces_culled += 1;
                            continue;
                        }
                        
                        // Sample light for this face based on face direction
                        // Model blocks exist in air space - when a face points INTO a solid block,
                        // use the model block's own light (not the solid block's light which is 0)
                        let (sky_light, block_light) = sample_face_light(
                            grid,
                            light_grid,
                            lookups,
                            world_x,
                            world_y,
                            world_z,
                            face,
                            &own_light,
                        );
                        
                        faces_emitted += 1;
                        // Emit face to appropriate mesh
                        // For now, all go to opaque (TODO: separate transparent)
                        emit_face(
                            &mut result.opaque,
                            face,
                            world_x as f32,
                            world_y as f32,
                            world_z as f32,
                            sky_light,
                            block_light,
                        );
                    }
                }
            }
        }
    }
    
    // Log debug info once
    if should_log {
        web_sys::console::log_1(&format!(
            "[WASM ModelMesher] Hashes looked up: {}, Models found: {} ({}% hit rate), Faces emitted: {}, culled: {}",
            total_hashes, found_models,
            if total_hashes > 0 { found_models * 100 / total_hashes } else { 0 },
            faces_emitted, faces_culled
        ).into());
    }
    
    result
}

/// Sample light for a face based on its direction
/// 
/// Model blocks exist in air space. For faces pointing into transparent blocks,
/// sample light from the adjacent position (more accurate sky light exposure).
/// For faces against solid blocks, use the model block's own light.
fn sample_face_light(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    world_x: i32,
    world_y: i32,
    world_z: i32,
    face: &ModelFace,
    own_light: &LightValue,
) -> (f32, f32) {
    // If no light grid, return full brightness
    let lg = match light_grid {
        Some(lg) => lg,
        None => return (1.0, 0.0),
    };
    
    // Get face direction for light sampling
    let face_direction = face.get_face_direction();
    
    // Get the adjacent position based on face direction
    let (adj_x, adj_y, adj_z) = match face_direction {
        Some(Face::Up) => (world_x, world_y + 1, world_z),
        Some(Face::Down) => (world_x, world_y - 1, world_z),
        Some(Face::North) => (world_x, world_y, world_z - 1),
        Some(Face::South) => (world_x, world_y, world_z + 1),
        Some(Face::West) => (world_x - 1, world_y, world_z),
        Some(Face::East) => (world_x + 1, world_y, world_z),
        None => {
            // No clear face direction (cross-model plants, etc.)
            // Use the block's own position light
            return (own_light.sky_light as f32 / 15.0, own_light.block_light as f32 / 15.0);
        }
    };
    
    // Check if adjacent block is transparent (air or non-opaque)
    let adj_block = grid.get_block(adj_x, adj_y, adj_z);
    let adj_id = (adj_block & 0x0FFF) as usize;
    
    // If adjacent is air (id=0) or not fully opaque, sample from there
    if adj_id == 0 || (adj_id < lookups.is_opaque.len() && lookups.is_opaque[adj_id] == 0) {
        let adj_light = lg.get_light(adj_x, adj_y, adj_z);
        (adj_light.sky_light as f32 / 15.0, adj_light.block_light as f32 / 15.0)
    } else {
        // Face is against a solid block - use own position's light
        (own_light.sky_light as f32 / 15.0, own_light.block_light as f32 / 15.0)
    }
}

/// Check if a face should be culled based on neighboring blocks
fn should_cull_face(
    grid: &BinaryGrid,
    lookups: &Lookups,
    x: i32,
    y: i32,
    z: i32,
    face: &ModelFace,
) -> bool {
    // Get cull direction
    let cull_face = match face.get_cull_face() {
        Some(f) => f,
        None => return false, // Never cull if no cull face specified
    };
    
    // Get neighbor position
    let (nx, ny, nz) = match cull_face {
        Face::Down => (x, y - 1, z),
        Face::Up => (x, y + 1, z),
        Face::North => (x, y, z - 1),
        Face::South => (x, y, z + 1),
        Face::West => (x - 1, y, z),
        Face::East => (x + 1, y, z),
    };
    
    // Get neighbor block
    let neighbor_block = grid.get_block(nx, ny, nz);
    let neighbor_id = (neighbor_block & 0x0FFF) as usize;
    
    // Cull if neighbor is opaque and full cube
    if neighbor_id < lookups.is_opaque.len() && lookups.is_opaque[neighbor_id] != 0 {
        // Check if it's a full cube (not a slab, stairs, etc.)
        if neighbor_id < lookups.is_non_cube.len() && lookups.is_non_cube[neighbor_id] == 0 {
            return true;
        }
    }
    
    false
}

/// Emit a face to the mesh
fn emit_face(
    mesh: &mut ModelMeshData,
    face: &ModelFace,
    world_x: f32,
    world_y: f32,
    world_z: f32,
    sky_light: f32,
    block_light: f32,
) {
    let base_vertex = mesh.vertex_count;
    
    // Calculate normal
    let normal = face.calculate_normal();
    
    // Add 4 vertices
    for i in 0..4 {
        let v = face.vertices[i];
        let uv = face.uvs[i];
        
        // Position (offset by world position)
        mesh.positions.push(world_x + v[0]);
        mesh.positions.push(world_y + v[1]);
        mesh.positions.push(world_z + v[2]);
        
        // Normal
        mesh.normals.push(normal[0]);
        mesh.normals.push(normal[1]);
        mesh.normals.push(normal[2]);
        
        // Color (white, tinting applied in shader)
        mesh.colors.push(1.0);
        mesh.colors.push(1.0);
        mesh.colors.push(1.0);
        
        // UV
        mesh.uvs.push(uv[0]);
        mesh.uvs.push(uv[1]);
        
        // Texture index
        mesh.tex_indices.push(face.texture_index as f32);
        
        // Tint type
        mesh.tint_types.push(face.tint_type as f32);
        
        // Light
        mesh.sky_light.push(sky_light);
        mesh.block_light.push(block_light);
    }
    
    // Add indices (two triangles)
    // Match JS ModelMesher winding: [0, 2, 1] and [0, 3, 2]
    // This is counter-clockwise when viewed from outside (THREE.js FrontSide)
    mesh.indices.push(base_vertex);
    mesh.indices.push(base_vertex + 2);
    mesh.indices.push(base_vertex + 1);
    mesh.indices.push(base_vertex);
    mesh.indices.push(base_vertex + 3);
    mesh.indices.push(base_vertex + 2);
    
    mesh.vertex_count += 4;
}

/// Mesh models with explicit bounds (for single-chunk processing)
pub fn mesh_models_bounded(
    grid: &BinaryGrid,
    state_grid: &BlockStateGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    bounds: Option<&MeshBounds>,
) -> ModelMeshResult {
    mesh_models(grid, state_grid, light_grid, lookups, bounds)
}

