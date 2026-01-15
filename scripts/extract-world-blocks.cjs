#!/usr/bin/env node
/**
 * Extract all blocks from a Minecraft world file to JSON
 * 
 * Usage: node scripts/extract-world-blocks.js <input.zip|input_folder> <output.json>
 * 
 * Example: node scripts/extract-world-blocks.js test/world_files/debug_world.zip test/fixtures/debug_world_blocks.json
 * 
 * Output format:
 * {
 *   "metadata": {
 *     "extractedAt": "2026-01-12T...",
 *     "source": "debug_world.zip",
 *     "totalBlocks": 12345,
 *     "uniqueBlockTypes": 789,
 *     "chunks": 32
 *   },
 *   "blocks": [
 *     {
 *       "x": 0, "y": 64, "z": 0,
 *       "block": "minecraft:stone",
 *       "properties": {}
 *     },
 *     {
 *       "x": 1, "y": 64, "z": 0,
 *       "block": "minecraft:oak_stairs",
 *       "properties": { "facing": "north", "half": "bottom", "shape": "straight", "waterlogged": "false" }
 *     }
 *   ],
 *   "blockEntities": [
 *     {
 *       "x": 5, "y": 64, "z": 10,
 *       "id": "minecraft:chest",
 *       "data": { ... }
 *     }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Check for command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node scripts/extract-world-blocks.cjs <input.zip|input_folder> <output.json> [--with-positions]');
  console.log('Example: node scripts/extract-world-blocks.cjs test/world_files/debug_world.zip test/fixtures/debug_world_blocks.json');
  console.log('');
  console.log('Options:');
  console.log('  --with-positions  Include all block positions (large output)');
  console.log('                    Without this flag, only unique block+properties combinations are output');
  process.exit(1);
}

const inputPath = args[0];
const outputPath = args[1];
const includePositions = args.includes('--with-positions');

// ============================================================================
// NBT Parser (simplified version for Node.js)
// ============================================================================

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

class NBTReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  readByte() {
    return this.view.getInt8(this.offset++);
  }

  readUByte() {
    return this.view.getUint8(this.offset++);
  }

  readShort() {
    const val = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return val;
  }

  readInt() {
    const val = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return val;
  }

  readLong() {
    const high = this.view.getInt32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return BigInt(high) * BigInt(0x100000000) + BigInt(low);
  }

  readFloat() {
    const val = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return val;
  }

  readDouble() {
    const val = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return val;
  }

  readString() {
    const length = this.readShort();
    if (length <= 0) return '';
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return new TextDecoder('utf-8').decode(bytes);
  }

  readTag(tagType) {
    switch (tagType) {
      case TAG_END:
        return null;
      case TAG_BYTE:
        return this.readByte();
      case TAG_SHORT:
        return this.readShort();
      case TAG_INT:
        return this.readInt();
      case TAG_LONG:
        return this.readLong();
      case TAG_FLOAT:
        return this.readFloat();
      case TAG_DOUBLE:
        return this.readDouble();
      case TAG_BYTE_ARRAY: {
        const length = this.readInt();
        const arr = new Int8Array(this.buffer, this.offset, length);
        this.offset += length;
        return Array.from(arr);
      }
      case TAG_STRING:
        return this.readString();
      case TAG_LIST: {
        const listType = this.readUByte();
        const length = this.readInt();
        const list = [];
        for (let i = 0; i < length; i++) {
          list.push(this.readTag(listType));
        }
        return list;
      }
      case TAG_COMPOUND: {
        const compound = {};
        while (true) {
          const type = this.readUByte();
          if (type === TAG_END) break;
          const name = this.readString();
          compound[name] = this.readTag(type);
        }
        return compound;
      }
      case TAG_INT_ARRAY: {
        const length = this.readInt();
        const arr = [];
        for (let i = 0; i < length; i++) {
          arr.push(this.readInt());
        }
        return arr;
      }
      case TAG_LONG_ARRAY: {
        const length = this.readInt();
        const arr = [];
        for (let i = 0; i < length; i++) {
          arr.push(this.readLong());
        }
        return arr;
      }
      default:
        throw new Error(`Unknown tag type: ${tagType}`);
    }
  }

  parse() {
    const rootType = this.readUByte();
    if (rootType !== TAG_COMPOUND) {
      throw new Error('Expected root compound tag');
    }
    const rootName = this.readString();
    const value = this.readTag(TAG_COMPOUND);
    return { name: rootName, value };
  }
}

function parseNBT(buffer) {
  const reader = new NBTReader(buffer);
  return reader.parse();
}

// ============================================================================
// MCA Parser
// ============================================================================

const SECTOR_SIZE = 4096;
const CHUNKS_PER_REGION = 32;

function parseMCABuffer(buffer) {
  const view = new DataView(buffer);
  const chunks = [];

  for (let z = 0; z < CHUNKS_PER_REGION; z++) {
    for (let x = 0; x < CHUNKS_PER_REGION; x++) {
      const index = x + z * CHUNKS_PER_REGION;
      const locationOffset = index * 4;

      const locationData = view.getUint32(locationOffset, false);
      const offset = (locationData >> 8) * SECTOR_SIZE;
      const sectorCount = locationData & 0xff;

      if (offset === 0 || sectorCount === 0) continue;

      try {
        const length = view.getUint32(offset, false);
        const compressionType = view.getUint8(offset + 4);

        const compressedData = Buffer.from(buffer, offset + 5, length - 1);

        let decompressedData;
        if (compressionType === 1) {
          // GZip
          decompressedData = zlib.gunzipSync(compressedData);
        } else if (compressionType === 2) {
          // Zlib
          decompressedData = zlib.inflateSync(compressedData);
        } else {
          console.warn(`Unknown compression type ${compressionType} for chunk ${x},${z}`);
          continue;
        }

        const nbt = parseNBT(decompressedData.buffer.slice(
          decompressedData.byteOffset,
          decompressedData.byteOffset + decompressedData.byteLength
        ));
        chunks.push({ x, z, data: nbt.value });
      } catch (e) {
        console.warn(`Failed to parse chunk ${x},${z}:`, e.message);
      }
    }
  }

  return chunks;
}

// ============================================================================
// Block Extraction
// ============================================================================

const AIR_BLOCKS = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'air'
]);

function unpackBlockIndices(data, bitsPerBlock, totalBlocks) {
  const indices = new Uint16Array(totalBlocks);
  const entriesPerLong = Math.floor(64 / bitsPerBlock);

  // Convert BigInt array to number array for processing
  const longValues = data.map(v => typeof v === 'bigint' ? v : BigInt(v));

  const mask = (1n << BigInt(bitsPerBlock)) - 1n;

  let i = 0;
  for (let longIndex = 0; longIndex < longValues.length && i < totalBlocks; longIndex++) {
    const longValue = BigInt.asUintN(64, longValues[longIndex]);

    for (let indexInLong = 0; indexInLong < entriesPerLong && i < totalBlocks; indexInLong++) {
      const bitOffset = BigInt(indexInLong * bitsPerBlock);
      indices[i++] = Number((longValue >> bitOffset) & mask);
    }
  }

  return indices;
}

function extractBlocksFromChunk(chunk, regionX, regionZ) {
  const blocks = [];
  const blockEntities = [];
  const data = chunk.data;
  const chunkX = chunk.x + regionX * 32;
  const chunkZ = chunk.z + regionZ * 32;

  // Extract block entities
  const beList = data.block_entities || data.TileEntities || [];
  for (const be of beList) {
    const beX = be.x ?? be.X ?? 0;
    const beY = be.y ?? be.Y ?? 0;
    const beZ = be.z ?? be.Z ?? 0;
    const beId = be.id ?? be.Id ?? 'unknown';

    blockEntities.push({
      x: beX,
      y: beY,
      z: beZ,
      id: beId,
      data: be
    });
  }

  // Try modern format (1.18+) with sections
  const sections = data.sections || (data.Level && data.Level.Sections);

  if (!sections) {
    return { blocks, blockEntities };
  }

  for (const section of sections) {
    const sectionY = section.Y !== undefined ? Number(section.Y) : 0;
    const baseY = sectionY * 16;

    // Skip sections outside reasonable range
    if (baseY < -64 || baseY >= 321) continue;

    // Modern format with block_states (1.18+)
    const blockStates = section.block_states;
    if (blockStates) {
      const palette = blockStates.palette;
      if (!palette || palette.length === 0) continue;

      const blockData = blockStates.data;

      // Process palette
      const paletteInfo = palette.map((entry) => {
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        const props = (typeof entry === 'object' && entry.Properties) ? { ...entry.Properties } : null;
        const isAir = AIR_BLOCKS.has(name) || name.endsWith(':air');
        return { name, properties: props, isAir };
      });

      // If there's only one block type in the section
      if (palette.length === 1 || !blockData || blockData.length === 0) {
        const info = paletteInfo[0];
        if (info.isAir) continue;

        for (let ly = 0; ly < 16; ly++) {
          const worldY = baseY + ly;
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              blocks.push({
                x: chunkX * 16 + lx,
                y: worldY,
                z: chunkZ * 16 + lz,
                block: info.name,
                properties: info.properties
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
        const worldY = baseY + ly;
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex++];

            if (paletteIndex < palette.length) {
              const info = paletteInfo[paletteIndex];
              if (!info.isAir) {
                blocks.push({
                  x: chunkX * 16 + lx,
                  y: worldY,
                  z: chunkZ * 16 + lz,
                  block: info.name,
                  properties: info.properties
                });
              }
            }
          }
        }
      }
    }
    // Legacy format with Palette and BlockStates (1.13-1.17)
    else if (section.Palette && section.BlockStates) {
      const palette = section.Palette;
      const blockData = section.BlockStates;

      if (palette.length === 0) continue;

      const paletteInfo = palette.map((entry) => {
        const name = typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air');
        const props = (typeof entry === 'object' && entry.Properties) ? { ...entry.Properties } : null;
        const isAir = AIR_BLOCKS.has(name) || name.endsWith(':air');
        return { name, properties: props, isAir };
      });

      if (palette.length === 1) {
        const info = paletteInfo[0];
        if (info.isAir) continue;

        for (let ly = 0; ly < 16; ly++) {
          const worldY = baseY + ly;
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              blocks.push({
                x: chunkX * 16 + lx,
                y: worldY,
                z: chunkZ * 16 + lz,
                block: info.name,
                properties: info.properties
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
        const worldY = baseY + ly;
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const paletteIndex = indices[blockIndex++];

            if (paletteIndex < palette.length) {
              const info = paletteInfo[paletteIndex];
              if (!info.isAir) {
                blocks.push({
                  x: chunkX * 16 + lx,
                  y: worldY,
                  z: chunkZ * 16 + lz,
                  block: info.name,
                  properties: info.properties
                });
              }
            }
          }
        }
      }
    }
  }

  return { blocks, blockEntities };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`Extracting blocks from: ${inputPath}`);
  console.log(`Output: ${outputPath}`);

  let regionFiles = [];

  // Check if input is a zip file or folder
  const stats = fs.statSync(inputPath);
  if (stats.isDirectory()) {
    // Look for region folder
    const regionPath = path.join(inputPath, 'region');
    if (fs.existsSync(regionPath)) {
      regionFiles = fs.readdirSync(regionPath)
        .filter(f => f.endsWith('.mca'))
        .map(f => ({ name: f, buffer: fs.readFileSync(path.join(regionPath, f)) }));
    } else {
      // Look for .mca files directly in the folder
      regionFiles = fs.readdirSync(inputPath)
        .filter(f => f.endsWith('.mca'))
        .map(f => ({ name: f, buffer: fs.readFileSync(path.join(inputPath, f)) }));
    }
  } else if (inputPath.endsWith('.zip')) {
    // Use built-in unzip (requires Node.js with zlib)
    // For simplicity, we'll extract to a temp folder
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(inputPath);
    const entries = zip.getEntries();

    for (const entry of entries) {
      if (entry.entryName.endsWith('.mca')) {
        regionFiles.push({
          name: path.basename(entry.entryName),
          buffer: entry.getData()
        });
      }
    }
  } else if (inputPath.endsWith('.mca')) {
    // Single .mca file
    regionFiles.push({
      name: path.basename(inputPath),
      buffer: fs.readFileSync(inputPath)
    });
  } else {
    console.error('Input must be a .zip file, .mca file, or folder containing region files');
    process.exit(1);
  }

  if (regionFiles.length === 0) {
    console.error('No region files found');
    process.exit(1);
  }

  console.log(`Found ${regionFiles.length} region file(s)`);

  const allBlocks = [];
  const allBlockEntities = [];
  let totalChunks = 0;

  for (const regionFile of regionFiles) {
    console.log(`Processing: ${regionFile.name}`);

    // Parse region coordinates from filename (r.X.Z.mca)
    const match = regionFile.name.match(/r\.(-?\d+)\.(-?\d+)\.mca/);
    const regionX = match ? parseInt(match[1], 10) : 0;
    const regionZ = match ? parseInt(match[2], 10) : 0;

    // Convert Buffer to ArrayBuffer
    const arrayBuffer = regionFile.buffer.buffer.slice(
      regionFile.buffer.byteOffset,
      regionFile.buffer.byteOffset + regionFile.buffer.byteLength
    );

    const chunks = parseMCABuffer(arrayBuffer);
    console.log(`  Parsed ${chunks.length} chunks`);
    totalChunks += chunks.length;

    for (const chunk of chunks) {
      const { blocks, blockEntities } = extractBlocksFromChunk(chunk, regionX, regionZ);
      allBlocks.push(...blocks);
      allBlockEntities.push(...blockEntities);
    }
  }

  // Count unique block types
  const uniqueBlockTypes = new Set(allBlocks.map(b => b.block));

  // Deduplicate blocks by (block, properties) pair
  let outputBlocks;
  if (includePositions) {
    // Keep all blocks with positions
    outputBlocks = allBlocks;
  } else {
    // Create unique entries based on block + properties, with a sample position
    const uniqueMap = new Map();
    
    for (const block of allBlocks) {
      // Create a unique key from block name and sorted properties
      const propsKey = block.properties 
        ? Object.keys(block.properties).sort().map(k => `${k}=${block.properties[k]}`).join(',')
        : '';
      const key = `${block.block}|${propsKey}`;
      
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, {
          block: block.block,
          properties: block.properties,
          x: block.x,
          y: block.y,
          z: block.z
        });
      }
    }
    
    // Convert map to array sorted by block name then properties
    outputBlocks = Array.from(uniqueMap.values()).sort((a, b) => {
      if (a.block !== b.block) return a.block.localeCompare(b.block);
      const aProps = JSON.stringify(a.properties || {});
      const bProps = JSON.stringify(b.properties || {});
      return aProps.localeCompare(bProps);
    });
    
    console.log(`  Deduplicated to ${outputBlocks.length} unique block+properties combinations`);
  }

  // Build output
  const output = {
    metadata: {
      extractedAt: new Date().toISOString(),
      source: path.basename(inputPath),
      totalBlocks: allBlocks.length,
      uniqueBlockTypes: uniqueBlockTypes.size,
      uniqueBlockStates: includePositions ? null : outputBlocks.length,
      chunks: totalChunks,
      regions: regionFiles.length,
      includesPositions: includePositions
    },
    blocks: outputBlocks,
    blockEntities: allBlockEntities
  };

  // Write output
  fs.writeFileSync(outputPath, JSON.stringify(output, (key, value) => {
    // Convert BigInt to string for JSON serialization
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }, 2));

  console.log(`\nExtraction complete!`);
  console.log(`  Total blocks: ${allBlocks.length.toLocaleString()}`);
  console.log(`  Unique block types: ${uniqueBlockTypes.size}`);
  if (!includePositions) {
    console.log(`  Unique block+properties: ${outputBlocks.length}`);
  }
  console.log(`  Block entities: ${allBlockEntities.length}`);
  console.log(`  Output written to: ${outputPath}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
