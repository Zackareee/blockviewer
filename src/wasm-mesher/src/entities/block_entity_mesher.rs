//! Block Entity Mesher
//!
//! Generates mesh geometry for block entities using the block entity registry
//! and entity state grid. This is the updated mesher that uses the new model
//! format extracted from Minecraft.
//!
//! ## Coordinate System
//!
//! - Model coordinates are in block space (0-1)
//! - Rotation is applied around block center (0.5, 0.5, 0.5)
//! - World position is added after rotation

use super::block_entity_registry::{get_block_entity_registry, FaceDir, BlockEntityModel};
use super::entity_state_grid::{EntityPos, unpack_entity_type, unpack_variant, unpack_rotation, unpack_color};
use super::EntityStateGrid;
use crate::grid::LightGrid;
use crate::mesher::MeshBounds;

/// Result of block entity meshing
pub struct BlockEntityMeshResult {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
    pub colors: Vec<f32>,
    pub tex_indices: Vec<f32>,
    pub sky_light: Vec<f32>,
    pub block_light: Vec<f32>,
    pub indices: Vec<u32>,
    pub vertex_count: u32,
}

impl BlockEntityMeshResult {
    pub fn new() -> Self {
        Self {
            positions: Vec::new(),
            normals: Vec::new(),
            uvs: Vec::new(),
            colors: Vec::new(),
            tex_indices: Vec::new(),
            sky_light: Vec::new(),
            block_light: Vec::new(),
            indices: Vec::new(),
            vertex_count: 0,
        }
    }
    
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }
}

impl Default for BlockEntityMeshResult {
    fn default() -> Self {
        Self::new()
    }
}

/// Mesh all block entities in the state grid
pub fn mesh_block_entities(
    entity_grid: &EntityStateGrid,
    light_grid: Option<&LightGrid>,
    bounds: Option<&MeshBounds>,
) -> BlockEntityMeshResult {
    let registry = match get_block_entity_registry() {
        Some(r) => r,
        None => return BlockEntityMeshResult::new(),
    };
    
    if entity_grid.is_empty() {
        return BlockEntityMeshResult::new();
    }
    
    let mut result = BlockEntityMeshResult::new();
    
    // Filter entities by bounds if provided
    let entities: Vec<_> = if let Some(b) = bounds {
        let min_x = b.min_chunk_x * 16;
        let max_x = (b.max_chunk_x + 1) * 16 - 1;
        let min_z = b.min_chunk_z * 16;
        let max_z = (b.max_chunk_z + 1) * 16 - 1;
        entity_grid.iter_in_bounds(min_x, min_z, max_x, max_z).collect()
    } else {
        entity_grid.iter().collect()
    };
    
    for (pos, &state) in entities {
        let entity_type = unpack_entity_type(state);
        let variant_idx = unpack_variant(state);
        let rotation = unpack_rotation(state);
        let color = unpack_color(state);
        
        // Get model by index
        let model = match registry.get_by_index(entity_type as usize) {
            Some(m) => m,
            None => continue,
        };
        
        // Get lighting at entity position
        let (sky_light, block_light) = if let Some(lg) = light_grid {
            let lv = lg.get_light(pos.x, pos.y, pos.z);
            (lv.sky_light as f32 / 15.0, lv.block_light as f32 / 15.0)
        } else {
            (1.0, 0.0)
        };
        
        // Calculate rotation matrix
        let rot_matrix = rotation_matrix_y(rotation);
        
        // Mesh all elements
        for element in &model.elements {
            for face in &element.faces {
                add_face(
                    &mut result,
                    element,
                    face,
                    pos,
                    &rot_matrix,
                    variant_idx as f32,
                    sky_light,
                    block_light,
                );
            }
        }
    }
    
    result.vertex_count = (result.positions.len() / 3) as u32;
    result
}

