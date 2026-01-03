/**
 * AnimationRegistry - Central registry for animated texture metadata
 * 
 * Maps texture paths to animation data including:
 * - Frame count and frame order
 * - Timing (frametime in ticks)
 * - Interpolation settings
 * - Atlas indices for each frame
 * 
 * Used by the shader to compute the correct frame to display based on time.
 * 
 * FRAME SEQUENCE TEXTURE:
 * To handle custom frame orders (like lava which plays 0→19→18→1), we create
 * a "frame sequence" texture. This is a 1D texture where each texel stores the
 * actual atlas index to display at that point in the animation cycle.
 * 
 * For example, an animation with frames=[0,1,2,1] would have a sequence of
 * 4 entries, where the shader can look up the atlas index for any cycle position.
 */

/**
 * Animation data for a single animated texture
 * @typedef {Object} AnimationEntry
 * @property {number} baseIndex - Atlas index of the first frame
 * @property {number} frameCount - Total number of physical frames in the texture
 * @property {number} cycleLength - Length of the animation cycle (frames.length or frameCount)
 * @property {number} frametime - Ticks per frame (20 ticks = 1 second)
 * @property {number[]|null} frames - Custom frame order, or null for sequential
 * @property {boolean} interpolate - Whether to interpolate between frames
 * @property {number} sequenceStart - Start index in the frame sequence texture
 */

class AnimationRegistry {
  constructor() {
    // Map<texturePath, AnimationEntry>
    this.animations = new Map();
    
    // Map<atlasIndex, AnimationEntry> for fast lookup by index
    this.indexToAnimation = new Map();
    
    // Array of all base atlas indices that are animated
    // Used to quickly check if an index is animated
    this.animatedIndices = new Set();
    
    // Frame sequence data: pre-expanded list of atlas indices for each animation cycle position
    // Used to handle custom frame orders in shaders
    this.frameSequence = [];
    
    // Current position in frame sequence (for allocating new sequences)
    this.sequencePosition = 0;
  }
  
  /**
   * Clear all registered animations
   */
  clear() {
    this.animations.clear();
    this.indexToAnimation.clear();
    this.animatedIndices.clear();
    this.frameSequence = [];
    this.sequencePosition = 0;
  }
  
  /**
   * Register an animated texture
   * @param {string} texturePath - Texture path (e.g., "textures/block/water_still.png")
   * @param {number} baseIndex - Atlas index of the first frame
   * @param {number} frameCount - Total number of physical frames in texture
   * @param {number} frametime - Ticks per frame
   * @param {number[]|null} frames - Custom frame order, or null for sequential
   * @param {boolean} interpolate - Whether to interpolate between frames
   */
  register(texturePath, baseIndex, frameCount, frametime = 1, frames = null, interpolate = false) {
    // Calculate cycle length: frames.length if custom order, otherwise frameCount
    const cycleLength = (frames && frames.length > 0) ? frames.length : frameCount;
    
    // Allocate space in frame sequence and store the sequence start
    const sequenceStart = this.sequencePosition;
    
    // Build the frame sequence for this animation
    for (let i = 0; i < cycleLength; i++) {
      let physicalFrame;
      if (frames && frames.length > 0) {
        // Custom frame order
        const frameSpec = frames[i];
        if (typeof frameSpec === 'number') {
          physicalFrame = frameSpec;
        } else if (typeof frameSpec === 'object' && frameSpec.index !== undefined) {
          physicalFrame = frameSpec.index;
        } else {
          physicalFrame = i % frameCount;
        }
      } else {
        // Sequential order
        physicalFrame = i;
      }
      // Store the actual atlas index for this cycle position
      this.frameSequence.push(baseIndex + physicalFrame);
    }
    this.sequencePosition += cycleLength;
    
    const entry = {
      baseIndex,
      frameCount,
      cycleLength,
      frametime,
      frames,
      interpolate,
      sequenceStart,
    };
    
    this.animations.set(texturePath, entry);
    this.indexToAnimation.set(baseIndex, entry);
    this.animatedIndices.add(baseIndex);
  }
  
  /**
   * Get animation entry by texture path
   * @param {string} texturePath 
   * @returns {AnimationEntry|null}
   */
  getByPath(texturePath) {
    return this.animations.get(texturePath) || null;
  }
  
  /**
   * Get animation entry by atlas index
   * @param {number} atlasIndex 
   * @returns {AnimationEntry|null}
   */
  getByIndex(atlasIndex) {
    return this.indexToAnimation.get(atlasIndex) || null;
  }
  
  /**
   * Check if an atlas index is animated
   * @param {number} atlasIndex 
   * @returns {boolean}
   */
  isAnimated(atlasIndex) {
    return this.animatedIndices.has(atlasIndex);
  }
  
  /**
   * Get the total number of animated textures
   * @returns {number}
   */
  get count() {
    return this.animations.size;
  }
  
  /**
   * Calculate the current frame index for an animation at a given time
   * @param {AnimationEntry} entry - Animation entry
   * @param {number} timeSeconds - Current time in seconds
   * @returns {number} The atlas index to use
   */
  static getCurrentFrame(entry, timeSeconds) {
    if (!entry || entry.cycleLength <= 1) {
      return entry?.baseIndex || 0;
    }
    
    // Convert time to ticks (20 ticks per second, matching Minecraft)
    const ticks = timeSeconds * 20;
    
    // Calculate frame progress using cycleLength
    const ticksPerCycle = entry.frametime * entry.cycleLength;
    const cycleTicks = ticks % ticksPerCycle;
    const cycleFrameIndex = Math.floor(cycleTicks / entry.frametime);
    
    // Apply custom frame order if specified
    let physicalFrame = cycleFrameIndex;
    if (entry.frames && entry.frames.length > 0) {
      // Custom frame order: frames array maps cycle index to physical frame
      const frameSpec = entry.frames[cycleFrameIndex % entry.frames.length];
      
      // Frame spec can be just a number, or { index, time }
      if (typeof frameSpec === 'number') {
        physicalFrame = frameSpec;
      } else if (typeof frameSpec === 'object' && frameSpec.index !== undefined) {
        physicalFrame = frameSpec.index;
      }
    }
    
    return entry.baseIndex + physicalFrame;
  }
  
