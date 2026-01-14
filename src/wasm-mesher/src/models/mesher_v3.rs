//! V3 Model Mesher - Uses block-name-based registry
//!
//! This mesher uses the BlockModelRegistry and ModelStateGrid to render
//! model blocks without requiring state ID matching between workers and main thread.

use crate::grid::{BinaryGrid, LightGrid, ModelStateGrid, ModelState};
use crate::lookup::Lookups;
use crate::mesher::MeshBounds;
use crate::types::{SECTION_SIZE, block_index_in_section};
use super::block_registry::{
    get_block_model_registry, BakedFace, FaceDirection,
};
use super::geometry::ModelMeshData;
use super::mesher::{ModelMeshResult, BlockPosition};
use super::position_hash::{get_position_rotation, get_position_offset};

/// Per-vertex lighting data
#[derive(Clone, Copy, Default)]
struct VertexLight {
    sky: u8,
    block: u8,
    ao: f32,
}

/// Mesh all model blocks using V3 registry (block-name based)
/// 
/// This is the preferred meshing function for worker-based rendering.
pub fn mesh_models_v3(
    grid: &BinaryGrid,
    model_state_grid: &ModelStateGrid,
    light_grid: Option<&LightGrid>,
    lookups: &Lookups,
    bounds: Option<&MeshBounds>,
) -> ModelMeshResult {
    let registry = match get_block_model_registry() {
        Some(r) => r,
        None => {
            web_sys::console::warn_1(&"[WASM] Block model registry not initialized".into());
            return ModelMeshResult::default();
        }
    };
    
    let mut result = ModelMeshResult::new();
    let mut blocks_found = 0u32;
    let mut blocks_meshed = 0u32;
    let mut _faces_emitted = 0u32;
    
    // Debug logging for V3 debugging
    web_sys::console::log_1(&format!("[WASM mesh_models_v3] Registry has {} blocks, grid has {} sections", registry.len(), model_state_grid.section_count()).into());
    
    // Iterate over sections with model states
    let mut section_count = 0u32;
    for (key, section) in model_state_grid.iter_sections_with_states() {
        section_count += 1;
        if section_count <= 2 {
            let non_empty = section.iter().filter(|s| !s.is_empty()).count();
            web_sys::console::log_1(&format!("[WASM V3] Section ({}, {}, {}): {} non-empty states", 
                key.chunk_x, key.chunk_z, key.section_y, non_empty).into());
        }
        
        // Check bounds
        if let Some(b) = bounds {
            if key.chunk_x < b.min_chunk_x || key.chunk_x > b.max_chunk_x ||
               key.chunk_z < b.min_chunk_z || key.chunk_z > b.max_chunk_z {
                if section_count <= 2 {
                    web_sys::console::log_1(&format!("[WASM V3] Section ({}, {}) SKIPPED - out of bounds [{},{}] to [{},{}]", 
                        key.chunk_x, key.chunk_z,
                        b.min_chunk_x, b.min_chunk_z, b.max_chunk_x, b.max_chunk_z).into());
                }
                continue;
            }
        }
        
        let base_x = key.chunk_x * SECTION_SIZE as i32;
        let base_y = key.section_y * SECTION_SIZE as i32 - 64;
        let base_z = key.chunk_z * SECTION_SIZE as i32;
        
        // Process each block in the section
        for local_y in 0..SECTION_SIZE {
            for local_z in 0..SECTION_SIZE {
                for local_x in 0..SECTION_SIZE {
                    let idx = block_index_in_section(local_x, local_y, local_z);
                    let state = section[idx];
                    
                    if state.is_empty() {
                        continue;
                    }
                    
                    blocks_found += 1;
                    
                    let block_idx = state.block_index();
                    let variant_idx = state.variant_index();
                    let rotation_packed = state.rotation();
                    // Unpack rotation: [axis (2 bits) | y_rotation (2 bits)]
                    let y_rotation = rotation_packed & 0x3;
                    let axis = (rotation_packed >> 2) & 0x3;
                    let is_flipped = state.is_flipped();
                    
                    // Get block data from registry
                    let block = match registry.get_by_index(block_idx) {
                        Some(b) => b,
                        None => {
                            if blocks_found <= 3 {
                                web_sys::console::warn_1(&format!("[WASM] No block at index {}", block_idx).into());
                            }
                            continue;
                        }
                    };
                    
                    // Get variant
                    let variant = match block.get_variant_by_index(variant_idx) {
                        Some(v) => v,
                        None => {
                            if blocks_found <= 3 {
                                web_sys::console::warn_1(&format!("[WASM] No variant {} for block {}", variant_idx, block.name).into());
                            }
                            continue;
                        }
                    };
                    
                    blocks_meshed += 1;
                    
                    let world_x = base_x + local_x as i32;
                    let world_y = base_y + local_y as i32;
                    let world_z = base_z + local_z as i32;
                    
                    // Check for beacon
                    if block.name == "beacon" {
                        result.beacon_positions.push(BlockPosition {
                            x: world_x,
                            y: world_y,
                            z: world_z,
                        });
                    }
                    
                    // Get additional rotation for random-rotation blocks
                    let total_y_rotation = if block.has_random_rotation() {
                        let pos_rot = get_position_rotation(world_x, world_y, world_z);
                        (y_rotation + pos_rot) % 4
                    } else {
                        y_rotation
                    };
                    
                    // Get position offset for offset blocks
                    let (offset_x, offset_z) = if block.has_position_offset() {
                        get_position_offset(world_x, world_y, world_z)
                    } else {
                        (0.0, 0.0)
                    };
                    
                    // Get light at this position
                    let (sky_light, block_light) = if let Some(lg) = light_grid {
                        let light = lg.get_light(world_x, world_y, world_z);
                        (light.sky_light, light.block_light)
                    } else {
                        (15, 0)
                    };
                    
                    // Select target mesh
                    let target = if block.is_transparent() {
                        &mut result.transparent
                    } else {
                        &mut result.opaque
                    };
                    
                    // Process each face
                    for face in &variant.faces {
                        // Check if face should be culled
                        if should_cull_face_v3(grid, lookups, world_x, world_y, world_z, face, total_y_rotation, axis, is_flipped) {
                            continue;
                        }
                        
                        // Calculate per-vertex AO for this face
                        // Only full cubes cause AO - partial blocks (stairs, slabs) are AO-transparent
                        let vertex_ao = calculate_face_ao_v3(
                            grid, lookups, light_grid,
                            world_x, world_y, world_z,
                            face, total_y_rotation, axis, is_flipped,
                        );
                        
                        // Emit face with rotation/flip applied
                        // shade_flag = 1.0 for shaded blocks, 0.0 for no-shade blocks (cross models)
                        let shade_flag = if block.has_no_shade() { 0.0 } else { 1.0 };
                        emit_face_v3_with_ao(
                            target,
                            face,
                            world_x as f32 + offset_x,
                            world_y as f32,
                            world_z as f32 + offset_z,
                            total_y_rotation,
                            axis,
                            is_flipped,
                            &vertex_ao,
                            shade_flag,
                        );
                    }
                    
                    // Check for particle emitters
                    // TODO: Add particle emitter detection based on block name
                }
            }
        }
    }
    
    // Debug logging disabled for performance
    // web_sys::console::log_1(&format!(
    //     "[WASM mesh_models_v3] Found {} blocks, meshed {}, opaque verts={}, trans verts={}",
    //     blocks_found, blocks_meshed,
    //     result.opaque.positions.len() / 3,
    //     result.transparent.positions.len() / 3
    // ).into());
    let _ = (blocks_found, blocks_meshed, _faces_emitted); // Suppress unused warnings
    
    result
}

