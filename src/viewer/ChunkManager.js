/**
 * ChunkManager - High-Performance Region Viewer with Progressive Loading
 * 
 * Features:
 * - Progressive region loading (parse → mesh → render pipeline)
 * - Unified worker pipeline for fastest possible loading
 * - Parallel processing across regions for memory efficiency
 * - Automatic mesh splitting for WebGL index limits
 * - GPU-based Y slicing via shader uniforms
 * - Streaming support for hundreds of regions
 * 
 * Performance Target: 3 seconds per region for full pipeline
 */

import * as THREE from 'three';
// SolidMaterial no longer used - using TexturedMaterial for all blocks
import { createWaterMaterial, updateWaterMaterialAtlas } from './materials/WaterMaterial';
import { createLavaMaterial, updateLavaMaterialAtlas } from './materials/LavaMaterial';
import { createGlassMaterial } from './materials/GlassMaterial';
import { createTexturedMaterial, createTexturedGlassMaterial, createTexturedModelMaterial, createTransparentModelMaterial, createOverlayModelMaterial, updateMaterialAtlas, setMaterialTextureMode, setMaterialLightingEnabled, setMaterialFastPath, setMaterialFog } from './materials/TexturedMaterial';
import { createInstancedModelMaterial, createInstancedMesh, createCrossGeometry } from './materials/InstancedModelMaterial';
import { RegionMeshBuilder } from '../mesh/RegionMeshBuilder';
import { StreamingRegionLoader } from '../mesh/StreamingRegionLoader';
import { BinaryGrid } from '../mesh/BinaryGrid';
import { getBlockRegistry } from '../mesh/BlockRegistry';
import { generateLightmap, DAYTIME_PARAMS, getLightmapParamsForTime } from '../mesh/LightmapGenerator';
import { ParticleSystem } from '../particles/ParticleSystem';
import { ParticleEmitterManager } from '../particles/ParticleEmitter';
import { BeaconBeamManager } from './BeaconBeamManager';

// WebGL has a max index count limit (~30M). Use 25M to be safe.
const MAX_INDICES_PER_DRAW = 25000000;

// EXPERIMENT: Disable LOD objects entirely to test performance impact
// When true, all meshes are added as regular meshes (no LOD switching)
const DISABLE_LOD_OBJECTS = true;

// Max concurrent region processing
// Keep at 1-2 to avoid memory exhaustion with large worlds
const MAX_CONCURRENT_REGIONS = 2;

// Delay between regions to allow GC
const REGION_GC_DELAY_MS = 100;

// Memory thresholds for adaptive processing
const HIGH_MEMORY_BLOCK_THRESHOLD = 50_000_000; // 50M blocks = switch to conservative mode
const CRITICAL_MEMORY_BLOCK_THRESHOLD = 200_000_000; // 200M blocks = very conservative
const LOD_MEMORY_THRESHOLD = 30_000_000; // 30M blocks = skip LOD generation

// LOD distance thresholds (blocks from camera)
// These are calculated from LOD object position to camera
// Increased distances so full detail shows for longer
const LOD_DISTANCE_1 = 800;   // LOD1: ~8k points
const LOD_DISTANCE_2 = 1500;  // LOD2: ~4k points
const LOD_DISTANCE_3 = 2500;  // LOD3: ~2k points
const LOD_DISTANCE_4 = 4000;  // LOD4: ~1k points

export class ChunkManager {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.onProgress = options.onProgress || null;
    this.onComplete = options.onComplete || null;
    
    // Texture mode: 'solid', 'default', or 'custom'
    this.textureMode = options.textureMode || 'solid';
    this.textureAtlas = options.textureAtlas || null;
    
    // Three.js groups (added to scene)
    this.solidGroup = new THREE.Group();
    this.waterGroup = new THREE.Group();
    this.lavaGroup = new THREE.Group();
    this.glassGroup = new THREE.Group(); // Glass and transparent blocks
    this.modelGroup = new THREE.Group(); // Opaque non-cube blocks (slabs, stairs, flowers, etc.)
    this.transparentModelGroup = new THREE.Group(); // Transparent non-cube blocks (glass panes, iron bars)
    this.overlayModelGroup = new THREE.Group(); // Overlay effects (torch bulb glow) - rendered with depthWrite: false
    // Render order for proper depth sorting:
    // 0: Solid blocks and opaque model blocks (write to depth)
    // 0.5: Transparent model blocks (glass panes, iron bars - write to depth)
    // 1: Full glass blocks, leaves, grass overlays (transparent, write to depth)
    //    These must render BEFORE water so underwater objects get properly tinted
    // 2: Water (transparent, no depth write)
    // 3: Lava (transparent, no depth write)
    // 4: Overlay effects (no depth write)
    this.modelGroup.renderOrder = 0; // Same as solid - opaque partial blocks
    this.transparentModelGroup.renderOrder = 0.5; // Render BEFORE water so depth is correct
    this.glassGroup.renderOrder = 1; // Glass/leaves render BEFORE water (underwater objects visible through water)
    this.waterGroup.renderOrder = 2;
    this.lavaGroup.renderOrder = 3;
    this.overlayModelGroup.renderOrder = 4; // Overlay renders last (but doesn't write to depth)
    scene.add(this.solidGroup);
    scene.add(this.waterGroup);
    scene.add(this.lavaGroup);
    scene.add(this.glassGroup);
    scene.add(this.modelGroup);
    scene.add(this.transparentModelGroup);
    scene.add(this.overlayModelGroup);
    
    // Create materials based on texture mode
    // When textures are enabled, use textured materials that can fall back to vertex colors
    const useTextures = this.textureMode !== 'solid' && this.textureAtlas;
    
    // Generate lightmap texture for Minecraft-style lighting
    this.lightmap = generateLightmap(DAYTIME_PARAMS);
    console.log('[ChunkManager] Generated lightmap texture');
    
    // Shared materials with Y-slice uniforms
    // Use textured material that supports both textures and vertex colors
    // Pass lightmap to all materials for proper lighting
    this.solidMaterial = createTexturedMaterial(this.textureAtlas, useTextures, this.lightmap);
    this.waterMaterial = createWaterMaterial(this.textureAtlas, useTextures, this.lightmap);
    this.lavaMaterial = createLavaMaterial(this.textureAtlas, useTextures, this.lightmap);
    this.glassMaterial = createTexturedGlassMaterial(this.textureAtlas, useTextures, this.lightmap);
    this.modelMaterial = createTexturedModelMaterial(this.textureAtlas, useTextures, this.lightmap); // Opaque non-cube blocks
    this.transparentModelMaterial = createTransparentModelMaterial(this.textureAtlas, useTextures, this.lightmap); // Transparent non-cube blocks (glass panes, iron bars)
    this.overlayModelMaterial = createOverlayModelMaterial(this.textureAtlas, useTextures, this.lightmap); // Overlay glow effects (torch bulbs)
    this.instancedMaterial = createInstancedModelMaterial(this.textureAtlas, useTextures, this.lightmap); // GPU instanced grass/flowers
    
    // Group for instanced meshes
    this.instancedGroup = new THREE.Group();
    this.instancedGroup.renderOrder = 0; // Same as solid opaque blocks
    scene.add(this.instancedGroup);
    
    // Current meshes (arrays to support split meshes)
    this.solidMeshes = [];
    this.waterMeshes = [];
    this.lavaMeshes = [];
    this.glassMeshes = []; // Glass and transparent block meshes
    this.modelMeshes = []; // Opaque non-cube block meshes
    this.transparentModelMeshes = []; // Transparent non-cube block meshes (glass panes, iron bars)
    this.overlayModelMeshes = []; // Overlay glow effect meshes (torch bulbs)
    this.instancedMeshes = []; // GPU instanced meshes (grass, flowers)
    
    // Stats
    this.totalBlocks = 0;
    this.loadedChunks = 0;
    this.loadedRegions = 0;
    
    // Center offset
    this.centerX = 0;
    this.centerY = 0;
    this.centerZ = 0;
    
    // Y range for filtering
    this.minY = -64;
    this.maxY = 320;
    
    // Chunk render distance (0 = unlimited)
    this.renderDistance = 0;
    this._lastVisibilityLog = false;
    
    // Streaming loader for optimized region loading
    this.streamingLoader = null;
    
    // Use streaming by default (faster for most cases)
    this.useStreaming = options.useStreaming !== false;
    
    // Debug mode: block lookup grid (stores block IDs for position lookup)
    // Needed for particle collision detection
    this.blockRegistry = getBlockRegistry();
    
    // Particle system for torch flames, smoke, etc.
    this.particleSystem = null;
    this.particleEmitterManager = new ParticleEmitterManager();
    this.particlesEnabled = options.enableParticles !== false;
    
    // Beacon beam manager for rendering beacon beams
    this.beaconBeamManager = new BeaconBeamManager();
    this.beaconBeamsEnabled = options.enableBeaconBeams !== false;
    
