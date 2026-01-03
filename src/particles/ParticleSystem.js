/**
 * ParticleSystem - GPU-instanced particle manager
 * 
 * Features:
 * - Efficient GPU instancing with THREE.InstancedMesh
 * - Object pooling for particle recycling
 * - Multiple particle types with different blend modes
 * - Frustum culling and distance-based LOD
 * - Smooth animation and physics updates
 */

import * as THREE from 'three';
import { createParticleMaterial, createAdditiveParticleMaterial, updateParticleTime } from '../viewer/materials/ParticleMaterial.js';

// Maximum particles per type
const MAX_PARTICLES = 5000;

// Particle state constants
const PARTICLE_DEAD = 0;
const PARTICLE_ALIVE = 1;

/**
 * Single particle data structure
 */
class Particle {
  constructor() {
    this.state = PARTICLE_DEAD;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.size = 0.1;
    this.age = 0;
    this.lifetime = 1;
    this.spriteIndex = 0;      // Current sprite index for rendering
    this.baseSpriteIndex = 0;  // Base sprite index (first frame)
    this.frameCount = 1;
    this.frameIndices = null;  // For multi-file animations: array of frame indices
    this.r = 1;
    this.g = 1;
    this.b = 1;
    this.baseAlpha = 1;     // Original alpha (never modified during lifetime)
    this.currentAlpha = 1;  // Calculated alpha for rendering (includes fade)
    this.fadeIn = 0;
    this.fadeOut = 0.2;
    this.friction = 1.0;    // Velocity multiplier per tick (MC uses 0.96 for rising particles)
    this.gravity = 0;       // Downward acceleration (MC uses 0.75 for lava "sputtering")
    this.hasPhysics = true; // Whether particle collides with blocks (MC default: true)
    this.onGround = false;  // Whether particle landed on ground
  }
  
  reset() {
    this.state = PARTICLE_DEAD;
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.size = 0.1;
    this.age = 0;
    this.lifetime = 1;
    this.spriteIndex = 0;
    this.baseSpriteIndex = 0;
    this.frameCount = 1;
    this.frameIndices = null;
    this.r = this.g = this.b = 1;
    this.baseAlpha = 1;
    this.currentAlpha = 1;
    this.friction = 1.0;
    this.gravity = 0;
    this.hasPhysics = true;
    this.onGround = false;
  }
}

/**
 * ParticlePool - Manages a pool of particles for efficient reuse
 */
class ParticlePool {
  constructor(maxParticles = MAX_PARTICLES) {
    this.maxParticles = maxParticles;
    this.particles = [];
    this.aliveCount = 0;
    
    // Pre-allocate all particles
    for (let i = 0; i < maxParticles; i++) {
      this.particles.push(new Particle());
    }
  }
  
  /**
   * Get a dead particle for spawning
   * @returns {Particle|null}
   */
  spawn() {
    if (this.aliveCount >= this.maxParticles) {
      return null;
    }
    
    // Find a dead particle
    for (const p of this.particles) {
      if (p.state === PARTICLE_DEAD) {
        p.state = PARTICLE_ALIVE;
        this.aliveCount++;
        return p;
      }
    }
    
    return null;
  }
  
  /**
   * Kill a particle
   * @param {Particle} particle
   */
  kill(particle) {
    if (particle.state === PARTICLE_ALIVE) {
      particle.state = PARTICLE_DEAD;
      particle.reset();
      this.aliveCount--;
    }
  }
  
