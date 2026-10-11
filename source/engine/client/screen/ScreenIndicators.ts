import Cvar from '../../common/Cvar.ts';
import { clientConnectionState } from '../../common/Def.ts';
import Host from '../../common/Host.ts';
import { clientRuntimeState, clientStaticState } from '../ClientState.ts';
import Draw from '../Draw.ts';
import Camera from '../renderer/scene/Camera.ts';

/**
 * The small pictures in the corner of the screen that tell about the connection: the turtle for a low frame rate
 * and the net for a connection that is stalling. (The pause sign is the game's.)
 */
export default class ScreenIndicators {
  /** `showturtle`: show the turtle while the frame rate is low. */
  static showturtle: Cvar = null!;

  static net: ReturnType<typeof Draw.LoadPicFromWad> = null!;
  static turtle: ReturnType<typeof Draw.LoadPicFromWad> = null!;

  /** How many frames in a row were slow, the turtle shows after three. */
  static #slowFrames = 0;

  /**
   * Creates the variables and loads the pictures.
   */
  static Init(): void {
    ScreenIndicators.showturtle = new Cvar('showturtle', '0');
    ScreenIndicators.net = Draw.LoadPicFromWad('NET');
    ScreenIndicators.turtle = Draw.LoadPicFromWad('TURTLE');
  }

  /**
   * Draws the net and the turtle, whichever apply.
   */
  static Draw(): void {
    ScreenIndicators.DrawNet();
    ScreenIndicators.DrawTurtle();
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
}
