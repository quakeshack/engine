import Vector from '../../../../shared/Vector.ts';
import Cmd from '../../../common/Cmd.ts';
import { eventBus } from '../../../common/EventBus.ts';
import Draw from '../../Draw.ts';
import GL, { type GLTexture } from '../../GL.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import { clientCollision } from '../../ClientPhysics.ts';
import LightSampler from '../lighting/LightSampler.ts';
import Camera from '../scene/Camera.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

export interface Decal {
  readonly texture: GLTexture;
  readonly verts: [Vector, Vector, Vector, Vector];
  readonly color: Vector;
  readonly die: number;
  readonly origin: Vector;
}

/**
 * Decals placed on world surfaces (bullet holes, scorch marks): placement with the light at the spot, the
 * list of live decals and their drawing.
 */
export class Decals {
  /** The live decals, oldest first. */
  static list: Decal[] = [];

  /**
   * Emit one decal quad into the stream buffer.
   */
  static EmitQuad(decal: Decal): void {
    GL.StreamGetSpace(6);

    // Quad vertices: 0, 1, 2, 0, 2, 3
    const v = decal.verts;
    const c = decal.color;
    const r = c[0];
    const g = c[1];
    const b = c[2];

    GL.StreamWriteFloat3(v[0][0], v[0][1], v[0][2]); GL.StreamWriteFloat2(0, 0); GL.StreamWriteUByte4(r, g, b, 255);
    GL.StreamWriteFloat3(v[1][0], v[1][1], v[1][2]); GL.StreamWriteFloat2(1, 0); GL.StreamWriteUByte4(r, g, b, 255);
    GL.StreamWriteFloat3(v[2][0], v[2][1], v[2][2]); GL.StreamWriteFloat2(1, 1); GL.StreamWriteUByte4(r, g, b, 255);

    GL.StreamWriteFloat3(v[0][0], v[0][1], v[0][2]); GL.StreamWriteFloat2(0, 0); GL.StreamWriteUByte4(r, g, b, 255);
    GL.StreamWriteFloat3(v[2][0], v[2][1], v[2][2]); GL.StreamWriteFloat2(1, 1); GL.StreamWriteUByte4(r, g, b, 255);
    GL.StreamWriteFloat3(v[3][0], v[3][1], v[3][2]); GL.StreamWriteFloat2(0, 1); GL.StreamWriteUByte4(r, g, b, 255);
  }

  /**
   * Starts with no decals and registers the `test_decal` console command, which places one where the view hits a wall.
   */
  static Init(): void {
    Decals.list = [];

    Cmd.AddCommand('test_decal', async () => {
      const start = Camera.refdef.vieworg;
      const vectors = clientRuntimeState.viewangles.angleVectors();
      const forward = vectors.forward;
      const end = start.copy().add(forward.copy().multiply(8192));
      const trace = clientCollision.traceStaticWorldLine(start, end);

      if (trace.allsolid || trace.startsolid || trace.fraction === 1.0) {
        return;
      }

      // Use a particle texture for testing if no bullet texture exists
      Decals.PlaceDecal(trace.endpos, trace.plane.normal, await Draw.LoadPicFromLump('box_tl'));
    });
  }

  /**
   * Drops all decals.
   */
  static Clear(): void {
    Decals.list = [];
  }

  /**
   * Places a decal of `texture` on the surface at `origin`, facing `normal`. It is lit with the light there and lasts
   * 10 seconds. Does nothing without a texture.
   */
  static PlaceDecal(origin: Vector, normal: Vector, texture: GLTexture | null): void {
    if (!texture) {
      return;
    }

    // Calculate basis vectors for the decal quad
    const up = new Vector(0, 0, 1);

    if (Math.abs(normal.dot(up)) > 0.99) {
      up.setTo(1, 0, 0);
    }

    const right = normal.cross(up);
    right.normalize();
    up.set(right.cross(normal));
    up.normalize();

    const size = 4.0; // Decal size

    const verts: [Vector, Vector, Vector, Vector] = [
      origin.copy().add(right.copy().multiply(-size)).add(up.copy().multiply(size)),
      origin.copy().add(right.copy().multiply(size)).add(up.copy().multiply(size)),
      origin.copy().add(right.copy().multiply(size)).add(up.copy().multiply(-size)),
      origin.copy().add(right.copy().multiply(-size)).add(up.copy().multiply(-size)),
    ];

    // Apply polygon offset
    const offset = normal.copy().multiply(0.5);
    for (let i = 0; i < 4; i++) {
      verts[i].add(offset);
    }

    // Calculate lighting
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const lightStart = origin.copy().add(normal.copy().multiply(4.0));
    const lightEnd = origin.copy().subtract(normal.copy().multiply(4.0));
    const lightResult = LightSampler.RecursiveLightPoint(worldmodel.nodes[0], lightStart, lightEnd);

    let color = new Vector(255, 255, 255); // Default to white
    if (lightResult) {
      const r = Math.min(255, Math.max(0, Math.floor(lightResult[0][0])));
      const g = Math.min(255, Math.max(0, Math.floor(lightResult[0][1])));
      const b = Math.min(255, Math.max(0, Math.floor(lightResult[0][2])));
      color.setTo(r, g, b);
    }

    Decals.list.push({
      texture,
      verts,
      color,
      die: clientRuntimeState.time + 10.0, // Lasts 10 seconds
      origin: origin.copy(),
    });
  }

  /**
   * Drops the decals that have run out.
   */
  static PruneExpired(): void {
    Decals.list = Decals.list.filter((decal) => decal.die > clientRuntimeState.time);
  }

  /**
   * Draws all live decals in one pass, used when the map has no world model to sort against.
   */
  static Draw(): void {
    if (!Decals.list || Decals.list.length === 0) {
      return;
    }

    Decals.PruneExpired();

    if (Decals.list.length === 0) {
      return;
    }

    GL.StreamFlush();

    const program = GL.UseProgram('decal')!;
    console.assert(program !== null, 'decal program required');
    gl.depthMask(false);
    gl.enable(gl.BLEND);

    gl.uniform1f(program.uAlpha!, 1.0);

    let currentTexture = null;

    for (let i = 0; i < Decals.list.length; i++) {
      const decal = Decals.list[i];

      if (decal.texture !== currentTexture) {
        GL.StreamFlush();
        decal.texture.bind(program.tTexture!);
        currentTexture = decal.texture;
      }

      Decals.EmitQuad(decal);
    }

    GL.StreamFlush();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}

export default Decals;
