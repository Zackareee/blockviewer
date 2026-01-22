/**
 * Generate a test region file with specific block patterns
 * 
 * Creates 4 chunks in a 2x2 grid:
 * - Chunk (0,0): 4x4 grid of bottom stone slabs at Y=64
 * - Chunk (1,0): 4x4 grid of stone stairs at Y=64
 * - Chunk (0,1): 4x4 grid of stone blocks with stone slabs on top (Y=64,65)
 * - Chunk (1,1): 4x4 grid of stone blocks with stone stairs on top (Y=64,65)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

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

// Region constants
const SECTOR_SIZE = 4096;
const CHUNKS_PER_REGION = 32;

class NBTWriter {
  constructor() {
    this.buffer = Buffer.alloc(1024 * 1024); // 1MB initial buffer
    this.offset = 0;
  }

  ensureCapacity(bytes) {
    if (this.offset + bytes > this.buffer.length) {
      const newBuffer = Buffer.alloc(this.buffer.length * 2);
      this.buffer.copy(newBuffer);
      this.buffer = newBuffer;
    }
  }

  writeByte(value) {
    this.ensureCapacity(1);
    this.buffer.writeInt8(value, this.offset);
    this.offset += 1;
  }

  writeShort(value) {
    this.ensureCapacity(2);
    this.buffer.writeInt16BE(value, this.offset);
    this.offset += 2;
  }

  writeInt(value) {
    this.ensureCapacity(4);
    this.buffer.writeInt32BE(value, this.offset);
    this.offset += 4;
  }

  writeLong(value) {
    this.ensureCapacity(8);
    // Write as BigInt
    const bigValue = BigInt(value);
    this.buffer.writeBigInt64BE(bigValue, this.offset);
    this.offset += 8;
  }

  writeString(str) {
    const bytes = Buffer.from(str, 'utf-8');
    this.writeShort(bytes.length);
    this.ensureCapacity(bytes.length);
    bytes.copy(this.buffer, this.offset);
    this.offset += bytes.length;
  }

  writeTagHeader(type, name) {
    this.writeByte(type);
    this.writeString(name);
  }

  writeCompoundTag(name, writeContents) {
    this.writeTagHeader(TAG_COMPOUND, name);
    writeContents();
    this.writeByte(TAG_END);
  }

  writeByteTag(name, value) {
    this.writeTagHeader(TAG_BYTE, name);
    this.writeByte(value);
  }

  writeShortTag(name, value) {
    this.writeTagHeader(TAG_SHORT, name);
    this.writeShort(value);
  }

  writeIntTag(name, value) {
    this.writeTagHeader(TAG_INT, name);
    this.writeInt(value);
  }

  writeLongTag(name, value) {
    this.writeTagHeader(TAG_LONG, name);
    this.writeLong(value);
  }

  writeStringTag(name, value) {
    this.writeTagHeader(TAG_STRING, name);
    this.writeString(value);
  }

  writeListTag(name, elementType, elements, writeElement) {
    this.writeTagHeader(TAG_LIST, name);
    this.writeByte(elementType);
    this.writeInt(elements.length);
    for (const element of elements) {
      writeElement(element);
    }
  }

  writeLongArrayTag(name, values) {
    this.writeTagHeader(TAG_LONG_ARRAY, name);
    this.writeInt(values.length);
    for (const value of values) {
      this.writeLong(value);
    }
  }

  writeByteArrayTag(name, values) {
    this.writeTagHeader(TAG_BYTE_ARRAY, name);
    this.writeInt(values.length);
    this.ensureCapacity(values.length);
    for (let i = 0; i < values.length; i++) {
      // Use UInt8 to allow values 0-255
      this.buffer.writeUInt8(values[i] & 0xFF, this.offset + i);
    }
    this.offset += values.length;
  }

  // Write a compound without the outer tag header (for list elements)
  writeCompoundContents(writeContents) {
    writeContents();
    this.writeByte(TAG_END);
  }

  getBuffer() {
    return this.buffer.slice(0, this.offset);
  }
}

/**
 * Pack block indices into a long array using Minecraft's format
 * Modern Minecraft (1.16+) uses non-spanning packing
 */
function packBlockIndices(indices, bitsPerBlock) {
  const blocksPerLong = Math.floor(64 / bitsPerBlock);
  const numLongs = Math.ceil(4096 / blocksPerLong);
  const longs = [];
  
  for (let longIdx = 0; longIdx < numLongs; longIdx++) {
    let value = BigInt(0);
    for (let i = 0; i < blocksPerLong; i++) {
      const blockIdx = longIdx * blocksPerLong + i;
      if (blockIdx < 4096) {
        const idx = BigInt(indices[blockIdx] || 0);
        value |= idx << BigInt(i * bitsPerBlock);
      }
    }
    longs.push(value);
  }
  
  return longs;
}

