/**
 * Debug script that runs the actual mesher on a specific region
 * and analyzes the mesh triangles around a coordinate to find artifact sources
 */
import { parseMCAFromPath } from './test/helpers/nodeMcaParser.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Target coordinates (from user)
const TARGET_X = -236;
const TARGET_Y = 76;
const TARGET_Z = -213;
const INSPECT_RADIUS = 2; // Check triangles within this radius

// Import meshing infrastructure
// We need to mock the browser environment first
global.performance = { now: () => Date.now() };

async function main() {
  console.log(`\n=== Running mesher to analyze triangles near (${TARGET_X}, ${TARGET_Y}, ${TARGET_Z}) ===\n`);
  
  // We can't easily run the full mesher in Node without setting up the whole environment
  // Instead, let's look at what the actual model for wall_banner produces
  
  // Check the model file directly
  const fs = await import('fs');
  const modelsDir = path.join(__dirname, 'textures/1.21.11+Template/assets/minecraft/models/block');
  
  // List model files that might be related to what user sees
  console.log('=== Checking relevant model files ===\n');
  
  const interestingBlocks = [
    'banner',
    'wall_banner', 
    'lantern',
    'soul_lantern',
    'cave_vines',
    'cave_vines_plant',
    'hanging_roots',
    'spruce_fence_post',
    'spruce_fence_side',
    'trapdoor',
  ];
  
  for (const blockName of interestingBlocks) {
    const modelPath = path.join(modelsDir, `${blockName}.json`);
    try {
      const content = fs.readFileSync(modelPath, 'utf-8');
      const model = JSON.parse(content);
      
      if (model.elements && model.elements.length > 0) {
        console.log(`\n${blockName}.json: ${model.elements.length} element(s)`);
        for (let i = 0; i < model.elements.length; i++) {
          const el = model.elements[i];
          const from = el.from;
          const to = el.to;
          const size = [to[0]-from[0], to[1]-from[1], to[2]-from[2]];
          console.log(`  Element ${i}: from [${from.join(', ')}] to [${to.join(', ')}] size [${size.join(', ')}]`);
          
          // Check if this is a very thin element (potential artifact source)
          const minSize = Math.min(...size);
          if (minSize < 0.5) {
            console.log(`    ⚠️  VERY THIN element (${minSize} pixels)!`);
          }
          
          // Check what faces it has
          if (el.faces) {
            const faceList = Object.keys(el.faces);
            console.log(`    Faces: ${faceList.join(', ')}`);
          }
        }
      } else {
        console.log(`${blockName}.json: NO ELEMENTS (entity-rendered or inherits)`);
        if (model.parent) {
          console.log(`  Parent: ${model.parent}`);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.log(`${blockName}.json: Error - ${e.message}`);
      }
    }
  }
  
  // Check for cave_vines variations
  console.log('\n=== Cave vines models ===');
  const vinesModels = fs.readdirSync(modelsDir)
    .filter(f => f.includes('cave_vine'))
    .slice(0, 10);
  
  for (const model of vinesModels) {
    const modelPath = path.join(modelsDir, model);
    const content = fs.readFileSync(modelPath, 'utf-8');
    const parsed = JSON.parse(content);
    console.log(`\n${model}:`);
    if (parsed.parent) console.log(`  Parent: ${parsed.parent}`);
    if (parsed.elements) {
      console.log(`  Elements: ${parsed.elements.length}`);
      for (const el of parsed.elements) {
        const from = el.from;
        const to = el.to;
        console.log(`    from [${from.join(', ')}] to [${to.join(', ')}]`);
      }
    }
  }
  
  // Look for the "cross" parent model since many plants use it
  console.log('\n=== Cross model (used by many plants) ===');
  const crossPath = path.join(modelsDir, 'cross.json');
  try {
    const content = fs.readFileSync(crossPath, 'utf-8');
    const model = JSON.parse(content);
    console.log('cross.json:');
    if (model.elements) {
      for (const el of model.elements) {
        console.log(`  Element: from [${el.from.join(', ')}] to [${el.to.join(', ')}]`);
        if (el.rotation) {
          console.log(`    Rotation: ${JSON.stringify(el.rotation)}`);
        }
      }
    }
  } catch (e) {
    console.log('Could not read cross.json');
  }
}

main().catch(console.error);





