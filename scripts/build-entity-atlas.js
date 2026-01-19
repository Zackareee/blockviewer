#!/usr/bin/env node
/**
 * Entity Texture Atlas Builder
 * 
 * Builds a texture atlas from entity textures for the WASM entity meshing pipeline.
 * Entity textures have varying sizes (64x64, 64x32, 256x256) which requires
 * special handling compared to the uniform 16x16 block textures.
 * 
 * Output:
 *   - public/assets/entity-atlas.png - The packed texture atlas
 *   - public/assets/entity-atlas-manifest.json - Texture path -> atlas region mapping
 * 
 * Usage:
 *   node scripts/build-entity-atlas.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ENTITY_TEXTURES_PATH = path.join(__dirname, '../textures/1.21.11+Template/assets/minecraft/textures/entity');
const OUTPUT_ATLAS_PATH = path.join(__dirname, '../public/assets/entity-atlas.png');
const OUTPUT_MANIFEST_PATH = path.join(__dirname, '../public/assets/entity-atlas-manifest.json');

// Border pixels to prevent texture bleeding
const BORDER_SIZE = 1;

// Entity textures we need for block entities (subset of all entity textures)
const BLOCK_ENTITY_TEXTURES = {
  // Chests
  'entity/chest/normal': 'chest/normal.png',
  'entity/chest/normal_left': 'chest/normal_left.png',
  'entity/chest/normal_right': 'chest/normal_right.png',
  'entity/chest/trapped': 'chest/trapped.png',
  'entity/chest/trapped_left': 'chest/trapped_left.png',
  'entity/chest/trapped_right': 'chest/trapped_right.png',
  'entity/chest/ender': 'chest/ender.png',
  'entity/chest/christmas': 'chest/christmas.png',
  'entity/chest/christmas_left': 'chest/christmas_left.png',
  'entity/chest/christmas_right': 'chest/christmas_right.png',
  
  // Beds (16 colors)
  'entity/bed/white': 'bed/white.png',
  'entity/bed/orange': 'bed/orange.png',
  'entity/bed/magenta': 'bed/magenta.png',
  'entity/bed/light_blue': 'bed/light_blue.png',
  'entity/bed/yellow': 'bed/yellow.png',
  'entity/bed/lime': 'bed/lime.png',
  'entity/bed/pink': 'bed/pink.png',
  'entity/bed/gray': 'bed/gray.png',
  'entity/bed/light_gray': 'bed/light_gray.png',
  'entity/bed/cyan': 'bed/cyan.png',
  'entity/bed/purple': 'bed/purple.png',
  'entity/bed/blue': 'bed/blue.png',
  'entity/bed/brown': 'bed/brown.png',
  'entity/bed/green': 'bed/green.png',
  'entity/bed/red': 'bed/red.png',
  'entity/bed/black': 'bed/black.png',
  
  // Signs (12 wood types)
  'entity/signs/oak': 'signs/oak.png',
  'entity/signs/spruce': 'signs/spruce.png',
  'entity/signs/birch': 'signs/birch.png',
  'entity/signs/acacia': 'signs/acacia.png',
  'entity/signs/cherry': 'signs/cherry.png',
  'entity/signs/jungle': 'signs/jungle.png',
  'entity/signs/dark_oak': 'signs/dark_oak.png',
  'entity/signs/pale_oak': 'signs/pale_oak.png',
  'entity/signs/mangrove': 'signs/mangrove.png',
  'entity/signs/bamboo': 'signs/bamboo.png',
  'entity/signs/crimson': 'signs/crimson.png',
  'entity/signs/warped': 'signs/warped.png',
  
  // Hanging signs
  'entity/signs/hanging/oak': 'signs/hanging/oak.png',
  'entity/signs/hanging/spruce': 'signs/hanging/spruce.png',
  'entity/signs/hanging/birch': 'signs/hanging/birch.png',
  'entity/signs/hanging/acacia': 'signs/hanging/acacia.png',
  'entity/signs/hanging/cherry': 'signs/hanging/cherry.png',
  'entity/signs/hanging/jungle': 'signs/hanging/jungle.png',
  'entity/signs/hanging/dark_oak': 'signs/hanging/dark_oak.png',
  'entity/signs/hanging/pale_oak': 'signs/hanging/pale_oak.png',
  'entity/signs/hanging/mangrove': 'signs/hanging/mangrove.png',
  'entity/signs/hanging/bamboo': 'signs/hanging/bamboo.png',
  'entity/signs/hanging/crimson': 'signs/hanging/crimson.png',
  'entity/signs/hanging/warped': 'signs/hanging/warped.png',
  
  // Skulls
  'entity/skeleton/skeleton': 'skeleton/skeleton.png',
  'entity/skeleton/wither_skeleton': 'skeleton/wither_skeleton.png',
  'entity/creeper/creeper': 'creeper/creeper.png',
  'entity/zombie/zombie': 'zombie/zombie.png',
  'entity/player/wide/steve': 'player/wide/steve.png',
  'entity/enderdragon/dragon': 'enderdragon/dragon.png',
  'entity/piglin/piglin': 'piglin/piglin.png',
  
  // Bell
  'entity/bell/bell_body': 'bell/bell_body.png',
  
  // Banner base
  'entity/banner_base': 'banner_base.png',
  
  // Shulker boxes (17 variants - default + 16 colors)
  'entity/shulker/shulker': 'shulker/shulker.png',
  'entity/shulker/shulker_white': 'shulker/shulker_white.png',
  'entity/shulker/shulker_orange': 'shulker/shulker_orange.png',
  'entity/shulker/shulker_magenta': 'shulker/shulker_magenta.png',
  'entity/shulker/shulker_light_blue': 'shulker/shulker_light_blue.png',
  'entity/shulker/shulker_yellow': 'shulker/shulker_yellow.png',
  'entity/shulker/shulker_lime': 'shulker/shulker_lime.png',
  'entity/shulker/shulker_pink': 'shulker/shulker_pink.png',
  'entity/shulker/shulker_gray': 'shulker/shulker_gray.png',
  'entity/shulker/shulker_light_gray': 'shulker/shulker_light_gray.png',
  'entity/shulker/shulker_cyan': 'shulker/shulker_cyan.png',
  'entity/shulker/shulker_purple': 'shulker/shulker_purple.png',
  'entity/shulker/shulker_blue': 'shulker/shulker_blue.png',
  'entity/shulker/shulker_brown': 'shulker/shulker_brown.png',
  'entity/shulker/shulker_green': 'shulker/shulker_green.png',
  'entity/shulker/shulker_red': 'shulker/shulker_red.png',
  'entity/shulker/shulker_black': 'shulker/shulker_black.png',
  
  // Conduit
  'entity/conduit/base': 'conduit/base.png',
  'entity/conduit/open': 'conduit/open.png',
  'entity/conduit/wind': 'conduit/wind.png',
  'entity/conduit/wind_vertical': 'conduit/wind_vertical.png',
  
  // Decorated pot
  'entity/decorated_pot/decorated_pot_base': 'decorated_pot/decorated_pot_base.png',
  
  // Enchanting table book
  'entity/enchanting_table_book': 'enchanting_table_book.png',
};

// Banner pattern textures (for pattern compositing)
const BANNER_PATTERN_TEXTURES = {
  'entity/banner/base': 'banner/base.png',
  'entity/banner/border': 'banner/border.png',
  'entity/banner/bricks': 'banner/bricks.png',
  'entity/banner/circle': 'banner/circle.png',
  'entity/banner/creeper': 'banner/creeper.png',
  'entity/banner/cross': 'banner/cross.png',
  'entity/banner/curly_border': 'banner/curly_border.png',
  'entity/banner/diagonal_left': 'banner/diagonal_left.png',
  'entity/banner/diagonal_right': 'banner/diagonal_right.png',
  'entity/banner/diagonal_up_left': 'banner/diagonal_up_left.png',
  'entity/banner/diagonal_up_right': 'banner/diagonal_up_right.png',
  'entity/banner/flow': 'banner/flow.png',
  'entity/banner/flower': 'banner/flower.png',
  'entity/banner/globe': 'banner/globe.png',
  'entity/banner/gradient': 'banner/gradient.png',
  'entity/banner/gradient_up': 'banner/gradient_up.png',
  'entity/banner/guster': 'banner/guster.png',
  'entity/banner/half_horizontal': 'banner/half_horizontal.png',
  'entity/banner/half_horizontal_bottom': 'banner/half_horizontal_bottom.png',
  'entity/banner/half_vertical': 'banner/half_vertical.png',
  'entity/banner/half_vertical_right': 'banner/half_vertical_right.png',
  'entity/banner/mojang': 'banner/mojang.png',
  'entity/banner/piglin': 'banner/piglin.png',
  'entity/banner/rhombus': 'banner/rhombus.png',
  'entity/banner/skull': 'banner/skull.png',
  'entity/banner/small_stripes': 'banner/small_stripes.png',
  'entity/banner/square_bottom_left': 'banner/square_bottom_left.png',
  'entity/banner/square_bottom_right': 'banner/square_bottom_right.png',
  'entity/banner/square_top_left': 'banner/square_top_left.png',
  'entity/banner/square_top_right': 'banner/square_top_right.png',
  'entity/banner/straight_cross': 'banner/straight_cross.png',
  'entity/banner/stripe_bottom': 'banner/stripe_bottom.png',
  'entity/banner/stripe_center': 'banner/stripe_center.png',
  'entity/banner/stripe_downleft': 'banner/stripe_downleft.png',
  'entity/banner/stripe_downright': 'banner/stripe_downright.png',
  'entity/banner/stripe_left': 'banner/stripe_left.png',
  'entity/banner/stripe_middle': 'banner/stripe_middle.png',
  'entity/banner/stripe_right': 'banner/stripe_right.png',
  'entity/banner/stripe_top': 'banner/stripe_top.png',
  'entity/banner/triangle_bottom': 'banner/triangle_bottom.png',
  'entity/banner/triangle_top': 'banner/triangle_top.png',
  'entity/banner/triangles_bottom': 'banner/triangles_bottom.png',
  'entity/banner/triangles_top': 'banner/triangles_top.png',
};

/**
 * Load a PNG texture
 */
