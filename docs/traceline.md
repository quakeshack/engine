# Traceline API

`Traceline` is one of the primary collision queries exposed to game logic.
Game code uses it for line-of-sight tests, item placement, aiming helpers, interaction checks, and many forms of environment probing.

This document describes the public contract that game code should rely on.

## Overview

QuakeShack currently exposes two gameplay-facing `Traceline` entry points:

- `ServerEngineAPI.Traceline(start, end, noMonsters, passEdict, mins, maxs)`
- `ClientEngineAPI.Traceline(start, end)`

They intentionally share the same public name, but they do not currently trace against the same set of things:

- Server `Traceline` is entity-aware. It traces against worldspawn and other collidable entities.
- Client `Traceline` currently traces static world geometry only.

The client keeps the legacy `Traceline` name on purpose so it can later grow into entity-aware behavior without another gameplay API rename.

## Server API

Server-side game code receives the broader and more traditional contract:

```js
const trace = ServerEngineAPI.Traceline(start, end, noMonsters, passEdict, mins, maxs);
```

Parameters:

- `start`: trace start position.
- `end`: trace end position.
- `noMonsters`: when true, skip non-BSP dynamic entities during the move trace.
- `passEdict`: entity to ignore, typically the caller or owner.
- `mins`, `maxs`: optional extents for box traces. When omitted, the trace is point-sized.

Behavior:

- Traces through the active server collision system.
- Includes worldspawn.
- Includes relevant collidable entities, such as BSP entities and other solid entities, subject to the move flags and skip rules.
- Supports point traces and swept box traces.

When game logic needs a true gameplay collision query on the server, this is usually the right entry point.

## Client API

Client-side game code currently gets a narrower implementation:

```js
const trace = ClientEngineAPI.Traceline(start, end);
```

Behavior today:

- Traces static world geometry only.
- Does not currently trace against dynamic entities.
- Uses the client-visible world collision path.

This is intentionally documented as a temporary implementation detail, not a desired long-term semantic difference.
The public name stays aligned with the server API because future client-side gameplay may need entity-aware traces too.

## Returned Trace Shape

Both APIs return the same gameplay-oriented trace object shape:

```js
{
  solid: {
    all: boolean,
    start: boolean,
  },
  fraction: number,
  plane: {
    normal: Vector,
    distance: number,
  },
  contents: {
    inOpen: boolean,
    inWater: boolean,
  },
  point: Vector,
  entity: BaseEntity | null,
}
```

Field meanings:

- `solid.all`: the trace remained in solid for the whole move.
- `solid.start`: the trace started in solid.
- `fraction`: completed movement fraction. `1.0` means no hit along the segment.
- `plane.normal`: impact plane normal.
- `plane.distance`: impact plane distance from origin.
- `contents.inOpen`: open space was encountered during the trace.
- `contents.inWater`: water was encountered during the trace.
- `point`: final trace position. On collision, this is the impact position. On a clear trace, this is the requested end point.
- `entity`: the hit gameplay entity when one is available, otherwise `null`.

Common interpretation pattern:

```js
const trace = ServerEngineAPI.Traceline(start, end, false, self);

if (trace.solid.start || trace.solid.all) {
  // Started inside blocking geometry.
}

if (trace.fraction < 1.0) {
  // Hit something before reaching end.
  const impactPoint = trace.point;
  const impactNormal = trace.plane.normal;
  const hitEntity = trace.entity;
}
```

## Point Trace Versus Box Trace

The server API supports both:

- Omit `mins` and `maxs` for a point trace.
- Provide `mins` and `maxs` for a swept box trace.

Example box trace:

```js
const trace = ServerEngineAPI.Traceline(
  start,
  end,
  false,
  self,
  mins,
  maxs,
);
```

Use point traces for visibility or hitscan-style probes.
Use box traces for placement checks, clearance checks, and movement-style probing.

## Relationship To Static-World Helpers

The collision layer also exposes lower-level helpers that are explicitly worldspawn-only:

- `SV.collision.traceStaticWorld(...)`
- `SV.collision.traceStaticWorldLine(...)`
- `SV.collision.staticWorldContents(...)`

Those helpers exist to make the scope explicit:

- They query static world geometry only.
- They do not include BSP entities such as doors or plats.
- They are collision-layer utilities, not the main gameplay-facing tracing contract.

Game logic should not assume that `Traceline` means the same thing as `traceStaticWorldLine`.
That equivalence is false on the server today, and it is only accidentally true on the client at the moment.

## Related Contents Queries

When code needs to classify the contents at a point rather than sweep a trace, use the contents APIs instead of `Traceline`.

Server-side gameplay-facing contents API:

```js
const contents = ServerEngineAPI.DetermineStaticWorldContents(origin);
```

Compatibility aliases still exist:

- `DetermineWorldContents(origin)`
- `DeterminePointContents(origin)`

These currently route to static-world contents queries.
That means they are worldspawn-only, just like the explicitly named static-world helper.

## Guidance For Game Code

Use `Traceline` when the question is about swept collision or line-of-sight.

Prefer the server API when game rules need authoritative answers.

Use the static-world helpers only when the code explicitly wants worldspawn-only behavior and that limitation is part of the intent.

Do not write new game logic that assumes client `Traceline` is permanently static-only.
Documented future intent is for the client-side API surface to stay compatible with a later entity-aware implementation.

## Summary

- `Traceline` is a core gameplay-facing collision query.
- Server `Traceline` is entity-aware.
- Client `Traceline` currently traces static world geometry only.
- The shared name is intentional and preserved for future parity.
- Explicit `staticWorld...` helpers are lower-level, worldspawn-only utilities.