/// Check if a face should be culled based on neighbor blocks
fn should_cull_face_v3(
    grid: &BinaryGrid,
    lookups: &Lookups,
    world_x: i32,
    world_y: i32,
    world_z: i32,
    face: &BakedFace,
    y_rotation: u8,
    axis: u8,
    is_flipped: bool,
) -> bool {
    // If no cullface, never cull
    let cullface = match face.cullface {
        Some(cf) => cf,
        None => return false,
    };
    
    // Transform cullface by axis, rotation and flip
    let transformed = transform_direction(cullface, y_rotation, axis, is_flipped);
    
    // Get neighbor position
    let (nx, ny, nz) = direction_offset(transformed);
    let neighbor_x = world_x + nx;
    let neighbor_y = world_y + ny;
    let neighbor_z = world_z + nz;
    
    // Check if neighbor is solid opaque cube
    let neighbor_id = grid.get_block(neighbor_x, neighbor_y, neighbor_z);
    if neighbor_id == 0 {
        return false;
    }
    
    // Check if neighbor is a full opaque cube (opaque and not a non-cube)
    let block_id = neighbor_id & 0xFFF;
    lookups.is_opaque(block_id) && !lookups.is_non_cube(block_id)
}

/// Transform a direction by axis rotation, Y rotation, and vertical flip
fn transform_direction(dir: FaceDirection, y_rotation: u8, axis: u8, is_flipped: bool) -> FaceDirection {
    use FaceDirection::*;
    
    // First apply axis rotation
    let after_axis = match axis {
        1 => {
            // X-axis: 90° around Z axis
            match dir {
                Up => North,
                Down => South,
                North => Down,
                South => Up,
                other => other, // East/West unchanged
            }
        }
        2 => {
            // Z-axis: 90° around X axis
            match dir {
                Up => West,
                Down => East,
                West => Down,
                East => Up,
                other => other, // North/South unchanged
            }
        }
        _ => dir, // Y-axis (default): no change
    };
    
    // Then apply vertical flip
    let after_flip = if is_flipped {
        match after_axis {
            Up => Down,
            Down => Up,
            other => other,
        }
    } else {
        after_axis
    };
    
    // Finally apply Y-axis rotation (CCW to match rotate_vertex)
    if y_rotation == 0 {
        return after_flip;
    }
    
    match after_flip {
        North => {
            match y_rotation {
                1 => West,  // CCW: North -> West
                2 => South,
                3 => East,  // CCW: North -> East
                _ => North,
            }
        }
        East => {
            match y_rotation {
                1 => North, // CCW: East -> North
                2 => West,
                3 => South, // CCW: East -> South
                _ => East,
            }
        }
        South => {
            match y_rotation {
                1 => East,  // CCW: South -> East
                2 => North,
                3 => West,  // CCW: South -> West
                _ => South,
            }
        }
        West => {
            match y_rotation {
                1 => South, // CCW: West -> South
                2 => East,
                3 => North, // CCW: West -> North
                _ => West,
            }
        }
        other => other, // Up/Down/None unaffected by Y rotation
    }
}

/// Get offset for a direction
fn direction_offset(dir: FaceDirection) -> (i32, i32, i32) {
    use FaceDirection::*;
    match dir {
        Down => (0, -1, 0),
        Up => (0, 1, 0),
        North => (0, 0, -1),
        South => (0, 0, 1),
        West => (-1, 0, 0),
        East => (1, 0, 0),
        None => (0, 0, 0),
    }
}

