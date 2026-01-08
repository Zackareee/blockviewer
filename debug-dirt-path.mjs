/**
 * Debug: Check how dirt_path is categorized and rendered
 */

// Mock browser environment
global.performance = { now: () => Date.now() };

import { parseMCAFromPath } from './test/helpers/nodeMcaParser.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Parse the region file to find dirt_path blocks
  const regionPath = path.join(__dirname, 'test-regions', 'r.-1.-1.mca');
  const chunks = await parseMCAFromPath(regionPath);
  
  console.log('=== Looking for dirt_path blocks ===\n');
  
  const dirtPathBlocks = [];
  
  for (const chunk of chunks) {
    const sections = chunk.data?.sections;
    if (!sections) continue;
    
    const chunkBaseX = (chunk.x - 32) * 16;
    const chunkBaseZ = (chunk.z - 32) * 16;
    
    for (const section of sections) {
      const sectionY = section.Y;
      if (sectionY === undefined) continue;
      
      const sectionMinY = sectionY * 16;
      const blockStates = section.block_states;
      if (!blockStates?.palette) continue;
      
      const palette = blockStates.palette;
      const data = blockStates.data;
      
      // Find dirt_path in palette
      const dirtPathIndex = palette.findIndex(p => 
        p?.Name === 'minecraft:dirt_path' || p?.Name === 'dirt_path'
      );
      
      if (dirtPathIndex === -1) continue;
      
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const blocksPerLong = Math.floor(64 / bitsPerBlock);
      const mask = (1n << BigInt(bitsPerBlock)) - 1n;
      
      for (let i = 0; i < 4096; i++) {
        let paletteIdx = 0;
        if (data && data.length > 0) {
          const longIndex = Math.floor(i / blocksPerLong);
          const bitOffset = (i % blocksPerLong) * bitsPerBlock;
          
          if (longIndex < data.length) {
            let longValue = data[longIndex];
            if (typeof longValue !== 'bigint') longValue = BigInt(longValue);
            longValue = BigInt.asUintN(64, longValue);
            paletteIdx = Number((longValue >> BigInt(bitOffset)) & mask);
          }
        }
        
        if (paletteIdx === dirtPathIndex) {
          const localX = i & 15;
          const localZ = (i >> 4) & 15;
          const localY = i >> 8;
          
          dirtPathBlocks.push({
            x: chunkBaseX + localX,
            y: sectionMinY + localY,
            z: chunkBaseZ + localZ
          });
        }
      }
    }
  }
  
  console.log(`Found ${dirtPathBlocks.length} dirt_path blocks total`);
  
  if (dirtPathBlocks.length > 0) {
    console.log('\nFirst 20 dirt_path blocks:');
    for (let i = 0; i < Math.min(20, dirtPathBlocks.length); i++) {
      const b = dirtPathBlocks[i];
      console.log(`  (${b.x}, ${b.y}, ${b.z})`);
    }
    
    // Check the model
    const fs = await import('fs');
    const modelPath = path.join(__dirname, 'textures/1.21.11+Template/assets/minecraft/models/block/dirt_path.json');
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
    
    console.log('\n=== dirt_path model ===');
    console.log(`Elements: ${model.elements?.length || 0}`);
    if (model.elements) {
      for (const el of model.elements) {
        console.log(`  from: [${el.from.join(', ')}] to: [${el.to.join(', ')}]`);
        console.log(`  Faces: ${Object.keys(el.faces).join(', ')}`);
        for (const [face, faceData] of Object.entries(el.faces)) {
          console.log(`    ${face}: cullface=${faceData.cullface || 'none'}`);
        }
      }
    }
    
    // Check blockstate
    const blockstatePath = path.join(__dirname, 'textures/1.21.11+Template/assets/minecraft/blockstates/dirt_path.json');
    const blockstate = JSON.parse(fs.readFileSync(blockstatePath, 'utf-8'));
    console.log('\n=== dirt_path blockstate ===');
    console.log(JSON.stringify(blockstate, null, 2));
  }
}

main().catch(console.error);




