import Cmd from '../../common/Cmd.ts';
import Host from '../../common/Host.ts';
import { clientRuntimeState, clientStaticState } from '../ClientState.ts';
import clientCvars from '../ClientCvars.ts';
import viewCvars from './ViewCvars.ts';

/**
 * Lets the view drift back to level when the player walks forward and has not touched the look keys (Quake's
 * lookspring and `centerview`). Input behavior that changes `viewangles`, which prediction uses, so it is not
 * the first-person view's.
 */
export default class PitchDrift {
  /**
   * Registers the `centerview` console command.
   */
  static Init(): void {
    Cmd.AddCommand('centerview', PitchDrift.Start);
  }

  /**
   * Starts the drift back to level, unless it was stopped in this very frame so that a look key wins.
   */
  static Start(this: void): void {
    if (clientRuntimeState.laststop === clientRuntimeState.time) {
      return;
    }
    if (clientRuntimeState.nodrift || clientRuntimeState.pitchvel === 0.0) {
      clientRuntimeState.pitchvel = viewCvars.centerspeed.value;
      clientRuntimeState.nodrift = false;
      clientRuntimeState.driftmove = 0.0;
    }
  }

  /**
   * Stops the drift, because the player is looking up or down by hand.
   */
  static Stop(): void {
    clientRuntimeState.laststop = clientRuntimeState.time;
    clientRuntimeState.nodrift = true;
    clientRuntimeState.pitchvel = 0.0;
  }

  /**
   * Runs one frame of the drift: waits for forward movement, then moves the pitch toward the ideal pitch of
   * the ground the player stands on, faster as it goes.
   */
  static Update(): void {
    if (Host.noclip_anglehack || !clientRuntimeState.onground || clientStaticState.demoplayback) {
      clientRuntimeState.driftmove = 0.0;
      clientRuntimeState.pitchvel = 0.0;
      return;
    }

    if (clientRuntimeState.nodrift) {
      if (Math.abs(clientRuntimeState.cmd.forwardmove) < clientCvars.forwardspeed.value) {
        clientRuntimeState.driftmove = 0.0;
      } else {
        clientRuntimeState.driftmove += Host.frametime;
      }
      if (clientRuntimeState.driftmove > viewCvars.centermove.value) {
        PitchDrift.Start();
      }
      return;
    }

    const delta = clientRuntimeState.idealpitch - clientRuntimeState.viewangles[0];
    if (delta === 0.0) {
      clientRuntimeState.pitchvel = 0.0;
      return;
    }

    let move = Host.frametime * clientRuntimeState.pitchvel;
    clientRuntimeState.pitchvel += Host.frametime * viewCvars.centerspeed.value;

    if (delta > 0) {
      if (move > delta) {
        clientRuntimeState.pitchvel = 0.0;
        move = delta;
      }
      clientRuntimeState.viewangles[0] += move;
    } else if (delta < 0) {
      if (move > -delta) {
        clientRuntimeState.pitchvel = 0.0;
        move = -delta;
      }
      clientRuntimeState.viewangles[0] -= move;
    }
  }
}
