//! Mesh generation algorithms

pub mod ao;
pub mod ao_simd;
pub mod binary_cull;
pub mod fluid;
pub mod greedy;
pub mod model;

/// Common mesh data output
#[derive(Debug, Clone, Default)]
pub struct MeshData {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub colors: Vec<f32>,
    pub uvs: Vec<f32>,           // UV coordinates (2 per vertex)
    pub tex_indices: Vec<f32>,
    pub tex_rotations: Vec<f32>,
    pub tint_types: Vec<f32>,
    pub sky_light: Vec<f32>,
    pub block_light: Vec<f32>,
    /// Packed light data: high nibble = sky (0-15), low nibble = block (0-15)
    /// This is 8x smaller than the separate f32 arrays
    pub packed_light: Vec<u8>,
    pub indices: Vec<u32>,
    pub vertex_count: u32,
}

impl MeshData {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(vertex_cap: usize, index_cap: usize) -> Self {
        Self {
            positions: Vec::with_capacity(vertex_cap * 3),
            normals: Vec::with_capacity(vertex_cap * 3),
            colors: Vec::with_capacity(vertex_cap * 3),
            uvs: Vec::with_capacity(vertex_cap * 2),
            tex_indices: Vec::with_capacity(vertex_cap),
            tex_rotations: Vec::with_capacity(vertex_cap),
            tint_types: Vec::with_capacity(vertex_cap),
            sky_light: Vec::with_capacity(vertex_cap),
            block_light: Vec::with_capacity(vertex_cap),
            packed_light: Vec::with_capacity(vertex_cap),
            indices: Vec::with_capacity(index_cap),
            vertex_count: 0,
        }
    }
    
    /// Pack sky and block light into a single byte
    /// High nibble = sky (0-15), low nibble = block (0-15)
    #[inline]
    pub fn pack_light(sky: f32, block: f32) -> u8 {
        let sky_u8 = (sky.clamp(0.0, 15.0) as u8) & 0x0F;
        let block_u8 = (block.clamp(0.0, 15.0) as u8) & 0x0F;
        (sky_u8 << 4) | block_u8
    }
    
    /// Unpack light byte to (sky, block) f32 values
    #[inline]
    pub fn unpack_light(packed: u8) -> (f32, f32) {
        let sky = (packed >> 4) as f32;
        let block = (packed & 0x0F) as f32;
        (sky, block)
    }

    /// Add a quad (4 vertices, 6 indices)
    pub fn add_quad(
        &mut self,
        positions: [(f32, f32, f32); 4],
        normal: (f32, f32, f32),
        color: (f32, f32, f32),
        tex_idx: f32,
        tex_rot: f32,
        tint: f32,
        sky: [f32; 4],
        block: [f32; 4],
        flip_winding: bool,
    ) {
        // Use default UVs for solid blocks (0,0), (1,0), (1,1), (0,1)
        let uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        self.add_quad_with_uvs(positions, normal, color, uvs, tex_idx, tex_rot, tint, sky, block, flip_winding);
    }

    /// Add a quad with explicit UV coordinates
    pub fn add_quad_with_uvs(
        &mut self,
        positions: [(f32, f32, f32); 4],
        normal: (f32, f32, f32),
        color: (f32, f32, f32),
        uvs: [(f32, f32); 4],
        tex_idx: f32,
        tex_rot: f32,
        tint: f32,
        sky: [f32; 4],
        block: [f32; 4],
        flip_winding: bool,
    ) {
        let base = self.vertex_count;

        // Add vertex data
        for i in 0..4 {
            self.positions.push(positions[i].0);
            self.positions.push(positions[i].1);
            self.positions.push(positions[i].2);
            self.normals.push(normal.0);
            self.normals.push(normal.1);
            self.normals.push(normal.2);
            self.colors.push(color.0);
            self.colors.push(color.1);
            self.colors.push(color.2);
            self.uvs.push(uvs[i].0);
            self.uvs.push(uvs[i].1);
            self.tex_indices.push(tex_idx);
            self.tex_rotations.push(tex_rot);
            self.tint_types.push(tint);
            self.sky_light.push(sky[i]);
            self.block_light.push(block[i]);
            // Also add packed light for efficient transfer
            self.packed_light.push(Self::pack_light(sky[i], block[i]));
        }

        // Add indices (two triangles)
        if flip_winding {
            // AO-based winding: 0-1-2, 0-2-3
            self.indices.push(base);
            self.indices.push(base + 1);
            self.indices.push(base + 2);
            self.indices.push(base);
            self.indices.push(base + 2);
            self.indices.push(base + 3);
        } else {
            // Standard winding: 0-1-2, 0-2-3
            self.indices.push(base);
            self.indices.push(base + 1);
            self.indices.push(base + 2);
            self.indices.push(base);
            self.indices.push(base + 2);
            self.indices.push(base + 3);
        }

        self.vertex_count += 4;
    }
}

/// Result from fluid meshing (water + lava)
#[derive(Debug, Default)]
pub struct FluidMeshResult {
    pub water: MeshData,
    pub lava: MeshData,
}

/// Bounds for mesh generation (only blocks within these chunk coords generate geometry)
/// Blocks outside bounds are still used for neighbor lookups (lighting, fluid height, face culling)
#[derive(Debug, Clone, Copy)]
pub struct MeshBounds {
    pub min_chunk_x: i32,
    pub min_chunk_z: i32,
    pub max_chunk_x: i32,
    pub max_chunk_z: i32,
}

impl MeshBounds {
    /// Check if a world position is within bounds
    #[inline]
    pub fn contains(&self, world_x: i32, world_z: i32) -> bool {
        let chunk_x = world_x.div_euclid(16);
        let chunk_z = world_z.div_euclid(16);
        chunk_x >= self.min_chunk_x && chunk_x <= self.max_chunk_x &&
        chunk_z >= self.min_chunk_z && chunk_z <= self.max_chunk_z
    }
    
    /// Check if a chunk is within bounds
    #[inline]
    pub fn contains_chunk(&self, chunk_x: i32, chunk_z: i32) -> bool {
        chunk_x >= self.min_chunk_x && chunk_x <= self.max_chunk_x &&
        chunk_z >= self.min_chunk_z && chunk_z <= self.max_chunk_z
    }
}

