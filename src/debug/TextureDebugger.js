/**
 * TextureDebugger - Comprehensive debug utility for texture resolution
 * 
 * Traces through the entire pipeline:
 * 1. Block name -> Block ID mapping
 * 2. Block ID -> Geometry lookup  
 * 3. Geometry -> Per-face textures
 * 4. Texture path -> Atlas index
 * 5. Final verification
 */

import { getBlockRegistry } from '../mesh/BlockRegistry.js';
import { getGeometryRegistry } from '../assets/GeometryRegistry.js';
import { getTextureAtlas } from '../assets/TextureAtlas.js';
import { getBlockstateResolver } from '../assets/BlockstateResolver.js';
import { getModelResolver } from '../assets/ModelResolver.js';

/**
 * Debug a specific block's texture resolution
 */
export async function debugBlockTextures(blockName) {
  const name = blockName.replace('minecraft:', '');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`DEBUGGING BLOCK: ${name}`);
  console.log('='.repeat(60));
  
  const results = {
    blockName: name,
    issues: [],
    success: true,
  };
  
  // Step 1: Check BlockRegistry
  console.log('\n--- Step 1: BlockRegistry ---');
  const registry = getBlockRegistry();
  const blockId = registry.nameToId.get(name) || registry.nameToId.get(`minecraft:${name}`);
  
  if (blockId === undefined) {
    console.error(`  ❌ Block not registered in BlockRegistry`);
    results.issues.push('Block not registered');
    results.success = false;
    return results;
  }
  console.log(`  ✓ Block ID: ${blockId}`);
  results.blockId = blockId;
  
  // Step 2: Check GeometryRegistry
  console.log('\n--- Step 2: GeometryRegistry ---');
  const geomRegistry = getGeometryRegistry();
  
  if (!geomRegistry.loaded) {
    console.error(`  ❌ GeometryRegistry not loaded!`);
    results.issues.push('GeometryRegistry not loaded');
    results.success = false;
    return results;
  }
  
  const geometries = geomRegistry.getGeometry(name, {});
  
  if (!geometries || geometries.length === 0) {
    console.warn(`  ⚠️ No geometry found for ${name}`);
    results.issues.push('No geometry in GeometryRegistry');
    
    // Try to understand why - check blockstate
    console.log('  Checking blockstate...');
    const resolver = getBlockstateResolver();
    const variants = resolver.resolve(name, {});
    if (variants && variants.length > 0) {
      console.log(`  Blockstate variants found: ${variants.length}`);
      console.log(`  First variant model: ${variants[0].model}`);
    } else {
      console.log(`  No blockstate variants found`);
    }
  } else {
    console.log(`  ✓ Found ${geometries.length} geometry variant(s)`);
    const geom = geometries[0];
    console.log(`  Vertex count: ${geom.vertexCount}`);
    console.log(`  Is full cube: ${geom.isFullCube}`);
    console.log(`  CullFaces count: ${geom.cullFaces?.length || 0}`);
    
    results.geometry = {
      vertexCount: geom.vertexCount,
      isFullCube: geom.isFullCube,
      cullFacesCount: geom.cullFaces?.length || 0,
    };
    
    // Step 3: Check per-face textures from geometry
    console.log('\n--- Step 3: Per-face textures from geometry ---');
    const faceTextures = {};
    
    if (geom.cullFaces) {
      for (const face of geom.cullFaces) {
        const faceName = face.cullface || 'internal';
        const texture = face.texture || '(none)';
        const tintindex = face.tintindex;
        
        if (!faceTextures[faceName]) {
          faceTextures[faceName] = texture;
          console.log(`  ${faceName}: ${texture}${tintindex >= 0 ? ` (tint: ${tintindex})` : ''}`);
        }
      }
    }
    
    results.faceTextures = faceTextures;
    
    // Check if we have all 6 faces
    const expectedFaces = ['up', 'down', 'north', 'south', 'east', 'west'];
    const missingFaces = expectedFaces.filter(f => !faceTextures[f]);
    if (missingFaces.length > 0) {
      console.warn(`  ⚠️ Missing faces: ${missingFaces.join(', ')}`);
      results.issues.push(`Missing faces: ${missingFaces.join(', ')}`);
    }
  }
  
  // Step 4: Check TextureAtlas mapping
  console.log('\n--- Step 4: TextureAtlas mapping ---');
  const atlas = getTextureAtlas();
  
  if (!atlas.isBuilt) {
    console.error(`  ❌ TextureAtlas not built!`);
    results.issues.push('TextureAtlas not built');
    results.success = false;
    return results;
  }
  
  const lookup = atlas.textureIndexLookup;
  if (!lookup) {
    console.error(`  ❌ TextureIndexLookup not created!`);
    results.issues.push('TextureIndexLookup not created');
    results.success = false;
    return results;
  }
  
  console.log(`  TexturePathToIndex has ${atlas.texturePathToIndex.size} entries`);
  
  // Check each expected texture
  if (results.faceTextures) {
    console.log('\n  Texture path resolution:');
    for (const [faceName, texPath] of Object.entries(results.faceTextures)) {
      if (texPath === '(none)') continue;
      
      const index = lookup.getIndexByPath(texPath);
      const inAtlas = atlas.texturePathToIndex.has(texPath) || 
                      atlas.texturePathToIndex.has(`block/${texPath}`) ||
                      atlas.texturePathToIndex.has(`textures/block/${texPath}.png`);
      
      if (inAtlas) {
        console.log(`  ✓ ${faceName}: "${texPath}" -> atlas index ${index}`);
      } else {
        console.warn(`  ❌ ${faceName}: "${texPath}" NOT FOUND in atlas (using default ${index})`);
        results.issues.push(`Texture not in atlas: ${texPath}`);
      }
    }
  }
  
  // Step 5: Check final TextureIndexLookup values
  console.log('\n--- Step 5: Final TextureIndexLookup values ---');
  const faces = ['up', 'down', 'north', 'south', 'east', 'west'];
  results.finalIndices = {};
  
  for (let i = 0; i < 6; i++) {
    const faceName = faces[i];
    const index = lookup.getIndex(blockId, i);
    results.finalIndices[faceName] = index;
    console.log(`  ${faceName}: atlas index ${index}`);
  }
  
  // Check if all faces have the same index (potential issue for multi-face blocks)
  const uniqueIndices = new Set(Object.values(results.finalIndices));
  if (uniqueIndices.size === 1 && Object.keys(results.faceTextures || {}).length > 1) {
    console.warn(`  ⚠️ All faces have same atlas index ${[...uniqueIndices][0]} - may indicate broken resolution`);
    results.issues.push('All faces have same texture index');
  }
  
  console.log(`\n${'='.repeat(60)}`);
  if (results.issues.length > 0) {
    console.log(`ISSUES FOUND: ${results.issues.length}`);
    results.issues.forEach(i => console.log(`  - ${i}`));
  } else {
    console.log('NO ISSUES FOUND');
  }
  console.log('='.repeat(60) + '\n');
  
  return results;
}

