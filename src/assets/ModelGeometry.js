/**
 * ModelGeometry - Pre-computes geometry from Minecraft block models
 * 
 * Converts model elements (boxes) to GPU-ready vertex data.
 * Caches geometry for each unique model+rotation combination.
 * 
 * Uses vertex colors (no textures) for now.
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
 * @property {Array} cullFaces - Per-face cullface info [{start, count, cullface, texture}]
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
  // Standard mapping: vertex template [x, y] maps to UV based on face orientation
  down:  [[0, 1], [1, 1], [1, 0], [0, 0]],  // Y- face: X→U, Z→V
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
   * @returns {CompiledGeometry}
   */
  getGeometry(resolvedModel, rotX = 0, rotY = 0, modelPath = null) {
    if (!resolvedModel || !resolvedModel.elements) {
      return null;
    }

    // Build cache key from model path and rotation
    // If no path provided, fall back to element count (less reliable but still useful)
    const pathKey = modelPath || `elements_${resolvedModel.elements.length}`;
    const cacheKey = `${pathKey}|${rotX}|${rotY}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    
    // Compute and cache geometry
    const geometry = this._computeGeometry(resolvedModel, rotX, rotY);
    this.cache.set(cacheKey, geometry);
    return geometry;
  }

  /**
   * Compute geometry from model elements
   */
  _computeGeometry(model, rotX, rotY) {
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

    for (let elementIdx = 0; elementIdx < elements.length; elementIdx++) {
      const element = elements[elementIdx];
      // Element bounds in [0-16] space, convert to [0-1]
      const from = element.from.map(v => v / 16);
      const to = element.to.map(v => v / 16);

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
        
        // Map UVs to the 4 vertices using the face's UV mapping
        const uvMap = FACE_UV_MAPPING[faceName];
        for (let i = 0; i < 4; i++) {
          // uvMap[i] gives [u_weight, v_weight] where 0 = use u1/v1, 1 = use u2/v2
          const uWeight = uvMap[i][0];
          const vWeight = uvMap[i][1];
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

        cullFaces.push({
          faceIndex: faceIndex++,
          indexStart: faceStartIndex,
          indexCount: 6,
          cullface: cullface,
          texture: texturePath,
          tintindex: tintindex,
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

    // Combined rotation: Y first, then X
    // This matches Minecraft's rotation order
    return [
      cosY,          0,      sinY,
      sinX * sinY,   cosX,  -sinX * cosY,
      -cosX * sinY,  sinX,   cosX * cosY,
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
    
    // Apply rotation (negate angles for Minecraft's clockwise convention)
    const radX = (-rotX * Math.PI) / 180;
    const radY = (-rotY * Math.PI) / 180;
    
    // Rotate Y first
    if (rotY !== 0) {
      const cosY = Math.cos(radY), sinY = Math.sin(radY);
      const x = dir[0], z = dir[2];
      dir[0] = Math.round(cosY * x + sinY * z);
      dir[2] = Math.round(-sinY * x + cosY * z);
    }
    
    // Rotate X second
    if (rotX !== 0) {
      const cosX = Math.cos(radX), sinX = Math.sin(radX);
      const y = dir[1], z = dir[2];
      dir[1] = Math.round(cosX * y - sinX * z);
      dir[2] = Math.round(sinX * y + cosX * z);
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

