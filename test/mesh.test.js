/**
 * Mesh Determinism Tests
 * 
 * Ensures that mesh generation produces identical output given the same input.
 * Uses golden snapshots stored in test/fixtures/ as the source of truth.
 * 
 * Usage:
 *   npm test              - Run tests, comparing to existing snapshots
 *   npm test -- --update  - Update snapshots with current output
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { parseMCAFromPath } from './helpers/nodeMcaParser.js';
import { BinaryGrid } from '../src/mesh/BinaryGrid.js';
import { getBlockRegistry, resetBlockRegistry } from '../src/mesh/BlockRegistry.js';
import { decodeChunk } from '../src/mesh/ChunkDecoder.js';
import { buildGridMeshes } from '../src/mesh/FastMesher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_REGIONS_DIR = path.join(__dirname, '..', 'test-regions');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

/**
 * Generate a deterministic hash for mesh data
 */
function hashMeshData(meshData) {
  if (!meshData) return null;
  
  const hash = crypto.createHash('sha256');
  
  // Hash positions (most critical for mesh correctness)
  hash.update(Buffer.from(meshData.positions.buffer));
  
  // Hash normals
  hash.update(Buffer.from(meshData.normals.buffer));
  
  // Hash colors
  hash.update(Buffer.from(meshData.colors.buffer));
  
  // Hash indices
  hash.update(Buffer.from(meshData.indices.buffer));
  
  return hash.digest('hex');
}

/**
 * Create a snapshot object from mesh results
 */
function createSnapshot(result) {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    stats: {
      totalBlocks: result.stats.totalBlocks,
      solidTriangles: result.stats.solidTriangles,
      waterTriangles: result.stats.waterTriangles,
      lavaTriangles: result.stats.lavaTriangles,
      chunksProcessed: result.stats.chunksProcessed,
    },
    hashes: {
      solid: hashMeshData(result.solidMesh),
      water: hashMeshData(result.waterMesh),
      lava: hashMeshData(result.lavaMesh),
    },
    // Store detailed mesh info for debugging
    meshInfo: {
      solid: result.solidMesh ? {
        vertexCount: result.solidMesh.vertexCount,
        triangleCount: result.solidMesh.triangleCount,
        positionsSample: Array.from(result.solidMesh.positions.slice(0, 12)),
      } : null,
      water: result.waterMesh ? {
        vertexCount: result.waterMesh.vertexCount,
        triangleCount: result.waterMesh.triangleCount,
        positionsSample: Array.from(result.waterMesh.positions.slice(0, 12)),
      } : null,
      lava: result.lavaMesh ? {
        vertexCount: result.lavaMesh.vertexCount,
        triangleCount: result.lavaMesh.triangleCount,
        positionsSample: Array.from(result.lavaMesh.positions.slice(0, 12)),
      } : null,
    },
  };
}

/**
 * Compare two snapshots and return differences
 */
function compareSnapshots(expected, actual) {
  const differences = [];
  
  // Compare stats
  for (const [key, expectedValue] of Object.entries(expected.stats)) {
    const actualValue = actual.stats[key];
    if (expectedValue !== actualValue) {
      differences.push({
        type: 'stat',
        key,
        expected: expectedValue,
        actual: actualValue,
      });
    }
  }
  
  // Compare hashes
  for (const [key, expectedHash] of Object.entries(expected.hashes)) {
    const actualHash = actual.hashes[key];
    if (expectedHash !== actualHash) {
      differences.push({
        type: 'hash',
        key,
        expected: expectedHash,
        actual: actualHash,
      });
    }
  }
  
  return differences;
}

/**
 * Build meshes from a region file
 */
async function buildMeshesFromRegion(regionPath) {
  // Reset registry to ensure deterministic block ID assignment
  resetBlockRegistry();
  const registry = getBlockRegistry();
  
  // Parse the region file
  console.log(`${colors.dim}  Parsing ${path.basename(regionPath)}...${colors.reset}`);
  const chunks = await parseMCAFromPath(regionPath);
  console.log(`${colors.dim}  Found ${chunks.length} chunks${colors.reset}`);
  
  // Decode chunks into binary grid
  console.log(`${colors.dim}  Decoding chunks...${colors.reset}`);
  const grid = new BinaryGrid();
  let chunksProcessed = 0;
  
  for (const chunk of chunks) {
    decodeChunk(chunk, grid, registry);
    chunksProcessed++;
  }
  
  console.log(`${colors.dim}  Decoded ${grid.totalBlocks.toLocaleString()} blocks${colors.reset}`);
  
  // Build meshes using deterministic settings (no centering to keep consistent coordinates)
  console.log(`${colors.dim}  Building meshes...${colors.reset}`);
  const offset = { x: 0, y: 0, z: 0 };
  const meshResult = buildGridMeshes(grid, registry, offset);
  
  // Create stats object similar to RegionMeshBuilder
  const stats = {
    totalBlocks: grid.totalBlocks,
    chunksProcessed,
    solidTriangles: meshResult.solid?.triangleCount || 0,
    waterTriangles: meshResult.water?.triangleCount || 0,
    lavaTriangles: meshResult.lava?.triangleCount || 0,
  };
  
  return {
    solidMesh: meshResult.solid,
    waterMesh: meshResult.water,
    lavaMesh: meshResult.lava,
    stats,
  };
}

