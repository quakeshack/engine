import type { ClientEventValue, SerializedData } from '../../shared/GameInterfaces.ts';
import type { GameTrace } from '../common/GameApiSupport.ts';
import type { SFX } from './Sound.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import type { JointAdjustments } from '../common/model/JointAdjustments.ts';
import { ModelScope, type BrushModel } from '../common/Mod.ts';
import type { Pmove } from '../common/Pmove.ts';

import Vector, { Quaternion } from '../../shared/Vector.ts';
import * as Def from '../common/Def.ts';
import { content, effect, moveType, solid } from '../../shared/Defs.ts';
import Chase from './Chase.ts';
import ClientEntityPhysics from './ClientEntityPhysics.ts';
import { clientCollision } from './ClientPhysics.ts';
import { DefaultClientEdictHandler } from './ClientLegacy.ts';
import { BaseClientEdictHandler, type ClientSpawnParameters } from '../../shared/ClientEdict.ts';
import GameModule from '../common/GameModule.ts';
import { engineApi } from './PageServices.ts';
import { revealedVisibility, type Visibility } from '../common/model/BSP.ts';
import Con from '../common/Console.ts';
import Mod from '../common/Mod.ts';
import { clientRuntimeState } from './ClientState.ts';
import clientCvars from './ClientCvars.ts';
import rendererCvars from './renderer/resources/RendererCvars.ts';
import Host from '../common/Host.ts';
import S from './Sound.ts';
import Camera from './renderer/scene/Camera.ts';
import { EntityAttachments } from './EntityAttachments.ts';
import { EntityTags } from './EntityTags.ts';
import { MAX_ATTACHMENT_DEPTH } from '../common/AttachmentTransform.ts';

interface ClientEntityLerpState {
  readonly frame: [number, number, number];
  /**
   * Where to draw the entity: its own interpolated origin, or, for an entity attached to another, the place the
   * attachment puts it this frame (`EntityAttachments`), which its own origin is only an offset to.
   */
  readonly origin: Vector;
  /**
   * The entity's own angles, interpolated. For an attached entity they are an offset in tag space and nothing draws
   * by them: renderers take `rotationMatrix`.
   */
  readonly angles: Vector;
  /**
   * The angles the body of the entity is turned by: `angles`, without the pitch when the game turned it into joint rotations
   * instead (`ClientEdict.bodyPitch`).
   */
  readonly bodyAngles: Vector;
  /** The entity's own interpolated origin, the offset in tag space for an attached entity. */
  readonly localOrigin: Vector;
  /**
   * The nine numbers of the rotation to draw the entity with, the form the model renderers upload as `uAngles` (what
   * `Vector.toRotationMatrix()` gives): from `bodyAngles` for an entity that stands free, from the rotation the attachment
   * resolved for an attached one, which never becomes angles on the way.
   */
  readonly rotationMatrix: number[];
}

interface TempEntitySounds {
  wizhit: SFX | null;
  knighthit: SFX | null;
  tink1: SFX | null;
  ric1: SFX | null;
  ric2: SFX | null;
  ric3: SFX | null;
  explosion: SFX | null;
}

/**
 * Flat, JSON-safe save-game snapshot of one persistent client-only entity (`ClientEdict.
 * persistent`), captured by `ClientEntities.serialize()`.
 */
export interface SerializedClientEntity {
  readonly classname: string;
  /** Name of the entity's model (e.g. `progs/gib1.mdl`), or `null` when it has none. */
  readonly model: string | null;
  readonly origin: readonly [number, number, number];
  readonly angles: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  /** The engine-driven physics state, see `ClientEdict.movetype`. */
  readonly movetype: moveType;
  readonly avelocity: readonly [number, number, number];
  readonly gravity: number;
  readonly onGround: boolean;
  /**
   * The sequence state, so that a saved animation resumes where it was (`animtime` is a point of the clock the save
   * restores). Missing from saves made before it existed, which restore the defaults.
   */
  readonly sequence?: number;
  readonly animtime?: number;
  readonly framerate?: number;
  /** The owning handler's own `serialize()` result, or `null` when it saved nothing. */
  readonly handlerData: SerializedData | null;
}

export class ClientDlight {
  /** light radius */
  radius = 0.0;

  /** light color, RGB */
  color = new Vector(1.0, 1.0, 1.0);

  /** origin */
  origin = new Vector();

  /** time when this light is considered gone */
  die = 0.0;

  /** radius decrease per second, e.g. 300 */
  decay = 0.0;

  /** entity number */
  entity = 0;

  minlight = 0;

  /** simulation time this light was (re-)allocated, used to size the fade-out window */
  bornTime = 0.0;

  isFree(): boolean {
    return this.radius < 0.0 || this.die < clientRuntimeState.time;
  }

  clear(): void {
    this.radius = 0.0;
    this.color.setTo(1.0, 1.0, 1.0);
    this.origin.clear();
    this.die = 0.0;
    this.decay = 0.0;
    this.entity = 0;
    this.minlight = 0;
    this.bornTime = 0.0;
  }

  think(): void {
    this.radius -= this.decay * Host.frametime;

    // Fade smoothly to zero instead of an abrupt cutoff at `die`: over the
    // last half of the light's remaining lifetime (capped at 0.25s so long-
    // lived lights, e.g. rocket glow, don't start dimming too early), scale
    // radius down so it reaches exactly zero right as the light expires.
    // This also covers zero-decay lights (muzzle flashes, e-lights) that
    // otherwise held full brightness until `die` and then vanished instantly.
    const lifetime = this.die - this.bornTime;
    const fadeWindow = Math.min(lifetime * 0.5, 0.25);

    if (fadeWindow > 0.0) {
      const remaining = this.die - clientRuntimeState.time;
      const fade = Math.min(Math.max(remaining / fadeWindow, 0.0), 1.0);
      this.radius *= fade;
    }

    if (this.radius < 0.0) {
      this.radius = 0;
    }
  }
}

export class ClientBeam {
  start = new Vector();
  end = new Vector();

  /** what model to use to draw the beam */
  model: BaseModel | null = null;

  entity = 0;
  endtime = 0.0;
}

/**
 * Follows the parents of an entity to the top of its chain, at most `MAX_ATTACHMENT_DEPTH` of them.
 * @returns The entity itself when it stands free.
 */
function findAttachmentRoot(entity: ClientEdict): ClientEdict {
  let root = entity;

  for (let depth = 0; root.attachmentParent !== null && depth < MAX_ATTACHMENT_DEPTH; depth++) {
    root = root.attachmentParent;
  }

  return root;
}

/**
 * The engine-side record of one entity on the client, the counterpart of `ServerEdict`. "Edict"
 * is the engine's word for that record (number, model, origin, links); what a game thinks of as
 * the entity is its handler.
 *
 * It serves three kinds of entities: ones mirrored from a server edict (`num >= 0`), static
 * decorations from `svc_spawnstatic`, and client-only entities a game spawns itself (see
 * `isClientOwned()` and `docs/client-entities.md`).
 *
 * Optionally there can be a `BaseClientEdictHandler` for each edict, handling the logic that is
 * not part of a client-server session.
 */
