import Cvar from '../../common/Cvar.ts';
import { clientConnectionState } from '../../common/Def.ts';
import Host from '../../common/Host.ts';
import { clientRuntimeState, clientStaticState } from '../ClientState.ts';
import Draw from '../Draw.ts';
import Camera from '../renderer/scene/Camera.ts';
import VID from '../VID.ts';

/**
 * The small pictures in the corner and the middle of the screen that tell about the connection and the game: the
 * turtle for a low frame rate, the net for a connection that is stalling, the pause sign.
 */
export default class ScreenIndicators {
  /** `showturtle`: show the turtle while the frame rate is low. */
  static showturtle: Cvar = null!;

  /** `showpause`: show the pause sign while the game is paused. */
  static showpause: Cvar = null!;

  static net: ReturnType<typeof Draw.LoadPicFromWad> = null!;
  static turtle: ReturnType<typeof Draw.LoadPicFromWad> = null!;
  static pause: ReturnType<typeof Draw.LoadPicFromLumpDeferred> = null!;

  /** How many frames in a row were slow, the turtle shows after three. */
  static #slowFrames = 0;

  /**
   * Creates the variables and loads the pictures.
   */
  static Init(): void {
    ScreenIndicators.showturtle = new Cvar('showturtle', '0');
    ScreenIndicators.showpause = new Cvar('showpause', '1');
    ScreenIndicators.net = Draw.LoadPicFromWad('NET');
    ScreenIndicators.turtle = Draw.LoadPicFromWad('TURTLE');
    ScreenIndicators.pause = Draw.LoadPicFromLumpDeferred('pause');
  }

  /**
   * Draws the net, the turtle and the pause sign, whichever apply.
   */
  static Draw(): void {
    ScreenIndicators.DrawNet();
    ScreenIndicators.DrawTurtle();
    ScreenIndicators.DrawPause();
  }

  /** Draws the low-frame-rate turtle indicator. */
  static DrawTurtle(): void {
    if (ScreenIndicators.showturtle.value === 0) {
      return;
    }
    if (Host.frametime < 0.1) {
      ScreenIndicators.#slowFrames = 0;
      return;
    }
    if (++ScreenIndicators.#slowFrames >= 3) {
      Draw.Pic(Camera.refdef.vrect.x, Camera.refdef.vrect.y, ScreenIndicators.turtle);
    }
  }

  /** Draws the network-lag indicator when packets are delayed. */
  static DrawNet(): void {
    // `last_received_message` defaults to 0 and is only ever set once a message actually arrives
    // (ClientConnection.ts) -- without this guard, `Host.realtime - 0` grows past the threshold
    // within the first fraction of a second after boot and the indicator shows permanently while
    // fully disconnected, misreporting "bad connection" when there's no connection at all.
    if (clientStaticState.state !== clientConnectionState.connected) {
      return;
    }

    if ((Host.realtime - clientRuntimeState.last_received_message >= 0.3) && !clientStaticState.demoplayback) {
      Draw.Pic(Camera.refdef.vrect.x, Camera.refdef.vrect.y, ScreenIndicators.net);
    }
  }

  /** Draws the pause indicator when the game is paused. */
  static DrawPause(): void {
    if (ScreenIndicators.showpause.value !== 0 && clientRuntimeState.paused) {
      Draw.Pic((VID.width - ScreenIndicators.pause.width * 2) / 2, (VID.height - 48 - ScreenIndicators.pause.height * 2) / 2, ScreenIndicators.pause, 2);
    }
  }
}
