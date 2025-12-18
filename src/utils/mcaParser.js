import pako from 'pako';
import { parseNBTRaw } from './nbtParser';

const SECTOR_SIZE = 4096;
const CHUNKS_PER_REGION = 32;

export async function parseMCAFile(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const chunks = [];

  // Read chunk location table (first 4KB)
  for (let z = 0; z < CHUNKS_PER_REGION; z++) {
    for (let x = 0; x < CHUNKS_PER_REGION; x++) {
      const index = x + z * CHUNKS_PER_REGION;
      const locationOffset = index * 4;
      
      const locationData = view.getUint32(locationOffset, false);
      const offset = (locationData >> 8) * SECTOR_SIZE;
      const sectorCount = locationData & 0xFF;

      if (offset === 0 || sectorCount === 0) continue;

      try {
        // Read chunk data
        const length = view.getUint32(offset, false);
        const compressionType = view.getUint8(offset + 4);
        
        const compressedData = new Uint8Array(buffer, offset + 5, length - 1);
        
        let decompressedData;
        if (compressionType === 1) {
          // GZip
          decompressedData = pako.ungzip(compressedData);
        } else if (compressionType === 2) {
          // Zlib
          decompressedData = pako.inflate(compressedData);
        } else {
          console.warn(`Unknown compression type: ${compressionType}`);
          continue;
        }

        const nbt = parseNBTRaw(decompressedData.buffer);
        chunks.push({
          x,
          z,
          data: nbt.value
        });
      } catch (e) {
        console.warn(`Failed to parse chunk at ${x}, ${z}:`, e.message);
      }
    }
  }

  return chunks;
}

// Unpack block indices from packed long array (Minecraft 1.16+ format)
function unpackBlockIndices(data, bitsPerBlock, totalBlocks) {
  const indices = new Array(totalBlocks);
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  
  // In 1.16+, entries don't span across longs
  const entriesPerLong = Math.floor(64 / bitsPerBlock);
  
  for (let i = 0; i < totalBlocks; i++) {
    const longIndex = Math.floor(i / entriesPerLong);
    const indexInLong = i % entriesPerLong;
    const bitOffset = indexInLong * bitsPerBlock;
    
    if (longIndex >= data.length) {
      indices[i] = 0;
      continue;
    }
    
    // Handle BigInt from NBT parser
    let longValue = data[longIndex];
    if (typeof longValue === 'bigint') {
      longValue = BigInt.asUintN(64, longValue);
    } else {
      longValue = BigInt(longValue >>> 0);
    }
    
    indices[i] = Number((longValue >> BigInt(bitOffset)) & mask);
  }
  
  return indices;
}

