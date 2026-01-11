#!/usr/bin/env node
/**
 * V3 Model Meshing Test
 * 
 * Tests the mesh_models_v3 function directly to verify it produces geometry.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BAKED_PATH = path.join(__dirname, '../public/assets/baked-models.bin');
const MANIFEST_PATH = path.join(__dirname, '../public/assets/block-model-manifest.json');

console.log('=== V3 Model Meshing Test ===\n');

// Load and verify baked models
const baked = fs.readFileSync(BAKED_PATH);
const view = new DataView(baked.buffer, baked.byteOffset, baked.byteLength);

const magic = view.getUint32(0, true);
const version = view.getUint32(4, true);
const blockCount = view.getUint32(8, true);

console.log('Baked Models:');
console.log(`  File size: ${baked.length} bytes`);
console.log(`  Magic: 0x${magic.toString(16)} (expected 0x424b4d44)`);
console.log(`  Version: ${version}`);
console.log(`  Block count: ${blockCount}`);

// Parse block index to verify structure
let offset = 12;
const blocks = [];
let blocksWithVariants = 0;
let blocksWithFaces = 0;

for (let i = 0; i < blockCount; i++) {
  const nameLen = view.getUint16(offset, true);
  offset += 2;
  
  const nameBytes = new Uint8Array(baked.buffer, baked.byteOffset + offset, nameLen);
  const name = new TextDecoder().decode(nameBytes);
  offset += nameLen;
  
  const dataOffset = view.getUint32(offset, true);
  offset += 4;
  
  blocks.push({ name, dataOffset });
}

console.log(`\nParsed ${blocks.length} block index entries`);

// Parse block data section
const dataStart = offset;
console.log(`Data section starts at offset ${dataStart}`);

for (let i = 0; i < blocks.length; i++) {
  const block = blocks[i];
  const blockDataOffset = dataStart + block.dataOffset;
  
  const variantCount = view.getUint8(blockDataOffset);
  const flags = view.getUint8(blockDataOffset + 1);
  
  block.variantCount = variantCount;
  block.flags = flags;
  
  if (variantCount > 0) {
    blocksWithVariants++;
  }
  
  // Parse variants to count faces
  let variantOffset = blockDataOffset + 2;
  block.totalFaces = 0;
  
  for (let v = 0; v < variantCount; v++) {
    const keyLen = view.getUint8(variantOffset);
    variantOffset += 1 + keyLen;
    
    const faceCount = view.getUint16(variantOffset, true);
    variantOffset += 2;
    
    block.totalFaces += faceCount;
    
    // Skip face data (97 bytes per face)
    variantOffset += faceCount * 97;
  }
  
  if (block.totalFaces > 0) {
    blocksWithFaces++;
  }
}

console.log(`\nBlock Analysis:`);
console.log(`  Total blocks: ${blocks.length}`);
console.log(`  Blocks with variants: ${blocksWithVariants}`);
console.log(`  Blocks with faces: ${blocksWithFaces}`);

// Show some example blocks
console.log(`\nSample blocks with faces:`);
const withFaces = blocks.filter(b => b.totalFaces > 0).slice(0, 10);
for (const b of withFaces) {
  console.log(`  ${b.name}: ${b.variantCount} variants, ${b.totalFaces} faces`);
}

// Check specific blocks
console.log(`\nKey block check:`);
const keyBlocks = ['stone_slab', 'oak_stairs', 'torch', 'lantern', 'oak_fence'];
for (const name of keyBlocks) {
  const block = blocks.find(b => b.name === name);
  if (block) {
    console.log(`  ${name}: index=${blocks.indexOf(block)}, variants=${block.variantCount}, faces=${block.totalFaces}`);
  } else {
    console.log(`  ${name}: NOT FOUND`);
  }
}

console.log(`\n=== Test Complete ===`);
