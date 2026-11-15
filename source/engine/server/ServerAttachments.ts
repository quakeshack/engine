import type { BaseModel } from '../common/model/BaseModel.ts';
import type { ServerEdict } from './Edict.ts';
import type Server from './Server.ts';

import Vector, { Quaternion } from '../../shared/Vector.ts';
import { AttachmentTransform, MAX_ATTACHMENT_DEPTH, TRANSFORM_SIZE } from '../common/AttachmentTransform.ts';
import { SkeletalAnimation } from '../common/model/SkeletalAnimation.ts';
import { SkeletalModel } from '../common/model/SkeletalModel.ts';

/**
 * What the server does with attachments beyond remembering them (`ServerEdict.setAttachment`): resolving a tag name
 * against the parent's current model, and finding where a child is in the world, which it needs when its parent goes
 * away and the child stays behind. The client resolves the same chain for drawing (`EntityAttachments`), from the same
 * maths (`AttachmentTransform`).
 */
export class ServerAttachments {
  private constructor() {
    // Static-only helper class.
  }

  static readonly #pose: [number, number, number] = [0, 0, 0];
  static readonly #tag = new Float64Array(TRANSFORM_SIZE);
  static readonly #childRotation = new Float64Array(4);
  static readonly #parentTransforms = Array.from({ length: MAX_ATTACHMENT_DEPTH + 1 }, () => new Float64Array(TRANSFORM_SIZE));

  /**
   * The model an edict is drawn with, as far as the server has it.
   * @returns The model, `null` for an edict without one and for one that has not finished loading.
   */
  static modelOf(server: Server, edict: ServerEdict): BaseModel | null {
    const modelindex = edict.entity?.modelindex ?? 0;

    if (modelindex === 0) {
      return null;
    }

    const model = server.server.models[modelindex];

    return model === undefined || model === null || model instanceof Promise ? null : model;
  }

  /**
   * Looks a tag up in the parent's model as it is right now, so a parent that switches model (a player picking up a
   * weapon with its own rig) is followed without the game telling the child again.
   * @returns The tag's index, -1 when the parent has no model, the model has no such tag, or no tag name was given.
   */
  static tagIndex(server: Server, parent: ServerEdict, tagName: string | null): number {
    if (tagName === null) {
      return -1;
    }

    return ServerAttachments.modelOf(server, parent)?.getTagIndex(tagName) ?? -1;
  }

  /**
   * Finds where an attached edict is in the world: its parent's transform (itself resolved through the chain) times the
   * tag in the parent's pose, times the child's own origin and angles. The pose is the one the parent's `sequence` has
   * reached when the game set its `animtime`, and the parent's `frame` otherwise, without blending: the clients draw
   * the blended one, and the difference is a fraction of a frame.
   * @param server The server.
   * @param edict The attached edict.
   * @param out Receives origin `x, y, z` and rotation `w, x, y, z`.
   * @param depth How many parents deep this call is, to stop a chain that loops.
   * @returns `false` when the chain is deeper than `MAX_ATTACHMENT_DEPTH` or reaches a free edict, and `out` is untouched.
   */
  static worldTransformInto(server: Server, edict: ServerEdict, out: Float64Array, depth = 0): boolean {
    const entity = edict.entity;

    if (entity === null || edict.isFree()) {
      return false;
    }

    const parent = edict.attachmentParent;

    if (parent === null) {
      AttachmentTransform.fromOriginAnglesInto(out, entity.origin, entity.angles);
      return true;
    }

    if (depth >= MAX_ATTACHMENT_DEPTH) {
      return false;
    }

    const parentTransform = ServerAttachments.#parentTransforms[depth];

    if (!ServerAttachments.worldTransformInto(server, parent, parentTransform, depth + 1)) {
      return false;
    }

    const tag = ServerAttachments.#sampleTag(server, parent, edict.attachmentTagIndex());
    const childRotation = ServerAttachments.#childRotation;

    Quaternion.fromModelAnglesInto(childRotation, 0, entity.angles);
    AttachmentTransform.composeInto(out, parentTransform, tag, entity.origin, childRotation);
    return true;
  }

  /**
   * The tag of a parent in the pose it is in on the server.
   * @returns The tag as origin and rotation, `null` to attach to the parent's origin.
   */
  static #sampleTag(server: Server, parent: ServerEdict, tagIndex: number): Float64Array | null {
    const model = ServerAttachments.modelOf(server, parent);

    if (tagIndex < 0 || !(model instanceof SkeletalModel)) {
      return null;
    }

    const entity = parent.entity!;
    const pose = ServerAttachments.#pose;
    const tag = ServerAttachments.#tag;
    const animtime = entity.animtime ?? null;
    const playing = (entity.sequence ?? -1) >= 0 && animtime !== null
      && SkeletalAnimation.samplePlayback(model, entity.sequence!, server.server.time - animtime, entity.framerate ?? 1.0, false, pose);

    if (!playing) {
      pose[0] = entity.frame;
      pose[1] = entity.frame;
      pose[2] = 0;
    }

    return model.sampleTag(tagIndex, pose[0], pose[1], pose[2], tag) ? tag : null;
  }

  /**
   * Lets go of everything attached to an edict that is about to be freed, and keeps each child where it is in the
   * world, so a weapon its owner drops lies where it was held instead of at the origin of the map.
   * @param server The server.
   * @param parent The edict being freed, which still has its entity.
   * @param children Its attached children.
   */
  static releaseChildren(server: Server, parent: ServerEdict, children: Iterable<ServerEdict>): void {
    const world = new Float64Array(TRANSFORM_SIZE);
    const angles = new Vector();

    // detaching one child changes the parent's set, so work on a copy
    for (const child of [...children]) {
      const resolved = ServerAttachments.worldTransformInto(server, child, world);

      child.clearAttachment();

      if (!resolved || child.isFree()) {
        continue;
      }

      Quaternion.toModelAnglesInto(angles, 0, world, 3);
      child.entity!.angles.set(angles);
      child.setOrigin(new Vector(world[0], world[1], world[2]));
    }

    console.assert(parent.attachedChildren.size === 0, 'ServerAttachments.releaseChildren: a child is still attached');
  }
}