export class ClientEdict { // TODO: extends Protocol.EntityState
  #handler: BaseClientEdictHandler | null = null;

  classname: string | null;
  readonly num: number;
  #model: BaseModel | null = null;
  #sequence = -1;
  /** The frame to draw. A model that follows `sequence` ignores it while one is selected. */
  frame = 0;
  /**
   * Server time at which the sequence started: a model that plays a sequence shows the point `(time - animtime) *
   * framerate` seconds into it. The client stamps it with its clock when `model` or `sequence` changes, which is all a
   * game needs that never looks at it. A game that sets `animtime` itself (`now` restarts the sequence, `now - elapsed`
   * resumes it) has it sent, and the server's value replaces the stamp, so a client that joins late sees the same point.
   */
  animtime = 0.0;
  /** Playback speed multiplier of the sequence, 1 for the speed the model gives it. */
  framerate = 1.0;
  modelindex: number;
  framePrevious: number | null;
  frameTime: number;
  skinnum: number;
  colormap: number;
  effects: effect;
  /** alpha value for rendering */
  alpha: number;
  solid: solid;
  originPrevious: Vector;
  originTime: number;
  origin: Vector;
  anglesPrevious: Vector;
  anglesTime: number;
  angles: Vector;
  velocityPrevious: Vector;
  velocityTime: number;
  velocity: Vector;
  /**
   * How the engine moves this entity. Only client-owned entities are ever stepped, and only with
   * `MOVETYPE_TOSS` or `MOVETYPE_BOUNCE` (gravity, collision with the world, and for a bounce the
   * rest rule, see `ClientEntityPhysics`); everything else, including every entity mirrored from
   * the server, stays at `MOVETYPE_NONE` and is moved by whoever owns it.
   */
  movetype: moveType;
  /** Tumble rate in degrees per second, applied while the entity is stepped. */
  avelocity: Vector;
  /** Multiplier of the world gravity for this entity, like the server's `entity.gravity`. */
  gravity: number;
  /** Whether the engine-driven physics has come to rest. A resting entity is not stepped again. */
  onGround: boolean;
  dlightbits: number;
  dlightframe: number;
  /** keeps track of origin changes */
  msg_origins: [Vector, Vector];
  /** keeps track of angle changes */
  msg_angles: [Vector, Vector];
  /** keeps track of velocity changes */
  msg_velocity: [Vector, Vector];
  leafs: number[];
  /** count of received updates */
  updatecount: number;
  /** whether this ClientEdict is ready to be recycled */
  free: boolean;
  /**
   * Whether this client-only entity survives save/load, set by `ClientEntities.
   * allocateSimulatedEntity()` (procedurally-spawned effects like debris) but not
   * `allocateStaticEntity()` (`svc_spawnstatic` decorations, regenerated by the server's signon on
   * every (re)connect and thus never saved). See `ClientEntities.serialize()`.
   */
  persistent: boolean;
  syncbase: number;
  /**
   * End time of the current network-driven lerp window (origin/angles/frame interpolate towards
   * this entity's values until this time is reached). Despite the name (kept for now to match the
   * `svc_update`/`Protocol.u.nextthink` wire bit that sets it), this does not gate `think()` —
   * `think()` runs unconditionally every frame for every non-free entity.
   */
  lerpEndTime: number;
  maxs: Vector;
  mins: Vector;
  /** entity fields pushed by the server */
  extended: Record<string, ClientEventValue>;
  readonly lerp: ClientEntityLerpState;

  /**
   * The entity this one follows, `null` when it stands free. An attached entity's `origin` and `angles` are its offset
   * in the tag's space, and it is drawn exactly when its parent is (`EntityAttachments`). The server sets it for
   * entities it sends (`Protocol.u.attachment`); a game sets it for its own client-only entities with
   * {@link ClientEdict.setAttachment}.
   */
  attachmentParent: ClientEdict | null = null;
  /** Index of the parent's tag that the server resolved, -1 for the parent's origin. */
  attachmentTag = -1;
  /**
   * How many times a server update has set `EF_MUZZLEFLASH` on this entity (a shot). The server clears the bit after one datagram,
   * so when a client frame reads two datagrams (a slow frame, a burst of messages) the bit is set and clear again before any handler
   * has looked; a handler that wants every shot compares this count with the one it saw last, instead of sampling `effects`.
   */
  muzzleFlashCount = 0;
  /** The client clock (`CL.time`) when the last of those shots was read, so that a handler can leave out one it comes to see long after (the entity was out of view). */
  muzzleFlashTime = -Infinity;
  /**
   * Rotations a game put on joints of this entity's skeletal model, on top of its animation (`ClientEngineAPI.SetEntityJointAngles`);
   * `null` while there are none. The renderer, the tags and with them the entities attached to this one all use them.
   */
  jointAdjustments: JointAdjustments | null = null;
  /**
   * Whether the entity's pitch tilts the whole body, as it does for alias models. A game that bends joints with the pitch instead
   * (`ClientEngineAPI.SetEntityPitchesBody`) turns it off; `lerp.angles` still holds the pitch.
   */
  bodyPitch = true;
  /**
   * The name of the tag a client-only entity follows, looked up in the parent's model every frame so a parent that
   * changes model is followed. `null` when the tag index came from the server.
   */
  attachmentTagName: string | null = null;
  /** Where the attachment put the entity this frame: origin `x, y, z`, rotation `w, x, y, z`. Valid while `attachmentResolved`. */
  readonly attachmentTransform = new Float64Array(7);
  /** The origin part of `attachmentTransform` as a vector, for what reads an origin (`worldOrigin`, `lerp.origin`). */
  readonly attachmentOrigin = new Vector();
  /**
   * Whether `attachmentTransform` was resolved by the last emit pass that drew the entity. An entity that is not drawn
   * (its parent is not) keeps what it had, and is not read.
   */
  attachmentResolved = false;
  /** The emit pass that last put this entity on screen, so an attached entity can tell whether its parent was. */
  emitSerial = 0;

  /**
   * Time-smoothed static/dynamic lighting terms, blended towards the newly
   * sampled values each frame by `EntityLighting.CalculateLightValues` so lighting eases
   * across lightmap boundaries instead of snapping. Null until first sampled.
   */
  smoothedAmbientLight: Vector | null;
  smoothedShadeLight: Vector | null;
  smoothedLightOrigin: Vector | null;
  smoothedDynamicShadeLight: Vector | null;
  smoothedDynamicLightOrigin: Vector | null;

