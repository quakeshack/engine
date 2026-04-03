import type { Hull } from '../../common/model/BSP.ts';
import type { ServerEdict } from '../Edict.mjs';

import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import CollisionModelSource, { createRegistryCollisionModelSource } from '../../common/CollisionModelSource.ts';
import { BrushModel, MeshModel } from '../../common/Mod.ts';
import { BrushTrace, DIST_EPSILON, Trace as SharedTrace } from '../../common/Pmove.ts';
import { eventBus, getCommonRegistry } from '../../registry.mjs';
import {
  BrushCollisionState,
  CollisionState,
  CollisionTrace,
  HullCollisionState,
  MeshCollisionState,
  MeshTraceContext,
  MeshTriangle,
  MoveClip,
} from './ServerCollisionSupport.ts';
import {
  hullPointContents as legacyHullPointContents,
  pointContents as legacyPointContents,
  recursiveHullCheck as legacyRecursiveHullCheck,
} from './ServerLegacyHullCollision.ts';

type CollisionModel = BrushModel | MeshModel | object | null;

interface StaticWorldSource {
  readonly worldEntity: ServerEdict | null;
  readonly worldModel: BrushModel | null;
}

interface TraceExtents {
  readonly mins: Vector;
  readonly maxs: Vector;
}

let { Con, SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, SV } = getCommonRegistry());
});

/**
 * Handles collision detection and tracing for entities in the world.
 * Uses shared brush tracing for BSP models when brush data is available,
 * falling back to legacy hull traces otherwise.
 */
export class ServerCollision {
  static readonly MISSILE_MINS = new Vector(-15.0, -15.0, -15.0);
  static readonly MISSILE_MAXS = new Vector(15.0, 15.0, 15.0);

  private readonly _modelSource: CollisionModelSource;

  /**
   * Resolve a collision model by model index from either the active server or
   * the client precache populated by server signon data.
   */
  constructor(modelSource: CollisionModelSource = createRegistryCollisionModelSource()) {
    this._modelSource = modelSource;
  }

  /**
   * Resolve a collision model by model index from either the active server or
   * the client precache populated by server signon data.
   */
  _getModelByIndex(modelIndex: number): CollisionModel {
    return this._modelSource.getModelByIndex(modelIndex);
  }

  /**
   * Resolve the model used by an entity for collision.
   */
  _getEntityModel(ent: ServerEdict): CollisionModel {
    if (ent === SV.server?.edicts?.[0]) {
      return this._getStaticWorldSource().worldModel;
    }

    return this._getModelByIndex(ent.entity!.modelindex);
  }

  /**
   * Resolve the collision state used by an entity during tracing.
   */
  _getEntityCollisionState(ent: ServerEdict): CollisionState | null {
    const entity = ent.entity!;

    if (entity.solid === Defs.solid.SOLID_MESH) {
      const model = this._getEntityModel(ent);
      return this._isMeshModel(model)
        ? new MeshCollisionState(ent, model)
        : null;
    }

    if (entity.solid === Defs.solid.SOLID_BSP) {
      const model = this._getEntityModel(ent);

      if (!this._isBrushModel(model) || !model.hasBrushData) {
        return new HullCollisionState(ent);
      }

      return new BrushCollisionState(ent, model, entity.origin, entity.angles);
    }

    return new HullCollisionState(ent);
  }

  /**
   * Build a hull fallback state for callers that want a guaranteed collision mode.
   */
  _getHullFallbackState(ent: ServerEdict): HullCollisionState {
    return new HullCollisionState(ent);
  }

  /**
   * Resolve the active static-world model for traces that can run on either a
   * local server or a pure client connection.
   */
  _getStaticWorldSource(): StaticWorldSource {
    return {
      worldEntity: this._modelSource.getWorldEntity(),
      worldModel: this._modelSource.getWorldModel(),
    };
  }

