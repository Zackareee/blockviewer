/**
 * TexturePackManager - Loads and manages Minecraft texture packs
 * 
 * Supports:
 * - Loading texture packs from zip files (Minecraft resource pack format)
 * - Loading the bundled default texture pack
 * - Texture fallback chain: custom pack → default pack → solid colors
 * - Model and blockstate overrides from texture packs
 * - Animation metadata from .mcmeta files
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
    
    // Animation metadata: Map<texturePath, AnimationData>
    // AnimationData: { frametime, frames, interpolate, frameCount }
    this.animations = new Map();
    
    // Colormap textures for biome tinting
    this.colormaps = {
      grass: null,      // textures/colormap/grass.png
      foliage: null,    // textures/colormap/foliage.png
      dryFoliage: null, // textures/colormap/dry_foliage.png (Pale Garden)
    };
    
    // Particle textures: Map<texturePath, ImageBitmap>
    // Loaded from textures/particle/
    this.particleTextures = new Map();
    
    // Particle animation metadata: Map<texturePath, AnimationData>
    this.particleAnimations = new Map();
    
    // Current texture mode
    this.mode = TEXTURE_MODE.SOLID_COLOR;
    
    // Pack metadata
    this.packMeta = null;
    this.packName = null;
    
    // BlockViewer-specific config (blockviewer.json)
    // Supports: { randomRotationBlocks: ["block1", "block2", ...] }
    this.blockviewerConfig = null;
    
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
      await this.loadFromZip(blob, 'Vanilla 1.21.11');
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
    this.animations.clear();
    this.particleTextures.clear();
    this.particleAnimations.clear();
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
    
    // Load textures with controlled concurrency for better performance
    // Too many parallel createImageBitmap calls can overwhelm the browser
    const TEXTURE_CONCURRENCY = 32;
    const textureEntries = [];
    const mcmetaEntries = [];
    const texturePath = `${minecraftPath}textures/block/`;
    
    // Also load particle textures
    const particleEntries = [];
    const particleMcmetaEntries = [];
    const particlePath = `${minecraftPath}textures/particle/`;
    
    // Also load entity textures (for beacon beams, etc.)
    const entityEntries = [];
    const entityPath = `${minecraftPath}textures/entity/`;
    
    for (const [path, file] of Object.entries(zip.files)) {
      // Block textures
      if (path.startsWith(texturePath) && !file.dir) {
        if (path.endsWith('.png')) {
          const relativePath = path.substring(minecraftPath.length);
          textureEntries.push({ file, relativePath });
        } else if (path.endsWith('.png.mcmeta')) {
          // Animation metadata file
          const relativePath = path.substring(minecraftPath.length);
          mcmetaEntries.push({ file, relativePath });
        }
      }
      // Particle textures
      if (path.startsWith(particlePath) && !file.dir) {
        if (path.endsWith('.png')) {
          const relativePath = path.substring(minecraftPath.length);
          particleEntries.push({ file, relativePath });
        } else if (path.endsWith('.png.mcmeta')) {
          const relativePath = path.substring(minecraftPath.length);
          particleMcmetaEntries.push({ file, relativePath });
        }
      }
      // Entity textures (beacon_beam.png, etc.)
      if (path.startsWith(entityPath) && !file.dir && path.endsWith('.png')) {
        const relativePath = path.substring(minecraftPath.length);
        entityEntries.push({ file, relativePath });
      }
    }
    
    // Process textures in batches with controlled concurrency
    const loadTexturesBatched = async () => {
      for (let i = 0; i < textureEntries.length; i += TEXTURE_CONCURRENCY) {
        const batch = textureEntries.slice(i, i + TEXTURE_CONCURRENCY);
        const results = await Promise.all(
          batch.map(({ file, relativePath }) => this._loadTextureEntry(file, relativePath))
        );
        // Store results immediately (reduces memory pressure)
        for (const result of results) {
          if (result) {
            this.textures.set(result.path, result.bitmap);
          }
        }
      }
    };
    
    // Process particle textures in batches
    const loadParticleTexturesBatched = async () => {
      for (let i = 0; i < particleEntries.length; i += TEXTURE_CONCURRENCY) {
        const batch = particleEntries.slice(i, i + TEXTURE_CONCURRENCY);
        const results = await Promise.all(
          batch.map(({ file, relativePath }) => this._loadTextureEntry(file, relativePath))
        );
        for (const result of results) {
          if (result) {
            this.particleTextures.set(result.path, result.bitmap);
          }
        }
      }
    };
    
    // Load animation metadata from .mcmeta files
    const loadAnimationMetadata = async () => {
      const mcmetaPromises = mcmetaEntries.map(async ({ file, relativePath }) => {
        try {
          const text = await file.async('text');
          const meta = JSON.parse(text);
          if (meta.animation) {
            // relativePath is like "textures/block/water_still.png.mcmeta"
            // Convert to texture path: "textures/block/water_still.png"
            const texPath = relativePath.replace('.mcmeta', '');
            return { path: texPath, animation: meta.animation };
          }
        } catch (e) {
          // Skip invalid mcmeta files
        }
        return null;
      });
      
      const results = await Promise.all(mcmetaPromises);
      for (const result of results) {
        if (result) {
          // Get the texture to calculate frame count
          const texture = this.textures.get(result.path);
          const frameCount = texture 
            ? Math.floor(texture.height / texture.width) 
            : 1;
          
          this.animations.set(result.path, {
            frametime: result.animation.frametime || 1, // Ticks per frame (default 1 = 1/20 second)
            frames: result.animation.frames || null,    // Custom frame order, or null for sequential
            interpolate: result.animation.interpolate || false,
            frameCount: frameCount,
          });
        }
      }
    };
    
    // Load particle animation metadata from .mcmeta files
    const loadParticleAnimationMetadata = async () => {
      const mcmetaPromises = particleMcmetaEntries.map(async ({ file, relativePath }) => {
        try {
          const text = await file.async('text');
          const meta = JSON.parse(text);
          if (meta.animation) {
            const texPath = relativePath.replace('.mcmeta', '');
            return { path: texPath, animation: meta.animation };
          }
        } catch (e) {
          // Skip invalid mcmeta files
        }
        return null;
      });
      
      const results = await Promise.all(mcmetaPromises);
      for (const result of results) {
        if (result) {
          const texture = this.particleTextures.get(result.path);
          const frameCount = texture 
            ? Math.floor(texture.height / texture.width) 
            : 1;
          
          this.particleAnimations.set(result.path, {
            frametime: result.animation.frametime || 1,
            frames: result.animation.frames || null,
            interpolate: result.animation.interpolate || false,
            frameCount: frameCount,
          });
        }
      }
    };
    
    // Process entity textures in batches (for beacon beams, etc.)
    const loadEntityTexturesBatched = async () => {
      for (let i = 0; i < entityEntries.length; i += TEXTURE_CONCURRENCY) {
        const batch = entityEntries.slice(i, i + TEXTURE_CONCURRENCY);
        const results = await Promise.all(
          batch.map(({ file, relativePath }) => this._loadTextureEntry(file, relativePath))
        );
        for (const result of results) {
          if (result) {
            // Store entity textures in the main textures map
            this.textures.set(result.path, result.bitmap);
          }
        }
      }
    };
    
    const texturePromises = [loadTexturesBatched(), loadParticleTexturesBatched(), loadEntityTexturesBatched()];
    
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
    
    // Load blockviewer.json config if exists (custom Block Viewer settings)
    const blockviewerConfigPath = `${assetsPrefix}blockviewer.json`;
    if (zip.files[blockviewerConfigPath]) {
      try {
        const configText = await zip.files[blockviewerConfigPath].async('text');
        this.blockviewerConfig = JSON.parse(configText);
        console.log('[TexturePackManager] Loaded blockviewer.json config');
      } catch (e) {
        console.warn('[TexturePackManager] Could not parse blockviewer.json');
      }
    }
    
    // Wait for all to load
    await Promise.all([
      ...texturePromises,
      ...modelPromises,
      ...blockstatePromises,
    ]);
    
    // Load animation metadata after textures are loaded
    // (needs texture dimensions to calculate frame count)
    await loadAnimationMetadata();
    await loadParticleAnimationMetadata();
    
    this.isLoaded = true;
    
    console.log(
      `[TexturePackManager] Loaded "${packName}": ` +
      `${this.textures.size} textures, ` +
      `${this.particleTextures.size} particle textures, ` +
      `${this.models.size} models, ` +
      `${this.blockstates.size} blockstates, ` +
      `${this.animations.size} animated textures`
    );
  }

  /**
   * Load a single texture from a ZIP file entry
   * Returns a promise that resolves to { path, bitmap } or null on failure
   * @private
   */
  async _loadTextureEntry(file, relativePath) {
    try {
      const blob = await file.async('blob');
      const imageBitmap = await createImageBitmap(blob);
      return { path: relativePath, bitmap: imageBitmap };
    } catch (e) {
      return null; // Skip invalid images silently
    }
  }

  async _loadTexture(file, relativePath) {
    const result = await this._loadTextureEntry(file, relativePath);
    if (result) {
      this.textures.set(result.path, result.bitmap);
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
    this.animations.clear();
    this.particleTextures.clear();
    this.particleAnimations.clear();
    this.colormaps = { grass: null, foliage: null, dryFoliage: null };
    this.blockviewerConfig = null;
    this.isLoaded = false;
    this.packMeta = null;
    this.packName = null;
  }
  
  /**
   * Get a particle texture by path (e.g., "textures/particle/flame.png" or "particle/flame")
   * Returns ImageBitmap or null
   */
  getParticleTexture(texturePath) {
    // Normalize path
    let normalized = texturePath.replace('minecraft:', '');
    
    // Handle short form (particle/flame → textures/particle/flame.png)
    if (!normalized.startsWith('textures/')) {
      normalized = `textures/${normalized}`;
    }
    if (!normalized.endsWith('.png')) {
      normalized = `${normalized}.png`;
    }
    
    // Try this pack first
    if (this.particleTextures.has(normalized)) {
      return this.particleTextures.get(normalized);
    }
    
    // Try fallback
    if (this.fallbackManager) {
      return this.fallbackManager.getParticleTexture(normalized);
    }
    
    return null;
  }
  
  /**
   * Get all loaded particle texture paths
   */
  getParticleTextureList() {
    return Array.from(this.particleTextures.keys());
  }
  
  /**
   * Get particle animation data
   * @returns {Map<string, AnimationData>}
   */
  getParticleAnimations() {
    if (this.fallbackManager) {
      const combined = new Map(this.fallbackManager.getParticleAnimations());
      for (const [path, anim] of this.particleAnimations) {
        combined.set(path, anim);
      }
      return combined;
    }
    return new Map(this.particleAnimations);
  }
  
  /**
   * Get animation metadata for a texture
   * @param {string} texturePath - Path like "textures/block/water_still.png" or "block/water_still"
   * @returns {{ frametime: number, frames: number[]|null, interpolate: boolean, frameCount: number } | null}
   */
  getAnimation(texturePath) {
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
    if (this.animations.has(normalized)) {
      return this.animations.get(normalized);
    }
    
    // Try fallback
    if (this.fallbackManager) {
      return this.fallbackManager.getAnimation(normalized);
    }
    
    return null;
  }
  
  /**
   * Check if a texture is animated
   * @param {string} texturePath - Texture path
   * @returns {boolean}
   */
  isAnimated(texturePath) {
    return this.getAnimation(texturePath) !== null;
  }
  
  /**
   * Get all animated texture paths
   * @returns {string[]}
   */
  getAnimatedTextures() {
    return Array.from(this.animations.keys());
  }
  
  /**
   * Get all animation data
   * @returns {Map<string, { frametime: number, frames: number[]|null, interpolate: boolean, frameCount: number }>}
   */
  getAnimations() {
    // Combine with fallback animations if available
    if (this.fallbackManager) {
      const combined = new Map(this.fallbackManager.getAnimations());
      // This pack's animations override fallback
      for (const [path, anim] of this.animations) {
        combined.set(path, anim);
      }
      return combined;
    }
    return new Map(this.animations);
  }

  /**
   * Get BlockViewer-specific config from texture pack
   * @returns {Object|null} Config object or null if not present
   */
  getBlockViewerConfig() {
    return this.blockviewerConfig;
  }

  /**
   * Get random rotation blocks override from texture pack
   * @returns {string[]|null} Array of block names or null if not specified
   */
  getRandomRotationBlocks() {
    if (this.blockviewerConfig && Array.isArray(this.blockviewerConfig.randomRotationBlocks)) {
      return this.blockviewerConfig.randomRotationBlocks;
    }
    return null;
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
      animationCount: this.animations.size,
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