  /** @param num entity number */
  constructor(num: number) {
    this.classname = null;
    this.num = num;
    this.modelindex = 0;
    this.framePrevious = null;
    this.frameTime = 0.0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.alpha = 1.0;
    this.solid = 0;
    this.originPrevious = new Vector(Infinity, Infinity, Infinity);
    this.originTime = 0.0;
    this.origin = new Vector(Infinity, Infinity, Infinity);
    this.anglesPrevious = new Vector(Infinity, Infinity, Infinity);
    this.anglesTime = 0.0;
    this.angles = new Vector(Infinity, Infinity, Infinity);
    this.velocityPrevious = new Vector(Infinity, Infinity, Infinity);
    this.velocityTime = 0.0;
    this.velocity = new Vector();
    this.movetype = moveType.MOVETYPE_NONE;
    this.avelocity = new Vector();
    this.gravity = 1.0;
    this.onGround = false;
    this.dlightbits = 0;
    this.dlightframe = 0;
    this.msg_origins = [new Vector(), new Vector()];
    this.msg_angles = [new Vector(), new Vector()];
    this.msg_velocity = [new Vector(), new Vector()];
    this.leafs = [];
    this.updatecount = 0;
    this.free = false;
    this.persistent = false;
    this.syncbase = 0.0;
    this.lerpEndTime = -1;
    this.maxs = new Vector();
    this.mins = new Vector();
    this.extended = {};
    this.smoothedAmbientLight = null;
    this.smoothedShadeLight = null;
    this.smoothedLightOrigin = null;
    this.smoothedDynamicShadeLight = null;
    this.smoothedDynamicLightOrigin = null;

    const that = this;

    /**
     * holds lerped origin and angles for rendering purposes
     */
    this.lerp = {
      get frame(): [number, number, number] {
        const time = clientRuntimeState.clientMessages.renderTime;
        if (that.lerpEndTime <= time || that.framePrevious === null || clientCvars.nolerp.value) {
          return [that.frame, that.frame, 0];
        }
        return [that.framePrevious, that.frame, (time - that.frameTime) / (that.lerpEndTime - that.frameTime)];
      },
      get origin(): Vector {
        return that.attachmentResolved ? that.attachmentOrigin : this.localOrigin;
      },
      get localOrigin(): Vector {
        const time = clientRuntimeState.clientMessages.renderTime;
        if (that.lerpEndTime <= time || clientCvars.nolerp.value || that.originPrevious.isInfinite()) {
          return that.origin;
        }
        const f = Math.min(1, Math.max(0, (time - that.originTime) / (that.lerpEndTime - that.originTime)));
        const o0 = that.origin;
        const o1 = that.originPrevious;
        const l = new Vector(
          o1[0] + (o0[0] - o1[0]) * f,
          o1[1] + (o0[1] - o1[1]) * f,
          o1[2] + (o0[2] - o1[2]) * f,
        );
        return l;
      },
      get angles(): Vector {
        const time = clientRuntimeState.clientMessages.renderTime;
        if (that.lerpEndTime <= time || clientCvars.nolerp.value || that.anglesPrevious.isInfinite()) {
          return that.angles;
        }
        const f = Math.min(1, Math.max(0, (time - that.anglesTime) / (that.lerpEndTime - that.anglesTime)));
        return Quaternion.slerpAngles(that.anglesPrevious, that.angles, f, new Vector());
      },
      get bodyAngles(): Vector {
        const angles = this.angles;

        if (that.bodyPitch || angles[0] === 0) {
          return angles;
        }

        return new Vector(0, angles[1], angles[2]);
      },
      get rotationMatrix(): number[] {
        if (!that.attachmentResolved) {
          return this.bodyAngles.toRotationMatrix();
        }

        const matrix: number[] = new Array<number>(9).fill(0);
        Quaternion.toModelRotationMatrixInto(matrix, 0, that.attachmentTransform, 3);
        return matrix;
      },
    };

    Object.freeze(this.lerp);
    Object.seal(this);
  }

  /**
   * The model to draw. Setting a different model restarts its animation ({@link ClientEdict.animtime}).
   * @returns The model, `null` when the entity is not drawn.
   */
  get model(): BaseModel | null {
    return this.#model;
  }

  set model(model: BaseModel | null) {
    if (model !== this.#model) {
      this.animtime = clientRuntimeState.time;
    }

    this.#model = model;
  }

  /**
   * The sequence a sequenced model plays (image sprites, skeletal models), -1 for none, when the model follows `frame`.
   * Selecting another one restarts its animation ({@link ClientEdict.animtime}); writing the value it already has does
   * not, so the server repeating a `sequence` leaves a running animation alone.
   * @returns The sequence number.
   */
  get sequence(): number {
    return this.#sequence;
  }

  set sequence(sequence: number) {
    if (sequence !== this.#sequence) {
      this.animtime = clientRuntimeState.time;
    }

    this.#sequence = sequence;
  }

  /**
   * The entity at the top of the chain of parents this one hangs on, the one whose place decides where this one is.
   * @returns The root, this entity itself when it stands free. A chain deeper than `MAX_ATTACHMENT_DEPTH` stops there.
   */
  get attachmentRoot(): ClientEdict {
    return findAttachmentRoot(this);
  }

  /**
   * Where the entity is in the world, not interpolated: what culling and sorting look at. Its own `origin` for an
   * entity that stands free, the place the attachment put it this frame for an attached one, whose own `origin` is only
   * an offset.
   * @returns The position. It is not a copy: read it, do not change it.
   */
  get worldOrigin(): Vector {
    return this.attachmentResolved ? this.attachmentOrigin : this.origin;
  }

  /**
   * Attaches this client-only entity to another entity, to a tag of its model or to its origin, the same as
   * `ServerEdict.setAttachment` does for server entities, without any network traffic: a muzzle flash sprite on the
   * barrel, a spark on a hand. From now on `origin` and `angles` are this entity's offset in the tag's space and it is
   * drawn exactly when its parent is, hidden in first person when the parent is the view entity. When the parent is the
   * first-person weapon (`ClientEngineAPI.GetViewmodelEntity()`) it is drawn with the weapon, in the weapon's projection. The attachment
   * follows the parent while it lives; when the parent is freed this entity stops being drawn, and the game that
   * attached it frees it or attaches it elsewhere. Attachments of client-only entities are not saved.
   * @param parent The entity to follow, a server entity or another client-only one.
   * @param tagName The name of a tag of the parent's model, `null` for the parent's origin. A name the model does not have also gives the origin.
   */
  setAttachment(parent: Readonly<ClientEdict>, tagName: string | null = null): void {
    console.assert(parent !== this, 'ClientEdict.setAttachment: an entity cannot be attached to itself');

    // a game holds entities as `Readonly<ClientEdict>`; every one of them is a real `ClientEdict` of the engine's
    this.attachmentParent = parent as ClientEdict;
    this.attachmentTag = -1;
    this.attachmentTagName = tagName === '' ? null : tagName;
    this.attachmentResolved = false;
  }

  /**
   * Lets go of the parent: `origin` and `angles` are world values again, which the game that detaches on purpose
   * sets first.
   *
   * Note: set the origin with `setOrigin()`, not by assigning `origin`. The entity's leaves were linked at the offset
   * while it was attached, and only `setOrigin()` relinks it. With a plain assignment the PVS check of a client-only
   * entity keeps using the old leaves and the entity is drawn only where the offset was.
   */
  clearAttachment(): void {
    this.attachmentParent = null;
    this.attachmentTag = -1;
    this.attachmentTagName = null;
    this.attachmentResolved = false;
  }