/**
 * Debug multiple common blocks
 */
export async function debugCommonBlocks() {
  const blocks = [
    'stone',
    'dirt', 
    'grass_block',
    'oak_log',
    'oak_planks',
    'cobblestone',
    'crafting_table',
    'furnace',
    'oak_slab',
    'oak_stairs',
  ];
  
  const results = [];
  for (const block of blocks) {
    results.push(await debugBlockTextures(block));
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  for (const r of results) {
    const status = r.success && r.issues.length === 0 ? '✓' : '❌';
    console.log(`${status} ${r.blockName}: ${r.issues.length} issues`);
  }
  
  return results;
}

/**
 * Check what's in the texture atlas
 */
export function debugAtlasContents() {
  const atlas = getTextureAtlas();
  
  console.log('\n' + '='.repeat(60));
  console.log('TEXTURE ATLAS CONTENTS');
  console.log('='.repeat(60));
  
  if (!atlas.isBuilt) {
    console.error('Atlas not built!');
    return;
  }
  
  console.log(`\nAtlas size: ${atlas.atlasWidth}x${atlas.atlasHeight}`);
  console.log(`Tiles: ${atlas.tilesPerRow} x ${atlas.tilesPerCol}`);
  console.log(`Total paths: ${atlas.texturePathToIndex.size}`);
  
  // Sample paths
  console.log('\nSample texture paths:');
  const paths = Array.from(atlas.texturePathToIndex.keys());
  paths.slice(0, 30).forEach(p => {
    console.log(`  ${atlas.texturePathToIndex.get(p)}: ${p}`);
  });
  
  // Search for specific textures
  console.log('\nSearching for key textures:');
  const searchTerms = ['grass_block', 'oak_log', 'stone', 'dirt', 'crafting_table'];
  
  for (const term of searchTerms) {
    const matches = paths.filter(p => p.includes(term));
    console.log(`\n"${term}" matches:`);
    matches.forEach(m => console.log(`  ${atlas.texturePathToIndex.get(m)}: ${m}`));
  }
}

/**
 * Trace a specific block from raw model JSON to final texture
 */
export async function traceBlockModel(blockName) {
  const name = blockName.replace('minecraft:', '');
  
  console.log('\n' + '='.repeat(60));
  console.log(`TRACING MODEL: ${name}`);
  console.log('='.repeat(60));
  
  const atlas = getTextureAtlas();
  
  // Get blockstate
  const blockstateResolver = getBlockstateResolver();
  await blockstateResolver.getBlockstate(name);
  
  console.log('\n--- Blockstate Resolution ---');
  console.log(`  BlockstateResolver has packManager: ${!!blockstateResolver.packManager}`);
  
  const rawBlockstate = blockstateResolver.blockstates.get(name);
  if (rawBlockstate) {
    console.log(`  Blockstate format: ${rawBlockstate.variants ? 'variants' : (rawBlockstate.multipart ? 'multipart' : 'unknown')}`);
    if (rawBlockstate.variants) {
      console.log(`  Variant keys: ${Object.keys(rawBlockstate.variants).slice(0, 5).join(', ')}...`);
    }
  } else {
    console.log(`  ❌ No blockstate loaded for ${name}`);
  }
  
  const variants = blockstateResolver.resolve(name, {});
  
  if (!variants || variants.length === 0) {
    console.log('No variants found for default state');
    return;
  }
  
  console.log(`Found ${variants.length} variant(s)`);
  
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    console.log(`\nVariant ${i}:`);
    console.log(`  Model: ${v.model}`);
    console.log(`  Rotation: x=${v.x || 0}, y=${v.y || 0}`);
    console.log(`  UV Lock: ${v.uvlock || false}`);
    
    // Resolve model
    const modelResolver = getModelResolver();
    console.log(`  ModelResolver has packManager: ${!!modelResolver.packManager}`);
    
    const model = await modelResolver.resolve(v.model);
    
    if (!model) {
      console.log(`  ❌ Could not resolve model`);
      continue;
    }
    
    console.log(`\n  Model details:`);
    console.log(`    Elements: ${model.elements?.length || 0}`);
    console.log(`    Textures:`, model.textures || {});
    
    // Check if textures exist in atlas
    if (model.textures) {
      console.log(`\n  Texture atlas check:`);
      for (const [varName, texPath] of Object.entries(model.textures)) {
        const cleanPath = texPath.replace('minecraft:', '');
        const inAtlas = atlas.texturePathToIndex.has(cleanPath);
        const idx = atlas.texturePathToIndex.get(cleanPath);
        console.log(`    ${varName}: "${cleanPath}" -> atlas=${inAtlas ? idx : 'NOT FOUND'}`);
      }
    }
    
    if (model.elements) {
      console.log(`\n  Elements with faces:`);
      for (let ei = 0; ei < model.elements.length; ei++) {
        const el = model.elements[ei];
        console.log(`    Element ${ei}: from=[${el.from}] to=[${el.to}]`);
        
        if (el.faces) {
          for (const [faceName, faceData] of Object.entries(el.faces)) {
            const textureRef = faceData.texture;
            // Resolve texture reference
            let resolvedTex = textureRef;
            if (textureRef?.startsWith('#')) {
              const varName = textureRef.substring(1);
              resolvedTex = model.textures?.[varName] || textureRef;
              // Follow chain
              while (resolvedTex?.startsWith('#')) {
                const nextVar = resolvedTex.substring(1);
                resolvedTex = model.textures?.[nextVar] || resolvedTex;
              }
            }
            
            // Check final resolved texture in atlas
            const cleanResolved = resolvedTex?.replace('minecraft:', '');
            const inAtlas = cleanResolved ? atlas.texturePathToIndex.has(cleanResolved) : false;
            
            console.log(`      ${faceName}: ref="${textureRef}" -> "${cleanResolved}" [${inAtlas ? '✓' : '❌'}] cullface=${faceData.cullface || '(none)'}`);
          }
        }
      }
    }
  }
}