  /**
   * Update all alive particles
   * @param {number} deltaTime - Time since last update in seconds
   * @param {Function} updateFn - Custom update function (particle, dt) => boolean (false = kill)
   * @param {Function} collisionFn - Collision check (x, y, z) => boolean (true = solid block)
   */
  update(deltaTime, updateFn, collisionFn) {
    // Convert deltaTime to tick-equivalent for friction
    // MC runs at 20 ticks/sec, so we apply friction proportionally
    const ticksElapsed = deltaTime * 20;
    
    for (const p of this.particles) {
      if (p.state !== PARTICLE_ALIVE) continue;
      
      // Apply gravity (accelerate downward)
      // MC gravity is applied per tick, so scale by ticksElapsed
      if (p.gravity !== 0 && !p.onGround) {
        p.vy -= p.gravity * ticksElapsed * 0.05; // Scale factor for visual match
      }
      
      // Store old position for collision resolution
      const oldX = p.x, oldY = p.y, oldZ = p.z;
      
      // Apply physics - velocity to position
      p.x += p.vx * deltaTime;
      p.y += p.vy * deltaTime;
      p.z += p.vz * deltaTime;
      
      // Collision detection (only for particles with physics enabled)
      // Grace period: don't check collisions for first 0.3 seconds (lets particles escape spawn block)
      if (p.hasPhysics && collisionFn && p.age > 0.3) {
        // Check if new position is inside a solid block
        if (collisionFn(p.x, p.y, p.z)) {
          // Check which axis caused collision and resolve
          const collidesX = collisionFn(p.x, oldY, oldZ);
          const collidesY = collisionFn(oldX, p.y, oldZ);
          const collidesZ = collisionFn(oldX, oldY, p.z);
          
          if (collidesY) {
            // Vertical collision - most common (ground/ceiling)
            p.y = oldY;
            if (p.vy < 0) {
              // Hit ground - stop and mark as grounded
              p.onGround = true;
              p.vy = 0;
              p.vx *= 0.7; // Friction when on ground
              p.vz *= 0.7;
            } else {
              // Hit ceiling - just stop vertical motion
              p.vy = 0;
            }
          }
          if (collidesX) {
            p.x = oldX;
            p.vx = 0;
          }
          if (collidesZ) {
            p.z = oldZ;
            p.vz = 0;
          }
        } else {
          // No longer on ground if we moved
          if (p.onGround && p.vy !== 0) {
            p.onGround = false;
          }
        }
      }
      
      // Apply friction (velocity decay per tick)
      // For friction 0.96 and 1 tick: v *= 0.96
      // For fractional ticks, we use: v *= friction^ticksElapsed
      if (p.friction < 1.0) {
        const frictionFactor = Math.pow(p.friction, ticksElapsed);
        p.vx *= frictionFactor;
        p.vy *= frictionFactor;
        p.vz *= frictionFactor;
      }
      
      // Age the particle
      p.age += deltaTime;
      
      // Check if dead
      if (p.age >= p.lifetime) {
        this.kill(p);
        continue;
      }
      
      // Custom update
      if (updateFn && !updateFn(p, deltaTime)) {
        this.kill(p);
      }
    }
  }
  
  /**
   * Clear all particles
   */
  clear() {
    for (const p of this.particles) {
      p.reset();
    }
    this.aliveCount = 0;
  }
}

/**
 * ParticleSystem - Main particle manager
 */
export class ParticleSystem {
  /**
   * @param {ParticleAtlas} particleAtlas - The particle texture atlas
   */
  constructor(particleAtlas) {
    this.particleAtlas = particleAtlas;
    
    // Particle pools (one per blend mode)
    this.normalPool = new ParticlePool(MAX_PARTICLES);
    this.additivePool = new ParticlePool(MAX_PARTICLES);
    
    // THREE.js objects
    this.normalMesh = null;
    this.additiveMesh = null;
    this.normalMaterial = null;
    this.additiveMaterial = null;
    
    // Collision detection callback: (x, y, z) => boolean (true if solid block)
    this.collisionFn = null;
    this.group = new THREE.Group();
    this.group.name = 'ParticleSystem';
    this.group.renderOrder = 10; // Render after everything else
    
    // Instance attribute buffers
    this.normalBuffers = null;
    this.additiveBuffers = null;
    
    // Performance tracking
    this.lastUpdateTime = 0;
    this.updateCount = 0;
    
    // Debug logging
    console.log('[ParticleSystem] Constructor called with atlas:', particleAtlas ? 'yes' : 'no', 'isBuilt:', particleAtlas?.isBuilt);
    
    // Initialize if atlas is available
    if (particleAtlas && particleAtlas.isBuilt) {
      this._initialize();
    } else {
      console.warn('[ParticleSystem] Atlas not ready at construction time');
    }
  }
  
  /**
   * Initialize the particle system with GPU resources
   */
  _initialize() {
    // Create materials
    this.normalMaterial = createParticleMaterial(this.particleAtlas);
    this.additiveMaterial = createAdditiveParticleMaterial(this.particleAtlas);
    
    // Create SEPARATE quad geometries for each mesh type (critical - each needs its own instance buffers)
    const normalGeometry = new THREE.PlaneGeometry(1, 1);
    const additiveGeometry = new THREE.PlaneGeometry(1, 1);
    
    // Create instanced meshes with separate geometries
    this.normalMesh = this._createInstancedMesh(normalGeometry, this.normalMaterial, MAX_PARTICLES);
    this.additiveMesh = this._createInstancedMesh(additiveGeometry, this.additiveMaterial, MAX_PARTICLES);
    
    // Add to group
    this.group.add(this.normalMesh);
    this.group.add(this.additiveMesh);
    
    // Store buffer references
    this.normalBuffers = this._getBuffers(this.normalMesh);
    this.additiveBuffers = this._getBuffers(this.additiveMesh);
    
    console.log('[ParticleSystem] Initialized with', MAX_PARTICLES, 'max particles per type');
  }
  