/// Emit a face to the mesh data with rotation/flip applied (legacy, without per-vertex AO)
#[allow(dead_code)]
fn emit_face_v3(
    mesh: &mut ModelMeshData,
    face: &BakedFace,
    world_x: f32,
    world_y: f32,
    world_z: f32,
    y_rotation: u8,
    axis: u8,
    is_flipped: bool,
    sky_light: u8,
    block_light: u8,
) {
    let base_idx = mesh.positions.len() as u32 / 3;
    
    // Transform and emit vertices
    for i in 0..4 {
        let v = face.vertices[i];
        
        // Apply axis and Y rotation around center (0.5, 0.5, 0.5)
        let (vx, mut vy, vz) = rotate_vertex(v, y_rotation, axis);
        
        // Apply vertical flip around center
        if is_flipped {
            vy = 1.0 - vy;
        }
        
        // Translate to world position
        mesh.positions.push(world_x + vx);
        mesh.positions.push(world_y + vy);
        mesh.positions.push(world_z + vz);
        
        // Transform and emit normal
        let n = face.normal;
        let (nx, ny, nz) = rotate_normal(n, y_rotation, axis);
        let (nx, ny, nz) = if is_flipped { (nx, -ny, nz) } else { (nx, ny, nz) };
        
        mesh.normals.push(nx);
        mesh.normals.push(ny);
        mesh.normals.push(nz);
        
        // Emit UV
        mesh.uvs.push(face.uvs[i][0]);
        mesh.uvs.push(face.uvs[i][1]);
        
        // Emit color (white, will be tinted by shader)
        mesh.colors.push(1.0);
        mesh.colors.push(1.0);
        mesh.colors.push(1.0);
        mesh.colors.push(1.0);
        
        // Emit texture index
        mesh.tex_indices.push(face.texture_index as f32);
        
        // Emit tint type
        mesh.tint_types.push(face.tint_type as f32);
        
        // Emit light
        mesh.sky_light.push(sky_light as f32);
        mesh.block_light.push(block_light as f32);
    }
    
    // Emit indices (two triangles per face)
    // CCW winding: 0-1-2, 0-2-3
    mesh.indices.push(base_idx);
    mesh.indices.push(base_idx + 1);
    mesh.indices.push(base_idx + 2);
    mesh.indices.push(base_idx);
    mesh.indices.push(base_idx + 2);
    mesh.indices.push(base_idx + 3);
}

/// Rotate a vertex with axis and Y rotation
/// First applies axis rotation, then Y rotation
/// Center at (0.5, 0.5, 0.5)
fn rotate_vertex(v: [f32; 3], y_rotation: u8, axis: u8) -> (f32, f32, f32) {
    // Center the vertex
    let (mut x, mut y, mut z) = (v[0] - 0.5, v[1] - 0.5, v[2] - 0.5);
    
    // Apply axis rotation first
    match axis {
        1 => {
            // X-axis orientation: rotate 90° around Z axis
            // (x, y, z) -> (y, -x, z)
            let new_x = y;
            let new_y = -x;
            x = new_x;
            y = new_y;
        }
        2 => {
            // Z-axis orientation: rotate 90° around X axis
            // (x, y, z) -> (x, -z, y)
            let new_y = -z;
            let new_z = y;
            y = new_y;
            z = new_z;
        }
        _ => {} // Y-axis (0) or default: no axis rotation
    }
    
    // Apply Y-axis rotation (CCW when looking down at +Y)
    // Combined with FACING_TO_ROTATION compensation to get correct orientation
    let (rx, rz) = match y_rotation {
        0 => (x, z),
        1 => (-z, x),  // 90° CCW
        2 => (-x, -z), // 180°
        3 => (z, -x),  // 270° CCW (90° CW)
        _ => (x, z),
    };
    
    (rx + 0.5, y + 0.5, rz + 0.5)
}

/// Rotate a normal vector with axis and Y rotation
fn rotate_normal(n: [f32; 3], y_rotation: u8, axis: u8) -> (f32, f32, f32) {
    let (mut x, mut y, mut z) = (n[0], n[1], n[2]);
    
    // Apply axis rotation first
    match axis {
        1 => {
            // X-axis orientation: rotate 90° around Z axis
            let new_x = y;
            let new_y = -x;
            x = new_x;
            y = new_y;
        }
        2 => {
            // Z-axis orientation: rotate 90° around X axis
            let new_y = -z;
            let new_z = y;
            y = new_y;
            z = new_z;
        }
        _ => {}
    }
    
    // Apply Y-axis rotation (CCW when looking down at +Y)
    match y_rotation {
        0 => (x, y, z),
        1 => (-z, y, x),  // 90° CCW
        2 => (-x, y, -z), // 180°
        3 => (z, y, -x),  // 270° CCW (90° CW)
        _ => (x, y, z),
    }
}

/// Check if block is solid for AO calculation
/// Only full cubes should cause AO occlusion - not partial blocks like stairs
#[inline]
fn is_solid_for_ao(grid: &BinaryGrid, lookups: &Lookups, x: i32, y: i32, z: i32) -> bool {
    let block_id = grid.get_block_id(x, y, z);
    
    // Air is never solid
    if block_id == 0 {
        return false;
    }
    
    // AO-transparent blocks (glass, leaves, non-cubes) don't cause AO
    if lookups.is_ao_transparent(block_id) {
        return false;
    }
    
    // Non-cube blocks (stairs, slabs, walls) don't cause AO
    // This is a belt-and-suspenders check in case is_ao_transparent wasn't set
    if lookups.is_non_cube(block_id) {
        return false;
    }
    
    // Only opaque full cubes cause AO
    lookups.is_opaque(block_id)
}