function loadTexture(texturePath) {
  const fullPath = path.join(ENTITY_TEXTURES_PATH, texturePath);
  
  if (!fs.existsSync(fullPath)) {
    console.warn(`  Warning: Texture not found: ${fullPath}`);
    return null;
  }
  
  try {
    const data = fs.readFileSync(fullPath);
    const png = PNG.sync.read(data);
    return {
      png,
      width: png.width,
      height: png.height,
      data: png.data,
    };
  } catch (error) {
    console.warn(`  Warning: Failed to load texture: ${fullPath} - ${error.message}`);
    return null;
  }
}

/**
 * Simple bin packing algorithm for variable-sized textures
 * Uses a shelf-based approach
 */
class ShelfPacker {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.shelves = [];
    this.currentY = 0;
  }
  
  pack(itemWidth, itemHeight) {
    const paddedWidth = itemWidth + BORDER_SIZE * 2;
    const paddedHeight = itemHeight + BORDER_SIZE * 2;
    
    // Try to fit in existing shelf
    for (const shelf of this.shelves) {
      if (shelf.height >= paddedHeight && shelf.x + paddedWidth <= this.width) {
        const result = { x: shelf.x + BORDER_SIZE, y: shelf.y + BORDER_SIZE };
        shelf.x += paddedWidth;
        return result;
      }
    }
    
    // Create new shelf
    if (this.currentY + paddedHeight > this.height) {
      return null; // Doesn't fit
    }
    
    const newShelf = {
      y: this.currentY,
      x: paddedWidth,
      height: paddedHeight,
    };
    
    this.shelves.push(newShelf);
    const result = { x: BORDER_SIZE, y: this.currentY + BORDER_SIZE };
    this.currentY += paddedHeight;
    
    return result;
  }
}

