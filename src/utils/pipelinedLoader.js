/**
 * Pipelined Region Loader
 * 
 * Optimizes region loading by:
 * - Processing chunks in batches with UI yielding
 * - Frustum-based priority loading (visible chunks first)
 * - Incremental mesh rendering (show meshes as they complete)
 * - Efficient memory management
 */

import * as THREE from 'three';
import { getExtractionWorkerManager } from './extractionWorkerManager';
import { meshWorkerManager } from './meshWorkerManager';
import { 
  SubchunkManager, 
  buildSubchunkMesh,
  buildWaterSubchunkMesh,
  buildLavaSubchunkMesh,
  getSubchunkYRange 
} from './subchunkManager';

/**
 * Create a camera frustum for visibility testing
 */
function createFrustum(camera) {
  try {
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    camera.updateMatrixWorld();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);
    return frustum;
  } catch (e) {
    return null;
  }
}

/**
 * Check if a chunk is within the camera frustum
 */
function isChunkInFrustum(chunkX, chunkZ, frustum, regionCenter) {
  if (!frustum) return true;
  
  const worldX = chunkX * 16 - regionCenter.x;
  const worldZ = chunkZ * 16 - regionCenter.z;
  
  const box = new THREE.Box3(
    new THREE.Vector3(worldX, -64, worldZ),
    new THREE.Vector3(worldX + 16, 320, worldZ + 16)
  );
  
  return frustum.intersectsBox(box);
}

/**
 * Calculate distance from chunk to camera
 */
function chunkDistanceToCamera(chunkX, chunkZ, cameraPos, regionCenter) {
  const worldX = chunkX * 16 + 8 - regionCenter.x;
  const worldZ = chunkZ * 16 + 8 - regionCenter.z;
  return Math.hypot(worldX - cameraPos.x, worldZ - cameraPos.z);
}

/**
 * Priority-based chunk sorting with frustum awareness
 */
export function prioritizeChunks(chunkRefs, options = {}) {
  const {
    camera = null,
    cameraPosition = { x: 0, y: 64, z: 0 },
    regionCenter = { x: 0, y: 64, z: 0 },
  } = options;
  
  const frustum = camera ? createFrustum(camera) : null;
  
  return [...chunkRefs].sort((a, b) => {
    const distA = chunkDistanceToCamera(a.chunkX, a.chunkZ, cameraPosition, regionCenter);
    const distB = chunkDistanceToCamera(b.chunkX, b.chunkZ, cameraPosition, regionCenter);
    
    if (frustum) {
      const inFrustumA = isChunkInFrustum(a.chunkX, a.chunkZ, frustum, regionCenter);
      const inFrustumB = isChunkInFrustum(b.chunkX, b.chunkZ, frustum, regionCenter);
      
      if (inFrustumA && !inFrustumB) return -1;
      if (!inFrustumA && inFrustumB) return 1;
    }
    
    return distA - distB;
  });
}

/**
 * Calculate optimal batch size based on system capabilities
 * OPTIMIZED: Use larger batches for better throughput
 */
export function calculateOptimalBatchSize(totalChunks) {
  // Use larger batches for better throughput - workers handle parallelism well
  // 16-32 chunks per batch provides good balance of throughput and memory
  const workerCount = navigator.hardwareConcurrency || 4;
  const batchSize = Math.min(32, Math.max(workerCount * 2, Math.ceil(totalChunks / 8)));
  return batchSize;
}

/**
 * Yield to allow UI updates
 */
function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Process chunks with pipelined extraction and meshing
 */
