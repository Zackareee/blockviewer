/**
 * EntitySystem - Manages and renders Minecraft entities
 * 
 * Entities are non-block objects in the world like item frames, paintings, 
 * armor stands, etc. Unlike blocks which are part of the chunk grid, entities
 * have precise floating-point positions and orientations.
 * 
 * Currently supported entity types:
 * - item_frame / glow_item_frame
 * - painting (TODO)
 * - armor_stand (TODO)
 * 
 * Entity data structure:
 * - id: Entity type (e.g., "minecraft:item_frame")
 * - Pos: [x, y, z] position
 * - Rotation: [yaw, pitch] in degrees
 * - Facing: Direction index (0=down, 1=up, 2=north, 3=south, 4=west, 5=east)
 * - Item: Item in the frame (for item frames)
 * - ItemRotation: Item rotation in frame (0-7, each step is 45 degrees)
 */

import * as THREE from 'three';

// Direction enum matching Minecraft's Direction ordinal
export const Direction = {
  DOWN: 0,
  UP: 1,
  NORTH: 2,
  SOUTH: 3,
  WEST: 4,
  EAST: 5,
};

// Direction vectors for offset calculation
const DIRECTION_VECTORS = {
  [Direction.DOWN]: [0, -1, 0],
  [Direction.UP]: [0, 1, 0],
  [Direction.NORTH]: [0, 0, -1],
  [Direction.SOUTH]: [0, 0, 1],
  [Direction.WEST]: [-1, 0, 0],
  [Direction.EAST]: [1, 0, 0],
};

// Rotation to apply for each facing direction (in Minecraft model space)
// Item frames use facing direction to determine their orientation
const DIRECTION_ROTATIONS = {
  [Direction.DOWN]: { x: -90, y: 0 },
  [Direction.UP]: { x: 90, y: 0 },
  [Direction.NORTH]: { x: 0, y: 0 },
  [Direction.SOUTH]: { x: 0, y: 180 },
  [Direction.WEST]: { x: 0, y: 90 },
  [Direction.EAST]: { x: 0, y: -90 },
};

/**
 * EntitySystem - Core class for entity management and rendering
 */
export class EntitySystem {
  constructor() {
    // Entity storage by type
    this.entities = new Map(); // Map<string, Entity[]>
    
    // Three.js group for all entity meshes
    this.group = new THREE.Group();
    this.group.name = 'Entities';
    
    // References to asset systems (set during initialization)
    this.modelResolver = null;
    this.modelGeometry = null;
    this.textureAtlas = null;
    this.material = null;
    
    // Mesh cache for entity models
    this.meshCache = new Map(); // Map<cacheKey, THREE.BufferGeometry>
    
    // Stats
    this.totalEntities = 0;
  }
  
  /**
   * Initialize the entity system with asset references
   * @param {Object} options - Configuration options
   * @param {ModelResolver} options.modelResolver - Model resolver instance
   * @param {ModelGeometry} options.modelGeometry - Model geometry processor
   * @param {TextureAtlas} options.textureAtlas - Texture atlas
   * @param {THREE.Material} options.material - Material to use for entities
   */
  init(options = {}) {
    this.modelResolver = options.modelResolver || null;
    this.modelGeometry = options.modelGeometry || null;
    this.textureAtlas = options.textureAtlas || null;
    this.material = options.material || null;
    
    console.log('[EntitySystem] Initialized');
  }
  
  /**
   * Add an entity to the system
   * @param {Object} entityData - Entity NBT data
   */
  addEntity(entityData) {
    const id = (entityData.id || '').replace('minecraft:', '');
    
    if (!this.entities.has(id)) {
      this.entities.set(id, []);
    }
    
    this.entities.get(id).push(entityData);
    this.totalEntities++;
  }
  
  /**
   * Add multiple entities at once
   * @param {Array} entities - Array of entity NBT data
   */
  addEntities(entities) {
    for (const entity of entities) {
      this.addEntity(entity);
    }
  }
  
