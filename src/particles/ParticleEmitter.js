/**
 * ParticleEmitter - Block-based particle spawning system
 * 
 * Manages particle emitters attached to blocks (torches, furnaces, etc.)
 * Handles spawning rates, offsets, and particle properties.
 */

/**
 * Emitter configuration for different block types
 * Each entry defines what particles to spawn and how
 */
const BLOCK_EMITTERS = {
  // Standing torch - Minecraft spawns at exact position, no variance
  // Size varies randomly, motion creates spread
  'torch': {
    particles: [
      {
        type: 'flame',
        rate: 1.0, // ~1 per second
        offset: [0.5, 0.7, 0.5], // Exact center top of torch
        offsetVariance: [0.0, 0.0, 0.0], // No position variance - MC spawns at exact spot
        velocity: [0, 0.02, 0], // Small upward drift
        velocityVariance: [0.01, 0.01, 0.01], // Random spread comes from velocity
        size: 0.2, // Larger visible size (~0.2 blocks)
        sizeVariance: 0.05, // Size varies per spawn
        lifetime: 0.6, // 12 ticks average
        lifetimeVariance: 0.2,
        color: [1.0, 1.0, 1.0], // Use texture color
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
      {
        type: 'smoke',
        rate: 0.5, // ~1 per 2 seconds
        offset: [0.5, 0.75, 0.5], // Above flame
        offsetVariance: [0.0, 0.0, 0.0], // No position variance
        velocity: [0, 0.04, 0], // Rises faster than flame
        velocityVariance: [0.02, 0.02, 0.02], // More random for smoke
        size: 0.15, // Slightly smaller than flame
        sizeVariance: 0.04,
        lifetime: 1.5, // ~30 ticks
        lifetimeVariance: 0.5,
        color: [0.6, 0.6, 0.6], // Gray smoke
        alpha: 0.4,
        fadeIn: 0.1,
        fadeOut: 0.6,
        friction: 0.96,
      },
    ],
  },
  
  // Wall torch (facing directions handled by offset adjustments)
  'wall_torch': {
    particles: [
      {
        type: 'flame',
        rate: 1.0,
        offset: [0.5, 0.65, 0.28], // Default facing south (attached to north wall)
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.02, 0],
        velocityVariance: [0.01, 0.01, 0.01],
        size: 0.2,
        sizeVariance: 0.05,
        lifetime: 0.6,
        lifetimeVariance: 0.2,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
      {
        type: 'smoke',
        rate: 0.5,
        offset: [0.5, 0.7, 0.28],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.04, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.15,
        sizeVariance: 0.04,
        lifetime: 1.5,
        lifetimeVariance: 0.5,
        color: [0.6, 0.6, 0.6],
        alpha: 0.4,
        fadeIn: 0.1,
        fadeOut: 0.6,
        friction: 0.96,
      },
    ],
  },
  
  // Soul torch (blue flame)
  'soul_torch': {
    particles: [
      {
        type: 'soul_fire_flame',
        rate: 1.0,
        offset: [0.5, 0.7, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.02, 0],
        velocityVariance: [0.01, 0.01, 0.01],
        size: 0.2,
        sizeVariance: 0.05,
        lifetime: 0.6,
        lifetimeVariance: 0.2,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
      {
        type: 'smoke',
        rate: 0.5,
        offset: [0.5, 0.75, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.04, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.15,
        sizeVariance: 0.04,
        lifetime: 1.5,
        lifetimeVariance: 0.5,
        color: [0.5, 0.5, 0.6], // Slightly blue-tinted smoke
        alpha: 0.4,
        fadeIn: 0.1,
        fadeOut: 0.6,
        friction: 0.96,
      },
    ],
  },
  
  // Soul wall torch
  'soul_wall_torch': {
    particles: [
      {
        type: 'soul_fire_flame',
        rate: 1.0,
        offset: [0.5, 0.65, 0.28],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.02, 0],
        velocityVariance: [0.01, 0.01, 0.01],
        size: 0.2,
        sizeVariance: 0.05,
        lifetime: 0.6,
        lifetimeVariance: 0.2,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
    ],
  },
  
  // Redstone torch (spawns redstone dust particles, less frequently)
  'redstone_torch': {
    particles: [
      {
        type: 'flame',
        rate: 0.5, // Redstone torches have less particle activity
        offset: [0.5, 0.65, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.02, 0],
        velocityVariance: [0.01, 0.01, 0.01],
        size: 0.15, // Slightly smaller than regular torches
        sizeVariance: 0.04,
        lifetime: 0.6,
        lifetimeVariance: 0.2,
        color: [1.0, 0.2, 0.1], // Red tint
        alpha: 0.9,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
    ],
  },
  
  // Redstone wall torch
  'redstone_wall_torch': {
    particles: [
      {
        type: 'flame',
        rate: 0.5,
        offset: [0.5, 0.6, 0.28],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.02, 0],
        velocityVariance: [0.01, 0.01, 0.01],
        size: 0.15,
        sizeVariance: 0.04,
        lifetime: 0.6,
        lifetimeVariance: 0.2,
        color: [1.0, 0.2, 0.1],
        alpha: 0.9,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
    ],
  },
  
  // ============================================================================
  // CAMPFIRE PARTICLES
  // ============================================================================
  // From CampfireSmokeParticle.class:
  // - Scale: 3.0f (very large smoke puffs!)
  // - Gravity: ~0.000003 (nearly zero - floats up)
  // - Lifetime: 50-100 ticks for cosy (~2.5-5 sec), 100-180 for signal (~5-9 sec)
  // - XZ velocity: random * 500f (creates horizontal drift)
  // - Y velocity: passed from block spawn
  // From CampfireBlock.class:
  // - Spawns at block center + random XZ offset ±0.5
  // - Y offset: 0.3-0.5 above block
  // - Cosy smoke rises ~10 blocks, signal smoke ~24 blocks
  
  // Campfire (cosy smoke - rises ~10 blocks)
  'campfire': {
    particles: [
      {
        type: 'flame',
        rate: 3.0, // Multiple flames
        offset: [0.5, 0.3, 0.5], // Center of campfire logs
        offsetVariance: [0.3, 0.0, 0.3], // Spread across fire area
        velocity: [0, 0.02, 0],
        velocityVariance: [0.015, 0.01, 0.015],
        size: 0.15,
        sizeVariance: 0.05,
        lifetime: 0.6,
        lifetimeVariance: 0.2,
        color: [1.0, 0.9, 0.6],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
      {
        type: 'campfire_cosy_smoke',
        rate: 2.5, // Frequent smoke puffs
        offset: [0.5, 0.5, 0.5], // Above the flames
        offsetVariance: [0.4, 0.0, 0.4], // Wide spread across campfire (MC uses ±0.5)
        velocity: [0, 0.12, 0], // Rises ~10 blocks over lifetime (0.12 * 5s * 20 = ~12 blocks)
        velocityVariance: [0.03, 0.02, 0.03], // Horizontal drift
        size: 0.8, // Large smoke! (MC scale is 3.0 on base 0.25 = 0.75 quad size)
        sizeVariance: 0.2, // Random size variation
        lifetime: 5.0, // ~100 ticks = 5 seconds
        lifetimeVariance: 1.5, // 50-130 ticks range
        color: [0.5, 0.5, 0.5],
        alpha: 0.6,
        fadeIn: 0.15,
        fadeOut: 0.4,
        friction: 0.995, // Nearly no friction - MC gravity is ~0
      },
    ],
  },
  
  // Soul campfire (blue flame, same smoke behavior)
  'soul_campfire': {
    particles: [
      {
        type: 'soul_fire_flame',
        rate: 3.0,
        offset: [0.5, 0.3, 0.5],
        offsetVariance: [0.3, 0.0, 0.3],
        velocity: [0, 0.02, 0],
        velocityVariance: [0.015, 0.01, 0.015],
        size: 0.15,
        sizeVariance: 0.05,
        lifetime: 0.6,
        lifetimeVariance: 0.2,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
      {
        type: 'campfire_cosy_smoke',
        rate: 2.5,
        offset: [0.5, 0.5, 0.5],
        offsetVariance: [0.4, 0.0, 0.4],
        velocity: [0, 0.12, 0],
        velocityVariance: [0.03, 0.02, 0.03],
        size: 0.8,
        sizeVariance: 0.2,
        lifetime: 5.0,
        lifetimeVariance: 1.5,
        color: [0.4, 0.45, 0.5], // Slightly blue-tinted smoke for soul fire
        alpha: 0.6,
        fadeIn: 0.15,
        fadeOut: 0.4,
        friction: 0.995,
      },
    ],
  },
  
  // ============================================================================
  // FURNACE / SMOKER / BLAST FURNACE PARTICLES
  // ============================================================================
  
  // Furnace (when lit) - emits smoke from top
  'furnace': {
    particles: [
      {
        type: 'smoke',
        rate: 0.8,
        offset: [0.5, 1.0, 0.5], // Top of block
        offsetVariance: [0.2, 0.0, 0.2],
        velocity: [0, 0.05, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.15,
        sizeVariance: 0.03,
        lifetime: 1.5,
        lifetimeVariance: 0.5,
        color: [0.4, 0.4, 0.4],
        alpha: 0.5,
        fadeIn: 0.1,
        fadeOut: 0.6,
        friction: 0.96,
      },
    ],
  },
  
  // Smoker - more smoke than furnace
  'smoker': {
    particles: [
      {
        type: 'large_smoke',
        rate: 1.5,
        offset: [0.5, 1.0, 0.5],
        offsetVariance: [0.15, 0.0, 0.15],
        velocity: [0, 0.08, 0],
        velocityVariance: [0.03, 0.03, 0.03],
        size: 0.25,
        sizeVariance: 0.05,
        lifetime: 2.0,
        lifetimeVariance: 0.5,
        color: [0.5, 0.5, 0.5],
        alpha: 0.6,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.97,
      },
    ],
  },
  
  // Blast furnace - faster, smaller smoke
  'blast_furnace': {
    particles: [
      {
        type: 'smoke',
        rate: 1.2,
        offset: [0.5, 1.0, 0.5],
        offsetVariance: [0.15, 0.0, 0.15],
        velocity: [0, 0.1, 0], // Faster rise
        velocityVariance: [0.02, 0.03, 0.02],
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 1.0,
        lifetimeVariance: 0.3,
        color: [0.35, 0.35, 0.4],
        alpha: 0.5,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.95,
      },
    ],
  },
  
  // ============================================================================
  // CANDLE PARTICLES
  // ============================================================================
  
  // Single candle
  'candle': {
    particles: [
      {
        type: 'small_flame',
        rate: 0.8,
        offset: [0.5, 0.5, 0.5], // Center of candle top
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.015, 0],
        velocityVariance: [0.005, 0.005, 0.005],
        size: 0.08, // Very small flame
        sizeVariance: 0.02,
        lifetime: 0.5,
        lifetimeVariance: 0.15,
        color: [1.0, 0.9, 0.6],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
      {
        type: 'smoke',
        rate: 0.3,
        offset: [0.5, 0.55, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.03, 0],
        velocityVariance: [0.01, 0.01, 0.01],
        size: 0.06,
        sizeVariance: 0.02,
        lifetime: 1.0,
        lifetimeVariance: 0.3,
        color: [0.6, 0.6, 0.6],
        alpha: 0.3,
        fadeIn: 0.1,
        fadeOut: 0.6,
        friction: 0.96,
      },
    ],
  },
  
  // Candle cake (single candle on cake)
  'candle_cake': {
    particles: [
      {
        type: 'small_flame',
        rate: 0.8,
        offset: [0.5, 0.9, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.015, 0],
        velocityVariance: [0.005, 0.005, 0.005],
        size: 0.08,
        sizeVariance: 0.02,
        lifetime: 0.5,
        lifetimeVariance: 0.15,
        color: [1.0, 0.9, 0.6],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
    ],
  },
  
  // ============================================================================
  // END ROD PARTICLES
  // ============================================================================
  
  // End rod - white glowing particles
  'end_rod': {
    particles: [
      {
        type: 'end_rod',
        rate: 0.5,
        offset: [0.5, 0.5, 0.5], // Center of rod
        offsetVariance: [0.1, 0.3, 0.1], // Along the rod
        velocity: [0, 0.01, 0],
        velocityVariance: [0.02, 0.02, 0.02], // Random drift
        size: 0.1,
        sizeVariance: 0.03,
        lifetime: 1.5,
        lifetimeVariance: 0.5,
        color: [1.0, 1.0, 1.0], // Pure white
        alpha: 0.8,
        fadeIn: 0.2,
        fadeOut: 0.5,
        friction: 0.98,
      },
    ],
  },
  
  // ============================================================================
  // LAVA PARTICLES
  // ============================================================================
  
  // Lava block - occasional bubbles/sparks
  'lava': {
    particles: [
      {
        type: 'lava',
        rate: 0.3, // Occasional sparks
        offset: [0.5, 1.0, 0.5], // Surface of lava
        offsetVariance: [0.4, 0.0, 0.4], // Spread across block
        velocity: [0, 0.08, 0], // Pop up
        velocityVariance: [0.05, 0.05, 0.05],
        size: 0.15,
        sizeVariance: 0.05,
        lifetime: 1.0,
        lifetimeVariance: 0.3,
        color: [1.0, 0.6, 0.2], // Orange-red
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.94,
      },
    ],
  },
  
  // ============================================================================
  // BREWING STAND PARTICLES
  // ============================================================================
  
  // Brewing stand - bubbles when active
  'brewing_stand': {
    particles: [
      {
        type: 'bubble',
        rate: 1.0,
        offset: [0.5, 0.6, 0.5],
        offsetVariance: [0.1, 0.0, 0.1],
        velocity: [0, 0.05, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.08,
        sizeVariance: 0.02,
        lifetime: 0.8,
        lifetimeVariance: 0.2,
        color: [0.8, 0.4, 1.0], // Purple tint
        alpha: 0.7,
        fadeIn: 0.1,
        fadeOut: 0.4,
        friction: 0.96,
      },
    ],
  },
  
  // ============================================================================
  // ENCHANTING TABLE PARTICLES (simplified - no spiral)
  // ============================================================================
  
  // Enchanting table - sparkles
  'enchanting_table': {
    particles: [
      {
        type: 'end_rod', // Use white sparkle
        rate: 0.8,
        offset: [0.5, 1.0, 0.5],
        offsetVariance: [0.3, 0.0, 0.3],
        velocity: [0, 0.02, 0],
        velocityVariance: [0.03, 0.02, 0.03],
        size: 0.08,
        sizeVariance: 0.02,
        lifetime: 1.2,
        lifetimeVariance: 0.4,
        color: [0.9, 0.7, 1.0], // Light purple
        alpha: 0.8,
        fadeIn: 0.2,
        fadeOut: 0.5,
        friction: 0.97,
      },
    ],
  },
  
  // ============================================================================
  // BEACON PARTICLES (simplified)
  // ============================================================================
  
  // Beacon - ambient sparkles
  'beacon': {
    particles: [
      {
        type: 'end_rod',
        rate: 1.0,
        offset: [0.5, 1.0, 0.5],
        offsetVariance: [0.3, 0.0, 0.3],
        velocity: [0, 0.05, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.1,
        sizeVariance: 0.03,
        lifetime: 1.5,
        lifetimeVariance: 0.5,
        color: [0.9, 0.95, 1.0], // Slightly cyan
        alpha: 0.9,
        fadeIn: 0.1,
        fadeOut: 0.4,
        friction: 0.98,
      },
    ],
  },
  
  // ============================================================================
  // RESPAWN ANCHOR PARTICLES
  // ============================================================================
  
  // Respawn anchor - portal-like particles
  'respawn_anchor': {
    particles: [
      {
        type: 'end_rod',
        rate: 1.5,
        offset: [0.5, 0.8, 0.5],
        offsetVariance: [0.2, 0.1, 0.2],
        velocity: [0, -0.02, 0], // Sink downward
        velocityVariance: [0.03, 0.02, 0.03],
        size: 0.1,
        sizeVariance: 0.03,
        lifetime: 1.0,
        lifetimeVariance: 0.3,
        color: [0.6, 0.2, 1.0], // Purple
        alpha: 0.9,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.96,
      },
    ],
  },
};

// ============================================================================
// CANDLE COLOR ALIASES
// All colored candles share the same particle config as the base candle
// ============================================================================
const CANDLE_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
];

// Add all colored candles and candle cakes
for (const color of CANDLE_COLORS) {
  BLOCK_EMITTERS[`${color}_candle`] = BLOCK_EMITTERS['candle'];
  BLOCK_EMITTERS[`${color}_candle_cake`] = BLOCK_EMITTERS['candle_cake'];
}

// Wall torch facing offset adjustments (from default south-facing)
const WALL_TORCH_OFFSETS = {
  south: [0, 0, 0],      // Default
  north: [0, 0, 0.44],   // Flip Z
  east: [-0.22, 0, 0.22],
  west: [0.22, 0, 0.22],
};

/**
 * EmitterInstance - A single active emitter at a world position
 */
class EmitterInstance {
  /**
   * @param {string} blockType - Block type key
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {number} z - World Z
   * @param {Object} properties - Block properties (for facing, etc.)
   */
  constructor(blockType, x, y, z, properties = {}) {
    this.blockType = blockType;
    this.x = x;
    this.y = y;
    this.z = z;
    this.properties = properties;
    this.config = BLOCK_EMITTERS[blockType];
    this.timers = []; // Spawn timers for each particle type
    this.active = true;
    
    // Initialize spawn timers
    if (this.config) {
      for (let i = 0; i < this.config.particles.length; i++) {
        const pConfig = this.config.particles[i];
        // Randomize initial timer to avoid synchronized spawning
        this.timers.push(Math.random() / pConfig.rate);
      }
    }
  }
  
  /**
   * Update emitter and spawn particles
   * @param {number} deltaTime - Time since last update
   * @param {ParticleSystem} particleSystem - Particle system to spawn into
   */
  update(deltaTime, particleSystem) {
    if (!this.active || !this.config || !particleSystem) return;
    
    for (let i = 0; i < this.config.particles.length; i++) {
      const pConfig = this.config.particles[i];
      this.timers[i] += deltaTime;
      
      const spawnInterval = 1.0 / pConfig.rate;
      
      while (this.timers[i] >= spawnInterval) {
        this.timers[i] -= spawnInterval;
        this._spawnParticle(pConfig, particleSystem);
      }
    }
  }
  
  /**
   * Spawn a single particle with the given config
   */
  _spawnParticle(config, particleSystem) {
    // Calculate offset with variance
    const offset = [
      config.offset[0] + (Math.random() - 0.5) * 2 * config.offsetVariance[0],
      config.offset[1] + (Math.random() - 0.5) * 2 * config.offsetVariance[1],
      config.offset[2] + (Math.random() - 0.5) * 2 * config.offsetVariance[2],
    ];
    
    // Apply wall torch facing adjustment
    if (this.blockType.includes('wall_torch') && this.properties.facing) {
      const facingOffset = WALL_TORCH_OFFSETS[this.properties.facing] || [0, 0, 0];
      offset[0] += facingOffset[0];
      offset[1] += facingOffset[1];
      offset[2] += facingOffset[2];
    }
    
    // Calculate velocity with variance
    const velocity = [
      config.velocity[0] + (Math.random() - 0.5) * 2 * config.velocityVariance[0],
      config.velocity[1] + (Math.random() - 0.5) * 2 * config.velocityVariance[1],
      config.velocity[2] + (Math.random() - 0.5) * 2 * config.velocityVariance[2],
    ];
    
    // Size with variance
    const size = config.size + (Math.random() - 0.5) * 2 * config.sizeVariance;
    
    // Lifetime with variance
    const lifetime = config.lifetime + (Math.random() - 0.5) * 2 * config.lifetimeVariance;
    
    // Spawn the particle
    const particle = particleSystem.spawn(config.type, {
      x: this.x + offset[0],
      y: this.y + offset[1],
      z: this.z + offset[2],
      vx: velocity[0],
      vy: velocity[1],
      vz: velocity[2],
      size,
      lifetime,
      r: config.color[0],
      g: config.color[1],
      b: config.color[2],
      alpha: config.alpha,
      fadeIn: config.fadeIn,
      fadeOut: config.fadeOut,
      friction: config.friction ?? 1.0,
    });
    
    // Debug: log first spawn
    if (!this._loggedSpawn && particle) {
      console.log(`[EmitterInstance] Spawned ${config.type} at ${(this.x + offset[0]).toFixed(1)},${(this.y + offset[1]).toFixed(1)},${(this.z + offset[2]).toFixed(1)}`);
      this._loggedSpawn = true;
    }
  }
  
  /**
   * Deactivate this emitter
   */
  deactivate() {
    this.active = false;
  }
}

/**
 * ParticleEmitterManager - Manages all emitter instances
 */
export class ParticleEmitterManager {
  constructor() {
    // Map of position key -> EmitterInstance
    this.emitters = new Map();
    
    // Maximum distance from camera to update emitters
    this.maxDistance = 64;
    
    // Camera position for distance culling
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraZ = 0;
  }
  
  /**
   * Register an emitter at a world position
   * @param {string} blockType - Block type (e.g., 'torch')
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {number} z - World Z
   * @param {Object} properties - Block properties
   */
  addEmitter(blockType, x, y, z, properties = {}) {
    // Normalize block name (remove minecraft: prefix)
    const normalizedType = blockType.replace('minecraft:', '');
    
    // Check if this block type has an emitter config
    if (!BLOCK_EMITTERS[normalizedType]) {
      // Debug: log unknown block types that might need emitter configs
      // console.log('[ParticleEmitterManager] No emitter config for:', normalizedType);
      return;
    }
    
    const key = `${x},${y},${z}`;
    
    // Don't add duplicates
    if (this.emitters.has(key)) return;
    
    const emitter = new EmitterInstance(normalizedType, x, y, z, properties);
    this.emitters.set(key, emitter);
  }
  
  /**
   * Remove an emitter at a world position
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  removeEmitter(x, y, z) {
    const key = `${x},${y},${z}`;
    const emitter = this.emitters.get(key);
    if (emitter) {
      emitter.deactivate();
      this.emitters.delete(key);
    }
  }
  
  /**
   * Update camera position for distance culling
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  updateCamera(x, y, z) {
    this.cameraX = x;
    this.cameraY = y;
    this.cameraZ = z;
  }
  
  /**
   * Update all emitters
   * @param {number} deltaTime - Time since last update
   * @param {ParticleSystem} particleSystem - Particle system to spawn into
   */
  update(deltaTime, particleSystem) {
    const maxDistSq = this.maxDistance * this.maxDistance;
    let activeCount = 0;
    
    for (const emitter of this.emitters.values()) {
      // Distance culling
      const dx = emitter.x - this.cameraX;
      const dy = emitter.y - this.cameraY;
      const dz = emitter.z - this.cameraZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      
      if (distSq <= maxDistSq) {
        emitter.update(deltaTime, particleSystem);
        activeCount++;
      }
    }
    
    // Debug: log active emitters periodically (every ~5 seconds)
    if (this._debugCounter === undefined) this._debugCounter = 0;
    this._debugCounter++;
    if (this._debugCounter % 300 === 1 && this.emitters.size > 0) {
      console.log(`[ParticleEmitterManager] ${activeCount}/${this.emitters.size} emitters active, camera at ${this.cameraX.toFixed(0)},${this.cameraY.toFixed(0)},${this.cameraZ.toFixed(0)}`);
    }
  }
  
  /**
   * Clear all emitters
   */
  clear() {
    for (const emitter of this.emitters.values()) {
      emitter.deactivate();
    }
    this.emitters.clear();
  }
  
  /**
   * Get emitter count
   */
  getEmitterCount() {
    return this.emitters.size;
  }
  
  /**
   * Set max distance for emitter updates
   * @param {number} distance
   */
  setMaxDistance(distance) {
    this.maxDistance = distance;
  }
}

/**
 * Check if a block type has particle emitters
 * @param {string} blockType - Block type name
 * @returns {boolean}
 */
export function hasEmitter(blockType) {
  // Remove minecraft: prefix if present
  const name = blockType.replace('minecraft:', '');
  return BLOCK_EMITTERS.hasOwnProperty(name);
}

/**
 * Get emitter config for a block type
 * @param {string} blockType
 * @returns {Object|null}
 */
export function getEmitterConfig(blockType) {
  const name = blockType.replace('minecraft:', '');
  return BLOCK_EMITTERS[name] || null;
}

export { BLOCK_EMITTERS, EmitterInstance };
export default ParticleEmitterManager;

