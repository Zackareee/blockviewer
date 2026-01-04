/**
 * BeaconBeamManager - Manages beacon beam rendering
 * 
 * Implements Minecraft's beacon beam behavior:
 * - Traces upward from beacons to detect stained glass tinting
 * - Creates beam sections with averaged colors
 * - Renders two-layer beams (solid inner + translucent outer glow)
 * - Animates beam rotation (45°/sec like Minecraft)
 * 
 * From BeaconBlockEntity.class and BeaconRenderer.class:
 * - SOLID_BEAM_RADIUS = 0.2
 * - BEAM_GLOW_RADIUS = 0.25
 * - MAX_RENDER_Y = 2048
 * - Rotation speed = 45 degrees per second
 * - Colors averaged via ARGB.average() when stained glass stacks
 */

import * as THREE from 'three';

// Beam rendering constants from Minecraft
const SOLID_BEAM_RADIUS = 0.2;
const BEAM_GLOW_RADIUS = 0.25;
const MAX_BEAM_HEIGHT = 2048;
const ROTATION_SPEED = Math.PI / 4; // 45 degrees per second in radians

// Stained glass colors (from DyeColor.getTextureDiffuseColor)
// These are the diffuse colors used for beacon beams
const STAINED_GLASS_COLORS = {
  'white_stained_glass': 0xF9FFFE,
  'orange_stained_glass': 0xF9801D,
  'magenta_stained_glass': 0xC74EBD,
  'light_blue_stained_glass': 0x3AB3DA,
  'yellow_stained_glass': 0xFED83D,
  'lime_stained_glass': 0x80C71F,
  'pink_stained_glass': 0xF38BAA,
  'gray_stained_glass': 0x474F52,
  'light_gray_stained_glass': 0x9D9D97,
  'cyan_stained_glass': 0x169C9C,
  'purple_stained_glass': 0x8932B8,
  'blue_stained_glass': 0x3C44AA,
  'brown_stained_glass': 0x835432,
  'green_stained_glass': 0x5E7C16,
  'red_stained_glass': 0xB02E26,
  'black_stained_glass': 0x1D1D21,
  // Panes have the same colors
  'white_stained_glass_pane': 0xF9FFFE,
  'orange_stained_glass_pane': 0xF9801D,
  'magenta_stained_glass_pane': 0xC74EBD,
  'light_blue_stained_glass_pane': 0x3AB3DA,
  'yellow_stained_glass_pane': 0xFED83D,
  'lime_stained_glass_pane': 0x80C71F,
  'pink_stained_glass_pane': 0xF38BAA,
  'gray_stained_glass_pane': 0x474F52,
  'light_gray_stained_glass_pane': 0x9D9D97,
  'cyan_stained_glass_pane': 0x169C9C,
  'purple_stained_glass_pane': 0x8932B8,
  'blue_stained_glass_pane': 0x3C44AA,
  'brown_stained_glass_pane': 0x835432,
  'green_stained_glass_pane': 0x5E7C16,
  'red_stained_glass_pane': 0xB02E26,
  'black_stained_glass_pane': 0x1D1D21,
};

// Blocks that don't block the beam
const TRANSPARENT_BLOCKS = new Set([
  'air', 'cave_air', 'void_air',
  'glass', 'glass_pane', 'tinted_glass',
  ...Object.keys(STAINED_GLASS_COLORS),
  'beacon', // The beacon itself
]);

/**
 * Represents a single section of a beacon beam with a specific color and height
 */
class BeamSection {
  constructor(color, startY, height) {
    this.color = color; // Packed RGB int
    this.startY = startY;
    this.height = height;
  }
  
  /**
   * Get normalized RGB components
   */
  getRGB() {
    return {
      r: ((this.color >> 16) & 0xFF) / 255,
      g: ((this.color >> 8) & 0xFF) / 255,
      b: (this.color & 0xFF) / 255,
    };
  }
}

/**
 * Average two ARGB colors (Minecraft's ARGB.average)
 */
