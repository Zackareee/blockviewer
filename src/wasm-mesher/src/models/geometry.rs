//! Model Geometry Types
//!
//! Defines the data structures for block model geometry.

use crate::types::Face;

/// Model geometry for a single block state
#[derive(Debug, Clone)]
pub struct ModelGeometry {
    /// Faces that make up this model
    pub faces: Vec<ModelFace>,
    /// Whether this model is a full cube (all 6 faces present and full size)
    pub is_full_cube: bool,
    /// Whether this model is transparent (affects neighbor face culling)
    pub is_transparent: bool,
}

impl ModelGeometry {
    pub fn new() -> Self {
        Self {
            faces: Vec::new(),
            is_full_cube: false,
            is_transparent: false,
        }
    }
}

impl Default for ModelGeometry {
    fn default() -> Self {
        Self::new()
    }
}

/// A single face of a block model
#[derive(Debug, Clone)]
pub struct ModelFace {
    /// Which direction this face points (for culling)
    /// 0=down, 1=up, 2=north, 3=south, 4=west, 5=east, 6=none (interior face)
    pub direction: u8,
    /// 4 corner vertices [x, y, z] in block-local coordinates (0-1 range)
    pub vertices: [[f32; 3]; 4],
    /// UV coordinates for each vertex
    pub uvs: [[f32; 2]; 4],
    /// Texture atlas index
    pub texture_index: u16,
    /// Tint type: 0=none, 1=grass, 2=foliage, 3=water, 4=redstone
    pub tint_type: u8,
    /// Which neighbor to check for face culling
    /// 0=down, 1=up, 2=north, 3=south, 4=west, 5=east, 255=never cull
    pub cull_face: u8,
}

impl ModelFace {
    /// Convert direction byte to Face enum
    pub fn get_face_direction(&self) -> Option<Face> {
        match self.direction {
            0 => Some(Face::Down),
            1 => Some(Face::Up),
            2 => Some(Face::North),
            3 => Some(Face::South),
            4 => Some(Face::West),
            5 => Some(Face::East),
            _ => None, // Interior face
        }
    }

    /// Get the cull face direction
    pub fn get_cull_face(&self) -> Option<Face> {
        match self.cull_face {
            0 => Some(Face::Down),
            1 => Some(Face::Up),
            2 => Some(Face::North),
            3 => Some(Face::South),
            4 => Some(Face::West),
            5 => Some(Face::East),
            _ => None, // Never cull
        }
    }

    /// Calculate face normal from vertices
    pub fn calculate_normal(&self) -> [f32; 3] {
        // Use first 3 vertices to calculate normal
        let v0 = self.vertices[0];
        let v1 = self.vertices[1];
        let v2 = self.vertices[2];

        let edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        let edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];

        // Cross product
        let nx = edge1[1] * edge2[2] - edge1[2] * edge2[1];
        let ny = edge1[2] * edge2[0] - edge1[0] * edge2[2];
        let nz = edge1[0] * edge2[1] - edge1[1] * edge2[0];

        // Normalize
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 0.0001 {
            [nx / len, ny / len, nz / len]
        } else {
            [0.0, 1.0, 0.0] // Default up
        }
    }
}

/// Result of model meshing
#[derive(Debug, Clone)]
pub struct ModelMeshData {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub colors: Vec<f32>,
    pub uvs: Vec<f32>,
    pub tex_indices: Vec<f32>,
    pub tint_types: Vec<f32>,
    pub sky_light: Vec<f32>,
    pub block_light: Vec<f32>,
    /// Packed light: high nibble = sky (0-15), low nibble = block (0-15)
    pub packed_light: Vec<u8>,
    /// Per-vertex shade flag (0.0 = no shade, 1.0 = apply directional shading)
    pub shade_flags: Vec<f32>,
    pub indices: Vec<u32>,
    pub vertex_count: u32,
}

impl ModelMeshData {
    pub fn new() -> Self {
        Self {
            positions: Vec::new(),
            normals: Vec::new(),
            colors: Vec::new(),
            uvs: Vec::new(),
            tex_indices: Vec::new(),
            tint_types: Vec::new(),
            sky_light: Vec::new(),
            block_light: Vec::new(),
            packed_light: Vec::new(),
            shade_flags: Vec::new(),
            indices: Vec::new(),
            vertex_count: 0,
        }
    }
}

impl Default for ModelMeshData {
    fn default() -> Self {
        Self::new()
    }
}

