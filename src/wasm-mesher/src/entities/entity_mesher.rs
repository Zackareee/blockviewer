//! Entity Mesher
//!
//! Generates mesh geometry for block entities using the entity registry
//! and entity state grid.

use super::entity_registry::{EntityFace, get_entity_registry};
use super::entity_state_grid::{EntityPos, unpack_entity_type, unpack_variant, unpack_rotation, unpack_color};
use super::EntityStateGrid;
use crate::grid::LightGrid;
use crate::mesher::MeshBounds;

/// Result of entity meshing
pub struct EntityMeshResult {
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

impl EntityMeshResult {
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

impl Default for EntityMeshResult {
    fn default() -> Self {
        Self::new()
    }
}

/// Mesh all entities in the state grid
pub fn mesh_entities(
    entity_grid: &EntityStateGrid,
    light_grid: Option<&LightGrid>,
    bounds: Option<&MeshBounds>,
) -> EntityMeshResult {
    let registry = match get_entity_registry() {
        Some(r) => r,
        None => return EntityMeshResult::new(),
    };
    
    if entity_grid.is_empty() {
        return EntityMeshResult::new();
    }
    
    let mut result = EntityMeshResult::new();
    
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
        
        // Get entity model
        let model = match registry.get_by_index(entity_type as usize) {
            Some(m) => m,
            None => continue,
        };
        
        // Get variant
        let variant = match model.variants.get(variant_idx as usize) {
            Some(v) => v,
            None => match model.default_variant() {
                Some(v) => v,
                None => continue,
            },
        };
        
        // Get lighting at entity position
        let light_value = if let Some(lg) = light_grid {
            lg.get_light(pos.x, pos.y, pos.z)
        } else {
            crate::grid::LightValue::new(15, 0)
        };
        let (sky, block) = (light_value.sky_light, light_value.block_light);
        
        let sky_light_f = sky as f32 / 15.0;
        let block_light_f = block as f32 / 15.0;
        
        // Get texture index (base + color offset if applicable)
        let tex_index = if model.has_color_variants() {
            model.base_texture_index as f32 + color as f32
        } else {
            model.base_texture_index as f32
        };
        
        // Calculate rotation matrix for Y rotation
        let rot_matrix = rotation_matrix_y(rotation, model.has_16_rotations());
        
        // Add faces
        for face in &variant.faces {
            add_face(
                &mut result,
                face,
                pos,
                &rot_matrix,
                tex_index,
                sky_light_f,
                block_light_f,
            );
        }
    }
    
    result.vertex_count = (result.positions.len() / 3) as u32;
    result
}

/// Add a single face to the mesh
fn add_face(
    result: &mut EntityMeshResult,
    face: &EntityFace,
    pos: &EntityPos,
    rot_matrix: &[[f32; 3]; 3],
    tex_index: f32,
    sky_light: f32,
    block_light: f32,
) {
    let base_vertex = result.vertex_count;
    
    // Add vertices
    for i in 0..4 {
        let v = &face.vertices[i];
        
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
        let n = &face.normal;
        result.normals.push(n[0] * rot_matrix[0][0] + n[1] * rot_matrix[0][1] + n[2] * rot_matrix[0][2]);
        result.normals.push(n[0] * rot_matrix[1][0] + n[1] * rot_matrix[1][1] + n[2] * rot_matrix[1][2]);
        result.normals.push(n[0] * rot_matrix[2][0] + n[1] * rot_matrix[2][1] + n[2] * rot_matrix[2][2]);
        
        // UV
        let uv = &face.uvs[i];
        result.uvs.push(uv[0]);
        result.uvs.push(uv[1]);
        
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
fn rotation_matrix_y(rotation: u8, is_16_rotations: bool) -> [[f32; 3]; 3] {
    let angle = if is_16_rotations {
        // 0-15 maps to 0-360 degrees
        (rotation as f32) * std::f32::consts::PI * 2.0 / 16.0
    } else {
        // 0-3 maps to 0, 90, 180, 270 degrees (from facing property)
        match rotation & 0x03 {
            0 => 0.0,                              // North (facing south)
            1 => std::f32::consts::FRAC_PI_2,      // East (facing west)
            2 => std::f32::consts::PI,             // South (facing north)
            3 => -std::f32::consts::FRAC_PI_2,     // West (facing east)
            _ => 0.0,
        }
    };
    
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
        let mat = rotation_matrix_y(0, false);
        
        // Should be close to identity for rotation 0
        assert!((mat[0][0] - 1.0).abs() < 0.001);
        assert!((mat[1][1] - 1.0).abs() < 0.001);
        assert!((mat[2][2] - 1.0).abs() < 0.001);
    }
    
    #[test]
    fn test_rotation_matrix_90() {
        let mat = rotation_matrix_y(1, false); // 90 degrees
        
        // cos(90) ≈ 0, sin(90) ≈ 1
        assert!(mat[0][0].abs() < 0.001);
        assert!((mat[2][0] - 1.0).abs() < 0.001);
    }
}
