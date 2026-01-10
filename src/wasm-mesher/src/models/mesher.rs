//! Model Mesher
//!
//! Meshes non-cube blocks (slabs, stairs, fences, etc.) using pre-baked model geometry.

use crate::grid::{BinaryGrid, LightGrid, BlockStateGrid};
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
                    
                    let world_x = base_x + local_x as i32;
                    let world_y = base_y + local_y as i32;
                    let world_z = base_z + local_z as i32;
                    
                    // Get model geometry by hash
                    let model = match get_model_geometry_by_hash(state_hash) {
                        Some(m) => m,
                        None => continue,
                    };
                    
                    // Get light at this position
                    let (sky_light, block_light) = if let Some(lg) = light_grid {
                        let light = lg.get_light(world_x, world_y, world_z);
                        (light.sky_light as f32 / 15.0, light.block_light as f32 / 15.0)
                    } else {
                        (1.0, 0.0)
                    };
                    
                    // Process each face
                    for face in &model.faces {
                        // Check if face should be culled
                        if should_cull_face(grid, lookups, world_x, world_y, world_z, face) {
                            continue;
                        }
                        
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
    
    result
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
    mesh.indices.push(base_vertex);
    mesh.indices.push(base_vertex + 1);
    mesh.indices.push(base_vertex + 2);
    mesh.indices.push(base_vertex);
    mesh.indices.push(base_vertex + 2);
    mesh.indices.push(base_vertex + 3);
    
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

