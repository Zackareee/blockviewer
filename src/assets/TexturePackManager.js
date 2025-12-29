/**
 * TexturePackManager - Loads and manages Minecraft texture packs
 * 
 * Supports:
 * - Loading texture packs from zip files (Minecraft resource pack format)
 * - Loading the bundled default texture pack
 * - Texture fallback chain: custom pack → default pack → solid colors
 * - Model and blockstate overrides from texture packs
 */

import JSZip from 'jszip';

// Texture modes
export const TEXTURE_MODE = {
  SOLID_COLOR: 'solid',
  DEFAULT_PACK: 'default',
  CUSTOM_PACK: 'custom',
};

/**
 * TexturePackManager class
 */
class TexturePackManager {
  constructor() {
    // Loaded textures: Map<texturePath, ImageBitmap>
    this.textures = new Map();
    
    // Loaded models: Map<modelPath, modelJSON>
    this.models = new Map();
    
    // Loaded blockstates: Map<blockName, blockstateJSON>
    this.blockstates = new Map();
    
    // Colormap textures for biome tinting
    this.colormaps = {
      grass: null,      // textures/colormap/grass.png
      foliage: null,    // textures/colormap/foliage.png
      dryFoliage: null, // textures/colormap/dry_foliage.png (Pale Garden)
    };
    
    // Current texture mode
    this.mode = TEXTURE_MODE.SOLID_COLOR;
    
    // Pack metadata
    this.packMeta = null;
    this.packName = null;
    
    // Loading state
    this.isLoaded = false;
    this.loading = null;
    
    // Default pack path
    this.defaultPackPath = '/textures/minecraft.zip';
    
    // Fallback manager (for cascading lookups)
    this.fallbackManager = null;
  }

  /**
   * Set the fallback texture pack manager
   * Used for custom packs to fall back to default pack
   */
  setFallback(fallbackManager) {
    this.fallbackManager = fallbackManager;
  }

  /**
   * Load the default bundled texture pack
   */
  async loadDefaultPack() {
    if (this.mode === TEXTURE_MODE.DEFAULT_PACK && this.isLoaded) {
      return;
    }
    
    console.log('[TexturePackManager] Loading default texture pack...');
    
    try {
      const response = await fetch(this.defaultPackPath);
      if (!response.ok) {
        throw new Error(`Failed to fetch default pack: ${response.status}`);
      }
      
      const blob = await response.blob();
      await this.loadFromZip(blob, 'Minecraft Default');
      this.mode = TEXTURE_MODE.DEFAULT_PACK;
      
      console.log(`[TexturePackManager] Default pack loaded: ${this.textures.size} textures`);
    } catch (err) {
      console.error('[TexturePackManager] Failed to load default pack:', err);
      throw err;
    }
  }

  /**
   * Load a texture pack from a File/Blob (zip format)
   */
  async loadFromZip(zipBlob, packName = 'Custom Pack') {
    if (this.loading) {
      await this.loading;
    }
    
    this.loading = this._loadZip(zipBlob, packName);
    await this.loading;
    this.loading = null;
  }

