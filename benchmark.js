/**
 * Region Loading Benchmark
 * 
 * Tests the performance of loading and processing a Minecraft region file.
 * Run with: node benchmark.js
 */

import { readFileSync } from 'fs';
import { inflateSync, gunzipSync } from 'zlib';

const SECTOR_SIZE = 4096;
const CHUNKS_PER_REGION = 32;

// Simple NBT parser (subset needed for benchmarking)
function parseNBT(buffer, offset = 0) {
  const view = new DataView(buffer);
  
  function readString(pos) {
    const length = view.getUint16(pos, false);
    const bytes = new Uint8Array(buffer, pos + 2, length);
    return { value: new TextDecoder().decode(bytes), bytesRead: 2 + length };
  }
  
  function readTag(pos, tagType) {
    switch (tagType) {
      case 0: return { value: null, bytesRead: 0 }; // TAG_End
      case 1: return { value: view.getInt8(pos), bytesRead: 1 }; // TAG_Byte
      case 2: return { value: view.getInt16(pos, false), bytesRead: 2 }; // TAG_Short
      case 3: return { value: view.getInt32(pos, false), bytesRead: 4 }; // TAG_Int
      case 4: { // TAG_Long
        const high = view.getInt32(pos, false);
        const low = view.getUint32(pos + 4, false);
        return { value: BigInt(high) << 32n | BigInt(low), bytesRead: 8 };
      }
      case 5: return { value: view.getFloat32(pos, false), bytesRead: 4 }; // TAG_Float
      case 6: return { value: view.getFloat64(pos, false), bytesRead: 8 }; // TAG_Double
      case 7: { // TAG_Byte_Array
        const length = view.getInt32(pos, false);
        return { value: new Int8Array(buffer, pos + 4, length), bytesRead: 4 + length };
      }
      case 8: return readString(pos); // TAG_String
      case 9: { // TAG_List
        const listType = view.getInt8(pos);
        const length = view.getInt32(pos + 1, false);
        const items = [];
        let bytesRead = 5;
        for (let i = 0; i < length; i++) {
          const item = readTag(pos + bytesRead, listType);
          items.push(item.value);
          bytesRead += item.bytesRead;
        }
        return { value: items, bytesRead };
      }
      case 10: { // TAG_Compound
        const result = {};
        let bytesRead = 0;
        while (true) {
          const childType = view.getInt8(pos + bytesRead);
          bytesRead += 1;
          if (childType === 0) break; // TAG_End
          const name = readString(pos + bytesRead);
          bytesRead += name.bytesRead;
          const value = readTag(pos + bytesRead, childType);
          result[name.value] = value.value;
          bytesRead += value.bytesRead;
        }
        return { value: result, bytesRead };
      }
      case 11: { // TAG_Int_Array
        const length = view.getInt32(pos, false);
        const arr = new Int32Array(length);
        for (let i = 0; i < length; i++) {
          arr[i] = view.getInt32(pos + 4 + i * 4, false);
        }
        return { value: arr, bytesRead: 4 + length * 4 };
      }
      case 12: { // TAG_Long_Array
        const length = view.getInt32(pos, false);
        const arr = new Array(length);
        for (let i = 0; i < length; i++) {
          const high = view.getInt32(pos + 4 + i * 8, false);
          const low = view.getUint32(pos + 4 + i * 8 + 4, false);
          arr[i] = BigInt(high) << 32n | BigInt(low);
        }
        return { value: arr, bytesRead: 4 + length * 8 };
      }
      default:
        throw new Error(`Unknown tag type: ${tagType}`);
    }
  }
  
  const rootType = view.getInt8(offset);
  if (rootType !== 10) throw new Error('Expected compound root');
  const name = readString(offset + 1);
  const value = readTag(offset + 1 + name.bytesRead, 10);
  return { name: name.value, value: value.value };
}