/**
 * Check if geometry has correct texture references
 */
export async function validateGeometryTextures(blockName) {
  const name = blockName.replace('minecraft:', '');
  
  console.log('\n' + '='.repeat(60));
  console.log(`VALIDATING GEOMETRY TEXTURES: ${name}`);
  console.log('='.repeat(60));
  
  const geomRegistry = getGeometryRegistry();
  const geometries = geomRegistry.getGeometry(name, {});
  
  if (!geometries || geometries.length === 0) {
    console.log('No geometry found');
    return;
  }
  
  const atlas = getTextureAtlas();
  
  for (let gi = 0; gi < geometries.length; gi++) {
    const geom = geometries[gi];
    console.log(`\nGeometry ${gi}:`);
    console.log(`  Vertices: ${geom.vertexCount}`);
    console.log(`  Full cube: ${geom.isFullCube}`);
    console.log(`  Primary texture: ${geom.primaryTexture}`);
    
    if (!geom.cullFaces) {
      console.log('  No cullFaces data!');
      continue;
    }
    
    console.log(`\n  CullFaces (${geom.cullFaces.length}):`);
    
    const textureCounts = {};
    for (const face of geom.cullFaces) {
      const tex = face.texture || '(null)';
      textureCounts[tex] = (textureCounts[tex] || 0) + 1;
      
      // Check if texture exists in atlas
      const inAtlas = tex !== '(null)' && (
        atlas.texturePathToIndex.has(tex) ||
        atlas.texturePathToIndex.has(`textures/${tex}.png`)
      );
      
      const status = tex === '(null)' ? '⚠️' : (inAtlas ? '✓' : '❌');
      console.log(`    ${status} cullface=${face.cullface || '(internal)'}, texture="${tex}", tintindex=${face.tintindex ?? -1}`);
    }
    
    console.log(`\n  Texture usage summary:`);
    for (const [tex, count] of Object.entries(textureCounts)) {
      console.log(`    ${tex}: ${count} faces`);
    }
  }
}