  /**
   * A client-owned entity has no corresponding server-tracked slot (`num === -1`): static
   * (`svc_spawnstatic`) decorations, temp entities, and future client-only simulated entities
   * all share this sentinel.
   * @returns True when this entity has no server-tracked slot.
   */
  isClientOwned(): boolean {
    return this.num === -1;
  }

  /**
   * Marks the entity as free for the allocator to recycle. Stops it thinking, emitting, and
   * rendering as of the next frame.
   */
  markFree(): void {
    this.free = true;
  }

  equals(other: { num: number } | null): boolean {
    // CR: playing with fire here
    return other !== null && (this === other || (this.num !== -1 && this.num === other.num));
  }

  /**
   * @returns the center point of the entity's bounding box.
   */
  get centerPoint(): Vector {
    const center = this.origin.copy();
    center.add(this.mins).add(this.maxs).multiply(0.5);
    return center;
  }

  freeEdict(): void {
    this.model = null;
    this.framePrevious = null;
    this.frameTime = 0.0;
    this.frame = 0;
    this.sequence = -1;
    this.animtime = 0.0;
    this.framerate = 1.0;
    this.clearAttachment();
    this.jointAdjustments = null;
    this.bodyPitch = true;
    this.muzzleFlashCount = 0;
    this.muzzleFlashTime = -Infinity;
    this.modelindex = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.alpha = 1.0;
    this.solid = 0;
    this.origin.setTo(Infinity, Infinity, Infinity);
    this.angles.setTo(Infinity, Infinity, Infinity);
    this.velocity.clear();
    this.movetype = moveType.MOVETYPE_NONE;
    this.avelocity.clear();
    this.gravity = 1.0;
    this.onGround = false;
    this.dlightbits = 0;
    this.dlightframe = 0;
    this.msg_origins[0].clear();
    this.msg_origins[1].clear();
    this.msg_angles[0].clear();
    this.msg_angles[1].clear();
    this.leafs.length = 0;
    this.updatecount = 0;
    this.free = false;
    this.persistent = false;
    this.maxs.clear();
    this.mins.clear();
    this.originTime = 0.0;
    this.originPrevious.setTo(Infinity, Infinity, Infinity);
    this.anglesTime = 0.0;
    this.anglesPrevious.setTo(Infinity, Infinity, Infinity);
    this.velocityTime = 0.0;
    this.velocityPrevious.setTo(Infinity, Infinity, Infinity);
    this.lerpEndTime = -1;
    // make sure we delete the field, not just replace the holding object
    for (const key of Object.keys(this.extended)) {
      delete this.extended[key];
    }
  }

  /**
   * Links the entity to the current world model.
   * This has to be called after the origin for a client-side entity has been changed.
   */
  linkEdict(): void {
    const worldmodel = clientRuntimeState.worldmodel;

    console.assert(worldmodel !== null, 'worldmodel must be set before linking an entity');
    console.assert(this.isClientOwned(), 'linkEdict is only valid for client-side entities');
    console.assert(this.model !== null, 'model must be set before linking an entity');

    if (worldmodel === null || this.model === null) {
      return;
    }

    console.assert(worldmodel.nodeTable.count > 0, 'worldmodel must have a root node before linking an entity');
    if (worldmodel.nodeTable.count === 0) {
      return;
    }

    // Recomputed from scratch every call -- #splitEntityOnNode only ever appends, so without this
    // a repeatedly-moved entity (e.g. ClientEntityPhysics.step() calling setOrigin() every frame)
    // would keep accumulating leaf numbers from every position it has ever occupied instead of
    // reflecting where it actually is now.
    this.leafs.length = 0;

    const emins = this.origin.copy().add(this.model.mins);
    const emaxs = this.origin.copy().add(this.model.maxs);
    this.#splitEntityOnNode(worldmodel, 0, emins, emaxs);
  }

  /**
   * @param worldmodel world model with the BSP tree
   * @param reference BSP node to split the entity on (its index), or a leaf (`~index`)
   * @param emins entity mins
   * @param emaxs entity maxs
   */
  #splitEntityOnNode(worldmodel: BrushModel, reference: number, emins: Vector, emaxs: Vector): void {
    if (reference < 0) {
      const leaf = ~reference;

      if (worldmodel.leafTable.contents[leaf] !== content.CONTENT_SOLID) {
        this.leafs[this.leafs.length] = leaf;
      }

      return;
    }

    const nodes = worldmodel.nodeTable;
    const sides = Vector.boxOnPlaneSide(emins, emaxs, worldmodel.planes[nodes.planeNums[reference]]);

    if ((sides & 1) !== 0) {
      this.#splitEntityOnNode(worldmodel, nodes.children[reference * 2], emins, emaxs);
    }

    if ((sides & 2) !== 0) {
      this.#splitEntityOnNode(worldmodel, nodes.children[reference * 2 + 1], emins, emaxs);
    }
  }

  /**
   * Sets the origin of the entity.
   * Only valid for client-side entities.
   * @param origin new position of the entity
   */
  setOrigin(origin: Vector): void {
    this.origin.set(origin);
    this.linkEdict();
  }

  /** loads handler based on set classname */
  loadHandler(): void {
    const handler = (() => {
      if (this.classname === null) {
        return null;
      }

      const activeGameModule = GameModule.active;
      console.assert(activeGameModule !== null, 'ClientEdict.loadHandler requires an active game module');

      if (activeGameModule === null) {
        return null;
      }

      const entityHandler = activeGameModule.ClientGameAPI.GetClientEdictHandler(this.classname);

      if (!entityHandler) {
        // Con.DPrint('No ClientEdictHandler for entity: ' + this.classname + '\n');
        return null;
      }

      return entityHandler;
    })() ?? DefaultClientEdictHandler;

    this.#handler = new handler(this, engineApi);
  }

  /**
   * Makes `lerp.origin` return `origin` as is, for as long as nothing snapshots a new previous origin.
   * Client prediction moves the player's origin every frame, so interpolating it from the origin
   * the last server message found would drag the player along a line between that stale point and
   * the predicted one (a flicker, and a sweep across the map after a teleport).
   */
  dropOriginLerp(): void {
    this.originPrevious.setTo(Infinity, Infinity, Infinity);
  }

  /**
   * Sets origin and angles according to the current message.
   * @param doLerp whether to do a point lerp
   */
  updatePosition(doLerp: boolean): void {
    const time = clientRuntimeState.clientMessages.mtime[0];

    // not precisely a position, but it is part of the lerp too
    if (time > this.lerpEndTime || this.framePrevious === null) {
      this.frameTime = time;
      this.framePrevious = this.frame;
    }

    if (!doLerp) {
      this.origin.set(this.msg_origins[0]);
      this.angles.set(this.msg_angles[0]);
      this.velocity.set(this.msg_velocity[0]);
      return;
    }

    // if (this.num === 120) {
    //   console.log('updatePosition', this.num, this.classname, this.origin, this.angles, this.velocity);
    // }

    // reset previous values when lerpEndTime is over
    if (time >= this.lerpEndTime || this.originPrevious.isInfinite() || this.origin.distanceTo(this.originPrevious) > 150) {
      this.originTime = time;
      this.originPrevious.set(this.origin);
    }

    if (time >= this.lerpEndTime || this.anglesPrevious.isInfinite()) {
      this.anglesTime = time;
      this.anglesPrevious.set(this.angles);
    }

    if (time >= this.lerpEndTime || this.velocityPrevious.isInfinite() || this.velocity.distanceTo(this.velocityPrevious) > 150) {
      this.velocityTime = time;
      this.velocityPrevious.set(this.velocity);
    }

    this.angles.set(this.msg_angles[0]);
    this.origin.set(this.msg_origins[0]);
    this.velocity.set(this.msg_velocity[0]);
  }

  /**
   * Spawns the entity, delegating to the handler's `spawn()`.
   * @param parameters per-instance inputs for the handler, see `ClientSpawnParameters`
   */
  spawn(parameters?: ClientSpawnParameters): void {
    if (this.#handler) {
      this.#handler.spawn(parameters);
    }
  }

  emit(): void {
    if (this.#handler) {
      this.#handler.emit();
    }
  }

  think(): void {
    if (this.#handler) {
      this.#handler.think();
    }
  }

  /**
   * Tells the handler that the engine-driven physics hit the world.
   * @param trace the world hit
   */
  impact(trace: GameTrace): void {
    this.#handler?.impact(trace);
  }

  /**
   * Tells the handler that the engine-driven physics has come to rest.
   */
  rest(): void {
    this.#handler?.rest();
  }

  /**
   * Delegates to the handler's `serialize()`, for `ClientEntities.serialize()` to fold in
   * alongside this edict's own classname/origin/angles/velocity.
   * @returns The handler's saved extras, or `null` when there is no handler or it saved nothing.
   */
  serialize(): SerializedData | null {
    return this.#handler ? this.#handler.serialize() : null;
  }

  /**
   * Delegates to the handler's `deserialize()`, restoring the extras `serialize()` captured.
   */
  deserialize(data: SerializedData): void {
    this.#handler?.deserialize(data);
  }

  toString(): string {
    return `${this.num.toFixed(0).padStart(3, ' ')}: ${(this.classname || '(no classname)').padEnd(32)} ${(this.model?.name || '-').padEnd(32)}: [${this.origin}], ${this.angles}`;
  }
}