/// Calculate single vertex AO from 3 neighbors
#[inline]
fn vertex_ao_value(side1: bool, side2: bool, corner: bool) -> u8 {
    if side1 && side2 {
        0 // Both sides solid = maximum occlusion
    } else {
        3 - (side1 as u8 + side2 as u8 + corner as u8)
    }
}

/// AO brightness levels for model blocks
/// Matching the greedy mesher's AO values from ao.rs for consistency
const AO_BRIGHTNESS: [f32; 4] = [0.5, 0.7, 0.85, 1.0];

/// Calculate per-vertex lighting for a model face with smooth interpolation
/// 
/// For model blocks, we calculate AO directly at each vertex's world position.
/// This avoids complex index mapping and works correctly regardless of rotation.
///
/// For each vertex:
/// 1. Calculate its world position (block pos + rotated vertex offset)
/// 2. Determine which 3 neighbors affect this vertex based on face direction
/// 3. Calculate AO from those neighbors
/// 4. Sample smooth light for the vertex
fn calculate_face_ao_v3(
    grid: &BinaryGrid,
    lookups: &Lookups,
    light_grid: Option<&LightGrid>,
    world_x: i32,
    world_y: i32,
    world_z: i32,
    face: &BakedFace,
    y_rotation: u8,
    axis: u8,
    is_flipped: bool,
) -> [VertexLight; 4] {
    // Get the transformed normal direction for determining sample plane
    let face_dir = transform_direction(face.direction, y_rotation, axis, is_flipped);
    
    let mut result = [VertexLight { sky: 15, block: 0, ao: 1.0 }; 4];
    
    for (i, vertex) in face.vertices.iter().enumerate() {
        // Transform vertex position by rotation
        let (rot_x, rot_y, rot_z) = apply_rotation_to_point(
            vertex[0], vertex[1], vertex[2],
            y_rotation, axis, is_flipped
        );
        
        // Calculate AO directly at this vertex's position
        let ao_level = calculate_vertex_ao_direct(
            grid, lookups,
            world_x, world_y, world_z,
            rot_x, rot_y, rot_z,
            face_dir,
        );
        
        // Sample light using proper smooth light sampling
        // This samples from 4 blocks around the vertex, only from non-solid blocks
        let (sky, block) = sample_smooth_light_for_vertex(
            grid, lookups, light_grid,
            world_x, world_y, world_z,
            rot_x, rot_y, rot_z,
            face_dir,
        );
        
        result[i] = VertexLight { sky, block, ao: AO_BRIGHTNESS[ao_level as usize] };
    }
    
    result
}

/// Sample smooth light for a model block vertex
/// 
/// This implements Minecraft's smooth lighting algorithm:
/// 1. Calculate the vertex's world position
/// 2. Sample light from 4 blocks around the vertex in the face's plane
/// 3. Only include light from NON-SOLID blocks (air, transparent)
/// 4. Average the valid samples
/// 
/// This fixes the black face bug where sampling from solid blocks returns (0, 0).
fn sample_smooth_light_for_vertex(
    grid: &BinaryGrid,
    lookups: &Lookups,
    light_grid: Option<&LightGrid>,
    world_x: i32,
    world_y: i32,
    world_z: i32,
    vx: f32, vy: f32, vz: f32,  // Vertex position within block (0-1 range)
    face_dir: FaceDirection,
) -> (u8, u8) {
    let lg = match light_grid {
        Some(lg) => lg,
        None => return (15, 0),
    };
    
    // Calculate world position of the vertex
    let vertex_world_x = world_x as f32 + vx;
    let vertex_world_y = world_y as f32 + vy;
    let vertex_world_z = world_z as f32 + vz;
    
    // Offset slightly in the face normal direction to sample from "air space" in front of face
    let (sample_x, sample_y, sample_z) = match face_dir {
        FaceDirection::Up => (vertex_world_x, vertex_world_y + 0.1, vertex_world_z),
        FaceDirection::Down => (vertex_world_x, vertex_world_y - 0.1, vertex_world_z),
        FaceDirection::North => (vertex_world_x, vertex_world_y, vertex_world_z - 0.1),
        FaceDirection::South => (vertex_world_x, vertex_world_y, vertex_world_z + 0.1),
        FaceDirection::East => (vertex_world_x + 0.1, vertex_world_y, vertex_world_z),
        FaceDirection::West => (vertex_world_x - 0.1, vertex_world_y, vertex_world_z),
        FaceDirection::None => (vertex_world_x, vertex_world_y, vertex_world_z),
    };
    
    // Sample 4 blocks around this position in the plane perpendicular to the face normal
    // This is Minecraft's smooth lighting algorithm
    let mut total_sky = 0.0f32;
    let mut total_block = 0.0f32;
    let mut count = 0;
    
    // Get the 4 sample positions based on face direction
    let offsets: [(i32, i32, i32); 4] = match face_dir {
        FaceDirection::Up | FaceDirection::Down => {
            // Sample in XZ plane
            [(-1, 0, -1), (0, 0, -1), (-1, 0, 0), (0, 0, 0)]
        }
        FaceDirection::East | FaceDirection::West => {
            // Sample in YZ plane
            [(0, -1, -1), (0, 0, -1), (0, -1, 0), (0, 0, 0)]
        }
        FaceDirection::North | FaceDirection::South => {
            // Sample in XY plane
            [(-1, -1, 0), (0, -1, 0), (-1, 0, 0), (0, 0, 0)]
        }
        FaceDirection::None => {
            // Fallback: just use center
            [(0, 0, 0), (0, 0, 0), (0, 0, 0), (0, 0, 0)]
        }
    };
    
    let base_x = sample_x.floor() as i32;
    let base_y = sample_y.floor() as i32;
    let base_z = sample_z.floor() as i32;
    
    for (dx, dy, dz) in offsets {
        let sx = base_x + dx;
        let sy = base_y + dy;
        let sz = base_z + dz;
        
        // Check if this block is solid - if so, don't sample light from it
        let block_id = grid.get_block_id(sx, sy, sz);
        let is_solid = block_id != 0 && 
                       !lookups.is_ao_transparent(block_id) && 
                       lookups.is_opaque(block_id);
        
        if !is_solid {
            let light = lg.get_light(sx, sy, sz);
            total_sky += light.sky_light as f32;
            total_block += light.block_light as f32;
            count += 1;
        }
    }
    
    if count > 0 {
        ((total_sky / count as f32).round() as u8, (total_block / count as f32).round() as u8)
    } else {
        // All neighbors solid - sample from the current block (the model block itself)
        // Model blocks are typically non-solid, so they should have reasonable light values
        let light = lg.get_light(world_x, world_y, world_z);
        (light.sky_light, light.block_light)
    }
}

