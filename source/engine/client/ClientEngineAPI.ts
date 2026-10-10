import type { ClientDlight, ClientEdict } from './ClientEntities.ts';
import { BitmapFont, type BitmapFontConfig } from './BitmapFont.ts';
import type { GLTexture } from './GL.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import type { DiscoveredSession, SessionDiscoveryStatus } from './menu/SessionDiscovery.ts';
import type { SaveSlotInfo } from './menu/SaveSlots.ts';

import { type GameTrace, type InternalTraceLike, internalTraceToGameTrace } from '../common/GameApiSupport.ts';
import { CommonEngineAPI } from '../common/CommonEngineAPI.ts';
import { PmoveConfiguration } from '../../shared/Pmove.ts';
import Vector from '../../shared/Vector.ts';
import { solid } from '../../shared/Defs.ts';
import { clientConnectionState } from '../common/Def.ts';
import Key, { KeyDestination } from './Key.ts';
import { Action, ColorPicker, Image, KeyBindItem, Label, MenuItem, NumberInput, SaveSlotItem, Slider, Spacer, Textbox, Toggle } from './menu/MenuItem.ts';
import { DialogPage, GridLayout, ImageBasedLayout, ListLayout, ListPage, MenuPage, VerticalLayout } from './menu/MenuPage.ts';
import { MenuViewport } from './menu/MenuViewport.ts';
import type { MenuPic } from './Menu.ts';
import SessionDiscovery from './menu/SessionDiscovery.ts';
import SaveSlotsService from './menu/SaveSlots.ts';
import { SFX as SFXValue } from './Sound.ts';
import VID from './VID.ts';
import type { EventBus } from '../common/EventBus.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { HostError } from '../common/Errors.ts';
import W from '../common/W.ts';
import PostProcess from './renderer/postprocess/PostProcess.ts';
import type { PostProcessStack } from '../../shared/GameInterfaces.ts';
import ConsoleOverlay from './ConsoleOverlay.ts';
import { clientRuntimeState, clientStaticState } from './ClientState.ts';
import { clientCollision, clientPmove } from './ClientPhysics.ts';
import CL from './CL.ts';
import Particles from './renderer/effects/Particles.ts';
import Decals from './renderer/effects/Decals.ts';
import M from './Menu.ts';
import Host from '../common/Host.ts';
import ClientHost from './ClientHost.ts';
import Draw from './Draw.ts';
import S from './Sound.ts';
import SCR from './SCR.ts';
import V from './V.ts';
import Camera from './renderer/scene/Camera.ts';

interface ClientTraceOptions {
  readonly includeEntities?: boolean;
  readonly passEntityId?: number | null;
  readonly filter?: ((entity: ClientEdict) => boolean) | null;
}

interface ClientTraceEntityAdapter {
  readonly entity: ClientEdict;
  readonly num: number;
  equals(other: unknown): boolean;
}

type ClientEntityFilter = ((entity: ClientEdict) => boolean) | null;
type CommandCallback = (...args: string[]) => void | Promise<void>;

/**
 * Return whether the entity can be traced against.
 * @returns True when the entity can be traced against.
 */
function isTraceableClientSolid(entity: ClientEdict): boolean {
  return entity.solid === solid.SOLID_BBOX
    || entity.solid === solid.SOLID_SLIDEBOX
    || entity.solid === solid.SOLID_BSP
    || entity.solid === solid.SOLID_MESH;
}

/**
 * Return the extents used for tracing the entity.
 * @returns The mins/maxs extents used for tracing.
 */
function getClientTraceExtents(entity: ClientEdict): { mins: Vector; maxs: Vector } {
  if (entity.model !== null && entity.mins.isOrigin() && entity.maxs.isOrigin()) {
    return {
      mins: entity.model.mins,
      maxs: entity.model.maxs,
    };
  }

  return {
    mins: entity.mins,
    maxs: entity.maxs,
  };
}

/**
 * Compute the client's world-space trace bounds.
 */