/** How far in front of a wall a light that was pulled out of it is left, in world units. */
const LIGHT_WALL_MARGIN = 4.0;

export default class ClientEntities {
  /**
   * All client-owned entities (`num === -1`), allocated via `allocateClientEntity()`. Despite the
   * name, this holds two different intents: `svc_spawnstatic` decorations (spawn once, never
   * move, regenerated automatically by the server's signon on every (re)connect) and future
   * client-only simulated entities such as debris (spawned procedurally, expected to move and
   * eventually free themselves). The name is kept for now since it still matches the wire
   * message (`svc_spawnstatic`) that populates most of today's entries.
   */
  static_entities: ClientEdict[] = [];

  /** all server managed entities */
  entities: ClientEdict[] = [];

  /** visible entities staged for the next frame */
  visedicts: ClientEdict[] = [];

  /** all temporary entities, will last one frame */
  temp_entities: ClientEdict[] = [];

  /** current dynamic lights */
  dlights: ClientDlight[] = [];

  /** current configured lightstyles (set by the server) */
  lightstyle: string[] = [];

  /** current beams */
  beams: ClientBeam[] = [];

  /** Scratch for where a beam's shooter has its muzzle. */
  readonly #beamMuzzle = new Vector();

  num_temp_entities = 0;
  num_visedicts = 0;

  /**
   * The PVS of the view the last `emit()` pass was made for, `null` before the first pass of a map.
   */
  #viewVisibility: Visibility | null = null;

  /** Counts the `emit()` passes, so an entity can tell whether its parent was put on screen in this one. */
  #emitSerial = 0;

  /** The attached entities of the current `emit()` pass, waiting for their parents (`#emitAttachedEntities`). */
  readonly #attachedCandidates: ClientEdict[] = [];

  /**
   * The entities of the current `emit()` pass that hang on the view model (directly or through a chain), which are drawn
   * with it and not with the world (`resolveViewmodelAttachments`).
   */
  readonly #viewmodelAttachments: ClientEdict[] = [];

  tempEntitySounds: TempEntitySounds = {
    wizhit: null,
    knighthit: null,
    tink1: null,
    ric1: null,
    ric2: null,
    ric3: null,
    explosion: null,
  };

  /** available tent models, initialized in initTempEntities */
  tempEntityModels: Record<string, BaseModel | null> = {};

  constructor() {
    this.clear();
  }

  async initTempEntities(): Promise<void> {
    this.tempEntitySounds = {
      wizhit: S.PrecacheSound('wizard/hit.wav'),
      knighthit: S.PrecacheSound('hknight/hit.wav'),
      tink1: S.PrecacheSound('weapons/tink1.wav'),
      ric1: S.PrecacheSound('weapons/ric1.wav'),
      ric2: S.PrecacheSound('weapons/ric2.wav'),
      ric3: S.PrecacheSound('weapons/ric3.wav'),
      explosion: S.PrecacheSound('weapons/r_exp3.wav'),
    };

    for (const { model, name } of await Promise.all([
      'progs/bolt.mdl',
      'progs/bolt2.mdl',
      'progs/bolt3.mdl',
      'progs/beam.mdl', // CR: does not exist in Quake
    ].map((model) => Mod.ForNameAsync(model, false, ModelScope.client).then((loadedModel) => ({ model: loadedModel, name: model }))))) {
      this.tempEntityModels[name] = model;
    }
  }

  /**
   * @param id lightstyle number
   * @param style lightstyle sequence
   */
  setLightstyle(id: number, style: string): void {
    console.assert(id >= 0 && id < this.lightstyle.length, 'id must be in range');

    this.lightstyle[id] = style;
  }

  clear(): void {
    this.static_entities.length = 0;
    this.visedicts.length = 0;
    this.entities.length = 0;
    this.temp_entities.length = 0;

    this.num_temp_entities = 0;
    this.num_visedicts = 0;
    this.#viewVisibility = null;

    // preallocate
    this.dlights.length = Def.limits.dlights;
    this.lightstyle.length = Def.limits.lightstyles;
    this.beams.length = Def.limits.beams;

    for (let i = 0; i < Def.limits.dlights; i++) {
      this.dlights[i] = new ClientDlight();
    }

    for (let i = 0; i < Def.limits.lightstyles; i++) {
      this.lightstyle[i] = '';
    }

    for (let i = 0; i < Def.limits.beams; i++) {
      this.beams[i] = new ClientBeam();
    }
  }