/// Calculate AO directly at a vertex position
/// 
/// Based on the face direction and vertex position within the block (0-1 range),
/// determine which 3 neighbors affect this vertex and calculate AO.
fn calculate_vertex_ao_direct(
    grid: &BinaryGrid,
    lookups: &Lookups,
    block_x: i32,
    block_y: i32,
    block_z: i32,
    vx: f32, vy: f32, vz: f32,
    face_dir: FaceDirection,
) -> u8 {
    // Determine which corner of the block this vertex is at
    // Vertices at 0-side go to the negative neighbor, vertices at 1-side go to positive
    let is_east = vx > 0.5;   // +X side
    let is_up = vy > 0.5;     // +Y side  
    let is_south = vz > 0.5;  // +Z side
    
    // Get the position in the air space where we sample AO
    // This is one block out from the face in the face normal direction
    let (sample_x, sample_y, sample_z) = match face_dir {
        FaceDirection::Up => (block_x, block_y + 1, block_z),
        FaceDirection::Down => (block_x, block_y - 1, block_z),
        FaceDirection::North => (block_x, block_y, block_z - 1),
        FaceDirection::South => (block_x, block_y, block_z + 1),
        FaceDirection::East => (block_x + 1, block_y, block_z),
        FaceDirection::West => (block_x - 1, block_y, block_z),
        FaceDirection::None => return 3, // No AO for directionless faces
    };
    
    // Based on face direction and vertex position, check the appropriate neighbors
    let (side1, side2, corner) = match face_dir {
        FaceDirection::Up | FaceDirection::Down => {
            // Horizontal face - check X and Z neighbors
            let x_offset = if is_east { 1 } else { -1 };
            let z_offset = if is_south { 1 } else { -1 };
            
            let s1 = is_solid_for_ao(grid, lookups, sample_x + x_offset, sample_y, sample_z);
            let s2 = is_solid_for_ao(grid, lookups, sample_x, sample_y, sample_z + z_offset);
            let c = is_solid_for_ao(grid, lookups, sample_x + x_offset, sample_y, sample_z + z_offset);
            (s1, s2, c)
        }
        FaceDirection::North | FaceDirection::South => {
            // Z-facing face - check X and Y neighbors
            let x_offset = if is_east { 1 } else { -1 };
            let y_offset = if is_up { 1 } else { -1 };
            
            let s1 = is_solid_for_ao(grid, lookups, sample_x + x_offset, sample_y, sample_z);
            let s2 = is_solid_for_ao(grid, lookups, sample_x, sample_y + y_offset, sample_z);
            let c = is_solid_for_ao(grid, lookups, sample_x + x_offset, sample_y + y_offset, sample_z);
            (s1, s2, c)
        }
        FaceDirection::East | FaceDirection::West => {
            // X-facing face - check Y and Z neighbors
            let y_offset = if is_up { 1 } else { -1 };
            let z_offset = if is_south { 1 } else { -1 };
            
            let s1 = is_solid_for_ao(grid, lookups, sample_x, sample_y + y_offset, sample_z);
            let s2 = is_solid_for_ao(grid, lookups, sample_x, sample_y, sample_z + z_offset);
            let c = is_solid_for_ao(grid, lookups, sample_x, sample_y + y_offset, sample_z + z_offset);
            (s1, s2, c)
        }
        FaceDirection::None => return 3,
    };
    
    vertex_ao_value(side1, side2, corner)
}
/// Sample smooth light at a vertex position using bilinear interpolation
/// in the plane perpendicular to the face normal.
///
/// This properly handles partial blocks (slabs, etc.) by sampling based on
/// the actual vertex position, not fixed block-boundary offsets.
fn sample_smooth_light_at_vertex(
    light_grid: &LightGrid,
    vx: f32, vy: f32, vz: f32,
    face_dir: FaceDirection,
) -> (u8, u8) {
    // Offset into the air space in front of the face
    let (sample_x, sample_y, sample_z) = match face_dir {
        FaceDirection::Up => (vx, vy + 0.5, vz),
        FaceDirection::Down => (vx, vy - 0.5, vz),
        FaceDirection::East => (vx + 0.5, vy, vz),
        FaceDirection::West => (vx - 0.5, vy, vz),
        FaceDirection::North => (vx, vy, vz - 0.5),
        FaceDirection::South => (vx, vy, vz + 0.5),
        FaceDirection::None => {
            let light = light_grid.get_light(vx.floor() as i32, vy.floor() as i32, vz.floor() as i32);
            return (light.sky_light, light.block_light);
        }
    };

    // Bilinear interpolation in the plane perpendicular to the face normal
    match face_dir {
        FaceDirection::Up | FaceDirection::Down => {
            // Sample in XZ plane at fixed Y
            let y = sample_y.floor() as i32;
            let x0 = sample_x.floor() as i32;
            let z0 = sample_z.floor() as i32;
            let fx = sample_x - sample_x.floor();
            let fz = sample_z - sample_z.floor();
            
            let l00 = light_grid.get_light(x0, y, z0);
            let l10 = light_grid.get_light(x0 + 1, y, z0);
            let l01 = light_grid.get_light(x0, y, z0 + 1);
            let l11 = light_grid.get_light(x0 + 1, y, z0 + 1);
            
            let sky = (1.0-fx)*(1.0-fz)*(l00.sky_light as f32) + fx*(1.0-fz)*(l10.sky_light as f32) + 
                      (1.0-fx)*fz*(l01.sky_light as f32) + fx*fz*(l11.sky_light as f32);
            let block = (1.0-fx)*(1.0-fz)*(l00.block_light as f32) + fx*(1.0-fz)*(l10.block_light as f32) + 
                        (1.0-fx)*fz*(l01.block_light as f32) + fx*fz*(l11.block_light as f32);
            (sky as u8, block as u8)
        }
        FaceDirection::East | FaceDirection::West => {
            // Sample in YZ plane at fixed X
            let x = sample_x.floor() as i32;
            let y0 = sample_y.floor() as i32;
            let z0 = sample_z.floor() as i32;
            let fy = sample_y - sample_y.floor();
            let fz = sample_z - sample_z.floor();
            
            let l00 = light_grid.get_light(x, y0, z0);
            let l10 = light_grid.get_light(x, y0 + 1, z0);
            let l01 = light_grid.get_light(x, y0, z0 + 1);
            let l11 = light_grid.get_light(x, y0 + 1, z0 + 1);
            
            let sky = (1.0-fy)*(1.0-fz)*(l00.sky_light as f32) + fy*(1.0-fz)*(l10.sky_light as f32) + 
                      (1.0-fy)*fz*(l01.sky_light as f32) + fy*fz*(l11.sky_light as f32);
            let block = (1.0-fy)*(1.0-fz)*(l00.block_light as f32) + fy*(1.0-fz)*(l10.block_light as f32) + 
                        (1.0-fy)*fz*(l01.block_light as f32) + fy*fz*(l11.block_light as f32);
            (sky as u8, block as u8)
        }
        FaceDirection::North | FaceDirection::South => {
            // Sample in XY plane at fixed Z
            let x0 = sample_x.floor() as i32;
            let y0 = sample_y.floor() as i32;
            let z = sample_z.floor() as i32;
            let fx = sample_x - sample_x.floor();
            let fy = sample_y - sample_y.floor();
            
            let l00 = light_grid.get_light(x0, y0, z);
            let l10 = light_grid.get_light(x0 + 1, y0, z);
            let l01 = light_grid.get_light(x0, y0 + 1, z);
            let l11 = light_grid.get_light(x0 + 1, y0 + 1, z);
            
            let sky = (1.0-fx)*(1.0-fy)*(l00.sky_light as f32) + fx*(1.0-fy)*(l10.sky_light as f32) + 
                      (1.0-fx)*fy*(l01.sky_light as f32) + fx*fy*(l11.sky_light as f32);
            let block = (1.0-fx)*(1.0-fy)*(l00.block_light as f32) + fx*(1.0-fy)*(l10.block_light as f32) + 
                        (1.0-fx)*fy*(l01.block_light as f32) + fx*fy*(l11.block_light as f32);
            (sky as u8, block as u8)
        }
        FaceDirection::None => {
            // Already handled above
        (15, 0)
        }
    }
}

