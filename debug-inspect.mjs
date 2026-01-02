/**
 * Debug script to inspect blocks at a specific location
 */
import { parseMCAFromPath } from './test/helpers/nodeMcaParser.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Target coordinates (from user)
const TARGET_X = -236;
const TARGET_Y = 76;
const TARGET_Z = -213;
const BOX_SIZE = 5; // 5 blocks in each direction = 10x10x10 box

async function main() {
  // Read region file
  const regionPath = path.join(__dirname, 'test-regions', 'r.-1.-1.mca');
  
  console.log(`\n=== Inspecting blocks around (${TARGET_X}, ${TARGET_Y}, ${TARGET_Z}) ===\n`);
  console.log(`Region file: r.-1.-1.mca`);
  
  // Calculate which chunk contains our target
  // For region -1,-1 chunks are 0-31 locally, but world coordinates are -512 to -1
  const worldChunkX = Math.floor(TARGET_X / 16); // = -15
  const worldChunkZ = Math.floor(TARGET_Z / 16); // = -14
  const localChunkX = worldChunkX + 32; // Local chunk in region (0-31)
  const localChunkZ = worldChunkZ + 32;
  
  console.log(`Target is in world chunk (${worldChunkX}, ${worldChunkZ})`);
  console.log(`Local region chunk: (${localChunkX}, ${localChunkZ})`);
  console.log(`Local position in chunk: (${((TARGET_X % 16) + 16) % 16}, ${TARGET_Y}, ${((TARGET_Z % 16) + 16) % 16})`);
  
  // Parse the region
  const chunks = await parseMCAFromPath(regionPath);
  console.log(`\nParsed ${chunks.length} chunks from region\n`);
  
  // Find chunks that contain our target area
  const minChunkX = Math.floor((TARGET_X - BOX_SIZE) / 16) + 32;
  const maxChunkX = Math.floor((TARGET_X + BOX_SIZE) / 16) + 32;
  const minChunkZ = Math.floor((TARGET_Z - BOX_SIZE) / 16) + 32;
  const maxChunkZ = Math.floor((TARGET_Z + BOX_SIZE) / 16) + 32;
  
  console.log(`Looking at local chunks from (${minChunkX}, ${minChunkZ}) to (${maxChunkX}, ${maxChunkZ})\n`);
  
  // Collect blocks in the area
  const blocksFound = [];
  
  for (const chunk of chunks) {
    // chunk.x and chunk.z are local (0-31)
    if (chunk.x < minChunkX || chunk.x > maxChunkX) continue;
    if (chunk.z < minChunkZ || chunk.z > maxChunkZ) continue;
    
    const worldChunkBaseX = (chunk.x - 32) * 16;
    const worldChunkBaseZ = (chunk.z - 32) * 16;
    
    console.log(`Checking chunk (${chunk.x}, ${chunk.z}) - world base: (${worldChunkBaseX}, ${worldChunkBaseZ})`);
    
    // Look through sections
    const sections = chunk.data?.sections;
    if (!sections) continue;
    
    for (const section of sections) {
      const sectionY = section.Y;
      if (sectionY === undefined) continue;
      
      const sectionMinY = sectionY * 16;
      const sectionMaxY = sectionMinY + 15;
      
      // Skip sections outside our Y range
      if (sectionMaxY < TARGET_Y - BOX_SIZE || sectionMinY > TARGET_Y + BOX_SIZE) continue;
      
      const blockStates = section.block_states;
      if (!blockStates?.palette) continue;
      
      const palette = blockStates.palette;
      const data = blockStates.data;
      
      // Calculate bits per block
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const blocksPerLong = Math.floor(64 / bitsPerBlock);
      const mask = (1n << BigInt(bitsPerBlock)) - 1n;
      
      // Iterate through blocks in this section
      for (let localY = 0; localY < 16; localY++) {
        const worldY = sectionMinY + localY;
        if (worldY < TARGET_Y - BOX_SIZE || worldY > TARGET_Y + BOX_SIZE) continue;
        
        for (let localZ = 0; localZ < 16; localZ++) {
          const actualWorldZ = worldChunkBaseZ + localZ;
          if (actualWorldZ < TARGET_Z - BOX_SIZE || actualWorldZ > TARGET_Z + BOX_SIZE) continue;
          
          for (let localX = 0; localX < 16; localX++) {
            const actualWorldX = worldChunkBaseX + localX;
            if (actualWorldX < TARGET_X - BOX_SIZE || actualWorldX > TARGET_X + BOX_SIZE) continue;
            
            // Get block index
            const blockIndex = localY * 256 + localZ * 16 + localX;
            
            // Get palette index from data
            let paletteIndex = 0;
            if (data && data.length > 0) {
              const longIndex = Math.floor(blockIndex / blocksPerLong);
              const bitOffset = (blockIndex % blocksPerLong) * bitsPerBlock;
              
              if (longIndex < data.length) {
                // Handle BigInt conversion properly
                let longValue = data[longIndex];
                if (typeof longValue !== 'bigint') {
                  longValue = BigInt(longValue);
                }
                longValue = BigInt.asUintN(64, longValue);
                paletteIndex = Number((longValue >> BigInt(bitOffset)) & mask);
              }
            }
            
            if (paletteIndex >= palette.length) paletteIndex = 0;
            
            const blockState = palette[paletteIndex];
            const blockName = blockState?.Name || 'unknown';
            
            // Skip air
            if (blockName === 'minecraft:air' || blockName === 'air') continue;
            
            blocksFound.push({
              x: actualWorldX,
              y: worldY,
              z: actualWorldZ,
              block: blockName,
              properties: blockState?.Properties || {},
              distance: Math.sqrt(
                Math.pow(actualWorldX - TARGET_X, 2) +
                Math.pow(worldY - TARGET_Y, 2) +
                Math.pow(actualWorldZ - TARGET_Z, 2)
              )
            });
          }
        }
      }
    }
  }
  
  // Sort by distance
  blocksFound.sort((a, b) => a.distance - b.distance);
  
  console.log(`\n=== Blocks found in ${BOX_SIZE*2+1}x${BOX_SIZE*2+1}x${BOX_SIZE*2+1} box (${blocksFound.length} total) ===\n`);
  
  // Group by block type
  const blockCounts = {};
  for (const block of blocksFound) {
    const name = block.block.replace('minecraft:', '');
    blockCounts[name] = (blockCounts[name] || 0) + 1;
  }
  
  console.log('Block counts:');
  const sorted = Object.entries(blockCounts).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`  ${name}: ${count}`);
  }
  
  console.log('\n=== All blocks sorted by distance ===\n');
  for (const b of blocksFound) {
    const props = Object.keys(b.properties).length > 0 ? 
      ` [${Object.entries(b.properties).map(([k,v]) => `${k}=${v}`).join(', ')}]` : '';
    console.log(`(${b.x}, ${b.y}, ${b.z}) dist=${b.distance.toFixed(2)}: ${b.block.replace('minecraft:', '')}${props}`);
  }
  
  // Look for unusual blocks (sea pickles, coral, etc.)
  console.log('\n=== Unusual blocks (non-standard shapes) ===\n');
  const unusualPatterns = ['pickle', 'coral', 'candle', 'rod', 'chain', 'lantern', 'campfire', 'brewing', 'flower_pot', 'dragon_egg', 'sea_pickle', 'turtle_egg', 'frogspawn', 'amethyst', 'pointed', 'end_rod'];
  const unusual = blocksFound.filter(b => 
    unusualPatterns.some(p => b.block.toLowerCase().includes(p))
  );
  
  if (unusual.length > 0) {
    for (const b of unusual) {
      const props = Object.keys(b.properties).length > 0 ? 
        ` [${Object.entries(b.properties).map(([k,v]) => `${k}=${v}`).join(', ')}]` : '';
      console.log(`(${b.x}, ${b.y}, ${b.z}): ${b.block.replace('minecraft:', '')}${props}`);
    }
  } else {
    console.log('No unusual blocks found in this area');
  }
}

main().catch(console.error);
