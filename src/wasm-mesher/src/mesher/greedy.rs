//! Greedy Mesher - Optimized face merging for solid blocks
//!
//! Uses a greedy algorithm to merge adjacent faces of the same block type
//! into larger quads, reducing vertex count significantly.

use crate::grid::{BinaryGrid, LightGrid};
use crate::lookup::Lookups;
use crate::mesher::{MeshData, ao};
use crate::types::{
    Face, SectionKey, SECTION_SIZE, SECTION_VOLUME, BLOCK_ID_MASK, SLAB_MASK, SLAB_SHIFT,
    SLAB_DOUBLE, block_index_in_section, section_to_world_y,
};

const S: usize = SECTION_SIZE;
const S2: usize = S * S;
const S3: usize = SECTION_VOLUME;

/// Initial buffer size (vertices)
const INITIAL_CAPACITY: usize = 16384;

/// Check if a block value is a full cube for greedy meshing
#[inline]
fn is_full_cube(value: u16, lookups: &Lookups) -> bool {
    let block_id = value & BLOCK_ID_MASK;
    if block_id == 0 {
        return false;
    }
    if !lookups.is_opaque(block_id) {
        return false;
    }
    
    // Slab blocks: only double slabs are full cubes
    if lookups.is_slab(block_id) {
        let slab_type = ((value & SLAB_MASK) >> SLAB_SHIFT) as u8;
        return slab_type == SLAB_DOUBLE;
    }
    
    // Non-cube blocks are not full cubes
    if lookups.is_non_cube(block_id) {
        return false;
    }
    
    true
}

/// Check if a neighbor blocks a face
#[inline]
fn neighbor_blocks_face(value: u16, lookups: &Lookups) -> bool {
    let block_id = value & BLOCK_ID_MASK;
    if block_id == 0 {
        return false;
    }
    if !lookups.is_opaque(block_id) {
        return false;
    }
    
    // Slabs only block certain faces
    if lookups.is_slab(block_id) {
        let slab_type = ((value & SLAB_MASK) >> SLAB_SHIFT) as u8;
        return slab_type == SLAB_DOUBLE;
    }
    
    if lookups.is_non_cube(block_id) {
        return false;
    }
    
    true
}

/// Check if block is glass (for separate mesh)
#[inline]
fn is_glass_block(value: u16, lookups: &Lookups) -> bool {
    let block_id = value & BLOCK_ID_MASK;
    lookups.is_glass(block_id)
}

/// Mesh solid blocks using greedy algorithm
pub fn mesh_solid(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
) -> MeshData {
    mesh_solid_bounded(grid, light_grid, lookups, None)
}