/**
 * Full end-to-end validation - compare what should be displayed vs what is displayed
 */
export async function validateEndToEnd(blockName) {
  const name = blockName.replace('minecraft:', '');
  
  console.log('\n' + '='.repeat(60));
  console.log(`END-TO-END VALIDATION: ${name}`);
  console.log('='.repeat(60));
  
  const atlas = getTextureAtlas();
  const blockRegistry = getBlockRegistry();
  const geomRegistry = getGeometryRegistry();
  
  // 1. Get the expected textures from the model
  console.log('\n--- Expected (from model) ---');
  const blockstateResolver = getBlockstateResolver();
  await blockstateResolver.getBlockstate(name);
  const variants = blockstateResolver.resolve(name, {});
  
  if (!variants || variants.length === 0) {
    console.log('No variants found!');
    return;
  }
  
  const modelResolver = getModelResolver();
  const model = await modelResolver.resolve(variants[0].model);
  
  if (!model) {
    console.log('Could not resolve model!');
    return;
  }
  
  const expectedTextures = {};
  const faceNames = ['up', 'down', 'north', 'south', 'east', 'west'];
  
  if (model.elements) {
    for (const element of model.elements) {
      if (element.faces) {
        for (const [faceName, faceData] of Object.entries(element.faces)) {
          const textureRef = faceData.texture;
          if (textureRef && !expectedTextures[faceName]) {
            // Resolve the reference
            let resolved = textureRef;
            if (resolved.startsWith('#')) {
              const varName = resolved.substring(1);
              resolved = model.textures?.[varName] || resolved;
              while (resolved?.startsWith('#')) {
                const nextVar = resolved.substring(1);
                resolved = model.textures?.[nextVar] || resolved;
              }
            }
            resolved = resolved?.replace('minecraft:', '');
            expectedTextures[faceName] = resolved;
          }
        }
      }
    }
  }
  
  console.log('Expected textures per face:');
  for (const face of faceNames) {
    const tex = expectedTextures[face] || '(none)';
    const inAtlas = tex !== '(none)' && atlas.texturePathToIndex.has(tex);
    const atlasIdx = atlas.texturePathToIndex.get(tex) ?? 'N/A';
    console.log(`  ${face}: "${tex}" (inAtlas=${inAtlas}, idx=${atlasIdx})`);
  }
  
  // 2. Get actual textures assigned via GeometryRegistry
  console.log('\n--- Actual (from GeometryRegistry) ---');
  const geometries = geomRegistry.getGeometry(name, {});
  
  if (!geometries || geometries.length === 0) {
    console.log('No geometry found in registry!');
  } else {
    const geom = geometries[0];
    const actualTextures = {};
    
    for (const face of geom.cullFaces || []) {
      if (face.cullface && !actualTextures[face.cullface]) {
        actualTextures[face.cullface] = face.texture;
      }
    }
    
    console.log('Actual textures per face (from geometry):');
    for (const face of faceNames) {
      const tex = actualTextures[face] || '(none)';
      const inAtlas = tex !== '(none)' && atlas.texturePathToIndex.has(tex);
      const atlasIdx = atlas.texturePathToIndex.get(tex) ?? 'N/A';
      const match = tex === expectedTextures[face] ? '✓' : '❌';
      console.log(`  ${face}: "${tex}" (inAtlas=${inAtlas}, idx=${atlasIdx}) ${match}`);
    }
  }
  
  // 3. Get what TextureIndexLookup is returning
  console.log('\n--- Actual (from TextureIndexLookup) ---');
  const blockId = blockRegistry.nameToId.get(`minecraft:${name}`);
  
  if (blockId === undefined) {
    console.log('Block not in registry!');
    return;
  }
  
  const lookup = atlas.getTextureIndexLookup();
  console.log('Texture indices assigned to this block:');
  
  for (let i = 0; i < 6; i++) {
    const face = faceNames[i];
    const idx = lookup.getIndex(blockId, i);
    
    // Find what texture this index corresponds to
    let textureName = '(unknown)';
    for (const [path, atlasIdx] of atlas.texturePathToIndex) {
      if (atlasIdx === idx) {
        textureName = path;
        break;
      }
    }
    
    const expectedTex = expectedTextures[face];
    const expectedIdx = atlas.texturePathToIndex.get(expectedTex);
    const match = (expectedIdx === idx) ? '✓' : '❌';
    
    console.log(`  ${face}: idx=${idx} ("${textureName}") expected=${expectedIdx} ${match}`);
  }
  
  console.log('\n' + '='.repeat(60) + '\n');
}

