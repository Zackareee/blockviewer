/**
 * Node.js compatible MCA file parser
 * 
 * Adapted from src/utils/mcaParser.js for use in Node.js test environment
 */

import fs from 'fs';
import path from 'path';
import pako from 'pako';

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

/**
 * Parse an MCA file from disk
 * @param {string} filePath - Path to the .mca file
 * @returns {Promise<Array>} Array of parsed chunks
 */
export async function parseMCAFromPath(filePath) {
  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const view = new DataView(arrayBuffer);
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
        
        const compressedData = new Uint8Array(arrayBuffer, offset + 5, length - 1);
        
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

export default parseMCAFromPath;








