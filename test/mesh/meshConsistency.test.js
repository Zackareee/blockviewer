/**
 * Mesh Consistency Tests with Chunk Stitching
 * 
 * Tests that mesh generation is consistent and that chunk stitching
 * (lighting and water continuity between chunks) works correctly.
 * 
 * Features:
 * - Mesh determinism verification
 * - Light continuity across chunk boundaries
 * - Water mesh continuity between chunks
 * - Super-chunk boundary handling
 * 
 * Usage:
 *   npm run test:mesh               # Run mesh consistency tests
 *   npm run test:mesh -- --update   # Update snapshots
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { parseMCAFromPath } from '../helpers/nodeMcaParser.js';
import { BinaryGrid } from '../../src/mesh/BinaryGrid.js';
import { LightGrid } from '../../src/mesh/LightGrid.js';
import { getBlockRegistry, resetBlockRegistry } from '../../src/mesh/BlockRegistry.js';
import { decodeChunk } from '../../src/mesh/ChunkDecoder.js';
import { buildGridMeshes } from '../../src/mesh/FastMesher.js';
import { propagateSkyLight } from '../../src/mesh/LightPropagator.js';
import { propagateBlockLight } from '../../src/mesh/BlockLightPropagator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

/**
 * Generate hash for mesh data
 */
function hashMeshData(meshData) {
  if (!meshData) return null;
  
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(meshData.positions.buffer));
  hash.update(Buffer.from(meshData.normals.buffer));
  if (meshData.colors) hash.update(Buffer.from(meshData.colors.buffer));
  if (meshData.indices) hash.update(Buffer.from(meshData.indices.buffer));
  
  return hash.digest('hex');
}

/**
 * Analyze light grid for continuity at chunk boundaries
 */
function analyzeLightContinuity(lightGrid, chunkCoords) {
  const issues = [];
  
  // For each adjacent pair of chunks, check light continuity at boundary
  for (let i = 0; i < chunkCoords.length; i++) {
    const chunk1 = chunkCoords[i];
    
    for (let j = i + 1; j < chunkCoords.length; j++) {
      const chunk2 = chunkCoords[j];
      
      // Check if chunks are adjacent in X
      if (chunk1.z === chunk2.z && Math.abs(chunk1.x - chunk2.x) === 1) {
        const boundaryIssues = checkXBoundaryLighting(
          lightGrid,
          Math.min(chunk1.x, chunk2.x),
          chunk1.z
        );
        issues.push(...boundaryIssues);
      }
      
      // Check if chunks are adjacent in Z
      if (chunk1.x === chunk2.x && Math.abs(chunk1.z - chunk2.z) === 1) {
        const boundaryIssues = checkZBoundaryLighting(
          lightGrid,
          chunk1.x,
          Math.min(chunk1.z, chunk2.z)
        );
        issues.push(...boundaryIssues);
      }
    }
  }
  
  return issues;
}

/**
 * Check lighting continuity at X boundary between two chunks
 */
function checkXBoundaryLighting(lightGrid, chunkX, chunkZ) {
  const issues = [];
  const SECTION_SIZE = 16;
  
  // Check all sections (y-levels)
  for (const [key, section] of lightGrid.sections) {
    const parts = key.split(',');
    const secCX = parseInt(parts[0], 10);
    const secCZ = parseInt(parts[1], 10);
    const secSY = parseInt(parts[2], 10);
    
    if (secCZ !== chunkZ) continue;
    
    // Check the boundary between chunkX and chunkX+1
    if (secCX === chunkX) {
      // Get the adjacent section
      const adjacentKey = `${chunkX + 1},${chunkZ},${secSY}`;
      const adjacentSection = lightGrid.sections.get(adjacentKey);
      
      if (!adjacentSection) continue;
      
      // Check each block at x=15 vs x=0 of adjacent chunk
      for (let y = 0; y < SECTION_SIZE; y++) {
        for (let z = 0; z < SECTION_SIZE; z++) {
          const idx1 = y * SECTION_SIZE * SECTION_SIZE + z * SECTION_SIZE + 15;
          const idx2 = y * SECTION_SIZE * SECTION_SIZE + z * SECTION_SIZE + 0;
          
          const light1 = section[idx1] & 0x0F; // Sky light
          const light2 = adjacentSection[idx2] & 0x0F;
          
          // Light should not drop by more than 1 at boundaries (unless blocked)
          if (Math.abs(light1 - light2) > 2) {
            issues.push({
              type: 'light_discontinuity',
              boundary: 'X',
              chunk1: { x: chunkX, z: chunkZ },
              chunk2: { x: chunkX + 1, z: chunkZ },
              section: secSY,
              position: { y, z },
              light1,
              light2,
              difference: Math.abs(light1 - light2),
            });
          }
        }
      }
    }
  }
  
  return issues;
}