function computeClientTraceBounds(entity: ClientEdict, absmin: Vector, absmax: Vector): void {
  const { mins, maxs } = getClientTraceExtents(entity);

  if (!entity.angles.isOrigin()) {
    const basis = entity.angles.toRotationMatrix();
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    const centerX = (mins[0] + maxs[0]) * 0.5;
    const centerY = (mins[1] + maxs[1]) * 0.5;
    const centerZ = (mins[2] + maxs[2]) * 0.5;
    const extentsX = (maxs[0] - mins[0]) * 0.5;
    const extentsY = (maxs[1] - mins[1]) * 0.5;
    const extentsZ = (maxs[2] - mins[2]) * 0.5;

    const worldCenter = entity.origin.copy()
      .add(forward.copy().multiply(centerX))
      .add(right.copy().multiply(centerY))
      .add(up.copy().multiply(centerZ));

    const worldExtentX = Math.abs(forward[0]) * extentsX + Math.abs(right[0]) * extentsY + Math.abs(up[0]) * extentsZ;
    const worldExtentY = Math.abs(forward[1]) * extentsX + Math.abs(right[1]) * extentsY + Math.abs(up[1]) * extentsZ;
    const worldExtentZ = Math.abs(forward[2]) * extentsX + Math.abs(right[2]) * extentsY + Math.abs(up[2]) * extentsZ;

    absmin.setTo(
      worldCenter[0] - worldExtentX,
      worldCenter[1] - worldExtentY,
      worldCenter[2] - worldExtentZ,
    );
    absmax.setTo(
      worldCenter[0] + worldExtentX,
      worldCenter[1] + worldExtentY,
      worldCenter[2] + worldExtentZ,
    );
    return;
  }

  absmin.set(entity.origin).add(mins);
  absmax.set(entity.origin).add(maxs);
}

/**
 * Return whether the two AABBs overlap.
 * @returns True when the AABBs overlap.
 */
function traceBoundsOverlap(traceMins: Vector, traceMaxs: Vector, entityMins: Vector, entityMaxs: Vector): boolean {
  return !(
    traceMins[0] > entityMaxs[0]
    || traceMins[1] > entityMaxs[1]
    || traceMins[2] > entityMaxs[2]
    || traceMaxs[0] < entityMins[0]
    || traceMaxs[1] < entityMins[1]
    || traceMaxs[2] < entityMins[2]
  );
}

/**
 * Resolve the best trace including eligible client entities.
 * @returns The best trace including eligible client entities.
 */
function traceClientEntities(
  start: Vector,
  end: Vector,
  worldTrace: InternalTraceLike,
  options: ClientTraceOptions,
): InternalTraceLike {
  const traceMins = new Vector(
    Math.min(start[0], worldTrace.endpos[0]),
    Math.min(start[1], worldTrace.endpos[1]),
    Math.min(start[2], worldTrace.endpos[2]),
  );
  const traceMaxs = new Vector(
    Math.max(start[0], worldTrace.endpos[0]),
    Math.max(start[1], worldTrace.endpos[1]),
    Math.max(start[2], worldTrace.endpos[2]),
  );
  const entityMins = new Vector();
  const entityMaxs = new Vector();

  let bestTrace: InternalTraceLike = worldTrace;

  for (const entity of clientRuntimeState.clientEntities.getEntities()) {
    if (entity.num === 0 || entity.free || entity.origin.isInfinite() || entity.model === null) {
      continue;
    }

    if (!isTraceableClientSolid(entity)) {
      continue;
    }

    if (options.passEntityId !== null && options.passEntityId !== undefined && entity.num === options.passEntityId) {
      continue;
    }

    if (options.filter !== null && options.filter !== undefined && !options.filter(entity)) {
      continue;
    }

    computeClientTraceBounds(entity, entityMins, entityMaxs);

    if (!traceBoundsOverlap(traceMins, traceMaxs, entityMins, entityMaxs)) {
      continue;
    }

    const adapter: ClientTraceEntityAdapter = {
      entity,
      num: entity.num,
      equals(other: unknown): boolean {
        return this === other;
      },
    };
    const trace = clientCollision.clipMoveToEntity(
      adapter,
      start,
      Vector.origin,
      Vector.origin,
      bestTrace.endpos,
    ) as InternalTraceLike;

    if (trace.allsolid || trace.startsolid || trace.fraction < bestTrace.fraction) {
      bestTrace = trace;
    }
  }

  return bestTrace;
}

