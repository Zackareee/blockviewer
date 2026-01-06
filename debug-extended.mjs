/**
 * Debug: Look at blocks above/around target that might have extending geometry
 */
import { parseMCAFromPath } from './test/helpers/nodeMcaParser.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Target coordinates - exact from user
const TARGET_X = -236;
const TARGET_Y = 76;  // User is at Y=76.088
const TARGET_Z = -213;

async function main() {
  const regionPath = path.join(__dirname, 'test-regions', 'r.-1.-1.mca');
  const chunks = await parseMCAFromPath(regionPath);
  
  console.log('=== Blocks directly at/above target position ===\n');
  
  // Look at Y=76, 77, 78, 79 around target
  const worldChunkX = Math.floor(TARGET_X / 16);
  const worldChunkZ = Math.floor(TARGET_Z / 16);
  const localChunkX = worldChunkX + 32;
  const localChunkZ = worldChunkZ + 32;
  
  const targetChunk = chunks.find(c => c.x === localChunkX && c.z === localChunkZ);
  if (!targetChunk) {
    console.log('Chunk not found!');
    return;
  }
  
  const sections = targetChunk.data?.sections;
  if (!sections) return;
  
  const worldChunkBaseX = (localChunkX - 32) * 16;
  const worldChunkBaseZ = (localChunkZ - 32) * 16;
  
  // Print vertical column at exact target
  console.log(`Vertical column at X=${TARGET_X}, Z=${TARGET_Z}:`);
  console.log('');
  
  for (const section of sections) {
    const sectionY = section.Y;
    if (sectionY === undefined) continue;
    
    const sectionMinY = sectionY * 16;
    const blockStates = section.block_states;
    if (!blockStates?.palette) continue;
    
    const palette = blockStates.palette;
    const data = blockStates.data;
    
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const blocksPerLong = Math.floor(64 / bitsPerBlock);
    const mask = (1n << BigInt(bitsPerBlock)) - 1n;
    
    // Check local coords for our target
    const localX = ((TARGET_X % 16) + 16) % 16;
    const localZ = ((TARGET_Z % 16) + 16) % 16;
    
    for (let localY = 0; localY < 16; localY++) {
      const worldY = sectionMinY + localY;
      if (worldY < 70 || worldY > 85) continue; // Focus on nearby Y range
      
      const blockIndex = localY * 256 + localZ * 16 + localX;
      
      let paletteIndex = 0;
      if (data && data.length > 0) {
        const longIndex = Math.floor(blockIndex / blocksPerLong);
        const bitOffset = (blockIndex % blocksPerLong) * bitsPerBlock;
        
        if (longIndex < data.length) {
          let longValue = data[longIndex];
          if (typeof longValue !== 'bigint') longValue = BigInt(longValue);
          longValue = BigInt.asUintN(64, longValue);
          paletteIndex = Number((longValue >> BigInt(bitOffset)) & mask);
        }
      }
      
      if (paletteIndex >= palette.length) paletteIndex = 0;
      
      const blockState = palette[paletteIndex];
      const blockName = (blockState?.Name || 'unknown').replace('minecraft:', '');
      const props = blockState?.Properties || {};
      const propsStr = Object.keys(props).length > 0 
        ? ` [${Object.entries(props).map(([k,v]) => `${k}=${v}`).join(', ')}]`
        : '';
      
      if (blockName !== 'air') {
        const marker = worldY === TARGET_Y ? ' <-- USER POSITION' : '';
        console.log(`  Y=${worldY}: ${blockName}${propsStr}${marker}`);
      } else if (worldY === TARGET_Y) {
        console.log(`  Y=${worldY}: AIR <-- USER POSITION`);
      }
    }
  }
  
  // Check for cave_vines and hanging elements
  console.log('\n=== Cave vines and hanging elements in area ===\n');
  
  const hangingBlocks = [];
  
  // Check all chunks in a 3x3 area
  const chunkRange = [-1, 0, 1];
  for (const dcx of chunkRange) {
    for (const dcz of chunkRange) {
      const cx = localChunkX + dcx;
      const cz = localChunkZ + dcz;
      const chunk = chunks.find(c => c.x === cx && c.z === cz);
      if (!chunk?.data?.sections) continue;
      
      const chunkBaseX = (cx - 32) * 16;
      const chunkBaseZ = (cz - 32) * 16;
      
      for (const section of chunk.data.sections) {
        const sectionY = section.Y;
        if (sectionY === undefined) continue;
        
        const sectionMinY = sectionY * 16;
        if (sectionMinY > TARGET_Y + 10 || sectionMinY + 15 < TARGET_Y - 5) continue;
        
        const blockStates = section.block_states;
        if (!blockStates?.palette) continue;
        
        const palette = blockStates.palette;
        const data = blockStates.data;
        
        const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
        const blocksPerLong = Math.floor(64 / bitsPerBlock);
        const mask = (1n << BigInt(bitsPerBlock)) - 1n;
        
        for (let i = 0; i < 4096; i++) {
          let paletteIndex = 0;
          if (data && data.length > 0) {
            const longIndex = Math.floor(i / blocksPerLong);
            const bitOffset = (i % blocksPerLong) * bitsPerBlock;
            
            if (longIndex < data.length) {
              let longValue = data[longIndex];
              if (typeof longValue !== 'bigint') longValue = BigInt(longValue);
              longValue = BigInt.asUintN(64, longValue);
              paletteIndex = Number((longValue >> BigInt(bitOffset)) & mask);
            }
          }
          
          if (paletteIndex >= palette.length) paletteIndex = 0;
          
          const blockState = palette[paletteIndex];
          const blockName = (blockState?.Name || 'air').replace('minecraft:', '');
          
          // Check for hanging/vine blocks
          if (blockName.includes('vine') || 
              blockName.includes('root') || 
              blockName.includes('chain') ||
              blockName.includes('lantern') ||
              blockName.includes('rod') ||
              blockName === 'fire' ||
              blockName === 'soul_fire') {
            
            const localX = i & 15;
            const localZ = (i >> 4) & 15;
            const localY = i >> 8;
            
            const wx = chunkBaseX + localX;
            const wy = sectionMinY + localY;
            const wz = chunkBaseZ + localZ;
            
            const dist = Math.sqrt(
              Math.pow(wx - TARGET_X, 2) +
              Math.pow(wy - TARGET_Y, 2) +
              Math.pow(wz - TARGET_Z, 2)
            );
            
            if (dist < 10) {
              hangingBlocks.push({ 
                x: wx, y: wy, z: wz, 
                block: blockName,
                props: blockState?.Properties || {},
                dist
              });
            }
          }
        }
      }
    }
  }
  
  hangingBlocks.sort((a, b) => a.dist - b.dist);
  
  if (hangingBlocks.length === 0) {
    console.log('No hanging/vine blocks found nearby');
  } else {
    for (const b of hangingBlocks) {
      const propsStr = Object.keys(b.props).length > 0 
        ? ` [${Object.entries(b.props).map(([k,v]) => `${k}=${v}`).join(', ')}]`
        : '';
      console.log(`(${b.x}, ${b.y}, ${b.z}) dist=${b.dist.toFixed(2)}: ${b.block}${propsStr}`);
    }
  }
  
  // Check neighboring blocks in horizontal plane at Y=76 and Y=77
  console.log('\n=== Horizontal slice at Y=76 (user level) ===\n');
  
  for (let z = TARGET_Z - 2; z <= TARGET_Z + 2; z++) {
    let row = '';
    for (let x = TARGET_X - 2; x <= TARGET_X + 2; x++) {
      const block = getBlockAt(chunks, x, TARGET_Y, z);
      const shortName = block ? block.substring(0, 8).padEnd(8) : 'air     ';
      row += `[${shortName}]`;
    }
    console.log(`Z=${z}: ${row}`);
  }
  
  console.log('\n=== Horizontal slice at Y=77 ===\n');
  
  for (let z = TARGET_Z - 2; z <= TARGET_Z + 2; z++) {
    let row = '';
    for (let x = TARGET_X - 2; x <= TARGET_X + 2; x++) {
      const block = getBlockAt(chunks, x, TARGET_Y + 1, z);
      const shortName = block ? block.substring(0, 8).padEnd(8) : 'air     ';
      row += `[${shortName}]`;
    }
    console.log(`Z=${z}: ${row}`);
  }
  
  console.log('\n=== Horizontal slice at Y=78 ===\n');
  
  for (let z = TARGET_Z - 2; z <= TARGET_Z + 2; z++) {
    let row = '';
    for (let x = TARGET_X - 2; x <= TARGET_X + 2; x++) {
      const block = getBlockAt(chunks, x, TARGET_Y + 2, z);
      const shortName = block ? block.substring(0, 8).padEnd(8) : 'air     ';
      row += `[${shortName}]`;
    }
    console.log(`Z=${z}: ${row}`);
  }
}

