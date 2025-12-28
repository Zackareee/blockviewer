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
 * @property {Uint16Array} indices - Triangle indices
 * @property {Array} cullFaces - Per-face cullface info [{start, count, cullface}]
 * @property {number} vertexCount - Total vertices
 * @property {boolean} isFullCube - Whether this is a standard full cube
 */

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
   * @returns {CompiledGeometry}
   */
  getGeometry(resolvedModel, rotX = 0, rotY = 0) {
    if (!resolvedModel || !resolvedModel.elements) {
      return null;
    }

    // Check cache
    // We use object identity + rotation as key since models are cached
    const cacheKey = `${resolvedModel.elements.length}|${rotX}|${rotY}`;
    
    // For now, always recompute (proper caching needs model identity)
    return this._computeGeometry(resolvedModel, rotX, rotY);
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
    const indices = new Uint16Array(totalFaces * 6);
    const cullFaces = [];

    let vertexOffset = 0;
    let indexOffset = 0;
    let faceIndex = 0;

    // Build rotation matrix for block-level rotation
    const rotMatrix = this._buildRotationMatrix(rotX, rotY);

    for (const element of elements) {
      // Element bounds in [0-16] space, convert to [0-1]
      const from = element.from.map(v => v / 16);
      const to = element.to.map(v => v / 16);

      // Element-level rotation (optional)
      const elRot = element.rotation;

      for (const [faceName, faceData] of Object.entries(element.faces || {})) {
        const faceVerts = FACE_VERTICES[faceName];
        const faceNormal = FACE_NORMALS[faceName];
        
        if (!faceVerts) continue;

        const faceStartVertex = vertexOffset / 3;
        const faceStartIndex = indexOffset;

        // Compute rotated normal first
        let nx = faceNormal[0], ny = faceNormal[1], nz = faceNormal[2];
        if (rotX !== 0 || rotY !== 0) {
          [nx, ny, nz] = this._applyRotation(nx, ny, nz, rotMatrix);
        }

        // Only apply z-fighting offset to faces with cullface (flush with block boundary)
        // These are the faces that can z-fight with adjacent full blocks
        // Use a very small offset to avoid visible gaps
        const hasCullface = !!faceData.cullface;
        const Z_FIGHT_OFFSET = hasCullface ? 0.0005 : 0;
        const offsetX = nx * Z_FIGHT_OFFSET;
        const offsetY = ny * Z_FIGHT_OFFSET;
        const offsetZ = nz * Z_FIGHT_OFFSET;

        // Generate 4 vertices for this face
        for (let i = 0; i < 4; i++) {
          const template = faceVerts[i];
          
          // Interpolate within element bounds
          let x = from[0] + template[0] * (to[0] - from[0]);
          let y = from[1] + template[1] * (to[1] - from[1]);
          let z = from[2] + template[2] * (to[2] - from[2]);

          // Apply element rotation
          if (elRot) {
            [x, y, z] = this._applyElementRotation(x, y, z, elRot);
          }

          // Apply block rotation
          if (rotX !== 0 || rotY !== 0) {
            [x, y, z] = this._applyRotation(x - 0.5, y - 0.5, z - 0.5, rotMatrix);
            x += 0.5; y += 0.5; z += 0.5;
          }

          // Apply z-fighting offset along normal (only for cullface faces)
          positions[vertexOffset++] = x + offsetX;
          positions[vertexOffset++] = y + offsetY;
          positions[vertexOffset++] = z + offsetZ;
        }

        // Store normals for all 4 vertices
        for (let i = 0; i < 4; i++) {
          normals[faceStartVertex * 3 + i * 3] = nx;
          normals[faceStartVertex * 3 + i * 3 + 1] = ny;
          normals[faceStartVertex * 3 + i * 3 + 2] = nz;
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

        cullFaces.push({
          faceIndex: faceIndex++,
          indexStart: faceStartIndex,
          indexCount: 6,
          cullface: cullface,
        });
      }
    }

    // Check if this is a full cube
    const isFullCube = elements.length === 1 && 
      elements[0].from[0] === 0 && elements[0].from[1] === 0 && elements[0].from[2] === 0 &&
      elements[0].to[0] === 16 && elements[0].to[1] === 16 && elements[0].to[2] === 16;

    return {
      positions: positions.subarray(0, vertexOffset),
      normals: normals.subarray(0, vertexOffset),
      indices: indices.subarray(0, indexOffset),
      cullFaces,
      vertexCount: vertexOffset / 3,
      isFullCube,
    };
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

    // Apply rescale if needed (makes rotated elements fit in bounds)
    if (rot.rescale) {
      const scale = 1 / Math.cos(angle);
      rx *= scale;
      ry *= scale;
      rz *= scale;
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

