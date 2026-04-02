import { registry } from '../../../registry.mjs';

import Vector from '../../../../shared/Vector.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { MeshModel } from '../MeshModel.ts';
import { PBRMaterial } from '../../../client/renderer/Materials.mjs';
import { GLTexture } from '../../../client/GL.mjs';

/**
 * Loader for Wavefront OBJ format (.obj)
 * Supports vertices, normals, texture coordinates, and triangulated faces.
 * Does not yet support materials (.mtl), groups, or advanced features.
 */
export class WavefrontOBJLoader extends ModelLoader {
  /**
   * Get magic numbers that identify this format
   * OBJ is text-based, so no magic number
   * @returns {number[]} Empty array
   */
  getMagicNumbers() {
    return [];
  }

  /**
   * Get file extensions for this format
   * @returns {string[]} Array of file extensions
   */
  getExtensions() {
    return ['.obj'];
  }

  /**
   * Get human-readable name of this loader
   * @returns {string} Loader name
   */
  getName() {
    return 'Wavefront .obj';
  }

  /**
   * Check if this loader can handle the given file
   * @param {ArrayBuffer} buffer The file buffer
   * @param {string} filename The filename
   * @returns {boolean} True if this loader can handle the file
   */
  canLoad(buffer, filename) {
    // Check file extension
    if (filename.toLowerCase().endsWith('.obj')) {
      return true;
    }

    // Could also check for OBJ text markers in the buffer
    // But extension check is sufficient for now
    return false;
  }