/**
 * Copy a region of pixels from src to dst
 */
function copyRegion(src, srcWidth, srcX, srcY, srcW, srcH, dst, dstWidth, dstX, dstY) {
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const srcIdx = ((srcY + y) * srcWidth + (srcX + x)) * 4;
      const dstIdx = ((dstY + y) * dstWidth + (dstX + x)) * 4;
      
      dst[dstIdx + 0] = src[srcIdx + 0];
      dst[dstIdx + 1] = src[srcIdx + 1];
      dst[dstIdx + 2] = src[srcIdx + 2];
      dst[dstIdx + 3] = src[srcIdx + 3];
    }
  }
}

/**
 * Build the entity texture atlas
 */
function buildAtlas() {
  console.log('=== Entity Texture Atlas Builder ===\n');
  
  // Combine all textures
  const allTextures = {
    ...BLOCK_ENTITY_TEXTURES,
    ...BANNER_PATTERN_TEXTURES,
  };
  
  // Load all textures and get dimensions
  console.log('Loading textures...');
  const loadedTextures = [];
  
  for (const [key, relativePath] of Object.entries(allTextures)) {
    const texture = loadTexture(relativePath);
    if (texture) {
      loadedTextures.push({
        key,
        relativePath,
        ...texture,
      });
    }
  }
  
  console.log(`Loaded ${loadedTextures.length} textures`);
  
  if (loadedTextures.length === 0) {
    console.error('No textures loaded!');
    process.exit(1);
  }
  
  // Sort by height (descending) for better packing
  loadedTextures.sort((a, b) => b.height - a.height);
  
  // Calculate required atlas size
  let atlasSize = 1024;
  let packer = null;
  let placements = null;
  
  while (atlasSize <= 4096) {
    packer = new ShelfPacker(atlasSize, atlasSize);
    placements = [];
    let allFit = true;
    
    for (const texture of loadedTextures) {
      const pos = packer.pack(texture.width, texture.height);
      if (pos) {
        placements.push({
          ...texture,
          atlasX: pos.x,
          atlasY: pos.y,
        });
      } else {
        allFit = false;
        break;
      }
    }
    
    if (allFit) {
      break;
    }
    
    atlasSize *= 2;
  }
  
  if (!placements || placements.length !== loadedTextures.length) {
    console.error('Failed to pack all textures into atlas!');
    process.exit(1);
  }
  
  console.log(`\nAtlas size: ${atlasSize}x${atlasSize}`);
  
  // Create atlas image
  console.log('Building atlas...');
  const atlasData = new Uint8Array(atlasSize * atlasSize * 4);
  atlasData.fill(0); // Start transparent
  
  // Build manifest
  const manifest = {
    version: 1,
    atlasSize: [atlasSize, atlasSize],
    textures: {},
  };
  
  let index = 0;
  for (const placement of placements) {
    const { key, data, atlasX, atlasY, width, height } = placement;
    
    // Copy texture to atlas
    copyRegion(data, width, 0, 0, width, height, atlasData, atlasSize, atlasX, atlasY);
    
    // Copy borders for seamless sampling
    // Top border (duplicate first row)
    if (atlasY > 0) {
      copyRegion(data, width, 0, 0, width, 1, atlasData, atlasSize, atlasX, atlasY - 1);
    }
    // Bottom border (duplicate last row)
    if (atlasY + height < atlasSize) {
      copyRegion(data, width, 0, height - 1, width, 1, atlasData, atlasSize, atlasX, atlasY + height);
    }
    // Left border (duplicate first column)
    if (atlasX > 0) {
      copyRegion(data, width, 0, 0, 1, height, atlasData, atlasSize, atlasX - 1, atlasY);
    }
    // Right border (duplicate last column)
    if (atlasX + width < atlasSize) {
      copyRegion(data, width, width - 1, 0, 1, height, atlasData, atlasSize, atlasX + width, atlasY);
    }
    
    // Calculate normalized UV coordinates
    const u = atlasX / atlasSize;
    const v = atlasY / atlasSize;
    const uSize = width / atlasSize;
    const vSize = height / atlasSize;
    
    manifest.textures[key] = {
      x: atlasX,
      y: atlasY,
      w: width,
      h: height,
      u,
      v,
      uSize,
      vSize,
      index,
    };
    
    index++;
  }
  
  // Save atlas image
  console.log(`\nSaving atlas to ${OUTPUT_ATLAS_PATH}...`);
  const atlasPng = new PNG({ width: atlasSize, height: atlasSize });
  atlasPng.data = Buffer.from(atlasData);
  
  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_ATLAS_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const buffer = PNG.sync.write(atlasPng);
  fs.writeFileSync(OUTPUT_ATLAS_PATH, buffer);
  
  // Save manifest
  console.log(`Saving manifest to ${OUTPUT_MANIFEST_PATH}...`);
  fs.writeFileSync(OUTPUT_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  
  console.log(`\n=== Complete ===`);
  console.log(`Atlas: ${atlasSize}x${atlasSize} (${(buffer.length / 1024).toFixed(1)} KB)`);
  console.log(`Textures: ${placements.length}`);
}

// Run
buildAtlas();
