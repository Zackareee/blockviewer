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
import { createParticleMaterial, createAdditiveParticleMaterial, updateParticleTime, updateParticleMaterialAtlas } from '../viewer/materials/ParticleMaterial.js';

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
    // Firefly-style wandering behavior
    this.randomMomentum = false;       // Whether to randomly change direction over time
    this.randomMomentumStrength = 0.05; // Max velocity magnitude
    this.randomMomentumBias = 0;       // Y velocity bias (positive = down, negative = up)
    this.wanderInterval = 0.5;         // How often to pick a new direction (seconds)
    this.wanderTimer = 0;              // Time since last direction change
    this.targetVx = 0;                 // Target velocity X
    this.targetVy = 0;                 // Target velocity Y
    this.targetVz = 0;                 // Target velocity Z
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
    this.randomMomentum = false;
    this.randomMomentumStrength = 0.05;
    this.randomMomentumBias = 0;
    this.wanderInterval = 0.5;
    this.wanderTimer = 0;
    this.targetVx = 0;
    this.targetVy = 0;
    this.targetVz = 0;
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
    
    // Pre-allocate sort array (reused each frame to avoid GC pressure)
    this._sortArray = new Array(maxParticles);
    this._sortArrayLength = 0;
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
   * Collect alive particles into pre-allocated array (avoids GC pressure)
   * @returns {number} Number of alive particles
   */
  collectAlive() {
    let count = 0;
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (p.state === PARTICLE_ALIVE) {
        this._sortArray[count++] = p;
      }
    }
    this._sortArrayLength = count;
    return count;
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
    
    // Pre-compute friction factor lookup (optimization: avoid Math.pow per particle)
    // Common friction values: 0.96, 0.98, 0.99, 0.995
    const frictionFactors = this._frictionFactors || (this._frictionFactors = {});
    
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (p.state !== PARTICLE_ALIVE) continue;
      
      // Apply gravity (accelerate downward)
      // MC gravity is applied per tick, so scale by ticksElapsed
      if (p.gravity !== 0 && !p.onGround) {
        p.vy -= p.gravity * ticksElapsed * 0.05; // Scale factor for visual match
      }
      
      // Firefly-style wandering behavior
      // Instead of jittery per-tick changes, pick a target velocity and smoothly accelerate toward it
      // Then periodically pick a new target direction for sustained flight
      if (p.randomMomentum) {
        p.wanderTimer += deltaTime;
        
        // Pick a new target direction periodically (adds randomness to interval too)
        if (p.wanderTimer >= p.wanderInterval) {
          p.wanderTimer = 0;
          // Randomize next interval slightly (0.5x to 1.5x base interval)
          p.wanderInterval = (0.3 + Math.random() * 0.6) * 1.0; // 0.3-0.9 seconds
          
          // Pick new target velocity within strength bounds
          const str = p.randomMomentumStrength;
          p.targetVx = (Math.random() * 2 - 1) * str;
          p.targetVy = (Math.random() * 2 - 1) * str * 0.5 + p.randomMomentumBias; // Y has bias
          p.targetVz = (Math.random() * 2 - 1) * str;
        }
        
        // Smoothly accelerate toward target velocity (lerp factor based on time)
        // Higher factor = faster turning, lower = more gradual
        const lerpFactor = Math.min(1.0, deltaTime * 3.0); // ~0.3 per frame at 10fps
        p.vx += (p.targetVx - p.vx) * lerpFactor;
        p.vy += (p.targetVy - p.vy) * lerpFactor;
        p.vz += (p.targetVz - p.vz) * lerpFactor;
      }
      
      // Store old position for collision resolution
      const oldX = p.x, oldY = p.y, oldZ = p.z;
      
      // Apply physics - velocity to position
      p.x += p.vx * deltaTime;
      p.y += p.vy * deltaTime;
      p.z += p.vz * deltaTime;
      
      // Collision detection (only for particles with physics enabled)
      // Grace period: don't check collisions for first 1.0 seconds
      // Optimization: Only check collisions for particles with significant velocity
      if (p.hasPhysics && collisionFn && p.age > 1.0 && 
          (Math.abs(p.vx) > 0.01 || Math.abs(p.vy) > 0.01 || Math.abs(p.vz) > 0.01)) {
        // Check if new position is inside a solid block
        if (collisionFn(p.x, p.y, p.z)) {
          // Simplified collision: just check Y first (most common case)
          if (collisionFn(oldX, p.y, oldZ)) {
            p.y = oldY;
            if (p.vy < 0) {
              p.onGround = true;
              p.vy = 0;
              p.vx *= 0.7;
              p.vz *= 0.7;
            } else {
              p.vy = 0;
            }
          } else {
            // Only check X/Z if Y didn't resolve it
            if (collisionFn(p.x, oldY, oldZ)) {
              p.x = oldX;
              p.vx = 0;
            }
            if (collisionFn(oldX, oldY, p.z)) {
              p.z = oldZ;
              p.vz = 0;
            }
          }
        } else if (p.onGround && p.vy !== 0) {
          p.onGround = false;
        }
      }
      
      // Apply friction (velocity decay per tick)
      if (p.friction < 1.0) {
        // Use cached friction factor if available (common values)
        const key = p.friction.toFixed(3);
        let frictionFactor = frictionFactors[key];
        if (frictionFactor === undefined) {
          frictionFactor = Math.pow(p.friction, ticksElapsed);
          frictionFactors[key] = frictionFactor;
        }
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
    
    // Optimization: sort every N frames (sorting is expensive for many particles)
    this.sortInterval = 3; // Sort every 3 frames
    this._sortFrame = 0;
    
    // Optimization: cache last camera position to skip sorting if camera hasn't moved much
    this._lastCamX = 0;
    this._lastCamY = 0;
    this._lastCamZ = 0;
    
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
      'end_rod', 'copper_flame', 'firefly'
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
    
    // Firefly-style wandering behavior
    particle.randomMomentum = options.randomMomentum ?? false;
    particle.randomMomentumStrength = options.randomMomentumStrength ?? 0.05;
    particle.randomMomentumBias = options.randomMomentumBias ?? 0;
    particle.wanderInterval = options.wanderInterval ?? 0.5;
    particle.wanderTimer = Math.random() * particle.wanderInterval; // Stagger initial timers
    // Initialize target velocity to current velocity for smooth start
    particle.targetVx = particle.vx;
    particle.targetVy = particle.vy;
    particle.targetVz = particle.vz;
    
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
        console.warn(`[ParticleSystem] No sprite data for particle type: ${type}, trying fallback`);
        this._missingTypes.add(type);
      }
      
      // Try to use 'flame' as fallback for additive particles, 'generic_0' for normal
      // This is better than index 0 which could be anything
      const ADDITIVE_PARTICLES = new Set([
        'flame', 'small_flame', 'soul_fire_flame', 'lava', 
        'end_rod', 'copper_flame', 'firefly'
      ]);
      const isAdditive = ADDITIVE_PARTICLES.has(type);
      const fallbackType = isAdditive ? 'flame' : 'generic_0';
      const fallbackData = this.particleAtlas?.getParticleUV?.(fallbackType);
      
      if (fallbackData) {
        particle.baseSpriteIndex = fallbackData.index;
        particle.spriteIndex = fallbackData.index;
        particle.frameCount = 1; // Don't use fallback's frame count
        particle.frameIndices = null;
      } else {
        // Last resort: use index 0
        particle.baseSpriteIndex = 0;
        particle.spriteIndex = 0;
        particle.frameCount = 1;
        particle.frameIndices = null;
      }
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
    // Use pre-allocated array to avoid GC pressure
    const count = pool.collectAlive();
    const aliveParticles = pool._sortArray;
    
    // Sort back-to-front (farthest first) for proper transparency
    // Optimization: Only sort every N frames and when camera has moved
    if (sortByDepth && camPos && count > 1) {
      this._sortFrame++;
      
      // Check if camera moved significantly (> 2 blocks)
      const camMoved = Math.abs(camPos.x - this._lastCamX) > 2 ||
                       Math.abs(camPos.y - this._lastCamY) > 2 ||
                       Math.abs(camPos.z - this._lastCamZ) > 2;
      
      // Sort only every N frames OR if camera moved significantly
      if (this._sortFrame >= this.sortInterval || camMoved) {
        this._sortFrame = 0;
        this._lastCamX = camPos.x;
        this._lastCamY = camPos.y;
        this._lastCamZ = camPos.z;
        
        // Sort only the alive portion of the array
        const camX = camPos.x, camY = camPos.y, camZ = camPos.z;
        const sortSlice = aliveParticles.slice(0, count);
        sortSlice.sort((a, b) => {
          const distA = (a.x - camX) ** 2 + (a.y - camY) ** 2 + (a.z - camZ) ** 2;
          const distB = (b.x - camX) ** 2 + (b.y - camY) ** 2 + (b.z - camZ) ** 2;
          return distB - distA; // Farthest first
        });
        // Copy back to pre-allocated array
        for (let i = 0; i < count; i++) {
          aliveParticles[i] = sortSlice[i];
        }
      }
    }
    
    // Write particles to buffers
    const posArr = buffers.position.array;
    const sizeArr = buffers.size.array;
    const ageArr = buffers.age.array;
    const spriteArr = buffers.spriteIndex.array;
    const colorArr = buffers.color.array;
    const alphaArr = buffers.alpha.array;
    
    for (let i = 0; i < count; i++) {
      const p = aliveParticles[i];
      const i3 = i * 3;
      
      // Position
      posArr[i3] = p.x;
      posArr[i3 + 1] = p.y;
      posArr[i3 + 2] = p.z;
      
      // Size
      sizeArr[i] = p.size;
      
      // Age (normalized)
      ageArr[i] = p.age / p.lifetime;
      
      // Sprite index
      spriteArr[i] = p.spriteIndex;
      
      // Color
      colorArr[i3] = p.r;
      colorArr[i3 + 1] = p.g;
      colorArr[i3 + 2] = p.b;
      
      // Alpha (use currentAlpha which includes fade calculations)
      alphaArr[i] = p.currentAlpha;
    }
    
    // Update buffer counts
    mesh.count = count;
    
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
   * Update ambient brightness for non-additive particles (darkens at night)
   * @param {Object} brightness - { r, g, b } values 0-1
   */
  setAmbientBrightness(brightness) {
    if (this.normalMaterial?.uniforms?.uAmbientBrightness) {
      this.normalMaterial.uniforms.uAmbientBrightness.value.set(brightness.r, brightness.g, brightness.b);
    }
    // Additive material doesn't use ambient brightness, but set it anyway in case shader is updated
    if (this.additiveMaterial?.uniforms?.uAmbientBrightness) {
      this.additiveMaterial.uniforms.uAmbientBrightness.value.set(brightness.r, brightness.g, brightness.b);
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
  
  /**
   * Update the particle atlas (for texture pack hotswapping)
   * Updates both materials with the new atlas data
   * Clears all existing particles since their sprite indices are no longer valid
   * @param {ParticleAtlas} newAtlas - The new particle texture atlas
   */
  setAtlas(newAtlas) {
    if (!newAtlas || !newAtlas.isBuilt) {
      console.warn('[ParticleSystem] setAtlas called with invalid atlas');
      return;
    }
    
    // IMPORTANT: Clear all existing particles before updating the atlas
    // Existing particles have sprite indices pointing to the OLD atlas layout.
    // After the atlas is rebuilt, those indices point to wrong textures.
    // Emitters will respawn particles with correct indices immediately.
    const oldNormalCount = this.normalPool.aliveCount;
    const oldAdditiveCount = this.additivePool.aliveCount;
    this.clear();
    
    this.particleAtlas = newAtlas;
    
    // Update existing materials if they exist
    if (this.normalMaterial) {
      updateParticleMaterialAtlas(this.normalMaterial, newAtlas);
    }
    if (this.additiveMaterial) {
      updateParticleMaterialAtlas(this.additiveMaterial, newAtlas);
    }
    
    // Clear missing types cache since new atlas may have different particles
    this._missingTypes = new Set();
    
    const materialData = newAtlas.getMaterialData();
    console.log(`[ParticleSystem] Atlas updated: cleared ${oldNormalCount + oldAdditiveCount} particles, ` +
      `${newAtlas.particleLookup?.size || 0} particle types, ` +
      `${materialData?.textureSize || '?'}x${materialData?.textureSize || '?'} resolution`);
  }
}

export default ParticleSystem;