/**
 * Create a section with specific blocks
 */
function createSection(writer, sectionY, palette, blockIndices) {
  writer.writeCompoundContents(() => {
    // Section Y coordinate
    writer.writeByteTag('Y', sectionY);
    
    // Block states compound
    writer.writeCompoundTag('block_states', () => {
      // Palette list
      writer.writeListTag('palette', TAG_COMPOUND, palette, (entry) => {
        writer.writeCompoundContents(() => {
          writer.writeStringTag('Name', entry.name);
          if (entry.properties) {
            writer.writeCompoundTag('Properties', () => {
              for (const [key, value] of Object.entries(entry.properties)) {
                writer.writeStringTag(key, value);
              }
            });
          }
        });
      });
      
      // Pack block data if more than 1 palette entry
      if (palette.length > 1) {
        const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
        const packedData = packBlockIndices(blockIndices, bitsPerBlock);
        writer.writeLongArrayTag('data', packedData);
      }
    });
    
    // Empty biomes (required for modern chunks)
    writer.writeCompoundTag('biomes', () => {
      writer.writeListTag('palette', TAG_COMPOUND, [{ name: 'minecraft:plains' }], (entry) => {
        writer.writeCompoundContents(() => {
          writer.writeStringTag('Name', entry.name);
        });
      });
    });
    
    // Full sky light (all 15)
    const skyLight = new Array(2048).fill(0xFF);
    writer.writeByteArrayTag('SkyLight', skyLight);
    
    // No block light
    const blockLight = new Array(2048).fill(0);
    writer.writeByteArrayTag('BlockLight', blockLight);
  });
}

/**
 * Create a chunk with the specified block pattern
 */
function createChunk(chunkX, chunkZ, sectionData) {
  const writer = new NBTWriter();
  
  // Root compound
  writer.writeByte(TAG_COMPOUND);
  writer.writeString(''); // Empty root name
  
  // Data version (1.21.1 = 3955)
  writer.writeIntTag('DataVersion', 3955);
  
  // Chunk coordinates
  writer.writeIntTag('xPos', chunkX);
  writer.writeIntTag('zPos', chunkZ);
  writer.writeIntTag('yPos', -4); // Minimum section Y
  
  // Status
  writer.writeStringTag('Status', 'minecraft:full');
  
  // Last update
  writer.writeLongTag('LastUpdate', 0n);
  
  // Sections list
  writer.writeListTag('sections', TAG_COMPOUND, sectionData, (section) => {
    createSection(writer, section.y, section.palette, section.blockIndices);
  });
  
  // End root compound
  writer.writeByte(TAG_END);
  
  return writer.getBuffer();
}

/**
 * Get block index for a position within a section (YZX order)
 */
function getBlockIndex(x, y, z) {
  return (y * 16 + z) * 16 + x;
}

/**
 * Create indices array with blocks at specific positions
 */
function createBlockPattern(positions, paletteIndex = 1) {
  const indices = new Array(4096).fill(0); // All air by default
  for (const [x, y, z] of positions) {
    indices[getBlockIndex(x, y, z)] = paletteIndex;
  }
  return indices;
}

/**
 * Create a 4x4 grid of positions centered in the chunk
 */
function create4x4Grid(yOffset = 0) {
  const positions = [];
  // Start at x=6, z=6 to center a 4x4 grid in the 16x16 chunk
  for (let x = 6; x < 10; x++) {
    for (let z = 6; z < 10; z++) {
      positions.push([x, yOffset, z]);
    }
  }
  return positions;
}

/**
 * Create indices with two block types at different Y levels
 */
function createTwoLayerPattern(layer1Positions, layer2Positions, palette1Index = 1, palette2Index = 2) {
  const indices = new Array(4096).fill(0);
  for (const [x, y, z] of layer1Positions) {
    indices[getBlockIndex(x, y, z)] = palette1Index;
  }
  for (const [x, y, z] of layer2Positions) {
    indices[getBlockIndex(x, y, z)] = palette2Index;
  }
  return indices;
}