  setSolidEntities(pmove: Pmove): void {
    pmove.clearEntities();

    for (const clent of this.getEntities()) {
      if (clent.num === 0 || clent.model === null) {
        continue;
      }

      // Only solid entities participate in player movement collision.
      // SOLID_TRIGGER and SOLID_NOT entities must not block the player.
      const s = clent.solid;
      if (s !== solid.SOLID_BSP && s !== solid.SOLID_BBOX && s !== solid.SOLID_SLIDEBOX) {
        continue;
      }

      const brushModel = s === solid.SOLID_BSP ? clent.model as BrushModel : null;
      pmove.addEntity(clent, brushModel);
    }
  }

  printEntities(): void {
    Con.Print('Entities:\n');
    for (const ent of this.getEntities()) {
      if (ent.model === null) {
        continue;
      }

      Con.Print(`${ent}\n`);
    }
  }

  allocateDynamicLight(entityId: number): ClientDlight {
    let dl: ClientDlight | null = null;

    if (entityId === -1) {
      entityId = 0;
    }

    // go by entity number first
    if (entityId !== 0) {
      for (let i = 0; i < Def.limits.dlights; i++) {
        if (this.dlights[i].entity === entityId) {
          dl = this.dlights[i];
          break;
        }
      }
    }

    // find a free one
    if (dl === null) {
      for (let i = 0; i < Def.limits.dlights; i++) {
        if (this.dlights[i].isFree()) {
          dl = this.dlights[i];
          break;
        }
      }

      // if no free one found, use the first one
      if (dl === null) {
        dl = this.dlights[0];
      }
    }

    dl.origin = new Vector();
    dl.radius = 0.0;
    dl.die = 0.0;
    dl.decay = 0.0;
    dl.minlight = 0.0;
    dl.entity = entityId;
    dl.color.setTo(1.0, 1.0, 1.0);
    dl.bornTime = clientRuntimeState.time;
    return dl;
  }

  /**
   * Allocates a temporary entity. It will last one frame.
   * @param classname optional classname to set for the temporary entity
   * @returns a new temporary entity
   */
  allocateTempEntity(classname: string | null = null): ClientEdict {
    const ent = new ClientEdict(-1);

    this.temp_entities[this.num_temp_entities++] = ent;
    this.visedicts[this.num_visedicts++] = ent;

    if (classname !== null) {
      ent.classname = classname;
      ent.loadHandler();
    }

    return ent;
  }

  /**
   * Allocates a client-only entity, i.e. one with no corresponding server-tracked slot.
   * It will not be managed by the server. Used both for `svc_spawnstatic` decorations (parsed off
   * the wire, regenerated automatically by the server's signon on every (re)connect) and, in the
   * future, for procedurally-spawned client-side effects (debris, gibs, projectiles etc.) that
   * need to move and eventually free themselves.
   * @param classname optional classname to set for the entity
   * @returns a new client-only entity
   */
  allocateClientEntity(classname: string | null = null): ClientEdict {
    const ent = new ClientEdict(-1);

    if (classname !== null) {
      ent.classname = classname;
      ent.loadHandler();
    }

    ent.free = false;
    ent.updatecount = 1; // force it to be considered for rendering

    // find a free static entity slot
    for (let i = 0; i < this.static_entities.length; i++) {
      if (this.static_entities[i].free) {
        this.static_entities[i] = ent;
        return ent;
      }
    }

    this.static_entities.push(ent);

    return ent;
  }

  /**
   * Allocates a map-baked `svc_spawnstatic` decoration. `persistent` stays `false`: `SV.
   * SpawnServer()` re-emits `makeStatic()` and thus regenerates these from scratch on every
   * (re)connect, so `serialize()` correctly excludes them -- saving them would be redundant.
   * @param classname classname to set for the entity
   * @returns a new, non-persistent client-only entity
   */
  allocateStaticEntity(classname: string): ClientEdict {
    return this.allocateClientEntity(classname);
  }

  /**
   * Allocates a procedurally-spawned client-only entity (debris, gibs, shell casings, ...) that
   * has no second source of truth to regenerate it from, so `persistent` is set and `serialize()`
   * captures it for save/load.
   * @param classname classname to set for the entity
   * @returns a new, persistent client-only entity
   */
  allocateSimulatedEntity(classname: string): ClientEdict {
    const ent = this.allocateClientEntity(classname);
    ent.persistent = true;
    return ent;
  }

  /**
   * Captures every persistent, live client-only entity for save/load: `classname` + `origin` +
   * `angles` + `velocity` (the universal fields every client-only entity has) plus one opaque
   * blob from the owning handler (`ClientEdict.serialize()`). Mirrors `Particles.SerializeParticles()`'s
   * shape and round-trip, extended to the handler-owned tagged `SerializedData` format (see
   * `source/shared/ClientSerialization.ts`) instead of particles' flat fields, since a handler's
   * extra state can be richer than a single die time.
   * @returns The saved client-only entities.
   */
  serialize(): SerializedClientEntity[] {
    const result: SerializedClientEntity[] = [];

    for (const clent of this.static_entities) {
      if (!clent.persistent || clent.free) {
        continue;
      }

      console.assert(clent.classname !== null, 'a persistent client-only entity must have a classname');

      if (clent.classname === null) {
        continue;
      }

      result.push({
        classname: clent.classname,
        model: clent.model?.name ?? null,
        origin: [clent.origin[0], clent.origin[1], clent.origin[2]],
        angles: [clent.angles[0], clent.angles[1], clent.angles[2]],
        velocity: [clent.velocity[0], clent.velocity[1], clent.velocity[2]],
        movetype: clent.movetype,
        avelocity: [clent.avelocity[0], clent.avelocity[1], clent.avelocity[2]],
        gravity: clent.gravity,
        onGround: clent.onGround,
        sequence: clent.sequence,
        animtime: clent.animtime,
        framerate: clent.framerate,
        handlerData: clent.serialize(),
      });
    }

    return result;
  }

  /**
   * Restores persistent client-only entities saved by `serialize()`: re-creates each one via
   * `allocateSimulatedEntity()`, restores its model by name from the client's precache list (a
   * model that is no longer precached leaves it `null`), spawns it, restores its universal
   * fields, then hands the saved blob (if any) to the handler's `deserialize()`. The model comes
   * first so `setOrigin()` links against it and fills `leafs` for the entity's first frame back
   * (an unlinked entity would be culled until it moved, problem #5's stale-PVS footgun); a handler
   * whose `spawn()` assigns its own model still wins, as it does for a freshly spawned entity. The
   * engine-driven physics state (`movetype` and friends) is restored after `spawn()` as well, so
   * what a handler sets there while spawning does not overwrite what was saved.
   * `deserialize()` runs last so it can correct whatever `spawn()`'s fresh-entity defaults
   * initialized.
   */
  deserialize(data: readonly SerializedClientEntity[]): void {
    for (const entry of data) {
      const clent = this.allocateSimulatedEntity(entry.classname);

      if (entry.model !== null) {
        clent.model = clientRuntimeState.model_precache.find((model) => model?.name === entry.model) ?? null;
      }

      clent.spawn();
      clent.setOrigin(new Vector(entry.origin[0], entry.origin[1], entry.origin[2]));
      clent.angles.setTo(entry.angles[0], entry.angles[1], entry.angles[2]);
      clent.velocity.setTo(entry.velocity[0], entry.velocity[1], entry.velocity[2]);
      clent.movetype = entry.movetype;
      clent.avelocity.setTo(entry.avelocity[0], entry.avelocity[1], entry.avelocity[2]);
      clent.gravity = entry.gravity;
      clent.onGround = entry.onGround;
      clent.sequence = entry.sequence ?? -1;
      clent.animtime = entry.animtime ?? 0.0;
      clent.framerate = entry.framerate ?? 1.0;

      if (entry.handlerData !== null) {
        clent.deserialize(entry.handlerData);
      }
    }
  }