/**
 * Check lighting continuity at Z boundary between two chunks
 */
function checkZBoundaryLighting(lightGrid, chunkX, chunkZ) {
  const issues = [];
  const SECTION_SIZE = 16;
  
  for (const [key, section] of lightGrid.sections) {
    const parts = key.split(',');
    const secCX = parseInt(parts[0], 10);
    const secCZ = parseInt(parts[1], 10);
    const secSY = parseInt(parts[2], 10);
    
    if (secCX !== chunkX) continue;
    
    if (secCZ === chunkZ) {
      const adjacentKey = `${chunkX},${chunkZ + 1},${secSY}`;
      const adjacentSection = lightGrid.sections.get(adjacentKey);
      
      if (!adjacentSection) continue;
      
      for (let y = 0; y < SECTION_SIZE; y++) {
        for (let x = 0; x < SECTION_SIZE; x++) {
          const idx1 = y * SECTION_SIZE * SECTION_SIZE + 15 * SECTION_SIZE + x;
          const idx2 = y * SECTION_SIZE * SECTION_SIZE + 0 * SECTION_SIZE + x;
          
          const light1 = section[idx1] & 0x0F;
          const light2 = adjacentSection[idx2] & 0x0F;
          
          if (Math.abs(light1 - light2) > 2) {
            issues.push({
              type: 'light_discontinuity',
              boundary: 'Z',
              chunk1: { x: chunkX, z: chunkZ },
              chunk2: { x: chunkX, z: chunkZ + 1 },
              section: secSY,
              position: { y, x },
              light1,
              light2,
              difference: Math.abs(light1 - light2),
            });
          }
        }
      }
    }
  }
  
  return issues;
}

/**
 * Analyze water mesh for boundary continuity
 */
