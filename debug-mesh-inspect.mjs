/**
 * Debug script to inspect meshes generated at a specific location
 * Analyzes what triangles exist near a coordinate to identify visual artifacts
 */
import { parseMCAFromPath } from './test/helpers/nodeMcaParser.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Target coordinates (from user) - adjusted to integer
const TARGET_X = -236;
const TARGET_Y = 76;
const TARGET_Z = -213;
const INSPECT_RADIUS = 3; // Check within 3 blocks

async function main() {
  const regionPath = path.join(__dirname, 'test-regions', 'r.-1.-1.mca');
  
  console.log(`\n=== Mesh Inspection at (${TARGET_X}, ${TARGET_Y}, ${TARGET_Z}) ===\n`);
  
  // Parse the region
  const chunks = await parseMCAFromPath(regionPath);
  
  // Calculate which chunk contains our target
  const worldChunkX = Math.floor(TARGET_X / 16);
  const worldChunkZ = Math.floor(TARGET_Z / 16);
  const localChunkX = worldChunkX + 32;
  const localChunkZ = worldChunkZ + 32;
  
  console.log(`Looking in chunk (local: ${localChunkX}, ${localChunkZ})`);
  
  // Find the target chunk
  const targetChunk = chunks.find(c => c.x === localChunkX && c.z === localChunkZ);
  if (!targetChunk) {
    console.log('Chunk not found!');
    return;
  }
  
  const sections = targetChunk.data?.sections;
  if (!sections) {
    console.log('No sections in chunk!');
    return;
  }
  
  // Look for sections containing our Y coordinate
  const targetSectionY = Math.floor(TARGET_Y / 16);
  
  // Analyze nearby blocks to see what might cause artifacts
  console.log('\n=== Analysis of potential artifact sources ===\n');
  
  // Blocks with very thin/small geometry elements
  const potentialArtifactSources = [];
  
  for (const section of sections) {
    const sectionY = section.Y;
    if (sectionY === undefined) continue;
    if (Math.abs(sectionY - targetSectionY) > 1) continue;
    
    const sectionMinY = sectionY * 16;
    const blockStates = section.block_states;
    if (!blockStates?.palette) continue;
    
    const palette = blockStates.palette;
    const data = blockStates.data;
    
    const worldChunkBaseX = (localChunkX - 32) * 16;
    const worldChunkBaseZ = (localChunkZ - 32) * 16;
    
    const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const blocksPerLong = Math.floor(64 / bitsPerBlock);
    const mask = (1n << BigInt(bitsPerBlock)) - 1n;
    
    for (let localY = 0; localY < 16; localY++) {
      const worldY = sectionMinY + localY;
      if (Math.abs(worldY - TARGET_Y) > INSPECT_RADIUS) continue;
      
      for (let localZ = 0; localZ < 16; localZ++) {
        const actualWorldZ = worldChunkBaseZ + localZ;
        if (Math.abs(actualWorldZ - TARGET_Z) > INSPECT_RADIUS) continue;
        
        for (let localX = 0; localX < 16; localX++) {
          const actualWorldX = worldChunkBaseX + localX;
          if (Math.abs(actualWorldX - TARGET_X) > INSPECT_RADIUS) continue;
          
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
          const blockName = blockState?.Name || 'unknown';
          
          if (blockName === 'minecraft:air' || blockName === 'air') continue;
          
          const props = blockState?.Properties || {};
          const name = blockName.replace('minecraft:', '');
          
          // Check for blocks that could produce very thin geometry
          const isThinGeometry = 
            name.includes('banner') ||
            name.includes('sign') ||
            name.includes('candle') ||
            name.includes('torch') ||
            name.includes('chain') ||
            name.includes('rod') ||
            name.includes('pickle') ||
            name.includes('carpet') ||
            name.includes('rail') ||
            name.includes('vine') ||
            name.includes('roots');
          
          const distance = Math.sqrt(
            Math.pow(actualWorldX - TARGET_X, 2) +
            Math.pow(worldY - TARGET_Y, 2) +
            Math.pow(actualWorldZ - TARGET_Z, 2)
          );
          
          potentialArtifactSources.push({
            x: actualWorldX,
            y: worldY,
            z: actualWorldZ,
            block: name,
            properties: props,
            distance,
            isThin: isThinGeometry
          });
        }
      }
    }
  }
  
  // Sort by distance
  potentialArtifactSources.sort((a, b) => a.distance - b.distance);
  
  console.log(`Found ${potentialArtifactSources.length} blocks within ${INSPECT_RADIUS} blocks:`);
  console.log('');
  
  // Print blocks with emphasis on thin geometry ones
  for (const block of potentialArtifactSources) {
    const props = Object.keys(block.properties).length > 0 
      ? ` [${Object.entries(block.properties).map(([k,v]) => `${k}=${v}`).join(', ')}]` 
      : '';
    const thinMarker = block.isThin ? ' *** THIN GEOMETRY ***' : '';
    console.log(`(${block.x}, ${block.y}, ${block.z}) dist=${block.distance.toFixed(2)}: ${block.block}${props}${thinMarker}`);
  }
  
  // Look for specific artifact-prone patterns
  console.log('\n=== Blocks with thin/small geometry ===\n');
  const thinBlocks = potentialArtifactSources.filter(b => b.isThin);
  if (thinBlocks.length === 0) {
    console.log('No thin geometry blocks found nearby');
  } else {
    for (const block of thinBlocks) {
      const props = Object.keys(block.properties).length > 0 
        ? ` [${Object.entries(block.properties).map(([k,v]) => `${k}=${v}`).join(', ')}]` 
        : '';
      console.log(`(${block.x}, ${block.y}, ${block.z}): ${block.block}${props}`);
    }
  }
  
  // Check for banners specifically since user saw the X pattern
  console.log('\n=== Banner blocks (have flat X-shape geometry) ===\n');
  const bannerBlocks = potentialArtifactSources.filter(b => b.block.includes('banner'));
  if (bannerBlocks.length === 0) {
    console.log('No banners found nearby');
  } else {
    console.log('BANNERS FOUND - these have a thin pole + flat banner panel');
    for (const block of bannerBlocks) {
      const props = Object.entries(block.properties).map(([k,v]) => `${k}=${v}`).join(', ');
      console.log(`(${block.x}, ${block.y}, ${block.z}): ${block.block} [${props}]`);
    }
  }
  
  // Print section around the exact target coordinate
  console.log('\n=== 3x3x3 cube centered on target ===\n');
  const nearbyBlocks = potentialArtifactSources.filter(b => 
    Math.abs(b.x - TARGET_X) <= 1 && 
    Math.abs(b.y - TARGET_Y) <= 1 && 
    Math.abs(b.z - TARGET_Z) <= 1
  );
  
  if (nearbyBlocks.length === 0) {
    console.log('No non-air blocks in immediate vicinity (all air?)');
  } else {
    for (let y = TARGET_Y + 1; y >= TARGET_Y - 1; y--) {
      console.log(`Y=${y}:`);
      for (let z = TARGET_Z - 1; z <= TARGET_Z + 1; z++) {
        let row = '';
        for (let x = TARGET_X - 1; x <= TARGET_X + 1; x++) {
          const block = nearbyBlocks.find(b => b.x === x && b.y === y && b.z === z);
          if (block) {
            const shortName = block.block.substring(0, 15).padEnd(15);
            row += `[${shortName}]`;
          } else {
            row += '[     air       ]';
          }
        }
        console.log(`  Z=${z}: ${row}`);
      }
      console.log('');
    }
  }
}

main().catch(console.error);