// Export for browser console access
if (typeof window !== 'undefined') {
  window.TextureDebugger = {
    debugBlockTextures,
    debugCommonBlocks,
    debugAtlasContents,
    traceBlockModel,
    validateGeometryTextures,
    validateEndToEnd,
    runFullDiagnostics,
  };
}

/**
 * Run all validation checks and output a summary
 */
export async function runFullDiagnostics() {
  console.log('\n' + '='.repeat(80));
  console.log('FULL TEXTURE PIPELINE DIAGNOSTICS');
  console.log('='.repeat(80));
  
  // Check atlas status
  const atlas = getTextureAtlas();
  console.log(`\nAtlas Status: ${atlas.isBuilt ? '✓ Built' : '❌ NOT BUILT'}`);
  console.log(`  Dimensions: ${atlas.atlasWidth}x${atlas.atlasHeight}`);
  console.log(`  Total textures: ${atlas.texturePathToIndex.size}`);
  
  // Check geometry registry
  const geomRegistry = getGeometryRegistry();
  console.log(`\nGeometry Registry: ${geomRegistry.loaded ? '✓ Loaded' : '❌ NOT LOADED'}`);
  console.log(`  Cache entries: ${geomRegistry.cache.size}`);
  console.log(`  State mappings: ${geomRegistry.stateToKeys.size}`);
  
  // Check blockstate resolver
  const blockstateResolver = getBlockstateResolver();
  console.log(`\nBlockstate Resolver:`);
  console.log(`  Blockstates loaded: ${blockstateResolver.blockstates.size}`);
  console.log(`  Has packManager: ${!!blockstateResolver.packManager}`);
  
  // Check model resolver
  const modelResolver = getModelResolver();
  console.log(`\nModel Resolver:`);
  console.log(`  Raw models: ${modelResolver.rawModels.size}`);
  console.log(`  Resolved models: ${modelResolver.resolvedModels.size}`);
  console.log(`  Has packManager: ${!!modelResolver.packManager}`);
  
  // Check block registry
  const blockRegistry = getBlockRegistry();
  console.log(`\nBlock Registry:`);
  console.log(`  Registered blocks: ${blockRegistry.idToInfo.length}`);
  console.log(`  Name mappings: ${blockRegistry.nameToId.size}`);
  
  // Check texture index lookup
  const lookup = atlas.getTextureIndexLookup();
  console.log(`\nTexture Index Lookup:`);
  console.log(`  Registered blocks: ${lookup?.registeredBlocks?.size || 0}`);
  console.log(`  Path mappings: ${lookup?.texturePathToIndex?.size || 0}`);
  
  // Validate specific blocks
  console.log('\n' + '-'.repeat(80));
  console.log('BLOCK VALIDATION');
  console.log('-'.repeat(80));
  
  const testBlocks = [
    'stone',
    'dirt',
    'grass_block',
    'oak_log',
    'oak_planks',
    'cobblestone',
    'crafting_table',
    'furnace',
    'oak_stairs',
    'oak_slab',
    'glass',
    'oak_leaves',
  ];
  
  let passCount = 0;
  let failCount = 0;
  
  for (const blockName of testBlocks) {
    const result = await validateBlockQuick(blockName);
    if (result.pass) {
      passCount++;
      console.log(`✓ ${blockName}: OK`);
    } else {
      failCount++;
      console.log(`❌ ${blockName}: ${result.issues.join(', ')}`);
    }
  }
  
  console.log('\n' + '='.repeat(80));
  console.log(`SUMMARY: ${passCount} passed, ${failCount} failed`);
  console.log('='.repeat(80) + '\n');
  
  return { passCount, failCount };
}