  /**
   * Returns a client entity by its number.
   * If the entity does not exist, it will be allocated as a null entity.
   * @param num entity number
   * @returns entity
   */
  getEntity(num: number): ClientEdict {
    if (this.entities[num] !== undefined) {
      return this.entities[num];
    }

    console.assert(num >= 0, 'num must be >= 0, -1 is reserved for static entities');

    // preallocate entities
    while (this.entities.length <= num) {
      this.entities.push(new ClientEdict(this.entities.length));
    }

    return this.entities[num]!;
  }

  /**
   * Where a beam starts this frame. The server sends the shooter's origin; a shooter whose model has a muzzle (its own
   * `tag_flash`, or that of the weapon it holds) gets the beam there instead, every frame, so it leaves the weapon and
   * follows it. The same tag places the muzzle flash. Without a muzzle the beam starts where the server said.
   *
   * The local player in first person is the exception: the player's model is not drawn, so its muzzle is not on the
   * screen (the viewmodel is), and the beam starts at the player's origin, as it always did. In a chase view the model is
   * drawn and the muzzle is used.
   * @returns The start, `null` when the beam is the local player's and the player entity is not there.
   */
  #beamStart(beam: ClientBeam): Vector | null {
    const isFirstPerson = beam.entity === clientRuntimeState.viewentity && !Chase.active.value;

    if (isFirstPerson) {
      return clientRuntimeState.playerentity?.origin ?? null;
    }

    const shooter = beam.entity > 0 ? this.entities[beam.entity] : undefined;

    if (shooter !== undefined && !shooter.free && EntityTags.resolveMuzzleFlash(shooter, this.#beamMuzzle)) {
      return this.#beamMuzzle;
    }

    if (beam.entity === clientRuntimeState.viewentity) {
      return clientRuntimeState.playerentity?.origin ?? null;
    }

    return beam.start;
  }

