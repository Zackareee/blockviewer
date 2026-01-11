/**
 * SharedParticlePool - SharedArrayBuffer-backed particle storage
 * 
 * Uses SharedArrayBuffer for zero-copy sharing with ParticleWorker.
 * Physics updates happen in worker, rendering data is read on main thread.
 * 
 * Hybrid approach: SAB stores physics data, JS objects store rendering data
 * (color, alpha, sprite animation). This keeps the worker simple while
 * still offloading the heavy physics work.
 */

// Particle data layout (must match ParticleWorker.js)
export const PARTICLE_DEAD = 0;
export const PARTICLE_ALIVE = 1;

export const FLAG_HAS_PHYSICS = 1;
export const FLAG_ON_GROUND = 2;
export const FLAG_RANDOM_MOMENTUM = 4;

export const OFFSET_X = 0;
export const OFFSET_Y = 1;
export const OFFSET_Z = 2;
export const OFFSET_VX = 3;
export const OFFSET_VY = 4;
export const OFFSET_VZ = 5;
export const OFFSET_AGE = 6;
export const OFFSET_LIFETIME = 7;
export const OFFSET_SIZE = 8;
export const OFFSET_FRICTION = 9;
export const OFFSET_GRAVITY = 10;
export const OFFSET_STATE_FLAGS = 11;

export const FLOATS_PER_PARTICLE = 12;
export const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4; // 48 bytes

/**
 * Rendering data stored in JS (not in SharedArrayBuffer)
 * These don't need to be in SAB since worker doesn't touch them
 */
class ParticleRenderData {
  constructor() {
    this.spriteIndex = 0;
    this.baseSpriteIndex = 0;
    this.frameCount = 1;
    this.frameIndices = null;
    this.r = 1;
    this.g = 1;
    this.b = 1;
    this.baseAlpha = 1;
    this.currentAlpha = 1;
    this.fadeIn = 0;
    this.fadeOut = 0.2;
  }
  
  reset() {
    this.spriteIndex = 0;
    this.baseSpriteIndex = 0;
    this.frameCount = 1;
    this.frameIndices = null;
    this.r = this.g = this.b = 1;
    this.baseAlpha = 1;
    this.currentAlpha = 1;
    this.fadeIn = 0;
    this.fadeOut = 0.2;
  }
}

/**
 * SharedParticlePool - Manages particles with SharedArrayBuffer physics
 */
export class SharedParticlePool {
  constructor(maxParticles) {
    this.maxParticles = maxParticles;
    this.aliveCount = 0;
    
    // Check for SharedArrayBuffer support
    this.useSharedMemory = typeof SharedArrayBuffer !== 'undefined';
    
    if (this.useSharedMemory) {
      // Create SharedArrayBuffer for physics data
      this.buffer = new SharedArrayBuffer(maxParticles * BYTES_PER_PARTICLE);
      this.data = new Float32Array(this.buffer);
      this.stateView = new Uint32Array(this.buffer);
    } else {
      // Fallback to regular ArrayBuffer (no worker support)
      this.buffer = new ArrayBuffer(maxParticles * BYTES_PER_PARTICLE);
      this.data = new Float32Array(this.buffer);
      this.stateView = new Uint32Array(this.buffer);
      console.warn('[SharedParticlePool] SharedArrayBuffer not available, using fallback');
    }
    
    // Rendering data (stays in JS)
    this.renderData = [];
    for (let i = 0; i < maxParticles; i++) {
      this.renderData.push(new ParticleRenderData());
    }
    
    // Pre-allocate sort array
    this._sortIndices = new Uint16Array(maxParticles);
    this._sortDistances = new Float32Array(maxParticles);
    
    // Initialize all particles as dead
    for (let i = 0; i < maxParticles; i++) {
      const stateIdx = i * FLOATS_PER_PARTICLE + OFFSET_STATE_FLAGS;
      this.data[stateIdx] = 0;
    }
  }
  
  /**
   * Get SharedArrayBuffer for worker (if available)
   */
  getBuffer() {
    return this.useSharedMemory ? this.buffer : null;
  }
  
  /**
   * Spawn a new particle
   * @returns {number} Particle index or -1 if pool is full
   */
  spawn() {
    if (this.aliveCount >= this.maxParticles) {
      return -1;
    }
    
    // Find a dead particle
    for (let i = 0; i < this.maxParticles; i++) {
      const stateIdx = i * FLOATS_PER_PARTICLE + OFFSET_STATE_FLAGS;
      const stateFlags = this.stateView[stateIdx];
      const state = stateFlags & 0xFF;
      
      if (state === PARTICLE_DEAD) {
        // Mark as alive with default flags (hasPhysics = true)
        this.stateView[stateIdx] = PARTICLE_ALIVE | (FLAG_HAS_PHYSICS << 8);
        this.aliveCount++;
        
        // Reset render data
        this.renderData[i].reset();
        
        return i;
      }
    }
    
    return -1;
  }
  