export async function loadRegionPipelined(chunkRefs, options = {}) {
  const {
    regionCenter = { x: 0, y: 64, z: 0 },
    minY = -64,
    maxY = 320,
    camera = null,
    onProgress = null,
    onMeshReady = null,
    getBlockColor = null,
    signal = null,
  } = options;

  const startTime = performance.now();
  const stats = {
    extractionTime: 0,
    meshingTime: 0,
    totalBlocks: 0,
    totalChunks: chunkRefs.length,
    meshesBuilt: 0,
  };

  // Sort chunks by priority (frustum + distance)
  const cameraPosition = camera?.position ? 
    { x: camera.position.x, y: camera.position.y, z: camera.position.z } : 
    { x: 0, y: 64, z: 0 };
  
  const sortedChunks = prioritizeChunks(chunkRefs, {
    camera,
    cameraPosition,
    regionCenter,
  });

  const BATCH_SIZE = calculateOptimalBatchSize(sortedChunks.length);
  // Reduce logging in hot path - only log summary at start
  const DEBUG_PIPELINE = false;
  if (DEBUG_PIPELINE) console.log(`[Pipeline] Starting: ${sortedChunks.length} chunks, batch size: ${BATCH_SIZE}`);
  
  const extractionManager = getExtractionWorkerManager();
  extractionManager.resetPalette();
  
  const manager = new SubchunkManager();
  const meshOffset = { x: regionCenter.x, y: 0, z: regionCenter.z };
  
  let extractedChunks = 0;
  let totalMeshesBuilt = 0;

  // Create batches
  const batches = [];
  for (let i = 0; i < sortedChunks.length; i += BATCH_SIZE) {
    batches.push(sortedChunks.slice(i, i + BATCH_SIZE));
  }

  // Process each batch
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    if (signal?.aborted) break;
    
    const batch = batches[batchIdx];
    
    // === EXTRACTION PHASE ===
    onProgress?.('extracting', extractedChunks, sortedChunks.length, 
      `Extracting batch ${batchIdx + 1}/${batches.length}...`);
    
    const extractStartTime = performance.now();
    
    let typedBlocks, palette;
    try {
      const result = await extractionManager.extractChunksParallel(
        batch,
        (completed, total) => {
          if (!signal?.aborted) {
            onProgress?.('extracting', extractedChunks + completed, sortedChunks.length,
              `Extracting batch ${batchIdx + 1}/${batches.length}...`);
          }
        }
      );
      typedBlocks = result.blocks;
      palette = result.palette;
    } catch (e) {
      console.error('Extraction failed:', e);
      continue;
    }
    
    extractedChunks += batch.length;
    stats.extractionTime += performance.now() - extractStartTime;
    
    if (signal?.aborted) break;
    
    // Filter by Y range
    const { x, y, z, blockType, level, count } = typedBlocks;
    stats.totalBlocks += count;
    
    let filteredCount = 0;
    for (let i = 0; i < count; i++) {
      if (y[i] >= minY && y[i] <= maxY) filteredCount++;
    }
    
    const filteredX = new Int32Array(filteredCount);
    const filteredY = new Int16Array(filteredCount);
    const filteredZ = new Int32Array(filteredCount);
    const filteredBlockType = new Uint16Array(filteredCount);
    const filteredLevel = new Int8Array(filteredCount);
    
    let j = 0;
    for (let i = 0; i < count; i++) {
      if (y[i] >= minY && y[i] <= maxY) {
        filteredX[j] = x[i];
        filteredY[j] = y[i];
        filteredZ[j] = z[i];
        filteredBlockType[j] = blockType[i];
        filteredLevel[j] = level[i];
        j++;
      }
    }
    
    // Create batch manager for meshing
    const batchManager = new SubchunkManager();
    batchManager.addTypedBlocks(
      { x: filteredX, y: filteredY, z: filteredZ, blockType: filteredBlockType, level: filteredLevel, count: filteredCount },
      palette
    );
    
    // Also add to main manager
    manager.addTypedBlocks(
      { x: filteredX, y: filteredY, z: filteredZ, blockType: filteredBlockType, level: filteredLevel, count: filteredCount },
      palette
    );
    
    // Free chunk data
    for (const ref of batch) {
      ref.rawData = null;
    }
    
    await yieldToUI();
    if (signal?.aborted) break;
    
    // === MESHING PHASE - OPTIMIZED TYPED ARRAY PATH ===
    const meshStartTime = performance.now();
    
    // Use new high-performance indexed mesh building
    const { solidJobs, waterJobs, lavaJobs, typedArrays } = batchManager.prepareIndexedMeshJobs(meshOffset);
    
    const totalSubchunks = solidJobs.length + waterJobs.length + lavaJobs.length;
    
    onProgress?.('meshing', 0, totalSubchunks,
      `Building meshes for batch ${batchIdx + 1}/${batches.length}...`);
    
    // Build all meshes using typed array path (no object conversion!)
    const meshResult = await meshWorkerManager.buildMeshesTyped(
      typedArrays,
      solidJobs,
      waterJobs,
      lavaJobs,
      (completed, total) => {
        if (!signal?.aborted) {
          onProgress?.('meshing', completed, total, `Meshing batch ${batchIdx + 1}...`);
        }
      }
    ).catch(err => {
      console.error('Mesh building failed:', err);
      return { solidResults: [], waterResults: [], lavaResults: [] };
    });
    
    const { solidResults, waterResults, lavaResults } = meshResult;
    
    // Notify about solid meshes
    for (const result of solidResults) {
      if (result.geometry) {
        onMeshReady?.({
          type: 'solid',
          subchunkY: result.subchunkY,
          subchunkKey: result.subchunkKey,
          geometry: result.geometry,
          range: getSubchunkYRange(result.subchunkY),
          batchNumber: batchIdx,
        });
        totalMeshesBuilt++;
      }
    }
    
    // Notify about water meshes
    for (const result of waterResults) {
      if (result.geometry) {
        onMeshReady?.({
          type: 'water',
          subchunkY: result.subchunkY,
          subchunkKey: result.subchunkKey,
          geometry: result.geometry,
          range: getSubchunkYRange(result.subchunkY),
          batchNumber: batchIdx,
        });
        totalMeshesBuilt++;
      }
    }
    
    // Notify about lava meshes  
    for (const result of lavaResults) {
      if (result.geometry) {
        onMeshReady?.({
          type: 'lava',
          subchunkY: result.subchunkY,
          subchunkKey: result.subchunkKey,
          geometry: result.geometry,
          range: getSubchunkYRange(result.subchunkY),
          batchNumber: batchIdx,
        });
        totalMeshesBuilt++;
      }
    }
    
    stats.meshingTime += performance.now() - meshStartTime;
    await yieldToUI();
  }

  stats.totalTime = performance.now() - startTime;
  stats.meshesBuilt = totalMeshesBuilt;

  // Only log final summary
  console.log(
    `✅ Region loaded: ${stats.totalBlocks.toLocaleString()} blocks, ${totalMeshesBuilt} meshes in ${(stats.totalTime / 1000).toFixed(2)}s`
  );

  return { manager, stats };
}

/**
 * Quick estimation of load time for progress display
 */
export function estimateLoadTime(chunkCount) {
  const extractTimePerChunk = 5;
  const meshTimePerChunk = 15;
  return Math.round((extractTimePerChunk + meshTimePerChunk) * chunkCount * 0.7);
}
