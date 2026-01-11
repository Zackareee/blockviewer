#!/usr/bin/env node
/**
 * Geometry Baking Script
 * 
 * Pre-computes model geometry for all block variants and outputs a binary file.
 * This runs in Node.js and simulates what the browser would do.
 * 
 * Output: public/assets/baked-models.bin
 * 
 * Binary Format:
 * [header]
 *   u32: magic (0x424B4D44 = "BKMD")
 *   u32: version
 *   u32: block count
 * 
 * [block index] (for each block)
 *   u16: block name length
 *   bytes: block name (UTF-8)
 *   u32: offset to block data from start of data section
 * 
 * [block data] (for each block)
 *   u8: variant count
 *   u8: flags (hasRandomRotation, hasPositionOffset, isTransparent)
 *   [variant] (for each variant)
 *     u8: variant key length
 *     bytes: variant key (UTF-8)
 *     u16: face count
 *     [face] (for each face)
 *       u8: direction (0=down, 1=up, 2=north, 3=south, 4=west, 5=east, 6=none)
 *       u8: cullface (same encoding, 0xFF = no cull)
 *       u8: tint type (0=none, 1=grass, 2=foliage, 3=water)
 *       u16: texture index
 *       f32[12]: vertices (4 vertices × 3 components)
 *       f32[8]: uvs (4 vertices × 2 components)
 *       f32[3]: normal
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_PATH = path.join(__dirname, '../minecraft_versions/1.21.11_unobfuscated/assets/minecraft');
const MODELS_PATH = path.join(ASSETS_PATH, 'models/block');
const MANIFEST_PATH = path.join(__dirname, '../public/assets/block-model-manifest.json');
const OUTPUT_PATH = path.join(__dirname, '../public/assets/baked-models.bin');

// Face directions
const DIRECTION = {
  down: 0, up: 1, north: 2, south: 3, west: 4, east: 5, none: 6
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

// Face vertices (before rotation) - CCW winding
const FACE_VERTICES = {
  down: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
  up: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  north: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  south: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  west: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  east: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
};

// Texture name → tint type mapping
const TINT_TYPES = {
  grass: 1,
  foliage: 2,
  water: 3,
};

const GRASS_TINT_TEXTURES = new Set([
  'grass_block_top', 'short_grass', 'tall_grass_top', 'tall_grass_bottom',
  'fern', 'large_fern_top', 'large_fern_bottom',
]);

const FOLIAGE_TINT_TEXTURES = new Set([
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'vine',
]);

// Model cache
const modelCache = new Map();
const textureMap = new Map();
let nextTextureIndex = 0;

function loadJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function getTextureIndex(textureName) {
  const normalized = textureName.replace('minecraft:', '').replace('block/', '');
  if (!textureMap.has(normalized)) {
    textureMap.set(normalized, nextTextureIndex++);
  }
  return textureMap.get(normalized);
}

function getTintType(textureName) {
  const normalized = textureName.replace('minecraft:', '').replace('block/', '');
  if (GRASS_TINT_TEXTURES.has(normalized)) return 1;
  if (FOLIAGE_TINT_TEXTURES.has(normalized)) return 2;
  if (normalized.includes('water')) return 3;
  return 0;
}

function resolveModel(modelName) {
  if (modelCache.has(modelName)) {
    return modelCache.get(modelName);
  }
  
  const modelPath = path.join(MODELS_PATH, `${modelName}.json`);
  let model = loadJson(modelPath);
  
  if (!model) {
    // Try with full path
    const altPath = path.join(ASSETS_PATH, 'models', `block/${modelName}.json`);
    model = loadJson(altPath);
  }
  
  if (!model) {
    modelCache.set(modelName, null);
    return null;
  }
  
  let result = {
    elements: [],
    textures: {},
    ambientocclusion: model.ambientocclusion !== false,
  };
  
  if (model.parent) {
    const parentName = model.parent.replace('minecraft:', '').replace('block/', '');
    const parent = resolveModel(parentName);
    if (parent) {
      result.elements = [...parent.elements];
      result.textures = { ...parent.textures };
      result.ambientocclusion = parent.ambientocclusion;
    }
  }
  
  if (model.textures) {
    Object.assign(result.textures, model.textures);
  }
  
  if (model.elements) {
    result.elements = model.elements;
  }
  
  modelCache.set(modelName, result);
  return result;
}

function resolveTexture(textureRef, textures) {
  if (!textureRef) return null;
  
  let resolved = textureRef;
  const visited = new Set();
  
  while (resolved.startsWith('#')) {
    if (visited.has(resolved)) return null; // Circular
    visited.add(resolved);
    
    const key = resolved.slice(1);
    resolved = textures[key];
    if (!resolved) return null;
  }
  
  return resolved.replace('minecraft:', '').replace('block/', '');
}

function rotateVertex(v, rotX, rotY) {
  let [x, y, z] = v;
  
  // Rotate around Y axis
  if (rotY !== 0) {
    const radY = (rotY * Math.PI) / 180;
    const cosY = Math.cos(radY);
    const sinY = Math.sin(radY);
    const newX = (x - 0.5) * cosY - (z - 0.5) * sinY + 0.5;
    const newZ = (x - 0.5) * sinY + (z - 0.5) * cosY + 0.5;
    x = newX;
    z = newZ;
  }
  
  // Rotate around X axis
  if (rotX !== 0) {
    const radX = (rotX * Math.PI) / 180;
    const cosX = Math.cos(radX);
    const sinX = Math.sin(radX);
    const newY = (y - 0.5) * cosX - (z - 0.5) * sinX + 0.5;
    const newZ = (y - 0.5) * sinX + (z - 0.5) * cosX + 0.5;
    y = newY;
    z = newZ;
  }
  
  return [x, y, z];
}

function rotateNormal(n, rotX, rotY) {
  let [x, y, z] = n;
  
  if (rotY !== 0) {
    const radY = (rotY * Math.PI) / 180;
    const cosY = Math.cos(radY);
    const sinY = Math.sin(radY);
    const newX = x * cosY - z * sinY;
    const newZ = x * sinY + z * cosY;
    x = newX;
    z = newZ;
  }
  
  if (rotX !== 0) {
    const radX = (rotX * Math.PI) / 180;
    const cosX = Math.cos(radX);
    const sinX = Math.sin(radX);
    const newY = y * cosX - z * sinX;
    const newZ = y * sinX + z * cosX;
    y = newY;
    z = newZ;
  }
  
  return [x, y, z];
}

function rotateCullface(cullface, rotX, rotY) {
  if (!cullface || cullface === 'none') return 'none';
  
  const rotations = ['north', 'east', 'south', 'west'];
  
  let result = cullface;
  
  // Y rotation
  if (rotY !== 0 && ['north', 'east', 'south', 'west'].includes(result)) {
    const idx = rotations.indexOf(result);
    const steps = Math.round(rotY / 90) % 4;
    result = rotations[(idx + steps + 4) % 4];
  }
  
  // X rotation (only affects up/down/north/south)
  if (rotX !== 0) {
    const xRotations = ['north', 'down', 'south', 'up'];
    if (xRotations.includes(result)) {
      const idx = xRotations.indexOf(result);
      const steps = Math.round(rotX / 90) % 4;
      result = xRotations[(idx + steps + 4) % 4];
    }
  }
  
  return result;
}

function computeGeometry(model, rotX = 0, rotY = 0, uvlock = false) {
  if (!model || !model.elements || model.elements.length === 0) {
    return null;
  }
  
  const faces = [];
  
  for (const element of model.elements) {
    const from = element.from.map(v => v / 16);
    const to = element.to.map(v => v / 16);
    
    if (!element.faces) continue;
    
    for (const [faceName, faceData] of Object.entries(element.faces)) {
      const textureName = resolveTexture(faceData.texture, model.textures);
      if (!textureName) continue;
      
      const textureIndex = getTextureIndex(textureName);
      const tintType = faceData.tintindex !== undefined ? getTintType(textureName) : 0;
      
      // Get base vertices for this face
      let vertices;
      switch (faceName) {
        case 'down':
          vertices = [
            [from[0], from[1], to[2]],
            [to[0], from[1], to[2]],
            [to[0], from[1], from[2]],
            [from[0], from[1], from[2]],
          ];
          break;
        case 'up':
          vertices = [
            [from[0], to[1], from[2]],
            [to[0], to[1], from[2]],
            [to[0], to[1], to[2]],
            [from[0], to[1], to[2]],
          ];
          break;
        case 'north':
          vertices = [
            [to[0], from[1], from[2]],
            [from[0], from[1], from[2]],
            [from[0], to[1], from[2]],
            [to[0], to[1], from[2]],
          ];
          break;
        case 'south':
          vertices = [
            [from[0], from[1], to[2]],
            [to[0], from[1], to[2]],
            [to[0], to[1], to[2]],
            [from[0], to[1], to[2]],
          ];
          break;
        case 'west':
          vertices = [
            [from[0], from[1], from[2]],
            [from[0], from[1], to[2]],
            [from[0], to[1], to[2]],
            [from[0], to[1], from[2]],
          ];
          break;
        case 'east':
          vertices = [
            [to[0], from[1], to[2]],
            [to[0], from[1], from[2]],
            [to[0], to[1], from[2]],
            [to[0], to[1], to[2]],
          ];
          break;
        default:
          continue;
      }
      
      // Apply element rotation if present
      if (element.rotation) {
        const origin = element.rotation.origin.map(v => v / 16);
        const axis = element.rotation.axis;
        const angle = element.rotation.angle || 0;
        
        if (angle !== 0) {
          const rad = (angle * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          
          vertices = vertices.map(v => {
            let [x, y, z] = v;
            x -= origin[0];
            y -= origin[1];
            z -= origin[2];
            
            let newX = x, newY = y, newZ = z;
            switch (axis) {
              case 'x':
                newY = y * cos - z * sin;
                newZ = y * sin + z * cos;
                break;
              case 'y':
                newX = x * cos - z * sin;
                newZ = x * sin + z * cos;
                break;
              case 'z':
                newX = x * cos - y * sin;
                newY = x * sin + y * cos;
                break;
            }
            
            return [newX + origin[0], newY + origin[1], newZ + origin[2]];
          });
        }
      }
      
      // Apply block-level rotation
      if (rotX !== 0 || rotY !== 0) {
        vertices = vertices.map(v => rotateVertex(v, rotX, rotY));
      }
      
      // Get normal
      let normal = FACE_NORMALS[faceName] || [0, 0, 0];
      if (rotX !== 0 || rotY !== 0) {
        normal = rotateNormal(normal, rotX, rotY);
      }
      
      // Get UVs
      let uvs;
      if (faceData.uv) {
        const [u0, v0, u1, v1] = faceData.uv.map(v => v / 16);
        uvs = [
          [u0, v1],
          [u1, v1],
          [u1, v0],
          [u0, v0],
        ];
      } else {
        // Auto-generate UVs based on face
        uvs = [[0, 1], [1, 1], [1, 0], [0, 0]];
      }
      
      // Handle UV rotation
      if (faceData.rotation) {
        const steps = (faceData.rotation / 90) % 4;
        for (let i = 0; i < steps; i++) {
          uvs = [uvs[3], uvs[0], uvs[1], uvs[2]];
        }
      }
      
      // Cullface
      let cullface = faceData.cullface || 'none';
      if (rotX !== 0 || rotY !== 0) {
        cullface = rotateCullface(cullface, rotX, rotY);
      }
      
      faces.push({
        direction: DIRECTION[faceName] || 6,
        cullface: cullface === 'none' ? 0xFF : DIRECTION[cullface],
        tintType,
        textureIndex,
        vertices: vertices.flat(),
        uvs: uvs.flat(),
        normal,
      });
    }
  }
  
  return { faces, hasAO: model.ambientocclusion };
}

function writeBinary(manifest) {
  const chunks = [];
  let totalSize = 0;
  
  // Collect all blocks
  const blocks = Object.entries(manifest.blocks);
  
  console.log(`Baking geometry for ${blocks.length} blocks...`);
  
  // Build block data
  const blockDataList = [];
  let bakedVariants = 0;
  let bakedFaces = 0;
  
  for (const [blockName, blockInfo] of blocks) {
    const variants = [];
    
    for (const [variantKey, variantInfo] of Object.entries(blockInfo.variants)) {
      const model = resolveModel(variantInfo.model);
      if (!model) continue;
      
      const geometry = computeGeometry(
        model,
        variantInfo.rotX || 0,
        variantInfo.rotY || 0,
        variantInfo.uvlock || false
      );
      
      if (!geometry || geometry.faces.length === 0) continue;
      
      variants.push({
        key: variantKey,
        faces: geometry.faces,
        hasAO: geometry.hasAO,
      });
      
      bakedVariants++;
      bakedFaces += geometry.faces.length;
    }
    
    // CRITICAL: Include ALL blocks, even with 0 variants, to keep indices aligned
    // with ModelStateLookup which assigns indices to all manifest blocks.
    // Blocks with 0 variants simply won't render any geometry.
    blockDataList.push({
      name: blockName,
      flags: blockInfo.flags || {},
      variants,
    });
  }
  
  console.log(`Baked ${bakedVariants} variants with ${bakedFaces} faces`);
  console.log(`Unique textures: ${textureMap.size}`);
  
  // Calculate sizes
  const HEADER_SIZE = 12; // magic + version + block count
  let indexSize = 0;
  let dataSize = 0;
  
  for (const block of blockDataList) {
    indexSize += 2 + block.name.length + 4; // nameLen + name + offset
    
    // Block data: variantCount + flags
    let blockSize = 2;
    
    for (const variant of block.variants) {
      // Variant: keyLen + key + faceCount
      blockSize += 1 + variant.key.length + 2;
      
      // Faces: each face is 1 + 1 + 1 + 2 + 48 + 32 + 12 = 97 bytes
      blockSize += variant.faces.length * 97;
    }
    
    dataSize += blockSize;
  }
  
  const totalBytes = HEADER_SIZE + indexSize + dataSize;
  const buffer = Buffer.alloc(totalBytes);
  let offset = 0;
  
  // Write header
  buffer.writeUInt32LE(0x424B4D44, offset); offset += 4; // Magic "BKMD"
  buffer.writeUInt32LE(1, offset); offset += 4; // Version
  buffer.writeUInt32LE(blockDataList.length, offset); offset += 4;
  
  // Write index
  const indexStart = offset;
  const dataStart = indexStart + indexSize;
  let currentDataOffset = 0;
  
  for (const block of blockDataList) {
    buffer.writeUInt16LE(block.name.length, offset); offset += 2;
    buffer.write(block.name, offset, 'utf-8'); offset += block.name.length;
    buffer.writeUInt32LE(currentDataOffset, offset); offset += 4;
    
    // Calculate block data size for offset
    let blockSize = 2;
    for (const variant of block.variants) {
      blockSize += 1 + variant.key.length + 2;
      blockSize += variant.faces.length * 97;
    }
    currentDataOffset += blockSize;
  }
  
  // Write data
  for (const block of blockDataList) {
    // Variant count
    buffer.writeUInt8(block.variants.length, offset); offset += 1;
    
    // Flags
    let flags = 0;
    if (block.flags.hasRandomRotation) flags |= 0x01;
    if (block.flags.hasPositionOffset) flags |= 0x02;
    if (block.flags.isTransparent) flags |= 0x04;
    buffer.writeUInt8(flags, offset); offset += 1;
    
    for (const variant of block.variants) {
      // Variant key
      buffer.writeUInt8(variant.key.length, offset); offset += 1;
      buffer.write(variant.key, offset, 'utf-8'); offset += variant.key.length;
      
      // Face count
      buffer.writeUInt16LE(variant.faces.length, offset); offset += 2;
      
      for (const face of variant.faces) {
        buffer.writeUInt8(face.direction, offset); offset += 1;
        buffer.writeUInt8(face.cullface, offset); offset += 1;
        buffer.writeUInt8(face.tintType, offset); offset += 1;
        buffer.writeUInt16LE(face.textureIndex, offset); offset += 2;
        
        // Vertices (12 floats)
        for (let i = 0; i < 12; i++) {
          buffer.writeFloatLE(face.vertices[i], offset); offset += 4;
        }
        
        // UVs (8 floats)
        for (let i = 0; i < 8; i++) {
          buffer.writeFloatLE(face.uvs[i], offset); offset += 4;
        }
        
        // Normal (3 floats)
        for (let i = 0; i < 3; i++) {
          buffer.writeFloatLE(face.normal[i], offset); offset += 4;
        }
      }
    }
  }
  
  // Write texture map as separate file
  const textureMapPath = OUTPUT_PATH.replace('.bin', '-textures.json');
  const textureMapData = Object.fromEntries(textureMap);
  fs.writeFileSync(textureMapPath, JSON.stringify(textureMapData, null, 2));
  
  console.log(`\nOutput:`);
  console.log(`  Binary: ${OUTPUT_PATH} (${(buffer.length / 1024).toFixed(1)} KB)`);
  console.log(`  Textures: ${textureMapPath}`);
  
  return buffer;
}

async function main() {
  console.log('Loading manifest...');
  const manifest = loadJson(MANIFEST_PATH);
  
  if (!manifest) {
    console.error('Failed to load manifest. Run analyze-block-models.js first.');
    process.exit(1);
  }
  
  console.log(`Manifest loaded: ${Object.keys(manifest.blocks).length} blocks`);
  
  const binary = writeBinary(manifest);
  
  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(OUTPUT_PATH, binary);
  
  console.log('\nDone!');
}

main().catch(console.error);
