//! Position Hash Functions
//!
//! Implements Minecraft's exact position hash algorithm for:
//! - Random Y rotation selection for plants and cross-models
//! - Random XZ offset for small plants
//!
//! These must match the JavaScript implementations in ModelMesher.js exactly.

/// Compute position-based rotation (0-3) for blocks with random rotation variants.
/// Uses Minecraft's exact position hash algorithm.
/// 
/// # Arguments
/// * `x`, `y`, `z` - World coordinates
/// 
/// # Returns
/// Rotation value 0-3 (0°, 90°, 180°, 270°)
pub fn get_position_rotation(x: i32, y: i32, z: i32) -> u8 {
    // Minecraft's position hash
    // Note: x * 3129871 is done as int multiply first (with overflow), then cast to long
    // This matches Java's (long)(x * 3129871) behavior
    let x_part = (x.wrapping_mul(3129871)) as i64;  // int multiply, then cast
    let z_part = (z as i64).wrapping_mul(116129781); // cast to long first, then multiply
    let y_part = y as i64;
    
    let mut l = x_part ^ z_part ^ y_part;
    l = l.wrapping_mul(l).wrapping_mul(42317861).wrapping_add(l.wrapping_mul(11));
    let seed = l >> 16;
    
    // Java Random simulation
    const MULT: i64 = 0x5DEECE66D;
    const MASK: i64 = (1 << 48) - 1;
    
    let rng = (seed ^ MULT) & MASK;
    let rng = rng.wrapping_mul(MULT).wrapping_add(0xB) & MASK;
    
    // Java's nextInt(4) = (int)((4L * (seed >>> 17)) >> 31)
    // This correctly maps the 31-bit value to 0-3 range
    let next31 = rng >> 17;
    let result = ((4i64 * next31) >> 31) as u8;
    result & 3
}

/// Compute position-based XZ offset for small plants.
/// Returns offset in range [-0.25, 0.25] for X and Z.
/// 
/// # Arguments
/// * `x`, `y`, `z` - World coordinates
/// 
/// # Returns
/// (dx, dz) offset values in block units
pub fn get_position_offset(x: i32, y: i32, z: i32) -> (f32, f32) {
    // Minecraft's position hash
    let x_part = x.wrapping_mul(3129871) as i64;
    let z_part = (z as i64).wrapping_mul(116129781);
    let y_part = y as i64;
    
    let mut l = x_part ^ z_part ^ y_part;
    l = l.wrapping_mul(l).wrapping_mul(42317861).wrapping_add(l.wrapping_mul(11));
    let seed = l >> 16;
    
    // Java Random simulation
    const MULT: i64 = 0x5DEECE66D;
    const MASK: i64 = (1 << 48) - 1;
    
    let mut rng = (seed ^ MULT) & MASK;
    
    // First random value for X offset
    rng = rng.wrapping_mul(MULT).wrapping_add(0xB) & MASK;
    let x_rand = ((rng >> 17) & 0x7FFF) as f32 / 32767.0; // 0 to 1
    
    // Second random value for Z offset
    rng = rng.wrapping_mul(MULT).wrapping_add(0xB) & MASK;
    let z_rand = ((rng >> 17) & 0x7FFF) as f32 / 32767.0; // 0 to 1
    
    // Map to [-0.25, 0.25] range
    let dx = (x_rand - 0.5) * 0.5;
    let dz = (z_rand - 0.5) * 0.5;
    
    (dx, dz)
}

/// Rotate a vertex position around Y axis by 90-degree increments.
/// 
/// # Arguments
/// * `vx`, `vz` - Vertex X and Z (relative to block, 0-1 range)
/// * `rotation` - 0=0°, 1=90°, 2=180°, 3=270°
/// 
/// # Returns
/// (rx, rz) rotated position
pub fn rotate_vertex_y(vx: f32, vz: f32, rotation: u8) -> (f32, f32) {
    // Rotate around block center (0.5, 0.5)
    let cx = vx - 0.5;
    let cz = vz - 0.5;
    
    match rotation {
        1 => (-cz + 0.5, cx + 0.5),  // 90° clockwise
        2 => (-cx + 0.5, -cz + 0.5), // 180°
        3 => (cz + 0.5, -cx + 0.5),  // 270° clockwise
        _ => (vx, vz),               // 0° - no rotation
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_rotation_deterministic() {
        // Same position should give same rotation
        let r1 = get_position_rotation(10, 64, 20);
        let r2 = get_position_rotation(10, 64, 20);
        assert_eq!(r1, r2);
    }
    
    #[test]
    fn test_rotation_range() {
        // Rotation should be 0-3
        for x in 0..100 {
            let r = get_position_rotation(x, 64, x * 7);
            assert!(r < 4, "Rotation {} out of range", r);
        }
    }
    
    #[test]
    fn test_offset_range() {
        // Offset should be in [-0.25, 0.25]
        for x in 0..100 {
            let (dx, dz) = get_position_offset(x, 64, x * 7);
            assert!(dx >= -0.25 && dx <= 0.25, "dx {} out of range", dx);
            assert!(dz >= -0.25 && dz <= 0.25, "dz {} out of range", dz);
        }
    }
    
    #[test]
    fn test_vertex_rotation() {
        // Test corner at (1, 1) with different rotations
        let (rx, rz) = rotate_vertex_y(1.0, 1.0, 0);
        assert!((rx - 1.0).abs() < 0.001 && (rz - 1.0).abs() < 0.001);
        
        let (rx, rz) = rotate_vertex_y(1.0, 1.0, 2);
        assert!((rx - 0.0).abs() < 0.001 && (rz - 0.0).abs() < 0.001);
    }
}
