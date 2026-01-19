#!/usr/bin/env node
/**
 * Block Entity Geometry Baking Script
 * 
 * Converts the block-entity-models.json into a binary format for WASM consumption.
 * This is similar to bake-entity-geometry.js but uses the new extracted models
 * and the updated format that supports variants properly.
 * 
 * Output: public/assets/baked-block-entities.bin
 * 
 * Binary Format:
 * [header]
 *   u32: magic (0x424C454E = "BLEN" - Block ENtity)
 *   u32: version
 *   u32: model count
 * 
 * [model index] (for each model)
 *   u16: model name length
 *   bytes: model name (e.g., "chest_single", "bed_head")
 *   u32: offset to model data from start of data section
 * 
 * [model data] (for each model)
 *   u16: texture_width
 *   u16: texture_height
 *   u16: element count
 *   [element] (for each element)
 *     f32[3]: from (x, y, z)
 *     f32[3]: to (x, y, z)
 *     u8: face_mask (bit flags for which faces exist)
 *     [face] (for each face in mask order: down, up, north, south, west, east)
 *       f32[4]: uv (u1, v1, u2, v2)
 * 
 * Usage:
 *   node scripts/bake-block-entities.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const MODELS_PATH = path.join(__dirname, '../public/assets/block-entity-models.json');
const MANIFEST_PATH = path.join(__dirname, '../public/assets/block-entity-manifest.json');
const OUTPUT_PATH = path.join(__dirname, '../public/assets/baked-block-entities.bin');
const TEXTURE_MAP_PATH = path.join(__dirname, '../public/assets/baked-block-entities-textures.json');

// Face direction encoding
const FACE_DIRECTION = {
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

/**
 * Load a JSON file
 */