  async _loadZip(zipBlob, packName) {
    const zip = await JSZip.loadAsync(zipBlob);
    
    // Clear existing data
    this.textures.clear();
    this.models.clear();
    this.blockstates.clear();
    this.isLoaded = false;
    this.packName = packName;
    
    // Find the assets/minecraft directory (may be at root or in a subfolder)
    let assetsPrefix = '';
    
    for (const path of Object.keys(zip.files)) {
      if (path.includes('assets/minecraft/')) {
        const idx = path.indexOf('assets/minecraft/');
        assetsPrefix = path.substring(0, idx);
        break;
      }
    }
    
    const minecraftPath = `${assetsPrefix}assets/minecraft/`;
    
    // Load pack.mcmeta if exists
    const mcmetaPath = `${assetsPrefix}pack.mcmeta`;
    if (zip.files[mcmetaPath]) {
      try {
        const mcmetaText = await zip.files[mcmetaPath].async('text');
        this.packMeta = JSON.parse(mcmetaText);
      } catch (e) {
        console.warn('[TexturePackManager] Could not parse pack.mcmeta');
      }
    }
    
    // Load textures (parallel for speed)
    const texturePromises = [];
    const texturePath = `${minecraftPath}textures/block/`;
    
    for (const [path, file] of Object.entries(zip.files)) {
      if (path.startsWith(texturePath) && path.endsWith('.png') && !file.dir) {
        const relativePath = path.substring(minecraftPath.length);
        texturePromises.push(
          this._loadTexture(file, relativePath)
        );
      }
    }
    
    // Load colormap textures for biome tinting
    const colormapPath = `${minecraftPath}textures/colormap/`;
    const colormapFiles = {
      grass: `${colormapPath}grass.png`,
      foliage: `${colormapPath}foliage.png`,
      dryFoliage: `${colormapPath}dry_foliage.png`,
    };
    
    for (const [name, filePath] of Object.entries(colormapFiles)) {
      if (zip.files[filePath]) {
        texturePromises.push(
          this._loadColormap(zip.files[filePath], name)
        );
      }
    }
    
    // Load models (parallel)
    const modelPromises = [];
    const blockModelPath = `${minecraftPath}models/block/`;
    
    for (const [path, file] of Object.entries(zip.files)) {
      if (path.startsWith(blockModelPath) && path.endsWith('.json') && !file.dir) {
        const modelName = path.substring(blockModelPath.length, path.length - 5);
        modelPromises.push(
          this._loadJSON(file).then(json => {
            if (json) this.models.set(`block/${modelName}`, json);
          })
        );
      }
    }
    
    // Load blockstates (parallel)
    const blockstatePromises = [];
    const blockstatePath = `${minecraftPath}blockstates/`;
    
    for (const [path, file] of Object.entries(zip.files)) {
      if (path.startsWith(blockstatePath) && path.endsWith('.json') && !file.dir) {
        const blockName = path.substring(blockstatePath.length, path.length - 5);
        blockstatePromises.push(
          this._loadJSON(file).then(json => {
            if (json) this.blockstates.set(blockName, json);
          })
        );
      }
    }
    
    // Wait for all to load
    await Promise.all([
      ...texturePromises,
      ...modelPromises,
      ...blockstatePromises,
    ]);
    
    this.isLoaded = true;
    
    console.log(
      `[TexturePackManager] Loaded "${packName}": ` +
      `${this.textures.size} textures, ` +
      `${this.models.size} models, ` +
      `${this.blockstates.size} blockstates`
    );
  }

  async _loadTexture(file, relativePath) {
    try {
      const blob = await file.async('blob');
      const imageBitmap = await createImageBitmap(blob);
      this.textures.set(relativePath, imageBitmap);
    } catch (e) {
      // Skip invalid images silently
    }
  }

  async _loadColormap(file, colormapName) {
    try {
      const blob = await file.async('blob');
      const imageBitmap = await createImageBitmap(blob);
      this.colormaps[colormapName] = imageBitmap;
      console.log(`[TexturePackManager] Loaded colormap: ${colormapName} (${imageBitmap.width}x${imageBitmap.height})`);
    } catch (e) {
      console.warn(`[TexturePackManager] Failed to load colormap ${colormapName}:`, e);
    }
  }