function averageColors(color1, color2) {
  const r1 = (color1 >> 16) & 0xFF;
  const g1 = (color1 >> 8) & 0xFF;
  const b1 = color1 & 0xFF;
  
  const r2 = (color2 >> 16) & 0xFF;
  const g2 = (color2 >> 8) & 0xFF;
  const b2 = color2 & 0xFF;
  
  const r = Math.round((r1 + r2) / 2);
  const g = Math.round((g1 + g2) / 2);
  const b = Math.round((b1 + b2) / 2);
  
  return (r << 16) | (g << 8) | b;
}

/**
 * BeaconBeamManager - Handles all beacon beam rendering
 */
export class BeaconBeamManager {
  constructor() {
    this.beacons = new Map(); // Map<string, BeaconData>
    this.group = new THREE.Group();
    this.group.name = 'BeaconBeams';
    
    this.beamTexture = null;
    this.solidMaterial = null;
    this.glowMaterial = null;
    
    this.blockLookupFn = null; // Function to look up block at position
    this.worldOffset = { x: 0, y: 0, z: 0 };
    
    this.animationTime = 0;
  }
  
  /**
   * Set the block lookup function
   * @param {Function} fn - (x, y, z) => blockName
   */
  setBlockLookup(fn) {
    this.blockLookupFn = fn;
  }
  
  /**
   * Set the world offset for coordinate conversion
   */
  setWorldOffset(ox, oy, oz) {
    this.worldOffset = { x: ox, y: oy, z: oz };
  }
  
