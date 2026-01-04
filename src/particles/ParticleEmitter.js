/**
 * ParticleEmitter - Block-based particle spawning system
 * 
 * Manages particle emitters attached to blocks (torches, furnaces, etc.)
 * Handles spawning rates, offsets, and particle properties.
 */

/**
 * Particle types that should NOT collide with blocks (hasPhysics = false)
 * In MC, these extend BaseAshSmokeParticle which disables physics
 * 
 * NOTE: In vanilla MC, smoke passes through blocks. 
 * For more realistic physics where smoke stops at ceilings, 
 * remove 'campfire_cosy_smoke' and 'campfire_signal_smoke' from this set.
 */
const SMOKE_PARTICLE_TYPES = new Set([
  'smoke',           // Torch smoke - small, passes through
  'large_smoke',     // Furnace smoke - small, passes through
  'white_smoke',     // Various - passes through
  // Campfire smoke removed - now collides with blocks for more realistic behavior
  // 'campfire_cosy_smoke',
  // 'campfire_signal_smoke',
]);

/**
 * Candle wick positions for each candle count (in block coordinates 0-1)
 * Extracted from Minecraft's template_*.json model files
 * Format: [[x, y, z], ...] for each candle wick position
 */
const CANDLE_OFFSETS = {
  // 1 candle: single center candle
  1: [[0.5, 0.4375, 0.5]],  // (8, 7, 8) / 16
  
  // 2 candles: left and right
  2: [
    [0.375, 0.375, 0.5],    // (6, 6, 8) / 16
    [0.625, 0.4375, 0.4375], // (10, 7, 7) / 16
  ],
  
  // 3 candles: 3 positions
  3: [
    [0.5, 0.25, 0.625],     // (8, 4, 10) / 16
    [0.375, 0.375, 0.5],    // (6, 6, 8) / 16
    [0.5625, 0.4375, 0.4375], // (9, 7, 7) / 16
  ],
  
  // 4 candles: 4 positions
  4: [
    [0.4375, 0.25, 0.5625],  // (7, 4, 9) / 16
    [0.625, 0.375, 0.5625],  // (10, 6, 9) / 16
    [0.375, 0.375, 0.375],   // (6, 6, 6) / 16
    [0.5625, 0.4375, 0.375], // (9, 7, 6) / 16
  ],
};

/**
 * Candle cake wick position (single candle on cake)
 */
const CANDLE_CAKE_OFFSET = [0.5, 0.875, 0.5]; // Candle is higher on cake

/**
 * Emitter configuration for different block types
 * Each entry defines what particles to spawn and how
 * 
 * Properties:
 * - requiresLit: if true, only emit when block has lit=true property
 * - particles: array of particle spawn configurations
 */
