#!/usr/bin/env node
/**
 * Entity Geometry Baking Script
 * 
 * Pre-computes entity model geometry and outputs a binary file for WASM consumption.
 * Similar to bake-model-geometry.js but for entity models (chests, beds, signs, etc.)
 * 
 * Output: public/assets/baked-entities.bin
 * 
 * Binary Format:
 * [header]
 *   u32: magic (0x454E5459 = "ENTY")
 *   u32: version
 *   u32: entity type count
 * 
 * [entity type index] (for each entity type)
 *   u16: entity type name length
 *   bytes: entity type name (e.g., "chest", "bed_head")
 *   u32: offset to entity data from start of data section
 * 
 * [entity data] (for each entity type)
 *   u8: variant count
 *   u8: flags bitfield:
 *       0x01 = has16Rotations (signs, skulls, banners)
 *       0x02 = hasColorVariants (beds, shulkers)
 *       0x04 = hasMirror (some models have mirrored UVs)
 *       0x08 = noShade (glowing elements like conduit eye)
 *       0x10 = isWallMounted (wall signs, wall banners)
 *   u8: rotation_source (0=facing, 1=rotation_property, 2=nbt_rotation)
 *   u16: base_texture_index (in entity atlas, 0xFFFF = no base texture)
 *   
 *   [variant] (for each variant)
 *     u8: variant key length
 *     bytes: variant key (e.g., "single", "double_left")
 *     u16: face count
 *     [face] (for each face)
 *       u8: direction (0=down, 1=up, 2=north, 3=south, 4=west, 5=east)
 *       f32[12]: vertices (4 vertices × 3 components, in 0-1 block space)
 *       f32[8]: uvs (4 vertices × 2 components, normalized 0-1)
 *       f32[3]: normal
 * 
 * Usage:
 *   node scripts/bake-entity-geometry.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const ENTITY_MODELS_PATH = path.join(__dirname, '../textures/1.21.11+Template/assets/minecraft/models/entity');
const ENTITY_MANIFEST_PATH = path.join(__dirname, '../public/assets/entity-manifest.json');
const ATLAS_MANIFEST_PATH = path.join(__dirname, '../public/assets/entity-atlas-manifest.json');
const OUTPUT_PATH = path.join(__dirname, '../public/assets/baked-entities.bin');
const TEXTURE_MAP_PATH = path.join(__dirname, '../public/assets/baked-entities-textures.json');

// Face directions
const DIRECTION = {
  down: 0, up: 1, north: 2, south: 3, west: 4, east: 5
};

// Face normals
const FACE_NORMALS = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

// Face vertices - match block model conventions
const FACE_VERTICES = {
  down:  [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
  up:    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  north: [[1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0]],
  south: [[0, 1, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1]],
  west:  [[0, 1, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0]],
  east:  [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 1]],
};

// Rotation source encoding
const ROTATION_SOURCE = {
  facing: 0,
  rotation: 1,
  nbt: 2,
  none: 3,
};

// Entity model configurations for WASM
// Maps entity type name to model file(s) and flags
const ENTITY_MODELS = {
  // Chests
  'chest': { 
    file: 'chest.json',
    flags: 0,
    rotationSource: 'facing',
    textureBase: 'entity/chest/normal',
  },
  'chest_left': {
    file: 'chest_left.json',
    flags: 0,
    rotationSource: 'facing',
    textureBase: 'entity/chest/normal_left',
  },
  'chest_right': {
    file: 'chest_right.json',
    flags: 0,
    rotationSource: 'facing',
    textureBase: 'entity/chest/normal_right',
  },
  
  // Skulls - use extracted skull models
  'skull': {
    file: 'skull.json',
    flags: 0x01, // has16Rotations
    rotationSource: 'rotation',
    textureBase: 'entity/skeleton/skeleton',
  },
  'skull_32': {
    file: 'skull_32.json',
    flags: 0x01, // has16Rotations
    rotationSource: 'rotation',
    textureBase: 'entity/skeleton/skeleton',
  },
  'wall_skull': {
    file: 'skull_32.json',
    flags: 0x10, // isWallMounted
    rotationSource: 'facing',
    textureBase: 'entity/skeleton/skeleton',
  },
  'skull_dragon': {
    file: 'skull_dragon.json',
    flags: 0x01,
    rotationSource: 'rotation',
    textureBase: 'entity/enderdragon/dragon',
  },
  'skull_piglin': {
    file: 'skull_piglin.json',
    flags: 0x01,
    rotationSource: 'rotation',
    textureBase: 'entity/piglin/piglin',
  },
  
  // Banner (pole/stand only - flag rendered separately)
  'banner': {
    file: 'banner.json',
    flags: 0x01 | 0x02, // has16Rotations + hasColorVariants
    rotationSource: 'rotation',
    textureBase: 'entity/banner_base',
  },
  'banner_standing': {
    file: 'banner_standing.json',
    flags: 0x01 | 0x02, // has16Rotations + hasColorVariants
    rotationSource: 'rotation',
    textureBase: 'entity/banner_base',
  },
  'wall_banner': {
    file: 'banner.json',
    flags: 0x10 | 0x02, // isWallMounted + hasColorVariants
    rotationSource: 'facing',
    textureBase: 'entity/banner_base',
  },
  
  // Bell
  'bell': {
    file: 'bell.json',
    flags: 0,
    rotationSource: 'facing',
    textureBase: 'entity/bell/bell_body',
  },
  
  // Shulker boxes
  'shulker': {
    file: 'shulker.json',
    flags: 0x02, // hasColorVariants
    rotationSource: 'facing',
    textureBase: 'entity/shulker/shulker',
  },
  
  // Book (enchanting table / lectern)
  'book': {
    file: 'book.json',
    flags: 0,
    rotationSource: 'none',
    textureBase: 'entity/enchanting_table_book',
  },
};

// Texture path to index mapping (loaded from atlas manifest)
let textureMap = new Map();
let atlasManifest = null;

/**
 * Load a JSON file
 */