// Parse MCA file
function parseMCABuffer(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const chunks = [];

  for (let z = 0; z < CHUNKS_PER_REGION; z++) {
    for (let x = 0; x < CHUNKS_PER_REGION; x++) {
      const index = x + z * CHUNKS_PER_REGION;
      const locationOffset = index * 4;
      
      const locationData = view.getUint32(locationOffset, false);
      const offset = (locationData >> 8) * SECTOR_SIZE;
      const sectorCount = locationData & 0xFF;

      if (offset === 0 || sectorCount === 0) continue;

      try {
        const length = view.getUint32(offset, false);
        const compressionType = view.getUint8(offset + 4);
        
        const compressedData = buffer.subarray(offset + 5, offset + 5 + length - 1);
        
        let decompressedData;
        if (compressionType === 1) {
          decompressedData = gunzipSync(compressedData);
        } else if (compressionType === 2) {
          decompressedData = inflateSync(compressedData);
        } else {
          continue;
        }

        const nbt = parseNBT(decompressedData.buffer);
        chunks.push({ x, z, data: nbt.value });
      } catch (e) {
        // Skip failed chunks
      }
    }
  }

  return chunks;
}

// Count blocks in chunks (simulates extraction)
function countBlocks(chunks) {
  let totalBlocks = 0;
  let airBlocks = 0;
  
  for (const chunk of chunks) {
    const sections = chunk.data?.sections || [];
    for (const section of sections) {
      const blockStates = section?.block_states;
      if (!blockStates) continue;
      
      const palette = blockStates.palette || [];
      const data = blockStates.data;
      
      if (palette.length === 1) {
        // Uniform section
        const blockName = palette[0]?.Name || '';
        if (blockName.includes('air')) {
          airBlocks += 4096;
        } else {
          totalBlocks += 4096;
        }
      } else if (data) {
        // Mixed section - count based on palette
        for (const entry of palette) {
          const name = entry?.Name || '';
          if (!name.includes('air')) {
            totalBlocks += 1; // Approximate - at least one of this type
          }
        }
      }
    }
  }
  
  return { totalBlocks, airBlocks };
}

// Run benchmark
async function runBenchmark() {
  const regionPath = './test-regions/r.-1.0.mca';
  
  console.log('='.repeat(60));
  console.log('Region Loading Benchmark');
  console.log('='.repeat(60));
  console.log(`\nRegion file: ${regionPath}\n`);
  
  // Warmup
  console.log('Warming up...');
  const warmupBuffer = readFileSync(regionPath);
  for (let i = 0; i < 3; i++) {
    parseMCABuffer(warmupBuffer);
  }
  
  // Benchmark file reading
  console.log('\n--- File Reading ---');
  const readIterations = 10;
  const readTimes = [];
  
  for (let i = 0; i < readIterations; i++) {
    const start = performance.now();
    const buffer = readFileSync(regionPath);
    const elapsed = performance.now() - start;
    readTimes.push(elapsed);
  }
  
  const avgRead = readTimes.reduce((a, b) => a + b, 0) / readTimes.length;
  console.log(`  File size: ${(warmupBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Avg read time: ${avgRead.toFixed(2)}ms`);
  
  // Benchmark parsing
  console.log('\n--- NBT Parsing (decompression + parse) ---');
  const parseIterations = 5;
  const parseTimes = [];
  let lastChunks = null;
  
  for (let i = 0; i < parseIterations; i++) {
    const buffer = readFileSync(regionPath);
    const start = performance.now();
    lastChunks = parseMCABuffer(buffer);
    const elapsed = performance.now() - start;
    parseTimes.push(elapsed);
  }
  
  const avgParse = parseTimes.reduce((a, b) => a + b, 0) / parseTimes.length;
  console.log(`  Chunks parsed: ${lastChunks.length}`);
  console.log(`  Avg parse time: ${avgParse.toFixed(2)}ms`);
  console.log(`  Parse rate: ${(lastChunks.length / (avgParse / 1000)).toFixed(0)} chunks/sec`);
  
  // Block counting
  console.log('\n--- Block Extraction (simulated) ---');
  const extractStart = performance.now();
  const { totalBlocks, airBlocks } = countBlocks(lastChunks);
  const extractTime = performance.now() - extractStart;
  console.log(`  Solid blocks (approx): ${totalBlocks.toLocaleString()}`);
  console.log(`  Air blocks (approx): ${airBlocks.toLocaleString()}`);
  console.log(`  Count time: ${extractTime.toFixed(2)}ms`);
  
  // Summary
  console.log('\n--- Summary ---');
  const totalTime = avgRead + avgParse;
  console.log(`  Total time (read + parse): ${totalTime.toFixed(2)}ms`);
  console.log(`  Estimated full region time: ${(totalTime * 1.5).toFixed(2)}ms (with mesh building)`);
  
  console.log('\n' + '='.repeat(60));
  console.log('Benchmark complete');
  console.log('='.repeat(60));
}

runBenchmark().catch(console.error);