/// Mesh solid blocks with optional bounds
pub fn mesh_solid_bounded(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    bounds: Option<&super::MeshBounds>,
) -> MeshData {
    let mut mesh = MeshData::with_capacity(INITIAL_CAPACITY, INITIAL_CAPACITY * 6 / 4);
    
    // Reusable mask for greedy merging
    let mut mask = vec![0u16; S2];
    let mut visited = vec![false; S2];

    // Process each section
    for (key, section) in grid.iter_sections() {
        // Skip sections outside bounds (they're only for neighbor lookups)
        if let Some(b) = bounds {
            if !b.contains_chunk(key.chunk_x, key.chunk_z) {
                continue;
            }
        }
        
        let base_x = key.chunk_x * S as i32;
        let base_y = section_to_world_y(key.section_y);
        let base_z = key.chunk_z * S as i32;

        // Skip empty sections
        let non_air: usize = section.iter().filter(|&&v| v != 0).count();
        if non_air == 0 {
            continue;
        }

        // Get neighbor sections for face culling
        let sec_top = grid.get_neighbor_section(&key, 0, 1, 0);
        let sec_bot = grid.get_neighbor_section(&key, 0, -1, 0);
        let sec_east = grid.get_neighbor_section(&key, 1, 0, 0);
        let sec_west = grid.get_neighbor_section(&key, -1, 0, 0);
        let sec_south = grid.get_neighbor_section(&key, 0, 0, 1);
        let sec_north = grid.get_neighbor_section(&key, 0, 0, -1);

        // Process each face direction
        mesh_face_top(section, sec_top, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_face_bottom(section, sec_bot, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_face_north(section, sec_north, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_face_south(section, sec_south, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_face_east(section, sec_east, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_face_west(section, sec_west, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
    }

    mesh
}

/// Mesh glass blocks separately (transparent)
pub fn mesh_glass(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
) -> MeshData {
    mesh_glass_bounded(grid, light_grid, lookups, None)
}

/// Mesh glass blocks with optional bounds
pub fn mesh_glass_bounded(
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    bounds: Option<&super::MeshBounds>,
) -> MeshData {
    let mut mesh = MeshData::with_capacity(INITIAL_CAPACITY / 4, INITIAL_CAPACITY / 4 * 6 / 4);
    
    let mut mask = vec![0u16; S2];
    let mut visited = vec![false; S2];

    for (key, section) in grid.iter_sections() {
        // Skip sections outside bounds (they're only for neighbor lookups)
        if let Some(b) = bounds {
            if !b.contains_chunk(key.chunk_x, key.chunk_z) {
                continue;
            }
        }
        
        let base_x = key.chunk_x * S as i32;
        let base_y = section_to_world_y(key.section_y);
        let base_z = key.chunk_z * S as i32;

        let sec_top = grid.get_neighbor_section(&key, 0, 1, 0);
        let sec_bot = grid.get_neighbor_section(&key, 0, -1, 0);
        let sec_east = grid.get_neighbor_section(&key, 1, 0, 0);
        let sec_west = grid.get_neighbor_section(&key, -1, 0, 0);
        let sec_south = grid.get_neighbor_section(&key, 0, 0, 1);
        let sec_north = grid.get_neighbor_section(&key, 0, 0, -1);

        mesh_glass_face_top(section, sec_top, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_glass_face_bottom(section, sec_bot, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_glass_face_north(section, sec_north, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_glass_face_south(section, sec_south, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_glass_face_east(section, sec_east, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
        mesh_glass_face_west(section, sec_west, base_x, base_y, base_z, grid, light_grid, lookups, &mut mask, &mut visited, &mut mesh);
    }

    mesh
}

// ============================================================================
// TOP FACE (+Y)
// ============================================================================

fn mesh_face_top(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    mask: &mut [u16],
    visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for ly in 0..S {
        mask.fill(0);
        let mut has_faces = false;

        let slice_base = ly * S2;
        for j in 0..S2 {
            let value = section[slice_base + j];
            if !is_full_cube(value, lookups) {
                continue;
            }

            // Check neighbor above
            let n_value = if ly < S - 1 {
                section[slice_base + S2 + j]
            } else if let Some(n) = neighbor {
                n[j]
            } else {
                0
            };

            if !neighbor_blocks_face(n_value, lookups) {
                mask[j] = value & BLOCK_ID_MASK;
                has_faces = true;
            }
        }

        if !has_faces {
            continue;
        }

        // Greedy merge
        visited.fill(false);
        let block_y = base_y + ly as i32;

        for jj in 0..S {
            for ii in 0..S {
                let mi = jj * S + ii;
                if visited[mi] || mask[mi] == 0 {
                    continue;
                }

                let block_id = mask[mi];
                let world_x = base_x + ii as i32;
                let world_z = base_z + jj as i32;

                // Get AO for starting block
                let start_ao = ao::get_top_face_ao(grid, lookups, world_x, block_y, world_z);
                let face_y = block_y + 1;
                let (start_sky, start_block) = ao::get_face_light(light_grid, world_x, face_y, world_z);

                // Expand width (+X)
                let mut w = 1usize;
                while ii + w < S && !visited[mi + w] && mask[mi + w] == block_id {
                    let check_ao = ao::get_top_face_ao(grid, lookups, world_x + w as i32, block_y, world_z);
                    if !start_ao.matches(&check_ao) {
                        break;
                    }
                    // Check light compatibility
                    let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + w as i32, face_y, world_z);
                    if check_sky != start_sky || check_block != start_block {
                        break;
                    }
                    w += 1;
                }

                // Expand height (+Z)
                let mut h = 1usize;
                'outer: while jj + h < S {
                    for k in 0..w {
                        let ci = (jj + h) * S + ii + k;
                        if visited[ci] || mask[ci] != block_id {
                            break 'outer;
                        }
                        let check_ao = ao::get_top_face_ao(grid, lookups, world_x + k as i32, block_y, world_z + h as i32);
                        if !start_ao.matches(&check_ao) {
                            break 'outer;
                        }
                        // Check light compatibility
                        let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + k as i32, face_y, world_z + h as i32);
                        if check_sky != start_sky || check_block != start_block {
                            break 'outer;
                        }
                    }
                    h += 1;
                }

                // Mark visited
                for dj in 0..h {
                    for di in 0..w {
                        visited[(jj + dj) * S + ii + di] = true;
                    }
                }

                // Generate quad
                let x = world_x as f32;
                let y = (block_y + 1) as f32;
                let z = world_z as f32;
                let wf = w as f32;
                let hf = h as f32;

                let positions = [
                    (x, y, z + hf),      // V0 (SW)
                    (x + wf, y, z + hf), // V1 (SE)
                    (x + wf, y, z),      // V2 (NE)
                    (x, y, z),           // V3 (NW)
                ];

                // Sample smooth light with AO at each vertex corner
                // Vertex positions in world coords: (world_x, block_y+1, world_z+h), etc.
                let ao_levels = [start_ao.v0, start_ao.v1, start_ao.v2, start_ao.v3];
                let vertex_coords = [
                    (world_x, world_z + h as i32),      // V0 (SW)
                    (world_x + w as i32, world_z + h as i32), // V1 (SE)
                    (world_x + w as i32, world_z),      // V2 (NE)
                    (world_x, world_z),                 // V3 (NW)
                ];
                
                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                
                let face_y = block_y + 1;
                for i in 0..4 {
                    let (vx, vz) = vertex_coords[i];
                    let (s, b) = ao::sample_smooth_vertex_light(
                        grid, light_grid, lookups,
                        vx, face_y, vz,
                        ao_levels[i],
                        ao::Plane::XZ,
                    );
                    sky[i] = s;
                    block_light[i] = b;
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::Up as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::Up as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::Up.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    start_ao.should_flip(),
                );
            }
        }
    }
}

// ============================================================================
// BOTTOM FACE (-Y)
// ============================================================================

fn mesh_face_bottom(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    mask: &mut [u16],
    visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for ly in 0..S {
        mask.fill(0);
        let mut has_faces = false;

        let slice_base = ly * S2;
        for j in 0..S2 {
            let value = section[slice_base + j];
            if !is_full_cube(value, lookups) {
                continue;
            }

            let n_value = if ly > 0 {
                section[slice_base - S2 + j]
            } else if let Some(n) = neighbor {
                n[(S - 1) * S2 + j]
            } else {
                0
            };

            if !neighbor_blocks_face(n_value, lookups) {
                mask[j] = value & BLOCK_ID_MASK;
                has_faces = true;
            }
        }

        if !has_faces {
            continue;
        }

        visited.fill(false);
        let block_y = base_y + ly as i32;

        for jj in 0..S {
            for ii in 0..S {
                let mi = jj * S + ii;
                if visited[mi] || mask[mi] == 0 {
                    continue;
                }

                let block_id = mask[mi];
                let world_x = base_x + ii as i32;
                let world_z = base_z + jj as i32;

                let start_ao = ao::get_bottom_face_ao(grid, lookups, world_x, block_y, world_z);
                let face_y = block_y - 1;
                let (start_sky, start_block) = ao::get_face_light(light_grid, world_x, face_y, world_z);

                let mut w = 1usize;
                while ii + w < S && !visited[mi + w] && mask[mi + w] == block_id {
                    let check_ao = ao::get_bottom_face_ao(grid, lookups, world_x + w as i32, block_y, world_z);
                    if !start_ao.matches(&check_ao) {
                        break;
                    }
                    let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + w as i32, face_y, world_z);
                    if check_sky != start_sky || check_block != start_block {
                        break;
                    }
                    w += 1;
                }

                let mut h = 1usize;
                'outer: while jj + h < S {
                    for k in 0..w {
                        let ci = (jj + h) * S + ii + k;
                        if visited[ci] || mask[ci] != block_id {
                            break 'outer;
                        }
                        let check_ao = ao::get_bottom_face_ao(grid, lookups, world_x + k as i32, block_y, world_z + h as i32);
                        if !start_ao.matches(&check_ao) {
                            break 'outer;
                        }
                        let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + k as i32, face_y, world_z + h as i32);
                        if check_sky != start_sky || check_block != start_block {
                            break 'outer;
                        }
                    }
                    h += 1;
                }

                for dj in 0..h {
                    for di in 0..w {
                        visited[(jj + dj) * S + ii + di] = true;
                    }
                }

                let x = world_x as f32;
                let y = block_y as f32;
                let z = world_z as f32;
                let wf = w as f32;
                let hf = h as f32;

                let positions = [
                    (x, y, z),           // V0 (NW)
                    (x + wf, y, z),      // V1 (NE)
                    (x + wf, y, z + hf), // V2 (SE)
                    (x, y, z + hf),      // V3 (SW)
                ];

                // Sample smooth light with AO at each vertex corner
                let ao_levels = [start_ao.v0, start_ao.v1, start_ao.v2, start_ao.v3];
                let vertex_coords = [
                    (world_x, world_z),                 // V0 (NW)
                    (world_x + w as i32, world_z),      // V1 (NE)
                    (world_x + w as i32, world_z + h as i32), // V2 (SE)
                    (world_x, world_z + h as i32),      // V3 (SW)
                ];
                
                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                
                let face_y = block_y - 1;
                for i in 0..4 {
                    let (vx, vz) = vertex_coords[i];
                    let (s, b) = ao::sample_smooth_vertex_light(
                        grid, light_grid, lookups,
                        vx, face_y, vz,
                        ao_levels[i],
                        ao::Plane::XZ,
                    );
                    sky[i] = s;
                    block_light[i] = b;
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::Down as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::Down as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::Down.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    start_ao.should_flip(),
                );
            }
        }
    }
}

// ============================================================================
// NORTH FACE (-Z)
// ============================================================================

fn mesh_face_north(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    mask: &mut [u16],
    visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lz in 0..S {
        mask.fill(0);
        let mut has_faces = false;

        for ly in 0..S {
            for lx in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_full_cube(value, lookups) {
                    continue;
                }

                let n_value = if lz > 0 {
                    section[idx - S]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + (S - 1) * S + lx]
                } else {
                    0
                };

                if !neighbor_blocks_face(n_value, lookups) {
                    mask[ly * S + lx] = value & BLOCK_ID_MASK;
                    has_faces = true;
                }
            }
        }

        if !has_faces {
            continue;
        }

        visited.fill(false);
        let world_z = base_z + lz as i32;

        for jj in 0..S {
            for ii in 0..S {
                let mi = jj * S + ii;
                if visited[mi] || mask[mi] == 0 {
                    continue;
                }

                let block_id = mask[mi];
                let world_x = base_x + ii as i32;
                let block_y = base_y + jj as i32;

                let start_ao = ao::get_north_face_ao(grid, lookups, world_x, block_y, world_z);
                let face_z = world_z - 1;
                let (start_sky, start_block) = ao::get_face_light(light_grid, world_x, block_y, face_z);

                let mut w = 1usize;
                while ii + w < S && !visited[mi + w] && mask[mi + w] == block_id {
                    let check_ao = ao::get_north_face_ao(grid, lookups, world_x + w as i32, block_y, world_z);
                    if !start_ao.matches(&check_ao) {
                        break;
                    }
                    let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + w as i32, block_y, face_z);
                    if check_sky != start_sky || check_block != start_block {
                        break;
                    }
                    w += 1;
                }

                let mut h = 1usize;
                'outer: while jj + h < S {
                    for k in 0..w {
                        let ci = (jj + h) * S + ii + k;
                        if visited[ci] || mask[ci] != block_id {
                            break 'outer;
                        }
                        let check_ao = ao::get_north_face_ao(grid, lookups, world_x + k as i32, block_y + h as i32, world_z);
                        if !start_ao.matches(&check_ao) {
                            break 'outer;
                        }
                        let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + k as i32, block_y + h as i32, face_z);
                        if check_sky != start_sky || check_block != start_block {
                            break 'outer;
                        }
                    }
                    h += 1;
                }

                for dj in 0..h {
                    for di in 0..w {
                        visited[(jj + dj) * S + ii + di] = true;
                    }
                }

                let x = world_x as f32;
                let y = block_y as f32;
                let z = world_z as f32;
                let wf = w as f32;
                let hf = h as f32;

                let positions = [
                    (x + wf, y, z),      // V0
                    (x, y, z),           // V1
                    (x, y + hf, z),      // V2
                    (x + wf, y + hf, z), // V3
                ];

                // Sample smooth light with AO at each vertex corner
                let ao_levels = [start_ao.v0, start_ao.v1, start_ao.v2, start_ao.v3];
                let vertex_coords = [
                    (world_x + w as i32, block_y),      // V0
                    (world_x, block_y),                 // V1
                    (world_x, block_y + h as i32),      // V2
                    (world_x + w as i32, block_y + h as i32), // V3
                ];
                
                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                
                let face_z = world_z - 1;
                for i in 0..4 {
                    let (vx, vy) = vertex_coords[i];
                    let (s, b) = ao::sample_smooth_vertex_light(
                        grid, light_grid, lookups,
                        vx, vy, face_z,
                        ao_levels[i],
                        ao::Plane::XY,
                    );
                    sky[i] = s;
                    block_light[i] = b;
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::North as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::North as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::North.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    start_ao.should_flip(),
                );
            }
        }
    }
}