/// Add a single face to the mesh
fn add_face(
    result: &mut BlockEntityMeshResult,
    element: &super::block_entity_registry::BlockElement,
    face: &super::block_entity_registry::ElementFace,
    pos: &EntityPos,
    rot_matrix: &[[f32; 3]; 3],
    tex_index: f32,
    sky_light: f32,
    block_light: f32,
) {
    let base_vertex = result.vertex_count;
    
    // Get vertices and UVs for this face
    let vertices = element.get_face_vertices(face.direction);
    let uvs = element.get_face_uvs(face);
    let normal = face.direction.normal();
    
    // Add vertices
    for i in 0..4 {
        let v = vertices[i];
        
        // Apply rotation around center (0.5, 0.5, 0.5)
        let centered = [v[0] - 0.5, v[1] - 0.5, v[2] - 0.5];
        let rotated = [
            centered[0] * rot_matrix[0][0] + centered[1] * rot_matrix[0][1] + centered[2] * rot_matrix[0][2],
            centered[0] * rot_matrix[1][0] + centered[1] * rot_matrix[1][1] + centered[2] * rot_matrix[1][2],
            centered[0] * rot_matrix[2][0] + centered[1] * rot_matrix[2][1] + centered[2] * rot_matrix[2][2],
        ];
        
        // Transform to world position
        result.positions.push(pos.x as f32 + rotated[0] + 0.5);
        result.positions.push(pos.y as f32 + rotated[1] + 0.5);
        result.positions.push(pos.z as f32 + rotated[2] + 0.5);
        
        // Rotate normal
        result.normals.push(
            normal[0] * rot_matrix[0][0] + normal[1] * rot_matrix[0][1] + normal[2] * rot_matrix[0][2]
        );
        result.normals.push(
            normal[0] * rot_matrix[1][0] + normal[1] * rot_matrix[1][1] + normal[2] * rot_matrix[1][2]
        );
        result.normals.push(
            normal[0] * rot_matrix[2][0] + normal[1] * rot_matrix[2][1] + normal[2] * rot_matrix[2][2]
        );
        
        // UV
        result.uvs.push(uvs[i][0]);
        result.uvs.push(uvs[i][1]);
        
        // Color (white)
        result.colors.push(1.0);
        result.colors.push(1.0);
        result.colors.push(1.0);
        
        // Texture index
        result.tex_indices.push(tex_index);
        
        // Lighting
        result.sky_light.push(sky_light);
        result.block_light.push(block_light);
    }
    
    // Add indices (two triangles per quad)
    result.indices.push(base_vertex);
    result.indices.push(base_vertex + 1);
    result.indices.push(base_vertex + 2);
    result.indices.push(base_vertex);
    result.indices.push(base_vertex + 2);
    result.indices.push(base_vertex + 3);
    
    result.vertex_count += 4;
}

/// Create Y-axis rotation matrix
/// Rotation is 0-15 representing 0-360 degrees (22.5 degree increments)
/// 0=north(0°), 4=east(90°), 8=south(180°), 12=west(270°)
fn rotation_matrix_y(rotation: u8) -> [[f32; 3]; 3] {
    // All rotations use 16-step system: rotation * 22.5° = angle in degrees
    // rotation 0 = 0° (north)
    // rotation 4 = 90° (east)
    // rotation 8 = 180° (south)
    // rotation 12 = 270° (west)
    let angle = (rotation as f32) * std::f32::consts::PI * 2.0 / 16.0;
    
    let cos_a = angle.cos();
    let sin_a = angle.sin();
    
    [
        [cos_a, 0.0, -sin_a],
        [0.0, 1.0, 0.0],
        [sin_a, 0.0, cos_a],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_rotation_matrix_identity() {
        let mat = rotation_matrix_y(0);
        
        // Should be close to identity for rotation 0 (facing north)
        assert!((mat[0][0] - 1.0).abs() < 0.001);
        assert!((mat[1][1] - 1.0).abs() < 0.001);
        assert!((mat[2][2] - 1.0).abs() < 0.001);
    }
    
    #[test]
    fn test_rotation_matrix_90() {
        let mat = rotation_matrix_y(1); // 90 degrees (facing east)
        
        // cos(90) ≈ 0, sin(90) ≈ 1
        assert!(mat[0][0].abs() < 0.001);
        assert!((mat[2][0] - 1.0).abs() < 0.001);
    }
}
