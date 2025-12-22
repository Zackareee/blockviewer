/**
 * RegionManager - Multi-region lifecycle management
 * 
 * Handles loading, unloading, and rendering multiple Minecraft regions.
 * Designed for scalability with 20+ concurrent regions.
 */

import * as THREE from 'three';
import { RegionMeshBuilder } from './RegionMeshBuilder.js';
import { getBlockRegistry } from './BlockRegistry.js';
import { createSolidMaterial } from '../viewer/materials/SolidMaterial.js';
import { createWaterMaterial } from '../viewer/materials/WaterMaterial.js';
import { createLavaMaterial } from '../viewer/materials/LavaMaterial.js';

/**
 * Region data structure
 */
class LoadedRegion {
  constructor(regionX, regionZ) {
    this.regionX = regionX;
    this.regionZ = regionZ;
    this.key = `${regionX},${regionZ}`;
    
    // Meshes
    this.solidMesh = null;
    this.waterMesh = null;
    this.lavaMesh = null;
    
    // Metadata
    this.offset = null;
    this.bounds = null;
    this.stats = null;
    this.loadedAt = Date.now();
    
    // State
    this.isLoading = false;
    this.isDisposed = false;
  }
  
  /**
   * Dispose all GPU resources
   */
  dispose() {
    if (this.isDisposed) return;
    
    if (this.solidMesh) {
      this.solidMesh.geometry.dispose();
      this.solidMesh = null;
    }
    
    if (this.waterMesh) {
      this.waterMesh.geometry.dispose();
      this.waterMesh = null;
    }
    
    if (this.lavaMesh) {
      this.lavaMesh.geometry.dispose();
      this.lavaMesh = null;
    }
    
    this.isDisposed = true;
  }
  
  /**
   * Get triangle count
   */
  get triangleCount() {
    let count = 0;
    if (this.stats) {
      count += this.stats.solidTriangles || 0;
      count += this.stats.waterTriangles || 0;
      count += this.stats.lavaTriangles || 0;
    }
    return count;
  }
  
  /**
   * Get block count
   */
  get blockCount() {
    return this.stats?.totalBlocks || 0;
  }
}

/**
 * RegionManager class
 */
export class RegionManager {
  constructor(scene, options = {}) {
    this.scene = scene;
    
    // Configuration
    this.maxRegions = options.maxRegions || 25;
    this.maxConcurrentLoads = options.maxConcurrentLoads || 4;
    this.workerCount = options.workerCount || Math.min(navigator.hardwareConcurrency || 4, 8);
    
    // Region storage
    this.regions = new Map(); // key -> LoadedRegion
    this.loadQueue = [];
    this.activeLoads = 0;
    
    // Callbacks
    this.onRegionLoaded = options.onRegionLoaded || null;
    this.onRegionUnloaded = options.onRegionUnloaded || null;
    this.onProgress = options.onProgress || null;
    
    // Scene groups
    this.solidGroup = new THREE.Group();
    this.solidGroup.name = 'RegionManager_Solid';
    this.waterGroup = new THREE.Group();
    this.waterGroup.name = 'RegionManager_Water';
    this.waterGroup.renderOrder = 1;
    this.lavaGroup = new THREE.Group();
    this.lavaGroup.name = 'RegionManager_Lava';
    this.lavaGroup.renderOrder = 2;
    
    scene.add(this.solidGroup);
    scene.add(this.waterGroup);
    scene.add(this.lavaGroup);
    
    // Shared materials
    this.materials = {
      solid: options.solidMaterial || createSolidMaterial(),
      water: options.waterMaterial || createWaterMaterial(),
      lava: options.lavaMaterial || createLavaMaterial(),
    };
    
    // Mesh builder
    this.builder = new RegionMeshBuilder({
      workerCount: this.workerCount,
      registry: getBlockRegistry(),
    });
    
    // Global offset for centering
    this.globalOffset = { x: 0, y: 0, z: 0 };
  }
  