function getBlockAt(chunks, wx, wy, wz) {
  const worldChunkX = Math.floor(wx / 16);
  const worldChunkZ = Math.floor(wz / 16);
  const localChunkX = worldChunkX + 32;
  const localChunkZ = worldChunkZ + 32;
  
  const chunk = chunks.find(c => c.x === localChunkX && c.z === localChunkZ);
  if (!chunk?.data?.sections) return null;
  
  const sectionY = Math.floor(wy / 16);
  const section = chunk.data.sections.find(s => s.Y === sectionY);
  if (!section?.block_states?.palette) return null;
  
  const palette = section.block_states.palette;
  const data = section.block_states.data;
  
  const localX = ((wx % 16) + 16) % 16;
  const localY = ((wy % 16) + 16) % 16;
  const localZ = ((wz % 16) + 16) % 16;
  
  const blockIndex = localY * 256 + localZ * 16 + localX;
  
  const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
  const blocksPerLong = Math.floor(64 / bitsPerBlock);
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  
  let paletteIndex = 0;
  if (data && data.length > 0) {
    const longIndex = Math.floor(blockIndex / blocksPerLong);
    const bitOffset = (blockIndex % blocksPerLong) * bitsPerBlock;
    
    if (longIndex < data.length) {
      let longValue = data[longIndex];
      if (typeof longValue !== 'bigint') longValue = BigInt(longValue);
      longValue = BigInt.asUintN(64, longValue);
      paletteIndex = Number((longValue >> BigInt(bitOffset)) & mask);
    }
  }
  
  if (paletteIndex >= palette.length) paletteIndex = 0;
  
  const blockState = palette[paletteIndex];
  const blockName = (blockState?.Name || 'air').replace('minecraft:', '');
  return blockName === 'air' ? null : blockName;
}

main().catch(console.error);


