/**
 * Assets module - Block model and state management
 */

export { ModelResolver, getModelResolver } from './ModelResolver.js';
export { BlockstateResolver, getBlockstateResolver } from './BlockstateResolver.js';
export { ModelGeometry, getModelGeometry } from './ModelGeometry.js';
export { StateRegistry, getStateRegistry } from './StateRegistry.js';

/**
 * Initialize all asset systems
 * Call once at app startup before loading any regions
 */
export async function initAssets() {
  const { getModelResolver } = await import('./ModelResolver.js');
  const { getBlockstateResolver } = await import('./BlockstateResolver.js');
  const { getStateRegistry } = await import('./StateRegistry.js');

  const modelResolver = getModelResolver();
  const blockstateResolver = getBlockstateResolver();
  const stateRegistry = getStateRegistry();

  // Initialize state registry with resolvers
  await stateRegistry.init();

  console.log('[Assets] Initialized');
  
  return {
    modelResolver,
    blockstateResolver,
    stateRegistry,
  };
}

