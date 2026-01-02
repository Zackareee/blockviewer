/**
 * TextureAtlas - Combines block textures into a single GPU-efficient atlas
 * 
 * Features:
 * - Packs textures into a power-of-2 atlas
 * - Generates UV coordinates for each texture
 * - Supports proper texture tiling (1 pixel border to prevent bleeding)
 * - Creates Three.js texture from atlas
 * - Builds TextureIndexLookup for efficient shader texture selection
 */

import * as THREE from 'three';
import { TextureIndexLookup } from './TextureIndexLookup.js';

// Default Minecraft texture size (can be overridden by texture pack resolution)
const DEFAULT_TEXTURE_SIZE = 16;

// Border pixels to prevent texture bleeding during tiling
const BORDER_SIZE = 1;

/**
 * TextureAtlas class
 */
class TextureAtlas {
  constructor() {
    // UV lookup: texturePath → { u, v, width, height }
    this.uvLookup = new Map();
    
    // Texture path to atlas index mapping: texturePath → index (row * cols + col)
    this.texturePathToIndex = new Map();
    
    // TextureIndexLookup instance for fast block/face -> atlas index lookups
    this.textureIndexLookup = null;
    
    // Color to UV lookup: Maps block colors to atlas positions
    // Used by the shader to find the correct texture
    this.colorLookup = null;
    this.colorLookupTexture = null;
    
    // Colormap texture for biome tinting (grass + foliage combined into one texture)
    // Layout: grass colormap (256x256) on top, foliage colormap (256x256) below
    this.colormapTexture = null;
    
    // Atlas canvas and context
    this.canvas = null;
    this.ctx = null;
    
    // Atlas dimensions
    this.atlasWidth = 0;
    this.atlasHeight = 0;
    
    // Tiles per row/column
    this.tilesPerRow = 0;
    this.tilesPerCol = 0;
    
    // Three.js texture
    this.texture = null;
    
    // Build state
    this.isBuilt = false;
  }

  /**
   * Build the texture atlas from a TexturePackManager
   * @param {TexturePackManager} packManager
   */
  async build(packManager) {
    if (!packManager || !packManager.isLoaded) {
      console.warn('[TextureAtlas] No texture pack loaded');
      return false;
    }

    const texturePaths = packManager.getTextureList();
    const blockTextures = texturePaths.filter(p => p.startsWith('textures/block/'));
    
    if (blockTextures.length === 0) {
      console.warn('[TextureAtlas] No block textures found');
      return false;
    }

    console.log(`[TextureAtlas] Building atlas from ${blockTextures.length} textures...`);

    // Calculate atlas dimensions (power of 2)
    const tilesPerRow = Math.ceil(Math.sqrt(blockTextures.length));
    this.atlasWidth = this._nextPowerOf2(tilesPerRow * TILE_SIZE);
    this.atlasHeight = this._nextPowerOf2(Math.ceil(blockTextures.length / tilesPerRow) * TILE_SIZE);
    
    // Store tiles per row/col for index calculations
    this.tilesPerRow = Math.floor(this.atlasWidth / TILE_SIZE);
    this.tilesPerCol = Math.floor(this.atlasHeight / TILE_SIZE);
    
    // Clear texture path to index mapping
    this.texturePathToIndex.clear();

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.atlasWidth;
    this.canvas.height = this.atlasHeight;
    this.ctx = this.canvas.getContext('2d');

    // Fill with transparent background
    this.ctx.clearRect(0, 0, this.atlasWidth, this.atlasHeight);

    // Place textures
    this.uvLookup.clear();
    let tileCol = 0;
    let tileRow = 0;
    let textureIndex = 0;

    for (const path of blockTextures) {
      const bitmap = packManager.getTexture(path);
      if (!bitmap) continue;

      // Calculate tile position
      const tileX = tileCol * TILE_SIZE;
      const tileY = tileRow * TILE_SIZE;

      // Draw the texture with border (for tiling support)
      this._drawTileWithBorder(bitmap, tileX, tileY);

      // Calculate UV coordinates (normalized 0-1)
      // Account for the border when calculating UVs
      const innerX = tileX + BORDER_SIZE;
      const innerY = tileY + BORDER_SIZE;
      
      // Extract the texture name from path for lookup
      const textureName = this._pathToTextureName(path);
      
      // Store UVs in canvas space (top-left origin)
      // Three.js CanvasTexture will handle the Y-flip for WebGL
      const uvData = {
        u: innerX / this.atlasWidth,
        v: innerY / this.atlasHeight, // Don't flip - CanvasTexture handles it
        width: TEXTURE_SIZE / this.atlasWidth,
        height: TEXTURE_SIZE / this.atlasHeight,
        // Raw pixel coordinates for debugging
        px: innerX,
        py: innerY,
        // Atlas tile position
        col: tileCol,
        row: tileRow,
        index: textureIndex,
      };
      
      this.uvLookup.set(textureName, uvData);

      // Also add full path lookup
      this.uvLookup.set(path, uvData);
      
      // Store texture path to atlas index mapping (for TextureIndexLookup)
      this.texturePathToIndex.set(textureName, textureIndex);
      this.texturePathToIndex.set(path, textureIndex);

      // Move to next position
      tileCol++;
      textureIndex++;
      if ((tileCol + 1) * TILE_SIZE > this.atlasWidth) {
        tileCol = 0;
        tileRow++;
      }
    }

    // Create Three.js texture
    this._createThreeTexture();
    
    // Build colormap texture for biome tinting
    this._buildColormapTexture(packManager);

    this.isBuilt = true;
    console.log(`[TextureAtlas] Built ${this.atlasWidth}x${this.atlasHeight} atlas with ${this.uvLookup.size / 2} textures`);

    return true;
  }

