import pako from 'pako';

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

// Reuse TextDecoder to avoid creating new instances for each string
const textDecoder = new TextDecoder('utf-8');

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

  readUByte() {
    const value = this.view.getUint8(this.offset);
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
    return textDecoder.decode(bytes);
  }

  readByteArray() {
    const length = this.readInt();
    // Return Int8Array directly - more efficient than Array.from()
    // Callers that need Array can convert if needed
    const array = new Int8Array(this.buffer.slice(this.offset, this.offset + length));
    this.offset += length;
    return array;
  }

  readIntArray() {
    const length = this.readInt();
    // Pre-allocate array for better performance
    const array = new Int32Array(length);
    for (let i = 0; i < length; i++) {
      array[i] = this.view.getInt32(this.offset, false);
      this.offset += 4;
    }
    return array;
  }

  readLongArray() {
    const length = this.readInt();
    // Pre-allocate array for better performance
    const array = new Array(length);
    for (let i = 0; i < length; i++) {
      const high = this.view.getInt32(this.offset, false);
      const low = this.view.getUint32(this.offset + 4, false);
      this.offset += 8;
      array[i] = BigInt(high) * BigInt(0x100000000) + BigInt(low);
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

export function parseNBT(buffer) {
  // Try to decompress first (most NBT data is compressed)
  let data;
  try {
    const compressed = new Uint8Array(buffer);
    // Check for gzip magic number
    if (compressed[0] === 0x1f && compressed[1] === 0x8b) {
      data = pako.ungzip(compressed).buffer;
    } else if (compressed[0] === 0x78) {
      // zlib
      data = pako.inflate(compressed).buffer;
    } else {
      data = buffer;
    }
  } catch (e) {
    data = buffer;
  }

  const reader = new NBTReader(data);
  return reader.parse();
}

export function parseNBTRaw(buffer) {
  const reader = new NBTReader(buffer);
  return reader.parse();
}

/**
 * Parse level.dat and extract world spawn coordinates
 * @param {ArrayBuffer} buffer - The level.dat file contents
 * @returns {{ x: number, y: number, z: number } | null} - Spawn coordinates or null if not found
 */
export function extractSpawnFromLevelDat(buffer) {
  try {
    const nbt = parseNBT(buffer);
    const data = nbt.value?.Data;
    
    if (!data) {
      console.warn('[extractSpawnFromLevelDat] No Data compound found in level.dat');
      return null;
    }
    
    // Spawn coordinates are stored directly in the Data compound
    const spawnX = data.SpawnX;
    const spawnY = data.SpawnY;
    const spawnZ = data.SpawnZ;
    
    if (spawnX === undefined || spawnZ === undefined) {
      console.warn('[extractSpawnFromLevelDat] SpawnX/SpawnZ not found in level.dat');
      return null;
    }
    
    console.log(`[extractSpawnFromLevelDat] Found world spawn: (${spawnX}, ${spawnY ?? 'unknown'}, ${spawnZ})`);
    
    return {
      x: spawnX,
      y: spawnY ?? 64, // Default Y if not present
      z: spawnZ,
    };
  } catch (e) {
    console.error('[extractSpawnFromLevelDat] Failed to parse level.dat:', e);
    return null;
  }
}