// ============================================================================
// SOUTH FACE (+Z)
// ============================================================================

fn mesh_face_south(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    mask: &mut [u16],
    visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lz in 0..S {
        mask.fill(0);
        let mut has_faces = false;

        for ly in 0..S {
            for lx in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_full_cube(value, lookups) {
                    continue;
                }

                let n_value = if lz < S - 1 {
                    section[idx + S]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + lx]
                } else {
                    0
                };

                if !neighbor_blocks_face(n_value, lookups) {
                    mask[ly * S + lx] = value & BLOCK_ID_MASK;
                    has_faces = true;
                }
            }
        }

        if !has_faces {
            continue;
        }

        visited.fill(false);
        let world_z = base_z + lz as i32;

        for jj in 0..S {
            for ii in 0..S {
                let mi = jj * S + ii;
                if visited[mi] || mask[mi] == 0 {
                    continue;
                }

                let block_id = mask[mi];
                let world_x = base_x + ii as i32;
                let block_y = base_y + jj as i32;

                let start_ao = ao::get_south_face_ao(grid, lookups, world_x, block_y, world_z);
                let face_z = world_z + 1;
                let (start_sky, start_block) = ao::get_face_light(light_grid, world_x, block_y, face_z);

                let mut w = 1usize;
                while ii + w < S && !visited[mi + w] && mask[mi + w] == block_id {
                    let check_ao = ao::get_south_face_ao(grid, lookups, world_x + w as i32, block_y, world_z);
                    if !start_ao.matches(&check_ao) {
                        break;
                    }
                    let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + w as i32, block_y, face_z);
                    if check_sky != start_sky || check_block != start_block {
                        break;
                    }
                    w += 1;
                }

                let mut h = 1usize;
                'outer: while jj + h < S {
                    for k in 0..w {
                        let ci = (jj + h) * S + ii + k;
                        if visited[ci] || mask[ci] != block_id {
                            break 'outer;
                        }
                        let check_ao = ao::get_south_face_ao(grid, lookups, world_x + k as i32, block_y + h as i32, world_z);
                        if !start_ao.matches(&check_ao) {
                            break 'outer;
                        }
                        let (check_sky, check_block) = ao::get_face_light(light_grid, world_x + k as i32, block_y + h as i32, face_z);
                        if check_sky != start_sky || check_block != start_block {
                            break 'outer;
                        }
                    }
                    h += 1;
                }

                for dj in 0..h {
                    for di in 0..w {
                        visited[(jj + dj) * S + ii + di] = true;
                    }
                }

                let x = world_x as f32;
                let y = block_y as f32;
                let z = (world_z + 1) as f32;
                let wf = w as f32;
                let hf = h as f32;

                let positions = [
                    (x, y, z),           // V0
                    (x + wf, y, z),      // V1
                    (x + wf, y + hf, z), // V2
                    (x, y + hf, z),      // V3
                ];

                // Sample smooth light with AO at each vertex corner
                let ao_levels = [start_ao.v0, start_ao.v1, start_ao.v2, start_ao.v3];
                let vertex_coords = [
                    (world_x, block_y),                 // V0
                    (world_x + w as i32, block_y),      // V1
                    (world_x + w as i32, block_y + h as i32), // V2
                    (world_x, block_y + h as i32),      // V3
                ];
                
                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                
                let face_z = world_z + 1;
                for i in 0..4 {
                    let (vx, vy) = vertex_coords[i];
                    let (s, b) = ao::sample_smooth_vertex_light(
                        grid, light_grid, lookups,
                        vx, vy, face_z,
                        ao_levels[i],
                        ao::Plane::XY,
                    );
                    sky[i] = s;
                    block_light[i] = b;
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::South as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::South as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::South.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    start_ao.should_flip(),
                );
            }
        }
    }
}