  /**
   * Convert a shared brush trace result into the server collision trace shape.
   */
  _toServerTrace(brushTrace: SharedTrace, ent: ServerEdict | null): CollisionTrace {
    if (ent !== null) {
      return CollisionTrace.fromSharedTrace(brushTrace, ent);
    }

    const trace = new CollisionTrace(brushTrace.endpos.copy(), {
      fraction: brushTrace.fraction,
      allsolid: brushTrace.allsolid,
      startsolid: brushTrace.startsolid,
      plane: { normal: brushTrace.plane.normal.copy(), dist: brushTrace.plane.dist },
      inopen: brushTrace.inopen,
      inwater: brushTrace.inwater,
    });

    if (trace.allsolid) {
      trace.startsolid = true;
    }

    return trace;
  }

  /**
   * Returns true when the provided model is a brush model.
   */
  _isBrushModel(model: CollisionModel): model is BrushModel {
    return model instanceof BrushModel;
  }

  /**
   * Returns true when the provided model is a mesh model.
   */
  _isMeshModel(model: CollisionModel): model is MeshModel {
    return model instanceof MeshModel;
  }

  /**
   * Determine whether a trace is point-sized.
   */
  _isPointTrace(mins: Vector, maxs: Vector): boolean {
    return mins.isOrigin() && maxs.isOrigin();
  }

  /**
   * Emit a developer-only summary for point-trace hits so live repros can
   * distinguish world hull issues from dynamic-entity hits.
   */
  _debugLogPointTraceHit(trace: CollisionTrace, start: Vector, end: Vector, mins: Vector, maxs: Vector): void {
    if (!this._isPointTrace(mins, maxs)) {
      return;
    }

    if (trace.ent === null || (trace.fraction >= 1.0 && !trace.startsolid && !trace.allsolid)) {
      return;
    }

    console.assert(trace.ent.entity !== null, 'point trace hit entity must resolve to a live entity');
    const hitEntity = trace.ent.entity!;
    const model = this._getEntityModel(trace.ent);
    const modelName = model !== null
      && typeof model === 'object'
      && 'name' in model
      && typeof model.name === 'string'
      ? model.name
      : '<none>';
    const classname = typeof hitEntity.classname === 'string' ? hitEntity.classname : '<no classname>';

    Con.DPrint(
      `ServerCollision.move point trace hit ent=${trace.ent.num} classname=${classname} solid=${hitEntity.solid} movetype=${hitEntity.movetype} `
      + `modelindex=${hitEntity.modelindex} model=${modelName} fraction=${trace.fraction.toFixed(4)} `
      + `start=(${start[0].toFixed(1)} ${start[1].toFixed(1)} ${start[2].toFixed(1)}) `
      + `end=(${end[0].toFixed(1)} ${end[1].toFixed(1)} ${end[2].toFixed(1)}) `
      + `endpos=(${trace.endpos[0].toFixed(1)} ${trace.endpos[1].toFixed(1)} ${trace.endpos[2].toFixed(1)})\n`,
    );
  }

  /**
   * Legacy hull point traces remain the compatibility baseline when brush and
   * hull BSP paths disagree about the first finite hit.
   */
  _shouldPreferHullPointTrace(brushTrace: CollisionTrace, hullTrace: CollisionTrace): boolean {
    if (hullTrace.fraction >= 1.0) {
      return false;
    }

    if (brushTrace.allsolid && !hullTrace.allsolid) {
      return true;
    }

    if (brushTrace.startsolid && !hullTrace.startsolid) {
      return true;
    }

    return hullTrace.fraction > brushTrace.fraction + DIST_EPSILON;
  }

  /**
   * Hull fallback is only safe for point traces whose BSP entity is not rotated,
   * because the legacy hull path does not apply entity angles.
   */
  _canUseHullPointFallback(state: BrushCollisionState, mins: Vector, maxs: Vector): boolean {
    if (!this._isPointTrace(mins, maxs)) {
      return false;
    }

    if (state.ent === SV.server?.edicts?.[0]) {
      return true;
    }

    return state.angles.isOrigin();
  }