  /**
   * Get region key from coordinates
   */
  _getKey(regionX, regionZ) {
    return `${regionX},${regionZ}`;
  }
  
  /**
   * Check if a region is loaded
   */
  isRegionLoaded(regionX, regionZ) {
    return this.regions.has(this._getKey(regionX, regionZ));
  }
  
  /**
   * Check if a region is currently loading
   */
  isRegionLoading(regionX, regionZ) {
    const region = this.regions.get(this._getKey(regionX, regionZ));
    return region?.isLoading || false;
  }
  
  /**
   * Get a loaded region
   */
  getRegion(regionX, regionZ) {
    return this.regions.get(this._getKey(regionX, regionZ));
  }
  
  /**
   * Load a region from parsed chunks
   * 
   * @param {Array} chunks - Parsed chunks from mcaParser
   * @param {number} regionX - Region X coordinate
   * @param {number} regionZ - Region Z coordinate
   * @param {Object} options - Load options
   * @returns {Promise<LoadedRegion>}
   */
  async loadRegion(chunks, regionX, regionZ, options = {}) {
    const key = this._getKey(regionX, regionZ);
    
    // Check if already loaded
    if (this.regions.has(key)) {
      const existing = this.regions.get(key);
      if (!existing.isLoading) {
        return existing;
      }
    }
    
    // Create region entry
    const region = new LoadedRegion(regionX, regionZ);
    region.isLoading = true;
    this.regions.set(key, region);
    
    // Enforce max regions limit (LRU eviction)
    if (this.regions.size > this.maxRegions) {
      this._evictOldestRegion();
    }
    
    try {
      // Build meshes
      const result = await this.builder.buildRegion(chunks, {
        regionX,
        regionZ,
        onProgress: (phase, current, total, message) => {
          this.onProgress?.(key, phase, current, total, message);
        },
      });
      
      // Create Three.js meshes
      const meshes = RegionMeshBuilder.createMeshes(result, this.materials);
      
      // Calculate position offset
      const position = new THREE.Vector3(
        -result.offset.x - this.globalOffset.x,
        -result.offset.y - this.globalOffset.y,
        -result.offset.z - this.globalOffset.z
      );
      
      // Add to groups
      if (meshes.solid) {
        meshes.solid.position.copy(position);
        meshes.solid.userData.regionKey = key;
        this.solidGroup.add(meshes.solid);
        region.solidMesh = meshes.solid;
      }
      
      if (meshes.water) {
        meshes.water.position.copy(position);
        meshes.water.userData.regionKey = key;
        this.waterGroup.add(meshes.water);
        region.waterMesh = meshes.water;
      }
      
      if (meshes.lava) {
        meshes.lava.position.copy(position);
        meshes.lava.userData.regionKey = key;
        this.lavaGroup.add(meshes.lava);
        region.lavaMesh = meshes.lava;
      }
      
      // Store metadata
      region.offset = result.offset;
      region.bounds = result.bounds;
      region.stats = result.stats;
      region.isLoading = false;
      
      this.onRegionLoaded?.(region);
      
      return region;
      
    } catch (error) {
      console.error(`Failed to load region ${key}:`, error);
      region.isLoading = false;
      this.regions.delete(key);
      throw error;
    }
  }
  
  /**
   * Unload a region
   */
  unloadRegion(regionX, regionZ) {
    const key = this._getKey(regionX, regionZ);
    const region = this.regions.get(key);
    
    if (!region) return false;
    
    // Remove from groups
    if (region.solidMesh) {
      this.solidGroup.remove(region.solidMesh);
    }
    if (region.waterMesh) {
      this.waterGroup.remove(region.waterMesh);
    }
    if (region.lavaMesh) {
      this.lavaGroup.remove(region.lavaMesh);
    }
    
    // Dispose GPU resources
    region.dispose();
    
    // Remove from map
    this.regions.delete(key);
    
    this.onRegionUnloaded?.(regionX, regionZ);
    
    return true;
  }
  
