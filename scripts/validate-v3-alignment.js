#!/usr/bin/env node
/**
 * V3 Block Index Alignment Validator
 * 
 * Compares block indices between:
 * 1. ModelStateLookup (from manifest - assigns index to ALL blocks)
 * 2. BlockModelRegistry (from baked binary - only has blocks with geometry)
 * 
 * If these don't match, V3 model meshing will fail silently.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MANIFEST_PATH = path.join(__dirname, '../public/assets/block-model-manifest.json');
const BAKED_PATH = path.join(__dirname, '../public/assets/baked-models.bin');

console.log('=== V3 Block Index Alignment Validator ===\n');

// Load manifest
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const manifestBlocks = Object.keys(manifest.blocks);
console.log(`Manifest has ${manifestBlocks.length} blocks`);

// Read baked binary
const baked = fs.readFileSync(BAKED_PATH);
const view = new DataView(baked.buffer, baked.byteOffset, baked.byteLength);

// Parse header
let offset = 0;
const magic = view.getUint32(offset, true); offset += 4;
const version = view.getUint32(offset, true); offset += 4;
const blockCount = view.getUint32(offset, true); offset += 4;

console.log(`Baked binary: magic=0x${magic.toString(16)}, version=${version}, blocks=${blockCount}`);

if (magic !== 0x424B4D44) {
  console.error('ERROR: Invalid magic number!');
  process.exit(1);
}

// Parse block index
const bakedBlocks = [];
for (let i = 0; i < blockCount; i++) {
  const nameLen = view.getUint16(offset, true); offset += 2;
  const nameBytes = new Uint8Array(baked.buffer, baked.byteOffset + offset, nameLen);
  const name = new TextDecoder().decode(nameBytes);
  offset += nameLen;
  
  const dataOffset = view.getUint32(offset, true); offset += 4;
  
  bakedBlocks.push({ name, dataOffset });
}

console.log(`Parsed ${bakedBlocks.length} blocks from binary\n`);

// Compare
console.log('=== Block Count Comparison ===');
console.log(`  Manifest blocks: ${manifestBlocks.length}`);
console.log(`  Baked blocks: ${bakedBlocks.length}`);

if (manifestBlocks.length !== bakedBlocks.length) {
  console.log('\n⚠️  MISMATCH: Different block counts!');
  console.log('   This is the ROOT CAUSE of V3 failure!');
  console.log('   ModelStateLookup assigns indices 0..N for all manifest blocks,');
  console.log('   but baked binary only has blocks with valid geometry.\n');
}

// Build sets for analysis
const manifestSet = new Set(manifestBlocks);
const bakedSet = new Set(bakedBlocks.map(b => b.name));

const inManifestNotBaked = manifestBlocks.filter(b => !bakedSet.has(b));
const inBakedNotManifest = bakedBlocks.filter(b => !manifestSet.has(b.name));

if (inManifestNotBaked.length > 0) {
  console.log(`\n=== Blocks in MANIFEST but not in BAKED (${inManifestNotBaked.length}) ===`);
  for (const block of inManifestNotBaked.slice(0, 20)) {
    console.log(`  - ${block}`);
  }
  if (inManifestNotBaked.length > 20) {
    console.log(`  ... and ${inManifestNotBaked.length - 20} more`);
  }
}

if (inBakedNotManifest.length > 0) {
  console.log(`\n=== Blocks in BAKED but not in MANIFEST (${inBakedNotManifest.length}) ===`);
  for (const block of inBakedNotManifest.slice(0, 20)) {
    console.log(`  - ${block.name}`);
  }
}

// Check index alignment
console.log('\n=== Index Alignment Check ===');
let misalignments = 0;
const maxCheck = Math.min(manifestBlocks.length, bakedBlocks.length);

for (let i = 0; i < maxCheck; i++) {
  if (manifestBlocks[i] !== bakedBlocks[i].name) {
    if (misalignments < 10) {
      console.log(`  Index ${i}: manifest="${manifestBlocks[i]}" vs baked="${bakedBlocks[i].name}"`);
    }
    misalignments++;
  }
}

if (misalignments > 0) {
  console.log(`\n❌ FOUND ${misalignments} misaligned indices!`);
  console.log('   This means ModelStateLookup and BlockModelRegistry disagree on block indices.');
  console.log('   When a worker looks up block 5, WASM will return geometry for a different block!\n');
} else if (manifestBlocks.length === bakedBlocks.length) {
  console.log('✅ All indices are aligned!');
} else {
  console.log('⚠️  Different block counts means indices are implicitly misaligned');
}

// Simulate what happens at runtime
console.log('\n=== Simulating Runtime Lookup ===');
console.log('Testing a few common model blocks:\n');

const testBlocks = ['stone_slab', 'oak_stairs', 'oak_fence', 'torch', 'lantern', 'chest'];

for (const testBlock of testBlocks) {
  const manifestIndex = manifestBlocks.indexOf(testBlock);
  const bakedIndex = bakedBlocks.findIndex(b => b.name === testBlock);
  
  if (manifestIndex === -1) {
    console.log(`  ${testBlock}: NOT in manifest`);
  } else if (bakedIndex === -1) {
    console.log(`  ${testBlock}: manifest[${manifestIndex}], NOT in baked`);
  } else if (manifestIndex === bakedIndex) {
    console.log(`  ${testBlock}: ✅ manifest[${manifestIndex}] == baked[${bakedIndex}]`);
  } else {
    console.log(`  ${testBlock}: ❌ manifest[${manifestIndex}] != baked[${bakedIndex}]`);
    console.log(`    → When looking up ${testBlock}, WASM returns: ${bakedBlocks[manifestIndex]?.name || 'NOTHING'}`);
  }
}

console.log('\n=== Recommendations ===');
if (manifestBlocks.length !== bakedBlocks.length || misalignments > 0) {
  console.log('1. Modify bake-model-geometry.js to include ALL manifest blocks, even with 0 variants');
  console.log('2. OR modify ModelStateLookup to only include blocks that exist in baked binary');
  console.log('3. The first option is simpler - just don\'t skip empty blocks in the baking script');
}
