/**
 * Extract all unique block types from debug_world
 * 
 * Usage: node scripts/extractBlocks.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pako from 'pako';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECTOR_SIZE = 4096;
const CHUNKS_PER_REGION = 32;

// NBT Tag Types
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
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readShort() {
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  readInt() {
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  readLong() {
    const high = this.view.getInt32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return BigInt(high) * BigInt(0x100000000) + BigInt(low);
  }

  readFloat() {
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  readDouble() {
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  readString() {
    const length = this.readShort();
    if (length <= 0) return '';
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return new TextDecoder('utf-8').decode(bytes);
  }

  readByteArray() {
    const length = this.readInt();
    const array = new Int8Array(this.buffer, this.offset, length);
    this.offset += length;
    return Array.from(array);
  }

  readIntArray() {
    const length = this.readInt();
    const array = [];
    for (let i = 0; i < length; i++) {
      array.push(this.readInt());
    }
    return array;
  }

  readLongArray() {
    const length = this.readInt();
    const array = [];
    for (let i = 0; i < length; i++) {
      array.push(this.readLong());
    }
    return array;
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
      case TAG_BYTE_ARRAY:
        return this.readByteArray();
      case TAG_STRING:
        return this.readString();
      case TAG_LIST:
        return this.readList();
      case TAG_COMPOUND:
        return this.readCompound();
      case TAG_INT_ARRAY:
        return this.readIntArray();
      case TAG_LONG_ARRAY:
        return this.readLongArray();
      default:
        throw new Error(`Unknown tag type: ${tagType}`);
    }
  }

  readList() {
    const itemType = this.readByte();
    const length = this.readInt();
    const list = [];
    for (let i = 0; i < length; i++) {
      list.push(this.readTag(itemType));
    }
    return list;
  }

  readCompound() {
    const compound = {};
    while (true) {
      const tagType = this.readByte();
      if (tagType === TAG_END) break;
      const name = this.readString();
      compound[name] = this.readTag(tagType);
    }
    return compound;
  }

  parse() {
    const tagType = this.readByte();
    if (tagType !== TAG_COMPOUND) {
      throw new Error('Root tag must be a compound');
    }
    const name = this.readString();
    const value = this.readCompound();
    return { name, value };
  }
}

function parseNBTRaw(buffer) {
  const reader = new NBTReader(buffer);
  return reader.parse();
}

async function parseMCAFromPath(filePath) {
  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const view = new DataView(arrayBuffer);
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
        
        const compressedData = new Uint8Array(arrayBuffer, offset + 5, length - 1);
        
        let decompressedData;
        if (compressionType === 1) {
          decompressedData = pako.ungzip(compressedData);
        } else if (compressionType === 2) {
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

// Extract block names from palette entries
function extractBlockName(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && entry.Name) return entry.Name;
  return null;
}

// Extract all unique block types from chunks
function extractBlockTypes(chunks) {
  const blockTypes = new Set();
  
  for (const chunk of chunks) {
    const data = chunk.data;
    const sections = data.sections || (data.Level && data.Level.Sections);
    
    if (!sections) continue;
    
    for (const section of sections) {
      // Modern format (1.18+)
      if (section.block_states && section.block_states.palette) {
        for (const entry of section.block_states.palette) {
          const name = extractBlockName(entry);
          if (name) blockTypes.add(name);
        }
      }
      
      // Legacy format (1.13-1.17)
      if (section.Palette) {
        for (const entry of section.Palette) {
          const name = extractBlockName(entry);
          if (name) blockTypes.add(name);
        }
      }
    }
  }
  
  return Array.from(blockTypes).sort();
}

async function main() {
  const debugWorldPath = path.join(__dirname, '..', 'debug_world');
  const outputPath = path.join(__dirname, '..', 'block_types.txt');
  
  console.log('Scanning debug_world for block types...');
  
  const allBlockTypes = new Set();
  
  // Find all .mca files in debug_world
  const files = fs.readdirSync(debugWorldPath);
  const mcaFiles = files.filter(f => f.endsWith('.mca'));
  
  console.log(`Found ${mcaFiles.length} region file(s)`);
  
  for (const mcaFile of mcaFiles) {
    const filePath = path.join(debugWorldPath, mcaFile);
    console.log(`Processing ${mcaFile}...`);
    
    try {
      const chunks = await parseMCAFromPath(filePath);
      console.log(`  Found ${chunks.length} chunks`);
      
      const blockTypes = extractBlockTypes(chunks);
      console.log(`  Found ${blockTypes.length} unique block types`);
      
      blockTypes.forEach(t => allBlockTypes.add(t));
    } catch (e) {
      console.error(`  Error processing ${mcaFile}:`, e.message);
    }
  }
  
  const sortedBlocks = Array.from(allBlockTypes).sort();
  
  console.log(`\nTotal unique block types: ${sortedBlocks.length}`);
  
  // Write to file
  const output = sortedBlocks.join('\n');
  fs.writeFileSync(outputPath, output, 'utf-8');
  
  console.log(`\nBlock types exported to: ${outputPath}`);
}

main().catch(console.error);