// Extract block data from a chunk based on Minecraft version format
export function extractBlocks(chunk) {
  const blocks = [];
  const data = chunk.data;
  
  // Debug: log chunk structure
  console.log('=== CHUNK DEBUG ===');
  console.log('Chunk data keys:', Object.keys(data));
  
  // Log first level structure
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (Array.isArray(value)) {
      console.log(`  ${key}: Array[${value.length}]`);
      if (value.length > 0 && typeof value[0] === 'object') {
        console.log(`    First item keys:`, Object.keys(value[0]));
      }
    } else if (typeof value === 'object' && value !== null) {
      console.log(`  ${key}: Object with keys:`, Object.keys(value));
    } else {
      console.log(`  ${key}:`, value);
    }
  }
  
  // Try modern format (1.18+) with sections
  let sections = data.sections || (data.Level && data.Level.Sections);
  
  if (!sections) {
    console.warn('No sections found in chunk. Available keys:', Object.keys(data));
    return blocks;
  }
  
  console.log(`Found ${sections.length} sections`);

  for (const section of sections) {
    const y = section.Y !== undefined ? Number(section.Y) : 0;
    const baseY = y * 16;
    
    // Skip sections outside reasonable range
    if (baseY < -64 || baseY > 320) continue;
    
    // Debug section structure
    console.log(`\nSection Y=${y} keys:`, Object.keys(section));
    
    // Modern format with block_states (1.18+)
    const blockStates = section.block_states;
    if (blockStates) {
      const palette = blockStates.palette || [];
      const blockData = blockStates.data;
      
      if (palette.length === 0) continue;
      
      console.log(`Section Y=${y}: palette size=${palette.length}, has data=${!!blockData}, data length=${blockData?.length}`);
      if (palette.length > 0) {
        console.log(`  First palette entry:`, JSON.stringify(palette[0]));
        if (palette.length > 1) console.log(`  Second palette entry:`, JSON.stringify(palette[1]));
      }
      if (blockData && blockData.length > 0) {
        console.log(`  First data long:`, blockData[0]?.toString());
      }
      
      // If there's only one block type in the section (no data array needed)
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        const entry = palette[0];
        const blockName = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        if (isAirBlock(blockName)) continue;
        
        // Fill entire section with this block
        for (let ly = 0; ly < 16; ly++) {
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              blocks.push({
                x: lx,
                y: baseY + ly,
                z: lz,
                block: blockName
              });
            }
          }
        }
        continue;
      }
      
      // Calculate bits per block
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      
      // Unpack all block indices
      const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
      
      // Minecraft stores blocks in YZX order within a section
      let blockIndex = 0;
      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex];
            
            if (paletteIndex < palette.length) {
              const entry = palette[paletteIndex];
              const blockName = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
              
              if (!isAirBlock(blockName)) {
                blocks.push({
                  x: lx,
                  y: baseY + ly,
                  z: lz,
                  block: blockName
                });
              }
            }
            blockIndex++;
          }
        }
      }
    }
    // Legacy format with Palette and BlockStates (1.13-1.17)
    else if (section.Palette && section.BlockStates) {
      const palette = section.Palette;
      const blockData = section.BlockStates;
      
      console.log(`Section Y=${y} (legacy): palette size=${palette.length}`);
      
      if (palette.length === 0) continue;
      
      // Single block type in section
      if (palette.length === 1) {
        const blockName = palette[0].Name || 'minecraft:air';
        if (isAirBlock(blockName)) continue;
        
        for (let ly = 0; ly < 16; ly++) {
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              blocks.push({
                x: lx,
                y: baseY + ly,
                z: lz,
                block: blockName
              });
            }
          }
        }
        continue;
      }
      
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const indices = unpackBlockIndices(blockData, bitsPerBlock, 4096);
      
      let blockIndex = 0;
      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex];
            
            if (paletteIndex < palette.length) {
              const blockName = palette[paletteIndex].Name || 'minecraft:air';
              if (!isAirBlock(blockName)) {
                blocks.push({
                  x: lx,
                  y: baseY + ly,
                  z: lz,
                  block: blockName
                });
              }
            }
            blockIndex++;
          }
        }
      }
    }
    // Very old format with Blocks byte array (pre-1.13)
    else if (section.Blocks) {
      const blocksArray = section.Blocks;
      const addArray = section.Add || null;
      
      console.log(`Section Y=${y} (pre-1.13): blocks array length=${blocksArray.length}`);
      
      let blockIndex = 0;
      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            let blockId = blocksArray[blockIndex] & 0xFF;
            
            // Handle extended block IDs
            if (addArray) {
              const addIndex = blockIndex >> 1;
              const addValue = addArray[addIndex] & 0xFF;
              if (blockIndex % 2 === 0) {
                blockId |= (addValue & 0x0F) << 8;
              } else {
                blockId |= (addValue & 0xF0) << 4;
              }
            }
            
            // Skip air (block ID 0)
            if (blockId !== 0) {
              blocks.push({
                x: lx,
                y: baseY + ly,
                z: lz,
                block: `minecraft:legacy_${blockId}`
              });
            }
            blockIndex++;
          }
        }
      }
    }
  }

  console.log(`Total blocks extracted: ${blocks.length}`);
  return blocks;
}

function isAirBlock(name) {
  if (!name) return true;
  return name === 'minecraft:air' || 
         name === 'minecraft:cave_air' || 
         name === 'minecraft:void_air' ||
         name === 'air' ||
         name.endsWith(':air');
}