function loadJson(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Failed to load ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Get face vertices from element bounds
 */
function getFaceVertices(from, to, faceName) {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;
  
  // Vertices in CCW order when viewed from outside
  switch (faceName) {
    case 'down':
      return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
    case 'up':
      return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
    case 'north':
      return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
    case 'south':
      return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
    case 'west':
      return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
    case 'east':
      return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
    default:
      return null;
  }
}

/**
 * Convert element to face data for binary output
 */
function processElement(element) {
  const faces = [];
  
  // Convert coordinates from Minecraft units (0-16) to block space (0-1)
  const from = element.from.map(v => v / 16);
  const to = element.to.map(v => v / 16);
  
  const faceOrder = ['down', 'up', 'north', 'south', 'west', 'east'];
  let faceMask = 0;
  
  for (let i = 0; i < faceOrder.length; i++) {
    const faceName = faceOrder[i];
    const faceData = element.faces?.[faceName];
    
    if (!faceData) continue;
    
    faceMask |= (1 << i);
    
    const vertices = getFaceVertices(from, to, faceName);
    const uv = faceData.uv; // Already normalized 0-1
    const normal = FACE_NORMALS[faceName];
    
    faces.push({
      direction: FACE_DIRECTION[faceName],
      vertices,
      uv,
      normal,
    });
  }
  
  return {
    from,
    to,
    faceMask,
    faces,
  };
}

/**
 * Process a model and return structured data
 */
function processModel(modelName, modelData) {
  const elements = [];
  
  for (const element of modelData.elements) {
    elements.push(processElement(element));
  }
  
  return {
    name: modelName,
    textureSize: modelData.texture_size,
    elements,
  };
}

/**
 * Write binary output
 */
function writeBinary(models) {
  console.log(`Baking geometry for ${Object.keys(models).length} block entity models...`);
  
  // Process all models
  const processedModels = [];
  let totalFaces = 0;
  
  for (const [modelName, modelData] of Object.entries(models)) {
    const processed = processModel(modelName, modelData);
    processedModels.push(processed);
    
    const faceCount = processed.elements.reduce((sum, e) => sum + e.faces.length, 0);
    totalFaces += faceCount;
    console.log(`  ✓ ${modelName}: ${processed.elements.length} elements, ${faceCount} faces`);
  }
  
  console.log(`\nTotal: ${processedModels.length} models, ${totalFaces} faces`);
  
  // Calculate buffer size
  const HEADER_SIZE = 12; // magic + version + model count
  let indexSize = 0;
  let dataSize = 0;
  
  for (const model of processedModels) {
    indexSize += 2 + model.name.length + 4; // nameLen + name + offset
    
    // Model data: texW(2) + texH(2) + elementCount(2) = 6 bytes header
    let modelSize = 6;
    
    for (const element of model.elements) {
      // Element: from(12) + to(12) + faceMask(1) = 25 bytes base
      modelSize += 25;
      
      // Each face: direction(1) + vertices(48) + uv(16) + normal(12) = 77 bytes
      // Actually we'll use a more compact format:
      // Each face: uv(16) only since vertices computed from from/to
      modelSize += element.faces.length * 16;
    }
    
    dataSize += modelSize;
  }
  
  const totalBytes = HEADER_SIZE + indexSize + dataSize;
  const buffer = Buffer.alloc(totalBytes);
  let offset = 0;
  
  // Write header
  buffer.writeUInt32LE(0x424C454E, offset); offset += 4; // Magic "BLEN"
  buffer.writeUInt32LE(2, offset); offset += 4; // Version 2
  buffer.writeUInt32LE(processedModels.length, offset); offset += 4;
  
  // Write index
  const indexStart = offset;
  let currentDataOffset = 0;
  const modelDataOffsets = [];
  
  for (const model of processedModels) {
    buffer.writeUInt16LE(model.name.length, offset); offset += 2;
    buffer.write(model.name, offset, 'utf-8'); offset += model.name.length;
    
    modelDataOffsets.push({ offset, dataOffset: currentDataOffset });
    buffer.writeUInt32LE(currentDataOffset, offset); offset += 4;
    
    // Calculate this model's data size
    let modelSize = 6;
    for (const element of model.elements) {
      modelSize += 25;
      modelSize += element.faces.length * 16;
    }
    currentDataOffset += modelSize;
  }
  
  // Write data section
  const dataStart = offset;
  
  for (let i = 0; i < processedModels.length; i++) {
    const model = processedModels[i];
    
    // Update offset in index
    buffer.writeUInt32LE(offset - dataStart, modelDataOffsets[i].offset);
    
    // Texture size
    buffer.writeUInt16LE(model.textureSize[0], offset); offset += 2;
    buffer.writeUInt16LE(model.textureSize[1], offset); offset += 2;
    
    // Element count
    buffer.writeUInt16LE(model.elements.length, offset); offset += 2;
    
    // Elements
    for (const element of model.elements) {
      // From (3 floats)
      buffer.writeFloatLE(element.from[0], offset); offset += 4;
      buffer.writeFloatLE(element.from[1], offset); offset += 4;
      buffer.writeFloatLE(element.from[2], offset); offset += 4;
      
      // To (3 floats)
      buffer.writeFloatLE(element.to[0], offset); offset += 4;
      buffer.writeFloatLE(element.to[1], offset); offset += 4;
      buffer.writeFloatLE(element.to[2], offset); offset += 4;
      
      // Face mask
      buffer.writeUInt8(element.faceMask, offset); offset += 1;
      
      // Faces (UV only - vertices computed from from/to)
      for (const face of element.faces) {
        buffer.writeFloatLE(face.uv[0], offset); offset += 4;
        buffer.writeFloatLE(face.uv[1], offset); offset += 4;
        buffer.writeFloatLE(face.uv[2], offset); offset += 4;
        buffer.writeFloatLE(face.uv[3], offset); offset += 4;
      }
    }
  }
  
  console.log(`\nOutput: ${OUTPUT_PATH} (${(buffer.length / 1024).toFixed(1)} KB)`);
  
  return buffer.slice(0, offset); // Trim to actual size
}

/**
 * Main entry point
 */
async function main() {
  console.log('=== Block Entity Geometry Baking ===\n');
  
  // Load models
  const modelsData = loadJson(MODELS_PATH);
  if (!modelsData || !modelsData.models) {
    console.error('Failed to load block entity models. Run extract-block-entities.py first.');
    process.exit(1);
  }
  
  console.log(`Loaded ${Object.keys(modelsData.models).length} models from ${MODELS_PATH}`);
  
  // Bake geometry
  const binary = writeBinary(modelsData.models);
  
  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(OUTPUT_PATH, binary);
  
  // Also write a more detailed JSON output for debugging/JavaScript usage
  const detailedOutput = {
    version: 2,
    models: {},
  };
  
  for (const [modelName, modelData] of Object.entries(modelsData.models)) {
    const processed = processModel(modelName, modelData);
    detailedOutput.models[modelName] = {
      textureSize: processed.textureSize,
      elements: processed.elements.map(e => ({
        from: e.from,
        to: e.to,
        faces: e.faces.map(f => ({
          direction: f.direction,
          uv: f.uv,
          normal: f.normal,
        })),
      })),
    };
  }
  
  const jsonOutputPath = OUTPUT_PATH.replace('.bin', '.json');
  fs.writeFileSync(jsonOutputPath, JSON.stringify(detailedOutput, null, 2));
  console.log(`JSON output: ${jsonOutputPath}`);
  
  console.log('\nDone!');
}

main().catch(console.error);