  /**
   * Trace a BSP entity through the shared brush path and cross-check supported
   * point traces against the legacy hull path to avoid false early hits.
   */
  _clipMoveToBrushStateWithHullFallback(
    state: BrushCollisionState,
    start: Vector,
    mins: Vector,
    maxs: Vector,
    end: Vector,
  ): CollisionTrace {
    const brushTrace = this._traceBrushModel(
      state.model,
      start,
      mins,
      maxs,
      end,
      state.origin,
      state.angles,
    );
    const serverBrushTrace = this._toServerTrace(brushTrace, state.ent);

    if (!this._canUseHullPointFallback(state, mins, maxs)) {
      return serverBrushTrace;
    }

    const hullTrace = this._clipMoveToHullState(this._getHullFallbackState(state.ent), start, mins, maxs, end);

    if (this._shouldPreferHullPointTrace(serverBrushTrace, hullTrace)) {
      return hullTrace;
    }

    return serverBrushTrace;
  }

  /**
   * Run the shared brush trace path for a BSP entity, including zero-length
   * position tests that must avoid swept-trace startsolid artifacts.
   */
  _traceBrushModel(
    model: BrushModel,
    start: Vector,
    mins: Vector,
    maxs: Vector,
    end: Vector,
    origin: Vector,
    angles: Vector,
  ): SharedTrace {
    if (start.equals(end)) {
      const blocked = !BrushTrace.transformedTestPosition(
        model,
        start,
        mins,
        maxs,
        origin,
        angles,
      );

      const trace = new SharedTrace();
      trace.allsolid = blocked;
      trace.startsolid = blocked;
      trace.fraction = blocked ? 0.0 : 1.0;
      trace.endpos.set(start);
      trace.plane.normal.clear();
      trace.plane.dist = 0.0;
      trace.inopen = false;
      trace.inwater = false;
      return trace;
    }

    return BrushTrace.transformedBoxTrace(
      model,
      start,
      end,
      mins,
      maxs,
      origin,
      angles,
    );
  }

  /**
   * Trace against an entity through the shared brush path.
   */
  _clipMoveToBrushState(state: BrushCollisionState, start: Vector, mins: Vector, maxs: Vector, end: Vector): CollisionTrace {
    return this._clipMoveToBrushStateWithHullFallback(state, start, mins, maxs, end);
  }

  /**
   * Trace against an entity through the legacy hull path.
   */
  _clipMoveToHullState(state: HullCollisionState, start: Vector, mins: Vector, maxs: Vector, end: Vector): CollisionTrace {
    const trace = CollisionTrace.hullInitial(end);

    const offset = new Vector();
    const hull = SV.area.hullForEntity(state.ent, mins, maxs, offset);
    const startLocal = start.copy().subtract(offset);
    const endLocal = end.copy().subtract(offset);

    this.recursiveHullCheck(hull, hull.firstclipnode ?? 0, 0.0, 1.0, startLocal, endLocal, trace);

    if (trace.fraction !== 1.0) {
      trace.endpos.add(offset);
    }

    if (trace.fraction < 1.0 || trace.startsolid) {
      trace.ent = state.ent;
    }

    return trace;
  }

  /**
   * Trace a line through a specific legacy hull without exposing clipnode walks
   * to higher-level callers.
   */
  _traceLegacyHullLine(hull: Hull, start: Vector, end: Vector): CollisionTrace {
    const trace = CollisionTrace.hullInitial(end);
    this.recursiveHullCheck(hull, hull.firstclipnode ?? 0, 0.0, 1.0, start, end, trace);
    return trace;
  }

  /**
   * Determines the contents inside a hull by descending the clipnode tree.
   */
  hullPointContents(hull: Hull, num: number, p: Vector): number {
    return legacyHullPointContents(hull, num, p);
  }

  /**
   * Normalize static-world contents values so current volumes behave like water.
   */
  _normalizeStaticWorldContents(contents: number): number {
    if ((contents <= Defs.content.CONTENT_CURRENT_0) && (contents >= Defs.content.CONTENT_CURRENT_DOWN)) {
      return Defs.content.CONTENT_WATER;
    }

    return contents;
  }