/**
 * What a game's client side gets to see of the engine: the members of `ClientGameAPI.Init` and of the
 * constructor of `ClientGameAPI`. One instance belongs to one page, the composition root installs it.
 */
export class ClientEngineAPI extends CommonEngineAPI {
  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @returns The created variable.
   */
  override RegisterCvar(name: string, value: string, flags = 0, description: string | null = null): Cvar {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME | Cvar.FLAG.CLIENT, description);
  }

  RegisterCommand(name: string, callback: CommandCallback): void {
    Cmd.AddCommand(name, callback);
  }

  UnregisterCommand(name: string): void {
    Cmd.RemoveCommand(name);
  }

  /**
   * Load a texture from a lump.
   * @returns The loaded texture.
   */
  LoadPicFromLump(name: string): GLTexture {
    return Draw.LoadPicFromLumpDeferred(name);
  }

  /**
   * Load a texture from a WAD.
   * @returns The loaded texture.
   */
  LoadPicFromWad(name: string): GLTexture {
    return Draw.LoadPicFromWad(name);
  }

  /**
   * Load a texture from a file.
   * @returns The loaded texture.
   */
  LoadPicFromFile(filename: string): Promise<GLTexture> {
    return Draw.LoadPicFromFile(filename);
  }

  /**
   * Load a fixed-grid bitmap font atlas from a file (e.g. a stylized header font), described by
   * `config`'s charset and glyph/cell metrics.
   * @returns The loaded font.
   */
  LoadBitmapFont(filename: string, config: Omit<BitmapFontConfig, 'texture'>): Promise<BitmapFont> {
    return BitmapFont.FromImageFile(filename, config);
  }

  /**
   * Play a sound effect.
   */
  PlaySound(sfx: SFXValue): void {
    S.LocalSound(sfx);
  }

  /**
   * Load a sound effect. Can be used with PlaySound.
   * @returns The loaded sound effect.
   */
  LoadSound(sfxName: string): SFXValue {
    const sfx = S.PrecacheSound(sfxName);

    console.assert(sfx !== null, 'sound must be precached before being returned', sfxName);

    return sfx!;
  }

  /**
   * Draw a picture at the specified position.
   */
  DrawPic(x: number, y: number, pic: GLTexture, scale = 1.0): void {
    Draw.Pic(x, y, pic, scale);
  }

  /**
   * Draw a string on the screen at the specified position.
   */
  DrawString(x: number, y: number, str: string, scale = 1.0, color = new Vector(1.0, 1.0, 1.0)): void {
    Draw.String(x, y, str, scale, color);
  }

  /**
   * Fill a rectangle with a solid color.
   */
  DrawRect(x: number, y: number, w: number, h: number, c: Vector, a = 1.0): void {
    Draw.Fill(x, y, w, h, c, a);
  }

  /**
   * Translate a palette index into an RGB color vector.
   * @returns The RGB color vector.
   */
  IndexToRGB(index: number): [number, number, number] {
    return W.IndexToRGB(index);
  }

  /**
   * Translate world coordinates to screen coordinates.
   * @returns Screen coordinates, or `null` if the point is behind the camera.
   */
  WorldToScreen(origin: Vector): Vector | null {
    return Camera.WorldToScreen(origin);
  }

  /**
   * Get all entities in the game. Both client-only and server entities.
   * @yields Client entities.
   */
  *GetEntities(filter: ClientEntityFilter = null): Generator<ClientEdict, void, void> {
    for (const entity of clientRuntimeState.clientEntities.getEntities()) {
      if (filter && !filter(entity)) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Get all entities staged for rendering. Both client-only and server entities.
   * @yields Visible client entities.
   */
  *GetVisibleEntities(filter: ClientEntityFilter = null): Generator<ClientEdict, void, void> {
    for (const entity of clientRuntimeState.clientEntities.getVisibleEntities()) {
      if (filter && !filter(entity)) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Perform a trace line in the client game world.
   * By default this traces static world geometry only.
   * Keep this legacy entry point aligned with the server-side Traceline name so
   * client tracing can grow into entity-aware behavior later without another API
   * rename.
   * @returns The trace result.
   */
  Traceline(start: Vector, end: Vector, options: ClientTraceOptions | null = null): GameTrace {
    const worldTrace = clientCollision.traceWorldLine(start, end) as InternalTraceLike;

    if (options === null || !options.includeEntities) {
      return internalTraceToGameTrace(worldTrace);
    }

    return internalTraceToGameTrace(traceClientEntities(start, end, worldTrace, options));
  }

  /**
   * Tell whether a client entity is in the PVS of the current view, even when it is not drawn.
   * Meant for effect sources that should not do any work while the player cannot see them. It
   * answers for the view of the previous frame, and true while there is no view yet.
   * @returns True when the player could see the entity from where they are.
   */
  IsInPVS(entity: ClientEdict): boolean {
    return clientRuntimeState.clientEntities.isPotentiallyVisible(entity);
  }

  /**
   * Find what contents the given point of the static world is in.
   * @returns The contents constant.
   */
  DetermineStaticWorldContents(origin: Vector): number {
    return clientCollision.pointContents(origin);
  }

  /**
   * Allocate a dynamic light for the given entity Id.
   * @returns The dynamic light instance.
   */
  AllocDlight(entityId: number): ClientDlight {
    return clientRuntimeState.clientEntities.allocateDynamicLight(entityId);
  }

  /**
   * Allocate a new client entity.
   * This is a client-side entity, not a server-side edict.
   * Make sure to invoke spawn() when ready.
   * Make sure to use setOrigin() to set the position of the entity.
   * @deprecated use `SpawnClientEntity()` instead, which resolves the classname's handler and can mark the entity for save/load.
   * @returns A new client entity.
   */
  AllocEntity(): ClientEdict {
    return clientRuntimeState.clientEntities.allocateClientEntity();
  }

  /**
   * Allocate a client-only entity (debris, gibs, shell casings, ...) with no server-tracked slot.
   * The `ClientGameAPI.GetClientEdictHandler()` result for `classname` drives it. Set its `model`,
   * `velocity` etc., place it with `setOrigin()`, then invoke `spawn()` when ready.
   * @param classname Classname used to look up the entity's handler.
   * @param options.persistent Whether the entity is captured by save games, defaulting to `true`.
   * Use `false` only for entities the server regenerates on every (re)connect.
   * @returns A new client-only entity.
   */
  SpawnClientEntity(classname: string, options: { readonly persistent?: boolean } = {}): ClientEdict {
    const clientEntities = clientRuntimeState.clientEntities;

    if (options.persistent ?? true) {
      return clientEntities.allocateSimulatedEntity(classname);
    }

    return clientEntities.allocateStaticEntity(classname);
  }

  /**
   * Spawn a rocket trail effect from start to end.
   */
  RocketTrail(start: Vector, end: Vector, type: number): void {
    Particles.RocketTrail(start, end, type);
  }

  /**
   * Place a decal in the world.
   */
  PlaceDecal(origin: Vector, normal: Vector, texture: GLTexture): void {
    Decals.PlaceDecal(origin, normal, texture);
  }

  /**
   * Get a model by name. Must be precached first.
   * @returns The model.
   */
  ModForName(modelName: string): BaseModel {
    console.assert(typeof modelName === 'string', 'modelName must be a string');

    for (let index = 1; index < clientRuntimeState.model_precache.length; index++) {
      if (clientRuntimeState.model_precache[index].name === modelName) {
        return clientRuntimeState.model_precache[index];
      }
    }

    throw new HostError(`ClientEngineAPI.ModForName: ${modelName} not precached`);
  }

  /**
   * Get a model by id.
   * @returns The model.
   */
  ModById(id: number): BaseModel {
    console.assert(typeof id === 'number' && id > 0, 'id must be a number and greater than 0');

    if (clientRuntimeState.model_precache[id]) {
      return clientRuntimeState.model_precache[id];
    }

    throw new HostError(`ClientEngineAPI.ModById: ${id} not found`);
  }

  /**
   * Apply a content shift.
   */
  ContentShift(slot: number, color: Vector, alpha = 0.5): void {
    V.ContentShift(slot + 4, color, alpha);
  }

  /**
   * Set the player movement configuration. This is used by the PMove code to determine how the player will move.
   */
  SetPmoveConfiguration(config: PmoveConfiguration): void {
    console.assert(config instanceof PmoveConfiguration, 'config must be an instance of PmoveConfiguration');

    clientPmove.configuration = config;
  }

  readonly CL = {
    get viewangles(): Vector {
      return clientRuntimeState.viewangles.copy();
    },
    get vieworigin(): Vector {
      console.assert(clientRuntimeState.viewent !== null, 'client view entity must exist when reading vieworigin');

      return clientRuntimeState.viewent!.origin.copy();
    },
    get maxclients(): number {
      return clientRuntimeState.maxclients;
    },
    get levelname(): string {
      return clientRuntimeState.levelname ?? '';
    },
    get entityNum(): number {
      return clientRuntimeState.viewentity;
    },
    /**
     * local time, not game time! If you are looking for SV.server.time, check gametime
     * @returns Local time.
     */
    get time(): number { // FIXME: rename to localtime to make the distinction clearer
      return clientRuntimeState.time;
    },
    /**
     * latest SV.server.time, NOT local time!
     * @returns Game time.
     */
    get gametime(): number {
      return clientRuntimeState.clientMessages.mtime[0];
    },
    get frametime(): number {
      return Host.frametime;
    },
    get intermission(): boolean {
      return clientRuntimeState.intermission > 0;
    },
    /**
     * Current intermission mode: 0 = none, 1 = map exit, 2 = finale, 3 = cutscene.
     * @returns Current intermission mode.
     */
    get intermissionState(): number {
      return clientRuntimeState.intermission;
    },
    set intermission(value: boolean) {
      clientRuntimeState.intermission = value ? 1 : 0;
    },
    score(num: number) {
      return clientRuntimeState.scores[num];
    },
    get serverInfo() {
      return clientStaticState.serverInfo;
    },
    /**
     * @returns True while fully connected to a server (local or remote).
     */
    get connected(): boolean {
      return clientStaticState.state === clientConnectionState.connected;
    },
    /**
     * Authoritative world gravity strength, synced from the server via `parsePmovevars()` --
     * the same `movevars.gravity` value `ServerPhysics.addGravity()` scales by a per-entity
     * multiplier server-side (`entity.gravity`, default 1.0). Client-only physics should read
     * this instead of hardcoding a gravity value, applying its own multiplier the same way
     * (see `ClientEdict.gravity` and `ClientEntityPhysics`). Note `movevars.entgravity`
     * is the local player's own scale from `Pmove`'s player-movement fields, not a per-entity
     * value applicable to arbitrary client-only entities, so it is intentionally not folded in
     * here.
     * @returns Current world gravity.
     */
    get gravity(): number {
      return clientPmove.movevars.gravity;
    },
  };

  readonly SV = {
    /**
     * @returns True while this client is also hosting a local (listen) server.
     */
    get active(): boolean {
      return clientStaticState.serverController.state.active;
    },
  };

  readonly VID = {
    get width(): number {
      return VID.width;
    },
    get height(): number {
      return VID.height;
    },
    get pixelRatio(): number {
      return VID.pixelRatio;
    },
  };

  readonly Key = {
    /**
     * Get the string representation of a key binding, e.g. "+attack" -> "mouse1".
     * @returns The bound key string, or `null` when not found.
     */
    getKeyForBinding(binding: string): string | null {
      return Key.BindingToString(binding);
    },
  };

  readonly SCR = {
    /**
     * @returns The current view size.
     */
    get viewsize(): number {
      return (SCR as typeof SCR & { viewsize: Cvar }).viewsize.value as number;
    },
    /**
     * @returns The current 3D view rectangle in screen coordinates.
     */
    get viewRect(): { x: number; y: number; width: number; height: number } {
      return {
        x: Camera.refdef.vrect.x,
        y: Camera.refdef.vrect.y,
        width: Camera.refdef.vrect.width,
        height: Camera.refdef.vrect.height,
      };
    },
  };

  readonly PostProcess = {
    setStack(stack: PostProcessStack): void {
      PostProcess.setStack(stack);
    },

    clearStack(): void {
      PostProcess.clearStack();
    },

    hasStack(): boolean {
      return PostProcess.hasGameplayStack();
    },
  };

  /**
   * Menu registration and navigation, backed by the engine's menu stack (`source/engine/client/menu/`).
   * Widget classes are re-exported here so game code never has to import engine internals directly.
   */
  readonly Menu = {
    /**
     * Register a page under a name so it can later be opened by `Open`/`Push`/`Replace`.
     */
    RegisterPage(name: string, page: MenuPage): void {
      M.menuStack.register(name, page);
    },

    /**
     * Unregister a previously registered page.
     */
    UnregisterPage(name: string): void {
      M.menuStack.unregister(name);
    },

    /**
     * Declare which registered page is the root -- what `togglemenu`/Escape opens, and what
     * `Clear()`/an involuntary disconnect falls back to. Resolved by name, so re-registering
     * that name to a different page later keeps the root correct without calling this again.
     */
    SetRootPage(name: string): void {
      M.menuStack.setRootPage(name);
    },

    /**
     * Open a registered page as the pause menu, replacing whatever is currently shown.
     */
    Open(name: string): void {
      Key.destination = KeyDestination.menu;
      M.menuStack.push(name);
    },

    /**
     * Push a registered page on top of the current one. Assumes the menu is already open.
     */
    Push(name: string): void {
      M.menuStack.push(name);
    },

    /**
     * Pop the current page, revealing whatever was open before it (closing the menu entirely
     * if nothing is left).
     */
    Pop(): void {
      M.PopMenu();
    },

    /**
     * Pop pages until the stack is at most `depth` deep.
     */
    PopTo(depth: number): void {
      M.menuStack.popTo(depth);
    },

    /**
     * Pop down to a single page, leaving only the bottom of the stack.
     */
    PopToRoot(): void {
      M.menuStack.popToRoot();
    },

    /**
     * Replace the current page with a registered one, without growing the navigation stack.
     */
    Replace(name: string): void {
      M.menuStack.replace(name);
    },

    /**
     * Close the menu entirely, returning to the game (or console).
     */
    Close(): void {
      M.CloseMenu();
    },

    /**
     * Pop every page off the stack without changing `Key.destination` -- unlike `Close()`, this
     * doesn't return to the game/console, it just empties the navigation stack.
     */
    Clear(): void {
      M.menuStack.clear();
    },

    /**
     * Force the menu to close immediately and return control to the game, regardless of
     * connection state -- unlike `Close()`, which stays open while disconnected (nothing to
     * return to). Use this when the action itself is what's about to create a game to return
     * to, e.g. starting a new game from a disconnected menu.
     */
    ForceClose(): void {
      M.menuStack.clear();
      M.ReturnToGame();
    },

    /**
     * Toggle the drop-down console overlay.
     */
    ToggleConsole(): void {
      ConsoleOverlay.ToggleConsole_f();
    },

    /**
     * Quit immediately, skipping ClientHost.Quit_f()'s own confirmation gate -- for use after the
     * player already confirmed via a mod's own quit dialog.
     */
    ForceQuit(): void {
      ClientHost.ForceQuit();
    },

    /**
     * Start a new singleplayer game via the active mod's `StartGameInterface`
     * (`ClientGameConstructor.GetStartGameInterface`), or the engine's own default (`map start`)
     * if the mod didn't provide one.
     */
    StartSingleplayerGame(): void {
      M.StartSingleplayerGame();
    },

    /**
     * Start (host) a multiplayer game on `mapname` via the active mod's `StartGameInterface`
     * (`ClientGameConstructor.GetStartGameInterface`), or the engine's own default
     * (`map <mapname>`) if the mod didn't provide one.
     */
    StartMultiplayerGame(mapname: string): void {
      M.StartMultiplayerGame(mapname);
    },

    /**
     * Load a lump-based pic together with a color-translation texture built from its raw
     * palette indices, for `DrawPicTranslate` (e.g. a player-color preview). The palette/LMP
     * parsing stays engine-side since it's raw asset format handling, not menu content.
     * @returns The pic, with `.translate` populated.
     */
    LoadTranslatablePic(lumpName: string): Promise<MenuPic> {
      return M.LoadTranslatablePic(lumpName);
    },

    /**
     * Check whether the menu is open, optionally a specific registered page.
     * @returns True when the menu (or the named page) is currently shown.
     */
    IsOpen(name?: string): boolean {
      if (name === undefined) {
        return M.menuStack.current() !== null;
      }

      return M.menuStack.isShowing(name);
    },

    /**
     * @returns The current navigation stack depth.
     */
    Depth(): number {
      return M.menuStack.depth();
    },

    /**
     * @returns True when nothing is on the navigation stack.
     */
    IsEmpty(): boolean {
      return M.menuStack.isEmpty();
    },

    /**
     * The page one level below the current one on the stack, if any -- e.g. a dialog's own
     * `getBackdrop` wanting to draw whatever was open before it appeared.
     * @returns The previous page, or null if the current page is at (or below) the root.
     */
    GetPreviousPage(): MenuPage | null {
      return M.menuStack.getPreviousPage();
    },

    /**
     * Insert an item into a registered page, e.g. to extend a built-in screen from game code.
     */
    AddItem(pageName: string, item: MenuItem, index?: number): void {
      const page = M.menuStack.getPage(pageName);

      console.assert(page !== undefined, 'ClientEngineAPI.Menu.AddItem: unknown page', pageName);

      if (!page) {
        return;
      }

      if (index === undefined) {
        page.items.push(item);
      } else {
        page.items.splice(index, 0, item);
      }
    },

    /**
     * Remove a previously added item from a registered page.
     */
    RemoveItem(pageName: string, item: MenuItem): void {
      const page = M.menuStack.getPage(pageName);

      if (!page) {
        return;
      }

      const index = page.items.indexOf(item);

      if (index !== -1) {
        page.items.splice(index, 1);
      }
    },

    /**
     * Current mouse position in the current page's virtual menu-space coordinates (see
     * `MenuViewport`/`MenuPage.viewport`).
     * @returns The horizontal position.
     */
    get mouseX(): number {
      return M.mouseX;
    },

    /**
     * Current mouse position in the current page's virtual menu-space coordinates (see
     * `MenuViewport`/`MenuPage.viewport`).
     * @returns The vertical position.
     */
    get mouseY(): number {
      return M.mouseY;
    },

    /**
     * Convert a virtual-space point (in the current page's viewport) into a real screen pixel
     * position -- for a `customDraw` that needs to place a resolution-aware `DrawPic`/
     * `DrawString` call (see above; a different coordinate system from `Print`/`DrawPic` below)
     * at a virtual-space position.
     * @returns The equivalent real screen position.
     */
    toScreenPosition(x: number, y: number): { x: number; y: number } {
      return M.toScreenPosition(x, y);
    },

    /**
     * The current page's resolved virtual-to-real pixel scale, e.g. to size a resolution-aware
     * `DrawPic` call to match a virtual-space target width.
     * @returns The scale factor.
     */
    get viewportScale(): number {
      return M.viewportScale;
    },

    // Low-level drawing primitives every widget/layout draws with, re-exported so a page's
    // `customDraw`/`customHandleInput` (and a custom MenuItem's `customDraw`) can reproduce the
    // same look without reaching into engine internals. All operate in the current page's own
    // virtual coordinate space (see `MenuViewport`/`MenuPage.viewport`, classic 320x200 by
    // default) -- a different coordinate system from `DrawPic`/`DrawString` above, which are
    // resolution-aware absolute pixel offsets.

    Print(cx: number, cy: number, str: string): void {
      M.Print(cx, cy, str);
    },

    PrintWhite(cx: number, cy: number, str: string): void {
      M.PrintWhite(cx, cy, str);
    },

    DrawCharacter(cx: number, cy: number, num: number): void {
      M.DrawCharacter(cx, cy, num);
    },

    DrawPic(x: number, y: number, pic: MenuPic): void {
      M.DrawPic(x, y, pic);
    },

    DrawPicTranslate(x: number, y: number, pic: MenuPic, top: number, bottom: number): void {
      M.DrawPicTranslate(x, y, pic, top, bottom);
    },

    DrawTextBox(x: number, y: number, width: number, lines: number): void {
      M.DrawTextBox(x, y, width, lines);
    },

    DrawSlider(x: number, y: number, range: number): void {
      M.DrawSlider(x, y, range);
    },

    // Read on use: these classes are part of a module cycle with this one, so they are not there yet while this class is set up.
    get Action() {
      return Action;
    },
    get Label() {
      return Label;
    },
    get Slider() {
      return Slider;
    },
    get Toggle() {
      return Toggle;
    },
    get Textbox() {
      return Textbox;
    },
    get Spacer() {
      return Spacer;
    },
    get Image() {
      return Image;
    },
    get ColorPicker() {
      return ColorPicker;
    },
    get NumberInput() {
      return NumberInput;
    },
    get SaveSlotItem() {
      return SaveSlotItem;
    },
    get KeyBindItem() {
      return KeyBindItem;
    },
    get MenuPage() {
      return MenuPage;
    },
    get DialogPage() {
      return DialogPage;
    },
    get ListPage() {
      return ListPage;
    },
    get VerticalLayout() {
      return VerticalLayout;
    },
    get ImageBasedLayout() {
      return ImageBasedLayout;
    },
    get ListLayout() {
      return ListLayout;
    },
    get GridLayout() {
      return GridLayout;
    },
    get MenuViewport() {
      return MenuViewport;
    },
  };

  readonly Multiplayer = {
    /**
     * Fetch currently joinable sessions for this client's active game (mod) from the master
     * server. Throws if signaling is unavailable -- callers that can't assume it's configured
     * should check first or catch.
     * @returns Sessions matching the active game/mod.
     */
    ListSessions(): Promise<DiscoveredSession[]> {
      return SessionDiscovery.listSessions();
    },

    /**
     * Subscribes to live session updates for this client's active game (mod) over the master
     * server's real-time `/browser` channel. See {@link SessionDiscovery.subscribe}.
     * @returns An unsubscribe function; safe to call more than once.
     */
    SubscribeSessions(
      onSessions: (sessions: DiscoveredSession[]) => void,
      onStatus?: (status: SessionDiscoveryStatus) => void,
    ): () => void {
      return SessionDiscovery.subscribe(onSessions, onStatus);
    },

    /**
     * Requests a fresh session snapshot over an already-open SubscribeSessions channel. See
     * {@link SessionDiscovery.requestRefresh}.
     */
    RequestSessionsRefresh(): void {
      SessionDiscovery.requestRefresh();
    },
  };

  readonly SaveSlots = {
    /**
     * List save-slot metadata for the currently active game directory.
     * @returns Metadata for save slots `0..maxSlots - 1`.
     */
    List(maxSlots: number): SaveSlotInfo[] {
      return SaveSlotsService.list(maxSlots);
    },

    /**
     * Delete a save slot's data.
     */
    Delete(index: number): void {
      SaveSlotsService.delete(index);
    },
  };

  get eventBus(): EventBus {
    return clientRuntimeState.eventBus;
  }

  /**
   * A second bus alongside `eventBus`, living for the whole game module's lifetime instead of
   * being wiped on every disconnect/reconnect -- see `ClientState.ts`'s `moduleEventBus` for which
   * events reach it (the same set as `eventBus`) and why.
   * @returns The module-lifetime event bus.
   */
  get moduleEventBus(): EventBus {
    return CL.moduleEventBus;
  }
}
