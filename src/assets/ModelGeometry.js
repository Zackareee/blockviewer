/**
 * ModelGeometry - Pre-computes geometry from Minecraft block models
 * 
 * Converts model elements (boxes) to GPU-ready vertex data.
 * Caches geometry for each unique model+rotation+uvlock combination.
 * 
 * Handles:
 * - Block-level X/Y rotation from blockstate variants
 * - Face-level UV rotation from model face definitions
 * - UV lock (uvlock) - keeps UVs world-aligned when model is rotated
 */

// Face definitions: vertices in counter-clockwise order when viewed from outside
const FACE_VERTICES = {
  // Each face: 4 vertices, each vertex is [x, y, z] offset from box origin
  // Coordinates are normalized [0-1] within the element bounds
  down:  [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]], // -Y
  up:    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], // +Y
  north: [[1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0]], // -Z
  south: [[0, 1, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1]], // +Z
  west:  [[0, 1, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0]], // -X
  east:  [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 1]], // +X
};

const FACE_NORMALS = {
  down:  [0, -1, 0],
  up:    [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west:  [-1, 0, 0],
  east:  [1, 0, 0],
};

// Cullface direction to neighbor offset
const CULLFACE_OFFSETS = {
  down:  [0, -1, 0],
  up:    [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west:  [-1, 0, 0],
  east:  [1, 0, 0],
};

/**
 * Pre-computed geometry for a model variant
 * @typedef {Object} CompiledGeometry
 * @property {Float32Array} positions - Vertex positions (3 floats per vertex)
 * @property {Float32Array} normals - Vertex normals (3 floats per vertex)
 * @property {Float32Array} uvs - UV coordinates (2 floats per vertex)
 * @property {Uint16Array} indices - Triangle indices
 * @property {Array} cullFaces - Per-face cullface info [{start, count, cullface, texture, bounds}]
 *   - bounds: {minX, minY, minZ, maxX, maxY, maxZ} - face position in block-space [0-1]
 * @property {number} vertexCount - Total vertices
 * @property {boolean} isFullCube - Whether this is a standard full cube
 * @property {string|null} primaryTexture - The main texture used by this model (for non-cube blocks)
 */

// Default UV coordinates for faces when not specified in model
// Maps face name to how element bounds map to UV coordinates
// Each entry: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] for the 4 vertices
// In Minecraft, UV (0,0) is top-left, (16,16) is bottom-right
const FACE_UV_MAPPING = {
  // For each face, we need to map element-space coords to UV coords
  // The 4 vertices in FACE_VERTICES use [0,1] template coords
  // We map these to [u1,v1] -> [u2,v2] from the model's uv spec
  // 
  // Minecraft's UV mapping accounts for face orientation in how it maps element
  // corners to UV coordinates. For 'down', Minecraft already swaps the Z-to-UV
  // mapping compared to 'up' in the model format, so both faces use the same
  // weight mapping here (the model's UV specification handles the difference).
  down:  [[0, 0], [1, 0], [1, 1], [0, 1]],  // Y- face: matches 'up' - model UV handles orientation
  up:    [[0, 0], [1, 0], [1, 1], [0, 1]],  // Y+ face: X→U, Z→V 
  north: [[1, 0], [0, 0], [0, 1], [1, 1]],  // Z- face: X→U (flipped), Y→V
  south: [[0, 0], [1, 0], [1, 1], [0, 1]],  // Z+ face: X→U, Y→V
  west:  [[1, 0], [0, 0], [0, 1], [1, 1]],  // X- face: Z→U (flipped), Y→V
  east:  [[0, 0], [1, 0], [1, 1], [0, 1]],  // X+ face: Z→U, Y→V
};

class ModelGeometry {
  constructor() {
    // Cache: "modelPath|x|y" → CompiledGeometry
    this.cache = new Map();
    
    // Reusable arrays for building geometry
    this._tempVec3 = new Float32Array(3);
    this._tempMat3 = new Float32Array(9);
  }

  /**
   * Get or compute geometry for a model variant
   * @param {Object} resolvedModel - Resolved model from ModelResolver
   * @param {number} rotX - X rotation (0, 90, 180, 270)
   * @param {number} rotY - Y rotation (0, 90, 180, 270)
   * @param {string} modelPath - Model path for cache key (e.g., "block/stone_slab")
   * @param {boolean} uvlock - If true, UVs remain world-aligned when model is rotated
   * @returns {CompiledGeometry}
   */
  getGeometry(resolvedModel, rotX = 0, rotY = 0, modelPath = null, uvlock = false) {
    if (!resolvedModel || !resolvedModel.elements) {
      return null;
    }

    // Build cache key from model path, rotation, and uvlock
    // If no path provided, fall back to element count (less reliable but still useful)
    const pathKey = modelPath || `elements_${resolvedModel.elements.length}`;
    const cacheKey = `${pathKey}|${rotX}|${rotY}|${uvlock ? 1 : 0}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    
    // Compute and cache geometry
    const geometry = this._computeGeometry(resolvedModel, rotX, rotY, uvlock);
    this.cache.set(cacheKey, geometry);
    return geometry;
  }

  /**
   * Compute geometry from model elements
   * @param {Object} model - Resolved model with elements
   * @param {number} rotX - Block-level X rotation (0, 90, 180, 270)
   * @param {number} rotY - Block-level Y rotation (0, 90, 180, 270)
   * @param {boolean} uvlock - If true, counter-rotate UVs to maintain world orientation
   */
  _computeGeometry(model, rotX, rotY, uvlock = false) {
    const elements = model.elements;
    
    // Count total faces for allocation
    let totalFaces = 0;
    for (const el of elements) {
      if (el.faces) {
        totalFaces += Object.keys(el.faces).length;
      }
    }

    // Pre-allocate arrays (4 verts per face, 6 indices per face)
    const positions = new Float32Array(totalFaces * 4 * 3);
    const normals = new Float32Array(totalFaces * 4 * 3);
    const uvs = new Float32Array(totalFaces * 4 * 2); // 2 UV coords per vertex
    const indices = new Uint16Array(totalFaces * 6);
    const cullFaces = [];

    let vertexOffset = 0;
    let uvOffset = 0;
    let indexOffset = 0;
    let faceIndex = 0;

    // Build rotation matrix for block-level rotation
    const rotMatrix = this._buildRotationMatrix(rotX, rotY);

    // Small offset to prevent z-fighting on thin blocks (in block units)
    // These values need to be large enough to prevent z-fighting but small enough
    // to not be visually noticeable (at 16 pixels per block, 0.005 = ~0.08 pixels)
    const THIN_FACE_OFFSET = 0.005;
    const THIN_THRESHOLD = 0.02; // Elements thinner than this get offset
    
    // For cross-pattern blocks with multiple thin elements, we also need to offset
    // entire elements apart from each other to prevent z-fighting at intersections
    const ELEMENT_OFFSET = 0.002;
    
    // Pre-compute element bounds for internal face culling
    // This detects when faces from different elements overlap within the same model
    const elementBounds = elements.map(el => ({
      minX: el.from[0] / 16, minY: el.from[1] / 16, minZ: el.from[2] / 16,
      maxX: el.to[0] / 16, maxY: el.to[1] / 16, maxZ: el.to[2] / 16,
    }));
    
    // Helper to check if a face is internal (hidden by other elements)
    // Detection methods:
    // 1. Face-to-face: another element's opposite face at same position fully covers this face
    // 2. Volume (strict): face is entirely inside another element's volume
    // 3. Touching volume: face is at the boundary of another element and covered by it
    const isInternalFace = (elementIdx, faceName, from, to) => {
      const EPSILON = 0.001;
      
      for (let otherIdx = 0; otherIdx < elements.length; otherIdx++) {
        if (otherIdx === elementIdx) continue;
        
        const other = elementBounds[otherIdx];
        
        switch (faceName) {
          case 'up': { // This element's top face (at to[1])
            const faceY = to[1];
            // Face-to-face: another element's bottom at same Y, fully covers
            if (Math.abs(other.minY - faceY) < EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            // Volume: face at or inside other's Y range, other covers face's X/Z
            if (faceY >= other.minY - EPSILON && faceY < other.maxY - EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            break;
          }
          case 'down': { // This element's bottom face (at from[1])
            const faceY = from[1];
            if (Math.abs(other.maxY - faceY) < EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            // Volume: face at or inside other's Y range
            if (faceY > other.minY + EPSILON && faceY <= other.maxY + EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            break;
          }
          case 'east': { // This element's +X face (at to[0])
            const faceX = to[0];
            if (Math.abs(other.minX - faceX) < EPSILON) {
              if (other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            if (faceX >= other.minX - EPSILON && faceX < other.maxX - EPSILON) {
              if (other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            break;
          }
          case 'west': { // This element's -X face (at from[0])
            const faceX = from[0];
            if (Math.abs(other.maxX - faceX) < EPSILON) {
              if (other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            if (faceX > other.minX + EPSILON && faceX <= other.maxX + EPSILON) {
              if (other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON &&
                  other.minZ <= from[2] + EPSILON && other.maxZ >= to[2] - EPSILON) {
                return true;
              }
            }
            break;
          }
          case 'south': { // This element's +Z face (at to[2])
            const faceZ = to[2];
            if (Math.abs(other.minZ - faceZ) < EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON) {
                return true;
              }
            }
            if (faceZ >= other.minZ - EPSILON && faceZ < other.maxZ - EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON) {
                return true;
              }
            }
            break;
          }
          case 'north': { // This element's -Z face (at from[2])
            const faceZ = from[2];
            if (Math.abs(other.maxZ - faceZ) < EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON) {
                return true;
              }
            }
            if (faceZ > other.minZ + EPSILON && faceZ <= other.maxZ + EPSILON) {
              if (other.minX <= from[0] + EPSILON && other.maxX >= to[0] - EPSILON &&
                  other.minY <= from[1] + EPSILON && other.maxY >= to[1] - EPSILON) {
                return true;
              }
            }
            break;
          }
        }
      }
      return false;
    };

    for (let elementIdx = 0; elementIdx < elements.length; elementIdx++) {
      const element = elements[elementIdx];
      // Element bounds in [0-16] space, convert to [0-1]
      const from = element.from.map(v => v / 16);
      const to = element.to.map(v => v / 16);
      
      // Whether to apply directional face shading (default true in Minecraft)
      // Cross-model plants like grass and ferns have shade: false
      const elementShade = element.shade !== false;

      // Calculate element thickness in each axis
      const sizeX = Math.abs(to[0] - from[0]);
      const sizeY = Math.abs(to[1] - from[1]);
      const sizeZ = Math.abs(to[2] - from[2]);

      // Element-level rotation (optional)
      const elRot = element.rotation;

      for (const [faceName, faceData] of Object.entries(element.faces || {})) {
        const faceVerts = FACE_VERTICES[faceName];
        const faceNormal = FACE_NORMALS[faceName];
        
        if (!faceVerts) continue;
        
        // Skip internal faces - faces covered by other elements in the same model
        // This prevents z-fighting seams within multi-element blocks like stairs
        if (elements.length > 1 && isInternalFace(elementIdx, faceName, from, to)) {
          continue;
        }

        const faceStartVertex = vertexOffset / 3;
        const faceStartIndex = indexOffset;

        // Determine if this face needs an offset to prevent z-fighting
        const isThinElement = sizeX < THIN_THRESHOLD || sizeZ < THIN_THRESHOLD || sizeY < THIN_THRESHOLD;
        const hasElementRotation = !!elRot;
        
        // Compute offset for z-fighting prevention
        let normalOffsetX = 0, normalOffsetY = 0, normalOffsetZ = 0;
        
        // Count how many thin rotated elements there are (for cross-pattern detection)
        // Cross patterns have 2+ thin elements with the SAME rotation axis (typically Y)
        let thinRotatedCount = 0;
        let sameAxisRotation = true;
        const thisRotAxis = elRot?.axis;
        for (const el of elements) {
          const elFrom = el.from.map(v => v / 16);
          const elTo = el.to.map(v => v / 16);
          const elSizeX = Math.abs(elTo[0] - elFrom[0]);
          const elSizeY = Math.abs(elTo[1] - elFrom[1]);
          const elSizeZ = Math.abs(elTo[2] - elFrom[2]);
          const elIsThin = elSizeX < THIN_THRESHOLD || elSizeY < THIN_THRESHOLD || elSizeZ < THIN_THRESHOLD;
          if (elIsThin && el.rotation) {
            thinRotatedCount++;
            if (el.rotation.axis !== thisRotAxis) sameAxisRotation = false;
          }
        }
        
        // Cross-pattern: multiple thin elements with same-axis rotation that intersect
        // For these, we offset ENTIRE elements (not individual faces) to separate panes
        const isCrossPattern = thinRotatedCount >= 2 && sameAxisRotation && hasElementRotation;
        
        if (isThinElement && isCrossPattern) {
          // Offset entire pane along its thin axis to separate from other panes
          const elementSign = (elementIdx % 2 === 0) ? 1 : -1;
          if (sizeZ < THIN_THRESHOLD) normalOffsetZ = ELEMENT_OFFSET * elementSign;
          if (sizeX < THIN_THRESHOLD) normalOffsetX = ELEMENT_OFFSET * elementSign;
          if (sizeY < THIN_THRESHOLD) normalOffsetY = ELEMENT_OFFSET * elementSign;
        }
        // For any OTHER thin element (rotated or not), offset faces along their normals
        // This handles: diagonal rails, sunflower face, lily pads, flat rails, carpets, etc.
        else if (isThinElement) {
          // For flat horizontal planes (thin in Y), offset up/down faces apart
          if (sizeY < THIN_THRESHOLD) {
            if (faceName === 'up') normalOffsetY = THIN_FACE_OFFSET;
            else if (faceName === 'down') normalOffsetY = -THIN_FACE_OFFSET;
          }
          // For flat vertical planes (thin in Z), offset north/south faces apart
          if (sizeZ < THIN_THRESHOLD) {
            if (faceName === 'north') normalOffsetZ = -THIN_FACE_OFFSET;
            else if (faceName === 'south') normalOffsetZ = THIN_FACE_OFFSET;
          }
          // For flat vertical planes (thin in X), offset east/west faces apart
          if (sizeX < THIN_THRESHOLD) {
            if (faceName === 'west') normalOffsetX = -THIN_FACE_OFFSET;
            else if (faceName === 'east') normalOffsetX = THIN_FACE_OFFSET;
          }
        }

        // Generate 4 vertices for this face
        for (let i = 0; i < 4; i++) {
          const template = faceVerts[i];
          
          // Interpolate within element bounds
          let x = from[0] + template[0] * (to[0] - from[0]);
          let y = from[1] + template[1] * (to[1] - from[1]);
          let z = from[2] + template[2] * (to[2] - from[2]);

          // For rotated elements, apply the offset in element-local space,
          // then rotate everything together
          if (hasElementRotation) {
            // Add offset in local space before rotation
            x += normalOffsetX;
            y += normalOffsetY;
            z += normalOffsetZ;
            // Apply element rotation to both position and offset
            [x, y, z] = this._applyElementRotation(x, y, z, elRot);
          } else {
            // Non-rotated elements: apply offset directly
            x += normalOffsetX;
            y += normalOffsetY;
            z += normalOffsetZ;
          }

          // Apply block rotation
          if (rotX !== 0 || rotY !== 0) {
            [x, y, z] = this._applyRotation(x - 0.5, y - 0.5, z - 0.5, rotMatrix);
            x += 0.5; y += 0.5; z += 0.5;
          }

          positions[vertexOffset++] = x;
          positions[vertexOffset++] = y;
          positions[vertexOffset++] = z;
        }

        // Compute face bounds from the 4 vertices just written
        // This is used for partial-block-to-partial-block culling
        let faceMinX = Infinity, faceMinY = Infinity, faceMinZ = Infinity;
        let faceMaxX = -Infinity, faceMaxY = -Infinity, faceMaxZ = -Infinity;
        for (let i = 0; i < 4; i++) {
          const px = positions[faceStartVertex * 3 + i * 3];
          const py = positions[faceStartVertex * 3 + i * 3 + 1];
          const pz = positions[faceStartVertex * 3 + i * 3 + 2];
          if (px < faceMinX) faceMinX = px;
          if (py < faceMinY) faceMinY = py;
          if (pz < faceMinZ) faceMinZ = pz;
          if (px > faceMaxX) faceMaxX = px;
          if (py > faceMaxY) faceMaxY = py;
          if (pz > faceMaxZ) faceMaxZ = pz;
        }
        const faceBounds = { minX: faceMinX, minY: faceMinY, minZ: faceMinZ, maxX: faceMaxX, maxY: faceMaxY, maxZ: faceMaxZ };

        // Generate normal (rotated if needed)
        let nx = faceNormal[0], ny = faceNormal[1], nz = faceNormal[2];
        if (rotX !== 0 || rotY !== 0) {
          [nx, ny, nz] = this._applyRotation(nx, ny, nz, rotMatrix);
        }
        
        for (let i = 0; i < 4; i++) {
          normals[faceStartVertex * 3 + i * 3] = nx;
          normals[faceStartVertex * 3 + i * 3 + 1] = ny;
          normals[faceStartVertex * 3 + i * 3 + 2] = nz;
        }

        // Generate UV coordinates from model data
        // faceData.uv is [u1, v1, u2, v2] in 0-16 range
        // Default to element bounds if not specified
        let u1, v1, u2, v2;
        if (faceData.uv) {
          u1 = faceData.uv[0] / 16;
          v1 = faceData.uv[1] / 16;
          u2 = faceData.uv[2] / 16;
          v2 = faceData.uv[3] / 16;
        } else {
          // Default UV based on element bounds (in 0-16 space, converted to 0-1)
          // This matches Minecraft's default behavior when uv is not specified
          const elemFrom = element.from;
          const elemTo = element.to;
          
          // Map element coords to UV based on face
          switch (faceName) {
            case 'up':
              u1 = elemFrom[0] / 16; v1 = elemFrom[2] / 16;
              u2 = elemTo[0] / 16;   v2 = elemTo[2] / 16;
              break;
            case 'down':
              u1 = elemFrom[0] / 16; v1 = (16 - elemTo[2]) / 16;
              u2 = elemTo[0] / 16;   v2 = (16 - elemFrom[2]) / 16;
              break;
            case 'north':
              u1 = (16 - elemTo[0]) / 16;   v1 = (16 - elemTo[1]) / 16;
              u2 = (16 - elemFrom[0]) / 16; v2 = (16 - elemFrom[1]) / 16;
              break;
            case 'south':
              u1 = elemFrom[0] / 16; v1 = (16 - elemTo[1]) / 16;
              u2 = elemTo[0] / 16;   v2 = (16 - elemFrom[1]) / 16;
              break;
            case 'west':
              u1 = elemFrom[2] / 16; v1 = (16 - elemTo[1]) / 16;
              u2 = elemTo[2] / 16;   v2 = (16 - elemFrom[1]) / 16;
              break;
            case 'east':
              u1 = (16 - elemTo[2]) / 16;   v1 = (16 - elemTo[1]) / 16;
              u2 = (16 - elemFrom[2]) / 16; v2 = (16 - elemFrom[1]) / 16;
              break;
            default:
              u1 = 0; v1 = 0; u2 = 1; v2 = 1;
          }
        }
        
        // Calculate total UV rotation for this face:
        // 1. Face-level rotation from model definition (faceData.rotation)
        // 2. UV lock counter-rotation when block is rotated with uvlock: true
        let totalUVRotation = 0;
        
        // Face-level rotation from model (0, 90, 180, 270 degrees)
        const faceRotation = faceData.rotation || 0;
        totalUVRotation += faceRotation;
        
        // UV lock: when enabled, counter-rotate UVs based on how the face moved
        // This keeps the texture oriented to world space instead of model space
        if (uvlock && (rotX !== 0 || rotY !== 0)) {
          const uvlockRotation = this._computeUVLockRotation(faceName, rotX, rotY);
          totalUVRotation += uvlockRotation;
        }
        
        // Normalize to 0, 90, 180, or 270
        totalUVRotation = ((totalUVRotation % 360) + 360) % 360;
        
        // Map UVs to the 4 vertices using the face's UV mapping
        // Apply rotation by remapping the vertex indices
        const uvMap = FACE_UV_MAPPING[faceName];
        const rotSteps = Math.floor(totalUVRotation / 90);
        
        for (let i = 0; i < 4; i++) {
          // Rotate UV indices: shift vertex mapping by rotation steps
          const rotatedIdx = (i + rotSteps) % 4;
          const uWeight = uvMap[rotatedIdx][0];
          const vWeight = uvMap[rotatedIdx][1];
          uvs[uvOffset++] = u1 + uWeight * (u2 - u1);
          uvs[uvOffset++] = v1 + vWeight * (v2 - v1);
        }

        // Generate indices (2 triangles) - CCW winding for front faces
        indices[indexOffset++] = faceStartVertex;
        indices[indexOffset++] = faceStartVertex + 2;
        indices[indexOffset++] = faceStartVertex + 1;
        indices[indexOffset++] = faceStartVertex;
        indices[indexOffset++] = faceStartVertex + 3;
        indices[indexOffset++] = faceStartVertex + 2;

        // Track cullface info
        let cullface = faceData.cullface || null;
        if (cullface && (rotX !== 0 || rotY !== 0)) {
          cullface = this._rotateCullface(cullface, rotX, rotY);
        }

        // Resolve texture reference for this face
        let texturePath = null;
        if (faceData.texture) {
          texturePath = this._resolveTextureRef(faceData.texture, model.textures);
        }

        // Get tintindex from face data (-1 means no tinting)
        const tintindex = faceData.tintindex !== undefined ? faceData.tintindex : -1;

        // Determine the actual face direction from rotated normal
        // This is the direction the face is pointing after all rotations
        let faceDirection = null;
        if (Math.abs(nx) > 0.9) faceDirection = nx > 0 ? 'east' : 'west';
        else if (Math.abs(ny) > 0.9) faceDirection = ny > 0 ? 'up' : 'down';
        else if (Math.abs(nz) > 0.9) faceDirection = nz > 0 ? 'south' : 'north';
        
        cullFaces.push({
          faceIndex: faceIndex++,
          indexStart: faceStartIndex,
          indexCount: 6,
          cullface: cullface,
          texture: texturePath,
          tintindex: tintindex,
          bounds: faceBounds,
          faceDirection: faceDirection, // Actual direction the face points
          shade: elementShade, // Whether to apply directional face shading
        });
      }
    }

    // Check if this is a full cube
    const isFullCube = elements.length === 1 && 
      elements[0].from[0] === 0 && elements[0].from[1] === 0 && elements[0].from[2] === 0 &&
      elements[0].to[0] === 16 && elements[0].to[1] === 16 && elements[0].to[2] === 16;

    // Determine primary texture (first texture found, used for non-cube blocks)
    let primaryTexture = null;
    for (const face of cullFaces) {
      if (face.texture) {
        primaryTexture = face.texture;
        break;
      }
    }

    return {
      positions: positions.subarray(0, vertexOffset),
      normals: normals.subarray(0, vertexOffset),
      uvs: uvs.subarray(0, uvOffset),
      indices: indices.subarray(0, indexOffset),
      cullFaces,
      vertexCount: vertexOffset / 3,
      isFullCube,
      primaryTexture,
    };
  }

  /**
   * Resolve a texture reference like "#cross" to the actual texture path
   */
  _resolveTextureRef(ref, textures) {
    if (!ref) return null;
    if (!ref.startsWith('#')) {
      // Already a direct path
      return ref.replace('minecraft:', '');
    }
    
    const varName = ref.substring(1);
    const resolved = textures?.[varName];
    if (!resolved) return null;
    
    // Recursively resolve if it's another reference
    if (resolved.startsWith('#')) {
      return this._resolveTextureRef(resolved, textures);
    }
    
    return resolved.replace('minecraft:', '');
  }

  /**
   * Build 3x3 rotation matrix for X and Y rotations
   * Minecraft uses clockwise rotation when viewed from the positive axis
   */
  _buildRotationMatrix(rotX, rotY) {
    // Negate angles to convert from Minecraft's clockwise to standard CCW
    const radX = (-rotX * Math.PI) / 180;
    const radY = (-rotY * Math.PI) / 180;
    
    const cosX = Math.cos(radX), sinX = Math.sin(radX);
    const cosY = Math.cos(radY), sinY = Math.sin(radY);

    // Combined rotation: X first, then Y (Minecraft's actual order)
    // Matrix = Y * X (matrix multiplication is reverse of application order)
    return [
      cosY,   sinX * sinY,   cosX * sinY,
      0,      cosX,         -sinX,
      -sinY,  sinX * cosY,   cosX * cosY,
    ];
  }

  /**
   * Apply 3x3 rotation matrix to a point
   */
  _applyRotation(x, y, z, m) {
    return [
      m[0] * x + m[1] * y + m[2] * z,
      m[3] * x + m[4] * y + m[5] * z,
      m[6] * x + m[7] * y + m[8] * z,
    ];
  }

  /**
   * Apply element-level rotation
   */
  _applyElementRotation(x, y, z, rot) {
    const origin = rot.origin.map(v => v / 16);
    const angle = (rot.angle * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Translate to origin
    x -= origin[0];
    y -= origin[1];
    z -= origin[2];

    // Rotate around axis
    let rx, ry, rz;
    switch (rot.axis) {
      case 'x':
        rx = x;
        ry = cos * y - sin * z;
        rz = sin * y + cos * z;
        break;
      case 'y':
        rx = cos * x + sin * z;
        ry = y;
        rz = -sin * x + cos * z;
        break;
      case 'z':
        rx = cos * x - sin * y;
        ry = sin * x + cos * y;
        rz = z;
        break;
      default:
        rx = x; ry = y; rz = z;
    }

    // Apply rescale if needed (makes rotated elements maintain size in the rotation plane)
    // Only scale the axes perpendicular to the rotation axis
    if (rot.rescale) {
      const scale = 1 / Math.cos(angle);
      switch (rot.axis) {
        case 'x':
          // X-axis rotation: scale Y and Z
          ry *= scale;
          rz *= scale;
          break;
        case 'y':
          // Y-axis rotation: scale X and Z
          rx *= scale;
          rz *= scale;
          break;
        case 'z':
          // Z-axis rotation: scale X and Y
          rx *= scale;
          ry *= scale;
          break;
      }
    }

    // Translate back
    return [
      rx + origin[0],
      ry + origin[1],
      rz + origin[2],
    ];
  }

  /**
   * Rotate a cullface direction
   * Uses negated angles to match Minecraft's clockwise rotation convention
   */
  _rotateCullface(cullface, rotX, rotY) {
    // Map cullface to direction vector
    const dir = [...CULLFACE_OFFSETS[cullface]];
    
    // Apply rotation: X first, then Y (Minecraft's order)
    const radX = (-rotX * Math.PI) / 180;
    const radY = (-rotY * Math.PI) / 180;
    
    // Rotate X first
    if (rotX !== 0) {
      const cosX = Math.cos(radX), sinX = Math.sin(radX);
      const y = dir[1], z = dir[2];
      dir[1] = Math.round(cosX * y - sinX * z);
      dir[2] = Math.round(sinX * y + cosX * z);
    }
    
    // Rotate Y second
    if (rotY !== 0) {
      const cosY = Math.cos(radY), sinY = Math.sin(radY);
      const x = dir[0], z = dir[2];
      dir[0] = Math.round(cosY * x + sinY * z);
      dir[2] = Math.round(-sinY * x + cosY * z);
    }

    // Map back to cullface name
    for (const [name, offset] of Object.entries(CULLFACE_OFFSETS)) {
      if (offset[0] === dir[0] && offset[1] === dir[1] && offset[2] === dir[2]) {
        return name;
      }
    }
    
    return null; // Invalid direction after rotation
  }

  /**
   * Compute UV counter-rotation for uvlock mode
   * When uvlock is true, UVs should remain world-aligned even when the model rotates.
   * This means we need to counter-rotate the UVs based on how the face has moved.
   * 
   * @param {string} faceName - Original face name (before rotation)
   * @param {number} rotX - Block X rotation
   * @param {number} rotY - Block Y rotation  
   * @returns {number} UV rotation in degrees to counter the block rotation
   */
  _computeUVLockRotation(faceName, rotX, rotY) {
    // UV lock counter-rotation depends on:
    // 1. Which face we're on (determines which rotation axes affect it)
    // 2. How that face has been rotated
    //
    // The goal: after block rotation, the UV "up" direction should still point
    // toward world +Y (or the original texture "up" direction).
    
    // For Y-facing faces (up/down):
    // - Y rotation rotates the UVs directly
    // - X rotation doesn't affect UV orientation on these faces
    if (faceName === 'up') {
      // Y rotation rotates the up face, counter-rotate to maintain world orientation
      return -rotY;
    }
    if (faceName === 'down') {
      // Y rotation on down face needs opposite direction
      return rotY;
    }
    
    // For side faces (north/south/east/west):
    // - X rotation affects how the face tilts (which changes UV up direction)
    // - Y rotation moves which cardinal direction the face points but doesn't
    //   change the UV orientation within the face (texture up still points up)
    //
    // When X-rotated 90°, side faces become top/bottom oriented
    // When X-rotated 180°, side faces flip upside down
    
    // Handle X rotation effects on side faces
    if (rotX === 90) {
      // Side faces have rotated to point up/down
      // The UV "up" now points in the wrong direction
      // North face rotated 90° around X: texture up was +Y, now points -Z
      // We need to counter-rotate 180° to flip it back
      if (faceName === 'north') return 180;
      if (faceName === 'south') return 180;
      // East/west faces when X-rotated: counter-rotate based on Y rotation
      if (faceName === 'east') return 180 - rotY;
      if (faceName === 'west') return 180 + rotY;
    }
    else if (rotX === 180) {
      // Full X flip - all side faces are upside down
      return 180;
    }
    else if (rotX === 270) {
      // Same as X=90 but opposite direction
      if (faceName === 'north') return 180;
      if (faceName === 'south') return 180;
      if (faceName === 'east') return 180 + rotY;
      if (faceName === 'west') return 180 - rotY;
    }
    
    // No X rotation or X=0: Y rotation doesn't change UV orientation on side faces
    // because the face just moves to a different cardinal direction but texture
    // orientation within the face stays the same (up is still up)
    return 0;
  }

  /**
   * Clear geometry cache
   */
  clearCache() {
    this.cache.clear();
  }
}

// Singleton
let instance = null;

export function getModelGeometry() {
  if (!instance) {
    instance = new ModelGeometry();
  }
  return instance;
}

export { ModelGeometry, FACE_NORMALS, CULLFACE_OFFSETS };
export default ModelGeometry;