// ============================================================================
// EAST FACE (+X)
// ============================================================================

fn mesh_face_east(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    mask: &mut [u16],
    visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lx in 0..S {
        mask.fill(0);
        let mut has_faces = false;

        for ly in 0..S {
            for lz in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_full_cube(value, lookups) {
                    continue;
                }

                let n_value = if lx < S - 1 {
                    section[idx + 1]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + lz * S]
                } else {
                    0
                };

                if !neighbor_blocks_face(n_value, lookups) {
                    mask[ly * S + lz] = value & BLOCK_ID_MASK;
                    has_faces = true;
                }
            }
        }

        if !has_faces {
            continue;
        }

        visited.fill(false);
        let world_x = base_x + lx as i32;

        for jj in 0..S {
            for ii in 0..S {
                let mi = jj * S + ii;
                if visited[mi] || mask[mi] == 0 {
                    continue;
                }

                let block_id = mask[mi];
                let world_z = base_z + ii as i32;
                let block_y = base_y + jj as i32;

                let start_ao = ao::get_east_face_ao(grid, lookups, world_x, block_y, world_z);
                let face_x = world_x + 1;
                let (start_sky, start_block) = ao::get_face_light(light_grid, face_x, block_y, world_z);

                let mut w = 1usize;
                while ii + w < S && !visited[mi + w] && mask[mi + w] == block_id {
                    let check_ao = ao::get_east_face_ao(grid, lookups, world_x, block_y, world_z + w as i32);
                    if !start_ao.matches(&check_ao) {
                        break;
                    }
                    let (check_sky, check_block) = ao::get_face_light(light_grid, face_x, block_y, world_z + w as i32);
                    if check_sky != start_sky || check_block != start_block {
                        break;
                    }
                    w += 1;
                }

                let mut h = 1usize;
                'outer: while jj + h < S {
                    for k in 0..w {
                        let ci = (jj + h) * S + ii + k;
                        if visited[ci] || mask[ci] != block_id {
                            break 'outer;
                        }
                        let check_ao = ao::get_east_face_ao(grid, lookups, world_x, block_y + h as i32, world_z + k as i32);
                        if !start_ao.matches(&check_ao) {
                            break 'outer;
                        }
                        let (check_sky, check_block) = ao::get_face_light(light_grid, face_x, block_y + h as i32, world_z + k as i32);
                        if check_sky != start_sky || check_block != start_block {
                            break 'outer;
                        }
                    }
                    h += 1;
                }

                for dj in 0..h {
                    for di in 0..w {
                        visited[(jj + dj) * S + ii + di] = true;
                    }
                }

                let x = (world_x + 1) as f32;
                let y = block_y as f32;
                let z = world_z as f32;
                let wf = w as f32;
                let hf = h as f32;

                let positions = [
                    (x, y, z + wf),      // V0
                    (x, y, z),           // V1
                    (x, y + hf, z),      // V2
                    (x, y + hf, z + wf), // V3
                ];

                // Sample smooth light with AO at each vertex corner
                let ao_levels = [start_ao.v0, start_ao.v1, start_ao.v2, start_ao.v3];
                let vertex_coords = [
                    (block_y, world_z + w as i32),      // V0
                    (block_y, world_z),                 // V1
                    (block_y + h as i32, world_z),      // V2
                    (block_y + h as i32, world_z + w as i32), // V3
                ];
                
                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                
                let face_x = world_x + 1;
                for i in 0..4 {
                    let (vy, vz) = vertex_coords[i];
                    let (s, b) = ao::sample_smooth_vertex_light(
                        grid, light_grid, lookups,
                        face_x, vy, vz,
                        ao_levels[i],
                        ao::Plane::YZ,
                    );
                    sky[i] = s;
                    block_light[i] = b;
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::East as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::East as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::East.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    start_ao.should_flip(),
                );
            }
        }
    }
}

