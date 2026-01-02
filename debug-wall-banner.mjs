/**
 * Debug: Check what geometry (if any) is generated for wall banners
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const modelsDir = path.join(__dirname, 'textures/1.21.11+Template/assets/minecraft/models/block');
  
  console.log('=== Checking banner models for elements ===\n');
  
  // Check banner.json which is used by wall_banner
  const bannerPath = path.join(modelsDir, 'banner.json');
  const bannerContent = JSON.parse(fs.readFileSync(bannerPath, 'utf-8'));
  console.log('banner.json:');
  console.log(JSON.stringify(bannerContent, null, 2));
  
  console.log('\nBanner has elements:', !!bannerContent.elements);
  console.log('Banner parent:', bannerContent.parent || 'none');
  
  // Check if there's a parent we need to follow
  if (bannerContent.parent) {
    const parentPath = bannerContent.parent.replace('minecraft:', '').replace('block/', '');
    const parentFile = path.join(modelsDir, `${parentPath}.json`);
    if (fs.existsSync(parentFile)) {
      const parentContent = JSON.parse(fs.readFileSync(parentFile, 'utf-8'));
      console.log('\nParent model:');
      console.log(JSON.stringify(parentContent, null, 2));
    }
  }
  
  // Check the wall_banner blockstate
  const blockstatesDir = path.join(__dirname, 'textures/1.21.11+Template/assets/minecraft/blockstates');
  const wallBannerPath = path.join(blockstatesDir, 'brown_wall_banner.json');
  const wallBannerState = JSON.parse(fs.readFileSync(wallBannerPath, 'utf-8'));
  console.log('\nbrown_wall_banner.json blockstate:');
  console.log(JSON.stringify(wallBannerState, null, 2));
  
  // Also check if there might be a different model being used
  const modelVariant = wallBannerState.variants?.['']?.model || 'unknown';
  console.log('\nModel being used:', modelVariant);
  
  // Get the actual model
  const modelName = modelVariant.replace('minecraft:block/', '');
  const modelFile = path.join(modelsDir, `${modelName}.json`);
  if (fs.existsSync(modelFile)) {
    const modelContent = JSON.parse(fs.readFileSync(modelFile, 'utf-8'));
    console.log(`\n${modelName}.json content:`);
    console.log(JSON.stringify(modelContent, null, 2));
    
    if (modelContent.elements) {
      console.log(`\n⚠️  ${modelName}.json HAS ${modelContent.elements.length} elements!`);
      for (const el of modelContent.elements) {
        console.log(`  from [${el.from.join(',')}] to [${el.to.join(',')}]`);
      }
    } else {
      console.log(`\n✓ ${modelName}.json has no elements (entity-rendered block)`);
    }
  }
}

main().catch(console.error);