  /**
   * Create an instanced mesh with custom attributes
   */
  _createInstancedMesh(geometry, material, maxInstances) {
    const mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
    mesh.frustumCulled = false; // Particles manage their own culling
    mesh.count = 0; // Start with no visible instances
    
    // Add instance attributes
    const instancePosition = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances * 3), 3
    );
    const instanceSize = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances), 1
    );
    const instanceAge = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances), 1
    );
    const instanceSpriteIndex = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances), 1
    );
    const instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances * 3), 3
    );
    const instanceAlpha = new THREE.InstancedBufferAttribute(
      new Float32Array(maxInstances), 1
    );
    
    geometry.setAttribute('instancePosition', instancePosition);
    geometry.setAttribute('instanceSize', instanceSize);
    geometry.setAttribute('instanceAge', instanceAge);
    geometry.setAttribute('instanceSpriteIndex', instanceSpriteIndex);
    geometry.setAttribute('instanceColor', instanceColor);
    geometry.setAttribute('instanceAlpha', instanceAlpha);
    
    return mesh;
  }
  
  /**
   * Get buffer references from mesh
   */
  _getBuffers(mesh) {
    const geom = mesh.geometry;
    return {
      position: geom.getAttribute('instancePosition'),
      size: geom.getAttribute('instanceSize'),
      age: geom.getAttribute('instanceAge'),
      spriteIndex: geom.getAttribute('instanceSpriteIndex'),
      color: geom.getAttribute('instanceColor'),
      alpha: geom.getAttribute('instanceAlpha'),
    };
  }
  
  /**
   * Spawn a particle
   * @param {string} type - Particle type ('flame', 'smoke', etc.)
   * @param {Object} options - Spawn options
   * @returns {Particle|null}
   */
  spawn(type, options = {}) {
    // Skip if not initialized
    if (!this.normalMesh || !this.additiveMesh) {
      console.warn('[ParticleSystem] Cannot spawn - not initialized');
      return null;
    }
    
    // Determine blend mode based on type - additive particles glow/emit light
    const ADDITIVE_PARTICLES = new Set([
      'flame', 'small_flame', 'soul_fire_flame', 'lava', 
      'end_rod', 'copper_flame'
    ]);
    const isAdditive = ADDITIVE_PARTICLES.has(type);
    const pool = isAdditive ? this.additivePool : this.normalPool;
    
    const particle = pool.spawn();
    if (!particle) return null;
    
    // Set position
    particle.x = options.x ?? 0;
    particle.y = options.y ?? 0;
    particle.z = options.z ?? 0;
    
    // Set velocity
    particle.vx = options.vx ?? 0;
    particle.vy = options.vy ?? 0;
    particle.vz = options.vz ?? 0;
    
    // Set properties
    particle.size = options.size ?? 0.1;
    particle.lifetime = options.lifetime ?? 1;
    particle.r = options.r ?? 1;
    particle.g = options.g ?? 1;
    particle.b = options.b ?? 1;
    particle.baseAlpha = options.alpha ?? 1;
    particle.currentAlpha = particle.baseAlpha;
    particle.fadeIn = options.fadeIn ?? 0;
    particle.fadeOut = options.fadeOut ?? 0.2;
    particle.friction = options.friction ?? 1.0;
    particle.gravity = options.gravity ?? 0;  // Downward acceleration (MC lava uses 0.75)
    particle.hasPhysics = options.hasPhysics ?? true;  // MC default: collides with blocks
    particle.onGround = false;
    
    // Get sprite info from atlas
    const spriteData = this.particleAtlas?.getParticleUV?.(type);
    if (spriteData) {
      particle.baseSpriteIndex = spriteData.index;
      particle.spriteIndex = spriteData.index;
      particle.frameCount = spriteData.frameCount;
      // Store frame indices for multi-file animations
      particle.frameIndices = spriteData.frameIndices || null;
    } else {
      // Debug: log when sprite not found (only once per type)
      if (!this._missingTypes) this._missingTypes = new Set();
      if (!this._missingTypes.has(type)) {
        console.warn(`[ParticleSystem] No sprite data for particle type: ${type}, using fallback`);
        this._missingTypes.add(type);
      }
      particle.baseSpriteIndex = 0;
      particle.spriteIndex = 0;
      particle.frameCount = 1;
      particle.frameIndices = null;
    }
    
    // Debug: log first particle creation
    if (!this._loggedFirstParticle) {
      console.log(`[ParticleSystem] First particle spawned: type=${type} at ${options.x?.toFixed(1)},${options.y?.toFixed(1)},${options.z?.toFixed(1)} size=${particle.size} sprite=${particle.spriteIndex}`);
      this._loggedFirstParticle = true;
    }
    
    return particle;
  }
  
  /**
   * Update all particles
   * @param {number} deltaTime - Time since last update in seconds
   * @param {number} time - Total elapsed time in seconds
   * @param {THREE.Camera} camera - Camera for depth sorting
   */
  update(deltaTime, time, camera) {
    // Skip if not initialized
    if (!this.normalMesh || !this.additiveMesh) return;
    
    // Update material time
    updateParticleTime(this.normalMaterial, time);
    updateParticleTime(this.additiveMaterial, time);
    
    // Early exit if no particles are alive (performance optimization)
    const normalAlive = this.normalPool.aliveCount;
    const additiveAlive = this.additivePool.aliveCount;
    
    if (normalAlive === 0 && additiveAlive === 0) {
      // Ensure mesh counts are 0 (only need to set once when transitioning to 0)
      if (this.normalMesh.count !== 0) this.normalMesh.count = 0;
      if (this.additiveMesh.count !== 0) this.additiveMesh.count = 0;
      return;
    }
    
    // Get camera position for depth sorting
    const camPos = camera ? camera.position : null;
    
    // Update particle pools with physics
    if (normalAlive > 0) this._updatePool(this.normalPool, deltaTime);
    if (additiveAlive > 0) this._updatePool(this.additivePool, deltaTime);
    
    // Sync buffers with depth sorting (back-to-front for proper transparency)
    // Only sort normal pool (smoke, etc.) - additive blending is order-independent
    if (normalAlive > 0 || this.normalMesh.count > 0) {
      this._syncBuffers(this.normalPool, this.normalMesh, this.normalBuffers, camPos, true);
    }
    if (additiveAlive > 0 || this.additiveMesh.count > 0) {
      this._syncBuffers(this.additivePool, this.additiveMesh, this.additiveBuffers, camPos, false);
    }
    
    this.updateCount++;
    
    // Debug: log particle counts periodically (every ~5 seconds)
    if (this.updateCount % 300 === 1 && (normalAlive > 0 || additiveAlive > 0)) {
      console.log(`[ParticleSystem] Active: ${normalAlive} normal, ${additiveAlive} additive, mesh counts: ${this.normalMesh?.count || 0}/${this.additiveMesh?.count || 0}`);
    }
  }
  
  /**
   * Set the collision detection function
   * @param {Function} fn - (x, y, z) => boolean (true if position is inside a solid block)
   */
  setCollisionFunction(fn) {
    this.collisionFn = fn;
  }
  
  /**
   * Update a particle pool
   */
  _updatePool(pool, deltaTime) {
    pool.update(deltaTime, (p, dt) => {
      // Calculate current alpha with fade in/out
      // Use baseAlpha as the starting point (never modify baseAlpha!)
      const ageNorm = p.age / p.lifetime;
      let alpha = p.baseAlpha;
      
      // Fade in (during first fadeIn% of lifetime)
      if (p.fadeIn > 0 && ageNorm < p.fadeIn) {
        alpha *= ageNorm / p.fadeIn;
      }
      
      // Fade out (during last fadeOut% of lifetime)
      if (p.fadeOut > 0 && ageNorm > (1 - p.fadeOut)) {
        const fadeProgress = (ageNorm - (1 - p.fadeOut)) / p.fadeOut;
        alpha *= 1 - fadeProgress;
      }
      
      // Store calculated alpha in currentAlpha for rendering
      p.currentAlpha = alpha;
      
      // Update sprite frame for animated particles
      if (p.frameCount > 1) {
        const frameProgress = ageNorm * p.frameCount;
        const currentFrame = Math.min(Math.floor(frameProgress), p.frameCount - 1);
        
        // Use frame indices array for multi-file animations, otherwise sequential
        if (p.frameIndices && p.frameIndices.length > 0) {
          p.spriteIndex = p.frameIndices[currentFrame];
        } else {
          p.spriteIndex = p.baseSpriteIndex + currentFrame;
        }
      }
      
      return true;
    }, this.collisionFn); // Pass collision function for block collisions
  }
  
  /**
   * Sync particle pool data to GPU buffers
   * @param {ParticlePool} pool - Particle pool to sync
   * @param {THREE.InstancedMesh} mesh - Instanced mesh to update
   * @param {Object} buffers - GPU attribute buffers
   * @param {THREE.Vector3|null} camPos - Camera position for sorting
   * @param {boolean} sortByDepth - Whether to sort particles back-to-front
   */
  _syncBuffers(pool, mesh, buffers, camPos, sortByDepth) {
    // Collect alive particles
    const aliveParticles = [];
    for (const p of pool.particles) {
      if (p.state === PARTICLE_ALIVE) {
        aliveParticles.push(p);
      }
    }
    
    // Sort back-to-front (farthest first) for proper transparency
    // Only sort if we have camera position and sorting is enabled
    if (sortByDepth && camPos && aliveParticles.length > 1) {
      aliveParticles.sort((a, b) => {
        const distA = (a.x - camPos.x) ** 2 + (a.y - camPos.y) ** 2 + (a.z - camPos.z) ** 2;
        const distB = (b.x - camPos.x) ** 2 + (b.y - camPos.y) ** 2 + (b.z - camPos.z) ** 2;
        return distB - distA; // Farthest first
      });
    }
    
    // Write sorted particles to buffers
    for (let i = 0; i < aliveParticles.length; i++) {
      const p = aliveParticles[i];
      
      // Position
      buffers.position.array[i * 3] = p.x;
      buffers.position.array[i * 3 + 1] = p.y;
      buffers.position.array[i * 3 + 2] = p.z;
      
      // Size
      buffers.size.array[i] = p.size;
      
      // Age (normalized)
      buffers.age.array[i] = p.age / p.lifetime;
      
      // Sprite index
      buffers.spriteIndex.array[i] = p.spriteIndex;
      
      // Color
      buffers.color.array[i * 3] = p.r;
      buffers.color.array[i * 3 + 1] = p.g;
      buffers.color.array[i * 3 + 2] = p.b;
      
      // Alpha (use currentAlpha which includes fade calculations)
      buffers.alpha.array[i] = p.currentAlpha;
    }
    
    // Update buffer counts
    mesh.count = aliveParticles.length;
    
    // Mark buffers as needing update
    buffers.position.needsUpdate = true;
    buffers.size.needsUpdate = true;
    buffers.age.needsUpdate = true;
    buffers.spriteIndex.needsUpdate = true;
    buffers.color.needsUpdate = true;
    buffers.alpha.needsUpdate = true;
  }
  
  /**
   * Get the THREE.Group containing particle meshes
   */
  getGroup() {
    return this.group;
  }
  
  /**
   * Get particle count
   */
  getParticleCount() {
    return this.normalPool.aliveCount + this.additivePool.aliveCount;
  }
  
  /**
   * Update fog parameters
   * @param {Object} params - { color, start, end, enabled }
   */
  setFog(params) {
    if (this.normalMaterial?.uniforms) {
      if (params.color) this.normalMaterial.uniforms.uFogColor.value.set(params.color);
      if (params.start !== undefined) this.normalMaterial.uniforms.uFogStart.value = params.start;
      if (params.end !== undefined) this.normalMaterial.uniforms.uFogEnd.value = params.end;
      if (params.enabled !== undefined) this.normalMaterial.uniforms.uFogEnabled.value = params.enabled ? 1 : 0;
    }
    if (this.additiveMaterial?.uniforms) {
      if (params.color) this.additiveMaterial.uniforms.uFogColor.value.set(params.color);
      if (params.start !== undefined) this.additiveMaterial.uniforms.uFogStart.value = params.start;
      if (params.end !== undefined) this.additiveMaterial.uniforms.uFogEnd.value = params.end;
      if (params.enabled !== undefined) this.additiveMaterial.uniforms.uFogEnabled.value = params.enabled ? 1 : 0;
    }
  }
  
  /**
   * Clear all particles
   */
  clear() {
    this.normalPool.clear();
    this.additivePool.clear();
    
    if (this.normalMesh) this.normalMesh.count = 0;
    if (this.additiveMesh) this.additiveMesh.count = 0;
  }
  
  /**
   * Dispose of all resources
   */
  dispose() {
    this.clear();
    
    if (this.normalMesh) {
      this.normalMesh.geometry.dispose();
      this.group.remove(this.normalMesh);
    }
    if (this.additiveMesh) {
      this.additiveMesh.geometry.dispose();
      this.group.remove(this.additiveMesh);
    }
    if (this.normalMaterial) {
      this.normalMaterial.dispose();
    }
    if (this.additiveMaterial) {
      this.additiveMaterial.dispose();
    }
    
    this.normalMesh = null;
    this.additiveMesh = null;
    this.normalMaterial = null;
    this.additiveMaterial = null;
  }
}

export default ParticleSystem;