/// Apply rotation transform to a point in block-local space (0-1)
fn apply_rotation_to_point(x: f32, y: f32, z: f32, y_rotation: u8, axis: u8, is_flipped: bool) -> (f32, f32, f32) {
    // Center the point around (0.5, 0.5, 0.5) for rotation
    let cx = x - 0.5;
    let cy = y - 0.5;
    let cz = z - 0.5;
    
    // Apply Y rotation (0=0°, 1=90°, 2=180°, 3=270°)
    let (rx, rz) = match y_rotation {
        0 => (cx, cz),
        1 => (-cz, cx),  // 90° CW
        2 => (-cx, -cz), // 180°
        3 => (cz, -cx),  // 270° CW
        _ => (cx, cz),
    };
    
    // Apply axis rotation and flip
    let (fx, fy, fz) = match (axis, is_flipped) {
        (0, false) => (rx, cy, rz),      // No axis rotation
        (0, true) => (rx, -cy, rz),      // Y-flip only
        (1, false) => (cy, -rx, rz),     // X-axis rotation
        (1, true) => (-cy, -rx, rz),     // X-axis with flip
        (2, false) => (rx, -rz, cy),     // Z-axis rotation
        (2, true) => (rx, rz, cy),       // Z-axis with flip
        _ => (rx, cy, rz),
    };
    
    // Re-center
    (fx + 0.5, fy + 0.5, fz + 0.5)
}

