/**
 * EntityTextureAtlas - Manages entity textures packed into a single atlas
 * 
 * Entity textures (chests, beds, signs, skulls, banners, etc.) have varying sizes
 * unlike the uniform 16x16 block textures. This atlas packs them efficiently
 * and provides UV coordinate lookup for the WASM entity mesher.
 * 
 * Features:
 * - Variable texture sizes (64x64, 64x32, 256x256, etc.)
 * - Normalized UV coordinates for each texture
 * - Texture index lookup for WASM consumption
 * - Banner pattern texture support
 */

import * as THREE from 'three';

// Singleton instance
let atlasInstance = null;

/**
 * EntityTextureAtlas class
 */
export class EntityTextureAtlas {
  constructor() {
    // Atlas texture
    this.texture = null;
    
    // Manifest data: { atlasSize, textures: { path: { x, y, w, h, u, v, uSize, vSize, index } } }
    this.manifest = null;
    
    // Texture path to index mapping
    this.texturePathToIndex = new Map();
    
    // Index to UV mapping for WASM
    this.indexToUV = [];
    
    // Atlas dimensions
    this.atlasWidth = 0;
    this.atlasHeight = 0;
    
    // State
    this.isLoaded = false;
  }
  
  /**
   * Initialize the entity atlas from pre-built files
   * @param {string} atlasPath - Path to entity-atlas.png
   * @param {string} manifestPath - Path to entity-atlas-manifest.json
   */
  async init(atlasPath = '/assets/entity-atlas.png', manifestPath = '/assets/entity-atlas-manifest.json') {
    if (this.isLoaded) {
      return true;
    }
    
    try {
      // Load manifest
      const manifestResponse = await fetch(manifestPath);
      if (!manifestResponse.ok) {
        console.warn('[EntityTextureAtlas] Manifest not found, building at runtime disabled');
        return false;
      }
      
      this.manifest = await manifestResponse.json();
      this.atlasWidth = this.manifest.atlasSize[0];
      this.atlasHeight = this.manifest.atlasSize[1];
      
      // Build lookup tables
      this._buildLookupTables();
      
      // Load atlas texture
      const loader = new THREE.TextureLoader();
      this.texture = await new Promise((resolve, reject) => {
        loader.load(
          atlasPath,
          (texture) => {
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestFilter;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.flipY = false; // Entity textures have V=0 at top
            texture.colorSpace = THREE.SRGBColorSpace;
            resolve(texture);
          },
          undefined,
          (error) => {
            reject(new Error(`Failed to load entity atlas: ${error.message}`));
          }
        );
      });
      
      this.isLoaded = true;
      console.log(`[EntityTextureAtlas] Loaded ${this.atlasWidth}x${this.atlasHeight} atlas with ${this.texturePathToIndex.size} textures`);
      
      return true;
    } catch (error) {
      console.error('[EntityTextureAtlas] Failed to initialize:', error);
      return false;
    }
  }
  
  /**
   * Build lookup tables from manifest
   * @private
   */
  _buildLookupTables() {
    this.texturePathToIndex.clear();
    this.indexToUV = [];
    
    for (const [texturePath, textureInfo] of Object.entries(this.manifest.textures)) {
      const { index, u, v, uSize, vSize, w, h } = textureInfo;
      
      this.texturePathToIndex.set(texturePath, index);
      
      // Also support short paths (e.g., "chest/normal" instead of "entity/chest/normal")
      if (texturePath.startsWith('entity/')) {
        this.texturePathToIndex.set(texturePath.substring(7), index);
      }
      
      this.indexToUV[index] = {
        u,
        v,
        uSize,
        vSize,
        width: w,
        height: h,
      };
    }
  }
  