// Define the chunks
const chunks = [
  // Chunk (0,0): Bottom stone slabs at Y=64 (section 4, y offset 0)
  {
    x: 0,
    z: 0,
    sections: [{
      y: 4, // Section Y = 4 means blocks at Y = 64-79
      palette: [
        { name: 'minecraft:air' },
        { name: 'minecraft:stone_slab', properties: { type: 'bottom', waterlogged: 'false' } }
      ],
      blockIndices: createBlockPattern(create4x4Grid(0), 1)
    }]
  },
  
  // Chunk (1,0): Stone stairs at Y=64
  {
    x: 1,
    z: 0,
    sections: [{
      y: 4,
      palette: [
        { name: 'minecraft:air' },
        { name: 'minecraft:stone_stairs', properties: { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' } }
      ],
      blockIndices: createBlockPattern(create4x4Grid(0), 1)
    }]
  },
  
  // Chunk (0,1): Stone blocks with stone slabs on top (Y=64 stone, Y=65 slabs)
  {
    x: 0,
    z: 1,
    sections: [{
      y: 4,
      palette: [
        { name: 'minecraft:air' },
        { name: 'minecraft:stone' },
        { name: 'minecraft:stone_slab', properties: { type: 'bottom', waterlogged: 'false' } }
      ],
      blockIndices: createTwoLayerPattern(create4x4Grid(0), create4x4Grid(1), 1, 2)
    }]
  },
  
  // Chunk (1,1): Stone blocks with stone stairs on top (Y=64 stone, Y=65 stairs)
  {
    x: 1,
    z: 1,
    sections: [{
      y: 4,
      palette: [
        { name: 'minecraft:air' },
        { name: 'minecraft:stone' },
        { name: 'minecraft:stone_stairs', properties: { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' } }
      ],
      blockIndices: createTwoLayerPattern(create4x4Grid(0), create4x4Grid(1), 1, 2)
    }]
  }
];

function generateRegionFile() {
  console.log('Generating test region file...');
  
  // Create location and timestamp tables (8KB header)
  const header = Buffer.alloc(SECTOR_SIZE * 2);
  
  // Collect compressed chunk data
  const chunkDataBuffers = [];
  let currentSector = 2; // Start after header (2 sectors)
  
  for (const chunk of chunks) {
    console.log(`Creating chunk (${chunk.x}, ${chunk.z})...`);
    
    // Create NBT data
    const nbtData = createChunk(chunk.x, chunk.z, chunk.sections);
    console.log(`  NBT size: ${nbtData.length} bytes`);
    
    // Compress with zlib
    const compressed = zlib.deflateSync(nbtData);
    console.log(`  Compressed size: ${compressed.length} bytes`);
    
    // Create chunk data with length and compression type
    const chunkBuffer = Buffer.alloc(5 + compressed.length);
    chunkBuffer.writeUInt32BE(compressed.length + 1, 0); // Length includes compression type
    chunkBuffer.writeUInt8(2, 4); // Compression type: 2 = zlib
    compressed.copy(chunkBuffer, 5);
    
    // Calculate sectors needed
    const sectorsNeeded = Math.ceil(chunkBuffer.length / SECTOR_SIZE);
    
    // Write location entry
    const locationIndex = chunk.x + chunk.z * CHUNKS_PER_REGION;
    const locationValue = (currentSector << 8) | sectorsNeeded;
    header.writeUInt32BE(locationValue, locationIndex * 4);
    
    // Write timestamp entry (current time)
    const timestamp = Math.floor(Date.now() / 1000);
    header.writeUInt32BE(timestamp, SECTOR_SIZE + locationIndex * 4);
    
    // Pad chunk data to sector boundary
    const paddedSize = sectorsNeeded * SECTOR_SIZE;
    const paddedBuffer = Buffer.alloc(paddedSize);
    chunkBuffer.copy(paddedBuffer);
    
    chunkDataBuffers.push(paddedBuffer);
    currentSector += sectorsNeeded;
    
    console.log(`  Sectors: ${sectorsNeeded}, offset: sector ${currentSector - sectorsNeeded}`);
  }
  
  // Combine all buffers
  const regionFile = Buffer.concat([header, ...chunkDataBuffers]);
  
  // Write region file
  const outputDir = path.join(__dirname, '..', 'test', 'fixtures');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const mcaPath = path.join(outputDir, 'r.0.0.mca');
  fs.writeFileSync(mcaPath, regionFile);
  console.log(`\nWrote region file: ${mcaPath} (${regionFile.length} bytes)`);
  
  // Create directory structure for zip
  const zipContentDir = path.join(outputDir, 'test_slabs_stairs_content');
  const regionDir = path.join(zipContentDir, 'region');
  
  if (!fs.existsSync(regionDir)) {
    fs.mkdirSync(regionDir, { recursive: true });
  }
  
  // Copy MCA file to the structure
  fs.copyFileSync(mcaPath, path.join(regionDir, 'r.0.0.mca'));
  
  // Create zip file using command line
  const zipPath = path.join(outputDir, 'test_slabs_stairs.zip');
  
  // Remove existing zip if present
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  
  // Create zip from the content directory
  execSync(`cd "${zipContentDir}" && zip -r "${zipPath}" region/`);
  
  console.log(`Wrote zip file: ${zipPath}`);
  
  // Clean up temp directory
  fs.rmSync(zipContentDir, { recursive: true });
}

try {
  generateRegionFile();
  console.log('\nDone!');
} catch (err) {
  console.error('Error:', err);
  process.exit(1);
}