  #thinkTempEntities(): void {
    // TODO: rework
    this.num_temp_entities = 0;
    for (let i = 0; i < Def.limits.beams; i++) {
      let yaw: number;
      let pitch: number;
      const b = this.beams[i];
      if (b.model === null || b.endtime < clientRuntimeState.time) {
        continue;
      }
      const start = this.#beamStart(b);
      if (start === null) {
        continue;
      }
      const dist = b.end.copy().subtract(start);
      if ((dist[0] === 0.0) && (dist[1] === 0.0)) {
        yaw = 0;
        pitch = dist[2] > 0.0 ? 90 : 270;
      } else {
        yaw = (Math.atan2(dist[1], dist[0]) * 180.0 / Math.PI) || 0;
        if (yaw < 0) {
          yaw += 360;
        }
        pitch = (Math.atan2(dist[2], Math.hypot(dist[0], dist[1])) * 180.0 / Math.PI) || 0;
        if (pitch < 0) {
          pitch += 360;
        }
      }
      const org = start.copy();

      let d = dist.len();

      if (d !== 0.0) {
        dist.normalize();
      }

      while (d > 0.0) {
        // non-vanilla feature: colors and fullbright beam (TODO: feature flag)
        const dl = this.allocateDynamicLight(0);
        dl.origin = org.copy();
        dl.radius = 50;
        dl.die = clientRuntimeState.time + 0.1;
        dl.color.setTo(0.7, 0.7, 1.0);

        const ent = this.allocateTempEntity();
        ent.origin = org.copy();
        ent.model = b.model;
        ent.effects |= effect.EF_FULLBRIGHT; // <<< this too
        ent.angles = new Vector(pitch, yaw, Math.random() * 360.0);
        org[0] += dist[0] * 30.0;
        org[1] += dist[1] * 30.0;
        org[2] += dist[2] * 30.0;
        d -= 30.0;
        ent.spawn();
      }
    }
  }

  /**
   * Keeps the light of an entity on the entity's side of the walls. A game places it at the entity's muzzle, 20 units
   * ahead of the origin, which is farther than a player's hull is wide: flush against a wall (or a closed door) the
   * light is inside the wall, and the world's shadow swallows it, leaving only the shooter lit. Walking away from the
   * wall made it appear. The light is moved back along the line from the entity's origin to where the game put it, to
   * `LIGHT_WALL_MARGIN` units before the first wall on it.
   *
   * Lights that belong to no server entity (explosions, beams, client-only entities) are left where they are. So is a
   * light of an entity whose own origin is in solid, which is a noclipping player.
   */
  #pullLightsOutOfWalls(): void {
    for (const dl of this.dlights) {
      if (dl.entity <= 0 || dl.isFree()) {
        continue;
      }

      const owner = this.entities[dl.entity];

      if (owner === undefined || owner.free || owner.origin.isInfinite()) {
        continue;
      }

      const start = owner.origin;
      const trace = clientCollision.traceStaticWorldLine(start, dl.origin);

      if (trace.fraction >= 1.0 || trace.startsolid) {
        continue;
      }

      const reach = Math.max(dl.origin.distanceTo(start) * trace.fraction - LIGHT_WALL_MARGIN, 0.0);
      const direction = dl.origin.copy().subtract(start);

      direction.normalize();
      dl.origin = start.copy().add(direction.multiply(reach));
    }
  }

  #thinkDlights(): void {
    for (let i = 0; i < Def.limits.dlights; i++) {
      const dl = this.dlights[i];

      if (dl.isFree()) {
        continue;
      }

      dl.think();
    }
  }

  #thinkEntities(): void {
    for (const clent of this.getEntities()) {
      clent.think();
    }
  }

  /**
   * Steps the engine-driven physics of every client-owned entity that is tossed or bouncing and not
   * at rest yet. Skipped while paused.
   */
  #physicsEntities(): void {
    if (clientRuntimeState.paused) {
      return;
    }

    const frametime = Host.frametime;

    for (const clent of this.static_entities) {
      if (clent.free || clent.onGround) {
        continue;
      }

      if (clent.movetype === moveType.MOVETYPE_TOSS || clent.movetype === moveType.MOVETYPE_BOUNCE) {
        ClientEntityPhysics.step(clent, frametime);
      }
    }
  }

  think(): void {
    this.#physicsEntities();
    this.#thinkEntities();
    this.#thinkTempEntities();
    this.#thinkDlights();
  }

  #emitEntities(): void {
    // reset all visible entities
    this.num_visedicts = 0;

    for (let i = 1; i < this.entities.length; i++) {
      const clent = this.entities[i];

      // freed entity
      if (clent.free) {
        continue;
      }

      // entity has not been updated yet
      if (clent.updatecount === 0) {
        continue;
      }

      // skip position update for the player when prediction already set the correct position
      if (clientRuntimeState.predicted && clent.num === clientRuntimeState.viewentity) {
        // prediction already set origin/velocity, only update angles from server state
        clent.angles.set(clent.msg_angles[0]);
        // a server message snapshots originPrevious, which must not leak into the rendered origin (see chase cam)
        clent.dropOriginLerp();
      } else {
        clent.updatePosition(clent.num !== clientRuntimeState.viewentity);
      }

      // if the entity is not visible, skip it
      if (clent.model === null || (clent.effects & effect.EF_NODRAW)) {
        continue;
      }

      // do not render the player entity, unless we are in chase cam mode
      if (i === clientRuntimeState.viewentity && !Chase.active.value) {
        continue;
      }

      this.#stageOrDefer(clent);
    }

    const worldmodel = clientRuntimeState.worldmodel;
    console.assert(worldmodel !== null, 'worldmodel must be set before emitting client entities');
    if (worldmodel === null) {
      return;
    }

    // get the PVS for the current view
    const vis = rendererCvars.novis.value !== 0 ? revealedVisibility : worldmodel.getPvsByPoint(Camera.refdef.vieworg);
    this.#viewVisibility = vis;

    for (const clent of this.static_entities) {
      // freed entity or invisible entity
      if (clent.free || clent.model === null || (clent.effects & effect.EF_NODRAW)) {
        continue;
      }

      // entity has not been updated yet
      if (clent.updatecount === 0) {
        continue;
      }

      // an attached entity is where its parent is, so it has no leaves of its own to look up
      if (clent.attachmentParent === null && !vis.areRevealed(clent.leafs)) {
        continue;
      }

      this.#stageOrDefer(clent);
    }
  }

  /**
   * Puts an entity on screen, or holds it back when it is attached: an attached entity is drawn exactly when its parent
   * is, which is only known once every entity has been looked at (`#emitAttachedEntities`).
   * @param clent The entity, already checked for having a model and not being hidden.
   */
  #stageOrDefer(clent: ClientEdict): void {
    if (clent.attachmentParent !== null) {
      this.#attachedCandidates.push(clent);
      return;
    }

    clent.emit();
    this.#stage(clent);
  }

  #stage(clent: ClientEdict): void {
    clent.emitSerial = this.#emitSerial;
    this.visedicts[this.num_visedicts++] = clent;
  }

  /**
   * Resolves the entities attached to others and puts those whose parent is on screen on screen too, parents first so
   * a chain (a flash on a weapon on a player) works whatever order the entities are numbered in. An entity whose
   * parent is not drawn, or cannot be placed, or is in a loop, stays out.
   */
  #emitAttachedEntities(): void {
    const pending = this.#attachedCandidates;

    this.#takeViewmodelAttachments(pending);

    for (let round = 0; round < MAX_ATTACHMENT_DEPTH && pending.length > 0; round++) {
      let remaining = 0;

      for (const clent of pending) {
        if (clent.attachmentParent!.emitSerial !== this.#emitSerial) {
          pending[remaining++] = clent;
          continue;
        }

        // the handler runs first: what it does to the entity's own angles (a spinning pickup) is part of its offset
        clent.emit();

        if (EntityAttachments.resolve(clent)) {
          this.#stage(clent);
        }
      }

      pending.length = remaining;
    }

    pending.length = 0;
  }

  /**
   * Moves the entities that hang on the view model out of the candidates. The view model is placed after the entity list
   * is built (`FirstPersonView.CalcRefdef`) and drawn with a projection of its own, so what hangs on it is resolved and
   * drawn with it (`resolveViewmodelAttachments`), not with the world. The entity's handler runs now, like it does for the others.
   * @param pending The attached candidates of this pass; the ones that hang on the view model are removed.
   */
  #takeViewmodelAttachments(pending: ClientEdict[]): void {
    const viewmodel = clientRuntimeState.viewent;

    if (viewmodel === null) {
      return;
    }

    let remaining = 0;

    for (const clent of pending) {
      if (findAttachmentRoot(clent) !== viewmodel) {
        pending[remaining++] = clent;
        continue;
      }

      clent.emit();
      this.#viewmodelAttachments.push(clent);
    }

    pending.length = remaining;
  }

  /**
   * Places what hangs on the view model, now that the view model has its place for the frame, and says what is to be drawn
   * with it. An entity that cannot be placed (its parent has no model, or the chain loops) is left out.
   * @returns The entities to draw with the view model, in the order they were staged. Reused: valid until the next `emit()`.
   */
  resolveViewmodelAttachments(): readonly ClientEdict[] {
    const attachments = this.#viewmodelAttachments;
    let remaining = 0;

    for (const clent of attachments) {
      if (EntityAttachments.resolve(clent)) {
        attachments[remaining++] = clent;
      }
    }

    attachments.length = remaining;

    return attachments;
  }

  /**
   * Tells whether an entity sits in the PVS of the current view, i.e. whether the player could see
   * it from where they are. Unlike the emit pass this also answers for entities that are not drawn
   * (`EF_NODRAW`), which lets an invisible effect source skip its work while nobody can see it.
   * Reflects the view of the last `emit()` pass, so it lags by a frame.
   * @param clent the entity to check, its `leafs` have to be linked
   * @returns True when the entity is in the PVS, or when there is nothing to tell it by: no view
   * has been processed yet, or the entity is not linked into any leaf.
   */
  isPotentiallyVisible(clent: ClientEdict): boolean {
    return this.#viewVisibility === null || clent.leafs.length === 0 || this.#viewVisibility.areRevealed(clent.leafs);
  }

  #emitProjectiles(): void {
    // TODO: implement
  }

  #emitTempEntities(): void {
    for (let i = 0; i < this.num_temp_entities; i++) {
      const ent = this.temp_entities[i];
      if (ent.model === null || ent.free) {
        continue;
      }

      this.#stageOrDefer(ent);
    }
  }

  emit(): void {
    if (clientRuntimeState.worldmodel === null) {
      // no world model, nothing to render
      return;
    }

    this.#emitSerial++;
    this.#attachedCandidates.length = 0;
    this.#viewmodelAttachments.length = 0;

    this.#emitEntities();
    this.#emitProjectiles();
    this.#emitTempEntities();
    this.#emitAttachedEntities();
    this.#pullLightsOutOfWalls();
  }

  /**
   * Returns all entities in the game.
   * Both client-only and server entities.
   * @yields entity
   */
  *getEntities(): Generator<ClientEdict, void, void> {
    for (const entity of this.entities) {
      if (!entity || entity.free) {
        continue;
      }

      yield entity;
    }

    for (const entity of this.static_entities) {
      if (!entity || entity.free) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Contains all entities that are staged to be rendered.
   * @yields entity
   */
  *getVisibleEntities(): Generator<ClientEdict, void, void> {
    for (let i = 0; i < this.num_visedicts; i++) {
      const entity = this.visedicts[i];
      if (entity !== undefined) {
        yield entity;
      }
    }
  }
}