  /**
   * Sample the contents of a brush-backed world without exposing brush internals
   * to higher-level callers.
   */
  _pointContentsBrushStaticWorld(worldModel: BrushModel, point: Vector): number {
    if (!BrushTrace.transformedTestPosition(
      worldModel,
      point,
      Vector.origin,
      Vector.origin,
      Vector.origin,
      Vector.origin,
    )) {
      return Defs.content.CONTENT_SOLID;
    }

    return this._normalizeStaticWorldContents(worldModel.getLeafForPoint(point).contents);
  }

  /**
   * Sample static-world contents using the best collision backend for the
   * active map.
   */
  staticWorldContents(point: Vector, hullNum = 0): number {
    const { worldModel } = this._getStaticWorldSource();

    if (worldModel === null) {
      return Defs.content.CONTENT_EMPTY;
    }

    if (hullNum === 0 && worldModel.hasBrushData) {
      return this._pointContentsBrushStaticWorld(worldModel, point);
    }

    return this._normalizeStaticWorldContents(legacyPointContents(worldModel, point));
  }

  /**
   * Compatibility alias for staticWorldContents.
   */
  worldContents(point: Vector, hullNum = 0): number {
    return this.staticWorldContents(point, hullNum);
  }

  /**
   * Compatibility alias for staticWorldContents.
   */
  pointContents(p: Vector, hullNum = 0): number {
    return this.staticWorldContents(p, hullNum);
  }