function analyzeWaterContinuity(grid, chunkCoords) {
  const issues = [];
  const SECTION_SIZE = 16;
  
  // Check for water blocks at chunk boundaries that should connect
  for (let i = 0; i < chunkCoords.length; i++) {
    const chunk1 = chunkCoords[i];
    
    for (let j = i + 1; j < chunkCoords.length; j++) {
      const chunk2 = chunkCoords[j];
      
      // Adjacent in X
      if (chunk1.z === chunk2.z && Math.abs(chunk1.x - chunk2.x) === 1) {
        const leftChunk = chunk1.x < chunk2.x ? chunk1 : chunk2;
        const rightChunk = chunk1.x < chunk2.x ? chunk2 : chunk1;
        
        // Check each section
        for (const [key, section] of grid.sections) {
          const parts = key.split(',');
          const cx = parseInt(parts[0], 10);
          const cz = parseInt(parts[1], 10);
          const sy = parseInt(parts[2], 10);
          
          if (cx !== leftChunk.x || cz !== leftChunk.z) continue;
          
          const adjacentKey = `${rightChunk.x},${rightChunk.z},${sy}`;
          const adjacentSection = grid.sections.get(adjacentKey);
          
          if (!adjacentSection) continue;
          
          // Check water at x=15 vs x=0
          for (let y = 0; y < SECTION_SIZE; y++) {
            for (let z = 0; z < SECTION_SIZE; z++) {
              const idx1 = y * SECTION_SIZE * SECTION_SIZE + z * SECTION_SIZE + 15;
              const idx2 = y * SECTION_SIZE * SECTION_SIZE + z * SECTION_SIZE + 0;
              
              const block1 = section[idx1];
              const block2 = adjacentSection[idx2];
              
              const isWater1 = (block1 >> 12) & 0xF; // Water level in upper bits
              const isWater2 = (block2 >> 12) & 0xF;
              
              // If both are water, check levels match
              if (isWater1 > 0 && isWater2 > 0) {
                if (Math.abs(isWater1 - isWater2) > 1) {
                  issues.push({
                    type: 'water_level_mismatch',
                    boundary: 'X',
                    position: { 
                      chunk: `${leftChunk.x},${leftChunk.z}`,
                      section: sy,
                      y,
                      z,
                    },
                    level1: isWater1,
                    level2: isWater2,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  
  return issues;
}

/**
 * Build and analyze meshes from chunks
 */
async function buildAndAnalyzeMeshes(chunks) {
  resetBlockRegistry();
  const registry = getBlockRegistry();
  const grid = new BinaryGrid();
  const lightGrid = new LightGrid();
  
  // Track chunk coordinates
  const chunkCoords = chunks.map(c => ({ x: c.x, z: c.z }));
  
  // Decode all chunks
  for (const chunk of chunks) {
    decodeChunk(chunk, grid, registry, null, null, lightGrid);
  }
  
  // Propagate light
  if (lightGrid.sections.size === 0) {
    propagateSkyLight(grid, lightGrid, registry);
    propagateBlockLight(grid, lightGrid, registry);
  }
  
  // Analyze boundary issues
  const lightIssues = analyzeLightContinuity(lightGrid, chunkCoords);
  const waterIssues = analyzeWaterContinuity(grid, chunkCoords);
  
  // Build meshes
  const offset = { x: 0, y: 0, z: 0 };
  const meshResult = buildGridMeshes(grid, registry, offset);
  
  return {
    meshResult,
    lightIssues,
    waterIssues,
    stats: {
      totalBlocks: grid.totalBlocks,
      solidTriangles: meshResult.solid?.triangleCount || 0,
      waterTriangles: meshResult.water?.triangleCount || 0,
      lavaTriangles: meshResult.lava?.triangleCount || 0,
      chunksProcessed: chunks.length,
    },
    hashes: {
      solid: hashMeshData(meshResult.solid),
      water: hashMeshData(meshResult.water),
      lava: hashMeshData(meshResult.lava),
    },
  };
}

/**
 * Run mesh consistency test on a region file
 */
async function runMeshConsistencyTest(regionPath, updateSnapshot = false) {
  const regionName = path.basename(regionPath, '.mca');
  const snapshotPath = path.join(FIXTURES_DIR, `${regionName}.consistency.json`);
  
  console.log(`\n${colors.cyan}▶ Mesh Consistency Test: ${regionName}${colors.reset}`);
  
  try {
    // Parse region
    console.log(`${colors.dim}  Parsing region...${colors.reset}`);
    const chunks = await parseMCAFromPath(regionPath);
    console.log(`${colors.dim}  Found ${chunks.length} chunks${colors.reset}`);
    
    // Build and analyze
    console.log(`${colors.dim}  Building meshes and analyzing boundaries...${colors.reset}`);
    const result = await buildAndAnalyzeMeshes(chunks);
    
    // Report boundary issues
    if (result.lightIssues.length > 0) {
      console.log(`${colors.yellow}  ⚠ Found ${result.lightIssues.length} light continuity issues${colors.reset}`);
      // Show first few issues
      for (const issue of result.lightIssues.slice(0, 3)) {
        console.log(`${colors.dim}    - ${issue.boundary} boundary at chunk ${issue.chunk1.x},${issue.chunk1.z}: light ${issue.light1} → ${issue.light2}${colors.reset}`);
      }
      if (result.lightIssues.length > 3) {
        console.log(`${colors.dim}    ... and ${result.lightIssues.length - 3} more${colors.reset}`);
      }
    } else {
      console.log(`${colors.green}  ✓ No light continuity issues${colors.reset}`);
    }
    
    if (result.waterIssues.length > 0) {
      console.log(`${colors.yellow}  ⚠ Found ${result.waterIssues.length} water continuity issues${colors.reset}`);
    } else {
      console.log(`${colors.green}  ✓ No water continuity issues${colors.reset}`);
    }
    
    // Compare or update snapshot
    const snapshot = {
      version: 2,
      timestamp: new Date().toISOString(),
      stats: result.stats,
      hashes: result.hashes,
      boundaryAnalysis: {
        lightIssueCount: result.lightIssues.length,
        waterIssueCount: result.waterIssues.length,
      },
    };
    
    if (updateSnapshot) {
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
      console.log(`${colors.yellow}  ⟳ Snapshot updated${colors.reset}`);
      return { status: 'updated', name: regionName };
    }
    
    if (!fs.existsSync(snapshotPath)) {
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
      console.log(`${colors.yellow}  ⟳ Snapshot created (first run)${colors.reset}`);
      return { status: 'created', name: regionName };
    }
    
    // Compare to snapshot
    const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    const differences = [];
    
    // Compare hashes
    for (const [key, expectedHash] of Object.entries(expected.hashes)) {
      if (expectedHash !== snapshot.hashes[key]) {
        differences.push({ type: 'hash', key, expected: expectedHash, actual: snapshot.hashes[key] });
      }
    }
    
    // Compare stats
    for (const [key, expectedVal] of Object.entries(expected.stats)) {
      if (expectedVal !== snapshot.stats[key]) {
        differences.push({ type: 'stat', key, expected: expectedVal, actual: snapshot.stats[key] });
      }
    }
    
    if (differences.length === 0) {
      console.log(`${colors.green}  ✓ Meshes are consistent with snapshot${colors.reset}`);
      console.log(`${colors.dim}    ${result.stats.totalBlocks.toLocaleString()} blocks → ${result.stats.solidTriangles.toLocaleString()} solid triangles${colors.reset}`);
      return { status: 'passed', name: regionName };
    } else {
      console.log(`${colors.red}  ✗ Mesh mismatch${colors.reset}`);
      for (const diff of differences) {
        console.log(`${colors.red}    - ${diff.type} ${diff.key}: expected ${diff.expected}, got ${diff.actual}${colors.reset}`);
      }
      return { status: 'failed', name: regionName, differences };
    }
    
  } catch (error) {
    console.log(`${colors.red}  ✗ Error: ${error.message}${colors.reset}`);
    return { status: 'error', name: regionName, error: error.message };
  }
}

/**
 * Main test runner
 */
async function main() {
  const args = process.argv.slice(2);
  const updateSnapshots = args.includes('--update') || args.includes('-u');
  
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Mesh Consistency Tests with Chunk Stitching${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  if (updateSnapshots) {
    console.log(`${colors.yellow}  Mode: Updating snapshots${colors.reset}`);
  } else {
    console.log(`${colors.dim}  Mode: Comparing to snapshots${colors.reset}`);
  }
  
  // Ensure fixtures directory exists
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  
  // Find test region files
  const testRegionsDir = path.join(PROJECT_ROOT, 'test-regions');
  let regionFiles = [];
  
  // Look in test-regions root
  if (fs.existsSync(testRegionsDir)) {
    const rootFiles = fs.readdirSync(testRegionsDir)
      .filter(f => f.endsWith('.mca'))
      .map(f => path.join(testRegionsDir, f));
    regionFiles.push(...rootFiles);
    
    // Also look in subdirectories
    const subdirs = fs.readdirSync(testRegionsDir)
      .filter(f => fs.statSync(path.join(testRegionsDir, f)).isDirectory());
    
    for (const subdir of subdirs) {
      const subdirPath = path.join(testRegionsDir, subdir);
      if (fs.existsSync(path.join(subdirPath, 'region'))) {
        const regionDir = path.join(subdirPath, 'region');
        const files = fs.readdirSync(regionDir)
          .filter(f => f.endsWith('.mca'))
          .slice(0, 1) // Only test first region from each world
          .map(f => path.join(regionDir, f));
        regionFiles.push(...files);
      }
    }
  }
  
  // Also check debug_world
  const debugWorldRegion = path.join(PROJECT_ROOT, 'debug_world', 'r.0.0.mca');
  if (fs.existsSync(debugWorldRegion)) {
    regionFiles.push(debugWorldRegion);
  }
  
  if (regionFiles.length === 0) {
    console.log(`${colors.yellow}  No region files found for testing${colors.reset}`);
    process.exit(1);
  }
  
  console.log(`${colors.dim}  Found ${regionFiles.length} region file(s) to test${colors.reset}`);
  
  // Run tests
  const results = [];
  for (const regionPath of regionFiles) {
    const result = await runMeshConsistencyTest(regionPath, updateSnapshots);
    results.push(result);
  }
  
  // Summary
  console.log(`\n${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  Summary${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}═══════════════════════════════════════════════════${colors.reset}`);
  
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const errors = results.filter(r => r.status === 'error').length;
  const updated = results.filter(r => r.status === 'updated' || r.status === 'created').length;
  
  if (updateSnapshots) {
    console.log(`${colors.yellow}  ${updated} snapshot(s) updated${colors.reset}`);
  } else {
    console.log(`${colors.green}  ${passed} passed${colors.reset}`);
    if (failed > 0) console.log(`${colors.red}  ${failed} failed${colors.reset}`);
    if (errors > 0) console.log(`${colors.red}  ${errors} error(s)${colors.reset}`);
    if (updated > 0) console.log(`${colors.yellow}  ${updated} created${colors.reset}`);
  }
  
  console.log('');
  
  process.exit(failed > 0 || errors > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});