/**
 * Quick validation of a single block
 */
async function validateBlockQuick(blockName) {
  const name = blockName.replace('minecraft:', '');
  const issues = [];
  
  const blockRegistry = getBlockRegistry();
  const geomRegistry = getGeometryRegistry();
  const atlas = getTextureAtlas();
  
  // Check block ID
  const blockId = blockRegistry.nameToId.get(`minecraft:${name}`);
  if (blockId === undefined) {
    return { pass: false, issues: ['Not in registry'] };
  }
  
  // Check geometry
  const geoms = geomRegistry.getGeometry(name, {});
  if (!geoms || geoms.length === 0) {
    issues.push('No geometry');
    
    // Debug: check what keys exist for this block
    const allKeys = geomRegistry.stateToKeys ? 
      Array.from(geomRegistry.stateToKeys.keys()).filter(k => k.startsWith(name)) :
      [];
    if (allKeys.length > 0) {
      issues.push(`(keys exist: ${allKeys.slice(0, 2).join(', ')})`);
    }
  } else {
    // Check texture availability
    const missingTextures = [];
    for (const geom of geoms) {
      for (const face of (geom.cullFaces || [])) {
        if (face.texture && !atlas.texturePathToIndex.has(face.texture)) {
          missingTextures.push(face.texture);
        }
      }
    }
    if (missingTextures.length > 0) {
      const unique = [...new Set(missingTextures)];
      issues.push(`Missing textures: ${unique.join(', ')}`);
    }
  }
  
  // Check texture indices
  const lookup = atlas.getTextureIndexLookup();
  const indices = [];
  for (let i = 0; i < 6; i++) {
    indices.push(lookup.getIndex(blockId, i));
  }
  
  // All indices being 0 (default) might indicate a problem
  if (indices.every(i => i === lookup.defaultIndex)) {
    issues.push('All faces use default texture');
  }
  
  return { pass: issues.length === 0, issues };
}

export default {
  debugBlockTextures,
  debugCommonBlocks,
  debugAtlasContents,
  traceBlockModel,
  validateGeometryTextures,
  validateEndToEnd,
  runFullDiagnostics,
};

