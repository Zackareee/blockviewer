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

  readByte() { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
  readShort() { const v = this.view.getInt16(this.offset, false); this.offset += 2; return v; }
  readInt() { const v = this.view.getInt32(this.offset, false); this.offset += 4; return v; }
  readLong() {
    const high = this.view.getInt32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return BigInt(high) * BigInt(0x100000000) + BigInt(low);
  }
  readFloat() { const v = this.view.getFloat32(this.offset, false); this.offset += 4; return v; }
  readDouble() { const v = this.view.getFloat64(this.offset, false); this.offset += 8; return v; }
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
    for (let i = 0; i < length; i++) array.push(this.readInt());
    return array;
  }
  readLongArray() {
    const length = this.readInt();
    const array = [];
    for (let i = 0; i < length; i++) array.push(this.readLong());
    return array;
  }
  readTag(tagType) {
    switch (tagType) {
      case TAG_END: return null;
      case TAG_BYTE: return this.readByte();
      case TAG_SHORT: return this.readShort();
      case TAG_INT: return this.readInt();
      case TAG_LONG: return this.readLong();
      case TAG_FLOAT: return this.readFloat();
      case TAG_DOUBLE: return this.readDouble();
      case TAG_BYTE_ARRAY: return this.readByteArray();
      case TAG_STRING: return this.readString();
      case TAG_LIST: return this.readList();
      case TAG_COMPOUND: return this.readCompound();
      case TAG_INT_ARRAY: return this.readIntArray();
      case TAG_LONG_ARRAY: return this.readLongArray();
      default: throw new Error(`Unknown tag type: ${tagType}`);
    }
  }
  readList() {
    const itemType = this.readByte();
    const length = this.readInt();
    const list = [];
    for (let i = 0; i < length; i++) list.push(this.readTag(itemType));
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
    if (tagType !== TAG_COMPOUND) throw new Error('Root tag must be a compound');
    const name = this.readString();
    const value = this.readCompound();
    return { name, value };
  }
}

function parseNBTRaw(buffer) {
  const reader = new NBTReader(buffer);
  return reader.parse();
}

// Target coordinates
const targetX = -333;
const targetY = 89;
const targetZ = -435;

// Calculate chunk coordinates
const chunkX = Math.floor(targetX / 16);
const chunkZ = Math.floor(targetZ / 16);

// Calculate local block coordinates within chunk
const localX = ((targetX % 16) + 16) % 16;
const localY = targetY;
const localZ = ((targetZ % 16) + 16) % 16;

// Calculate section Y (each section is 16 blocks tall)
const sectionY = Math.floor(targetY / 16);
const localYInSection = targetY % 16;

console.log(`Target: ${targetX}, ${targetY}, ${targetZ}`);
console.log(`Chunk: ${chunkX}, ${chunkZ}`);
console.log(`Local in chunk: ${localX}, ${localY}, ${localZ}`);
console.log(`Section Y: ${sectionY}, local Y in section: ${localYInSection}`);

// Region file coordinates
const regionX = Math.floor(chunkX / 32);
const regionZ = Math.floor(chunkZ / 32);
console.log(`Region: ${regionX}, ${regionZ}`);

// Chunk within region
const chunkInRegionX = ((chunkX % 32) + 32) % 32;
const chunkInRegionZ = ((chunkZ % 32) + 32) % 32;
console.log(`Chunk in region: ${chunkInRegionX}, ${chunkInRegionZ}`);

const regionFile = path.join(process.cwd(), 'test-regions', `r.${regionX}.${regionZ}.mca`);
console.log(`\nReading: ${regionFile}`);

const buffer = fs.readFileSync(regionFile);
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const view = new DataView(arrayBuffer);

const index = chunkInRegionX + chunkInRegionZ * CHUNKS_PER_REGION;
const locationOffset = index * 4;
const locationData = view.getUint32(locationOffset, false);
const offset = (locationData >> 8) * SECTOR_SIZE;
const sectorCount = locationData & 0xFF;

console.log(`Chunk location index: ${index}, offset: ${offset}, sectors: ${sectorCount}`);

if (offset === 0 || sectorCount === 0) {
  console.log('Chunk not found!');
  process.exit(1);
}

const length = view.getUint32(offset, false);
const compressionType = view.getUint8(offset + 4);
const compressedData = new Uint8Array(arrayBuffer, offset + 5, length - 1);

let decompressedData;
if (compressionType === 1) {
  decompressedData = pako.ungzip(compressedData);
} else if (compressionType === 2) {
  decompressedData = pako.inflate(compressedData);
} else {
  console.log('Unknown compression');
  process.exit(1);
}

const nbt = parseNBTRaw(decompressedData.buffer);
const chunkData = nbt.value;

const sections = chunkData.sections || [];
console.log(`\nFound ${sections.length} sections`);

// Find the section at our Y level
const targetSection = sections.find(s => s.Y === sectionY);
if (!targetSection) {
  console.log(`Section Y=${sectionY} not found!`);
  process.exit(1);
}

console.log(`\nSection Y=${sectionY} found`);

const blockStates = targetSection.block_states;
if (!blockStates) {
  console.log('No block_states in section');
  process.exit(1);
}

const palette = blockStates.palette;
console.log(`Palette has ${palette.length} entries:`);
palette.forEach((p, i) => {
  console.log(`  [${i}] ${p.Name}${p.Properties ? ' ' + JSON.stringify(p.Properties) : ''}`);
});

// Get block at position
const data = blockStates.data;
if (!data || data.length === 0) {
  // Single block type in section
  console.log(`\n=== Block at ${targetX}, ${targetY}, ${targetZ} ===`);
  console.log(`Palette index: 0`);
  console.log(`Block: ${palette[0].Name}`);
  if (palette[0].Properties) {
    console.log(`Properties: ${JSON.stringify(palette[0].Properties, null, 2)}`);
  }
} else {
  // Calculate bits per entry
  const bitsPerEntry = Math.max(4, Math.ceil(Math.log2(palette.length)));
  console.log(`\nBits per entry: ${bitsPerEntry}`);
  
  // Calculate block index in section
  const blockIndex = localYInSection * 256 + localZ * 16 + localX;
  console.log(`Block index in section: ${blockIndex}`);
  
  // Extract from packed long array
  const entriesPerLong = Math.floor(64 / bitsPerEntry);
  const longIndex = Math.floor(blockIndex / entriesPerLong);
  const bitOffset = (blockIndex % entriesPerLong) * bitsPerEntry;
  
  const longValue = data[longIndex];
  const mask = (1n << BigInt(bitsPerEntry)) - 1n;
  const paletteIndex = Number((longValue >> BigInt(bitOffset)) & mask);
  
  console.log(`Long index: ${longIndex}, bit offset: ${bitOffset}`);
  console.log(`\n=== Block at ${targetX}, ${targetY}, ${targetZ} ===`);
  console.log(`Palette index: ${paletteIndex}`);
  console.log(`Block: ${palette[paletteIndex].Name}`);
  if (palette[paletteIndex].Properties) {
    console.log(`Properties: ${JSON.stringify(palette[paletteIndex].Properties, null, 2)}`);
  }
}