  /**
   * Set particle physics data
   */
  setPhysics(index, x, y, z, vx, vy, vz, lifetime, size, friction, gravity, hasPhysics = true) {
    const baseIdx = index * FLOATS_PER_PARTICLE;
    
    this.data[baseIdx + OFFSET_X] = x;
    this.data[baseIdx + OFFSET_Y] = y;
    this.data[baseIdx + OFFSET_Z] = z;
    this.data[baseIdx + OFFSET_VX] = vx;
    this.data[baseIdx + OFFSET_VY] = vy;
    this.data[baseIdx + OFFSET_VZ] = vz;
    this.data[baseIdx + OFFSET_AGE] = 0;
    this.data[baseIdx + OFFSET_LIFETIME] = lifetime;
    this.data[baseIdx + OFFSET_SIZE] = size;
    this.data[baseIdx + OFFSET_FRICTION] = friction;
    this.data[baseIdx + OFFSET_GRAVITY] = gravity;
    
    // Update flags
    const stateIdx = baseIdx + OFFSET_STATE_FLAGS;
    let flags = hasPhysics ? FLAG_HAS_PHYSICS : 0;
    this.stateView[stateIdx] = PARTICLE_ALIVE | (flags << 8);
  }
  
  /**
   * Set particle rendering data
   */
  setRenderData(index, r, g, b, alpha, fadeIn, fadeOut, spriteIndex, frameCount, frameIndices = null) {
    const rd = this.renderData[index];
    rd.r = r;
    rd.g = g;
    rd.b = b;
    rd.baseAlpha = alpha;
    rd.currentAlpha = alpha;
    rd.fadeIn = fadeIn;
    rd.fadeOut = fadeOut;
    rd.baseSpriteIndex = spriteIndex;
    rd.spriteIndex = spriteIndex;
    rd.frameCount = frameCount;
    rd.frameIndices = frameIndices;
  }
  
  /**
   * Get particle position
   */
  getPosition(index) {
    const baseIdx = index * FLOATS_PER_PARTICLE;
    return {
      x: this.data[baseIdx + OFFSET_X],
      y: this.data[baseIdx + OFFSET_Y],
      z: this.data[baseIdx + OFFSET_Z],
    };
  }
  
  /**
   * Get particle state
   */
  getState(index) {
    const stateIdx = index * FLOATS_PER_PARTICLE + OFFSET_STATE_FLAGS;
    return this.stateView[stateIdx] & 0xFF;
  }
  
  /**
   * Get particle age/lifetime
   */
  getAge(index) {
    const baseIdx = index * FLOATS_PER_PARTICLE;
    return {
      age: this.data[baseIdx + OFFSET_AGE],
      lifetime: this.data[baseIdx + OFFSET_LIFETIME],
    };
  }
  
  /**
   * Get particle size
   */
  getSize(index) {
    return this.data[index * FLOATS_PER_PARTICLE + OFFSET_SIZE];
  }
  
  /**
   * Update rendering calculations (alpha, sprite frame)
   * Call after physics tick
   */
  updateRenderData() {
    this.aliveCount = 0;
    
    for (let i = 0; i < this.maxParticles; i++) {
      const stateIdx = i * FLOATS_PER_PARTICLE + OFFSET_STATE_FLAGS;
      const state = this.stateView[stateIdx] & 0xFF;
      
      if (state !== PARTICLE_ALIVE) continue;
      
      this.aliveCount++;
      
      const baseIdx = i * FLOATS_PER_PARTICLE;
      const age = this.data[baseIdx + OFFSET_AGE];
      const lifetime = this.data[baseIdx + OFFSET_LIFETIME];
      const ageNorm = age / lifetime;
      
      const rd = this.renderData[i];
      
      // Calculate alpha with fade in/out
      let alpha = rd.baseAlpha;
      
      if (rd.fadeIn > 0 && ageNorm < rd.fadeIn) {
        alpha *= ageNorm / rd.fadeIn;
      }
      
      if (rd.fadeOut > 0 && ageNorm > (1 - rd.fadeOut)) {
        const fadeProgress = (ageNorm - (1 - rd.fadeOut)) / rd.fadeOut;
        alpha *= 1 - fadeProgress;
      }
      
      rd.currentAlpha = alpha;
      
      // Update sprite frame for animated particles
      if (rd.frameCount > 1) {
        const frameProgress = ageNorm * rd.frameCount;
        const currentFrame = Math.min(Math.floor(frameProgress), rd.frameCount - 1);
        
        if (rd.frameIndices && rd.frameIndices.length > 0) {
          rd.spriteIndex = rd.frameIndices[currentFrame];
        } else {
          rd.spriteIndex = rd.baseSpriteIndex + currentFrame;
        }
      }
    }
  }
  