/// Calculate AO values for 4 vertices of a face based on direction
fn calculate_face_ao_neighbors(
    grid: &BinaryGrid,
    lookups: &Lookups,
    x: i32,
    y: i32,
    z: i32,
    face_dir: FaceDirection,
) -> [u8; 4] {
    use FaceDirection::*;
    
    // Offset to the face position
    let (dx, dy, dz) = direction_offset(face_dir);
    let fx = x + dx;
    let fy = y + dy;
    let fz = z + dz;
    
    match face_dir {
        Up => {
            // Check neighbors above
            // Baked vertex order for Up: V0=NW, V1=NE, V2=SE, V3=SW
            let west = is_solid_for_ao(grid, lookups, fx - 1, fy, fz);
            let east = is_solid_for_ao(grid, lookups, fx + 1, fy, fz);
            let north = is_solid_for_ao(grid, lookups, fx, fy, fz - 1);
            let south = is_solid_for_ao(grid, lookups, fx, fy, fz + 1);
            let nw = is_solid_for_ao(grid, lookups, fx - 1, fy, fz - 1);
            let ne = is_solid_for_ao(grid, lookups, fx + 1, fy, fz - 1);
            let sw = is_solid_for_ao(grid, lookups, fx - 1, fy, fz + 1);
            let se = is_solid_for_ao(grid, lookups, fx + 1, fy, fz + 1);
            
            [
                vertex_ao_value(west, north, nw),  // V0 (NW)
                vertex_ao_value(east, north, ne),  // V1 (NE)
                vertex_ao_value(east, south, se),  // V2 (SE)
                vertex_ao_value(west, south, sw),  // V3 (SW)
            ]
        }
        Down => {
            // Baked vertex order for Down: V0=SW, V1=SE, V2=NE, V3=NW
            let west = is_solid_for_ao(grid, lookups, fx - 1, fy, fz);
            let east = is_solid_for_ao(grid, lookups, fx + 1, fy, fz);
            let north = is_solid_for_ao(grid, lookups, fx, fy, fz - 1);
            let south = is_solid_for_ao(grid, lookups, fx, fy, fz + 1);
            let nw = is_solid_for_ao(grid, lookups, fx - 1, fy, fz - 1);
            let ne = is_solid_for_ao(grid, lookups, fx + 1, fy, fz - 1);
            let sw = is_solid_for_ao(grid, lookups, fx - 1, fy, fz + 1);
            let se = is_solid_for_ao(grid, lookups, fx + 1, fy, fz + 1);
            
            [
                vertex_ao_value(west, south, sw),  // V0 (SW)
                vertex_ao_value(east, south, se),  // V1 (SE)
                vertex_ao_value(east, north, ne),  // V2 (NE)
                vertex_ao_value(west, north, nw),  // V3 (NW)
            ]
        }
        North => {
            // Baked vertex order for North: V0=east-up, V1=west-up, V2=west-down, V3=east-down
            let west = is_solid_for_ao(grid, lookups, fx - 1, fy, fz);
            let east = is_solid_for_ao(grid, lookups, fx + 1, fy, fz);
            let up = is_solid_for_ao(grid, lookups, fx, fy + 1, fz);
            let down = is_solid_for_ao(grid, lookups, fx, fy - 1, fz);
            let uw = is_solid_for_ao(grid, lookups, fx - 1, fy + 1, fz);
            let ue = is_solid_for_ao(grid, lookups, fx + 1, fy + 1, fz);
            let dw = is_solid_for_ao(grid, lookups, fx - 1, fy - 1, fz);
            let de = is_solid_for_ao(grid, lookups, fx + 1, fy - 1, fz);
            
            [
                vertex_ao_value(east, up, ue),    // V0: east-up (top-right)
                vertex_ao_value(west, up, uw),    // V1: west-up (top-left)
                vertex_ao_value(west, down, dw),  // V2: west-down (bottom-left)
                vertex_ao_value(east, down, de),  // V3: east-down (bottom-right)
            ]
        }
        South => {
            // Baked vertex order for South: V0=west-up, V1=east-up, V2=east-down, V3=west-down
            let west = is_solid_for_ao(grid, lookups, fx - 1, fy, fz);
            let east = is_solid_for_ao(grid, lookups, fx + 1, fy, fz);
            let up = is_solid_for_ao(grid, lookups, fx, fy + 1, fz);
            let down = is_solid_for_ao(grid, lookups, fx, fy - 1, fz);
            let uw = is_solid_for_ao(grid, lookups, fx - 1, fy + 1, fz);
            let ue = is_solid_for_ao(grid, lookups, fx + 1, fy + 1, fz);
            let dw = is_solid_for_ao(grid, lookups, fx - 1, fy - 1, fz);
            let de = is_solid_for_ao(grid, lookups, fx + 1, fy - 1, fz);
            
            [
                vertex_ao_value(west, up, uw),    // V0: west-up (top-left)
                vertex_ao_value(east, up, ue),    // V1: east-up (top-right)
                vertex_ao_value(east, down, de),  // V2: east-down (bottom-right)
                vertex_ao_value(west, down, dw),  // V3: west-down (bottom-left)
            ]
        }
        East => {
            // Baked vertex order for East: V0=south-up, V1=north-up, V2=north-down, V3=south-down
            let north = is_solid_for_ao(grid, lookups, fx, fy, fz - 1);
            let south = is_solid_for_ao(grid, lookups, fx, fy, fz + 1);
            let up = is_solid_for_ao(grid, lookups, fx, fy + 1, fz);
            let down = is_solid_for_ao(grid, lookups, fx, fy - 1, fz);
            let un = is_solid_for_ao(grid, lookups, fx, fy + 1, fz - 1);
            let us = is_solid_for_ao(grid, lookups, fx, fy + 1, fz + 1);
            let dn = is_solid_for_ao(grid, lookups, fx, fy - 1, fz - 1);
            let ds = is_solid_for_ao(grid, lookups, fx, fy - 1, fz + 1);
            
            [
                vertex_ao_value(south, up, us),    // V0: south-up (top-front)
                vertex_ao_value(north, up, un),    // V1: north-up (top-back)
                vertex_ao_value(north, down, dn),  // V2: north-down (bottom-back)
                vertex_ao_value(south, down, ds),  // V3: south-down (bottom-front)
            ]
        }
        West => {
            // Baked vertex order for West: V0=north-up, V1=south-up, V2=south-down, V3=north-down
            let north = is_solid_for_ao(grid, lookups, fx, fy, fz - 1);
            let south = is_solid_for_ao(grid, lookups, fx, fy, fz + 1);
            let up = is_solid_for_ao(grid, lookups, fx, fy + 1, fz);
            let down = is_solid_for_ao(grid, lookups, fx, fy - 1, fz);
            let un = is_solid_for_ao(grid, lookups, fx, fy + 1, fz - 1);
            let us = is_solid_for_ao(grid, lookups, fx, fy + 1, fz + 1);
            let dn = is_solid_for_ao(grid, lookups, fx, fy - 1, fz - 1);
            let ds = is_solid_for_ao(grid, lookups, fx, fy - 1, fz + 1);
            
            [
                vertex_ao_value(north, up, un),    // V0: north-up (top-back)
                vertex_ao_value(south, up, us),    // V1: south-up (top-front)
                vertex_ao_value(south, down, ds),  // V2: south-down (bottom-front)
                vertex_ao_value(north, down, dn),  // V3: north-down (bottom-back)
            ]
        }
        None => {
            // No specific direction (cross-model), use uniform lighting
            [3, 3, 3, 3]
        }
    }
}