  /**
   * Initialize beam textures and materials
   * @param {TexturePackManager} [packManager] - Optional pack manager (will use procedural texture if not provided)
   */
  async initialize(packManager = null) {
    // Try to load beacon beam texture from pack if available
    let textureLoaded = false;
    
    if (packManager) {
      const beamTexturePath = 'textures/entity/beacon_beam.png';
      const beamTextureData = packManager.getTexture(beamTexturePath);
      
      if (beamTextureData) {
        try {
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = URL.createObjectURL(beamTextureData);
          });
          
          this.beamTexture = new THREE.Texture(img);
          this.beamTexture.magFilter = THREE.LinearFilter;
          this.beamTexture.minFilter = THREE.LinearFilter;
          this.beamTexture.wrapS = THREE.RepeatWrapping;
          this.beamTexture.wrapT = THREE.RepeatWrapping;
          this.beamTexture.needsUpdate = true;
          textureLoaded = true;
        } catch (e) {
          console.warn('[BeaconBeamManager] Failed to load beacon texture, using procedural');
        }
      }
    }
    
    // Create procedural beacon beam texture (gradient from center to edges)
    if (!textureLoaded) {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      
      // Create a subtle radial gradient for the beam texture
      // Minecraft's beacon_beam.png is mostly solid white with slight transparency variation
      const gradient = ctx.createLinearGradient(0, 0, 16, 0);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
      gradient.addColorStop(0.3, 'rgba(255, 255, 255, 1.0)');
      gradient.addColorStop(0.7, 'rgba(255, 255, 255, 1.0)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.8)');
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 16, 16);
      
      this.beamTexture = new THREE.CanvasTexture(canvas);
      this.beamTexture.wrapS = THREE.RepeatWrapping;
      this.beamTexture.wrapT = THREE.RepeatWrapping;
    }
    
    // Create materials
    this._createMaterials();
    
    console.log('[BeaconBeamManager] Initialized');
  }
  
  /**
   * Create beam materials
   */
  _createMaterials() {
    // Solid inner beam material
    this.solidMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: this.beamTexture },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uAlpha: { value: 1.0 },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vY;
        
        void main() {
          vUv = uv;
          vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uTexture;
        uniform vec3 uColor;
        uniform float uAlpha;
        uniform float uTime;
        
        varying vec2 vUv;
        varying float vY;
        
        void main() {
          // Scroll texture vertically
          vec2 scrolledUV = vec2(vUv.x, vUv.y - uTime * 0.5);
          vec4 texColor = texture2D(uTexture, scrolledUV);
          
          // Apply beam color
          vec3 finalColor = texColor.rgb * uColor;
          
          gl_FragColor = vec4(finalColor, texColor.a * uAlpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    
    // Outer glow material (more transparent, additive-like)
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: this.beamTexture },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uAlpha: { value: 0.25 },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vY;
        
        void main() {
          vUv = uv;
          vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uTexture;
        uniform vec3 uColor;
        uniform float uAlpha;
        uniform float uTime;
        
        varying vec2 vUv;
        varying float vY;
        
        void main() {
          // Scroll texture vertically (slightly faster for glow)
          vec2 scrolledUV = vec2(vUv.x, vUv.y - uTime * 0.6);
          vec4 texColor = texture2D(uTexture, scrolledUV);
          
          // Apply beam color with glow effect
          vec3 finalColor = texColor.rgb * uColor;
          
          gl_FragColor = vec4(finalColor, texColor.a * uAlpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  
  /**
   * Register a beacon at the given position
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {number} z - World Z
   */
  addBeacon(x, y, z) {
    const key = `${x},${y},${z}`;
    if (this.beacons.has(key)) return;
    
    console.log(`[BeaconBeamManager] Adding beacon at ${x}, ${y}, ${z}`);
    
    const beaconData = {
      x, y, z,
      sections: [],
      meshes: [],
      needsUpdate: true,
    };
    
    this.beacons.set(key, beaconData);
    this._updateBeacon(beaconData);
  }
  
  /**
   * Remove a beacon
   */
  removeBeacon(x, y, z) {
    const key = `${x},${y},${z}`;
    const beaconData = this.beacons.get(key);
    if (!beaconData) return;
    
    // Remove meshes
    for (const mesh of beaconData.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    
    this.beacons.delete(key);
  }
  
  /**
   * Clear all beacons
   */
  clear() {
    for (const [key, beaconData] of this.beacons) {
      for (const mesh of beaconData.meshes) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.beacons.clear();
  }
  
  /**
   * Update beacon beam sections based on blocks above
   */
  _updateBeacon(beaconData) {
    if (!this.blockLookupFn) {
      console.warn('[BeaconBeamManager] No block lookup function set');
      return;
    }
    
    const { x, y, z } = beaconData;
    
    // Clear old meshes
    for (const mesh of beaconData.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    beaconData.meshes = [];
    beaconData.sections = [];
    
    // Trace upward and build sections
    let currentColor = 0xFFFFFF; // Default white beam
    let currentStartY = y + 1;
    let currentHeight = 0;
    
    for (let checkY = y + 1; checkY < y + MAX_BEAM_HEIGHT && checkY < 320; checkY++) {
      const blockName = this.blockLookupFn(x, checkY, z);
      
      // Check if block stops the beam
      if (!blockName || (!TRANSPARENT_BLOCKS.has(blockName) && !blockName.includes('stained_glass'))) {
        // Beam is blocked - finalize current section if any
        if (currentHeight > 0) {
          beaconData.sections.push(new BeamSection(currentColor, currentStartY, currentHeight));
        }
        break;
      }
      
      // Check if stained glass tints the beam
      const glassColor = STAINED_GLASS_COLORS[blockName];
      if (glassColor !== undefined) {
        // Finalize current section before color change
        if (currentHeight > 0) {
          beaconData.sections.push(new BeamSection(currentColor, currentStartY, currentHeight));
        }
        
        // Average with current color (Minecraft behavior)
        currentColor = averageColors(currentColor, glassColor);
        currentStartY = checkY + 1;
        currentHeight = 0;
      } else {
        // Continue current section
        currentHeight++;
      }
    }
    
    // Finalize last section if beam reached max height
    if (currentHeight > 0) {
      beaconData.sections.push(new BeamSection(currentColor, currentStartY, currentHeight));
    }
    
    console.log(`[BeaconBeamManager] Beacon at ${beaconData.x},${beaconData.y},${beaconData.z} has ${beaconData.sections.length} sections`);
    for (const s of beaconData.sections) {
      console.log(`  - Section: startY=${s.startY}, height=${s.height}, color=0x${s.color.toString(16)}`);
    }
    
    // Create meshes for each section
    this._createBeamMeshes(beaconData);
  }
  
  /**
   * Create beam meshes for a beacon
   */
  _createBeamMeshes(beaconData) {
    const { x, y, z, sections } = beaconData;
    
    // Apply world offset
    const worldX = x - this.worldOffset.x + 0.5; // Center of block
    const worldZ = z - this.worldOffset.z + 0.5;
    
    for (const section of sections) {
      const startY = section.startY - this.worldOffset.y;
      const rgb = section.getRGB();
      
      // Create inner solid beam
      const solidGeom = this._createBeamGeometry(SOLID_BEAM_RADIUS, section.height);
      const solidMesh = new THREE.Mesh(solidGeom, this.solidMaterial.clone());
      solidMesh.material.uniforms.uColor.value.setRGB(rgb.r, rgb.g, rgb.b);
      solidMesh.position.set(worldX, startY, worldZ);
      solidMesh.renderOrder = 1000; // Render after other objects
      this.group.add(solidMesh);
      beaconData.meshes.push(solidMesh);
      
      // Create outer glow beam
      const glowGeom = this._createBeamGeometry(BEAM_GLOW_RADIUS, section.height);
      const glowMesh = new THREE.Mesh(glowGeom, this.glowMaterial.clone());
      glowMesh.material.uniforms.uColor.value.setRGB(rgb.r, rgb.g, rgb.b);
      glowMesh.position.set(worldX, startY, worldZ);
      glowMesh.renderOrder = 1001;
      this.group.add(glowMesh);
      beaconData.meshes.push(glowMesh);
    }
  }
  
  /**
   * Create beam geometry (4-sided prism)
   */
  _createBeamGeometry(radius, height) {
    const geometry = new THREE.BufferGeometry();
    
    // 4-sided beam (like Minecraft)
    const vertices = [];
    const uvs = [];
    const indices = [];
    
    // UV repeat based on height
    const uvRepeat = height / 4; // Repeat every 4 blocks
    
    // Create 4 faces
    for (let face = 0; face < 4; face++) {
      const angle1 = (face * Math.PI / 2);
      const angle2 = ((face + 1) * Math.PI / 2);
      
      const x1 = Math.cos(angle1) * radius;
      const z1 = Math.sin(angle1) * radius;
      const x2 = Math.cos(angle2) * radius;
      const z2 = Math.sin(angle2) * radius;
      
      const baseIndex = vertices.length / 3;
      
      // 4 vertices per face
      vertices.push(
        x1, 0, z1,
        x2, 0, z2,
        x2, height, z2,
        x1, height, z1
      );
      
      // UVs
      uvs.push(
        0, 0,
        1, 0,
        1, uvRepeat,
        0, uvRepeat
      );
      
      // Two triangles per face
      indices.push(
        baseIndex, baseIndex + 1, baseIndex + 2,
        baseIndex, baseIndex + 2, baseIndex + 3
      );
    }
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    
    return geometry;
  }
  
  /**
   * Update animation
   * @param {number} deltaTime - Time since last update in seconds
   */
  update(deltaTime) {
    this.animationTime += deltaTime;
    
    // Update material uniforms for animation
    for (const [key, beaconData] of this.beacons) {
      for (const mesh of beaconData.meshes) {
        if (mesh.material.uniforms) {
          mesh.material.uniforms.uTime.value = this.animationTime;
        }
        
        // Rotate beam (45 degrees per second)
        mesh.rotation.y = this.animationTime * ROTATION_SPEED;
      }
    }
  }
  
  /**
   * Get the Three.js group containing all beam meshes
   */
  getGroup() {
    return this.group;
  }
  
  /**
   * Get beacon count
   */
  getBeaconCount() {
    return this.beacons.size;
  }
  
  /**
   * Refresh all beacons (call after block data is loaded)
   */
  refreshAll() {
    console.log(`[BeaconBeamManager] Refreshing ${this.beacons.size} beacons`);
    for (const [key, beaconData] of this.beacons) {
      this._updateBeacon(beaconData);
    }
  }
  
  /**
   * Dispose of all resources
   */
  dispose() {
    this.clear();
    
    if (this.beamTexture) {
      this.beamTexture.dispose();
    }
    if (this.solidMaterial) {
      this.solidMaterial.dispose();
    }
    if (this.glowMaterial) {
      this.glowMaterial.dispose();
    }
  }
}

export default BeaconBeamManager;