// ============================================================================
// WEST FACE (-X)
// ============================================================================

fn mesh_face_west(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    mask: &mut [u16],
    visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lx in 0..S {
        mask.fill(0);
        let mut has_faces = false;

        for ly in 0..S {
            for lz in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_full_cube(value, lookups) {
                    continue;
                }

                let n_value = if lx > 0 {
                    section[idx - 1]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + lz * S + (S - 1)]
                } else {
                    0
                };

                if !neighbor_blocks_face(n_value, lookups) {
                    mask[ly * S + lz] = value & BLOCK_ID_MASK;
                    has_faces = true;
                }
            }
        }

        if !has_faces {
            continue;
        }

        visited.fill(false);
        let world_x = base_x + lx as i32;

        for jj in 0..S {
            for ii in 0..S {
                let mi = jj * S + ii;
                if visited[mi] || mask[mi] == 0 {
                    continue;
                }

                let block_id = mask[mi];
                let world_z = base_z + ii as i32;
                let block_y = base_y + jj as i32;

                let start_ao = ao::get_west_face_ao(grid, lookups, world_x, block_y, world_z);
                let face_x = world_x - 1;
                let (start_sky, start_block) = ao::get_face_light(light_grid, face_x, block_y, world_z);

                let mut w = 1usize;
                while ii + w < S && !visited[mi + w] && mask[mi + w] == block_id {
                    let check_ao = ao::get_west_face_ao(grid, lookups, world_x, block_y, world_z + w as i32);
                    if !start_ao.matches(&check_ao) {
                        break;
                    }
                    let (check_sky, check_block) = ao::get_face_light(light_grid, face_x, block_y, world_z + w as i32);
                    if check_sky != start_sky || check_block != start_block {
                        break;
                    }
                    w += 1;
                }

                let mut h = 1usize;
                'outer: while jj + h < S {
                    for k in 0..w {
                        let ci = (jj + h) * S + ii + k;
                        if visited[ci] || mask[ci] != block_id {
                            break 'outer;
                        }
                        let check_ao = ao::get_west_face_ao(grid, lookups, world_x, block_y + h as i32, world_z + k as i32);
                        if !start_ao.matches(&check_ao) {
                            break 'outer;
                        }
                        let (check_sky, check_block) = ao::get_face_light(light_grid, face_x, block_y + h as i32, world_z + k as i32);
                        if check_sky != start_sky || check_block != start_block {
                            break 'outer;
                        }
                    }
                    h += 1;
                }

                for dj in 0..h {
                    for di in 0..w {
                        visited[(jj + dj) * S + ii + di] = true;
                    }
                }

                let x = world_x as f32;
                let y = block_y as f32;
                let z = world_z as f32;
                let wf = w as f32;
                let hf = h as f32;

                let positions = [
                    (x, y, z),           // V0
                    (x, y, z + wf),      // V1
                    (x, y + hf, z + wf), // V2
                    (x, y + hf, z),      // V3
                ];

                // Sample smooth light with AO at each vertex corner
                let ao_levels = [start_ao.v0, start_ao.v1, start_ao.v2, start_ao.v3];
                let vertex_coords = [
                    (block_y, world_z),                 // V0
                    (block_y, world_z + w as i32),      // V1
                    (block_y + h as i32, world_z + w as i32), // V2
                    (block_y + h as i32, world_z),      // V3
                ];
                
                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                
                let face_x = world_x - 1;
                for i in 0..4 {
                    let (vy, vz) = vertex_coords[i];
                    let (s, b) = ao::sample_smooth_vertex_light(
                        grid, light_grid, lookups,
                        face_x, vy, vz,
                        ao_levels[i],
                        ao::Plane::YZ,
                    );
                    sky[i] = s;
                    block_light[i] = b;
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::West as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::West as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::West.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    start_ao.should_flip(),
                );
            }
        }
    }
}