  /**
   * Evict oldest region to make room for new ones
   */
  _evictOldestRegion() {
    let oldest = null;
    let oldestTime = Infinity;
    
    for (const [key, region] of this.regions) {
      if (!region.isLoading && region.loadedAt < oldestTime) {
        oldest = key;
        oldestTime = region.loadedAt;
      }
    }
    
    if (oldest) {
      const [rx, rz] = oldest.split(',').map(Number);
      this.unloadRegion(rx, rz);
    }
  }
  
  /**
   * Set global offset for all regions
   */
  setGlobalOffset(x, y, z) {
    const dx = x - this.globalOffset.x;
    const dy = y - this.globalOffset.y;
    const dz = z - this.globalOffset.z;
    
    this.globalOffset = { x, y, z };
    
    // Update all mesh positions
    for (const region of this.regions.values()) {
      if (region.solidMesh) {
        region.solidMesh.position.x -= dx;
        region.solidMesh.position.y -= dy;
        region.solidMesh.position.z -= dz;
      }
      if (region.waterMesh) {
        region.waterMesh.position.x -= dx;
        region.waterMesh.position.y -= dy;
        region.waterMesh.position.z -= dz;
      }
      if (region.lavaMesh) {
        region.lavaMesh.position.x -= dx;
        region.lavaMesh.position.y -= dy;
        region.lavaMesh.position.z -= dz;
      }
    }
  }
  
  /**
   * Center view on loaded regions
   */
  centerOnRegions() {
    const bounds = this.getCombinedBounds();
    if (!bounds) return;
    
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = 64;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    
    this.setGlobalOffset(centerX, centerY, centerZ);
  }
  
  /**
   * Get combined bounds of all loaded regions
   */
  getCombinedBounds() {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let hasData = false;
    
    for (const region of this.regions.values()) {
      if (!region.bounds) continue;
      hasData = true;
      
      minX = Math.min(minX, region.bounds.minX);
      maxX = Math.max(maxX, region.bounds.maxX);
      minY = Math.min(minY, region.bounds.minY);
      maxY = Math.max(maxY, region.bounds.maxY);
      minZ = Math.min(minZ, region.bounds.minZ);
      maxZ = Math.max(maxZ, region.bounds.maxZ);
    }
    
    if (!hasData) return null;
    
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }
  
  /**
   * Get total statistics across all regions
   */
  getStats() {
    let totalBlocks = 0;
    let totalTriangles = 0;
    let regionCount = 0;
    
    for (const region of this.regions.values()) {
      if (!region.isLoading) {
        regionCount++;
        totalBlocks += region.blockCount;
        totalTriangles += region.triangleCount;
      }
    }
    
    return {
      regionCount,
      totalBlocks,
      totalTriangles,
      meshCount: this.solidGroup.children.length + 
                 this.waterGroup.children.length + 
                 this.lavaGroup.children.length,
    };
  }
  
  /**
   * Clear all regions
   */
  clear() {
    // Create a copy of keys to iterate
    const keys = [...this.regions.keys()];
    
    for (const key of keys) {
      const [rx, rz] = key.split(',').map(Number);
      this.unloadRegion(rx, rz);
    }
    
    this.globalOffset = { x: 0, y: 0, z: 0 };
  }
  
  /**
   * Dispose manager and all resources
   */
  dispose() {
    this.clear();
    
    // Dispose builder
    this.builder.dispose();
    
    // Dispose materials
    this.materials.solid.dispose();
    this.materials.water.dispose();
    this.materials.lava.dispose();
    
    // Remove groups from scene
    this.scene.remove(this.solidGroup);
    this.scene.remove(this.waterGroup);
    this.scene.remove(this.lavaGroup);
  }
  
  /**
   * Get list of loaded region keys
   */
  getLoadedRegions() {
    return [...this.regions.keys()].filter(key => {
      const region = this.regions.get(key);
      return region && !region.isLoading;
    });
  }
  
  /**
   * Update animation (call in render loop)
   */
  update(deltaTime) {
    // Update animated materials if needed
    // Currently no animation, but ready for future use
  }
}

export default RegionManager;