  /**
   * Get texture index by path
   * @param {string} texturePath - Path like "entity/chest/normal" or "chest/normal"
   * @returns {number} Atlas index, or -1 if not found
   */
  getTextureIndex(texturePath) {
    // Try direct lookup
    let index = this.texturePathToIndex.get(texturePath);
    if (index !== undefined) {
      return index;
    }
    
    // Try with entity/ prefix
    index = this.texturePathToIndex.get(`entity/${texturePath}`);
    if (index !== undefined) {
      return index;
    }
    
    // Try without entity/ prefix
    if (texturePath.startsWith('entity/')) {
      index = this.texturePathToIndex.get(texturePath.substring(7));
      if (index !== undefined) {
        return index;
      }
    }
    
    return -1;
  }
  
  /**
   * Get UV coordinates for a texture by path
   * @param {string} texturePath - Texture path
   * @returns {{ u: number, v: number, uSize: number, vSize: number } | null}
   */
  getTextureUV(texturePath) {
    const index = this.getTextureIndex(texturePath);
    if (index < 0 || index >= this.indexToUV.length) {
      return null;
    }
    return this.indexToUV[index];
  }
  
  /**
   * Get UV coordinates by texture index
   * @param {number} index - Texture index
   * @returns {{ u: number, v: number, uSize: number, vSize: number } | null}
   */
  getUVByIndex(index) {
    if (index < 0 || index >= this.indexToUV.length) {
      return null;
    }
    return this.indexToUV[index];
  }
  
  /**
   * Get all texture UV mappings as an array
   * @returns {Array<{ u: number, v: number, uSize: number, vSize: number }>}
   */
  getAllTextureUVs() {
    return this.indexToUV.slice();
  }
  
  /**
   * Get the Three.js texture
   * @returns {THREE.Texture | null}
   */
  getTexture() {
    return this.texture;
  }
  
  /**
   * Get atlas size
   * @returns {{ width: number, height: number }}
   */
  getAtlasSize() {
    return {
      width: this.atlasWidth,
      height: this.atlasHeight,
    };
  }
  
  /**
   * Get texture remapping array for WASM
   * Maps from model's texture indices to atlas indices
   * @param {string[]} texturePathList - Ordered list of texture paths from baked models
   * @returns {Uint16Array} Remapping array
   */
  getTextureRemapping(texturePathList) {
    const remapping = new Uint16Array(texturePathList.length);
    
    for (let i = 0; i < texturePathList.length; i++) {
      const atlasIndex = this.getTextureIndex(texturePathList[i]);
      remapping[i] = atlasIndex >= 0 ? atlasIndex : 0;
    }
    
    return remapping;
  }
  
  /**
   * Get all banner pattern texture indices for the banner shader
   * @returns {Map<string, number>} Pattern name -> atlas index
   */
  getBannerPatternIndices() {
    const patterns = new Map();
    
    for (const [path, index] of this.texturePathToIndex.entries()) {
      if (path.includes('banner/') && !path.includes('banner_base')) {
        const patternName = path.split('/').pop().replace('.png', '');
        patterns.set(patternName, index);
      }
    }
    
    return patterns;
  }
  
  /**
   * Create UV data texture for WASM/shader consumption
   * Each texel contains (u, v, uSize, vSize) for one texture
   * @returns {THREE.DataTexture}
   */
  createUVDataTexture() {
    const count = this.indexToUV.length;
    const data = new Float32Array(count * 4);
    
    for (let i = 0; i < count; i++) {
      const uv = this.indexToUV[i];
      if (uv) {
        data[i * 4 + 0] = uv.u;
        data[i * 4 + 1] = uv.v;
        data[i * 4 + 2] = uv.uSize;
        data[i * 4 + 3] = uv.vSize;
      }
    }
    
    const texture = new THREE.DataTexture(
      data,
      count,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    texture.needsUpdate = true;
    
    return texture;
  }
  
  /**
   * Dispose of resources
   */
  dispose() {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.manifest = null;
    this.texturePathToIndex.clear();
    this.indexToUV = [];
    this.isLoaded = false;
  }
}

/**
 * Get the singleton EntityTextureAtlas instance
 * @returns {EntityTextureAtlas}
 */
export function getEntityTextureAtlas() {
  if (!atlasInstance) {
    atlasInstance = new EntityTextureAtlas();
  }
  return atlasInstance;
}

export default EntityTextureAtlas;
