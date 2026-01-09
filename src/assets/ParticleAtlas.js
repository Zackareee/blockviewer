/**
 * ParticleAtlas - Separate texture atlas for particle effects
 * 
 * Features:
 * - Packs particle textures into a power-of-2 atlas
 * - Supports animated particles (smoke uses 8 frames)
 * - Generates UV coordinates for each particle type
 * - Creates Three.js texture from atlas
 */

import * as THREE from 'three';

// Default texture size for particles (most are 8x8 or 16x16)
const DEFAULT_PARTICLE_SIZE = 8;

// Border pixels to prevent texture bleeding
const BORDER_SIZE = 1;

/**
 * Particle type definitions
 * Maps particle names to their texture file(s) and properties
 */
const PARTICLE_DEFINITIONS = {
  // Torch particles
  flame: {
    textures: ['textures/particle/flame.png'],
    animated: false,
    blendMode: 'additive',
  },
  smoke: {
    // Smoke uses reverse order for fade-out effect
    textures: [
      'textures/particle/generic_7.png',
      'textures/particle/generic_6.png',
      'textures/particle/generic_5.png',
      'textures/particle/generic_4.png',
      'textures/particle/generic_3.png',
      'textures/particle/generic_2.png',
      'textures/particle/generic_1.png',
      'textures/particle/generic_0.png',
    ],
    animated: true,
    frametime: 5, // Ticks per frame
    blendMode: 'normal',
  },
  // Soul torch particles
  soul_fire_flame: {
    textures: ['textures/particle/soul_fire_flame.png'],
    animated: false,
    blendMode: 'additive',
  },
  // Lava particles
  lava: {
    textures: ['textures/particle/lava.png'],
    animated: false,
    blendMode: 'additive',
  },
  // Dripping particles
  drip_hang: {
    textures: ['textures/particle/drip_hang.png'],
    animated: false,
    blendMode: 'normal',
  },
  drip_fall: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Bubble particles
  bubble: {
    textures: ['textures/particle/bubble.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Bubble column particles (rising bubbles from soul sand)
  bubble_column_up: {
    textures: ['textures/particle/bubble.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Current down particles (downward flow from magma)
  current_down: {
    textures: ['textures/particle/bubble.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Bubble pop animation (when bubbles reach surface)
  bubble_pop: {
    textures: [
      'textures/particle/bubble_pop_0.png',
      'textures/particle/bubble_pop_1.png',
      'textures/particle/bubble_pop_2.png',
      'textures/particle/bubble_pop_3.png',
      'textures/particle/bubble_pop_4.png',
    ],
    animated: true,
    frametime: 2,
    blendMode: 'normal',
  },
  // Large smoke (furnace, smoker, blast furnace)
  large_smoke: {
    textures: [
      'textures/particle/big_smoke_0.png',
      'textures/particle/big_smoke_1.png',
      'textures/particle/big_smoke_2.png',
      'textures/particle/big_smoke_3.png',
      'textures/particle/big_smoke_4.png',
      'textures/particle/big_smoke_5.png',
      'textures/particle/big_smoke_6.png',
      'textures/particle/big_smoke_7.png',
      'textures/particle/big_smoke_8.png',
      'textures/particle/big_smoke_9.png',
      'textures/particle/big_smoke_10.png',
      'textures/particle/big_smoke_11.png',
    ],
    animated: true,
    frametime: 3,
    blendMode: 'normal',
  },
  // Small flame (candles)
  small_flame: {
    textures: ['textures/particle/flame.png'], // Uses same texture, just smaller
    animated: false,
    blendMode: 'additive',
  },
  // End rod particle (white glow)
  end_rod: {
    textures: ['textures/particle/effect_0.png'],
    animated: false,
    blendMode: 'additive',
  },
  // Campfire smoke (cosy - normal height)
  campfire_cosy_smoke: {
    textures: [
      'textures/particle/big_smoke_0.png',
      'textures/particle/big_smoke_1.png',
      'textures/particle/big_smoke_2.png',
      'textures/particle/big_smoke_3.png',
      'textures/particle/big_smoke_4.png',
      'textures/particle/big_smoke_5.png',
      'textures/particle/big_smoke_6.png',
      'textures/particle/big_smoke_7.png',
      'textures/particle/big_smoke_8.png',
      'textures/particle/big_smoke_9.png',
      'textures/particle/big_smoke_10.png',
      'textures/particle/big_smoke_11.png',
    ],
    animated: true,
    frametime: 4,
    blendMode: 'normal',
  },
  // Campfire signal smoke (tall - with hay bale)
  campfire_signal_smoke: {
    textures: [
      'textures/particle/big_smoke_0.png',
      'textures/particle/big_smoke_1.png',
      'textures/particle/big_smoke_2.png',
      'textures/particle/big_smoke_3.png',
      'textures/particle/big_smoke_4.png',
      'textures/particle/big_smoke_5.png',
      'textures/particle/big_smoke_6.png',
      'textures/particle/big_smoke_7.png',
      'textures/particle/big_smoke_8.png',
      'textures/particle/big_smoke_9.png',
      'textures/particle/big_smoke_10.png',
      'textures/particle/big_smoke_11.png',
    ],
    animated: true,
    frametime: 6,
    blendMode: 'normal',
  },
  // Copper flame (lightning rod struck)
  copper_flame: {
    textures: ['textures/particle/copper_fire_flame.png'],
    animated: false,
    blendMode: 'additive',
  },
  // Spore blossom particles (uses drip_fall texture)
  spore_blossom_air: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  falling_spore_blossom: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Cherry leaf particles (pink - not tinted)
  cherry_leaves: {
    textures: [
      'textures/particle/cherry_0.png',
      'textures/particle/cherry_1.png',
      'textures/particle/cherry_2.png',
      'textures/particle/cherry_3.png',
      'textures/particle/cherry_4.png',
      'textures/particle/cherry_5.png',
      'textures/particle/cherry_6.png',
      'textures/particle/cherry_7.png',
      'textures/particle/cherry_8.png',
      'textures/particle/cherry_9.png',
      'textures/particle/cherry_10.png',
      'textures/particle/cherry_11.png',
    ],
    animated: true,
    frametime: 4,
    blendMode: 'normal',
  },
  // Tinted leaf particles (uses biome tint - oak, birch, jungle, etc.)
  tinted_leaves: {
    textures: [
      'textures/particle/leaf_0.png',
      'textures/particle/leaf_1.png',
      'textures/particle/leaf_2.png',
      'textures/particle/leaf_3.png',
      'textures/particle/leaf_4.png',
      'textures/particle/leaf_5.png',
      'textures/particle/leaf_6.png',
      'textures/particle/leaf_7.png',
      'textures/particle/leaf_8.png',
      'textures/particle/leaf_9.png',
      'textures/particle/leaf_10.png',
      'textures/particle/leaf_11.png',
    ],
    animated: true,
    frametime: 5, // Slow rotation through shapes
    blendMode: 'normal',
  },
  // Mycelium spores
  mycelium: {
    textures: ['textures/particle/generic_0.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Dripping particles (water/lava/honey/obsidian)
  dripping_water: {
    textures: ['textures/particle/drip_hang.png'],
    animated: false,
    blendMode: 'normal',
  },
  falling_water: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  dripping_lava: {
    textures: ['textures/particle/drip_hang.png'],
    animated: false,
    blendMode: 'normal',
  },
  falling_lava: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  dripping_honey: {
    textures: ['textures/particle/drip_hang.png'],
    animated: false,
    blendMode: 'normal',
  },
  falling_honey: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  dripping_obsidian_tear: {
    textures: ['textures/particle/drip_hang.png'],
    animated: false,
    blendMode: 'normal',
  },
  falling_obsidian_tear: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Portal particle
  portal: {
    textures: [
      'textures/particle/generic_7.png',
      'textures/particle/generic_6.png',
      'textures/particle/generic_5.png',
      'textures/particle/generic_4.png',
      'textures/particle/generic_3.png',
      'textures/particle/generic_2.png',
      'textures/particle/generic_1.png',
      'textures/particle/generic_0.png',
    ],
    animated: true,
    frametime: 3,
    blendMode: 'additive',
  },
  // Wither rose smoke
  wither_smoke: {
    textures: [
      'textures/particle/generic_7.png',
      'textures/particle/generic_6.png',
      'textures/particle/generic_5.png',
      'textures/particle/generic_4.png',
      'textures/particle/generic_3.png',
      'textures/particle/generic_2.png',
      'textures/particle/generic_1.png',
      'textures/particle/generic_0.png',
    ],
    animated: true,
    frametime: 5,
    blendMode: 'normal',
  },
  // Note particle
  note: {
    textures: ['textures/particle/note.png'],
    animated: false,
    blendMode: 'additive',
  },
  // Dust/redstone particle
  dust: {
    textures: ['textures/particle/generic_0.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Nectar (beehive)
  falling_nectar: {
    textures: ['textures/particle/drip_fall.png'],
    animated: false,
    blendMode: 'normal',
  },
  // Firefly
  firefly: {
    textures: ['textures/particle/firefly.png'],
    animated: false,
    blendMode: 'additive', // Fireflies glow
  },
  // White smoke (various uses)
  white_smoke: {
    textures: [
      'textures/particle/generic_7.png',
      'textures/particle/generic_6.png',
      'textures/particle/generic_5.png',
      'textures/particle/generic_4.png',
      'textures/particle/generic_3.png',
      'textures/particle/generic_2.png',
      'textures/particle/generic_1.png',
      'textures/particle/generic_0.png',
    ],
    animated: true,
    frametime: 3,
    blendMode: 'normal',
  },
  // Enchant particle (SGA letters for enchanting table)
  enchant: {
    textures: [
      'textures/particle/sga_a.png',
      'textures/particle/sga_b.png',
      'textures/particle/sga_c.png',
      'textures/particle/sga_d.png',
      'textures/particle/sga_e.png',
      'textures/particle/sga_f.png',
      'textures/particle/sga_g.png',
      'textures/particle/sga_h.png',
      'textures/particle/sga_i.png',
      'textures/particle/sga_j.png',
      'textures/particle/sga_k.png',
      'textures/particle/sga_l.png',
      'textures/particle/sga_m.png',
      'textures/particle/sga_n.png',
      'textures/particle/sga_o.png',
      'textures/particle/sga_p.png',
      'textures/particle/sga_q.png',
      'textures/particle/sga_r.png',
      'textures/particle/sga_s.png',
      'textures/particle/sga_t.png',
      'textures/particle/sga_u.png',
      'textures/particle/sga_v.png',
      'textures/particle/sga_w.png',
      'textures/particle/sga_x.png',
      'textures/particle/sga_y.png',
      'textures/particle/sga_z.png',
    ],
    animated: false, // Each particle picks a random letter
    blendMode: 'additive',
  },
  // Glitter particle (sparkle effect)
  glitter: {
    textures: [
      'textures/particle/glitter_0.png',
      'textures/particle/glitter_1.png',
      'textures/particle/glitter_2.png',
      'textures/particle/glitter_3.png',
      'textures/particle/glitter_4.png',
      'textures/particle/glitter_5.png',
      'textures/particle/glitter_6.png',
      'textures/particle/glitter_7.png',
    ],
    animated: true,
    frametime: 2,
    blendMode: 'additive',
  },
  // Reverse portal (respawn anchor)
  reverse_portal: {
    textures: [
      'textures/particle/generic_0.png',
      'textures/particle/generic_1.png',
      'textures/particle/generic_2.png',
      'textures/particle/generic_3.png',
      'textures/particle/generic_4.png',
      'textures/particle/generic_5.png',
      'textures/particle/generic_6.png',
      'textures/particle/generic_7.png',
    ],
    animated: true,
    frametime: 3,
    blendMode: 'additive',
  },
};

/**
 * ParticleAtlas class
 */
class ParticleAtlas {
  constructor() {
    // UV lookup: particleName → { u, v, width, height, frameCount, frames[] }
    this.particleLookup = new Map();
    
    // Texture name to atlas index: texturePath → index
    this.textureToIndex = new Map();
    
    // Atlas canvas and context
    this.canvas = null;
    this.ctx = null;
    
    // Atlas dimensions
    this.atlasWidth = 0;
    this.atlasHeight = 0;
    
    // Tiles per row/column
    this.tilesPerRow = 0;
    this.tilesPerCol = 0;
    
    // Total tiles in atlas
    this.totalTiles = 0;
    
    // Three.js texture
    this.texture = null;
    
    // Detected particle texture size
    this.textureSize = DEFAULT_PARTICLE_SIZE;
    this.tileSize = DEFAULT_PARTICLE_SIZE + BORDER_SIZE * 2;
    
    // Build state
    this.isBuilt = false;
  }

  /**
   * Build the particle atlas from a TexturePackManager
   * @param {TexturePackManager} packManager
   */
  async build(packManager) {
    if (!packManager || !packManager.isLoaded) {
      console.warn('[ParticleAtlas] No texture pack loaded');
      return false;
    }

    const particleTextures = packManager.getParticleTextureList();
    
    if (particleTextures.length === 0) {
      console.warn('[ParticleAtlas] No particle textures found');
      return false;
    }
    
    // Debug: Check fallback status
    const hasFallback = !!packManager.fallbackManager;
    const fallbackLoaded = packManager.fallbackManager?.isLoaded;
    console.log(`[ParticleAtlas] Pack has fallback: ${hasFallback}, fallback loaded: ${fallbackLoaded}, total paths: ${particleTextures.length}`);

    // Detect texture size from first particle
    this.textureSize = this._detectTextureSize(packManager, particleTextures);
    this.tileSize = this.textureSize + BORDER_SIZE * 2;

    // Count total tiles needed (including all animation frames)
    let totalTiles = 0;
    const textureList = [];
    
    for (const path of particleTextures) {
      const bitmap = packManager.getParticleTexture(path);
      if (!bitmap) continue;
      
      // Check for animated textures (height > width)
      const frameCount = bitmap.height > bitmap.width 
        ? Math.floor(bitmap.height / bitmap.width) 
        : 1;
      
      for (let frame = 0; frame < frameCount; frame++) {
        textureList.push({ path, frame, frameCount });
        totalTiles++;
      }
    }
    
    this.totalTiles = totalTiles;

    console.log(`[ParticleAtlas] Building atlas from ${particleTextures.length} particle textures (${totalTiles} total tiles, ${this.textureSize}x${this.textureSize} resolution)...`);
    
    // Debug: Check if firefly texture is in the list
    const hasFireflyPath = particleTextures.some(p => p.includes('firefly'));
    const fireflyBitmap = packManager.getParticleTexture('textures/particle/firefly.png');
    console.log(`[ParticleAtlas] Debug - firefly in paths: ${hasFireflyPath}, firefly bitmap: ${fireflyBitmap ? `${fireflyBitmap.width}x${fireflyBitmap.height}` : 'null'}`);

    // Calculate atlas dimensions (power of 2)
    const tilesPerRow = Math.ceil(Math.sqrt(totalTiles));
    this.atlasWidth = this._nextPowerOf2(tilesPerRow * this.tileSize);
    this.atlasHeight = this._nextPowerOf2(Math.ceil(totalTiles / tilesPerRow) * this.tileSize);
    
    this.tilesPerRow = Math.floor(this.atlasWidth / this.tileSize);
    this.tilesPerCol = Math.floor(this.atlasHeight / this.tileSize);

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.atlasWidth;
    this.canvas.height = this.atlasHeight;
    this.ctx = this.canvas.getContext('2d');
    
    // CRITICAL: Disable image smoothing for crisp pixel art
    // Without this, smaller textures (8x8) scaled to larger tiles (16x16) become blurry
    this.ctx.imageSmoothingEnabled = false;

    // Fill with transparent background
    this.ctx.clearRect(0, 0, this.atlasWidth, this.atlasHeight);

    // Place textures
    this.textureToIndex.clear();
    this.particleLookup.clear();
    
    let tileIndex = 0;
    
    for (const { path, frame, frameCount } of textureList) {
      const bitmap = packManager.getParticleTexture(path);
      if (!bitmap) continue;
      
      const col = tileIndex % this.tilesPerRow;
      const row = Math.floor(tileIndex / this.tilesPerRow);
      const tileX = col * this.tileSize;
      const tileY = row * this.tileSize;
      
      // Draw the frame with border
      this._drawFrameWithBorder(bitmap, tileX, tileY, frame);
      
      // Store texture index for this specific frame
      const frameKey = `${path}:${frame}`;
      this.textureToIndex.set(frameKey, tileIndex);
      
      // For first frame, store in particle lookup
      if (frame === 0) {
        const particleName = this._pathToParticleName(path);
        const innerX = tileX + BORDER_SIZE;
        const innerY = tileY + BORDER_SIZE;
        
        this.particleLookup.set(particleName, {
          u: innerX / this.atlasWidth,
          v: innerY / this.atlasHeight,
          width: this.textureSize / this.atlasWidth,
          height: this.textureSize / this.atlasHeight,
          index: tileIndex,
          frameCount: frameCount,
          path: path,
        });
        
        // Also store by path
        this.particleLookup.set(path, this.particleLookup.get(particleName));
      }
      
      tileIndex++;
    }

    // Create Three.js texture
    this._createThreeTexture();

    // Register particle type aliases from PARTICLE_DEFINITIONS
    this._registerParticleAliases();

    this.isBuilt = true;
    console.log(`[ParticleAtlas] Built ${this.atlasWidth}x${this.atlasHeight} atlas with ${this.particleLookup.size} particle entries`);
    
    // Debug: Check key entries
    const fireflyEntry = this.particleLookup.get('firefly');
    const flameEntry = this.particleLookup.get('flame');
    const tintedLeavesEntry = this.particleLookup.get('tinted_leaves');
    console.log(`[ParticleAtlas] Debug - firefly: ${fireflyEntry ? `idx=${fireflyEntry.index}` : 'NOT FOUND'}, ` +
      `flame: ${flameEntry ? `idx=${flameEntry.index}` : 'NOT FOUND'}, ` +
      `tinted_leaves: ${tintedLeavesEntry ? `idx=${tintedLeavesEntry.index}` : 'NOT FOUND'}`);

    return true;
  }

  /**
   * Register particle type aliases from PARTICLE_DEFINITIONS
   * Maps named particle types (e.g., "smoke", "campfire_cosy_smoke") to their texture entries
   */
  _registerParticleAliases() {
    for (const [particleName, definition] of Object.entries(PARTICLE_DEFINITIONS)) {
      // Skip if already registered (e.g., "flame" matches flame.png directly)
      if (this.particleLookup.has(particleName)) continue;
      
      // Get the first texture to find the base entry
      const firstTexture = definition.textures[0];
      const baseTextureName = this._pathToParticleName(firstTexture);
      const baseEntry = this.particleLookup.get(baseTextureName);
      
      if (baseEntry) {
        const frameCount = definition.textures.length;
        
        // For multi-file animations, we need to collect all frame indices
        // and store them for the animation system
        const frameIndices = [];
        for (const texPath of definition.textures) {
          const texName = this._pathToParticleName(texPath);
          const texEntry = this.particleLookup.get(texName);
          if (texEntry) {
            frameIndices.push(texEntry.index);
          }
        }
        
        // Create the alias entry
        this.particleLookup.set(particleName, {
          ...baseEntry,
          frameCount: frameCount,
          frameIndices: frameIndices.length > 0 ? frameIndices : null,
          isMultiFile: definition.textures.length > 1 && frameIndices.length > 1,
        });
        
        // Debug log
        if (frameCount > 1) {
          console.log(`[ParticleAtlas] Registered "${particleName}" → "${baseTextureName}" (${frameCount} frames, multi-file: ${frameIndices.length > 1})`);
        }
      } else {
        console.warn(`[ParticleAtlas] Could not find base texture "${baseTextureName}" for particle "${particleName}"`);
      }
    }
  }

  /**
   * Draw a specific frame of a texture with border pixels
   */
  _drawFrameWithBorder(bitmap, tileX, tileY, frameIndex) {
    const innerX = tileX + BORDER_SIZE;
    const innerY = tileY + BORDER_SIZE;
    const texSize = this.textureSize;
    const srcW = bitmap.width;
    const frameH = srcW; // Each frame is square
    const srcY = frameIndex * frameH;

    // Draw main texture
    this.ctx.drawImage(bitmap, 0, srcY, srcW, frameH, 
                       innerX, innerY, texSize, texSize);

    // Draw border pixels
    // Top border
    this.ctx.drawImage(bitmap, 0, srcY, srcW, 1,
                       innerX, tileY, texSize, BORDER_SIZE);
    // Bottom border
    this.ctx.drawImage(bitmap, 0, srcY + frameH - 1, srcW, 1,
                       innerX, innerY + texSize, texSize, BORDER_SIZE);
    // Left border
    this.ctx.drawImage(bitmap, 0, srcY, 1, frameH,
                       tileX, innerY, BORDER_SIZE, texSize);
    // Right border
    this.ctx.drawImage(bitmap, srcW - 1, srcY, 1, frameH,
                       innerX + texSize, innerY, BORDER_SIZE, texSize);

    // Corner pixels
    this.ctx.drawImage(bitmap, 0, srcY, 1, 1,
                       tileX, tileY, BORDER_SIZE, BORDER_SIZE);
    this.ctx.drawImage(bitmap, srcW - 1, srcY, 1, 1,
                       innerX + texSize, tileY, BORDER_SIZE, BORDER_SIZE);
    this.ctx.drawImage(bitmap, 0, srcY + frameH - 1, 1, 1,
                       tileX, innerY + texSize, BORDER_SIZE, BORDER_SIZE);
    this.ctx.drawImage(bitmap, srcW - 1, srcY + frameH - 1, 1, 1,
                       innerX + texSize, innerY + texSize, BORDER_SIZE, BORDER_SIZE);
  }

  /**
   * Convert texture path to particle name
   * "textures/particle/flame.png" → "flame"
   */
  _pathToParticleName(path) {
    let name = path;
    if (name.startsWith('textures/particle/')) {
      name = name.substring(18); // Remove "textures/particle/"
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
    this.texture.flipY = false;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  /**
   * Get UV data for a particle type
   * @param {string} particleName - e.g., "flame" or "smoke"
   * @returns {{ u, v, width, height, index, frameCount } | null}
   */
  getParticleUV(particleName) {
    if (!this.isBuilt) return null;
    return this.particleLookup.get(particleName) || null;
  }

  /**
   * Get atlas index for a specific frame of a particle
   * @param {string} particleName - Particle name
   * @param {number} frame - Frame index
   * @returns {number} Atlas tile index
   */
  getFrameIndex(particleName, frame) {
    const data = this.particleLookup.get(particleName);
    if (!data) return 0;
    
    const clampedFrame = Math.max(0, Math.min(frame, data.frameCount - 1));
    
    // For multi-file animations, use the frameIndices array
    if (data.frameIndices && data.frameIndices.length > 0) {
      return data.frameIndices[clampedFrame];
    }
    
    // For single-file animations, frames are sequential
    return data.index + clampedFrame;
  }

  /**
   * Get the Three.js texture
   */
  getTexture() {
    return this.texture;
  }

  /**
   * Get material data for particle rendering
   */
  getMaterialData() {
    return {
      atlas: this.texture,
      tilesPerRow: this.tilesPerRow,
      tilesPerCol: this.tilesPerCol,
      totalTiles: this.totalTiles,
      tileUV: {
        x: this.tileSize / this.atlasWidth,
        y: this.tileSize / this.atlasHeight,
      },
      textureUV: {
        x: this.textureSize / this.atlasWidth,
        y: this.textureSize / this.atlasHeight,
      },
      borderUV: {
        x: BORDER_SIZE / this.atlasWidth,
        y: BORDER_SIZE / this.atlasHeight,
      },
      atlasWidth: this.atlasWidth,
      atlasHeight: this.atlasHeight,
      textureSize: this.textureSize,
    };
  }

  /**
   * Get all registered particle definitions
   */
  static getParticleDefinitions() {
    return PARTICLE_DEFINITIONS;
  }

  /**
   * Get next power of 2
   */
  _nextPowerOf2(n) {
    return Math.pow(2, Math.ceil(Math.log2(n)));
  }

  /**
   * Detect texture size from particle textures
   * Uses the MAXIMUM size found to accommodate all textures (8x8 and 16x16)
   */
  _detectTextureSize(packManager, texturePaths) {
    let maxSize = DEFAULT_PARTICLE_SIZE;
    
    // Scan all textures to find the largest
    for (const path of texturePaths) {
      const bitmap = packManager.getParticleTexture(path);
      if (bitmap && bitmap.width > maxSize) {
        maxSize = bitmap.width;
      }
    }
    
    console.log(`[ParticleAtlas] Using ${maxSize}x${maxSize} tile size (max found across all particles)`);
    return maxSize;
  }

  /**
   * Dispose of resources
   */
  dispose() {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.canvas = null;
    this.ctx = null;
    this.particleLookup.clear();
    this.textureToIndex.clear();
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
 * Get the particle atlas singleton
 */
export function getParticleAtlas() {
  if (!instance) {
    instance = new ParticleAtlas();
  }
  return instance;
}

export { ParticleAtlas, PARTICLE_DEFINITIONS, DEFAULT_PARTICLE_SIZE, BORDER_SIZE };
export default ParticleAtlas;