// ============================================================================
// GLASS MESH FUNCTIONS (simplified - no greedy merging for transparency)
// ============================================================================

fn mesh_glass_face_top(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    _grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    _mask: &mut [u16],
    _visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for ly in 0..S {
        let slice_base = ly * S2;
        for lz in 0..S {
            for lx in 0..S {
                let j = lz * S + lx;
                let value = section[slice_base + j];
                if !is_glass_block(value, lookups) {
                    continue;
                }

                let n_value = if ly < S - 1 {
                    section[slice_base + S2 + j]
                } else if let Some(n) = neighbor {
                    n[j]
                } else {
                    0
                };

                // Only render if neighbor is not same glass type
                let block_id = value & BLOCK_ID_MASK;
                let n_block_id = n_value & BLOCK_ID_MASK;
                if n_block_id == block_id {
                    continue;
                }

                let world_x = base_x + lx as i32;
                let block_y = base_y + ly as i32;
                let world_z = base_z + lz as i32;

                let x = world_x as f32;
                let y = (block_y + 1) as f32;
                let z = world_z as f32;

                let positions = [
                    (x, y, z + 1.0),
                    (x + 1.0, y, z + 1.0),
                    (x + 1.0, y, z),
                    (x, y, z),
                ];

                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                if let Some(lg) = light_grid {
                    let light = lg.get_light(world_x, block_y + 1, world_z);
                    sky.fill(light.sky_light as f32);
                    block_light.fill(light.block_light as f32);
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::Up as u8);

                let tint_type = lookups.face_tint_type(block_id, Face::Up as u8) as f32;
                mesh.add_quad(
                    positions,
                    Face::Up.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    false,
                );
            }
        }
    }
}