  /**
   * Build combined colormap texture for biome tinting
   * Creates a 256x512 texture with grass colormap on top, foliage below
   * @param {TexturePackManager} packManager
   */
  _buildColormapTexture(packManager) {
    const colormaps = packManager.getColormaps();
    
    // Create a 256x512 canvas (grass on top half, foliage on bottom half)
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // Fill with default green colors (used when colormaps aren't available)
    ctx.fillStyle = '#5D8C32'; // Default grass green
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#3A8B25'; // Default foliage green
    ctx.fillRect(0, 256, 256, 256);
    
    // Draw grass colormap to top half (0-255) if available
    if (colormaps.grass) {
      ctx.drawImage(colormaps.grass, 0, 0, 256, 256);
      console.log('[TextureAtlas] Added grass colormap');
    } else {
      console.log('[TextureAtlas] No grass colormap, using default green');
    }
    
    // Draw foliage colormap to bottom half (256-511) if available
    if (colormaps.foliage) {
      ctx.drawImage(colormaps.foliage, 0, 256, 256, 256);
      console.log('[TextureAtlas] Added foliage colormap');
    } else {
      console.log('[TextureAtlas] No foliage colormap, using default green');
    }
    
    // Create Three.js texture
    if (this.colormapTexture) {
      this.colormapTexture.dispose();
    }
    
    this.colormapTexture = new THREE.CanvasTexture(canvas);
    this.colormapTexture.flipY = false;
    this.colormapTexture.magFilter = THREE.LinearFilter; // Smooth sampling
    this.colormapTexture.minFilter = THREE.LinearFilter;
    this.colormapTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.colormapTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.colormapTexture.generateMipmaps = false;
    // Use NoColorSpace to prevent any gamma correction
    this.colormapTexture.colorSpace = THREE.NoColorSpace;
    this.colormapTexture.needsUpdate = true;
    
    console.log('[TextureAtlas] Built colormap texture (256x512)');
  }

  /**
   * Draw a texture tile with border pixels for seamless tiling
   */
  _drawTileWithBorder(bitmap, tileX, tileY) {
    const innerX = tileX + BORDER_SIZE;
    const innerY = tileY + BORDER_SIZE;

    // Draw main texture
    this.ctx.drawImage(bitmap, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE, 
                       innerX, innerY, TEXTURE_SIZE, TEXTURE_SIZE);

    // Draw border pixels by extending edge pixels
    // This prevents texture bleeding when mipmapping or filtering
    
    // Top border (copy from top row of texture)
    this.ctx.drawImage(bitmap, 0, 0, TEXTURE_SIZE, 1,
                       innerX, tileY, TEXTURE_SIZE, BORDER_SIZE);
    
    // Bottom border (copy from bottom row)
    this.ctx.drawImage(bitmap, 0, TEXTURE_SIZE - 1, TEXTURE_SIZE, 1,
                       innerX, innerY + TEXTURE_SIZE, TEXTURE_SIZE, BORDER_SIZE);
    
    // Left border (copy from left column)
    this.ctx.drawImage(bitmap, 0, 0, 1, TEXTURE_SIZE,
                       tileX, innerY, BORDER_SIZE, TEXTURE_SIZE);
    
    // Right border (copy from right column)
    this.ctx.drawImage(bitmap, TEXTURE_SIZE - 1, 0, 1, TEXTURE_SIZE,
                       innerX + TEXTURE_SIZE, innerY, BORDER_SIZE, TEXTURE_SIZE);

    // Corner pixels
    // Top-left
    this.ctx.drawImage(bitmap, 0, 0, 1, 1,
                       tileX, tileY, BORDER_SIZE, BORDER_SIZE);
    // Top-right
    this.ctx.drawImage(bitmap, TEXTURE_SIZE - 1, 0, 1, 1,
                       innerX + TEXTURE_SIZE, tileY, BORDER_SIZE, BORDER_SIZE);
    // Bottom-left
    this.ctx.drawImage(bitmap, 0, TEXTURE_SIZE - 1, 1, 1,
                       tileX, innerY + TEXTURE_SIZE, BORDER_SIZE, BORDER_SIZE);
    // Bottom-right
    this.ctx.drawImage(bitmap, TEXTURE_SIZE - 1, TEXTURE_SIZE - 1, 1, 1,
                       innerX + TEXTURE_SIZE, innerY + TEXTURE_SIZE, BORDER_SIZE, BORDER_SIZE);
  }