/**
 * Run a single test case
 */
async function runTest(name, regionPath, updateSnapshots) {
  const snapshotPath = path.join(FIXTURES_DIR, `${name}.snapshot.json`);
  
  console.log(`\n${colors.cyan}▶ ${name}${colors.reset}`);
  
  try {
    // Build meshes
    const result = await buildMeshesFromRegion(regionPath);
    const actualSnapshot = createSnapshot(result);
    
    // Check if we're updating snapshots
    if (updateSnapshots) {
      fs.writeFileSync(snapshotPath, JSON.stringify(actualSnapshot, null, 2));
      console.log(`${colors.yellow}  ⟳ Snapshot updated${colors.reset}`);
      return { status: 'updated', name };
    }
    
    // Check if snapshot exists
    if (!fs.existsSync(snapshotPath)) {
      fs.writeFileSync(snapshotPath, JSON.stringify(actualSnapshot, null, 2));
      console.log(`${colors.yellow}  ⟳ Snapshot created (first run)${colors.reset}`);
      return { status: 'created', name };
    }
    
    // Load and compare snapshot
    const expectedSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    const differences = compareSnapshots(expectedSnapshot, actualSnapshot);
    
    if (differences.length === 0) {
      console.log(`${colors.green}  ✓ Mesh matches snapshot${colors.reset}`);
      console.log(`${colors.dim}    ${result.stats.totalBlocks.toLocaleString()} blocks → ${result.stats.solidTriangles.toLocaleString()} solid, ${result.stats.waterTriangles.toLocaleString()} water, ${result.stats.lavaTriangles.toLocaleString()} lava triangles${colors.reset}`);
      return { status: 'passed', name };
    } else {
      console.log(`${colors.red}  ✗ Mesh does not match snapshot${colors.reset}`);
      console.log(`${colors.dim}  Differences:${colors.reset}`);
      for (const diff of differences) {
        if (diff.type === 'stat') {
          console.log(`${colors.red}    - ${diff.key}: expected ${diff.expected}, got ${diff.actual}${colors.reset}`);
        } else if (diff.type === 'hash') {
          console.log(`${colors.red}    - ${diff.key} mesh hash mismatch${colors.reset}`);
          console.log(`${colors.dim}      expected: ${diff.expected?.slice(0, 16)}...${colors.reset}`);
          console.log(`${colors.dim}      actual:   ${diff.actual?.slice(0, 16)}...${colors.reset}`);
        }
      }
      return { status: 'failed', name, differences };
    }
  } catch (error) {
    console.log(`${colors.red}  ✗ Error: ${error.message}${colors.reset}`);
    console.log(`${colors.dim}    ${error.stack}${colors.reset}`);
    return { status: 'error', name, error };
  }
}

/**
 * Main test runner
 */
async function main() {
  const args = process.argv.slice(2);
  const updateSnapshots = args.includes('--update') || args.includes('-u');
  
  console.log(`\n${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}  Mesh Determinism Tests${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  
  if (updateSnapshots) {
    console.log(`${colors.yellow}  Mode: Updating snapshots${colors.reset}`);
  } else {
    console.log(`${colors.dim}  Mode: Comparing to snapshots${colors.reset}`);
  }
  
  // Ensure fixtures directory exists
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  
  // Find all test region files
  const regionFiles = fs.readdirSync(TEST_REGIONS_DIR)
    .filter(f => f.endsWith('.mca'))
    .map(f => ({
      name: f.replace('.mca', ''),
      path: path.join(TEST_REGIONS_DIR, f),
    }));
  
  if (regionFiles.length === 0) {
    console.log(`${colors.yellow}\n  No region files found in test-regions/${colors.reset}`);
    process.exit(1);
  }
  
  console.log(`${colors.dim}  Found ${regionFiles.length} region file(s) to test${colors.reset}`);
  
  // Run tests
  const results = [];
  for (const region of regionFiles) {
    const result = await runTest(region.name, region.path, updateSnapshots);
    results.push(result);
  }
  
  // Summary
  console.log(`\n${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}  Summary${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  
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
  
  // Exit with error code if any tests failed
  if (failed > 0 || errors > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});