  /**
   * Load a Wavefront OBJ model from buffer
   * @param {ArrayBuffer} buffer The model file data
   * @param {string} name The model name/path
   * @returns {Promise<MeshModel>} The loaded model
   */
  async load(buffer, name) {
    const loadmodel = new MeshModel(name);

    // Convert ArrayBuffer to text
    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(buffer);

    // Parse OBJ format
    const objData = this._parseOBJ(text);

    // Build vertex arrays for WebGL (expand indexed format to flat arrays)
    const meshData = this._buildMeshData(objData);

    // Store in model
    loadmodel.vertices = meshData.vertices;
    loadmodel.normals = meshData.normals;
    loadmodel.texcoords = meshData.texcoords;
    loadmodel.indices = meshData.indices;
    loadmodel.numVertices = meshData.vertices.length / 3;
    loadmodel.numTriangles = meshData.indices.length / 3;

    // Calculate bounding box
    this._calculateBounds(loadmodel);

    // Generate tangents and bitangents for normal mapping
    if (loadmodel.normals && loadmodel.texcoords) {
      this._generateTangentSpace(loadmodel);
    }

    // Set texture name (convention: same as model name without .obj)
    const baseName = name.replace(/\.obj$/i, '.png').replace(/^models\//i, 'textures/');
    loadmodel.textureName = baseName;

    if (!registry.isDedicatedServer) {
      const mat = new PBRMaterial(baseName, 256, 256); // Placeholder material
      mat.diffuse = await GLTexture.FromImageFile(baseName);
      mat.width = mat.diffuse.width;
      mat.height = mat.diffuse.height;
      loadmodel.texture = mat;
    }

    loadmodel.needload = false;

    return loadmodel;
  }

  /**
   * Parse OBJ text format into indexed data
   * @protected
   * @param {string} text OBJ file content
   * @returns {object} Parsed OBJ data with positions, texcoords, normals, faces
   */
  _parseOBJ(text) {
    const positions = [];  // v entries
    const texcoords = [];  // vt entries
    const normals = [];    // vn entries
    const faces = [];      // f entries

    const lines = text.split('\n');

    for (let line of lines) {
      // Remove comments and trim whitespace
      const commentIndex = line.indexOf('#');
      if (commentIndex >= 0) {
        line = line.substring(0, commentIndex);
      }
      line = line.trim();

      if (line.length === 0) {
        continue;
      }

      const parts = line.split(/\s+/);
      const type = parts[0];

      switch (type) {
        case 'v': // Vertex position
          if (parts.length >= 4) {
            // Convert from OBJ convention to Quake's coordinate system
            // OBJ: X=right, Y=up, Z=back
            // Quake: X=forward, Y=left, Z=up
            // Transformation: Quake(x,y,z) = OBJ(x, -z, y)
            const x = parseFloat(parts[1]);
            const y = parseFloat(parts[2]);
            const z = parseFloat(parts[3]);
            positions.push(
              x,   // OBJ X -> Quake X (forward)
              -z,  // OBJ -Z -> Quake Y (left)
              y,   // OBJ Y -> Quake Z (up)
            );
          }
          break;

        case 'vt': // Texture coordinate
          if (parts.length >= 3) {
            texcoords.push(
              parseFloat(parts[1]),
              parseFloat(parts[2]),
            );
          }
          break;

        case 'vn': // Normal
          if (parts.length >= 4) {
            // Convert normals from OBJ to Quake coordinate system
            // Same transformation as positions: Quake(x,y,z) = OBJ(x, -z, y)
            const nx = parseFloat(parts[1]);
            const ny = parseFloat(parts[2]);
            const nz = parseFloat(parts[3]);
            normals.push(
              nx,   // OBJ X -> Quake X
              -nz,  // OBJ -Z -> Quake Y
              ny,   // OBJ Y -> Quake Z
            );
          }
          break;

        case 'f': // Face
          if (parts.length >= 4) {
            // Parse face vertices
            const faceVertices = [];
            for (let i = 1; i < parts.length; i++) {
              faceVertices.push(this._parseFaceVertex(parts[i]));
            }

            // Triangulate if needed (quad or n-gon)
            if (faceVertices.length === 3) {
              // Already a triangle
              faces.push(faceVertices);
            } else if (faceVertices.length === 4) {
              // Quad - split into two triangles
              faces.push([faceVertices[0], faceVertices[1], faceVertices[2]]);
              faces.push([faceVertices[0], faceVertices[2], faceVertices[3]]);
            } else if (faceVertices.length > 4) {
              // N-gon - fan triangulation
              for (let i = 1; i < faceVertices.length - 1; i++) {
                faces.push([faceVertices[0], faceVertices[i], faceVertices[i + 1]]);
              }
            }
          }
          break;

        // Ignore other types (g, o, mtllib, usemtl, s, etc.)
        default:
          break;
      }
    }

    return { positions, texcoords, normals, faces };
  }

  /**
   * Parse a face vertex specification (v, v/vt, v/vt/vn, v//vn)
   * @protected
   * @param {string} spec Face vertex specification
   * @returns {object} Object with v, vt, vn indices (1-based, can be negative)
   */
  _parseFaceVertex(spec) {
    const parts = spec.split('/');
    return {
      v: parts[0] ? parseInt(parts[0], 10) : 0,
      vt: parts[1] ? parseInt(parts[1], 10) : 0,
      vn: parts[2] ? parseInt(parts[2], 10) : 0,
    };
  }

  /**
   * Build mesh data from parsed OBJ (expand indices to flat arrays)
   * @protected
   * @param {object} objData Parsed OBJ data
   * @returns {object} Mesh data with flat vertices, normals, texcoords, indices
   */
  _buildMeshData(objData) {
    const vertices = [];
    const normals = [];
    const texcoords = [];
    const indices = [];

    const hasNormals = objData.normals.length > 0;
    const hasTexcoords = objData.texcoords.length > 0;

    // Vertex deduplication using a map
    const vertexMap = new Map();
    let nextIndex = 0;

    for (const face of objData.faces) {
      for (const fv of face) {
        // Convert OBJ 1-based indices to 0-based
        // Handle negative indices (count from end)
        const vIdx = this._resolveIndex(fv.v, objData.positions.length / 3);
        const vtIdx = hasTexcoords ? this._resolveIndex(fv.vt, objData.texcoords.length / 2) : -1;
        const vnIdx = hasNormals ? this._resolveIndex(fv.vn, objData.normals.length / 3) : -1;

        // Create unique key for this vertex combination
        const key = `${vIdx}/${vtIdx}/${vnIdx}`;

        if (vertexMap.has(key)) {
          // Reuse existing vertex
          indices.push(vertexMap.get(key));
        } else {
          // Add new vertex
          const index = nextIndex++;
          vertexMap.set(key, index);
          indices.push(index);

          // Add position
          if (vIdx >= 0) {
            vertices.push(
              objData.positions[vIdx * 3],
              objData.positions[vIdx * 3 + 1],
              objData.positions[vIdx * 3 + 2],
            );
          } else {
            vertices.push(0, 0, 0);
          }

          // Add texcoord
          if (vtIdx >= 0) {
            texcoords.push(
              objData.texcoords[vtIdx * 2],
              objData.texcoords[vtIdx * 2 + 1],
            );
          } else {
            texcoords.push(0, 0);
          }

          // Add normal
          if (vnIdx >= 0) {
            normals.push(
              objData.normals[vnIdx * 3],
              objData.normals[vnIdx * 3 + 1],
              objData.normals[vnIdx * 3 + 2],
            );
          } else {
            normals.push(0, 0, 1); // Default up normal
          }
        }
      }
    }

    // Convert to typed arrays
    return {
      vertices: new Float32Array(vertices),
      normals: hasNormals ? new Float32Array(normals) : null,
      texcoords: hasTexcoords ? new Float32Array(texcoords) : null,
      indices: nextIndex < 65536 ? new Uint16Array(indices) : new Uint32Array(indices),
    };
  }

  /**
   * Resolve OBJ index (1-based, negative) to 0-based array index
   * @protected
   * @param {number} index OBJ index
   * @param {number} arrayLength Length of the array being indexed
   * @returns {number} 0-based array index, or -1 if invalid
   */
  _resolveIndex(index, arrayLength) {
    if (index === 0) {
      return -1; // Invalid
    }
    if (index > 0) {
      return index - 1; // Convert 1-based to 0-based
    }
    // Negative index: count from end
    return arrayLength + index;
  }

  /**
   * Calculate bounding box for the model
   * @protected
   * @param {import('../MeshModel.ts').MeshModel} model The model
   */
  _calculateBounds(model) {
    if (!model.vertices || model.vertices.length === 0) {
      return;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < model.vertices.length; i += 3) {
      const x = model.vertices[i];
      const y = model.vertices[i + 1];
      const z = model.vertices[i + 2];

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }

    model.mins = new Vector(minX, minY, minZ);
    model.maxs = new Vector(maxX, maxY, maxZ);

    // Calculate bounding radius (distance from origin to furthest point)
    let maxDist = 0;
    for (let i = 0; i < model.vertices.length; i += 3) {
      const x = model.vertices[i];
      const y = model.vertices[i + 1];
      const z = model.vertices[i + 2];
      maxDist = Math.max(maxDist, Math.hypot(x, y, z));
    }
    model.boundingradius = maxDist;
  }

  /**
   * Generate tangent and bitangent vectors for normal mapping
   * Based on "Lengyel's Method" for computing tangent space basis
   * @protected
   * @param {import('../MeshModel.ts').MeshModel} model The model
   */
  _generateTangentSpace(model) {
    const numVerts = model.numVertices;
    const tangents = new Float32Array(numVerts * 3);
    const bitangents = new Float32Array(numVerts * 3);

    // Accumulate tangents and bitangents for each vertex
    const tan1 = new Float32Array(numVerts * 3);
    const tan2 = new Float32Array(numVerts * 3);

    // Calculate tangent and bitangent for each triangle
    for (let i = 0; i < model.indices.length; i += 3) {
      const i1 = model.indices[i];
      const i2 = model.indices[i + 1];
      const i3 = model.indices[i + 2];

      const v1 = [model.vertices[i1 * 3], model.vertices[i1 * 3 + 1], model.vertices[i1 * 3 + 2]];
      const v2 = [model.vertices[i2 * 3], model.vertices[i2 * 3 + 1], model.vertices[i2 * 3 + 2]];
      const v3 = [model.vertices[i3 * 3], model.vertices[i3 * 3 + 1], model.vertices[i3 * 3 + 2]];

      const w1 = [model.texcoords[i1 * 2], model.texcoords[i1 * 2 + 1]];
      const w2 = [model.texcoords[i2 * 2], model.texcoords[i2 * 2 + 1]];
      const w3 = [model.texcoords[i3 * 2], model.texcoords[i3 * 2 + 1]];

      const x1 = v2[0] - v1[0];
      const x2 = v3[0] - v1[0];
      const y1 = v2[1] - v1[1];
      const y2 = v3[1] - v1[1];
      const z1 = v2[2] - v1[2];
      const z2 = v3[2] - v1[2];

      const s1 = w2[0] - w1[0];
      const s2 = w3[0] - w1[0];
      const t1 = w2[1] - w1[1];
      const t2 = w3[1] - w1[1];

      const denom = (s1 * t2 - s2 * t1);
      const r = denom !== 0 ? 1.0 / denom : 0;

      const sdir = [
        (t2 * x1 - t1 * x2) * r,
        (t2 * y1 - t1 * y2) * r,
        (t2 * z1 - t1 * z2) * r,
      ];

      const tdir = [
        (s1 * x2 - s2 * x1) * r,
        (s1 * y2 - s2 * y1) * r,
        (s1 * z2 - s2 * z1) * r,
      ];

      // Accumulate
      for (const idx of [i1, i2, i3]) {
        tan1[idx * 3] += sdir[0];
        tan1[idx * 3 + 1] += sdir[1];
        tan1[idx * 3 + 2] += sdir[2];

        tan2[idx * 3] += tdir[0];
        tan2[idx * 3 + 1] += tdir[1];
        tan2[idx * 3 + 2] += tdir[2];
      }
    }

    // Orthogonalize and normalize
    for (let i = 0; i < numVerts; i++) {
      const n = [
        model.normals[i * 3],
        model.normals[i * 3 + 1],
        model.normals[i * 3 + 2],
      ];

      const t = [
        tan1[i * 3],
        tan1[i * 3 + 1],
        tan1[i * 3 + 2],
      ];

      // Gram-Schmidt orthogonalize
      const dot = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
      const tangent = [
        t[0] - n[0] * dot,
        t[1] - n[1] * dot,
        t[2] - n[2] * dot,
      ];

      // Normalize tangent
      const tLen = Math.hypot(tangent[0], tangent[1], tangent[2]);
      if (tLen > 0) {
        tangent[0] /= tLen;
        tangent[1] /= tLen;
        tangent[2] /= tLen;
      }

      tangents[i * 3] = tangent[0];
      tangents[i * 3 + 1] = tangent[1];
      tangents[i * 3 + 2] = tangent[2];

      // Calculate bitangent (cross product of normal and tangent)
      const bitangent = [
        n[1] * tangent[2] - n[2] * tangent[1],
        n[2] * tangent[0] - n[0] * tangent[2],
        n[0] * tangent[1] - n[1] * tangent[0],
      ];

      bitangents[i * 3] = bitangent[0];
      bitangents[i * 3 + 1] = bitangent[1];
      bitangents[i * 3 + 2] = bitangent[2];
    }

    model.tangents = tangents;
    model.bitangents = bitangents;
  }
}
