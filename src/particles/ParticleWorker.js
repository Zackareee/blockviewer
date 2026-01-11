/**
 * ParticleWorker - Off-thread particle physics simulation
 * 
 * Uses SharedArrayBuffer for zero-copy data sharing with main thread.
 * Handles physics updates: position, velocity, gravity, friction, age.
 * 
 * Main thread responsibilities:
 * - Spawning particles (writing to SAB)
 * - GPU buffer sync (reading from SAB)
 * - Collision detection (optional, can be done here with block lookup)
 * 
 * Data layout per particle (48 bytes, 12 float32s):
 *   [0] x, [1] y, [2] z          - position
 *   [3] vx, [4] vy, [5] vz       - velocity
 *   [6] age, [7] lifetime        - timing
 *   [8] size                     - size
 *   [9] friction, [10] gravity   - physics params
 *   [11] state/flags             - packed: state (8 bits) | flags (8 bits) | unused (16 bits)
 */

// Particle state constants
const PARTICLE_DEAD = 0;
const PARTICLE_ALIVE = 1;

// Flags bit positions
const FLAG_HAS_PHYSICS = 1;
const FLAG_ON_GROUND = 2;
const FLAG_RANDOM_MOMENTUM = 4;

// Data layout offsets (in float32 indices)
const OFFSET_X = 0;
const OFFSET_Y = 1;
const OFFSET_Z = 2;
const OFFSET_VX = 3;
const OFFSET_VY = 4;
const OFFSET_VZ = 5;
const OFFSET_AGE = 6;
const OFFSET_LIFETIME = 7;
const OFFSET_SIZE = 8;
const OFFSET_FRICTION = 9;
const OFFSET_GRAVITY = 10;
const OFFSET_STATE_FLAGS = 11;

const FLOATS_PER_PARTICLE = 12;
const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4; // 48 bytes

// State
let particleBuffer = null;  // SharedArrayBuffer
let particleData = null;    // Float32Array view
let stateView = null;       // Uint32Array view for state/flags
let maxParticles = 0;
let aliveCount = 0;

/**
 * Initialize the worker with SharedArrayBuffer
 */
function init(buffer, count) {
  particleBuffer = buffer;
  particleData = new Float32Array(buffer);
  stateView = new Uint32Array(buffer);
  maxParticles = count;
  aliveCount = 0;
  
  // Initialize all particles as dead
  for (let i = 0; i < maxParticles; i++) {
    const stateIdx = i * FLOATS_PER_PARTICLE + OFFSET_STATE_FLAGS;
    particleData[stateIdx] = 0; // state = DEAD, flags = 0
  }
  
  self.postMessage({ type: 'initialized', maxParticles });
}

/**
 * Update particle physics
 * @param {number} deltaTime - Time since last update in seconds
 */
function tick(deltaTime) {
  if (!particleData) return;
  
  aliveCount = 0;
  
  for (let i = 0; i < maxParticles; i++) {
    const baseIdx = i * FLOATS_PER_PARTICLE;
    const stateIdx = baseIdx + OFFSET_STATE_FLAGS;
    
    // Read state/flags as uint32
    const stateFlags = stateView[stateIdx];
    const state = stateFlags & 0xFF;
    
    if (state !== PARTICLE_ALIVE) continue;
    
    aliveCount++;
    
    // Read current state
    let x = particleData[baseIdx + OFFSET_X];
    let y = particleData[baseIdx + OFFSET_Y];
    let z = particleData[baseIdx + OFFSET_Z];
    let vx = particleData[baseIdx + OFFSET_VX];
    let vy = particleData[baseIdx + OFFSET_VY];
    let vz = particleData[baseIdx + OFFSET_VZ];
    let age = particleData[baseIdx + OFFSET_AGE];
    const lifetime = particleData[baseIdx + OFFSET_LIFETIME];
    const friction = particleData[baseIdx + OFFSET_FRICTION];
    const gravity = particleData[baseIdx + OFFSET_GRAVITY];
    const flags = (stateFlags >> 8) & 0xFF;
    const hasPhysics = (flags & FLAG_HAS_PHYSICS) !== 0;
    const onGround = (flags & FLAG_ON_GROUND) !== 0;
    
    // Update age
    age += deltaTime;
    
    // Check if particle expired
    if (age >= lifetime) {
      // Kill particle
      particleData[stateIdx] = 0; // state = DEAD
      continue;
    }
    
    // Physics update (only if not on ground)
    if (!onGround) {
      // Apply gravity
      vy -= gravity * deltaTime;
      
      // Apply friction
      const frictionFactor = Math.pow(friction, deltaTime * 20); // Normalize to 20 ticks/sec
      vx *= frictionFactor;
      vy *= frictionFactor;
      vz *= frictionFactor;
      
      // Update position
      x += vx * deltaTime;
      y += vy * deltaTime;
      z += vz * deltaTime;
    }
    
    // Write back updated state
    particleData[baseIdx + OFFSET_X] = x;
    particleData[baseIdx + OFFSET_Y] = y;
    particleData[baseIdx + OFFSET_Z] = z;
    particleData[baseIdx + OFFSET_VX] = vx;
    particleData[baseIdx + OFFSET_VY] = vy;
    particleData[baseIdx + OFFSET_VZ] = vz;
    particleData[baseIdx + OFFSET_AGE] = age;
  }
  
  self.postMessage({ type: 'tickComplete', aliveCount, deltaTime });
}

/**
 * Handle messages from main thread
 */
self.onmessage = function(e) {
  const { type, data } = e.data;
  
  switch (type) {
    case 'init':
      init(data.buffer, data.maxParticles);
      break;
      
    case 'tick':
      tick(data.deltaTime);
      break;
      
    case 'getStats':
      self.postMessage({ type: 'stats', aliveCount, maxParticles });
      break;
  }
};

// Export constants for use by main thread
self.PARTICLE_CONSTANTS = {
  PARTICLE_DEAD,
  PARTICLE_ALIVE,
  FLAG_HAS_PHYSICS,
  FLAG_ON_GROUND,
  FLAG_RANDOM_MOMENTUM,
  OFFSET_X,
  OFFSET_Y,
  OFFSET_Z,
  OFFSET_VX,
  OFFSET_VY,
  OFFSET_VZ,
  OFFSET_AGE,
  OFFSET_LIFETIME,
  OFFSET_SIZE,
  OFFSET_FRICTION,
  OFFSET_GRAVITY,
  OFFSET_STATE_FLAGS,
  FLOATS_PER_PARTICLE,
  BYTES_PER_PARTICLE,
};
