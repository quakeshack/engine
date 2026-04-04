import { registry } from '../../../registry.mjs';

import Vector from '../../../../shared/Vector.ts';
import { GLTexture } from '../../../client/GL.ts';
import { PBRMaterial } from '../../../client/renderer/Materials.mjs';
import { MeshModel } from '../MeshModel.ts';
import { ModelLoader } from '../ModelLoader.ts';

type TriangleVertexIndices = [number, number, number];
type TextureCoordinate = [number, number];

interface FaceVertex {
  readonly v: number;
  readonly vt: number;
  readonly vn: number;
}

interface ParsedOBJData {
  readonly positions: number[];
  readonly texcoords: number[];
  readonly normals: number[];
  readonly faces: FaceVertex[][];
}

interface MeshBuildData {
  readonly vertices: Float32Array;
  readonly normals: Float32Array | null;
  readonly texcoords: Float32Array | null;
  readonly indices: Uint16Array | Uint32Array;
}

/**
 * Loader for Wavefront OBJ format (.obj).
 * Supports vertices, normals, texture coordinates, and triangulated faces.
 * Does not yet support materials (.mtl), groups, or advanced features.
 */
export class WavefrontOBJLoader extends ModelLoader {
  override getMagicNumbers(): number[] {
    return [];
  }

  override getExtensions(): string[] {
    return ['.obj'];
  }

  override getName(): string {
    return 'Wavefront .obj';
  }

  override canLoad(buffer: ArrayBuffer, filename: string): boolean {
    if (filename.toLowerCase().endsWith('.obj')) {
      return true;
    }

    return super.canLoad(buffer, filename);
  }

  override async load(buffer: ArrayBuffer, name: string): Promise<MeshModel> {
    const loadmodel = new MeshModel(name);
    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(buffer);
    const objData = this.#parseOBJ(text);
    const meshData = this.#buildMeshData(objData);

    loadmodel.vertices = meshData.vertices;
    loadmodel.normals = meshData.normals;
    loadmodel.texcoords = meshData.texcoords;
    loadmodel.indices = meshData.indices;
    loadmodel.numVertices = meshData.vertices.length / 3;
    loadmodel.numTriangles = meshData.indices.length / 3;

    this.#calculateBounds(loadmodel);

    if (loadmodel.normals !== null && loadmodel.texcoords !== null) {
      this.#generateTangentSpace(loadmodel);
    }

    const baseName = name.replace(/\.obj$/i, '.png').replace(/^models\//i, 'textures/');
    loadmodel.textureName = baseName;

    if (!registry.isDedicatedServer) {
      const material = new PBRMaterial(baseName, 256, 256);
      material.diffuse = await GLTexture.FromImageFile(baseName);
      material.width = material.diffuse.width;
      material.height = material.diffuse.height;
      loadmodel.texture = material;
    }

    loadmodel.needload = false;

    return loadmodel;
  }

  /**
   * Parse OBJ text format into indexed mesh data.
   * @returns Parsed OBJ positions, texture coordinates, normals, and faces.
   */
  #parseOBJ(text: string): ParsedOBJData {
    const positions: number[] = [];
    const texcoords: number[] = [];
    const normals: number[] = [];
    const faces: FaceVertex[][] = [];
    const lines = text.split('\n');

    for (let line of lines) {
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
        case 'v':
          if (parts.length >= 4) {
            const x = parseFloat(parts[1]);
            const y = parseFloat(parts[2]);
            const z = parseFloat(parts[3]);
            positions.push(x, -z, y);
          }
          break;

        case 'vt':
          if (parts.length >= 3) {
            texcoords.push(parseFloat(parts[1]), parseFloat(parts[2]));
          }
          break;

        case 'vn':
          if (parts.length >= 4) {
            const nx = parseFloat(parts[1]);
            const ny = parseFloat(parts[2]);
            const nz = parseFloat(parts[3]);
            normals.push(nx, -nz, ny);
          }
          break;

        case 'f':
          if (parts.length >= 4) {
            this.#parseFace(parts, faces);
          }
          break;

        default:
          break;
      }
    }

