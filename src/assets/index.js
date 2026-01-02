/**
 * Assets module - Block model, state, and texture management
 */

export { ModelResolver, getModelResolver } from './ModelResolver.js';
export { BlockstateResolver, getBlockstateResolver } from './BlockstateResolver.js';
export { ModelGeometry, getModelGeometry } from './ModelGeometry.js';
export { StateRegistry, getStateRegistry } from './StateRegistry.js';
export { 
  TexturePackManager, 
  getDefaultPackManager, 
  getCustomPackManager, 
  getActivePackManager,
  TEXTURE_MODE 
} from './TexturePackManager.js';
export { 
  TextureAtlas, 
  getTextureAtlas,
  DEFAULT_TEXTURE_SIZE,
  BORDER_SIZE,
} from './TextureAtlas.js';
export {
  RandomRotationRegistry,
  getRandomRotationRegistry,
  getPositionRotation,
} from './RandomRotationRegistry.js';

/**
 * Initialize all asset systems
 * Call once at app startup before loading any regions
 * @param {Object} options - { loadTextures: boolean, textureMode: string }
 */
export async function initAssets(options = {}) {
  const { loadTextures = false, textureMode = 'solid' } = options;
  
  const { getModelResolver } = await import('./ModelResolver.js');
  const { getBlockstateResolver } = await import('./BlockstateResolver.js');
  const { getStateRegistry } = await import('./StateRegistry.js');

  const modelResolver = getModelResolver();
  const blockstateResolver = getBlockstateResolver();
  const stateRegistry = getStateRegistry();

  // Initialize state registry with resolvers
  await stateRegistry.init();

  let textureAtlas = null;
  let packManager = null;
  
  // Load textures if requested
  if (loadTextures && textureMode !== 'solid') {
    const { getDefaultPackManager, getTextureAtlas } = await import('./TexturePackManager.js');
    const { getTextureAtlas: getAtlas } = await import('./TextureAtlas.js');
    
    packManager = getDefaultPackManager();
    await packManager.loadDefaultPack();
    
    textureAtlas = getAtlas();
    await textureAtlas.build(packManager);
  }

  console.log('[Assets] Initialized' + (loadTextures ? ' with textures' : ''));
  
  return {
    modelResolver,
    blockstateResolver,
    stateRegistry,
    textureAtlas,
    packManager,
  };
}