    // Enable debug grid for particle collision detection (needs block data)
    // This stores block IDs so particles can collide with blocks
    this.debugGrid = this.particlesEnabled ? new BinaryGrid() : null;
  }
  
  /**
   * Set texture mode and update materials
   * @param {string} mode - 'solid', 'default', or 'custom'
   * @param {Object|THREE.Texture} atlasData - Material data { atlas, size, textureIndexLookup } or legacy texture
   */
  setTextureMode(mode, atlasData) {
    this.textureMode = mode;
    this.textureAtlas = atlasData;
    
    const useTextures = mode !== 'solid' && atlasData && atlasData.atlas;
    
    // Update solid material
    updateMaterialAtlas(this.solidMaterial, atlasData);
    setMaterialTextureMode(this.solidMaterial, useTextures);
    
    // Update glass material
    updateMaterialAtlas(this.glassMaterial, atlasData);
    setMaterialTextureMode(this.glassMaterial, useTextures);
    
    // Update model material (slabs, stairs, etc.)
    updateMaterialAtlas(this.modelMaterial, atlasData);
    setMaterialTextureMode(this.modelMaterial, useTextures);
    
    // Update transparent model material (glass panes, iron bars)
    updateMaterialAtlas(this.transparentModelMaterial, atlasData);
    setMaterialTextureMode(this.transparentModelMaterial, useTextures);
    
    // Update overlay model material (torch bulb glow)
    updateMaterialAtlas(this.overlayModelMaterial, atlasData);
    setMaterialTextureMode(this.overlayModelMaterial, useTextures);
    
    // Update water material (animated textures)
    updateWaterMaterialAtlas(this.waterMaterial, atlasData);
    
    // Update lava material (animated textures)
    updateLavaMaterialAtlas(this.lavaMaterial, atlasData);
    
    console.log(`[ChunkManager] Texture mode: ${mode}, using textures: ${useTextures}`);
  }
  
  /**
   * Enable or disable lightmap-based lighting on all materials
   * @param {boolean} enabled - true = use lightmap, false = use fixed face shading
   */
  setLightingEnabled(enabled) {
    setMaterialLightingEnabled(this.solidMaterial, enabled);
    setMaterialLightingEnabled(this.glassMaterial, enabled);
    setMaterialLightingEnabled(this.modelMaterial, enabled);
    setMaterialLightingEnabled(this.transparentModelMaterial, enabled);
    setMaterialLightingEnabled(this.overlayModelMaterial, enabled);
    console.log(`[ChunkManager] Lighting: ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Enable or disable RGSS anti-aliasing for textures
   * @param {boolean} enabled - true = RGSS (smooth distant textures), false = nearest sampling
   */
  setRGSSEnabled(enabled) {
    const value = enabled ? 1.0 : 0.0;
    
    if (this.solidMaterial?.uniforms?.uUseRGSS) {
      this.solidMaterial.uniforms.uUseRGSS.value = value;
    }
    if (this.glassMaterial?.uniforms?.uUseRGSS) {
      this.glassMaterial.uniforms.uUseRGSS.value = value;
    }
    if (this.modelMaterial?.uniforms?.uUseRGSS) {
      this.modelMaterial.uniforms.uUseRGSS.value = value;
    }
    if (this.transparentModelMaterial?.uniforms?.uUseRGSS) {
      this.transparentModelMaterial.uniforms.uUseRGSS.value = value;
    }
    if (this.overlayModelMaterial?.uniforms?.uUseRGSS) {
      this.overlayModelMaterial.uniforms.uUseRGSS.value = value;
    }
    if (this.instancedMaterial?.uniforms?.uUseRGSS) {
      this.instancedMaterial.uniforms.uUseRGSS.value = value;
    }
    console.log(`[ChunkManager] RGSS anti-aliasing: ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Enable or disable continuous glass (connected glass textures)
   * When enabled, glass blocks render without visible borders between adjacent blocks
   * @param {boolean} enabled - true = borderless glass, false = normal glass with frame
   */
  setContinuousGlass(enabled) {
    const value = enabled ? 1.0 : 0.0;
    
    if (this.glassMaterial?.uniforms?.uContinuousGlass) {
      this.glassMaterial.uniforms.uContinuousGlass.value = value;
      console.log(`[ChunkManager] Glass material uContinuousGlass set to ${value}`);
    } else {
      console.warn('[ChunkManager] Glass material missing uContinuousGlass uniform!');
    }
    // Also update transparent model material for glass panes
    if (this.transparentModelMaterial?.uniforms?.uContinuousGlass) {
      this.transparentModelMaterial.uniforms.uContinuousGlass.value = value;
    }
    console.log(`[ChunkManager] Continuous glass: ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Update lightmap based on time of day and brightness setting
   * Regenerates the 16x16 lightmap texture with interpolated day/night parameters
   * @param {number} timeOfDay - 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
   * @param {number} brightness - 0-100 brightness slider (0=Moody, 100=Bright)
   */
  updateLightmapForTime(timeOfDay, brightness = 50) {
    const params = getLightmapParamsForTime(timeOfDay, brightness);
    
    // Dispose old lightmap texture
    if (this.lightmap) {
      this.lightmap.dispose();
    }
    
    // Generate new lightmap with time-adjusted parameters
    this.lightmap = generateLightmap(params);
    
    // Update lightmap uniform on all materials that use it
    if (this.solidMaterial?.uniforms?.uLightmap) {
      this.solidMaterial.uniforms.uLightmap.value = this.lightmap;
    }
    if (this.glassMaterial?.uniforms?.uLightmap) {
      this.glassMaterial.uniforms.uLightmap.value = this.lightmap;
    }
    if (this.modelMaterial?.uniforms?.uLightmap) {
      this.modelMaterial.uniforms.uLightmap.value = this.lightmap;
    }
    if (this.transparentModelMaterial?.uniforms?.uLightmap) {
      this.transparentModelMaterial.uniforms.uLightmap.value = this.lightmap;
    }
    if (this.overlayModelMaterial?.uniforms?.uLightmap) {
      this.overlayModelMaterial.uniforms.uLightmap.value = this.lightmap;
    }
    if (this.instancedMaterial?.uniforms?.uLightmap) {
      this.instancedMaterial.uniforms.uLightmap.value = this.lightmap;
    }
    // Update water and lava materials with new lightmap
    if (this.waterMaterial?.uniforms?.uLightmap) {
      this.waterMaterial.uniforms.uLightmap.value = this.lightmap;
      this.waterMaterial.uniforms.uUseLightmap.value = 1.0;
    }
    if (this.lavaMaterial?.uniforms?.uLightmap) {
      this.lavaMaterial.uniforms.uLightmap.value = this.lightmap;
      this.lavaMaterial.uniforms.uUseLightmap.value = 1.0;
    }
  }
  
  /**
   * Get the current texture index lookup (or null if not using textures)
   */
  getTextureIndexLookup() {
    if (this.textureMode === 'solid' || !this.textureAtlas) return null;
    return this.textureAtlas.textureIndexLookup || null;
  }
  
  /**
   * Enable debug block lookup (stores block data for coordinate queries)
   * Call this before loading regions if you need block info at coordinates
   */
  enableDebugLookup() {
    if (!this.debugGrid) {
      this.debugGrid = new BinaryGrid();
    }
  }
  
  /**
   * Get block info at world coordinates (for debug mode)
   * @returns {Object|null} { id, name, category } or null if no block
   */
  getBlockAt(worldX, worldY, worldZ) {
    if (!this.debugGrid) return null;
    
    const blockData = this.debugGrid.getBlock(worldX, worldY, worldZ);
    if (!blockData || blockData.blockId === 0) return null;
    
    const info = this.blockRegistry.getBlockInfo(blockData.blockId);
    if (!info) return null;
    
    return {
      id: blockData.blockId,
      name: info.name,
      category: info.category,
    };
  }
  
  /**
   * Merge a source grid into the debug grid
   * @param {BinaryGrid} sourceGrid - Grid to merge from
   */
  _mergeDebugGrid(sourceGrid) {
    if (!this.debugGrid || !sourceGrid) return;
    
    // Iterate all sections in source grid and merge into debug grid
    for (const [key, section] of sourceGrid.sections) {
      // Parse key to get chunk coords
      const [chunkX, chunkZ, sectionY] = key.split(',').map(Number);
      
      // Copy non-air blocks to debug grid
      for (let i = 0; i < section.length; i++) {
        if (section[i] !== 0) {
          const localX = i % 16;
          const localZ = Math.floor(i / 16) % 16;
          const localY = Math.floor(i / 256);
          
          const blockId = section[i] & 0x0FFF;
          const level = (section[i] >> 12) & 0xF;
          
          // Calculate world Y from section Y index
          const worldY = (sectionY - 4) * 16 + localY; // sectionY is 0-based from MIN_Y=-64
          
          this.debugGrid.setBlockLocal(chunkX, chunkZ, localX, worldY, localZ, blockId, level);
        }
      }
    }
  }

  /**
   * Set Y range for slicing - uses GPU shader uniforms (instant)
   */
  setYRange(minY, maxY) {
    if (this.minY === minY && this.maxY === maxY) return;
    
    this.minY = minY;
    this.maxY = maxY;
    
    this.solidMaterial.uniforms.uMinY.value = minY;
    this.solidMaterial.uniforms.uMaxY.value = maxY;
    this.waterMaterial.uniforms.uMinY.value = minY;
    this.waterMaterial.uniforms.uMaxY.value = maxY;
    this.lavaMaterial.uniforms.uMinY.value = minY;
    this.lavaMaterial.uniforms.uMaxY.value = maxY;
    this.glassMaterial.uniforms.uMinY.value = minY;
    this.glassMaterial.uniforms.uMaxY.value = maxY;
    this.modelMaterial.uniforms.uMinY.value = minY;
    this.modelMaterial.uniforms.uMaxY.value = maxY;
    this.transparentModelMaterial.uniforms.uMinY.value = minY;
    this.transparentModelMaterial.uniforms.uMaxY.value = maxY;
    this.overlayModelMaterial.uniforms.uMinY.value = minY;
    this.overlayModelMaterial.uniforms.uMaxY.value = maxY;
  }

  /**
   * Set the maximum render distance for partial blocks (grass, flowers, etc.)
   * Lower values = better performance, higher values = more detail
   * @param {number} distance - Distance in blocks (0 = render all, 32-128 typical range)
   */
  setPartialBlockDistance(distance) {
    this.partialBlockDistance = distance;
    this.modelMaterial.uniforms.uMaxDistance.value = distance;
    this.transparentModelMaterial.uniforms.uMaxDistance.value = distance;
    this.overlayModelMaterial.uniforms.uMaxDistance.value = distance;
    // Also update instanced material if it exists
    if (this.instancedMaterial?.uniforms?.uMaxDistance) {
      this.instancedMaterial.uniforms.uMaxDistance.value = distance;
    }
    console.log(`[ChunkManager] Partial block distance set to ${distance === 0 ? 'unlimited' : distance + ' blocks'}`);
  }
  
  /**
   * Get current partial block render distance
   * @returns {number} Distance in blocks
   */
  getPartialBlockDistance() {
    return this.modelMaterial.uniforms.uMaxDistance.value;
  }
  
  /**
   * Set the chunk render distance
   * Chunks beyond this distance from the camera are hidden
   * @param {number} distance - Distance in chunks (0 = unlimited)
   */
  setRenderDistance(distance) {
    this.renderDistance = distance;
    console.log(`[ChunkManager] Render distance set to ${distance === 0 ? 'unlimited' : distance + ' chunks'}`);
    
    // Update beacon beam manager render distance (convert chunks to blocks)
    if (this.beaconBeamManager) {
      const distanceBlocks = distance === 0 ? 10000 : distance * 16;
      this.beaconBeamManager.setMaxDistance(distanceBlocks);
    }
  }
  
  /**
   * Get current render distance
   * @returns {number} Distance in chunks (0 = unlimited)
   */
  getRenderDistance() {
    return this.renderDistance || 0;
  }
  
  /**
   * Set the particle render distance
   * Particles beyond this distance from the camera are not spawned
   * @param {number} distance - Distance in chunks
   */
  setParticleDistance(distance) {
    const distanceBlocks = distance * 16;
    this.particleEmitterManager.setMaxDistance(distanceBlocks);
    console.log(`[ChunkManager] Particle distance set to ${distance} chunks (${distanceBlocks} blocks)`);
  }
  
  /**
   * Set the particle quality level
   * Affects spawn rate multiplier: 'all' = 100%, 'decreased' = 67%, 'minimal' = 10%
   * @param {string} quality - 'all', 'decreased', or 'minimal'
   */
  setParticleQuality(quality) {
    this.particleEmitterManager.setQuality(quality);
    console.log(`[ChunkManager] Particle quality set to ${quality}`);
  }
  
  /**
   * Set fog parameters for distance haze (Minecraft-style)
   * @param {Object} fogParams - Fog parameters
   * @param {boolean} fogParams.enabled - Whether fog is enabled
   * @param {THREE.Color|Array} fogParams.color - Fog color (RGB 0-1)
   * @param {number} fogParams.start - Distance where fog starts (in blocks)
   * @param {number} fogParams.end - Distance where fog is fully opaque (in blocks)
   */
  setFog({ enabled, color, start, end }) {
    const fogParams = { enabled, color, start, end };
    
    // Apply fog to all materials
    setMaterialFog(this.solidMaterial, fogParams);
    setMaterialFog(this.waterMaterial, fogParams);
    setMaterialFog(this.lavaMaterial, fogParams);
    setMaterialFog(this.glassMaterial, fogParams);
    setMaterialFog(this.modelMaterial, fogParams);
    setMaterialFog(this.transparentModelMaterial, fogParams);
    setMaterialFog(this.overlayModelMaterial, fogParams);
    
    console.log(`[ChunkManager] Fog ${enabled ? 'enabled' : 'disabled'}${enabled ? ` (${start}-${end} blocks)` : ''}`);
  }
  
  /**
   * Update chunk visibility based on camera position and render distance
   * Uses Euclidean distance in chunk coordinates for circular render distance (like Minecraft)
   * Solid blocks use renderDistance, model blocks use partialBlockDistance (both in chunks)
   * @param {THREE.Camera} camera - The camera to calculate distances from
   */
  updateChunkVisibility(camera) {
    if (!camera) return;
    
    const renderDistanceChunks = this.renderDistance || 0;
    // Convert partialBlockDistance from blocks to chunks (it's stored as blocks)
    const detailDistanceChunks = this.partialBlockDistance ? Math.floor(this.partialBlockDistance / 16) : 0;
    
    // If both distances are 0 (unlimited), make sure everything is visible and return
    if (renderDistanceChunks === 0 && detailDistanceChunks === 0) {
      this._setAllMeshesVisible(true);
      return;
    }
    
    // Camera position in world coordinates
    const cameraX = camera.position.x;
    const cameraZ = camera.position.z;
    
    // Render distance in blocks (for Euclidean distance calculation)
    const renderDistanceBlocks = renderDistanceChunks * 16;
    const renderDistanceBlocksSq = renderDistanceChunks === 0 ? Infinity : renderDistanceBlocks * renderDistanceBlocks;
    
    // Detail distance for partial blocks (grass, flowers, slabs, etc.)
    const detailDistanceBlocks = detailDistanceChunks * 16;
    const detailDistanceBlocksSq = detailDistanceChunks === 0 ? Infinity : detailDistanceBlocks * detailDistanceBlocks;
    
    let visibleCount = 0;
    let hiddenCount = 0;
    
    // Helper to update visibility for a mesh array with a given distance threshold
    const updateMeshArrayVisibility = (meshArray, maxDistSq) => {
      for (const mesh of meshArray) {
        // Get mesh center for distance calculation
        let meshCenterX, meshCenterZ;
        
        // First check if we have stored chunk center (fastest)
        if (mesh.userData?.chunkCenterX !== undefined) {
          meshCenterX = mesh.userData.chunkCenterX;
          meshCenterZ = mesh.userData.chunkCenterZ;
        } else if (mesh.isLOD) {
          // LOD objects have their position set to the mesh center
          meshCenterX = mesh.position.x;
          meshCenterZ = mesh.position.z;
        } else {
          // Fall back to computing from geometry (slower)
          if (mesh.geometry?.boundingBox) {
            const center = new THREE.Vector3();
            mesh.geometry.boundingBox.getCenter(center);
            mesh.localToWorld(center);
            meshCenterX = center.x;
            meshCenterZ = center.z;
            // Cache for next time
            mesh.userData.chunkCenterX = meshCenterX;
            mesh.userData.chunkCenterZ = meshCenterZ;
          } else if (mesh.geometry) {
            mesh.geometry.computeBoundingBox();
            const center = new THREE.Vector3();
            mesh.geometry.boundingBox.getCenter(center);
            mesh.localToWorld(center);
            meshCenterX = center.x;
            meshCenterZ = center.z;
            mesh.userData.chunkCenterX = meshCenterX;
            mesh.userData.chunkCenterZ = meshCenterZ;
          } else {
            // Last resort: use mesh position
            meshCenterX = mesh.position.x;
            meshCenterZ = mesh.position.z;
          }
        }
        
        // Calculate Euclidean distance squared (circular render distance like Minecraft)
        const dx = meshCenterX - cameraX;
        const dz = meshCenterZ - cameraZ;
        const distSq = dx * dx + dz * dz;
        
        // Set visibility based on distance
        const shouldBeVisible = distSq <= maxDistSq;
        if (mesh.visible !== shouldBeVisible) {
          mesh.visible = shouldBeVisible;
        }
        
        if (shouldBeVisible) {
          visibleCount++;
        } else {
          hiddenCount++;
        }
      }
    };
    
    // Solid blocks use full render distance
    updateMeshArrayVisibility(this.solidMeshes, renderDistanceBlocksSq);
    updateMeshArrayVisibility(this.waterMeshes, renderDistanceBlocksSq);
    updateMeshArrayVisibility(this.lavaMeshes, renderDistanceBlocksSq);
    updateMeshArrayVisibility(this.glassMeshes, renderDistanceBlocksSq);
    
    // Model blocks (partial blocks) use detail distance
    // Use the smaller of detail distance and render distance
    const modelMaxDistSq = Math.min(detailDistanceBlocksSq, renderDistanceBlocksSq);
    updateMeshArrayVisibility(this.modelMeshes, modelMaxDistSq);
    updateMeshArrayVisibility(this.transparentModelMeshes, modelMaxDistSq);
    updateMeshArrayVisibility(this.overlayModelMeshes, modelMaxDistSq);
    updateMeshArrayVisibility(this.instancedMeshes, modelMaxDistSq);
    
    // Only log when there's a significant change (avoid spam)
    if (hiddenCount > 0 && !this._lastVisibilityLog) {
      console.log(`[ChunkManager] Render distance culling: ${visibleCount} visible, ${hiddenCount} hidden (terrain: ${renderDistanceChunks} chunks, detail: ${detailDistanceChunks} chunks)`);
      this._lastVisibilityLog = true;
    } else if (hiddenCount === 0 && this._lastVisibilityLog) {
      console.log(`[ChunkManager] All ${visibleCount} chunks visible`);
      this._lastVisibilityLog = false;
    }
  }
  
  /**
   * Set visibility of all meshes
   * @param {boolean} visible
   */
  _setAllMeshesVisible(visible) {
    const meshArrays = [
      this.solidMeshes,
      this.waterMeshes,
      this.lavaMeshes,
      this.glassMeshes,
      this.modelMeshes,
      this.transparentModelMeshes,
      this.overlayModelMeshes,
      this.instancedMeshes,
    ];
    
    for (const meshArray of meshArrays) {
      for (const mesh of meshArray) {
        if (mesh.visible !== visible) {
          mesh.visible = visible;
        }
      }
    }
  }

  /**
   * Split mesh data into chunks that fit within WebGL limits
   */
  _splitMeshData(meshData) {
    if (!meshData || meshData.indices.length <= MAX_INDICES_PER_DRAW) {
      return meshData ? [meshData] : [];
    }
    
    const { positions, normals, colors, indices, texIndices, texRotations } = meshData;
    const hasTexIndices = !!texIndices;
    const hasTexRotations = !!texRotations;
    
    const chunks = [];
    const indicesPerChunk = Math.floor(MAX_INDICES_PER_DRAW / 6) * 6;
    
    let indexOffset = 0;
    while (indexOffset < indices.length) {
      const chunkIndices = [];
      const chunkPositions = [];
      const chunkNormals = [];
      const chunkColors = [];
      const chunkTexIndices = hasTexIndices ? [] : null;
      const chunkTexRotations = hasTexRotations ? [] : null;
      const vertexMap = new Map();
      let newVertexIndex = 0;
      
      const endIndex = Math.min(indexOffset + indicesPerChunk, indices.length);
      
      for (let i = indexOffset; i < endIndex; i++) {
        const oldIdx = indices[i];
        
        if (!vertexMap.has(oldIdx)) {
          const pos = oldIdx * 3;
          chunkPositions.push(positions[pos], positions[pos + 1], positions[pos + 2]);
          chunkNormals.push(normals[pos], normals[pos + 1], normals[pos + 2]);
          chunkColors.push(colors[pos], colors[pos + 1], colors[pos + 2]);
          if (hasTexIndices) chunkTexIndices.push(texIndices[oldIdx]);
          if (hasTexRotations) chunkTexRotations.push(texRotations[oldIdx]);
          vertexMap.set(oldIdx, newVertexIndex++);
        }
        
        chunkIndices.push(vertexMap.get(oldIdx));
      }
      
      const chunk = {
        positions: new Float32Array(chunkPositions),
        normals: new Float32Array(chunkNormals),
        colors: new Float32Array(chunkColors),
        indices: new Uint32Array(chunkIndices),
        vertexCount: newVertexIndex,
        triangleCount: chunkIndices.length / 3,
      };
      
      if (hasTexIndices) chunk.texIndices = new Float32Array(chunkTexIndices);
      if (hasTexRotations) chunk.texRotations = new Float32Array(chunkTexRotations);
      
      chunks.push(chunk);
      
      indexOffset = endIndex;
    }
    
    return chunks;
  }

  /**
   * PERFORMANCE: Split mesh data into spatial chunks for effective frustum culling
   * Each chunk covers a CHUNK_SIZE x CHUNK_SIZE area in XZ plane
   * This allows Three.js to cull entire chunks when they're outside the camera frustum
   */
  _splitMeshSpatially(meshData, chunkSize = 16) {
    if (!meshData || meshData.vertexCount === 0) return [];
    
    const { positions, normals, colors, indices, texIndices, texRotations,
            tintTypes, skyLight, blockLight, modelUVs, uvs, shadeFlags, singleSidedFlags } = meshData;
    
    // Build spatial bins based on triangle centroids
    const bins = new Map(); // key: "chunkX,chunkZ" -> { triangles: [] }
    
    // Process each triangle
    const triangleCount = indices.length / 3;
    for (let t = 0; t < triangleCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];
      
      // Calculate triangle centroid
      const cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3;
      const cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;
      
      // Determine which spatial chunk this triangle belongs to
      const chunkX = Math.floor(cx / chunkSize);
      const chunkZ = Math.floor(cz / chunkSize);
      const key = `${chunkX},${chunkZ}`;
      
      if (!bins.has(key)) {
        bins.set(key, { triangles: [] });
      }
      bins.get(key).triangles.push(t);
    }
    
    // Build mesh data for each bin
    const chunks = [];
    for (const [key, bin] of bins) {
      if (bin.triangles.length === 0) continue;
      
      // Collect vertices for this bin
      const chunkPositions = [];
      const chunkNormals = [];
      const chunkColors = [];
      const chunkIndices = [];
      const chunkTexIndices = texIndices ? [] : null;
      const chunkTexRotations = texRotations ? [] : null;
      const chunkTintTypes = tintTypes ? [] : null;
      const chunkSkyLight = skyLight ? [] : null;
      const chunkBlockLight = blockLight ? [] : null;
      const chunkModelUVs = modelUVs ? [] : null;
      const chunkUVs = uvs ? [] : null;
      const chunkShadeFlags = shadeFlags ? [] : null;
      const chunkSingleSidedFlags = singleSidedFlags ? [] : null;
      
      const vertexMap = new Map(); // old index -> new index
      let newVertexIndex = 0;
      
      for (const triIdx of bin.triangles) {
        for (let v = 0; v < 3; v++) {
          const oldIdx = indices[triIdx * 3 + v];
          
          if (!vertexMap.has(oldIdx)) {
            const pos = oldIdx * 3;
            chunkPositions.push(positions[pos], positions[pos + 1], positions[pos + 2]);
            chunkNormals.push(normals[pos], normals[pos + 1], normals[pos + 2]);
            chunkColors.push(colors[pos], colors[pos + 1], colors[pos + 2]);
            
            if (texIndices) chunkTexIndices.push(texIndices[oldIdx]);
            if (texRotations) chunkTexRotations.push(texRotations[oldIdx]);
            if (tintTypes) chunkTintTypes.push(tintTypes[oldIdx]);
            if (skyLight) chunkSkyLight.push(skyLight[oldIdx]);
            if (blockLight) chunkBlockLight.push(blockLight[oldIdx]);
            if (modelUVs) {
              const uvIdx = oldIdx * 2;
              chunkModelUVs.push(modelUVs[uvIdx], modelUVs[uvIdx + 1]);
            }
            if (uvs) {
              const uvIdx = oldIdx * 2;
              chunkUVs.push(uvs[uvIdx], uvs[uvIdx + 1]);
            }
            if (shadeFlags) chunkShadeFlags.push(shadeFlags[oldIdx]);
            if (singleSidedFlags) chunkSingleSidedFlags.push(singleSidedFlags[oldIdx]);
            
            vertexMap.set(oldIdx, newVertexIndex++);
          }
          
          chunkIndices.push(vertexMap.get(oldIdx));
        }
      }
      
      // Parse the chunk key to get spatial chunk coordinates
      const [spatialChunkXStr, spatialChunkZStr] = key.split(',');
      const spatialChunkX = parseInt(spatialChunkXStr, 10);
      const spatialChunkZ = parseInt(spatialChunkZStr, 10);
      
      // Calculate the center of this spatial chunk in world coordinates
      // The chunk covers [chunkX * chunkSize, (chunkX + 1) * chunkSize) range
      const chunkCenterX = (spatialChunkX + 0.5) * chunkSize;
      const chunkCenterZ = (spatialChunkZ + 0.5) * chunkSize;
      
      const chunk = {
        positions: new Float32Array(chunkPositions),
        normals: new Float32Array(chunkNormals),
        colors: new Float32Array(chunkColors),
        indices: new Uint32Array(chunkIndices),
        vertexCount: newVertexIndex,
        triangleCount: chunkIndices.length / 3,
        // Store center position for render distance calculation
        centerX: chunkCenterX,
        centerZ: chunkCenterZ,
      };
      
      if (chunkTexIndices) chunk.texIndices = new Float32Array(chunkTexIndices);
      if (chunkTexRotations) chunk.texRotations = new Float32Array(chunkTexRotations);
      if (chunkTintTypes) chunk.tintTypes = new Float32Array(chunkTintTypes);
      if (chunkSkyLight) chunk.skyLight = new Float32Array(chunkSkyLight);
      if (chunkBlockLight) chunk.blockLight = new Float32Array(chunkBlockLight);
      if (chunkModelUVs) chunk.modelUVs = new Float32Array(chunkModelUVs);
      if (chunkUVs) chunk.uvs = new Float32Array(chunkUVs);
      if (chunkShadeFlags) chunk.shadeFlags = new Float32Array(chunkShadeFlags);
      if (chunkSingleSidedFlags) chunk.singleSidedFlags = new Float32Array(chunkSingleSidedFlags);
      
      chunks.push(chunk);
    }
    
    console.log(`[ChunkManager] Split mesh into ${chunks.length} spatial chunks (${chunkSize}x${chunkSize} blocks each)`);
    return chunks;
  }

  /**
   * Add meshes to scene from mesh data
   * PERFORMANCE: Uses spatial chunking for large meshes to enable effective frustum culling
   * @param {Object} meshData - Mesh data with positions, normals, etc.
   * @param {THREE.Material} material - Material to use
   * @param {THREE.Group} group - Group to add meshes to
   * @param {Array} meshArray - Array to track meshes
   * @param {number} renderOrder - Optional render order
   * @param {number} spatialChunkSize - Optional spatial chunk size (default 16 to match Minecraft chunks)
   */
  _addMeshesToScene(meshData, material, group, meshArray, renderOrder = undefined, spatialChunkSize = 16) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    // PERFORMANCE: For large meshes, split spatially for better frustum culling
    // When looking at a wall, chunks behind you won't be rendered
    // Smaller chunks = more draw calls but better frustum culling and render distance accuracy
    // Lower threshold ensures per-Minecraft-chunk visibility for render distance
    const SPATIAL_CHUNK_THRESHOLD = 1000; // Low threshold to always split for render distance
    const useSpatialChunking = meshData.triangleCount > SPATIAL_CHUNK_THRESHOLD;
    
    let splitData;
    if (useSpatialChunking) {
      splitData = this._splitMeshSpatially(meshData, spatialChunkSize);
    } else {
      // Just use WebGL limit splitting for smaller meshes
      splitData = this._splitMeshData(meshData);
    }
    
    for (const data of splitData) {
      const geom = RegionMeshBuilder.createGeometry(data);
      if (geom) {
        const mesh = new THREE.Mesh(geom, material);
        mesh.frustumCulled = true;
        if (renderOrder !== undefined) {
          mesh.renderOrder = renderOrder;
        }
        // Store chunk center for render distance calculation
        // If data has explicit center (from spatial chunking), use it
        // Otherwise compute from geometry bounding box
        if (data.centerX !== undefined && data.centerZ !== undefined) {
          mesh.userData.chunkCenterX = data.centerX;
          mesh.userData.chunkCenterZ = data.centerZ;
        } else {
          // Compute center from geometry
          geom.computeBoundingBox();
          const center = new THREE.Vector3();
          geom.boundingBox.getCenter(center);
          mesh.userData.chunkCenterX = center.x;
          mesh.userData.chunkCenterZ = center.z;
        }
        group.add(mesh);
        meshArray.push(mesh);
      }
    }
    
    return splitData.length;
  }

  /**
   * Add meshes with LOD (Level of Detail) support
   * Creates a single THREE.LOD object with multiple detail levels
   * 
   * Meshes are kept in their original world coordinates (no translation).
   * LOD object is positioned at mesh center for distance calculation only.
   */
  _addMeshesWithLOD(meshData, lodMeshes, material, group, meshArray) {
    // EXPERIMENT: Skip LOD and use regular meshes
    if (DISABLE_LOD_OBJECTS) {
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // If no LOD meshes, fall back to regular mesh
    if (!lodMeshes || (!lodMeshes.lod1 && !lodMeshes.lod2)) {
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Check if full-detail mesh needs splitting - if so, we can't use LOD properly
    if (meshData.indices.length > MAX_INDICES_PER_DRAW) {
      console.log('[ChunkManager] Mesh too large for LOD, using split meshes without LOD');
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Create geometries WITHOUT any translation - they stay in world coords
    const geom0 = RegionMeshBuilder.createGeometry(meshData);
    if (!geom0) {
      return this._addMeshesToScene(meshData, material, group, meshArray);
    }
    
    // Compute center from full-detail mesh for LOD distance calculation
    geom0.computeBoundingBox();
    const meshCenter = new THREE.Vector3();
    geom0.boundingBox.getCenter(meshCenter);
    
    // Create LOD object
    const lod = new THREE.LOD();
    
    // Add full detail mesh
    const mesh0 = new THREE.Mesh(geom0, material);
    mesh0.frustumCulled = true;
    // Offset mesh position so it renders at correct world position
    // when LOD is at meshCenter
    mesh0.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    lod.addLevel(mesh0, 0);
    
    // Helper to add LOD level with proper positioning
    let lodLevelsAdded = 1; // Start at 1 for LOD0
    const addLodLevel = (lodData, distance, levelName) => {
      if (!lodData) {
        console.log(`[LOD] ${levelName} skipped - no data`);
        return;
      }
      const geom = RegionMeshBuilder.createGeometry(lodData);
      if (!geom) {
        console.log(`[LOD] ${levelName} skipped - no geometry`);
        return;
      }
      const mesh = new THREE.Mesh(geom, material);
      mesh.frustumCulled = true;
      mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
      lod.addLevel(mesh, distance);
      lodLevelsAdded++;
      console.log(`[LOD] ${levelName} added at distance ${distance}, ${lodData.triangleCount} tris`);
    };
    
    addLodLevel(lodMeshes.lod1, LOD_DISTANCE_1, 'LOD1');
    addLodLevel(lodMeshes.lod2, LOD_DISTANCE_2, 'LOD2');
    addLodLevel(lodMeshes.lod3, LOD_DISTANCE_3, 'LOD3');
    addLodLevel(lodMeshes.lod4, LOD_DISTANCE_4, 'LOD4');
    
    console.log(`[LOD] Total ${lodLevelsAdded} levels added to LOD object`);
    
    // Position LOD at mesh center for distance calculation
    lod.position.copy(meshCenter);
    // Store chunk center for render distance culling
    lod.userData.chunkCenterX = meshCenter.x;
    lod.userData.chunkCenterZ = meshCenter.z;
    
    // PERFORMANCE: Disable autoUpdate - we'll manually update LODs when camera moves
    // This is critical because autoUpdate runs every frame for EVERY LOD object
    lod.autoUpdate = false;
    // Enable frustum culling on LOD - important for performance when looking at a wall
    lod.frustumCulled = true;
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }

  /**
   * Add fluid mesh (water/lava) with LOD that hides it at distance
   * At close range: show full detail fluid mesh
   * At LOD distance: hide completely (fluids are baked into LOD surface mesh)
   */
  _addFluidMeshWithLOD(meshData, material, group, meshArray, meshCenter, renderOrder = undefined) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    // EXPERIMENT: Skip LOD and use regular meshes
    if (DISABLE_LOD_OBJECTS) {
      return this._addMeshesToScene(meshData, material, group, meshArray, renderOrder);
    }
    
    // Check if mesh needs splitting - if so, fall back to regular (always visible)
    if (meshData.indices.length > MAX_INDICES_PER_DRAW) {
      return this._addMeshesToScene(meshData, material, group, meshArray, renderOrder);
    }
    
    const geom = RegionMeshBuilder.createGeometry(meshData);
    if (!geom) return 0;
    
    // Create LOD object
    const lod = new THREE.LOD();
    if (renderOrder !== undefined) {
      lod.renderOrder = renderOrder;
    }
    
    // Level 0: Full detail fluid mesh
    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = true;
    mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    if (renderOrder !== undefined) {
      mesh.renderOrder = renderOrder;
    }
    lod.addLevel(mesh, 0);
    
    // Level 1: Empty mesh (invisible) at LOD_DISTANCE_1
    // Create minimal empty geometry to hide fluids when LOD kicks in
    const emptyGeom = new THREE.BufferGeometry();
    emptyGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const emptyMesh = new THREE.Mesh(emptyGeom, material);
    if (renderOrder !== undefined) {
      emptyMesh.renderOrder = renderOrder;
    }
    lod.addLevel(emptyMesh, LOD_DISTANCE_1);
    
    // Position LOD at same center as solid mesh
    lod.position.copy(meshCenter);
    // Store chunk center for render distance culling
    lod.userData.chunkCenterX = meshCenter.x;
    lod.userData.chunkCenterZ = meshCenter.z;
    // PERFORMANCE: Disable autoUpdate - we'll manually update LODs when camera moves
    lod.autoUpdate = false;
    lod.frustumCulled = true;
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }

  /**
   * Add model mesh with LOD support - shows progressively simpler models at distance
   * LOD0: All blocks (flowers, grass, decorative)
   * LOD1: Skip flowers and small plants (distance ~400)
   * LOD2: Skip vines, saplings, crops (distance ~800)
   * LOD3: Only structural (slabs, stairs, walls) (distance ~1200)
   */
  _addModelMeshWithLOD(meshData, lodMeshes, material, group, meshArray, meshCenter, renderOrder = undefined) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    // EXPERIMENT: Skip LOD and use regular meshes
    if (DISABLE_LOD_OBJECTS) {
      return this._addMeshesToScene(meshData, material, group, meshArray, renderOrder);
    }
    
    // If no LOD data or mesh needs splitting, fall back to regular mesh
    if (!lodMeshes || meshData.indices.length > MAX_INDICES_PER_DRAW) {
      return this._addMeshesToScene(meshData, material, group, meshArray, renderOrder);
    }
    
    const geom0 = RegionMeshBuilder.createGeometry(meshData);
    if (!geom0) {
      return this._addMeshesToScene(meshData, material, group, meshArray, renderOrder);
    }
    
    // Create LOD object
    const lod = new THREE.LOD();
    if (renderOrder !== undefined) {
      lod.renderOrder = renderOrder;
    }
    
    // Level 0: Full detail (all model blocks)
    const mesh0 = new THREE.Mesh(geom0, material);
    mesh0.frustumCulled = true;
    mesh0.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    if (renderOrder !== undefined) {
      mesh0.renderOrder = renderOrder;
    }
    lod.addLevel(mesh0, 0);
    
    // Helper to add LOD level
    const addLodLevel = (lodData, distance) => {
      if (!lodData || lodData.vertexCount === 0) return;
      const geom = RegionMeshBuilder.createGeometry(lodData);
      if (!geom) return;
      const mesh = new THREE.Mesh(geom, material);
      mesh.frustumCulled = true;
      mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
      if (renderOrder !== undefined) {
        mesh.renderOrder = renderOrder;
      }
      lod.addLevel(mesh, distance);
    };
    
    // Add LOD levels at progressive distances
    // These distances match the decorative block skip patterns:
    // - LOD1 at 400: Skip flowers, grass, small plants
    // - LOD2 at 800: Also skip vines, saplings, crops
    // - LOD3 at 1200: Only structural blocks (slabs, stairs, walls)
    if (lodMeshes.lod1) addLodLevel(lodMeshes.lod1, 400);
    if (lodMeshes.lod2) addLodLevel(lodMeshes.lod2, 800);
    if (lodMeshes.lod3) addLodLevel(lodMeshes.lod3, 1200);
    
    // At very far distances, hide model meshes entirely
    // (decorative blocks not visible at distance anyway)
    const emptyGeom = new THREE.BufferGeometry();
    emptyGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const emptyMesh = new THREE.Mesh(emptyGeom, material);
    if (renderOrder !== undefined) {
      emptyMesh.renderOrder = renderOrder;
    }
    lod.addLevel(emptyMesh, 2000);
    
    // Position LOD at mesh center
    lod.position.copy(meshCenter);
    // Store chunk center for render distance culling
    lod.userData.chunkCenterX = meshCenter.x;
    lod.userData.chunkCenterZ = meshCenter.z;
    // PERFORMANCE: Disable autoUpdate - we'll manually update LODs when camera moves
    lod.autoUpdate = false;
    lod.frustumCulled = true;
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }
  
  /**
   * Add GPU-instanced meshes for repeated blocks (grass, flowers, etc.)
   * Uses THREE.InstancedMesh for massive draw call reduction
   * @param {Array} instanceGroups - Array of { blockName, texIndex, positions, rotations, tintTypes, lights, instanceCount }
   * @returns {number} Number of draw calls added
   */
  _addInstancedMeshes(instanceGroups) {
    if (!instanceGroups || instanceGroups.length === 0) return 0;
    
    let drawCalls = 0;
    
    for (const group of instanceGroups) {
      const { blockName, texIndex, positions, rotations, tintTypes, lights, instanceCount } = group;
      
      if (instanceCount === 0) continue;
      
      // Create base cross geometry for this block type
      const baseGeometry = createCrossGeometry(texIndex);
      
      // Create instance data in the format expected by createInstancedMesh
      const instanceData = {
        offsets: positions,
        rotations,
        tintTypes,
        lights,
      };
      
      // Create the instanced mesh
      const instancedMesh = createInstancedMesh(baseGeometry, this.instancedMaterial, instanceData);
      instancedMesh.frustumCulled = true;
      instancedMesh.name = `instanced_${blockName}`;
      
      // Add to scene
      this.instancedGroup.add(instancedMesh);
      this.instancedMeshes.push(instancedMesh);
      drawCalls++;
      
      console.log(`[ChunkManager] ✓ Instanced ${blockName}: ${instanceCount.toLocaleString()} instances (1 draw call)`);
    }
    
    return drawCalls;
  }

  /**
   * Register particle emitters for blocks that emit particles (torches, etc.)
   * @param {Array} emitters - Array of { blockType, x, y, z, properties }
   */
  _registerParticleEmitters(emitters) {
    if (!this.particleEmitterManager || !emitters) return;
    
    for (const emitter of emitters) {
      this.particleEmitterManager.addEmitter(
        emitter.blockType,
        emitter.x,
        emitter.y,
        emitter.z,
        emitter.properties
      );
    }
    
    console.log(`[ChunkManager] Registered ${emitters.length} particle emitters`);
  }

  /**
   * Register beacon positions for beam rendering
   * @param {Array} beacons - Array of { x, y, z }
   */
  _registerBeacons(beacons) {
    if (!this.beaconBeamManager || !beacons || !this.beaconBeamsEnabled) return;
    
    for (const beacon of beacons) {
      this.beaconBeamManager.addBeacon(beacon.x, beacon.y, beacon.z);
    }
    
    if (beacons.length > 0) {
      console.log(`[ChunkManager] Registered ${beacons.length} beacons`);
    }
  }

  /**
   * Initialize the beacon beam manager
   * @param {TexturePackManager} [packManager] - Optional texture pack manager for loading beacon texture
   */
  async initBeaconBeamManager(packManager = null) {
    if (!this.beaconBeamsEnabled) return;
    
    await this.beaconBeamManager.initialize(packManager);
    this.scene.add(this.beaconBeamManager.getGroup());
    
    // Set up block lookup for beam tracing
    // Uses debugGrid if available
    // Note: beacon positions are offset-adjusted (like mesh vertices), so no further adjustment needed
    this.beaconBeamManager.setBlockLookup((x, y, z) => {
      if (this.debugGrid) {
        // debugGrid.getBlock returns {blockId, level} or null
        const blockData = this.debugGrid.getBlock(
          Math.floor(x),
          Math.floor(y),
          Math.floor(z)
        );
        if (!blockData) return 'air';
        
        // Get block name from registry
        const registry = getBlockRegistry();
        const blockInfo = registry?.getBlockInfo(blockData.blockId);
        return blockInfo?.name || 'air';
      }
      return 'air';
    });
    
    console.log('[ChunkManager] Beacon beam manager initialized');
  }

  /**
   * Initialize the particle system with the particle atlas
   * @param {ParticleAtlas} particleAtlas - The particle texture atlas
   */
  initParticleSystem(particleAtlas) {
    if (!this.particlesEnabled) return;
    
    if (this.particleSystem) {
      this.particleSystem.dispose();
    }
    
    this.particleSystem = new ParticleSystem(particleAtlas);
    this.scene.add(this.particleSystem.getGroup());
    
    // Set up collision function for particles
    // Uses debugGrid if available, otherwise just checks Y >= 0
    this.particleSystem.setCollisionFunction((x, y, z) => {
      // If debug grid is available, use it for accurate collision
      if (this.debugGrid) {
        const blockData = this.debugGrid.getBlock(
          Math.floor(x),
          Math.floor(y),
          Math.floor(z)
        );
        // Block ID 0 = air, anything else is solid (simplified)
        if (blockData && blockData.blockId !== 0) {
          return true;
        }
      }
      // Fallback: simple floor at Y = 0
      return y < 0;
    });
    
    console.log('[ChunkManager] Particle system initialized, atlas isBuilt:', particleAtlas?.isBuilt);
  }

  /**
   * Update particle system (call every frame)
   * @param {number} deltaTime - Time since last update in seconds
   * @param {number} time - Total elapsed time in seconds
   * @param {THREE.Camera} camera - The camera for distance culling
   */
  updateParticles(deltaTime, time, camera) {
    if (!this.particlesEnabled || !this.particleSystem) return;
    
    // Update camera position for emitter distance culling
    if (camera) {
      this.particleEmitterManager.updateCamera(
        camera.position.x,
        camera.position.y,
        camera.position.z
      );
    }
    
    // Update emitters (spawn new particles)
    this.particleEmitterManager.update(deltaTime, this.particleSystem);
    
    // Update particle physics and rendering (pass camera for depth sorting)
    this.particleSystem.update(deltaTime, time, camera);
    
    // Update beacon beams animation (pass camera for distance culling)
    if (this.beaconBeamManager && this.beaconBeamsEnabled) {
      if (camera) {
        this.beaconBeamManager.updateCamera(camera.position.x, camera.position.y, camera.position.z);
      }
      this.beaconBeamManager.update(deltaTime);
    }
  }

  /**
   * Set particle fog parameters
   * @param {Object} params - { color, start, end, enabled }
   */
  setParticleFog(params) {
    if (this.particleSystem) {
      this.particleSystem.setFog(params);
    }
  }
  
  /**
   * Set particle ambient brightness (darkens non-additive particles at night)
   * @param {Object} brightness - { r, g, b } values 0-1
   */
  setParticleAmbientBrightness(brightness) {
    if (this.particleSystem) {
      this.particleSystem.setAmbientBrightness(brightness);
    }
  }

  /**
   * Get particle count for debug display
   */
  getParticleCount() {
    return this.particleSystem?.getParticleCount() || 0;
  }

  /**
   * Get emitter count for debug display
   */
  getEmitterCount() {
    return this.particleEmitterManager?.getEmitterCount() || 0;
  }

  /**
   * Load chunks from parsed MCA data (single region, simple mode)
   */
  async loadChunks(chunks, options = {}) {
    const startTime = performance.now();
    this.clear();
    
    console.log(`[ChunkManager] Loading ${chunks.length} chunks...`);
    
    const meshBuilder = new RegionMeshBuilder({
      textureIndexLookup: this.getTextureIndexLookup(),
    });
    
    try {
      const result = await meshBuilder.buildRegion(chunks, { 
        enableModelMeshes: true,
        returnGrid: !!this.debugGrid,
      });
      const { solidMesh, waterMesh, lavaMesh, glassMesh, modelMesh, transparentModelMesh, overlayModelMesh, instanceGroups: ig3, particleEmitters, beaconPositions, offset, stats, _grid } = result;
      
      // Register particle emitters for torches and other light sources
      if (particleEmitters && this.particlesEnabled) {
        this._registerParticleEmitters(particleEmitters);
      }
      
      // Merge grid for debug lookups (must be done before beacon registration)
      if (_grid && this.debugGrid) {
        this._mergeDebugGrid(_grid);
      }
      
      // Set world offset for beacon beam manager (beacons use world coords, meshes use render coords)
      if (offset && this.beaconBeamManager) {
        this.beaconBeamManager.setWorldOffset(offset.x, offset.y, offset.z);
      }
      
      // Register beacon positions for beam rendering (after grid is merged so block lookup works)
      if (beaconPositions && this.beaconBeamsEnabled) {
        this._registerBeacons(beaconPositions);
      }
      
      if (solidMesh) this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
      if (waterMesh) this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes, 1);
      if (lavaMesh) this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, 2);
      if (glassMesh) this._addMeshesToScene(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes, 3);
      // Model meshes use smaller 32-block spatial chunks for better frustum culling
      if (modelMesh) this._addMeshesToScene(modelMesh, this.modelMaterial, this.modelGroup, this.modelMeshes, undefined, 32);
      if (transparentModelMesh) this._addMeshesToScene(transparentModelMesh, this.transparentModelMaterial, this.transparentModelGroup, this.transparentModelMeshes, 0.5, 32);
      if (overlayModelMesh) this._addMeshesToScene(overlayModelMesh, this.overlayModelMaterial, this.overlayModelGroup, this.overlayModelMeshes, 4, 32);
      
      // Add GPU-instanced meshes for repeated blocks
      if (ig3 && ig3.length > 0) {
        this._addInstancedMeshes(ig3);
      }
      
      this.totalBlocks = stats.totalBlocks;
      this.loadedChunks = stats.chunksProcessed;
      this.loadedRegions = 1;
      
      const totalTime = performance.now() - startTime;
      const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length + this.glassMeshes.length + this.modelMeshes.length + this.transparentModelMeshes.length + this.overlayModelMeshes.length;
      
      console.log(
        `[ChunkManager] Loaded ${chunks.length} chunks, ` +
        `${this.totalBlocks.toLocaleString()} blocks, ` +
        `${meshCount} draw calls in ${(totalTime / 1000).toFixed(2)}s`
      );
      
      meshBuilder.dispose();
      this.onComplete?.();
      
      return {
        chunksLoaded: this.loadedChunks,
        totalBlocks: this.totalBlocks,
      };
      
    } catch (error) {
      console.error('[ChunkManager] Failed to load chunks:', error);
      meshBuilder.dispose();
      throw error;
    }
  }

  /**
   * Progressive loading: Process regions in a streaming pipeline
   * 
   * Each region goes through: Parse → Mesh → Render
   * Multiple regions process in parallel (limited concurrency)
   * Memory is freed as each region completes its pipeline stage
   * 
   * @param {Array} regionFiles - Array of { file, regionX, regionZ } objects
   * @param {Function} parseRegion - Async function (file) => chunks array
   * @param {Object} options - { onRegionStart, onRegionComplete, enableLOD }
   */
  async loadRegionsProgressive(regionFiles, parseRegion, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, onStageChange, enableLOD = false, enableModelMeshes = false } = options;
    
    this.clear();
    
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let totalChunks = 0;
    let totalBlocks = 0;
    let totalTriangles = 0;
    
    // Reduce concurrency for large region counts to save memory
    const effectiveConcurrency = totalRegions > 10 ? 1 : MAX_CONCURRENT_REGIONS;
    const effectiveGcDelay = totalRegions > 10 ? 200 : REGION_GC_DELAY_MS;
    
    console.log(`[ChunkManager] Progressive loading ${totalRegions} regions (concurrency: ${effectiveConcurrency})...`);
    
    // Process a single region through the full pipeline
    const processRegion = async (regionInfo, index) => {
      const { file, regionX, regionZ } = regionInfo;
      const regionName = file.name || `Region ${regionX},${regionZ}`;
      
      onRegionStart?.(index, totalRegions, regionName);
      
      try {
        // Stage 1: Parsing
        onStageChange?.(index, totalRegions, regionName, 'parsing', 0);
        
        // Step 1: Parse the region file
        const parseStart = performance.now();
        const chunks = await parseRegion(file);
        const parseTime = performance.now() - parseStart;
        
        if (!chunks || chunks.length === 0) {
          console.warn(`[ChunkManager] No chunks in ${regionName}`);
          return null;
        }
        
        // Stage 2: Decoding
        onStageChange?.(index, totalRegions, regionName, 'decoding', 0);
        
        // Apply world offset to chunks (region coords * 32 chunks * 16 blocks)
        // The chunk x/z from parser are local (0-31), we need world coordinates
        const offsetChunks = chunks.map(chunk => ({
          ...chunk,
          x: chunk.x + regionX * 32,
          z: chunk.z + regionZ * 32,
        }));
        
        // Stage 3: Meshing
        onStageChange?.(index, totalRegions, regionName, 'meshing', 0);
        
        // Step 2: Build meshes (this region's builder is independent)
        // Don't center meshes - keep at world coordinates for proper multi-region positioning
        // Always generate LOD for multi-region loads - it's essential for performance
        const shouldGenerateLOD = enableLOD && totalRegions > 1;
        
        const meshBuilder = new RegionMeshBuilder({
          textureIndexLookup: this.getTextureIndexLookup(),
        });
        const meshStart = performance.now();
        const result = await meshBuilder.buildRegion(offsetChunks, { 
          centerMesh: false,
          generateLOD: shouldGenerateLOD,
          enableModelMeshes,
          returnGrid: !!this.debugGrid,
        });
        const meshTime = performance.now() - meshStart;
        
        // Merge grid for debug lookups
        if (result._grid && this.debugGrid) {
          this._mergeDebugGrid(result._grid);
        }
        
        // Stage 4: Adding to scene
        onStageChange?.(index, totalRegions, regionName, 'adding', 0);
        
        // Step 3: Add to scene immediately (user sees progress)
        const { solidMesh, waterMesh, lavaMesh, glassMesh, modelMesh, transparentModelMesh, overlayModelMesh, instanceGroups, lodMeshes, modelLodMeshes, particleEmitters, beaconPositions, offset, stats } = result;
        
        // Set world offset for beacon beam manager (beacons use world coords, meshes use render coords)
        if (offset && this.beaconBeamManager) {
          this.beaconBeamManager.setWorldOffset(offset.x, offset.y, offset.z);
        }
        
        // Register beacon positions for beam rendering
        if (beaconPositions && this.beaconBeamsEnabled) {
          this._registerBeacons(beaconPositions);
        }

        let drawCalls = 0;
        let meshCenter = null;
        
        // Solid blocks (15% progress)
        if (solidMesh) {
          if (shouldGenerateLOD && lodMeshes) {
            // Compute mesh center for LOD positioning (used by fluids too)
            const geom = RegionMeshBuilder.createGeometry(solidMesh);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose(); // We'll recreate in _addMeshesWithLOD
            }
            drawCalls += this._addMeshesWithLOD(solidMesh, lodMeshes, this.solidMaterial, this.solidGroup, this.solidMeshes);
          } else {
            drawCalls += this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 15);
        
        // For water/lava/glass: use LOD to hide at distance (fluids baked into LOD surface)
        if (waterMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter, 1);
          } else {
            drawCalls += this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes, 1);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 30);
        
        if (lavaMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter, 2);
          } else {
            drawCalls += this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, 2);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 45);
        
        if (glassMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter, 3);
          } else {
            drawCalls += this._addMeshesToScene(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes, 3);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 60);
        
        // Add model meshes (non-cube blocks like slabs, stairs, flowers)
        // Use LOD to progressively hide decorative blocks at distance
        // Model meshes use smaller 32-block spatial chunks for better frustum culling
        if (modelMesh) {
          if (shouldGenerateLOD && modelLodMeshes && meshCenter) {
            drawCalls += this._addModelMeshWithLOD(modelMesh, modelLodMeshes, this.modelMaterial, this.modelGroup, this.modelMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(modelMesh, this.modelMaterial, this.modelGroup, this.modelMeshes, undefined, 32);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 75);
        
        // Add transparent model meshes (glass panes, iron bars)
        // Use LOD to progressively simplify at distance
        if (transparentModelMesh) {
          if (shouldGenerateLOD && modelLodMeshes && meshCenter) {
            const transparentLodMeshes = {
              lod1: modelLodMeshes.lod1Transparent,
              lod2: modelLodMeshes.lod2Transparent,
              lod3: modelLodMeshes.lod3Transparent,
            };
            drawCalls += this._addModelMeshWithLOD(transparentModelMesh, transparentLodMeshes, this.transparentModelMaterial, this.transparentModelGroup, this.transparentModelMeshes, meshCenter, 0.5);
          } else {
            drawCalls += this._addMeshesToScene(transparentModelMesh, this.transparentModelMaterial, this.transparentModelGroup, this.transparentModelMeshes, 0.5, 32);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 85);
        
        // Add overlay model meshes (torch bulb glow panels)
        // Use LOD to progressively simplify at distance
        if (overlayModelMesh) {
          if (shouldGenerateLOD && modelLodMeshes && meshCenter) {
            const overlayLodMeshes = {
              lod1: modelLodMeshes.lod1Overlay,
              lod2: modelLodMeshes.lod2Overlay,
              lod3: modelLodMeshes.lod3Overlay,
            };
            drawCalls += this._addModelMeshWithLOD(overlayModelMesh, overlayLodMeshes, this.overlayModelMaterial, this.overlayModelGroup, this.overlayModelMeshes, meshCenter, 4);
          } else {
            drawCalls += this._addMeshesToScene(overlayModelMesh, this.overlayModelMaterial, this.overlayModelGroup, this.overlayModelMeshes, 4, 32);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 100);
        
        // Stage 5: Particles
        onStageChange?.(index, totalRegions, regionName, 'particles', 0);
        
        // Register particle emitters for torches and other light sources
        if (particleEmitters && this.particlesEnabled) {
          this._registerParticleEmitters(particleEmitters);
        }
        onStageChange?.(index, totalRegions, regionName, 'particles', 100);
        
        // Add GPU-instanced meshes for repeated blocks (grass, flowers, etc.)
        // This dramatically reduces draw calls and vertex processing
        if (instanceGroups && instanceGroups.length > 0) {
          drawCalls += this._addInstancedMeshes(instanceGroups);
        }
        
        // Clean up builder immediately to free memory
        meshBuilder.dispose();
        
        // Update stats
        totalChunks += stats.chunksProcessed;
        totalBlocks += stats.totalBlocks;
        const triangles = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
        totalTriangles += triangles;
        
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        
        console.log(
          `[ChunkManager] ✓ ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `(parse: ${(parseTime/1000).toFixed(1)}s, mesh: ${(meshTime/1000).toFixed(1)}s)`
        );
        
        onRegionComplete?.(index, totalRegions, regionName, stats);
        
        return stats;
        
      } catch (error) {
        // Log error but continue with other regions
        const errMsg = error?.message || String(error);
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed: ${errMsg.slice(0, 100)}`);
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        
        // Brief pause to help with memory recovery
        await new Promise(r => setTimeout(r, 200));
        return null;
      }
    };
    
    // Process regions with adaptive concurrency and GC pauses
    const results = [];
    const pending = [];
    
    for (let i = 0; i < regionFiles.length; i++) {
      // Start processing this region
      const promise = processRegion(regionFiles[i], i).then(result => {
        // Remove from pending when done
        const idx = pending.indexOf(promise);
        if (idx !== -1) pending.splice(idx, 1);
        return result;
      });
      
      pending.push(promise);
      results.push(promise);
      
      // Wait if we've hit the concurrency limit
      if (pending.length >= effectiveConcurrency) {
        await Promise.race(pending);
        // GC pause
        await new Promise(r => setTimeout(r, effectiveGcDelay));
      }
    }
    
    // Wait for all remaining regions
    await Promise.all(results);
    
    // Update final stats
    this.totalBlocks = totalBlocks;
    this.loadedChunks = totalChunks;
    this.loadedRegions = completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    
    console.log(
      `[ChunkManager] ✅ Complete: ${completedRegions} regions, ` +
      `${totalChunks.toLocaleString()} chunks, ${totalBlocks.toLocaleString()} blocks, ` +
      `${totalTriangles.toLocaleString()} triangles, ${meshCount} draw calls ` +
      `in ${(totalTime / 1000).toFixed(1)}s`
    );
    
    // Expose stats globally for E2E testing
    if (typeof window !== 'undefined') {
      window.__chunkManagerStats = {
        regions: completedRegions,
        chunks: totalChunks,
        blocks: totalBlocks,
        triangles: totalTriangles,
        meshCount,
        timeMs: totalTime,
      };
    }
    
    this.onComplete?.();
    
    return {
      regionsLoaded: completedRegions,
      chunksLoaded: totalChunks,
      totalBlocks,
      totalTriangles,
      meshCount,
      timeMs: totalTime,
    };
  }

  /**
   * Add more regions to existing scene (without clearing)
   */
  async addRegionsProgressive(regionFiles, parseRegion, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, onStageChange, enableLOD = false, enableModelMeshes = false } = options;
    
    // Don't clear - keep existing meshes
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let totalChunks = 0;
    let totalBlocks = 0;
    let totalTriangles = 0;
    
    // Adaptive processing based on current memory pressure
    const currentBlocks = this.totalBlocks;
    const isHighMemory = currentBlocks > HIGH_MEMORY_BLOCK_THRESHOLD;
    const isCriticalMemory = currentBlocks > CRITICAL_MEMORY_BLOCK_THRESHOLD;
    
    // Reduce concurrency and increase GC time under memory pressure
    const effectiveConcurrency = isCriticalMemory ? 1 : (isHighMemory ? 1 : MAX_CONCURRENT_REGIONS);
    const effectiveGcDelay = isCriticalMemory ? 500 : (isHighMemory ? 300 : REGION_GC_DELAY_MS);
    
    console.log(`[ChunkManager] Adding ${totalRegions} more regions...` + 
      (isHighMemory ? ` (memory-conservative mode: ${(currentBlocks / 1_000_000).toFixed(0)}M blocks loaded)` : ''));
    
    // Process a single region through the full pipeline
    const processRegion = async (regionInfo, index) => {
      const { file, regionX, regionZ } = regionInfo;
      const regionName = file.name || `Region ${regionX},${regionZ}`;
      
      onRegionStart?.(index, totalRegions, regionName);
      
      try {
        // Stage 1: Parsing
        onStageChange?.(index, totalRegions, regionName, 'parsing', 0);
        
        const parseStart = performance.now();
        const chunks = await parseRegion(file);
        const parseTime = performance.now() - parseStart;
        
        if (!chunks || chunks.length === 0) {
          console.warn(`[ChunkManager] No chunks in ${regionName}`);
          return null;
        }
        
        // Stage 2: Decoding
        onStageChange?.(index, totalRegions, regionName, 'decoding', 0);
        
        const offsetChunks = chunks.map(chunk => ({
          ...chunk,
          x: chunk.x + regionX * 32,
          z: chunk.z + regionZ * 32,
        }));
        
        // Stage 3: Meshing
        onStageChange?.(index, totalRegions, regionName, 'meshing', 0);
        
        const meshBuilder = new RegionMeshBuilder({
          textureIndexLookup: this.getTextureIndexLookup(),
        });
        const meshStart = performance.now();
        
        // Force single-threaded mode when memory is high to avoid parallel allocation failures
        // Generate LOD for added regions too (essential for performance with many regions)
        const shouldGenerateLOD = enableLOD && !isCriticalMemory;
        
        const result = await meshBuilder.buildRegion(offsetChunks, { 
          centerMesh: false,
          forceSequential: isHighMemory, // Skip parallel mesher
          generateLOD: shouldGenerateLOD,
          enableModelMeshes,
          returnGrid: !!this.debugGrid,
        });
        const meshTime = performance.now() - meshStart;
        
        // Merge grid for debug lookups
        if (result._grid && this.debugGrid) {
          this._mergeDebugGrid(result._grid);
        }
        
        // Stage 4: Adding to scene
        onStageChange?.(index, totalRegions, regionName, 'adding', 0);
        
        const { solidMesh, waterMesh, lavaMesh, glassMesh, modelMesh, transparentModelMesh, overlayModelMesh, instanceGroups: ig2, lodMeshes, modelLodMeshes, particleEmitters: pe2, beaconPositions: bp2, offset: off2, stats } = result;
        
        // Set world offset for beacon beam manager (beacons use world coords, meshes use render coords)
        if (off2 && this.beaconBeamManager) {
          this.beaconBeamManager.setWorldOffset(off2.x, off2.y, off2.z);
        }
        
        // Register beacon positions for beam rendering
        if (bp2 && this.beaconBeamsEnabled) {
          this._registerBeacons(bp2);
        }
        
        let drawCalls = 0;
        let meshCenter = null;
        
        // Solid blocks (15% progress)
        if (solidMesh) {
          if (shouldGenerateLOD && lodMeshes) {
            // Compute mesh center for LOD positioning (used by fluids too)
            const geom = RegionMeshBuilder.createGeometry(solidMesh);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose();
            }
            drawCalls += this._addMeshesWithLOD(solidMesh, lodMeshes, this.solidMaterial, this.solidGroup, this.solidMeshes);
          } else {
            drawCalls += this._addMeshesToScene(solidMesh, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 15);
        
        // For water/lava/glass: use LOD to hide at distance (fluids baked into LOD surface)
        if (waterMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter, 1);
          } else {
            drawCalls += this._addMeshesToScene(waterMesh, this.waterMaterial, this.waterGroup, this.waterMeshes, 1);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 30);
        
        if (lavaMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter, 2);
          } else {
            drawCalls += this._addMeshesToScene(lavaMesh, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, 2);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 45);
        
        if (glassMesh) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLOD(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter, 3);
          } else {
            drawCalls += this._addMeshesToScene(glassMesh, this.glassMaterial, this.glassGroup, this.glassMeshes, 3);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 60);
        
        // Add model meshes (non-cube blocks like slabs, stairs, flowers)
        // Use LOD to progressively hide decorative blocks at distance
        // Model meshes use smaller 32-block spatial chunks for better frustum culling
        if (modelMesh) {
          if (shouldGenerateLOD && modelLodMeshes && meshCenter) {
            drawCalls += this._addModelMeshWithLOD(modelMesh, modelLodMeshes, this.modelMaterial, this.modelGroup, this.modelMeshes, meshCenter);
          } else {
            drawCalls += this._addMeshesToScene(modelMesh, this.modelMaterial, this.modelGroup, this.modelMeshes, undefined, 32);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 75);
        
        // Add transparent model meshes (glass panes, iron bars)
        // Use LOD to progressively simplify at distance
        if (transparentModelMesh) {
          if (shouldGenerateLOD && modelLodMeshes && meshCenter) {
            const transparentLodMeshes = {
              lod1: modelLodMeshes.lod1Transparent,
              lod2: modelLodMeshes.lod2Transparent,
              lod3: modelLodMeshes.lod3Transparent,
            };
            drawCalls += this._addModelMeshWithLOD(transparentModelMesh, transparentLodMeshes, this.transparentModelMaterial, this.transparentModelGroup, this.transparentModelMeshes, meshCenter, 0.5);
          } else {
            drawCalls += this._addMeshesToScene(transparentModelMesh, this.transparentModelMaterial, this.transparentModelGroup, this.transparentModelMeshes, 0.5, 32);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 85);
        
        // Add overlay model meshes (torch bulb glow panels)
        // Use LOD to progressively simplify at distance
        if (overlayModelMesh) {
          if (shouldGenerateLOD && modelLodMeshes && meshCenter) {
            const overlayLodMeshes = {
              lod1: modelLodMeshes.lod1Overlay,
              lod2: modelLodMeshes.lod2Overlay,
              lod3: modelLodMeshes.lod3Overlay,
            };
            drawCalls += this._addModelMeshWithLOD(overlayModelMesh, overlayLodMeshes, this.overlayModelMaterial, this.overlayModelGroup, this.overlayModelMeshes, meshCenter, 4);
          } else {
            drawCalls += this._addMeshesToScene(overlayModelMesh, this.overlayModelMaterial, this.overlayModelGroup, this.overlayModelMeshes, 4, 32);
          }
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 95);
        
        // Add GPU-instanced meshes for repeated blocks (grass, flowers, etc.)
        if (ig2 && ig2.length > 0) {
          drawCalls += this._addInstancedMeshes(ig2);
        }
        onStageChange?.(index, totalRegions, regionName, 'adding', 100);
        
        // Stage 5: Particles
        onStageChange?.(index, totalRegions, regionName, 'particles', 0);
        
        // Register particle emitters for torches and other light sources
        if (pe2 && this.particlesEnabled) {
          this._registerParticleEmitters(pe2);
        }
        onStageChange?.(index, totalRegions, regionName, 'particles', 100);
        
        meshBuilder.dispose();
        
        totalChunks += stats.chunksProcessed;
        totalBlocks += stats.totalBlocks;
        const triangles = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
        totalTriangles += triangles;
        
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        
        console.log(
          `[ChunkManager] ✓ Added ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `(parse: ${(parseTime/1000).toFixed(1)}s, mesh: ${(meshTime/1000).toFixed(1)}s)`
        );
        
        onRegionComplete?.(index, totalRegions, regionName, stats);
        
        return stats;
        
      } catch (error) {
        const errMsg = error?.message || String(error);
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed: ${errMsg.slice(0, 100)}`);
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
        await new Promise(r => setTimeout(r, effectiveGcDelay * 2)); // Longer delay on error
        return null;
      }
    };
    
    // Process with adaptive concurrency based on memory pressure
    const results = [];
    const pending = [];
    
    for (let i = 0; i < regionFiles.length; i++) {
      const promise = processRegion(regionFiles[i], i).then(result => {
        const idx = pending.indexOf(promise);
        if (idx !== -1) pending.splice(idx, 1);
        return result;
      });
      
      pending.push(promise);
      results.push(promise);
      
      if (pending.length >= effectiveConcurrency) {
        await Promise.race(pending);
        // GC pause - longer when memory is high
        await new Promise(r => setTimeout(r, effectiveGcDelay));
      }
    }
    
    await Promise.all(results);
    
    // Update totals (add to existing)
    this.totalBlocks += totalBlocks;
    this.loadedChunks += totalChunks;
    this.loadedRegions += completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    
    console.log(
      `[ChunkManager] ✅ Added ${completedRegions} regions ` +
      `(total: ${this.loadedRegions} regions, ${this.loadedChunks.toLocaleString()} chunks, ` +
      `${this.totalBlocks.toLocaleString()} blocks) in ${(totalTime / 1000).toFixed(1)}s`
    );
    
    this.onComplete?.();
    
    return {
      regionsAdded: completedRegions,
      totalRegions: this.loadedRegions,
      totalChunks: this.loadedChunks,
      totalBlocks: this.totalBlocks,
      meshCount,
      timeMs: totalTime,
    };
  }

  /**
   * Fast streaming loading using unified worker pipeline
   * 
   * This method uses the new StreamingRegionLoader which handles the entire
   * pipeline (parse → decode → mesh) in a worker, returning transferable buffers.
   * 
   * This is the fastest method for loading regions:
   * - No main thread blocking during processing
   * - Transferable buffers avoid memory copies
   * - Target: 3 seconds per region
   * 
   * @param {Array} regionFiles - Array of { file, regionX, regionZ } objects
   * @param {Object} options - { onRegionStart, onRegionComplete }
   */
  async loadRegionsStreaming(regionFiles, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, onStageChange, enableLOD = true } = options;
    
    // Note: Streaming loader uses simplified worker that doesn't collect particle emitters
    // Particles (torch flames, smoke) only work with progressive or loadChunks paths
    if (this.particlesEnabled && this.particleSystem) {
      console.log('[ChunkManager] Note: Particle effects disabled in streaming mode (use progressive loading for particles)');
    }
    
    this.clear();
    
    if (!this.streamingLoader) {
      this.streamingLoader = new StreamingRegionLoader({
        maxWorkers: Math.min(navigator.hardwareConcurrency || 4, 4),
        gcDelay: 50,
      });
    }
    
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let totalBlocks = 0;
    let totalChunks = 0;
    let totalTriangles = 0;
    
    // Generate LOD for multi-region loads (essential for performance)
    const shouldGenerateLOD = enableLOD && totalRegions >= 1;
    
    console.log(`[ChunkManager] 🚀 Fast streaming ${totalRegions} regions (LOD: ${shouldGenerateLOD})...`);
    
    // Process all regions using the streaming loader
    for (let i = 0; i < regionFiles.length; i++) {
      const region = regionFiles[i];
      const regionName = region.file.name || `r.${region.regionX}.${region.regionZ}.mca`;
      
      onRegionStart?.(i, totalRegions, regionName);
      this.onProgress?.(i, totalRegions);
      
      try {
        // Stage 1: Parsing (worker does parse + decode + mesh together)
        onStageChange?.(i, totalRegions, regionName, 'parsing', 0);
        
        const regionStart = performance.now();
        const { result, stats } = await this.streamingLoader.processRegion(
          region.file,
          region.regionX,
          region.regionZ,
          { generateLOD: shouldGenerateLOD }
        );
        const regionTime = performance.now() - regionStart;
        
        // Worker completed parse+decode+mesh - now adding to scene
        // (skipping fake decoding/meshing stages since worker does them all at once)
        onStageChange?.(i, totalRegions, regionName, 'adding', 0);
        
        // Small delay to let React rerender and show the "adding" stage
        await new Promise(r => setTimeout(r, 10));
        
        // Add meshes to scene
        let drawCalls = 0;
        let meshCenter = null;
        
        // Handle solid mesh with LOD (25% progress)
        if (result.solid) {
          if (shouldGenerateLOD && result.lodMeshes) {
            // Compute mesh center for LOD positioning
            const geom = this._createGeometryFromBuffers(result.solid);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose();
            }
            drawCalls += this._addMeshWithLODFromBuffers(
              result.solid, 
              result.lodMeshes, 
              this.solidMaterial, 
              this.solidGroup, 
              this.solidMeshes
            );
          } else {
            drawCalls += this._addMeshFromBuffers(result.solid, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 25);
        await new Promise(r => setTimeout(r, 5));
        
        // Handle water/lava with LOD (hide at distance) - 50% progress
        if (result.water) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter, 1);
          } else {
            drawCalls += this._addMeshFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes, 1);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 50);
        await new Promise(r => setTimeout(r, 5));
        
        if (result.lava) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter, 2);
          } else {
            drawCalls += this._addMeshFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, 2);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 75);
        await new Promise(r => setTimeout(r, 5));
        
        if (result.glass) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter, 3);
          } else {
            drawCalls += this._addMeshFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes, 3);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 100);
        await new Promise(r => setTimeout(r, 5));
        
        // Stage 5: Particles (streaming mode doesn't have particles, but show stage anyway)
        onStageChange?.(i, totalRegions, regionName, 'particles', 100);
        await new Promise(r => setTimeout(r, 10));
        
        // Update stats
        totalBlocks += stats.totalBlocks || 0;
        totalChunks += stats.chunksProcessed || 0;
        const tris = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
        totalTriangles += tris;
        completedRegions++;
        
        const lodInfo = shouldGenerateLOD ? `, LOD: ${(stats.lodTimeMs || 0).toFixed(0)}ms` : '';
        // Show timing breakdown: parse(decompress+NBT) → decode → mesh
        const nativeTag = stats.usedNativeDecompress ? '⚡' : '';
        const parseBreakdown = stats.decompressTimeMs 
          ? `decomp${nativeTag}:${stats.decompressTimeMs.toFixed(0)}ms,NBT:${(stats.nbtParseTimeMs || 0).toFixed(0)}ms`
          : `parse:${(stats.parseTimeMs || 0).toFixed(0)}ms`;
        const failInfo = (stats.failedDecompress || stats.failedNBT) 
          ? ` ⚠️ ${stats.failedDecompress || 0} decompress/${stats.failedNBT || 0} NBT failures`
          : '';
        console.log(
          `[ChunkManager] ✓ ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `in ${(regionTime / 1000).toFixed(2)}s [${parseBreakdown}, decode:${(stats.decodeTimeMs || 0).toFixed(0)}ms, mesh:${(stats.meshTimeMs || 0).toFixed(0)}ms${lodInfo}]${failInfo}`
        );
        
        onRegionComplete?.(i, totalRegions, regionName, stats);
        this.onProgress?.(completedRegions, totalRegions);
        
      } catch (error) {
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed:`, error.message);
        completedRegions++;
        this.onProgress?.(completedRegions, totalRegions);
      }
    }
    
    // Update final stats
    this.totalBlocks = totalBlocks;
    this.loadedChunks = totalChunks;
    this.loadedRegions = completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    const avgTime = completedRegions > 0 ? totalTime / completedRegions : 0;
    
    console.log(
      `[ChunkManager] ✅ Streaming complete: ${completedRegions} regions, ` +
      `${totalChunks.toLocaleString()} chunks, ${totalBlocks.toLocaleString()} blocks, ` +
      `${totalTriangles.toLocaleString()} triangles in ${(totalTime / 1000).toFixed(1)}s ` +
      `(avg ${(avgTime / 1000).toFixed(2)}s/region)`
    );
    
    // Expose stats globally for E2E testing
    if (typeof window !== 'undefined') {
      window.__chunkManagerStats = {
        regions: completedRegions,
        chunks: totalChunks,
        blocks: totalBlocks,
        triangles: totalTriangles,
        meshCount,
        timeMs: totalTime,
      };
    }
    
    this.onComplete?.();
    
    return {
      regionsLoaded: completedRegions,
      chunksLoaded: totalChunks,
      totalBlocks,
      totalTriangles,
      meshCount,
      timeMs: totalTime,
      avgTimePerRegion: avgTime,
    };
  }
  
  /**
   * Add more regions using streaming loader (without clearing existing)
   */
  async addRegionsStreaming(regionFiles, options = {}) {
    const startTime = performance.now();
    const { onRegionStart, onRegionComplete, onStageChange, enableLOD = true } = options;
    
    // Don't clear - keep existing meshes
    
    if (!this.streamingLoader) {
      this.streamingLoader = new StreamingRegionLoader({
        maxWorkers: Math.min(navigator.hardwareConcurrency || 4, 4),
        gcDelay: 50,
      });
    }
    
    const totalRegions = regionFiles.length;
    let completedRegions = 0;
    let addedBlocks = 0;
    let addedChunks = 0;
    let addedTriangles = 0;
    
    // Generate LOD for added regions too
    const shouldGenerateLOD = enableLOD;
    
    console.log(`[ChunkManager] 🚀 Adding ${totalRegions} regions via streaming (LOD: ${shouldGenerateLOD})...`);
    
    // Process all regions using the streaming loader
    for (let i = 0; i < regionFiles.length; i++) {
      const region = regionFiles[i];
      const regionName = region.file.name || `r.${region.regionX}.${region.regionZ}.mca`;
      
      onRegionStart?.(i, totalRegions, regionName);
      this.onProgress?.(this.loadedRegions + i, this.loadedRegions + totalRegions);
      
      try {
        // Stage 1: Parsing
        onStageChange?.(i, totalRegions, regionName, 'parsing', 0);
        
        const regionStart = performance.now();
        const { result, stats } = await this.streamingLoader.processRegion(
          region.file,
          region.regionX,
          region.regionZ,
          { generateLOD: shouldGenerateLOD }
        );
        const regionTime = performance.now() - regionStart;
        
        // Worker completed parse+decode+mesh - now adding to scene
        // (skipping fake decoding/meshing stages since worker does them all at once)
        onStageChange?.(i, totalRegions, regionName, 'adding', 0);
        await new Promise(r => setTimeout(r, 10));
        
        // Add meshes to scene
        let drawCalls = 0;
        let meshCenter = null;
        
        // Handle solid mesh with LOD (25% progress)
        if (result.solid) {
          if (shouldGenerateLOD && result.lodMeshes) {
            const geom = this._createGeometryFromBuffers(result.solid);
            if (geom) {
              geom.computeBoundingBox();
              meshCenter = new THREE.Vector3();
              geom.boundingBox.getCenter(meshCenter);
              geom.dispose();
            }
            drawCalls += this._addMeshWithLODFromBuffers(
              result.solid, 
              result.lodMeshes, 
              this.solidMaterial, 
              this.solidGroup, 
              this.solidMeshes
            );
          } else {
            drawCalls += this._addMeshFromBuffers(result.solid, this.solidMaterial, this.solidGroup, this.solidMeshes);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 25);
        await new Promise(r => setTimeout(r, 5));
        
        // Handle water/lava/glass with LOD (hide at distance) - 50% progress
        if (result.water) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes, meshCenter, 1);
          } else {
            drawCalls += this._addMeshFromBuffers(result.water, this.waterMaterial, this.waterGroup, this.waterMeshes, 1);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 50);
        await new Promise(r => setTimeout(r, 5));
        
        if (result.lava) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, meshCenter, 2);
          } else {
            drawCalls += this._addMeshFromBuffers(result.lava, this.lavaMaterial, this.lavaGroup, this.lavaMeshes, 2);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 75);
        await new Promise(r => setTimeout(r, 5));
        
        if (result.glass) {
          if (shouldGenerateLOD && meshCenter) {
            drawCalls += this._addFluidMeshWithLODFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes, meshCenter, 3);
          } else {
            drawCalls += this._addMeshFromBuffers(result.glass, this.glassMaterial, this.glassGroup, this.glassMeshes, 3);
          }
        }
        onStageChange?.(i, totalRegions, regionName, 'adding', 100);
        await new Promise(r => setTimeout(r, 5));
        
        // Stage 5: Particles complete
        onStageChange?.(i, totalRegions, regionName, 'particles', 100);
        await new Promise(r => setTimeout(r, 10));
        
        // Update stats
        addedBlocks += stats.totalBlocks || 0;
        addedChunks += stats.chunksProcessed || 0;
        const tris = (stats.solidTriangles || 0) + (stats.waterTriangles || 0) + (stats.lavaTriangles || 0) + (stats.glassTriangles || 0);
        addedTriangles += tris;
        completedRegions++;
        
        const lodInfo = shouldGenerateLOD ? `, LOD: ${(stats.lodTimeMs || 0).toFixed(0)}ms` : '';
        console.log(
          `[ChunkManager] ✓ Added ${regionName}: ${stats.chunksProcessed} chunks, ` +
          `${stats.totalBlocks.toLocaleString()} blocks, ${drawCalls} draws ` +
          `in ${(regionTime / 1000).toFixed(2)}s${lodInfo}`
        );
        
        onRegionComplete?.(i, totalRegions, regionName, stats);
        this.onProgress?.(this.loadedRegions + completedRegions, this.loadedRegions + totalRegions);
        
      } catch (error) {
        console.warn(`[ChunkManager] ⚠️ ${regionName} failed:`, error.message);
        completedRegions++;
        this.onProgress?.(this.loadedRegions + completedRegions, this.loadedRegions + totalRegions);
      }
    }
    
    // Update cumulative stats
    this.totalBlocks += addedBlocks;
    this.loadedChunks += addedChunks;
    this.loadedRegions += completedRegions;
    
    const totalTime = performance.now() - startTime;
    const meshCount = this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length;
    const avgTime = completedRegions > 0 ? totalTime / completedRegions : 0;
    
    console.log(
      `[ChunkManager] ✅ Added ${completedRegions} regions, ` +
      `now have ${this.loadedRegions} total regions, ${this.totalBlocks.toLocaleString()} blocks ` +
      `in ${(totalTime / 1000).toFixed(1)}s`
    );
    
    this.onComplete?.();
    
    return {
      regionsAdded: completedRegions,
      totalRegions: this.loadedRegions,
      chunksAdded: addedChunks,
      totalChunks: this.loadedChunks,
      blocksAdded: addedBlocks,
      totalBlocks: this.totalBlocks,
      trianglesAdded: addedTriangles,
      meshCount,
      timeMs: totalTime,
      avgTimePerRegion: avgTime,
    };
  }
  
  /**
   * Add mesh from raw buffers (used by streaming loader)
   * PERFORMANCE: Uses spatial chunking for large meshes to enable effective frustum culling
   */
  _addMeshFromBuffers(meshData, material, group, meshArray, renderOrder = undefined) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    // PERFORMANCE: Split spatially for better frustum culling and render distance accuracy
    const SPATIAL_CHUNK_THRESHOLD = 1000; // Low threshold to always split for render distance
    const triangleCount = meshData.indices ? meshData.indices.length / 3 : 0;
    
    if (triangleCount > SPATIAL_CHUNK_THRESHOLD) {
      // Split into spatial chunks (16 blocks = 1 Minecraft chunk)
      const chunks = this._splitMeshSpatially(meshData, 16);
      for (const chunk of chunks) {
        const geometry = this._createGeometryFromBuffers(chunk);
        if (geometry) {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.frustumCulled = true;
          if (renderOrder !== undefined) {
            mesh.renderOrder = renderOrder;
          }
          group.add(mesh);
          meshArray.push(mesh);
        }
      }
      return chunks.length;
    }
    
    // Small mesh - no splitting needed
    const geometry = this._createGeometryFromBuffers(meshData);
    if (!geometry) return 0;
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    if (renderOrder !== undefined) {
      mesh.renderOrder = renderOrder;
    }
    group.add(mesh);
    meshArray.push(mesh);
    
    return 1;
  }
  
  /**
   * Create a THREE.BufferGeometry from raw buffer data
   * Handles both solid blocks (with colors) and fluids (with UVs)
   */
  _createGeometryFromBuffers(meshData) {
    if (!meshData || meshData.vertexCount === 0) return null;
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    
    // Colors (used for vertex color tinting)
    if (meshData.colors) {
      geometry.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
    }
    
    // UV coordinates (for fluid meshes) - FluidMesher outputs 'uvs', shader expects 'modelUV'
    if (meshData.uvs) {
      geometry.setAttribute('modelUV', new THREE.BufferAttribute(meshData.uvs, 2));
    }
    
    // Texture index (for atlas lookup)
    if (meshData.texIndices) {
      geometry.setAttribute('texIndex', new THREE.BufferAttribute(meshData.texIndices, 1));
    }
    
    // Light data (for lightmap sampling)
    if (meshData.skyLight) {
      geometry.setAttribute('skyLight', new THREE.BufferAttribute(meshData.skyLight, 1));
    }
    if (meshData.blockLight) {
      geometry.setAttribute('blockLight', new THREE.BufferAttribute(meshData.blockLight, 1));
    }
    
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingSphere();
    
    return geometry;
  }
  
  /**
   * Add mesh with LOD levels from raw buffers (used by streaming loader)
   */
  _addMeshWithLODFromBuffers(solidData, lodMeshes, material, group, meshArray) {
    if (!solidData || solidData.vertexCount === 0) return 0;
    
    // EXPERIMENT: Skip LOD and use regular meshes
    if (DISABLE_LOD_OBJECTS) {
      return this._addMeshFromBuffers(solidData, material, group, meshArray);
    }
    
    if (!lodMeshes || (!lodMeshes.lod1 && !lodMeshes.lod2)) {
      return this._addMeshFromBuffers(solidData, material, group, meshArray);
    }
    
    // Check if full-detail mesh is too large for LOD
    if (solidData.indices.length > MAX_INDICES_PER_DRAW) {
      console.log('[ChunkManager] Mesh too large for LOD, using regular mesh');
      return this._addMeshFromBuffers(solidData, material, group, meshArray);
    }
    
    // Create full-detail geometry
    const geom0 = this._createGeometryFromBuffers(solidData);
    if (!geom0) return 0;
    
    // Compute center for LOD distance calculation
    geom0.computeBoundingBox();
    const meshCenter = new THREE.Vector3();
    geom0.boundingBox.getCenter(meshCenter);
    
    // Create LOD object
    const lod = new THREE.LOD();
    
    // Add full detail mesh
    const mesh0 = new THREE.Mesh(geom0, material);
    mesh0.frustumCulled = true;
    mesh0.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    lod.addLevel(mesh0, 0);
    
    // Add LOD levels
    let lodLevelsAdded = 1;
    const addLodLevel = (lodData, distance, levelName) => {
      if (!lodData) return;
      const geom = this._createGeometryFromBuffers(lodData);
      if (!geom) return;
      const mesh = new THREE.Mesh(geom, material);
      mesh.frustumCulled = true;
      mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
      lod.addLevel(mesh, distance);
      lodLevelsAdded++;
      console.log(`[LOD] ${levelName} added at distance ${distance}, ${lodData.triangleCount} tris`);
    };
    
    addLodLevel(lodMeshes.lod1, LOD_DISTANCE_1, 'LOD1');
    addLodLevel(lodMeshes.lod2, LOD_DISTANCE_2, 'LOD2');
    addLodLevel(lodMeshes.lod3, LOD_DISTANCE_3, 'LOD3');
    addLodLevel(lodMeshes.lod4, LOD_DISTANCE_4, 'LOD4');
    
    console.log(`[LOD] Total ${lodLevelsAdded} levels added to LOD object`);
    
    // Position LOD at mesh center for distance calculation
    lod.position.copy(meshCenter);
    // Store chunk center for render distance culling
    lod.userData.chunkCenterX = meshCenter.x;
    lod.userData.chunkCenterZ = meshCenter.z;
    // PERFORMANCE: Disable autoUpdate - we'll manually update LODs when camera moves
    lod.autoUpdate = false;
    lod.frustumCulled = true;
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }
  
  /**
   * Add fluid mesh with LOD that hides it at distance (from raw buffers)
   */
  _addFluidMeshWithLODFromBuffers(meshData, material, group, meshArray, meshCenter, renderOrder = undefined) {
    if (!meshData || meshData.vertexCount === 0) return 0;
    
    // EXPERIMENT: Skip LOD and use regular meshes
    if (DISABLE_LOD_OBJECTS) {
      return this._addMeshFromBuffers(meshData, material, group, meshArray, renderOrder);
    }
    
    // Check if mesh is too large
    if (meshData.indices.length > MAX_INDICES_PER_DRAW) {
      return this._addMeshFromBuffers(meshData, material, group, meshArray, renderOrder);
    }
    
    const geom = this._createGeometryFromBuffers(meshData);
    if (!geom) return 0;
    
    // Create LOD object
    const lod = new THREE.LOD();
    if (renderOrder !== undefined) {
      lod.renderOrder = renderOrder;
    }
    
    // Level 0: Full detail fluid mesh
    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = true;
    mesh.position.set(-meshCenter.x, -meshCenter.y, -meshCenter.z);
    if (renderOrder !== undefined) {
      mesh.renderOrder = renderOrder;
    }
    lod.addLevel(mesh, 0);
    
    // Level 1: Empty mesh (invisible) at LOD_DISTANCE_1
    const emptyGeom = new THREE.BufferGeometry();
    emptyGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const emptyMesh = new THREE.Mesh(emptyGeom, material);
    if (renderOrder !== undefined) {
      emptyMesh.renderOrder = renderOrder;
    }
    lod.addLevel(emptyMesh, LOD_DISTANCE_1);
    
    // Position LOD at same center as solid mesh
    lod.position.copy(meshCenter);
    // Store chunk center for render distance culling
    lod.userData.chunkCenterX = meshCenter.x;
    lod.userData.chunkCenterZ = meshCenter.z;
    // PERFORMANCE: Disable autoUpdate - we'll manually update LODs when camera moves
    lod.autoUpdate = false;
    lod.frustumCulled = true;
    
    group.add(lod);
    meshArray.push(lod);
    
    return 1;
  }

  /**
   * Dispose a mesh or LOD object and all its geometries
   */
  _disposeMeshOrLOD(obj) {
    if (obj.isLOD) {
      // LOD object - dispose all levels
      obj.levels.forEach(level => {
        if (level.object?.geometry) {
          level.object.geometry.dispose();
        }
      });
    } else if (obj.geometry) {
      obj.geometry.dispose();
    }
  }

  /**
   * Clear all meshes
   */
  clear() {
    for (const mesh of this.solidMeshes) {
      this.solidGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.solidMeshes = [];
    
    for (const mesh of this.waterMeshes) {
      this.waterGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.waterMeshes = [];
    
    for (const mesh of this.lavaMeshes) {
      this.lavaGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.lavaMeshes = [];
    
    for (const mesh of this.glassMeshes) {
      this.glassGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.glassMeshes = [];
    
    for (const mesh of this.modelMeshes) {
      this.modelGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.modelMeshes = [];
    
    for (const mesh of this.transparentModelMeshes) {
      this.transparentModelGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.transparentModelMeshes = [];
    
    for (const mesh of this.overlayModelMeshes) {
      this.overlayModelGroup.remove(mesh);
      this._disposeMeshOrLOD(mesh);
    }
    this.overlayModelMeshes = [];
    
    // Clear instanced meshes
    for (const mesh of this.instancedMeshes) {
      this.instancedGroup.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
    }
    this.instancedMeshes = [];
    
    // Clear particle emitters and particles
    this.particleEmitterManager.clear();
    if (this.particleSystem) {
      this.particleSystem.clear();
    }
    
    // Clear beacon beams
    if (this.beaconBeamManager) {
      this.beaconBeamManager.clear();
    }
    
    this.totalBlocks = 0;
    this.loadedChunks = 0;
    this.loadedRegions = 0;
    
    // Clear debug grid
    if (this.debugGrid) {
      this.debugGrid.clear();
    }
  }

  /**
   * Dispose all resources
   */
  dispose() {
    this.clear();
    
    // Dispose streaming loader
    if (this.streamingLoader) {
      this.streamingLoader.dispose();
      this.streamingLoader = null;
    }
    
    // Dispose particle system
    if (this.particleSystem) {
      this.scene.remove(this.particleSystem.getGroup());
      this.particleSystem.dispose();
      this.particleSystem = null;
    }
    
    // Dispose beacon beam manager
    if (this.beaconBeamManager) {
      this.scene.remove(this.beaconBeamManager.getGroup());
      this.beaconBeamManager.dispose();
      this.beaconBeamManager = null;
    }
    
    this.solidMaterial.dispose();
    this.waterMaterial.dispose();
    this.lavaMaterial.dispose();
    this.glassMaterial.dispose();
    this.modelMaterial.dispose();
    this.transparentModelMaterial.dispose();
    this.overlayModelMaterial.dispose();
    this.instancedMaterial.dispose();
    
    this.scene.remove(this.solidGroup);
    this.scene.remove(this.waterGroup);
    this.scene.remove(this.lavaGroup);
    this.scene.remove(this.glassGroup);
    this.scene.remove(this.modelGroup);
    this.scene.remove(this.transparentModelGroup);
    this.scene.remove(this.overlayModelGroup);
    this.scene.remove(this.instancedGroup);
  }

  /**
   * Update all LOD objects based on camera position
   * Call this manually when camera moves significantly (instead of every frame)
   * PERFORMANCE: Uses incremental updates to avoid lag spikes
   * @param {THREE.Camera} camera - The camera to calculate distances from
   */
  updateLODs(camera) {
    if (!camera) return;
    
    // PERFORMANCE: Update LODs incrementally across frames to avoid spikes
    // Track which group we last updated
    if (!this._lodUpdateIndex) this._lodUpdateIndex = 0;
    if (!this._lodUpdateSubIndex) this._lodUpdateSubIndex = 0;
    
    const groups = [
      this.solidMeshes,
      this.waterMeshes,
      this.lavaMeshes,
      this.glassMeshes,
      this.modelMeshes,
      this.transparentModelMeshes,
      this.overlayModelMeshes,
    ];
    
    // Update only a batch of LODs per call to spread work across frames
    const MAX_UPDATES_PER_CALL = 10;
    let updatesThisCall = 0;
    
    while (updatesThisCall < MAX_UPDATES_PER_CALL) {
      if (this._lodUpdateIndex >= groups.length) {
        // Wrapped around - reset for next cycle
        this._lodUpdateIndex = 0;
        this._lodUpdateSubIndex = 0;
        break;
      }
      
      const group = groups[this._lodUpdateIndex];
      
      if (this._lodUpdateSubIndex >= group.length) {
        // Move to next group
        this._lodUpdateIndex++;
        this._lodUpdateSubIndex = 0;
        continue;
      }
      
      const obj = group[this._lodUpdateSubIndex];
      if (obj && obj.isLOD) {
        obj.update(camera);
        updatesThisCall++;
      }
      
      this._lodUpdateSubIndex++;
    }
  }
  
  /**
   * Force update all LODs immediately (use sparingly - can cause lag spike)
   * @param {THREE.Camera} camera
   */
  updateAllLODsNow(camera) {
    if (!camera) return;
    
    const updateLODArray = (meshArray) => {
      for (const obj of meshArray) {
        if (obj.isLOD) {
          obj.update(camera);
        }
      }
    };
    
    updateLODArray(this.solidMeshes);
    updateLODArray(this.waterMeshes);
    updateLODArray(this.lavaMeshes);
    updateLODArray(this.glassMeshes);
    updateLODArray(this.modelMeshes);
    updateLODArray(this.transparentModelMeshes);
    updateLODArray(this.overlayModelMeshes);
  }

  /**
   * DEBUG: Toggle visibility of specific block groups
   * Use this to diagnose performance issues by hiding different block types
   * @param {string} groupName - 'solid', 'water', 'lava', 'glass', 'model', 'transparentModel', 'overlay'
   * @param {boolean} visible - Whether to show the group
   */
  setGroupVisible(groupName, visible) {
    const groups = {
      solid: this.solidGroup,
      water: this.waterGroup,
      lava: this.lavaGroup,
      glass: this.glassGroup,  // This includes leaves!
      model: this.modelGroup,
      transparentModel: this.transparentModelGroup,
      overlay: this.overlayModelGroup,
    };
    
    if (groups[groupName]) {
      groups[groupName].visible = visible;
      console.log(`[ChunkManager] ${groupName} group: ${visible ? 'VISIBLE' : 'HIDDEN'}`);
    }
  }
  
  /**
   * PERFORMANCE: Toggle fast path mode for model materials
   * Fast path skips expensive biome tinting and lightmap sampling
   * Use during camera movement or on low-end devices for better FPS
   * @param {boolean} enabled - Whether to enable fast path
   */
  setFastPathMode(enabled) {
    setMaterialFastPath(this.modelMaterial, enabled);
    setMaterialFastPath(this.transparentModelMaterial, enabled);
    setMaterialFastPath(this.overlayModelMaterial, enabled);
    console.log(`[ChunkManager] Fast path mode: ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }
  
  /**
   * DEBUG: Print triangle counts per group to console
   * Helps diagnose which block types are most expensive
   */
  printTriangleCounts() {
    const countTriangles = (meshArray, name) => {
      let count = 0;
      for (const mesh of meshArray) {
        // Handle both regular meshes and LOD objects
        if (mesh.isLOD) {
          // Count from first (full detail) level
          const geom = mesh.levels[0]?.object?.geometry;
          const idx = geom?.getIndex();
          if (idx) count += idx.count / 3;
        } else {
          const idx = mesh.geometry?.getIndex();
          if (idx) count += idx.count / 3;
        }
      }
      console.log(`[ChunkManager] ${name}: ${count.toLocaleString()} triangles (${meshArray.length} meshes)`);
      return count;
    };
    
    console.log('=== Triangle Counts by Group ===');
    const solid = countTriangles(this.solidMeshes, 'Solid blocks');
    const water = countTriangles(this.waterMeshes, 'Water');
    const lava = countTriangles(this.lavaMeshes, 'Lava');
    const glass = countTriangles(this.glassMeshes, 'Glass/Leaves/Ice');
    const model = countTriangles(this.modelMeshes, 'Model blocks (stairs, slabs, etc.)');
    const transparentModel = countTriangles(this.transparentModelMeshes, 'Transparent models (glass panes)');
    const overlay = countTriangles(this.overlayModelMeshes, 'Overlay effects');
    
    const total = solid + water + lava + glass + model + transparentModel + overlay;
    console.log(`[ChunkManager] TOTAL: ${total.toLocaleString()} triangles`);
    console.log('================================');
    
    // Expose globally for easy console access
    if (typeof window !== 'undefined') {
      window.__triangleCounts = { solid, water, lava, glass, model, transparentModel, overlay, total };
    }
    
    return { solid, water, lava, glass, model, transparentModel, overlay, total };
  }

  /**
   * Get current stats
   */
  getStats() {
    let triangleCount = 0;
    
    for (const mesh of this.solidMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    for (const mesh of this.waterMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    for (const mesh of this.lavaMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    for (const mesh of this.modelMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    for (const mesh of this.transparentModelMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    for (const mesh of this.overlayModelMeshes) {
      const idx = mesh.geometry?.getIndex();
      if (idx) triangleCount += idx.count / 3;
    }
    
    return {
      regionsLoaded: this.loadedRegions,
      chunksLoaded: this.loadedChunks,
      totalBlocks: this.totalBlocks,
      triangleCount,
      meshCount: this.solidMeshes.length + this.waterMeshes.length + this.lavaMeshes.length + this.modelMeshes.length + this.transparentModelMeshes.length + this.overlayModelMeshes.length,
      particleEmitters: this.getEmitterCount(),
      particleCount: this.getParticleCount(),
    };
  }
}

export default ChunkManager;