function loadJson(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.warn(`  Warning: Could not load ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Get texture index from atlas manifest
 */
function getTextureIndex(texturePath) {
  // Try direct lookup
  if (textureMap.has(texturePath)) {
    return textureMap.get(texturePath);
  }
  
  // Try with entity/ prefix
  const withPrefix = `entity/${texturePath}`;
  if (textureMap.has(withPrefix)) {
    textureMap.set(texturePath, textureMap.get(withPrefix));
    return textureMap.get(withPrefix);
  }
  
  // Try without entity/ prefix
  if (texturePath.startsWith('entity/')) {
    const withoutPrefix = texturePath.substring(7);
    if (textureMap.has(withoutPrefix)) {
      textureMap.set(texturePath, textureMap.get(withoutPrefix));
      return textureMap.get(withoutPrefix);
    }
  }
  
  // Assign new index
  const newIndex = textureMap.size;
  textureMap.set(texturePath, newIndex);
  return newIndex;
}

/**
 * Compute geometry from entity model JSON
 * Returns array of face data
 */
function computeGeometry(model) {
  if (!model || !model.elements || model.elements.length === 0) {
    return null;
  }
  
  const faces = [];
  const textureSize = model.texture_size || [64, 64];
  
  for (const element of model.elements) {
    // Element coordinates in block space (0-16)
    const from = element.from.map(v => v / 16); // Convert to 0-1 range
    const to = element.to.map(v => v / 16);
    
    if (!element.faces) continue;
    
    for (const [faceName, faceData] of Object.entries(element.faces)) {
      if (!faceData || !faceData.uv) continue;
      
      const direction = DIRECTION[faceName];
      if (direction === undefined) continue;
      
      // Get UV coordinates (already in 0-1 normalized form from extractor v3)
      // The extractor outputs normalized UVs directly
      const uv = faceData.uv;
      
      // Build vertices for this face based on element bounds
      const baseVerts = FACE_VERTICES[faceName];
      const vertices = [];
      
      for (let i = 0; i < 4; i++) {
        const bv = baseVerts[i];
        vertices.push([
          from[0] + bv[0] * (to[0] - from[0]),
          from[1] + bv[1] * (to[1] - from[1]),
          from[2] + bv[2] * (to[2] - from[2]),
        ]);
      }
      
      // Calculate UVs for each vertex
      // uv format: [u1, v1, u2, v2]
      const u1 = uv[0], v1 = uv[1], u2 = uv[2], v2 = uv[3];
      const vertexUVs = [
        [u1, v1],  // top-left
        [u2, v1],  // top-right
        [u2, v2],  // bottom-right
        [u1, v2],  // bottom-left
      ];
      
      // Normal
      const normal = FACE_NORMALS[faceName];
      
      faces.push({
        direction,
        vertices,
        uvs: vertexUVs,
        normal,
      });
    }
  }
  
  return { faces };
}

/**
 * Write binary data for an entity type
 */
function writeBinary(entities) {
  const chunks = [];
  
  console.log(`Baking geometry for ${Object.keys(entities).length} entity types...`);
  
  // Build entity data
  const entityDataList = [];
  let bakedFaces = 0;
  
  for (const [entityName, config] of Object.entries(entities)) {
    // Load model file
    const modelPath = path.join(ENTITY_MODELS_PATH, config.file);
    const model = loadJson(modelPath);
    
    if (!model) {
      console.warn(`  Skipping ${entityName}: model not found`);
      entityDataList.push({
        name: entityName,
        flags: config.flags || 0,
        rotationSource: ROTATION_SOURCE[config.rotationSource] || 0,
        textureIndex: getTextureIndex(config.textureBase),
        variants: [],
      });
      continue;
    }
    
    // Compute geometry
    const geometry = computeGeometry(model);
    
    if (!geometry || geometry.faces.length === 0) {
      console.warn(`  Skipping ${entityName}: no geometry`);
      entityDataList.push({
        name: entityName,
        flags: config.flags || 0,
        rotationSource: ROTATION_SOURCE[config.rotationSource] || 0,
        textureIndex: getTextureIndex(config.textureBase),
        variants: [],
      });
      continue;
    }
    
    // Entity models have a single "default" variant
    const variants = [{
      key: 'default',
      faces: geometry.faces,
    }];
    
    bakedFaces += geometry.faces.length;
    
    entityDataList.push({
      name: entityName,
      flags: config.flags || 0,
      rotationSource: ROTATION_SOURCE[config.rotationSource] || 0,
      textureIndex: getTextureIndex(config.textureBase),
      variants,
    });
    
    console.log(`  ✓ ${entityName}: ${geometry.faces.length} faces`);
  }
  
  console.log(`\nBaked ${bakedFaces} total faces`);
  
  // Calculate sizes
  const HEADER_SIZE = 12; // magic + version + entity count
  let indexSize = 0;
  let dataSize = 0;
  
  for (const entity of entityDataList) {
    indexSize += 2 + entity.name.length + 4; // nameLen + name + offset
    
    // Entity data: variantCount + flags + rotationSource + textureIndex
    let entitySize = 1 + 1 + 1 + 2;
    
    for (const variant of entity.variants) {
      // Variant: keyLen + key + faceCount
      entitySize += 1 + variant.key.length + 2;
      
      // Faces: each face is 1 + 48 + 32 + 12 = 93 bytes
      // direction(1) + vertices(12 floats * 4) + uvs(8 floats * 4) + normal(3 floats * 4)
      entitySize += variant.faces.length * 93;
    }
    
    dataSize += entitySize;
  }
  
  const totalBytes = HEADER_SIZE + indexSize + dataSize;
  const buffer = Buffer.alloc(totalBytes);
  let offset = 0;
  
  // Write header
  buffer.writeUInt32LE(0x454E5459, offset); offset += 4; // Magic "ENTY"
  buffer.writeUInt32LE(1, offset); offset += 4; // Version
  buffer.writeUInt32LE(entityDataList.length, offset); offset += 4;
  
  // Write index
  const indexStart = offset;
  const dataOffsets = [];
  let dataOffset = 0;
  
  for (const entity of entityDataList) {
    // Entity name
    buffer.writeUInt16LE(entity.name.length, offset); offset += 2;
    buffer.write(entity.name, offset, 'utf-8'); offset += entity.name.length;
    
    // Offset placeholder (will fill in after calculating data offsets)
    dataOffsets.push(offset);
    buffer.writeUInt32LE(dataOffset, offset); offset += 4;
    
    // Calculate data size for this entity
    let entityDataSize = 1 + 1 + 1 + 2; // variantCount + flags + rotationSource + textureIndex
    for (const variant of entity.variants) {
      entityDataSize += 1 + variant.key.length + 2;
      entityDataSize += variant.faces.length * 93;
    }
    dataOffset += entityDataSize;
  }
  
  // Write data section
  const dataStart = offset;
  
  for (let i = 0; i < entityDataList.length; i++) {
    const entity = entityDataList[i];
    
    // Update offset in index
    buffer.writeUInt32LE(offset - dataStart, dataOffsets[i]);
    
    // Variant count
    buffer.writeUInt8(entity.variants.length, offset); offset += 1;
    
    // Flags
    buffer.writeUInt8(entity.flags, offset); offset += 1;
    
    // Rotation source
    buffer.writeUInt8(entity.rotationSource, offset); offset += 1;
    
    // Texture index
    buffer.writeUInt16LE(entity.textureIndex, offset); offset += 2;
    
    for (const variant of entity.variants) {
      // Variant key
      buffer.writeUInt8(variant.key.length, offset); offset += 1;
      buffer.write(variant.key, offset, 'utf-8'); offset += variant.key.length;
      
      // Face count
      buffer.writeUInt16LE(variant.faces.length, offset); offset += 2;
      
      for (const face of variant.faces) {
        buffer.writeUInt8(face.direction, offset); offset += 1;
        
        // Vertices (12 floats)
        for (const v of face.vertices) {
          buffer.writeFloatLE(v[0], offset); offset += 4;
          buffer.writeFloatLE(v[1], offset); offset += 4;
          buffer.writeFloatLE(v[2], offset); offset += 4;
        }
        
        // UVs (8 floats)
        for (const uv of face.uvs) {
          buffer.writeFloatLE(uv[0], offset); offset += 4;
          buffer.writeFloatLE(uv[1], offset); offset += 4;
        }
        
        // Normal (3 floats)
        buffer.writeFloatLE(face.normal[0], offset); offset += 4;
        buffer.writeFloatLE(face.normal[1], offset); offset += 4;
        buffer.writeFloatLE(face.normal[2], offset); offset += 4;
      }
    }
  }
  
  // Write texture map
  const textureMapData = Object.fromEntries(textureMap);
  fs.writeFileSync(TEXTURE_MAP_PATH, JSON.stringify(textureMapData, null, 2));
  
  console.log(`\nOutput:`);
  console.log(`  Binary: ${OUTPUT_PATH} (${(buffer.length / 1024).toFixed(1)} KB)`);
  console.log(`  Textures: ${TEXTURE_MAP_PATH}`);
  
  return buffer;
}

async function main() {
  console.log('=== Entity Geometry Baking ===\n');
  
  // Load atlas manifest for texture indices
  atlasManifest = loadJson(ATLAS_MANIFEST_PATH);
  if (atlasManifest && atlasManifest.textures) {
    for (const [path, info] of Object.entries(atlasManifest.textures)) {
      textureMap.set(path, info.index);
    }
    console.log(`Loaded atlas manifest with ${textureMap.size} textures`);
  } else {
    console.warn('Atlas manifest not found, texture indices will be generated');
  }
  
  // Bake geometry
  const binary = writeBinary(ENTITY_MODELS);
  
  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(OUTPUT_PATH, binary);
  
  console.log('\nDone!');
}

main().catch(console.error);