// Glass face implementations (no greedy merging for proper transparency)
fn mesh_glass_face_bottom(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    _grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    _mask: &mut [u16],
    _visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for ly in 0..S {
        let slice_base = ly * S2;
        for lz in 0..S {
            for lx in 0..S {
                let j = lz * S + lx;
                let value = section[slice_base + j];
                if !is_glass_block(value, lookups) {
                    continue;
                }

                let n_value = if ly > 0 {
                    section[slice_base - S2 + j]
                } else if let Some(n) = neighbor {
                    n[(S - 1) * S2 + j]
                } else {
                    0
                };

                let block_id = value & BLOCK_ID_MASK;
                let n_block_id = n_value & BLOCK_ID_MASK;
                if n_block_id == block_id {
                    continue;
                }

                let world_x = base_x + lx as i32;
                let block_y = base_y + ly as i32;
                let world_z = base_z + lz as i32;

                let x = world_x as f32;
                let y = block_y as f32;
                let z = world_z as f32;

                let positions = [
                    (x, y, z),
                    (x + 1.0, y, z),
                    (x + 1.0, y, z + 1.0),
                    (x, y, z + 1.0),
                ];

                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                if let Some(lg) = light_grid {
                    let light = lg.get_light(world_x, block_y - 1, world_z);
                    sky.fill(light.sky_light as f32);
                    block_light.fill(light.block_light as f32);
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::Down as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::Down as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::Down.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    false,
                );
            }
        }
    }
}

fn mesh_glass_face_north(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    _grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    _mask: &mut [u16],
    _visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lz in 0..S {
        for ly in 0..S {
            for lx in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_glass_block(value, lookups) {
                    continue;
                }

                let n_value = if lz > 0 {
                    section[idx - S]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + (S - 1) * S + lx]
                } else {
                    0
                };

                let block_id = value & BLOCK_ID_MASK;
                let n_block_id = n_value & BLOCK_ID_MASK;
                if n_block_id == block_id {
                    continue;
                }

                let world_x = base_x + lx as i32;
                let block_y = base_y + ly as i32;
                let world_z = base_z + lz as i32;

                let x = world_x as f32;
                let y = block_y as f32;
                let z = world_z as f32;

                let positions = [
                    (x + 1.0, y, z),
                    (x, y, z),
                    (x, y + 1.0, z),
                    (x + 1.0, y + 1.0, z),
                ];

                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                if let Some(lg) = light_grid {
                    let light = lg.get_light(world_x, block_y, world_z - 1);
                    sky.fill(light.sky_light as f32);
                    block_light.fill(light.block_light as f32);
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::North as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::North as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::North.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    false,
                );
            }
        }
    }
}