const BLOCK_EMITTERS = {
  // Standing torch - Minecraft spawns at exact position, no variance
  // From TorchBlock.class: spawns every animateTick call (no random chance)
  // Offset constants: x=0.5, z=0.5, y=0.7 (from constant pool)
  'torch': {
    particles: [
      {
        type: 'flame',
        rate: 5.0, // Higher rate for active flame appearance
        offset: [0.5, 0.7, 0.5], // From MC constants
        offsetVariance: [0.0, 0.0, 0.0], // No position variance
        velocity: [0, 0.12, 0], // Visible upward drift
        velocityVariance: [0.03, 0.03, 0.03], // Some random spread
        size: 0.18, // Good visible size
        sizeVariance: 0.05,
        lifetime: 0.5, // Short lived for flickering
        lifetimeVariance: 0.15,
        color: [1.0, 1.0, 1.0], // Use texture color
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'smoke',
        rate: 4.0, // Slightly less than flame
        offset: [0.5, 0.75, 0.5], // Slightly above flame
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.2, 0], // Rises faster than flame
        velocityVariance: [0.04, 0.04, 0.04], // More random for smoke
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 1.2, // ~24 ticks
        lifetimeVariance: 0.3,
        color: [0.6, 0.6, 0.6], // Gray smoke
        alpha: 0.35,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.98,
      },
    ],
  },
  
  // Wall torch (facing directions handled by offset adjustments)
  'wall_torch': {
    particles: [
      {
        type: 'flame',
        rate: 5.0, // Same as standing torch
        offset: [0.5, 0.65, 0.28], // Default facing south
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.12, 0],
        velocityVariance: [0.03, 0.03, 0.03],
        size: 0.18,
        sizeVariance: 0.05,
        lifetime: 0.5,
        lifetimeVariance: 0.15,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'smoke',
        rate: 4.0,
        offset: [0.5, 0.7, 0.28],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.2, 0],
        velocityVariance: [0.04, 0.04, 0.04],
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 1.2,
        lifetimeVariance: 0.3,
        color: [0.6, 0.6, 0.6],
        alpha: 0.35,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.98,
      },
    ],
  },
  
  // Soul torch (blue flame) - same spawn behavior as regular torch
  'soul_torch': {
    particles: [
      {
        type: 'soul_fire_flame',
        rate: 5.0, // Same as regular torch
        offset: [0.5, 0.7, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.12, 0],
        velocityVariance: [0.03, 0.03, 0.03],
        size: 0.18,
        sizeVariance: 0.05,
        lifetime: 0.5,
        lifetimeVariance: 0.15,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'smoke',
        rate: 4.0,
        offset: [0.5, 0.75, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.2, 0],
        velocityVariance: [0.04, 0.04, 0.04],
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 1.2,
        lifetimeVariance: 0.3,
        color: [0.5, 0.5, 0.6], // Slightly blue-tinted smoke
        alpha: 0.35,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.98,
      },
    ],
  },
  
  // Soul wall torch
  'soul_wall_torch': {
    particles: [
      {
        type: 'soul_fire_flame',
        rate: 5.0,
        offset: [0.5, 0.65, 0.28],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.12, 0],
        velocityVariance: [0.03, 0.03, 0.03],
        size: 0.18,
        sizeVariance: 0.05,
        lifetime: 0.5,
        lifetimeVariance: 0.15,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'smoke',
        rate: 4.0,
        offset: [0.5, 0.7, 0.28],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.2, 0],
        velocityVariance: [0.04, 0.04, 0.04],
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 1.2,
        lifetimeVariance: 0.3,
        color: [0.5, 0.5, 0.6],
        alpha: 0.35,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.98,
      },
    ],
  },
  
  // Redstone torch (red particles, less active than regular torch)
  'redstone_torch': {
    particles: [
      {
        type: 'flame',
        rate: 3.0, // Less frequent than regular torches
        offset: [0.5, 0.65, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.08, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 0.4,
        lifetimeVariance: 0.1,
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
        rate: 3.0,
        offset: [0.5, 0.6, 0.28],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.08, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 0.4,
        lifetimeVariance: 0.1,
        color: [1.0, 0.2, 0.1],
        alpha: 0.9,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.98,
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
  // From CampfireBlock.class - spawns: FLAME, CAMPFIRE_COSY_SMOKE, LAVA, SMOKE
  // From CampfireSmokeParticle.class:
  // - scale: 3.0 (large smoke puffs)
  // - gravity: 0.000003 (near zero - floats up steadily)
  'campfire': {
    requiresLit: true, // Only emit when lit=true
    particles: [
      {
        type: 'flame',
        rate: 4.0, // Active flames
        offset: [0.5, 0.3, 0.5], // Center of campfire logs
        offsetVariance: [0.35, 0.0, 0.35], // Spread across fire area
        velocity: [0, 0.15, 0],
        velocityVariance: [0.03, 0.05, 0.03],
        size: 0.18,
        sizeVariance: 0.06,
        lifetime: 0.5,
        lifetimeVariance: 0.15,
        color: [1.0, 0.9, 0.6],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'lava', // Orange ember sparks - sputtering effect!
        // MC: lifetime = (16 + random * 16 * 0.8) ticks = 16-29 ticks = 0.8-1.45 sec
        // But they can bounce/rest on ground so extend lifetime
        rate: 1.5, // Occasional sparks
        offset: [0.5, 0.4, 0.5],
        offsetVariance: [0.3, 0.1, 0.3],
        velocity: [0, 1.5, 0], // Pop UP (then falls due to gravity)
        velocityVariance: [0.5, 0.6, 0.5], // Random arc trajectory
        size: 0.18, // Larger for visibility
        sizeVariance: 0.05,
        lifetime: 3.0, // Long enough to arc up, fall down, and rest
        lifetimeVariance: 1.0,
        color: [1.0, 1.0, 1.0], // Use texture color (lava.png is already orange)
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.3,
        friction: 0.999, // MC: very little air resistance
        gravity: 0.75, // MC: heavy gravity - particles arc up then FALL back down
      },
      {
        type: 'smoke', // Small smoke wisps (in addition to big smoke)
        rate: 2.0,
        offset: [0.5, 0.45, 0.5],
        offsetVariance: [0.3, 0.0, 0.3],
        velocity: [0, 0.25, 0],
        velocityVariance: [0.05, 0.05, 0.05],
        size: 0.15,
        sizeVariance: 0.05,
        lifetime: 1.2,
        lifetimeVariance: 0.4,
        color: [0.5, 0.5, 0.5],
        alpha: 0.5,
        fadeIn: 0.1,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'campfire_cosy_smoke',
        rate: 1.5, // Steady smoke emission
        offset: [0.5, 0.5, 0.5], // Above the flames
        offsetVariance: [0.4, 0.0, 0.4], // XZ spread
        velocity: [0, 0.8, 0], // Slower rise - 0.8 blocks/sec
        velocityVariance: [0.06, 0.05, 0.06], // Minimal drift
        size: 2.0, // LARGE smoke puffs (MC scale 3.0)
        sizeVariance: 0.5,
        lifetime: 12.0, // Long-lasting: 0.8 * 12 = ~10 blocks rise
        lifetimeVariance: 2.0,
        color: [0.7, 0.7, 0.7], // Light gray smoke
        alpha: 0.95, // Very opaque - like real campfire smoke
        fadeIn: 0.1,
        fadeOut: 0.3, // Fade out at end of life
        friction: 1.0, // No friction - constant velocity
      },
    ],
  },
  
  // Soul campfire (blue flame, same smoke behavior - no lava sparks)
  'soul_campfire': {
    requiresLit: true,
    particles: [
      {
        type: 'soul_fire_flame',
        rate: 4.0,
        offset: [0.5, 0.3, 0.5],
        offsetVariance: [0.35, 0.0, 0.35],
        velocity: [0, 0.15, 0],
        velocityVariance: [0.03, 0.05, 0.03],
        size: 0.18,
        sizeVariance: 0.06,
        lifetime: 0.5,
        lifetimeVariance: 0.15,
        color: [1.0, 1.0, 1.0],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'smoke', // Small smoke wisps
        rate: 2.0,
        offset: [0.5, 0.45, 0.5],
        offsetVariance: [0.3, 0.0, 0.3],
        velocity: [0, 0.25, 0],
        velocityVariance: [0.05, 0.05, 0.05],
        size: 0.15,
        sizeVariance: 0.05,
        lifetime: 1.2,
        lifetimeVariance: 0.4,
        color: [0.45, 0.5, 0.55], // Slightly blue-tinted
        alpha: 0.5,
        fadeIn: 0.1,
        fadeOut: 0.4,
        friction: 0.98,
      },
      {
        type: 'campfire_cosy_smoke',
        rate: 1.5, // Same as regular campfire
        offset: [0.5, 0.5, 0.5],
        offsetVariance: [0.4, 0.0, 0.4],
        velocity: [0, 0.8, 0], // Slower rise to match regular campfire
        velocityVariance: [0.06, 0.05, 0.06],
        size: 2.0,
        sizeVariance: 0.5,
        lifetime: 12.0,
        lifetimeVariance: 2.0,
        color: [0.6, 0.65, 0.7], // Slightly blue-tinted smoke for soul fire
        alpha: 0.95,
        fadeIn: 0.1,
        fadeOut: 0.3,
        friction: 1.0,
      },
    ],
  },
  
  // ============================================================================
  // FURNACE / SMOKER / BLAST FURNACE PARTICLES
  // ============================================================================
  
  // Furnace (when lit) - emits smoke from top
  'furnace': {
    requiresLit: true,
    particles: [
      {
        type: 'smoke',
        rate: 3.0,
        offset: [0.5, 1.0, 0.5], // Top of block
        offsetVariance: [0.2, 0.0, 0.2],
        velocity: [0, 0.3, 0], // Visible rise
        velocityVariance: [0.05, 0.05, 0.05],
        size: 0.15,
        sizeVariance: 0.04,
        lifetime: 1.2,
        lifetimeVariance: 0.3,
        color: [0.4, 0.4, 0.4],
        alpha: 0.45,
        fadeIn: 0.1,
        fadeOut: 0.5,
        friction: 0.99,
      },
    ],
  },
  
  // Smoker - more smoke than furnace
  'smoker': {
    requiresLit: true,
    particles: [
      {
        type: 'large_smoke',
        rate: 5.0, // Lots of smoke
        offset: [0.5, 1.0, 0.5],
        offsetVariance: [0.2, 0.0, 0.2],
        velocity: [0, 0.5, 0], // Rises visibly
        velocityVariance: [0.08, 0.08, 0.08],
        size: 0.3,
        sizeVariance: 0.1,
        lifetime: 1.5,
        lifetimeVariance: 0.4,
        color: [0.5, 0.5, 0.5],
        alpha: 0.55,
        fadeIn: 0.1,
        fadeOut: 0.4,
        friction: 0.99,
      },
    ],
  },
  
  // Blast furnace - faster, more intense smoke
  'blast_furnace': {
    requiresLit: true,
    particles: [
      {
        type: 'smoke',
        rate: 4.0,
        offset: [0.5, 1.0, 0.5],
        offsetVariance: [0.15, 0.0, 0.15],
        velocity: [0, 0.6, 0], // Fast rise
        velocityVariance: [0.06, 0.08, 0.06],
        size: 0.14,
        sizeVariance: 0.04,
        lifetime: 1.0,
        lifetimeVariance: 0.25,
        color: [0.35, 0.35, 0.4],
        alpha: 0.5,
        fadeIn: 0.1,
        fadeOut: 0.4,
        friction: 0.99,
      },
    ],
  },
  
  // ============================================================================
  // CANDLE PARTICLES
  // From AbstractCandleBlock.class:
  // - Spawn chance: 0.3 (30%) per animateTick call (constant pool entry [86])
  // - Effective rate: ~6 particles/sec per candle (20 ticks/sec * 0.3 chance)
  // - Particles: SMALL_FLAME and SMOKE
  // - Offset: 0.5 + random offset based on candle position
  // Uses dynamic offsets based on 'candles' property (1-4)
  // ============================================================================
  
  // Candle - supports 1-4 candles with multi-point emission
  // From FlameParticle.class / RisingParticle.class:
  // - Lifetime: 8-12 ticks (0.4-0.6 sec), our flames look better with 0.6-1.0
  // - SMALL_FLAME is FlameParticle.scale(0.5)
  // - Friction: 0.96 per tick
  'candle': {
    requiresLit: true,
    multiPoint: true, // Emit from multiple positions based on 'candles' property
    particles: [
      {
        type: 'small_flame',
        rate: 6.0, // Steady flame appearance
        offset: [0.5, 0.5, 0.5], // Overridden by CANDLE_OFFSETS for multi-point
        offsetVariance: [0.0, 0.0, 0.0], // No variance - exact wick position
        velocity: [0, 0.03, 0], // Slow rise - candle flames hover more than rise
        velocityVariance: [0.015, 0.01, 0.015], // Small variance
        size: 0.12, // Visible flame
        sizeVariance: 0.03,
        lifetime: 0.8, // Longer lasting - 16 ticks (MC: 8-12 base + we want overlap)
        lifetimeVariance: 0.2,
        color: [1.0, 0.95, 0.8], // Warmer, less saturated
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5, // Gradual fade
        friction: 0.96, // MC friction
      },
      {
        type: 'smoke',
        rate: 2.0, // Occasional smoke wisps
        offset: [0.5, 0.55, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.08, 0], // Rises above flame
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.06,
        sizeVariance: 0.02,
        lifetime: 1.0,
        lifetimeVariance: 0.3,
        color: [0.6, 0.6, 0.6],
        alpha: 0.3,
        fadeIn: 0.1,
        fadeOut: 0.6,
        friction: 0.98,
      },
    ],
  },
  
  // Candle cake (single candle on cake) - same settings as regular candle
  'candle_cake': {
    requiresLit: true,
    particles: [
      {
        type: 'small_flame',
        rate: 6.0,
        offset: [0.5, 0.9, 0.5], // Higher on cake
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.03, 0],
        velocityVariance: [0.015, 0.01, 0.015],
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 0.8,
        lifetimeVariance: 0.2,
        color: [1.0, 0.95, 0.8],
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.5,
        friction: 0.96,
      },
      {
        type: 'smoke',
        rate: 2.0,
        offset: [0.5, 0.95, 0.5],
        offsetVariance: [0.0, 0.0, 0.0],
        velocity: [0, 0.08, 0],
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.06,
        sizeVariance: 0.02,
        lifetime: 1.0,
        lifetimeVariance: 0.3,
        color: [0.6, 0.6, 0.6],
        alpha: 0.3,
        fadeIn: 0.1,
        fadeOut: 0.6,
        friction: 0.98,
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
  
  // Lava block - occasional bubbles/sparks that sputter up and fall
  'lava': {
    particles: [
      {
        type: 'lava',
        rate: 0.3, // Occasional sparks
        offset: [0.5, 1.0, 0.5], // Surface of lava
        offsetVariance: [0.4, 0.0, 0.4], // Spread across block
        velocity: [0, 1.5, 0], // Pop UP (then falls due to gravity)
        velocityVariance: [0.4, 0.5, 0.4], // Random arc trajectory
        size: 0.2, // Visible size
        sizeVariance: 0.06,
        lifetime: 3.5, // Long enough to arc and rest
        lifetimeVariance: 1.0,
        color: [1.0, 1.0, 1.0], // Use texture color (lava.png is already orange)
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.3,
        friction: 0.999, // MC: very little air resistance
        gravity: 0.75, // MC: heavy gravity - sputtering arc
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
  
  // ============================================================================
  // SPORE BLOSSOM PARTICLES
  // From SporeBlossomBlock.class:
  // - ADD_PARTICLE_ATTEMPTS = 14 (per animateTick)
  // - PARTICLE_XZ_RADIUS = 10 blocks (horizontal spawn radius)
  // - PARTICLE_Y_MAX = 16 blocks (max downward distance)
  // - 0.7 probability per attempt
  // - Uses FALLING_SPORE_BLOSSOM (drip from block) + SPORE_BLOSSOM_AIR (ambient area)
  // ============================================================================
  
  'spore_blossom': {
    // Spore blossom hangs from ceiling - flower is in LOWER portion of block (y ~0.3)
    // DECOMPILED FROM MINECRAFT BYTECODE:
    // DripParticle.class: gravity=0.06, friction=0.98, size=0.01
    // SporeBlossomFallProvider.class: lifetime=64 ticks, velocity=0.005, color=[0.32,0.50,0.22]
    // SuspendedParticle.class: size=0.125 (quadSize)
    //
    // CONVERSIONS APPLIED:
    // - lifetime: 64 ticks / 20 = 3.2 seconds
    // - velocity: 0.005 * 20 = 0.1 blocks/sec
    // - gravity: 0.06 * 20 = 1.2 (BV formula: vy -= gravity * ticksElapsed * 0.05)
    // - friction: 0.98 (same, applied per tick)
    // - size: MC scale 0.01 base, quadSize ~0.125 → ~0.1 blocks visible
    areaEmitter: true,
    particles: [
      {
        // Direct drips from the blossom (DripParticle$FallingParticle)
        type: 'falling_spore_blossom',
        rate: 2.0,
        offset: [0.5, 0.3, 0.5], // Flower hangs from ceiling
        offsetVariance: [0.25, 0.0, 0.25],
        velocity: [0, -0.1, 0], // MC: 0.005/tick * 20 = 0.1 blocks/sec
        velocityVariance: [0.02, 0.02, 0.02],
        size: 0.18, // Visible drip - MC quadSize ~0.125 but appears larger
        sizeVariance: 0.04,
        lifetime: 3.2, // MC: 64 ticks
        lifetimeVariance: 0.8,
        color: [0.32, 0.50, 0.22], // GREEN - exact MC values
        alpha: 0.9,
        fadeIn: 0.1,
        fadeOut: 0.1, // MC: 0.9 end alpha
        friction: 0.98, // MC: exact value
        gravity: 1.2, // MC: 0.06 * 20 = 1.2
        hasPhysics: true,
      },
      {
        // Ambient floating spores (SuspendedParticle)
        // MC: ADD_PARTICLE_ATTEMPTS=14, chance=0.7, animateTick ~5/sec = ~50 particles/sec
        // MC spawns in 10-block XZ radius, 16 blocks down
        // MC has lateral velocity: xd/zd up to ±0.8, yd = -0.8
        type: 'spore_blossom_air',
        rate: 25.0, // High density like MC (~50/sec but scaled for visual balance)
        offset: [0.5, -6.0, 0.5], // Center of spawn volume (8 blocks below)
        offsetVariance: [10.0, 6.0, 10.0], // MC: 10 block XZ radius, 16 blocks down
        velocity: [0, -0.4, 0], // Base downward drift
        velocityVariance: [0.4, 0.1, 0.4], // MC: lateral movement ±0.8 blocks/sec
        size: 0.15, // Visible floating spore - slightly smaller than drip
        sizeVariance: 0.04,
        lifetime: 4.0, // Shorter life but more particles
        lifetimeVariance: 1.5,
        color: [0.32, 0.50, 0.22], // GREEN
        alpha: 0.8,
        fadeIn: 0.1,
        fadeOut: 0.4,
        friction: 0.99, // Slight friction for natural movement
        gravity: 0.0, // No gravity - drifts at constant speed
        hasPhysics: false,
      },
    ],
  },
  
  // ============================================================================
  // FALLING LEAF PARTICLES
  // From FallingLeavesParticle.class:
  // - INITIAL_LIFETIME = 300 ticks (15 seconds)
  // - gravity = 0.0025
  // - size scale = 1.2
  // - Has rotation (rotSpeed) and lateral flow (xaFlowScale, zaFlowScale)
  // - Spawns below leaves blocks with leafParticleChance
  // ============================================================================
  
  // Base tinted leaves config (oak, birch, jungle, acacia, dark_oak, spruce, mangrove, azalea)
  '_tinted_leaves_base': {
    particles: [
      {
        type: 'tinted_leaves',
        rate: 0.3, // Low rate - leaves fall occasionally
        offset: [0.5, -0.1, 0.5], // Just below block
        offsetVariance: [0.4, 0.0, 0.4],
        velocity: [0, -0.3, 0], // Gentle fall
        velocityVariance: [0.15, 0.1, 0.15], // Lateral drift
        size: 0.12, // MC: 1.2 scale on ~0.1 base
        sizeVariance: 0.03,
        lifetime: 12.0, // MC: 300 ticks = 15s, but we cap for performance
        lifetimeVariance: 4.0,
        color: [0.4, 0.7, 0.3], // Default green tint (biome would override)
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.3,
        friction: 0.995, // Very slow decay
        gravity: 0.05, // MC: 0.0025 * 20 = 0.05
        hasPhysics: true,
      },
    ],
  },
  
  // Cherry leaves (pink - untinted)
  'cherry_leaves': {
    particles: [
      {
        type: 'cherry_leaves',
        rate: 0.5, // Cherry is more prolific
        offset: [0.5, -0.1, 0.5],
        offsetVariance: [0.4, 0.0, 0.4],
        velocity: [0, -0.25, 0],
        velocityVariance: [0.2, 0.1, 0.2], // More lateral sway
        size: 0.12,
        sizeVariance: 0.03,
        lifetime: 10.0,
        lifetimeVariance: 3.0,
        color: [1.0, 0.7, 0.8], // Pink tint
        alpha: 1.0,
        fadeIn: 0.0,
        fadeOut: 0.3,
        friction: 0.995,
        gravity: 0.04,
        hasPhysics: true,
      },
    ],
  },
};

// ============================================================================
// TINTED LEAVES BLOCK ALIASES
// All standard tree leaves use the same tinted particle config
// ============================================================================
const TINTED_LEAVES_BLOCKS = [
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves',
  'azalea_leaves', 'flowering_azalea_leaves',
];

for (const block of TINTED_LEAVES_BLOCKS) {
  BLOCK_EMITTERS[block] = BLOCK_EMITTERS['_tinted_leaves_base'];
}

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
    this.qualityMultiplier = 1.0; // Applied to spawn rates (set by manager)
    
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
    if (!this.active || !this.config || !particleSystem) {
      // Debug: log why we're returning early
      if (!this._loggedSkip) {
        console.warn(`[EmitterInstance] Skipping update: active=${this.active}, config=${!!this.config}, particleSystem=${!!particleSystem}`);
        this._loggedSkip = true;
      }
      return;
    }
    
    for (let i = 0; i < this.config.particles.length; i++) {
      const pConfig = this.config.particles[i];
      this.timers[i] += deltaTime;
      
      // Apply quality multiplier to spawn rate
      const effectiveRate = pConfig.rate * this.qualityMultiplier;
      if (effectiveRate <= 0) continue; // Skip if quality is too low
      
      const spawnInterval = 1.0 / effectiveRate;
      
      while (this.timers[i] >= spawnInterval) {
        this.timers[i] -= spawnInterval;
        this._spawnParticle(pConfig, particleSystem);
      }
    }
  }
  
  /**
   * Get base offset for this particle, handling multi-point emitters (candles)
   * @returns {[number, number, number]} Base offset in block coordinates
   */
  _getBaseOffset(config) {
    // Handle multi-point candle emission
    if (this.config.multiPoint && this.blockType.includes('candle') && !this.blockType.includes('cake')) {
      // Get candle count from properties (1-4)
      const candleCount = parseInt(this.properties.candles, 10) || 1;
      const offsets = CANDLE_OFFSETS[candleCount] || CANDLE_OFFSETS[1];
      
      // Pick a random candle position to spawn at
      const randomIndex = Math.floor(Math.random() * offsets.length);
      return offsets[randomIndex];
    }
    
    // Handle candle cake (single position, but different from regular candle)
    if (this.blockType.includes('candle_cake')) {
      return CANDLE_CAKE_OFFSET;
    }
    
    // Default: use config offset
    return config.offset;
  }
  
  /**
   * Spawn a single particle with the given config
   */
  _spawnParticle(config, particleSystem) {
    // Get base offset (handles multi-point emitters like candles)
    const baseOffset = this._getBaseOffset(config);
    
    // Calculate offset with variance
    const offset = [
      baseOffset[0] + (Math.random() - 0.5) * 2 * config.offsetVariance[0],
      baseOffset[1] + (Math.random() - 0.5) * 2 * config.offsetVariance[1],
      baseOffset[2] + (Math.random() - 0.5) * 2 * config.offsetVariance[2],
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
      gravity: config.gravity ?? 0, // For sputtering particles (lava uses 0.75)
      // hasPhysics: false for smoke particles (they pass through blocks)
      // MC: BaseAshSmokeParticle sets hasPhysics = false
      hasPhysics: config.hasPhysics ?? !SMOKE_PARTICLE_TYPES.has(config.type),
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

// Quality multipliers matching Minecraft's particle settings
const QUALITY_MULTIPLIERS = {
  'all': 1.0,       // 100% - full particle rate
  'decreased': 0.67, // 67% - 33% reduction
  'minimal': 0.1,    // 10% - heavily reduced
};

/**
 * ParticleEmitterManager - Manages all emitter instances
 * 
 * Simple approach: All blocks use EmitterInstance objects.
 * Distance culling ensures only nearby emitters are updated each frame.
 */
export class ParticleEmitterManager {
  constructor() {
    // Map of position key -> EmitterInstance
    this.emitters = new Map();
    
    // Maximum distance from camera to update emitters (default: 3 chunks = 48 blocks)
    this.maxDistance = 48;
    
    // Quality setting: 'all', 'decreased', 'minimal'
    this.quality = 'all';
    this.qualityMultiplier = 1.0;
    
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
    const config = BLOCK_EMITTERS[normalizedType];
    if (!config) {
      return;
    }
    
    // Check if block requires lit=true state
    if (config.requiresLit) {
      const litValue = properties.lit;
      const isLit = litValue === true || litValue === 'true';
      if (!isLit) {
        return;
      }
    }
    
    const key = `${x},${y},${z}`;
    
    // Don't add duplicates
    if (this.emitters.has(key)) return;
    
    const emitter = new EmitterInstance(normalizedType, x, y, z, properties);
    emitter.qualityMultiplier = this.qualityMultiplier;
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
    
    // Debug: log occasionally
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
  
  /**
   * Set particle quality level
   * @param {string} quality - 'all', 'decreased', or 'minimal'
   */
  setQuality(quality) {
    this.quality = quality;
    this.qualityMultiplier = QUALITY_MULTIPLIERS[quality] || 1.0;
    
    // Update all existing emitters with the new quality multiplier
    for (const emitter of this.emitters.values()) {
      emitter.qualityMultiplier = this.qualityMultiplier;
    }
  }
  
  /**
   * Get current quality multiplier
   */
  getQualityMultiplier() {
    return this.qualityMultiplier;
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