  /**
   * Fallback physics update (when worker not available)
   */
  updatePhysicsFallback(deltaTime) {
    for (let i = 0; i < this.maxParticles; i++) {
      const stateIdx = i * FLOATS_PER_PARTICLE + OFFSET_STATE_FLAGS;
      const stateFlags = this.stateView[stateIdx];
      const state = stateFlags & 0xFF;
      
      if (state !== PARTICLE_ALIVE) continue;
      
      const baseIdx = i * FLOATS_PER_PARTICLE;
      
      // Update age
      let age = this.data[baseIdx + OFFSET_AGE];
      age += deltaTime;
      const lifetime = this.data[baseIdx + OFFSET_LIFETIME];
      
      // Check expiration
      if (age >= lifetime) {
        this.stateView[stateIdx] = 0; // Kill
        continue;
      }
      
      const flags = (stateFlags >> 8) & 0xFF;
      const onGround = (flags & FLAG_ON_GROUND) !== 0;
      
      if (!onGround) {
        const friction = this.data[baseIdx + OFFSET_FRICTION];
        const gravity = this.data[baseIdx + OFFSET_GRAVITY];
        
        let vx = this.data[baseIdx + OFFSET_VX];
        let vy = this.data[baseIdx + OFFSET_VY];
        let vz = this.data[baseIdx + OFFSET_VZ];
        
        // Apply gravity
        vy -= gravity * deltaTime;
        
        // Apply friction
        const frictionFactor = Math.pow(friction, deltaTime * 20);
        vx *= frictionFactor;
        vy *= frictionFactor;
        vz *= frictionFactor;
        
        // Update position
        this.data[baseIdx + OFFSET_X] += vx * deltaTime;
        this.data[baseIdx + OFFSET_Y] += vy * deltaTime;
        this.data[baseIdx + OFFSET_Z] += vz * deltaTime;
        
        this.data[baseIdx + OFFSET_VX] = vx;
        this.data[baseIdx + OFFSET_VY] = vy;
        this.data[baseIdx + OFFSET_VZ] = vz;
      }
      
      this.data[baseIdx + OFFSET_AGE] = age;
    }
  }
  
  /**
   * Collect alive particle indices sorted by distance (back to front)
   */
  collectAlive(camX, camY, camZ, doSort = true) {
    let count = 0;
    
    for (let i = 0; i < this.maxParticles; i++) {
      const stateIdx = i * FLOATS_PER_PARTICLE + OFFSET_STATE_FLAGS;
      const state = this.stateView[stateIdx] & 0xFF;
      
      if (state === PARTICLE_ALIVE) {
        this._sortIndices[count] = i;
        
        if (doSort) {
          const baseIdx = i * FLOATS_PER_PARTICLE;
          const dx = this.data[baseIdx + OFFSET_X] - camX;
          const dy = this.data[baseIdx + OFFSET_Y] - camY;
          const dz = this.data[baseIdx + OFFSET_Z] - camZ;
          this._sortDistances[count] = dx * dx + dy * dy + dz * dz;
        }
        
        count++;
      }
    }
    
    // Sort by distance (farthest first for proper transparency)
    if (doSort && count > 1) {
      this._quickSortByDistance(0, count - 1);
    }
    
    return count;
  }
  
  /**
   * Quick sort by distance (descending - farthest first)
   */
  _quickSortByDistance(low, high) {
    if (low < high) {
      const pivotIdx = this._partition(low, high);
      this._quickSortByDistance(low, pivotIdx - 1);
      this._quickSortByDistance(pivotIdx + 1, high);
    }
  }
  
  _partition(low, high) {
    const pivot = this._sortDistances[high];
    let i = low - 1;
    
    for (let j = low; j < high; j++) {
      // Descending order (farthest first)
      if (this._sortDistances[j] > pivot) {
        i++;
        // Swap indices
        const tmpIdx = this._sortIndices[i];
        this._sortIndices[i] = this._sortIndices[j];
        this._sortIndices[j] = tmpIdx;
        // Swap distances
        const tmpDist = this._sortDistances[i];
        this._sortDistances[i] = this._sortDistances[j];
        this._sortDistances[j] = tmpDist;
      }
    }
    
    // Swap pivot
    const tmpIdx = this._sortIndices[i + 1];
    this._sortIndices[i + 1] = this._sortIndices[high];
    this._sortIndices[high] = tmpIdx;
    const tmpDist = this._sortDistances[i + 1];
    this._sortDistances[i + 1] = this._sortDistances[high];
    this._sortDistances[high] = tmpDist;
    
    return i + 1;
  }
}