  /**
   * Convert texture path to lookup name
   * "textures/block/stone.png" → "block/stone"
   */
  _pathToTextureName(path) {
    let name = path;
    if (name.startsWith('textures/')) {
      name = name.substring(9);
    }
    if (name.endsWith('.png')) {
      name = name.substring(0, name.length - 4);
    }
    return name;
  }

  /**
   * Create Three.js texture from atlas canvas
   */
  _createThreeTexture() {
    if (this.texture) {
      this.texture.dispose();
    }

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false; // Don't flip - we handle Y ourselves for simpler UV math
    this.texture.magFilter = THREE.NearestFilter; // Pixelated look (zoomed in)
    this.texture.minFilter = THREE.NearestFilter; // No mipmaps - prevents atlas tile bleeding
    this.texture.wrapS = THREE.ClampToEdgeWrapping; // Don't wrap - we handle tiling in shader
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false; // Disable mipmaps - they cause bleeding in atlases
    // Use NoColorSpace to prevent any gamma correction - Minecraft textures are
    // already in the correct color space and we apply shading directly in the shader
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  /**
   * Build a color lookup texture that maps RGB colors to atlas UV positions
   * This enables using block colors as texture indices
   * @param {Object} blockColors - Map of block names to {r, g, b} colors
   */
  buildColorLookup(blockColors) {
    // Create a 256x256 lookup texture (R,G used as indices)
    // Each pixel stores the UV offset and tile size for that color
    const lookupSize = 256;
    this.colorLookup = new Uint8ClampedArray(lookupSize * lookupSize * 4);
    
    // Calculate tile size in normalized UV space (not including border)
    const tileU = TEXTURE_SIZE / this.atlasWidth;
    const tileV = TEXTURE_SIZE / this.atlasHeight;
    
    let matchedCount = 0;
    let missedNames = [];
    
    // Iterate through all blocks and map their colors to atlas positions
    for (const [blockName, color] of Object.entries(blockColors)) {
      // Get the base block name (without variants like _slab, _stairs)
      const baseName = blockName.replace('minecraft:', '');
      
      // Try multiple texture name formats
      const tryNames = [
        `block/${baseName}`,
        `block/${baseName}_top`,
        `block/${baseName}_side`,
      ];
      
      let uv = null;
      for (const name of tryNames) {
        uv = this.uvLookup.get(name);
        if (uv) break;
      }
      
      if (!uv) {
        if (missedNames.length < 10) missedNames.push(baseName);
        continue;
      }
      
      matchedCount++;
      
      // Convert color (0-1) to lookup indices (0-255)
      const r = Math.floor(color.r * 255);
      const g = Math.floor(color.g * 255);
      
      // Calculate lookup index
      const idx = (g * lookupSize + r) * 4;
      
      // Store UV offset and tile size as RGBA
      // Values are stored as 0-255 and read as 0-1 in shader
      // Since we disabled flipY, uv.u and uv.v are in canvas space (top-left origin)
      this.colorLookup[idx] = Math.floor(uv.u * 255);
      this.colorLookup[idx + 1] = Math.floor(uv.v * 255);
      this.colorLookup[idx + 2] = Math.floor(tileU * 255);
      this.colorLookup[idx + 3] = Math.floor(tileV * 255);
    }
    
    // Create Three.js texture for the lookup
    if (this.colorLookupTexture) {
      this.colorLookupTexture.dispose();
    }
    
    const lookupCanvas = document.createElement('canvas');
    lookupCanvas.width = lookupSize;
    lookupCanvas.height = lookupSize;
    const ctx = lookupCanvas.getContext('2d');
    const imageData = ctx.createImageData(lookupSize, lookupSize);
    imageData.data.set(this.colorLookup);
    ctx.putImageData(imageData, 0, 0);
    
    this.colorLookupTexture = new THREE.CanvasTexture(lookupCanvas);
    this.colorLookupTexture.magFilter = THREE.NearestFilter;
    this.colorLookupTexture.minFilter = THREE.NearestFilter;
    this.colorLookupTexture.needsUpdate = true;
    
    console.log(`[TextureAtlas] Built color lookup: ${matchedCount}/${Object.keys(blockColors).length} blocks matched`);
    if (missedNames.length > 0) {
      console.log(`[TextureAtlas] Sample unmatched blocks:`, missedNames.join(', '));
    }
  }

  /**
   * Build the TextureIndexLookup from a BlockRegistry
   * This creates a fast lookup from (blockId, face) -> atlas texture index
   * @param {BlockRegistry} blockRegistry - The block registry to use
   * @returns {TextureIndexLookup} The built lookup
   */
  buildTextureIndexLookup(blockRegistry) {
    if (!this.isBuilt) {
      console.warn('[TextureAtlas] Atlas not built, cannot create texture index lookup');
      return null;
    }
    
    // Create the lookup
    this.textureIndexLookup = new TextureIndexLookup(this.tilesPerRow, this.tilesPerCol);
    
    // Set the texture path to index mapping
    this.textureIndexLookup.setTexturePathMapping(this.texturePathToIndex);
    
    // Debug: log the path mapping
    console.log(`[TextureAtlas] texturePathToIndex has ${this.texturePathToIndex.size} entries`);
    this.textureIndexLookup.debugPathMapping();
    
    // Find a reasonable default texture (stone if available, otherwise first texture)
    const defaultPath = this.texturePathToIndex.has('block/stone') 
      ? 'block/stone' 
      : Array.from(this.texturePathToIndex.keys())[0];
    const defaultIndex = this.texturePathToIndex.get(defaultPath) || 0;
    console.log(`[TextureAtlas] Default texture: '${defaultPath}' -> index ${defaultIndex}`);
    this.textureIndexLookup.setDefaultIndex(defaultIndex);
    
    // Log registry state
    console.log(`[TextureAtlas] BlockRegistry has ${blockRegistry.idToInfo.length} entries`);
    
    // Register all blocks from the registry
    const idToInfo = blockRegistry.idToInfo;
    let registeredCount = 0;
    let foundCount = 0;
    
    // Debug: register a few blocks with detailed logging
    const debugBlocks = ['minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:oak_planks'];
    
    for (let blockId = 0; blockId < idToInfo.length; blockId++) {
      const info = idToInfo[blockId];
      if (info && info.name) {
        const shouldDebug = debugBlocks.includes(info.name);
        const found = this.textureIndexLookup.registerBlock(blockId, info.name, shouldDebug);
        registeredCount++;
        if (found) foundCount++;
      }
    }
    
    console.log(`[TextureAtlas] Built texture index lookup: ${registeredCount} blocks registered, ${foundCount} found textures, ${this.texturePathToIndex.size} atlas textures`);
    
    return this.textureIndexLookup;
  }

  /**
   * Get the current TextureIndexLookup (or null if not built)
   * @returns {TextureIndexLookup|null}
   */
  getTextureIndexLookup() {
    return this.textureIndexLookup;
  }

  /**
   * Get the material data needed for textured rendering
   * @returns {Object} { atlas, lookup, size, textureIndexLookup, tileUV, textureUV }
   */
  getMaterialData() {
    // Calculate the actual tile size in UV space
    // TILE_SIZE includes the 1px border on each side (16 + 2 = 18)
    const tileUV = {
      x: TILE_SIZE / this.atlasWidth,  // Full tile size in UV (includes border)
      y: TILE_SIZE / this.atlasHeight,
    };
    // The actual usable texture area (without border)
    const textureUV = {
      x: TEXTURE_SIZE / this.atlasWidth,  // Just the 16x16 texture part
      y: TEXTURE_SIZE / this.atlasHeight,
    };
    // Border offset in UV space
    const borderUV = {
      x: BORDER_SIZE / this.atlasWidth,
      y: BORDER_SIZE / this.atlasHeight,
    };
    
    console.log(`[TextureAtlas] Material data: atlas ${this.atlasWidth}x${this.atlasHeight}, tiles ${this.tilesPerRow}x${this.tilesPerCol}`);
    console.log(`[TextureAtlas] UV sizes: tile=${tileUV.x.toFixed(4)}, texture=${textureUV.x.toFixed(4)}, border=${borderUV.x.toFixed(4)}`);
    console.log(`[TextureAtlas] Colormap texture: ${this.colormapTexture ? 'available' : 'not available'}`);
    
    return {
      atlas: this.texture,
      lookup: this.colorLookupTexture,
      colormap: this.colormapTexture, // Colormap texture for biome tinting
      size: {
        x: this.tilesPerRow,
        y: this.tilesPerCol,
      },
      textureIndexLookup: this.textureIndexLookup,
      tilesPerRow: this.tilesPerRow,
      tilesPerCol: this.tilesPerCol,
      // UV space sizes for shader
      tileUV,      // Full tile including border (18/1024)
      textureUV,   // Just texture area (16/1024)
      borderUV,    // Border offset (1/1024)
      atlasWidth: this.atlasWidth,
      atlasHeight: this.atlasHeight,
    };
  }

  /**
   * Get UV coordinates for a texture
   * @param {string} texturePath - e.g., "block/stone" or "minecraft:block/stone"
   * @returns {{ u, v, width, height } | null}
   */
  getUV(texturePath) {
    if (!this.isBuilt) return null;

    // Normalize path
    let normalized = texturePath.replace('minecraft:', '');
    
    // Try direct lookup
    if (this.uvLookup.has(normalized)) {
      return this.uvLookup.get(normalized);
    }

    // Try with different prefixes
    if (!normalized.startsWith('block/')) {
      const withPrefix = `block/${normalized}`;
      if (this.uvLookup.has(withPrefix)) {
        return this.uvLookup.get(withPrefix);
      }
    }

    return null;
  }

  /**
   * Calculate UV coordinates for a face quad
   * Takes into account UV rotation and flipping
   * @param {number} rotation - UV rotation in degrees (0, 90, 180, 270)
   * @returns {Float32Array} - 8 floats (4 UV pairs)
   */
  getFaceUVs(texturePath, rotation = 0) {
    const uv = this.getUV(texturePath);
    if (!uv) {
      // Return default UVs (full tile)
      return new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    }

    const { u, v, width, height } = uv;

    // Base corners (bottom-left origin)
    const corners = [
      [u, v],                      // 0: bottom-left
      [u + width, v],              // 1: bottom-right
      [u + width, v + height],     // 2: top-right
      [u, v + height],             // 3: top-left
    ];

    // Apply rotation
    const rotSteps = Math.floor(((rotation % 360) + 360) % 360 / 90);
    const rotated = [];
    for (let i = 0; i < 4; i++) {
      rotated.push(corners[(i + rotSteps) % 4]);
    }

    return new Float32Array([
      rotated[0][0], rotated[0][1],
      rotated[1][0], rotated[1][1],
      rotated[2][0], rotated[2][1],
      rotated[3][0], rotated[3][1],
    ]);
  }

  /**
   * Get the Three.js texture
   */
  getTexture() {
    return this.texture;
  }

  /**
   * Get atlas dimensions
   */
  getSize() {
    return { width: this.atlasWidth, height: this.atlasHeight };
  }

  /**
   * Helper to get next power of 2
   */
  _nextPowerOf2(n) {
    return Math.pow(2, Math.ceil(Math.log2(n)));
  }

  /**
   * Dispose of resources
   */
  dispose() {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    if (this.colorLookupTexture) {
      this.colorLookupTexture.dispose();
      this.colorLookupTexture = null;
    }
    if (this.colormapTexture) {
      this.colormapTexture.dispose();
      this.colormapTexture = null;
    }
    this.colorLookup = null;
    this.canvas = null;
    this.ctx = null;
    this.uvLookup.clear();
    this.texturePathToIndex.clear();
    this.textureIndexLookup = null;
    this.isBuilt = false;
  }

  /**
   * Export atlas as PNG for debugging
   */
  toDataURL() {
    if (!this.canvas) return null;
    return this.canvas.toDataURL('image/png');
  }
}

// Singleton instance
let instance = null;

/**
 * Get the texture atlas singleton
 */
export function getTextureAtlas() {
  if (!instance) {
    instance = new TextureAtlas();
  }
  return instance;
}

export { TextureAtlas, TEXTURE_SIZE, TILE_SIZE, BORDER_SIZE };
export default TextureAtlas;