  async _loadJSON(file) {
    try {
      const text = await file.async('text');
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /**
   * Get a texture by path (e.g., "textures/block/stone.png" or "block/stone")
   * Returns ImageBitmap or null
   */
  getTexture(texturePath) {
    // Normalize path
    let normalized = texturePath.replace('minecraft:', '');
    
    // Handle short form (block/stone → textures/block/stone.png)
    if (!normalized.startsWith('textures/')) {
      normalized = `textures/${normalized}`;
    }
    if (!normalized.endsWith('.png')) {
      normalized = `${normalized}.png`;
    }
    
    // Try this pack first
    if (this.textures.has(normalized)) {
      return this.textures.get(normalized);
    }
    
    // Try fallback
    if (this.fallbackManager) {
      return this.fallbackManager.getTexture(normalized);
    }
    
    return null;
  }

  /**
   * Get a model by path (e.g., "block/stone")
   * Returns model JSON or null
   */
  getModel(modelPath) {
    const normalized = modelPath.replace('minecraft:', '');
    
    // Try this pack first
    if (this.models.has(normalized)) {
      return this.models.get(normalized);
    }
    
    // Try fallback
    if (this.fallbackManager) {
      return this.fallbackManager.getModel(normalized);
    }
    
    return null;
  }

  /**
   * Get a blockstate by block name (e.g., "stone")
   * Returns blockstate JSON or null
   */
  getBlockstate(blockName) {
    const normalized = blockName.replace('minecraft:', '');
    
    // Try this pack first
    if (this.blockstates.has(normalized)) {
      return this.blockstates.get(normalized);
    }
    
    // Try fallback
    if (this.fallbackManager) {
      return this.fallbackManager.getBlockstate(normalized);
    }
    
    return null;
  }

  /**
   * Check if a texture exists
   */
  hasTexture(texturePath) {
    return this.getTexture(texturePath) !== null;
  }

  /**
   * Get all loaded texture paths
   */
  getTextureList() {
    return Array.from(this.textures.keys());
  }

  /**
   * Set texture mode
   */
  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Get current texture mode
   */
  getMode() {
    return this.mode;
  }

  /**
   * Check if textures should be used (not solid color mode)
   */
  useTextures() {
    return this.mode !== TEXTURE_MODE.SOLID_COLOR && this.isLoaded;
  }

  /**
   * Clear all loaded data
   */
  clear() {
    this.textures.clear();
    this.models.clear();
    this.blockstates.clear();
    this.colormaps = { grass: null, foliage: null, dryFoliage: null };
    this.isLoaded = false;
    this.packMeta = null;
    this.packName = null;
  }

  /**
   * Get colormap textures for biome tinting
   * @returns {{ grass: ImageBitmap|null, foliage: ImageBitmap|null, dryFoliage: ImageBitmap|null }}
   */
  getColormaps() {
    // Try this pack first
    if (this.colormaps.grass || this.colormaps.foliage) {
      return this.colormaps;
    }
    // Try fallback
    if (this.fallbackManager) {
      return this.fallbackManager.getColormaps();
    }
    return this.colormaps;
  }

  /**
   * Get pack info
   */
  getPackInfo() {
    return {
      name: this.packName,
      textureCount: this.textures.size,
      modelCount: this.models.size,
      blockstateCount: this.blockstates.size,
      meta: this.packMeta,
    };
  }
}

// Singleton instances
let defaultPackManager = null;
let customPackManager = null;

/**
 * Get the default texture pack manager (loads bundled pack)
 */
/**
 * Debug: Validate texture loading by checking a few known textures
 * Call this after loading to verify textures are correctly loaded
 */
TexturePackManager.prototype.debugValidateTextures = function() {
  const testTextures = [
    'textures/block/stone.png',
    'textures/block/dirt.png', 
    'textures/block/grass_block_top.png',
    'textures/block/grass_block_side.png',
    'textures/block/oak_planks.png',
    'textures/block/cobblestone.png',
  ];
  
  console.log(`[TexturePackManager] Validating ${testTextures.length} test textures...`);
  
  for (const path of testTextures) {
    const texture = this.textures.get(path);
    if (texture) {
      console.log(`  ✓ ${path}: ${texture.width}x${texture.height}`);
    } else {
      console.log(`  ✗ ${path}: NOT FOUND`);
      // Try to find similar keys
      const similar = Array.from(this.textures.keys())
        .filter(k => k.includes(path.split('/').pop().replace('.png', '')))
        .slice(0, 3);
      if (similar.length > 0) {
        console.log(`    Similar keys: ${similar.join(', ')}`);
      }
    }
  }
  
  // Log some sample texture paths that ARE loaded
  const samplePaths = Array.from(this.textures.keys()).slice(0, 10);
  console.log(`[TexturePackManager] Sample loaded paths:`, samplePaths);
};

export function getDefaultPackManager() {
  if (!defaultPackManager) {
    defaultPackManager = new TexturePackManager();
  }
  return defaultPackManager;
}

/**
 * Get the custom texture pack manager
 * Falls back to default pack
 */
export function getCustomPackManager() {
  if (!customPackManager) {
    customPackManager = new TexturePackManager();
    customPackManager.setFallback(getDefaultPackManager());
  }
  return customPackManager;
}

/**
 * Get the active texture pack manager based on mode
 */
export function getActivePackManager(mode = TEXTURE_MODE.DEFAULT_PACK) {
  if (mode === TEXTURE_MODE.CUSTOM_PACK) {
    return getCustomPackManager();
  }
  return getDefaultPackManager();
}

export { TexturePackManager };
export default TexturePackManager;

