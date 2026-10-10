import Vector from '../../../../shared/Vector.ts';
import { Plane } from '../../../common/model/BaseModel.ts';

/** The part of the screen the 3D view is drawn into, in virtual screen pixels. */
export interface RefdefRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the view is, which way it looks and how wide it sees. */
export interface RefdefState {
  vrect: RefdefRect;
  vieworg: Vector;
  viewangles: Vector;
  fov_x: number;
  fov_y: number;
}

type Vec4 = [number, number, number, number];

/**
 * The view of the current frame: the refdef that `V` and `SCR` fill in, the vectors, frustum and matrices derived
 * from it, and the queries that depend on them (culling a box, projecting a point to the screen).
 *
 * The derived state is rebuilt by explicit calls, in the order the frame needs them: the view vectors once the
 * refdef is final (`UpdateViewVectors`), the frustum when the scene starts (`SetFrustum`) and the matrices once the
 * viewport is set up (`UpdateMatrices`).
 */
class Camera {
  /** Forward, up and right unit vectors of the view. Replaced by `UpdateViewVectors`, so never hold on to them. */
  static vpn = new Vector();
  static vup = new Vector();
  static vright = new Vector();

  /** The view as `V` and `SCR` set it. Nothing else assigns to it, they change its members in place. */
  static readonly refdef: RefdefState = {
    vrect: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    },
    vieworg: new Vector(),
    viewangles: new Vector(),
    fov_x: 0,
    fov_y: 0,
  };

  /** Left, right, bottom and top plane of the view frustum. */
  static readonly frustum: Plane[] = [
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
  ];

  /** The 4x4 rotation of the view (`uViewAngles` without the translation), `null` before the first frame. */
  static viewMatrix: number[] | null = null;

  /** The projection matrix in use, `null` before the first frame. */
  static projectionMatrix: number[] | null = null;

  /** The 3x3 rotation that goes into the `uViewAngles` uniform of every program. */
  static rotation: number[] = [];

  /**
   * The projection matrix. `SCR.CalcRefdef` and `R.DrawViewModel` write the two scale entries when the field of
   * view changes, everything else only reads it.
   */
  static readonly perspective = [
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, -65540.0 / 65532.0, -1.0,
    0.0, 0.0, -524288.0 / 65532.0, 0.0,
  ];

  /**
   * Derives the forward, right and up vectors from the view angles. Run once per frame after the refdef is final
   * (`V.CalcRefdef`, the game's `updateRefDef` and the chase camera have all had their say).
   */
  static UpdateViewVectors(): void {
    const { forward, right, up } = Camera.refdef.viewangles.angleVectors();
    [Camera.vpn, Camera.vright, Camera.vup] = [forward, right, up];
  }

  /**
   * Builds the four frustum planes from the view vectors, the field of view and the view origin.
   */
  static SetFrustum(): void {
    if (Camera.vup.isOrigin() || Camera.vright.isOrigin() || Camera.vpn.isOrigin()) { // can’t set frustum with these
      return;
    }

    const { refdef, frustum } = Camera;

    frustum[0].normal = Camera.vup.rotatePointAroundVector(Camera.vpn, -(90.0 - refdef.fov_x * 0.5));
    frustum[1].normal = Camera.vup.rotatePointAroundVector(Camera.vpn, 90.0 - refdef.fov_x * 0.5);
    frustum[2].normal = Camera.vright.rotatePointAroundVector(Camera.vpn, 90.0 - refdef.fov_y * 0.5);
    frustum[3].normal = Camera.vright.rotatePointAroundVector(Camera.vpn, -(90.0 - refdef.fov_y * 0.5));

    for (let i = 0; i < 4; i++) {
      const out = frustum[i];
      out.type = 5;
      out.dist = refdef.vieworg.dot(out.normal);
      out.signbits = 0;
      if (out.normal[0] < 0.0) {
        out.signbits = 1;
      }
      if (out.normal[1] < 0.0) {
        out.signbits += 2;
      }
      if (out.normal[2] < 0.0) {
        out.signbits += 4;
      }
      if (out.normal[3] < 0.0) {
        out.signbits += 8;
      }
    }
  }

  /**
   * Whether a box is entirely outside of the view frustum.
   * @returns True when the box can be skipped.
   */
  static CullBox(mins: Vector, maxs: Vector): boolean {
    if (Vector.boxOnPlaneSide(mins, maxs, Camera.frustum[0]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, Camera.frustum[1]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, Camera.frustum[2]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, Camera.frustum[3]) === 2) {
      return true;
    }
    return false;
  }

  /**
   * Rebuilds the view rotation from the view angles and takes the projection matrix into use. The programs get
   * them through `FrameUniforms.Upload()`, `WorldToScreen` reads them from here.
   */
  static UpdateMatrices(): void {
    const viewangles = [
      Camera.refdef.viewangles[0] * Math.PI / 180.0,
      (Camera.refdef.viewangles[1] - 90.0) * Math.PI / -180.0,
      Camera.refdef.viewangles[2] * Math.PI / -180.0,
    ];
    const sp = Math.sin(viewangles[0]);
    const cp = Math.cos(viewangles[0]);
    const sy = Math.sin(viewangles[1]);
    const cy = Math.cos(viewangles[1]);
    const sr = Math.sin(viewangles[2]);
    const cr = Math.cos(viewangles[2]);
    const rotation = [
      cr * cy + sr * sp * sy,		cp * sy,	-sr * cy + cr * sp * sy,
      cr * -sy + sr * sp * cy,	cp * cy,	-sr * -sy + cr * sp * cy,
      sr * cp,					-sp,		cr * cp,
    ];

    Camera.rotation = rotation;
    Camera.viewMatrix = [
      rotation[0], rotation[1], rotation[2], 0.0,
      rotation[3], rotation[4], rotation[5], 0.0,
      rotation[6], rotation[7], rotation[8], 0.0,
      0.0,         0.0,         0.0,         1.0,
    ];

    Camera.projectionMatrix = Camera.perspective;
  }

  static #multiplyMatrixVec4(m: number[], v: Vec4): Vec4 {
    return [
      m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
      m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
      m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
      m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
    ];
  }

  /**
   * Convert a world-space position into screen coordinates.
   * @returns Screen coordinates or null when the point is off-screen.
   */
  static WorldToScreen(origin: Vector): Vector | null {
    const projectionMatrix = Camera.projectionMatrix;
    const viewMatrix = Camera.viewMatrix; // This is uViewAngles — rotation only

    if (projectionMatrix === null || viewMatrix === null) {
      return null;
    }

    // world-space delta from camera
    const delta = [
      origin[0] - Camera.refdef.vieworg[0],
      origin[1] - Camera.refdef.vieworg[1],
      origin[2] - Camera.refdef.vieworg[2],
    ];

    // Apply view rotation
    const x =
      viewMatrix[0] * delta[0] +
      viewMatrix[4] * delta[1] +
      viewMatrix[8] * delta[2];
    const y =
      viewMatrix[1] * delta[0] +
      viewMatrix[5] * delta[1] +
      viewMatrix[9] * delta[2];
    const z =
      viewMatrix[2] * delta[0] +
      viewMatrix[6] * delta[1] +
      viewMatrix[10] * delta[2];

    // Mimic gl_Position = projection * vec4(xz, -y, 1.0)
    const posVec = [x, z, -y, 1.0]; // Swizzle + flip Y

    const clip = Camera.#multiplyMatrixVec4(projectionMatrix, posVec as Vec4);

    // If the clip space W coordinate is zero, we can't convert to NDC
    if (clip[3] === 0) {
      return null;
    }

    const ndc = [
      clip[0] / clip[3],
      clip[1] / clip[3],
      clip[2] / clip[3],
    ];

    if (clip[3] > 0 && ndc[0] >= -1 && ndc[0] <= 1 && ndc[1] >= -1 && ndc[1] <= 1 && ndc[2] >= 0 && ndc[2] <= 1) {
      return new Vector(
        Camera.refdef.vrect.x + (ndc[0] + 1) * 0.5 * Camera.refdef.vrect.width,
        Camera.refdef.vrect.y + (1 - ndc[1]) * 0.5 * Camera.refdef.vrect.height,
        ndc[2],
      );
    }

    return null;
  }
}

export default Camera;