  /**
   * Clear all entities
   */
  clear() {
    this.entities.clear();
    this.totalEntities = 0;
    
    // Clear meshes from group
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
    }
  }
  
  /**
   * Build meshes for all entities
   * Must be called after entities are added and system is initialized
   */
  async buildMeshes() {
    if (!this.modelResolver || !this.modelGeometry) {
      console.warn('[EntitySystem] Cannot build meshes - system not initialized');
      return;
    }
    
    // Clear existing meshes
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
    }
    
    // Process item frames
    await this._buildItemFrameMeshes();
    
    console.log(`[EntitySystem] Built meshes for ${this.totalEntities} entities`);
  }
  
  /**
   * Build meshes for item frame entities
   */
  async _buildItemFrameMeshes() {
    const itemFrames = this.entities.get('item_frame') || [];
    const glowItemFrames = this.entities.get('glow_item_frame') || [];
    const allFrames = [...itemFrames, ...glowItemFrames];
    
    if (allFrames.length === 0) return;
    
    console.log(`[EntitySystem] Building ${allFrames.length} item frame meshes`);
    
    // Load item frame model
    const frameModel = await this.modelResolver.resolve('block/item_frame');
    if (!frameModel) {
      console.warn('[EntitySystem] Failed to load item_frame model');
      return;
    }
    
    // Get base geometry (no rotation)
    const baseGeometry = this.modelGeometry.getGeometry(frameModel, 0, 0, 'block/item_frame', false);
    if (!baseGeometry) {
      console.warn('[EntitySystem] Failed to get item_frame geometry');
      return;
    }
    
    // Batch all item frame vertices into a single geometry for performance
    const allPositions = [];
    const allNormals = [];
    const allUvs = [];
    const allColors = [];
    const allIndices = [];
    let indexOffset = 0;
    
    for (const frame of allFrames) {
      // Get position
      const pos = frame.Pos || [0, 0, 0];
      const x = typeof pos[0] === 'object' ? pos[0][0] : pos[0]; // Handle NBT long array
      const y = typeof pos[1] === 'object' ? pos[1][0] : pos[1];
      const z = typeof pos[2] === 'object' ? pos[2][0] : pos[2];
      
      // Get facing direction (default to SOUTH which is facing player in most cases)
      const facing = frame.Facing ?? frame.facing ?? Direction.SOUTH;
      
      // Get rotation values for this facing
      const rotation = DIRECTION_ROTATIONS[facing] || DIRECTION_ROTATIONS[Direction.SOUTH];
      
      // Get geometry for this rotation
      const rotatedGeom = this.modelGeometry.getGeometry(
        frameModel, 
        rotation.x, 
        rotation.y, 
        `block/item_frame_facing_${facing}`,
        false
      );
      
      if (!rotatedGeom || !rotatedGeom.positions) continue;
      
      // Calculate offset for this facing (item frame attaches to block in opposite direction)
      const dirVec = DIRECTION_VECTORS[facing] || [0, 0, 1];
      const offsetX = -dirVec[0] * 0.5;
      const offsetY = -dirVec[1] * 0.5;
      const offsetZ = -dirVec[2] * 0.5;
      
      // Add transformed vertices
      for (let i = 0; i < rotatedGeom.positions.length; i += 3) {
        // Vertex positions are in 0-16 block space, convert to world space
        allPositions.push(
          x + offsetX + rotatedGeom.positions[i] / 16,
          y + offsetY + rotatedGeom.positions[i + 1] / 16,
          z + offsetZ + rotatedGeom.positions[i + 2] / 16
        );
      }
      
      // Copy normals
      if (rotatedGeom.normals) {
        allNormals.push(...rotatedGeom.normals);
      }
      
      // Copy UVs
      if (rotatedGeom.uvs) {
        allUvs.push(...rotatedGeom.uvs);
      }
      
      // Add vertex colors (white for now - will use lighting later)
      const vertexCount = rotatedGeom.positions.length / 3;
      for (let i = 0; i < vertexCount; i++) {
        allColors.push(1, 1, 1);
      }
      
      // Copy indices with offset
      if (rotatedGeom.indices) {
        for (const idx of rotatedGeom.indices) {
          allIndices.push(idx + indexOffset);
        }
        indexOffset += vertexCount;
      }
    }
    
    if (allPositions.length === 0) return;
    
    // Create Three.js geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3));
    
    if (allNormals.length > 0) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(allNormals, 3));
    }
    
    if (allUvs.length > 0) {
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(allUvs, 2));
    }
    
    if (allColors.length > 0) {
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(allColors, 3));
    }
    
    if (allIndices.length > 0) {
      geometry.setIndex(allIndices);
    }
    
    geometry.computeBoundingSphere();
    
    // Create mesh
    const material = this.material || new THREE.MeshBasicMaterial({ 
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'ItemFrames';
    mesh.frustumCulled = true;
    
    this.group.add(mesh);
    
    console.log(`[EntitySystem] Created item frame mesh with ${allPositions.length / 3} vertices`);
  }
  
  /**
   * Update the system (called each frame for animations)
   * @param {number} delta - Time since last frame in seconds
   */
  update(delta) {
    // Future: Animate entities if needed
  }
  
  /**
   * Dispose of all resources
   */
  dispose() {
    this.clear();
    this.meshCache.clear();
  }
  
  /**
   * Get statistics about the entity system
   */
  getStats() {
    const stats = {
      totalEntities: this.totalEntities,
      byType: {},
      meshCount: this.group.children.length,
    };
    
    for (const [type, entities] of this.entities) {
      stats.byType[type] = entities.length;
    }
    
    return stats;
  }
}

// Singleton instance
let entitySystemInstance = null;

/**
 * Get the global entity system instance
 */
export function getEntitySystem() {
  if (!entitySystemInstance) {
    entitySystemInstance = new EntitySystem();
  }
  return entitySystemInstance;
}

/**
 * Create a new entity system instance (useful for testing)
 */
export function createEntitySystem() {
  return new EntitySystem();
}

