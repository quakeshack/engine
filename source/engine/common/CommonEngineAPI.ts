import type ParsedQC from './model/parsers/ParsedQC.ts';

import Vector from '../../shared/Vector.ts';
import Cmd from './Cmd.ts';
import Con from './Console.ts';
import Cvar from './Cvar.ts';
import { type GameEdition, GameFlavors } from './GameApiSupport.ts';
import Mod from './Mod.ts';

/**
 * What a game gets to see of the engine on either side: console output, console variables and the
 * edition of the game data. `ClientEngineAPI` adds the client's parts. One instance belongs to one realm.
 */
export class CommonEngineAPI {
  readonly #edition: () => GameEdition;

  constructor(edition: () => GameEdition) {
    this.#edition = edition;
  }

  /**
   * Whether the registered (non-shareware) game data is in use.
   * @returns True when the registered game is running.
   */
  get registered(): boolean {
    return this.#edition().registered;
  }

  /**
   * The editions of the game data that are in use.
   * @returns The flavors of the running game data.
   */
  get gameFlavors(): GameFlavors[] {
    const edition = this.#edition();
    const flavors: GameFlavors[] = [];

    if (!edition.registered) {
      flavors.push(GameFlavors.shareware);
    }

    if (edition.hipnotic) {
      flavors.push(GameFlavors.hipnotic);
    }

    if (edition.rogue) {
      flavors.push(GameFlavors.rogue);
    }

    return flavors;
  }

  /**
   * Append text to the command buffer.
   */
  AppendConsoleText(text: string): void {
    Cmd.text += text;
  }

  /**
   * Return a cvar by name.
   * @returns The variable.
   */
  GetCvar(name: string): Cvar | null {
    return Cvar.FindVar(name);
  }

  /**
   * Change the value of a cvar.
   * @returns The modified variable.
   */
  SetCvar(name: string, value: string): Cvar {
    const variable = Cvar.Set(name, value);

    console.assert(variable !== null, 'Cvar.Set requires a registered variable', name);

    return variable!;
  }

  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @returns The created variable.
   */
  RegisterCvar(name: string, value: string, flags = 0, description: string | null = null): Cvar {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME, description);
  }

  ConsolePrint(msg: string, color = new Vector(1.0, 1.0, 1.0)): void {
    Con.Print(msg, color);
  }

  ConsoleWarning(msg: string): void {
    Con.PrintWarning(msg);
  }

  ConsoleError(msg: string): void {
    Con.PrintError(msg);
  }

  ConsoleDebug(str: string): void {
    Con.DPrint(str);
  }

  /**
   * Parse QuakeC for model animation information.
   * @returns Parsed QC content.
   */
  ParseQC(qcContent: string): ParsedQC {
    return Mod.ParseQC(qcContent);
  }
}