/// Emit a face with per-vertex AO and lighting
fn emit_face_v3_with_ao(
    mesh: &mut ModelMeshData,
    face: &BakedFace,
    world_x: f32,
    world_y: f32,
    world_z: f32,
    y_rotation: u8,
    axis: u8,
    is_flipped: bool,
    vertex_lights: &[VertexLight; 4],
    shade_flag: f32,
) {
    let base_idx = mesh.positions.len() as u32 / 3;
    
    // Check if we need to flip winding for better AO interpolation
    let ao_sum_02 = vertex_lights[0].ao + vertex_lights[2].ao;
    let ao_sum_13 = vertex_lights[1].ao + vertex_lights[3].ao;
    let flip_winding = ao_sum_02 < ao_sum_13;
    
    // Transform and emit vertices
    for i in 0..4 {
        let v = face.vertices[i];
        
        // Apply axis and Y rotation around center (0.5, 0.5, 0.5)
        let (vx, mut vy, vz) = rotate_vertex(v, y_rotation, axis);
        
        // Apply vertical flip around center
        if is_flipped {
            vy = 1.0 - vy;
        }
        
        // Translate to world position
        mesh.positions.push(world_x + vx);
        mesh.positions.push(world_y + vy);
        mesh.positions.push(world_z + vz);
        
        // Transform and emit normal
        let n = face.normal;
        let (nx, ny, nz) = rotate_normal(n, y_rotation, axis);
        let (nx, ny, nz) = if is_flipped { (nx, -ny, nz) } else { (nx, ny, nz) };
        
        mesh.normals.push(nx);
        mesh.normals.push(ny);
        mesh.normals.push(nz);
        
        // Emit UV
        mesh.uvs.push(face.uvs[i][0]);
        mesh.uvs.push(face.uvs[i][1]);
        
        // Emit color with AO applied (RGB only, no alpha - matches geometry expectation)
        let ao = vertex_lights[i].ao;
        mesh.colors.push(ao);
        mesh.colors.push(ao);
        mesh.colors.push(ao);
        
        // Emit texture index
        mesh.tex_indices.push(face.texture_index as f32);
        
        // Emit tint type
        mesh.tint_types.push(face.tint_type as f32);
        
        // Emit light
        mesh.sky_light.push(vertex_lights[i].sky as f32);
        mesh.block_light.push(vertex_lights[i].block as f32);
        
        // Emit shade flag
        mesh.shade_flags.push(shade_flag);
    }
    
    // Emit indices - match JS ModelMesher winding order exactly
    // The baked geometry has vertices in specific order for each face
    // With indices 0-2-1, 0-3-2, we create CCW triangles for Three.js front faces
    // AO diagonal flip uses alternate diagonal for better interpolation
    if flip_winding {
        // Flipped diagonal for AO: 1-3-2, 1-0-3
        mesh.indices.push(base_idx + 1);
        mesh.indices.push(base_idx + 3);
        mesh.indices.push(base_idx + 2);
        mesh.indices.push(base_idx + 1);
        mesh.indices.push(base_idx);
        mesh.indices.push(base_idx + 3);
    } else {
        // Normal winding: 0-2-1, 0-3-2 (matches JS ModelMesher)
        mesh.indices.push(base_idx);
        mesh.indices.push(base_idx + 2);
        mesh.indices.push(base_idx + 1);
        mesh.indices.push(base_idx);
        mesh.indices.push(base_idx + 3);
        mesh.indices.push(base_idx + 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_rotate_vertex() {
        // Vertex at (1, 0, 0) should rotate to (0, 0, 1) after 90° CW
        let v = [1.0, 0.0, 0.0];
        let (rx, ry, rz) = rotate_vertex(v, 1);
        assert!((rx - 1.0).abs() < 0.001);
        assert!((rz - 0.0).abs() < 0.001);
    }
    
    #[test]
    fn test_transform_direction() {
        use FaceDirection::*;
        
        // North + 90° rotation = East
        assert_eq!(transform_direction(North, 1, false), East);
        
        // Up + flip = Down
        assert_eq!(transform_direction(Up, 0, true), Down);
    }
}