    return { positions, texcoords, normals, faces };
  }

  /**
   * Parse a face record and append triangulated faces.
   */
  #parseFace(parts: string[], faces: FaceVertex[][]): void {
    const faceVertices: FaceVertex[] = [];

    for (let index = 1; index < parts.length; index++) {
      faceVertices.push(this.#parseFaceVertex(parts[index]));
    }

    if (faceVertices.length === 3) {
      faces.push(faceVertices);
      return;
    }

    if (faceVertices.length === 4) {
      faces.push([faceVertices[0], faceVertices[1], faceVertices[2]]);
      faces.push([faceVertices[0], faceVertices[2], faceVertices[3]]);
      return;
    }

    for (let index = 1; index < faceVertices.length - 1; index++) {
      faces.push([faceVertices[0], faceVertices[index], faceVertices[index + 1]]);
    }
  }

  /**
   * Parse a face vertex specification (`v`, `v/vt`, `v/vt/vn`, `v//vn`).
   * @returns Parsed OBJ face indices.
   */
  #parseFaceVertex(spec: string): FaceVertex {
    const parts = spec.split('/');

    return {
      v: parts[0] ? parseInt(parts[0], 10) : 0,
      vt: parts[1] ? parseInt(parts[1], 10) : 0,
      vn: parts[2] ? parseInt(parts[2], 10) : 0,
    };
  }

  /**
   * Build flat mesh buffers from parsed indexed OBJ data.
   * @returns Flat mesh buffers ready for upload to WebGL.
   */
  #buildMeshData(objData: ParsedOBJData): MeshBuildData {
    const vertices: number[] = [];
    const normals: number[] = [];
    const texcoords: number[] = [];
    const indices: number[] = [];
    const hasNormals = objData.normals.length > 0;
    const hasTexcoords = objData.texcoords.length > 0;
    const vertexMap = new Map<string, number>();
    let nextIndex = 0;

    for (const face of objData.faces) {
      for (const faceVertex of face) {
        const vIdx = this.#resolveIndex(faceVertex.v, objData.positions.length / 3);
        const vtIdx = hasTexcoords ? this.#resolveIndex(faceVertex.vt, objData.texcoords.length / 2) : -1;
        const vnIdx = hasNormals ? this.#resolveIndex(faceVertex.vn, objData.normals.length / 3) : -1;
        const key = `${vIdx}/${vtIdx}/${vnIdx}`;
        const existingIndex = vertexMap.get(key);

        if (existingIndex !== undefined) {
          indices.push(existingIndex);
          continue;
        }

        const index = nextIndex++;
        vertexMap.set(key, index);
        indices.push(index);

        this.#appendPosition(vertices, objData.positions, vIdx);
        this.#appendTexcoord(texcoords, objData.texcoords, vtIdx);
        this.#appendNormal(normals, objData.normals, vnIdx);
      }
    }

    return {
      vertices: new Float32Array(vertices),
      normals: hasNormals ? new Float32Array(normals) : null,
      texcoords: hasTexcoords ? new Float32Array(texcoords) : null,
      indices: nextIndex < 65536 ? new Uint16Array(indices) : new Uint32Array(indices),
    };
  }

  /**
   * Resolve an OBJ index to a zero-based array index.
   * @returns The zero-based index, or `-1` when the OBJ index is invalid.
   */
  #resolveIndex(index: number, arrayLength: number): number {
    if (index === 0) {
      return -1;
    }

    if (index > 0) {
      return index - 1;
    }

    return arrayLength + index;
  }

  /**
   * Append a position triplet or a default origin.
   */
  #appendPosition(vertices: number[], positions: number[], vertexIndex: number): void {
    if (vertexIndex < 0) {
      vertices.push(0, 0, 0);
      return;
    }

    vertices.push(
      positions[vertexIndex * 3],
      positions[vertexIndex * 3 + 1],
      positions[vertexIndex * 3 + 2],
    );
  }

  /**
   * Append a texture coordinate pair or a default zero coordinate.
   */
  #appendTexcoord(texcoords: number[], sourceTexcoords: number[], texcoordIndex: number): void {
    if (texcoordIndex < 0) {
      texcoords.push(0, 0);
      return;
    }

    texcoords.push(
      sourceTexcoords[texcoordIndex * 2],
      sourceTexcoords[texcoordIndex * 2 + 1],
    );
  }

  /**
   * Append a normal triplet or a default up normal.
   */
  #appendNormal(normals: number[], sourceNormals: number[], normalIndex: number): void {
    if (normalIndex < 0) {
      normals.push(0, 0, 1);
      return;
    }

    normals.push(
      sourceNormals[normalIndex * 3],
      sourceNormals[normalIndex * 3 + 1],
      sourceNormals[normalIndex * 3 + 2],
    );
  }

  /**
   * Calculate the mesh bounding box and radius.
   */
  #calculateBounds(model: MeshModel): void {
    if (model.vertices === null || model.vertices.length === 0) {
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let index = 0; index < model.vertices.length; index += 3) {
      const x = model.vertices[index];
      const y = model.vertices[index + 1];
      const z = model.vertices[index + 2];

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }

    model.mins = new Vector(minX, minY, minZ);
    model.maxs = new Vector(maxX, maxY, maxZ);

    let maxDistance = 0;
    for (let index = 0; index < model.vertices.length; index += 3) {
      const x = model.vertices[index];
      const y = model.vertices[index + 1];
      const z = model.vertices[index + 2];
      maxDistance = Math.max(maxDistance, Math.hypot(x, y, z));
    }

    model.boundingradius = maxDistance;
  }

  /**
   * Generate tangent and bitangent buffers for normal mapping.
   */
  #generateTangentSpace(model: MeshModel): void {
    if (model.vertices === null || model.normals === null || model.texcoords === null || model.indices === null) {
      return;
    }

    const numVerts = model.numVertices;
    const tangents = new Float32Array(numVerts * 3);
    const bitangents = new Float32Array(numVerts * 3);
    const tan1 = new Float32Array(numVerts * 3);
    const tan2 = new Float32Array(numVerts * 3);

    for (let index = 0; index < model.indices.length; index += 3) {
      const i1 = model.indices[index];
      const i2 = model.indices[index + 1];
      const i3 = model.indices[index + 2];

      const v1 = this.#readTriangleVertex(model.vertices, i1);
      const v2 = this.#readTriangleVertex(model.vertices, i2);
      const v3 = this.#readTriangleVertex(model.vertices, i3);
      const w1 = this.#readTextureCoordinate(model.texcoords, i1);
      const w2 = this.#readTextureCoordinate(model.texcoords, i2);
      const w3 = this.#readTextureCoordinate(model.texcoords, i3);

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
      const denom = s1 * t2 - s2 * t1;
      const reciprocal = denom !== 0 ? 1 / denom : 0;

      const sdir: TriangleVertexIndices = [
        (t2 * x1 - t1 * x2) * reciprocal,
        (t2 * y1 - t1 * y2) * reciprocal,
        (t2 * z1 - t1 * z2) * reciprocal,
      ];
      const tdir: TriangleVertexIndices = [
        (s1 * x2 - s2 * x1) * reciprocal,
        (s1 * y2 - s2 * y1) * reciprocal,
        (s1 * z2 - s2 * z1) * reciprocal,
      ];

      for (const vertexIndex of [i1, i2, i3]) {
        tan1[vertexIndex * 3] += sdir[0];
        tan1[vertexIndex * 3 + 1] += sdir[1];
        tan1[vertexIndex * 3 + 2] += sdir[2];

        tan2[vertexIndex * 3] += tdir[0];
        tan2[vertexIndex * 3 + 1] += tdir[1];
        tan2[vertexIndex * 3 + 2] += tdir[2];
      }
    }

    for (let index = 0; index < numVerts; index++) {
      const normal = this.#readTriangleVertex(model.normals, index);
      const accumulatedTangent = this.#readTriangleVertex(tan1, index);
      const dot = normal[0] * accumulatedTangent[0]
        + normal[1] * accumulatedTangent[1]
        + normal[2] * accumulatedTangent[2];
      const tangent: TriangleVertexIndices = [
        accumulatedTangent[0] - normal[0] * dot,
        accumulatedTangent[1] - normal[1] * dot,
        accumulatedTangent[2] - normal[2] * dot,
      ];
      const tangentLength = Math.hypot(tangent[0], tangent[1], tangent[2]);

      if (tangentLength > 0) {
        tangent[0] /= tangentLength;
        tangent[1] /= tangentLength;
        tangent[2] /= tangentLength;
      }

      tangents[index * 3] = tangent[0];
      tangents[index * 3 + 1] = tangent[1];
      tangents[index * 3 + 2] = tangent[2];

      const bitangent: TriangleVertexIndices = [
        normal[1] * tangent[2] - normal[2] * tangent[1],
        normal[2] * tangent[0] - normal[0] * tangent[2],
        normal[0] * tangent[1] - normal[1] * tangent[0],
      ];

      bitangents[index * 3] = bitangent[0];
      bitangents[index * 3 + 1] = bitangent[1];
      bitangents[index * 3 + 2] = bitangent[2];
    }

    model.tangents = tangents;
    model.bitangents = bitangents;
  }

  /**
   * Read a packed `x, y, z` triplet from a flat float buffer.
   * @returns The vertex triplet at the requested index.
   */
  #readTriangleVertex(values: Float32Array, vertexIndex: number): TriangleVertexIndices {
    return [
      values[vertexIndex * 3],
      values[vertexIndex * 3 + 1],
      values[vertexIndex * 3 + 2],
    ];
  }

  /**
   * Read a packed `u, v` pair from a flat float buffer.
   * @returns The texture coordinate pair at the requested index.
   */
  #readTextureCoordinate(values: Float32Array, vertexIndex: number): TextureCoordinate {
    return [
      values[vertexIndex * 2],
      values[vertexIndex * 2 + 1],
    ];
  }
}