// Get block color based on block name
export function getBlockColor(blockName) {
  if (!blockName) return '#707070';
  const name = blockName.replace('minecraft:', '');
  
  const colorMap = {
    // Stone variants
    'stone': '#808080',
    'granite': '#9A6C4C',
    'polished_granite': '#A67B5B',
    'diorite': '#BFBFBF',
    'polished_diorite': '#D0D0D0',
    'andesite': '#888888',
    'polished_andesite': '#9A9A9A',
    'deepslate': '#4A4A4A',
    'cobblestone': '#7A7A7A',
    'cobbled_deepslate': '#3A3A3A',
    'bedrock': '#2A2A2A',
    
    // Dirt variants
    'dirt': '#8B6C4C',
    'coarse_dirt': '#7A5C3C',
    'rooted_dirt': '#8B6C4C',
    'grass_block': '#5D8C32',
    'podzol': '#6A5D3A',
    'mycelium': '#8B7B7B',
    'mud': '#3C3C3C',
    'clay': '#9BA4AF',
    
    // Sand
    'sand': '#E3D59E',
    'red_sand': '#BA6629',
    'gravel': '#8A8A8A',
    'sandstone': '#D9C896',
    'red_sandstone': '#A44D22',
    
    // Ores
    'coal_ore': '#4A4A4A',
    'deepslate_coal_ore': '#3A3A3A',
    'iron_ore': '#B8A090',
    'deepslate_iron_ore': '#8A7060',
    'copper_ore': '#A67B5B',
    'deepslate_copper_ore': '#8A5A3A',
    'gold_ore': '#FCEE4B',
    'deepslate_gold_ore': '#DAC42B',
    'redstone_ore': '#FF0000',
    'deepslate_redstone_ore': '#CC0000',
    'emerald_ore': '#17DD62',
    'deepslate_emerald_ore': '#0AAA4A',
    'lapis_ore': '#1E4B9B',
    'deepslate_lapis_ore': '#0E3B7B',
    'diamond_ore': '#4AEDD9',
    'deepslate_diamond_ore': '#2ACDB9',
    'ancient_debris': '#6C4A3A',
    
    // Wood
    'oak_log': '#8B7355',
    'spruce_log': '#4A3728',
    'birch_log': '#E8E4D5',
    'jungle_log': '#6A5B3A',
    'acacia_log': '#6A3D2A',
    'dark_oak_log': '#3A2714',
    'mangrove_log': '#6A2A2A',
    'cherry_log': '#4A2A3A',
    'oak_planks': '#BA9862',
    'spruce_planks': '#7A5A3A',
    'birch_planks': '#C9B87A',
    'jungle_planks': '#AB8254',
    'acacia_planks': '#BA6229',
    'dark_oak_planks': '#4A3314',
    'oak_leaves': '#3A8B25',
    'spruce_leaves': '#2A5A35',
    'birch_leaves': '#5A9A3A',
    'jungle_leaves': '#3A8B25',
    'acacia_leaves': '#6A9A4A',
    'dark_oak_leaves': '#2A5A25',
    'azalea_leaves': '#5A8A3A',
    'flowering_azalea_leaves': '#7A5A7A',
    'cherry_leaves': '#FFAACC',
    'mangrove_leaves': '#4A8A3A',
    
    // Water and lava
    'water': '#3F76E4',
    'lava': '#FF6600',
    
    // Building blocks
    'bricks': '#9A5A4A',
    'stone_bricks': '#7A7A7A',
    'mossy_stone_bricks': '#5A7A5A',
    'cracked_stone_bricks': '#6A6A6A',
    'chiseled_stone_bricks': '#7A7A7A',
    'obsidian': '#1A0A2A',
    'crying_obsidian': '#2A1A4A',
    'netherrack': '#8A3A3A',
    'soul_sand': '#5A4A3A',
    'soul_soil': '#4A3A2A',
    'basalt': '#4A4A4A',
    'smooth_basalt': '#3A3A3A',
    'blackstone': '#2A2A2A',
    'end_stone': '#DADA9A',
    'purpur_block': '#AA6AAA',
    
    // Glass
    'glass': '#FFFFFF',
    'tinted_glass': '#3A3A3A',
    
    // Terracotta
    'terracotta': '#9A5A4A',
    'white_terracotta': '#D9C8B8',
    'orange_terracotta': '#A45B2A',
    'magenta_terracotta': '#9A5A7A',
    'light_blue_terracotta': '#7A8AA0',
    'yellow_terracotta': '#BA982A',
    'lime_terracotta': '#6A7A3A',
    'pink_terracotta': '#A0605A',
    'gray_terracotta': '#4A3A3A',
    'light_gray_terracotta': '#8A7A70',
    'cyan_terracotta': '#5A6A6A',
    'purple_terracotta': '#7A4A6A',
    'blue_terracotta': '#4A4A6A',
    'brown_terracotta': '#5A3A2A',
    'green_terracotta': '#4A5A3A',
    'red_terracotta': '#8A3A3A',
    'black_terracotta': '#3A2A2A',
    
    // Concrete
    'white_concrete': '#CFCFCF',
    'orange_concrete': '#E06100',
    'magenta_concrete': '#A9309F',
    'light_blue_concrete': '#2389C6',
    'yellow_concrete': '#F1AF15',
    'lime_concrete': '#5EA818',
    'pink_concrete': '#D5658E',
    'gray_concrete': '#36393D',
    'light_gray_concrete': '#7D7D73',
    'cyan_concrete': '#157788',
    'purple_concrete': '#641F9C',
    'blue_concrete': '#2C2E8E',
    'brown_concrete': '#603B1F',
    'green_concrete': '#495B24',
    'red_concrete': '#8E2121',
    'black_concrete': '#080A0F',
    
    // Ice and snow
    'ice': '#91B9FF',
    'packed_ice': '#7AA4FF',
    'blue_ice': '#5A84FF',
    'snow_block': '#F0F0F0',
    'snow': '#FAFAFA',
    'powder_snow': '#F8F8F8',
    
    // Nether blocks
    'nether_bricks': '#3A2A2A',
    'red_nether_bricks': '#4A1A1A',
    'nether_wart_block': '#7A1A1A',
    'warped_wart_block': '#1A7A7A',
    'crimson_nylium': '#7A2A2A',
    'warped_nylium': '#2A7A7A',
    'crimson_stem': '#6A2A4A',
    'warped_stem': '#2A6A6A',
    'shroomlight': '#F0C040',
    'glowstone': '#FFDD75',
    
    // Copper
    'copper_block': '#C06040',
    'exposed_copper': '#A08060',
    'weathered_copper': '#6A9A70',
    'oxidized_copper': '#4A9A8A',
    
    // Amethyst
    'amethyst_block': '#8A5AAA',
    'budding_amethyst': '#9A6ABA',
    
    // Misc
    'tuff': '#5A5A4A',
    'calcite': '#E0E0E0',
    'dripstone_block': '#8A7A6A',
    'moss_block': '#4A7A3A',
    'sculk': '#0A2A3A',
    'sculk_catalyst': '#0A3A4A',
    'sculk_sensor': '#0A4A5A',
    'sculk_shrieker': '#0A3A4A',
    'bone_block': '#E5DCC5',
    'hay_block': '#B8A050',
    'honeycomb_block': '#E8A030',
    'slime_block': '#80CC60',
    'honey_block': '#FFAA20',
    'sponge': '#C4C040',
    'wet_sponge': '#A4A030',
    'melon': '#A0C830',
    'pumpkin': '#CC8020',
    'carved_pumpkin': '#CC8020',
    'jack_o_lantern': '#CC8020',
    
    // Wool colors
    'white_wool': '#E8E8E8',
    'orange_wool': '#E87020',
    'magenta_wool': '#B838B8',
    'light_blue_wool': '#58A8D8',
    'yellow_wool': '#E8C820',
    'lime_wool': '#60B820',
    'pink_wool': '#E888A8',
    'gray_wool': '#484848',
    'light_gray_wool': '#989898',
    'cyan_wool': '#189090',
    'purple_wool': '#7828B8',
    'blue_wool': '#3838B8',
    'brown_wool': '#784818',
    'green_wool': '#407820',
    'red_wool': '#A82020',
    'black_wool': '#181818',
  };

  // Check for exact match
  if (colorMap[name]) return colorMap[name];
  
  // Check for partial matches
  for (const [key, color] of Object.entries(colorMap)) {
    if (name.includes(key)) return color;
  }
  
  // Default colors based on common patterns
  if (name.includes('ore')) return '#8A7A6A';
  if (name.includes('log') || name.includes('wood')) return '#8B7355';
  if (name.includes('leaves') || name.includes('leaf')) return '#3A8B25';
  if (name.includes('stone')) return '#808080';
  if (name.includes('dirt') || name.includes('mud')) return '#8B6C4C';
  if (name.includes('sand')) return '#E3D59E';
  if (name.includes('grass')) return '#5D8C32';
  if (name.includes('water')) return '#3F76E4';
  if (name.includes('lava')) return '#FF6600';
  if (name.includes('ice')) return '#91B9FF';
  if (name.includes('snow')) return '#F0F0F0';
  if (name.includes('nether') || name.includes('crimson')) return '#7A2A2A';
  if (name.includes('warped')) return '#2A7A7A';
  if (name.includes('copper')) return '#C06040';
  if (name.includes('iron')) return '#D8D8D8';
  if (name.includes('gold')) return '#FCEE4B';
  if (name.includes('diamond')) return '#4AEDD9';
  if (name.includes('emerald')) return '#17DD62';
  if (name.includes('redstone')) return '#FF0000';
  if (name.includes('lapis')) return '#1E4B9B';
  if (name.includes('coal')) return '#2A2A2A';
  if (name.includes('wool')) return '#E8E8E8';
  if (name.includes('concrete')) return '#808080';
  if (name.includes('terracotta')) return '#9A5A4A';
  if (name.includes('glass')) return '#FFFFFF';
  if (name.includes('brick')) return '#9A5A4A';
  if (name.includes('planks')) return '#BA9862';
  if (name.includes('slab') || name.includes('stairs')) return '#808080';
  
  // Unknown block - use a subtle gray
  return '#707070';
}
