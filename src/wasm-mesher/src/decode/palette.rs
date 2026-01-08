//! Palette unpacking - efficient bit extraction for block indices
//!
//! Minecraft stores block indices in a packed format where each index
//! uses ceil(log2(palette_size)) bits. Multiple indices are packed into
//! 64-bit longs.

/// Unpack block indices from packed long array
/// 
/// This is the Rust equivalent of the JavaScript `unpackBlockIndices` function.
/// Performance is critical here as this is called for every section.
/// 
/// # Arguments
/// * `data` - Array of i64 values containing packed indices
/// * `bits_per_block` - Number of bits per block index (min 4)
/// * `total_blocks` - Total number of blocks to extract (usually 4096)
/// 
/// # Returns
/// Vector of u16 indices
pub fn unpack_block_indices(data: &[i64], bits_per_block: usize, total_blocks: usize) -> Vec<u16> {
    let mut indices = vec![0u16; total_blocks];
    let entries_per_long = 64 / bits_per_block;
    let mask = (1u64 << bits_per_block) - 1;
    
    // Fast path for 4 bits per block (most common case: palettes with 1-16 entries)
    // No entry crosses the 32-bit boundary, so we can use faster u32 operations
    if bits_per_block == 4 {
        let mut i = 0;
        for &long_value in data {
            if i >= total_blocks {
                break;
            }
            
            // Treat i64 as u64 for bit manipulation
            let val = long_value as u64;
            let low = val as u32;
            let high = (val >> 32) as u32;
            
            // Extract 8 entries from low, 8 from high (4 bits each)
            // Low 32 bits: entries 0-7
            if i < total_blocks { indices[i] = ((low) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((low >> 4) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((low >> 8) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((low >> 12) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((low >> 16) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((low >> 20) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((low >> 24) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((low >> 28) & 0xF) as u16; i += 1; }
            
            // High 32 bits: entries 8-15
            if i < total_blocks { indices[i] = ((high) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((high >> 4) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((high >> 8) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((high >> 12) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((high >> 16) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((high >> 20) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((high >> 24) & 0xF) as u16; i += 1; }
            if i < total_blocks { indices[i] = ((high >> 28) & 0xF) as u16; i += 1; }
        }
        return indices;
    }
    
    // Fast path for 5 bits per block (17-32 palette entries)
    // 12 entries per long
    if bits_per_block == 5 {
        let mut i = 0;
        for &long_value in data {
            if i >= total_blocks {
                break;
            }
            
            let val = long_value as u64;
            
            for j in 0..12 {
                if i >= total_blocks {
                    break;
                }
                let shift = j * 5;
                indices[i] = ((val >> shift) & 0x1F) as u16;
                i += 1;
            }
        }
        return indices;
    }
    
    // Fast path for 6 bits per block (33-64 palette entries)
    // 10 entries per long
    if bits_per_block == 6 {
        let mut i = 0;
        for &long_value in data {
            if i >= total_blocks {
                break;
            }
            
            let val = long_value as u64;
            
            for j in 0..10 {
                if i >= total_blocks {
                    break;
                }
                let shift = j * 6;
                indices[i] = ((val >> shift) & 0x3F) as u16;
                i += 1;
            }
        }
        return indices;
    }
    
    // General case for other bit widths
    let mut i = 0;
    for &long_value in data {
        if i >= total_blocks {
            break;
        }
        
        let val = long_value as u64;
        
        for j in 0..entries_per_long {
            if i >= total_blocks {
                break;
            }
            let shift = j * bits_per_block;
            indices[i] = ((val >> shift) & mask) as u16;
            i += 1;
        }
    }
    
    indices
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_unpack_4_bits() {
        // Create test data: first long contains indices 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
        let data = vec![0x0FEDCBA987654321u64 as i64];
        let result = unpack_block_indices(&data, 4, 16);
        
        assert_eq!(result[0], 1);
        assert_eq!(result[1], 2);
        assert_eq!(result[2], 3);
        assert_eq!(result[3], 4);
    }
    
    #[test]
    fn test_unpack_single_palette() {
        // Empty data with single palette entry should work
        let data: Vec<i64> = vec![];
        let result = unpack_block_indices(&data, 4, 0);
        assert_eq!(result.len(), 0);
    }
}