fn mesh_glass_face_south(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    _grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    _mask: &mut [u16],
    _visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lz in 0..S {
        for ly in 0..S {
            for lx in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_glass_block(value, lookups) {
                    continue;
                }

                let n_value = if lz < S - 1 {
                    section[idx + S]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + lx]
                } else {
                    0
                };

                let block_id = value & BLOCK_ID_MASK;
                let n_block_id = n_value & BLOCK_ID_MASK;
                if n_block_id == block_id {
                    continue;
                }

                let world_x = base_x + lx as i32;
                let block_y = base_y + ly as i32;
                let world_z = base_z + lz as i32;

                let x = world_x as f32;
                let y = block_y as f32;
                let z = (world_z + 1) as f32;

                let positions = [
                    (x, y, z),
                    (x + 1.0, y, z),
                    (x + 1.0, y + 1.0, z),
                    (x, y + 1.0, z),
                ];

                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                if let Some(lg) = light_grid {
                    let light = lg.get_light(world_x, block_y, world_z + 1);
                    sky.fill(light.sky_light as f32);
                    block_light.fill(light.block_light as f32);
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::South as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::South as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::South.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    false,
                );
            }
        }
    }
}

fn mesh_glass_face_east(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    _grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    _mask: &mut [u16],
    _visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lx in 0..S {
        for ly in 0..S {
            for lz in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_glass_block(value, lookups) {
                    continue;
                }

                let n_value = if lx < S - 1 {
                    section[idx + 1]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + lz * S]
                } else {
                    0
                };

                let block_id = value & BLOCK_ID_MASK;
                let n_block_id = n_value & BLOCK_ID_MASK;
                if n_block_id == block_id {
                    continue;
                }

                let world_x = base_x + lx as i32;
                let block_y = base_y + ly as i32;
                let world_z = base_z + lz as i32;

                let x = (world_x + 1) as f32;
                let y = block_y as f32;
                let z = world_z as f32;

                let positions = [
                    (x, y, z + 1.0),
                    (x, y, z),
                    (x, y + 1.0, z),
                    (x, y + 1.0, z + 1.0),
                ];

                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                if let Some(lg) = light_grid {
                    let light = lg.get_light(world_x + 1, block_y, world_z);
                    sky.fill(light.sky_light as f32);
                    block_light.fill(light.block_light as f32);
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::East as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::East as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::East.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    false,
                );
            }
        }
    }
}

fn mesh_glass_face_west(
    section: &[u16; S3],
    neighbor: Option<&[u16; S3]>,
    base_x: i32,
    base_y: i32,
    base_z: i32,
    _grid: &BinaryGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    _mask: &mut [u16],
    _visited: &mut [bool],
    mesh: &mut MeshData,
) {
    for lx in 0..S {
        for ly in 0..S {
            for lz in 0..S {
                let idx = ly * S2 + lz * S + lx;
                let value = section[idx];
                if !is_glass_block(value, lookups) {
                    continue;
                }

                let n_value = if lx > 0 {
                    section[idx - 1]
                } else if let Some(n) = neighbor {
                    n[ly * S2 + lz * S + (S - 1)]
                } else {
                    0
                };

                let block_id = value & BLOCK_ID_MASK;
                let n_block_id = n_value & BLOCK_ID_MASK;
                if n_block_id == block_id {
                    continue;
                }

                let world_x = base_x + lx as i32;
                let block_y = base_y + ly as i32;
                let world_z = base_z + lz as i32;

                let x = world_x as f32;
                let y = block_y as f32;
                let z = world_z as f32;

                let positions = [
                    (x, y, z),
                    (x, y, z + 1.0),
                    (x, y + 1.0, z + 1.0),
                    (x, y + 1.0, z),
                ];

                let mut sky = [15.0f32; 4];
                let mut block_light = [0.0f32; 4];
                if let Some(lg) = light_grid {
                    let light = lg.get_light(world_x - 1, block_y, world_z);
                    sky.fill(light.sky_light as f32);
                    block_light.fill(light.block_light as f32);
                }

                let color = lookups.color(block_id);
                let tex_idx = lookups.texture_index(block_id, Face::West as u8);
                let tint_type = lookups.face_tint_type(block_id, Face::West as u8) as f32;

                mesh.add_quad(
                    positions,
                    Face::West.normal(),
                    color,
                    tex_idx,
                    0.0,
                    tint_type,
                    sky,
                    block_light,
                    false,
                );
            }
        }
    }
}

