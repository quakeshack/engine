import Vector from '../../shared/Vector.mjs';
import Cvar from '../common/Cvar.mjs';
import { eventBus, registry } from '../registry.mjs';

let { CL, R, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  R = registry.R;
  SV = registry.SV;
});

export default class Chase {
  /** @type {Cvar} */
  static back = null;
  /** @type {Cvar} */
  static up = null;
  /** @type {Cvar} */
  static right = null;
  /** @type {Cvar} */
  static active = null;

  static Init() {
    Chase.back = new Cvar('chase_back', '100');
    Chase.up = new Cvar('chase_up', '16');
    Chase.right = new Cvar('chase_right', '0');
    Chase.active = new Cvar('chase_active', '0');
  }

  static Update2() { // side scroller style
    const { forward, right } = CL.state.viewangles.angleVectors();
    const back = forward.copy().subtract(new Vector(0.0, 128.0, 0.0));
    const org = R.refdef.vieworg;
    const trace = SV.collision.traceStaticWorldLine(org, new Vector(
      org[0] + 4096.0 * right[0],
      org[1] + 4096.0 * right[1],
      org[2] + 4096.0 * right[2]));
    const stop = trace.endpos;
    stop[2] -= org[2];
    const dist = Math.max(1.0, (stop[0] - org[0]) * right[0] + (stop[1] - org[1]) * right[1] + stop[2] * right[2]);
    R.refdef.viewangles[0] = Math.atan(stop[2] / dist) / Math.PI * -180.0;
    R.refdef.viewangles[1] += 90.0;
    org[0] += right[0] * Chase.back.value;
    org[1] += right[1] * Chase.back.value;
    org[2] += Chase.up.value;
    org.subtract(back);
  }

  static Update() {
    const { forward, right } = CL.state.viewangles.angleVectors();
    const org = R.refdef.vieworg;
    const trace = SV.collision.traceStaticWorldLine(org, new Vector(
      org[0] + 4096.0 * forward[0],
      org[1] + 4096.0 * forward[1],
      org[2] + 4096.0 * forward[2]));
    const stop = trace.endpos;
    stop[2] -= org[2];
    let dist = (stop[0] - org[0]) * forward[0] + (stop[1] - org[1]) * forward[1] + stop[2] * forward[2];
    if (dist < 1.0) {
      dist = 1.0;
    }
    R.refdef.viewangles[0] = Math.atan(stop[2] / dist) / Math.PI * -180.0;
    const org2 = R.refdef.vieworg.copy();
    org2[0] -= forward[0] * Chase.back.value + right[0] * Chase.right.value;
    org2[1] -= forward[1] * Chase.back.value + right[1] * Chase.right.value;
    org2[2] += Chase.up.value;
    const trace2 = SV.collision.traceStaticWorldLine(org, org2);
    if (trace2.endpos) {
      org.set(trace2.endpos);
    } else {
      org.set(org2);
    }
  }
};