  /**
   * Get interpolation data for smooth frame transitions
   * @param {AnimationEntry} entry - Animation entry
   * @param {number} timeSeconds - Current time in seconds
   * @returns {{ currentFrame: number, nextFrame: number, progress: number }}
   */
  static getInterpolatedFrame(entry, timeSeconds) {
    if (!entry || entry.cycleLength <= 1) {
      const frame = entry?.baseIndex || 0;
      return { currentFrame: frame, nextFrame: frame, progress: 0 };
    }
    
    const ticks = timeSeconds * 20;
    const ticksPerCycle = entry.frametime * entry.cycleLength;
    const cycleTicks = ticks % ticksPerCycle;
    
    const exactFrame = cycleTicks / entry.frametime;
    const currentCycleIndex = Math.floor(exactFrame);
    const progress = exactFrame - currentCycleIndex;
    const nextCycleIndex = (currentCycleIndex + 1) % entry.cycleLength;
    
    let currentPhysicalFrame = currentCycleIndex;
    let nextPhysicalFrame = nextCycleIndex;
    
    // Apply custom frame order
    if (entry.frames && entry.frames.length > 0) {
      const getFrame = (idx) => {
        const spec = entry.frames[idx % entry.frames.length];
        return typeof spec === 'number' ? spec : spec.index;
      };
      currentPhysicalFrame = getFrame(currentCycleIndex);
      nextPhysicalFrame = getFrame(nextCycleIndex);
    }
    
    return {
      currentFrame: entry.baseIndex + currentPhysicalFrame,
      nextFrame: entry.baseIndex + nextPhysicalFrame,
      progress: entry.interpolate ? progress : 0,
    };
  }
  
  /**
   * Build animation data texture for shader consumption
   * Creates a texture where each texel encodes animation info for an atlas index
   * 
   * RGBA channels:
   * - R: sequenceStart (index into frame sequence texture)
   * - G: cycleLength (number of frames in animation cycle)
   * - B: frametime (ticks per frame)
   * - A: interpolate (0 or 1)
   * 
   * @param {number} atlasSize - Total number of atlas slots
   * @returns {{ data: Float32Array, width: number, height: number }}
   */
  buildAnimationDataTexture(atlasSize) {
    // Create a 1D texture (encoded as width x 1)
    // Each pixel stores: (sequenceStart, cycleLength, frametime, interpolate)
    const width = Math.max(atlasSize, 1);
    const height = 1;
    const data = new Float32Array(width * 4);
    
    // Default: all textures are not animated (cycleLength=1)
    // For non-animated textures, we still need to provide a valid sequence lookup
    // We'll handle this by having the shader check cycleLength <= 1
    for (let i = 0; i < width; i++) {
      data[i * 4 + 0] = 0;     // sequenceStart = 0 (unused for non-animated)
      data[i * 4 + 1] = 1;     // cycleLength = 1 (not animated)
      data[i * 4 + 2] = 1;     // frametime = 1
      data[i * 4 + 3] = 0;     // interpolate = false
    }
    
    // Fill in animated entries
    for (const entry of this.indexToAnimation.values()) {
      const idx = entry.baseIndex;
      if (idx >= 0 && idx < width) {
        data[idx * 4 + 0] = entry.sequenceStart;
        data[idx * 4 + 1] = entry.cycleLength;
        data[idx * 4 + 2] = entry.frametime;
        data[idx * 4 + 3] = entry.interpolate ? 1 : 0;
      }
    }
    
    return { data, width, height };
  }
  
  /**
   * Build frame sequence texture for shader consumption
   * This is a 1D texture where each texel contains the atlas index to use
   * at that position in an animation cycle.
   * 
   * @returns {{ data: Float32Array, width: number, height: number }}
   */
  buildFrameSequenceTexture() {
    const width = Math.max(this.frameSequence.length, 1);
    const height = 1;
    // Using RGBA format for compatibility, but only R channel is used
    const data = new Float32Array(width * 4);
    
    for (let i = 0; i < this.frameSequence.length; i++) {
      data[i * 4 + 0] = this.frameSequence[i];  // Atlas index
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 1;
    }
    
    // If no animations, provide a dummy entry
    if (this.frameSequence.length === 0) {
      data[0] = 0;
      data[1] = 0;
      data[2] = 0;
      data[3] = 1;
    }
    
    return { data, width, height };
  }
  
  /**
   * Debug: log all registered animations
   */
  debugLog() {
    console.log(`[AnimationRegistry] ${this.count} animated textures:`);
    for (const [path, entry] of this.animations) {
      console.log(`  ${path}: ${entry.frameCount} frames, ${entry.frametime} ticks/frame, base=${entry.baseIndex}`);
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the animation registry singleton
 */
export function getAnimationRegistry() {
  if (!instance) {
    instance = new AnimationRegistry();
  }
  return instance;
}

export { AnimationRegistry };
export default AnimationRegistry;