  /**
   * Trace static-world geometry using the best collision backend for the active
   * map.
   */
  traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector, hullNum = 0): CollisionTrace {
    const { worldEntity, worldModel } = this._getStaticWorldSource();

    if (worldModel === null) {
      return CollisionTrace.empty(end);
    }

    if (hullNum === 0 && worldModel.hasBrushData) {
      return this._toServerTrace(
        this._traceBrushModel(worldModel, start, mins, maxs, end, Vector.origin, Vector.origin),
        worldEntity,
      );
    }

    if (hullNum === 0) {
      if (worldEntity === null) {
        if (!this._isPointTrace(mins, maxs)) {
          return CollisionTrace.empty(end);
        }

        return this._traceLegacyHullLine(worldModel.hulls[0], start, end);
      }

      return this._clipMoveToHullState(this._getHullFallbackState(worldEntity), start, mins, maxs, end);
    }

    return this._traceLegacyHullLine(worldModel.hulls[hullNum], start, end);
  }

  /**
   * Compatibility alias for traceStaticWorld.
   */
  traceWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector, hullNum = 0): CollisionTrace {
    return this.traceStaticWorld(start, mins, maxs, end, hullNum);
  }

  /**
   * Trace a point-sized line against the static world.
   */
  traceStaticWorldLine(start: Vector, end: Vector, hullNum = 0): CollisionTrace {
    return this.traceStaticWorld(start, Vector.origin, Vector.origin, end, hullNum);
  }

  /**
   * Compatibility alias for traceStaticWorldLine.
   */
  traceWorldLine(start: Vector, end: Vector, hullNum = 0): CollisionTrace {
    return this.traceStaticWorldLine(start, end, hullNum);
  }

  /**
   * Recursively tests a swept hull against the world and aggregates the trace result.
   */
  recursiveHullCheck(
    hull: Hull,
    num: number,
    p1f: number,
    p2f: number,
    p1: Vector,
    p2: Vector,
    trace: CollisionTrace,
    depth = 0,
  ): boolean {
    return legacyRecursiveHullCheck(hull, num, p1f, p2f, p1, p2, trace, depth);
  }

  /**
   * Tests whether a point lies inside a triangle using cross-product winding.
   */
  _pointInTriangle(p: Vector, v0: Vector, v1: Vector, v2: Vector, normal: Vector): boolean {
    // Small negative tolerance closes micro-gaps between adjacent triangles.
    // The cross product magnitude scales with edge length, so for typical
    // game triangles (edges ~5-50 units) this allows roughly 0.01-0.025 units
    // of perpendicular tolerance per edge.
    const EDGE_TOLERANCE = -0.125;

    const d0 = normal.dot(v1.copy().subtract(v0).cross(p.copy().subtract(v0)));
    const d1 = normal.dot(v2.copy().subtract(v1).cross(p.copy().subtract(v1)));
    const d2 = normal.dot(v0.copy().subtract(v2).cross(p.copy().subtract(v2)));

    return d0 >= EDGE_TOLERANCE && d1 >= EDGE_TOLERANCE && d2 >= EDGE_TOLERANCE;
  }

  /**
   * Update a trace with start-solid information for a mesh triangle.
   */
  _updateMeshStartSolid(
    trace: CollisionTrace,
    meshTrace: MeshTraceContext,
    triangle: MeshTriangle,
    startDistance: number,
    supportRadius: number,
    approach: number,
  ): void {
    if (startDistance < -supportRadius) {
      return;
    }

    const projectedStart = meshTrace.projectPointOntoPlane(meshTrace.startCenter, triangle.normal, triangle.planeDist);
    if (!this._pointInTriangle(projectedStart, triangle.v0, triangle.v1, triangle.v2, triangle.normal)) {
      return;
    }

    trace.startsolid = true;
    if ((startDistance - approach) <= 0.0) {
      trace.allsolid = true;
    }
  }

  /**
   * Try to record a nearer face impact from a mesh triangle.
   */
  _updateMeshImpact(
    trace: CollisionTrace,
    meshTrace: MeshTraceContext,
    triangle: MeshTriangle,
    startDistance: number,
    approach: number,
  ): void {
    if (approach < DIST_EPSILON) {
      return;
    }

    let fraction = (startDistance - DIST_EPSILON) / approach;
    fraction = Math.max(0.0, Math.min(1.0, fraction));

    if (fraction >= trace.fraction) {
      return;
    }

    const hitCenter = meshTrace.getCenterAtFraction(fraction);
    const projectedHit = meshTrace.projectPointOntoPlane(hitCenter, triangle.normal, triangle.planeDist);
    if (!this._pointInTriangle(projectedHit, triangle.v0, triangle.v1, triangle.v2, triangle.normal)) {
      return;
    }

    trace.fraction = fraction;
    trace.plane.normal = triangle.normal.copy();
    trace.plane.dist = triangle.planeDist;
    trace.ent = meshTrace.ent;
  }

  /**
   * Build a mesh tracing context if the target entity has usable mesh data.
   */
  _createMeshTraceContext(ent: ServerEdict, start: Vector, mins: Vector, maxs: Vector, end: Vector): MeshTraceContext | null {
    const model = this._getEntityModel(ent);
    if (!this._isMeshModel(model) || model.indices === null || model.vertices === null || model.numTriangles === 0) {
      return null;
    }

    return new MeshTraceContext(ent, model, start, mins, maxs, end);
  }

  /**
   * Traces a moving box against a mesh entity using expanded face planes.
   * Each triangle face is expanded outward by the box's support radius
   * (Minkowski sum) and tested for ray intersection. A DIST_EPSILON push-back
   * keeps the endpoint slightly in front of the surface, preventing the next
   * frame's trace from starting on or inside the plane.
   */
  clipMoveToMesh(ent: ServerEdict, start: Vector, mins: Vector, maxs: Vector, end: Vector): CollisionTrace {
    const trace = CollisionTrace.empty(end);

    const meshTrace = this._createMeshTraceContext(ent, start, mins, maxs, end);
    if (meshTrace === null) {
      return trace;
    }

    for (let index = 0; index < meshTrace.model.numTriangles; index++) {
      const triangle = MeshTriangle.fromMesh(meshTrace, index);
      if (triangle === null) {
        continue;
      }

      const supportRadius = meshTrace.getBoxSupportRadius(triangle.normal);
      const approach = triangle.getApproach(meshTrace.moveDir);
      const startDistance = triangle.normal.dot(meshTrace.startCenter) - triangle.planeDist - supportRadius;

      if (startDistance <= 0.0) {
        this._updateMeshStartSolid(trace, meshTrace, triangle, startDistance, supportRadius, approach);
        continue;
      }

      this._updateMeshImpact(trace, meshTrace, triangle, startDistance, approach);
    }

    if (trace.fraction < 1.0) {
      trace.endpos = meshTrace.getTraceEndAtFraction(trace.fraction);
    }

    return trace;
  }

  /**
   * Traces a moving box against a target entity.
   */
  clipMoveToEntity(ent: ServerEdict, start: Vector, mins: Vector, maxs: Vector, end: Vector): CollisionTrace {
    const state = this._getEntityCollisionState(ent) ?? this._getHullFallbackState(ent);

    return this._clipMoveToEntityWithState(state, start, mins, maxs, end);
  }

  /**
   * Trace against a target entity using its pre-resolved collision state.
   */
  _clipMoveToEntityWithState(state: CollisionState, start: Vector, mins: Vector, maxs: Vector, end: Vector): CollisionTrace {
    if (state instanceof MeshCollisionState) {
      return this.clipMoveToMesh(state.ent, start, mins, maxs, end);
    }

    if (state instanceof BrushCollisionState) {
      return this._clipMoveToBrushState(state, start, mins, maxs, end);
    }

    return this._clipMoveToHullState(state, start, mins, maxs, end);
  }

  /**
   * Select the extents used to trace against a touched entity.
   * Missiles expand only against monsters.
   */
  _getTouchTraceExtents(clip: MoveClip, touch: ServerEdict): TraceExtents {
    if ((touch.entity!.flags & Defs.flags.FL_MONSTER) !== 0) {
      return { mins: clip.mins2, maxs: clip.maxs2 };
    }

    return { mins: clip.mins, maxs: clip.maxs };
  }

  /**
   * Determine whether a touched entity should be skipped before narrow-phase tracing.
   */
  _shouldSkipTouch(clip: MoveClip, touch: ServerEdict): boolean {
    const touchEntity = touch.entity!;

    if (touch === clip.passedict) {
      return true;
    }

    if (touchEntity.solid === Defs.solid.SOLID_NOT || touchEntity.solid === Defs.solid.SOLID_TRIGGER) {
      return true;
    }

    if (clip.type === Defs.moveTypes.MOVE_NOMONSTERS && touchEntity.solid !== Defs.solid.SOLID_BSP) {
      return true;
    }

    if (clip.passedict && clip.passedict.entity!.size[0] && !touchEntity.size[0]) {
      return true;
    }

    if (clip.passedict) {
      if (touchEntity.owner && touchEntity.owner.equals(clip.passedict)) {
        return true;
      }

      if (clip.passedict.entity!.owner && clip.passedict.entity!.owner.equals(touch)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check whether a touched entity overlaps the clip broadphase box.
   */
  _touchOverlapsClipBounds(clip: MoveClip, touch: ServerEdict): boolean {
    const touchEntity = touch.entity!;

    return !(
      clip.boxmins[0] > touchEntity.absmax[0]
      || clip.boxmins[1] > touchEntity.absmax[1]
      || clip.boxmins[2] > touchEntity.absmax[2]
      || clip.boxmaxs[0] < touchEntity.absmin[0]
      || clip.boxmaxs[1] < touchEntity.absmin[1]
      || clip.boxmaxs[2] < touchEntity.absmin[2]
    );
  }

  /**
   * Run narrow-phase tracing against a touched entity using the correct extents.
   */
  _traceTouch(clip: MoveClip, touch: ServerEdict): CollisionTrace {
    const touchState = this._getEntityCollisionState(touch) ?? this._getHullFallbackState(touch);
    const { mins, maxs } = this._getTouchTraceExtents(clip, touch);
    const trace = this._clipMoveToEntityWithState(touchState, clip.start, mins, maxs, clip.end);

    console.assert(
      Number.isFinite(trace.fraction)
      && Number.isFinite(trace.endpos[0])
      && Number.isFinite(trace.endpos[1])
      && Number.isFinite(trace.endpos[2])
      && Number.isFinite(trace.plane.normal[0])
      && Number.isFinite(trace.plane.normal[1])
      && Number.isFinite(trace.plane.normal[2])
      && Number.isFinite(trace.plane.dist),
      'ServerCollision._traceTouch produced malformed trace',
    );

    return trace;
  }

  /**
   * Replace the current best clip trace when a touched entity produced a nearer hit.
   */
  _updateClipTrace(clip: MoveClip, touch: ServerEdict, trace: CollisionTrace): void {
    if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
      trace.ent = touch;
      clip.trace = trace;
    }
  }

  /**
   * Fill the broadphase AABB used to query touched entities for a trace.
   */
  _updateClipBounds(clip: MoveClip): void {
    for (let index = 0; index < 3; index++) {
      if (clip.end[index] > clip.start[index]) {
        clip.boxmins[index] = clip.start[index] + clip.mins2[index] - 1.0;
        clip.boxmaxs[index] = clip.end[index] + clip.maxs2[index] + 1.0;
      } else {
        clip.boxmins[index] = clip.end[index] + clip.mins2[index] - 1.0;
        clip.boxmaxs[index] = clip.start[index] + clip.maxs2[index] + 1.0;
      }
    }
  }

  /**
   * Build the clip context used to trace a move through the world and dynamic entities.
   */
  _createMoveClip(
    start: Vector,
    mins: Vector,
    maxs: Vector,
    end: Vector,
    type: number,
    passedict: ServerEdict | null,
  ): MoveClip {
    const worldEdict = SV.server.edicts[0];
    const worldState = this._getEntityCollisionState(worldEdict) ?? this._getHullFallbackState(worldEdict);
    const worldTrace = this._clipMoveToEntityWithState(worldState, start, mins, maxs, end);
    console.assert(
      Number.isFinite(worldTrace.fraction)
      && Number.isFinite(worldTrace.endpos[0])
      && Number.isFinite(worldTrace.endpos[1])
      && Number.isFinite(worldTrace.endpos[2])
      && Number.isFinite(worldTrace.plane.normal[0])
      && Number.isFinite(worldTrace.plane.normal[1])
      && Number.isFinite(worldTrace.plane.normal[2])
      && Number.isFinite(worldTrace.plane.dist),
      'ServerCollision._createMoveClip produced malformed world trace',
    );
    const clip = new MoveClip(
      worldTrace,
      start,
      end,
      mins,
      type === Defs.moveTypes.MOVE_MISSILE ? ServerCollision.MISSILE_MINS : mins,
      maxs,
      type === Defs.moveTypes.MOVE_MISSILE ? ServerCollision.MISSILE_MAXS : maxs,
      type,
      passedict,
    );

    this._updateClipBounds(clip);

    return clip;
  }

  /**
   * Recursively checks the links in the area node BSP for collision.
   */
  clipToLinks(clip: MoveClip): void {
    for (const touch of SV.area.tree.queryAABB(clip.boxmins, clip.boxmaxs)) {
      if (this._shouldSkipTouch(clip, touch)) {
        continue;
      }

      if (!this._touchOverlapsClipBounds(clip, touch)) {
        continue;
      }

      if (clip.trace.allsolid === true) {
        return;
      }

      const trace = this._traceTouch(clip, touch);
      this._updateClipTrace(clip, touch, trace);

      if (clip.trace.allsolid) {
        return;
      }
    }
  }

  /**
   * Fully traces a moving box through the world.
   */
  move(
    start: Vector,
    mins: Vector,
    maxs: Vector,
    end: Vector,
    type: number,
    passedict: ServerEdict | null,
  ): CollisionTrace {
    const clip = this._createMoveClip(start, mins, maxs, end, type, passedict);

    this.clipToLinks(clip);
    this._debugLogPointTraceHit(clip.trace, start, end, mins, maxs);
    return clip.trace;
  }

  /**
   * Tests whether an entity is currently stuck in solid geometry.
   */
  testEntityPosition(ent: ServerEdict): boolean {
    const entity = ent.entity!;
    const origin = entity.origin.copy();
    return this.move(origin, entity.mins, entity.maxs, origin, 0, ent).startsolid;
  }
}
