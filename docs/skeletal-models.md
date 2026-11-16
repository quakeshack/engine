# Skeletal Models

Models that are posed by a joint hierarchy, with a mesh skinned to it (a player, a monster, a weapon with moving parts). The
format is [Inter-Quake Model](https://sourceforge.net/projects/iqm/) (`.iqm`), version 2. The plan and the order of the work are in
[plans/skeletal-models.md](../plans/skeletal-models.md).

**What works today:** loading, on the client and on the server, including `setModel()` sizing and the `modelinfo` command; posing;
drawing with lighting, shadows, a glow layer and player colors; named sequences; tags; attachments. A game uses an `.iqm` where it used an `.mdl`: `frame`
picks the pose and the client blends neighboring frames like it does for alias models, or the game plays a sequence by name.
**What does not exist yet:** view weapons, per-skin textures. Those are later phases of the
plan; this page grows with each of them.

## Making a model

The Blender exporter is in the `qs-tools` repository, `blender/export_iqm.py` (headless, Blender 5.x; its README lists every
option). It writes the model and the PNG of each material's texture:

```sh
blender -b monster.blend --python-exit-code 1 --python export_iqm.py -- \
  --output progs/monster.iqm --frames monster.qc --loop stand,run --normals smooth --material-prefix progs/
```

`--frames` names the frames from the `$frame` lines of a QuakeC source, so that the model gets named animations. The frames are
written in the order of the Blender frames, which is the order of the frames of the MDL the model replaces, so code that picks a
pose with `frame` keeps working.

IQM files from other tools load too, as long as they are version 2 and have the vertex arrays below.

## What the loader accepts

`IQMLoader` (`source/engine/common/model/loaders/IQMLoader.ts`, its JSDoc describes the byte layout) is picked by the extension
`.iqm` and the magic `INTERQUAKEMODEL`.

| Needs | Notes |
|---|---|
| Version 2 | Version 1 is refused, with a message. |
| Positions, normals, texture coordinates | Floats. Tangents, colors and custom arrays are skipped. |
| Four blend indexes and four blend weights per vertex | Indexes as `ubyte`, `ushort` or `uint`, weights as `ubyte` or float. Weights are renormalized to sum to one. |
| At least one joint | Parents come before their children. 4096 joints at most. |
| Triangles that stay inside the vertices of their mesh | Counter-clockwise seen from the front, the order Blender writes. |

Frames are optional: a model without any has one, its bind pose. Per-frame bounds are optional too, and a file without them gets
the bounds of its bind pose (the console says so), which is too small for an animation that leaves it. Joints times frames may not
exceed 800,000 poses, which is about eighteen times the largest LibreQuake model (the shambler: 468 bones, 94 frames).

**The coordinate system is Quake's** (X forward, Y left, Z up, units as in the MDL): an IQM exported from the `.blend` of an MDL needs
no conversion, and its frame bounds equal the bounds in the MDL's header.

A file that breaks any of this, or whose counts and offsets do not fit in the file, is refused with a `CorruptedResourceError` that
says what is wrong. Nothing is read outside the file and no memory is reserved for a count the file does not back.

## The model in memory

`SkeletalModel` (abstract, `ModelType.skeletal`) holds what every skeletal format shares, `IQMModel` is the one format there is. It is
stored in flat typed arrays and does not change after loading, so the client's and the server's scoped views share it.

- **Rotations are quaternions `w, x, y, z`**, the layout of `Quaternion` and of every flat array in the engine that holds rotations.
  The file stores `x, y, z, w`; the loader reorders and normalizes once, and nowhere else.
- **A pose** is `SkeletalModel.POSE_FLOATS` (10) numbers per joint: translation `x, y, z`, rotation `w, x, y, z`, scale `x, y, z`, in
  the space of the parent joint. `restPose` is the bind pose, `framePoses` holds `frameCount * jointCount` poses, frame major.
- **Bounds**: `frameBounds` has `BOUNDS_FLOATS` (8) numbers per frame (minimum, maximum, radius around Z, radius around the origin),
  `mins`, `maxs` and `boundingradius` are the union over all frames. `setModel()` sizes an entity with `mins` and `maxs`; a game
  that wants the hull of a player overrides it with `setSize`, as it does for any model.
- **Sequences** (`sequences`) are the animations of the file: name, first frame, frame count, frame rate (0 for one held pose) and a
  loop flag.

### Realms

A realm that draws (the browser client) keeps the mesh: `meshData` (bind pose positions, normals, texture coordinates, joint indexes
and weights, triangles), `meshes` and `materials` (names only; the renderer resolves textures). A realm that does not draw (the
dedicated server, the server worker) reads and validates the same data and then keeps none of it: it has joints, poses, sequences
and bounds, which is what `setModel()` and, later, tags need. Both realms refuse the same files.

## Posing a model: `SkeletalAnimation`

`SkeletalAnimation.computePose(model, frameA, frameB, blend, outJointMatrices, outSkinningMatrices)`
(`common/model/SkeletalAnimation.ts`) turns two frames and a blend into matrices. It uses no GL, so the server can use it for
tags and the client for skinning, and it allocates nothing: the caller owns the output arrays,
`jointCount * SkeletalAnimation.MATRIX_FLOATS` numbers each.

- **Matrices** are 3×4, row major: three rows of `[column 0, column 1, column 2, translation]`, the bottom row `0, 0, 0, 1` implied.
- **Interpolation** is linear for translation and scale and a shortest-path slerp (`Quaternion.slerpInto`) for rotation. A pose is
  never interpolated as matrices, which would shorten a limb halfway through a turn. Frame numbers are clamped to the model's frames
  (they come off the wire) and the blend to 0 to 1.
- **Composition** is parent matrix times local matrix, so a joint may carry non-uniform scale (it shears its children, as in the
  IQM reference tools).
- **Joint matrices** (`outJointMatrices`) are joint space to model space and are what tags will read. **Skinning matrices** are the
  joint matrix times the inverse bind matrix and move a vertex of `meshData.positions` to its posed place:
  `position' = Σ weight × (skinning[joint] × position)` over the vertex's four influences. Pass `null` where only joints are
  needed.
- **Inverse bind matrices** (`SkeletalModel.inverseBindMatrices`) are computed once by the loader from the rest pose. A joint with a
  zero scale in the rest pose has no inverse: it gets the identity and the loader says so in developer mode.

The rotations of an entity's `angles` meet this code through `Quaternion.fromModelAnglesInto`, which follows
`Vector.toRotationMatrix()` (the convention every model renderer uses: pitch negated, the matrix holding the entity's axes as
rows). `Vector.toQuaternion()` and `angleVectors()` use the view convention instead, with no pitch negation.

## Sequences

The animations of the file (`modelinfo` lists them with their frame ranges, rates and loop flags; the exporter names them from the
`$frame` lines of a QuakeC source). An entity plays one through three members that every model with sequences shares (image
sprites use them too, see [Sprites](sprites.md#selecting-and-restarting-a-sequence)):

```ts
// the game's entity declares them like any other field
this.sequence = this.engine.GetSequenceIndex('progs/soldier.iqm', 'run'); // -1, the default, means: follow `frame`
this.animtime = this.game.time;                                           // restart; `this.game.time - 0.3` resumes
this.framerate = 1.5;                                                     // optional, 1.5 times the file's speed
```

- **Which pose**: the point `(time - animtime) * framerate * rate` frames into the sequence, `rate` being the sequence's own frame
  rate. A loop wraps from its last frame to its first (blended, while `r_interpolation` is on), any other sequence stops on its last
  frame; a `framerate` of 0 or less holds the first. The time is the client's extrapolated server time, the one `lerp.frame` uses.
- **Which wins**: an entity with `sequence` 0 or more plays it, one with -1 follows `frame` as before. A `sequence` the model does not
  have falls back to `frame` as well, so a wrong number shows a pose instead of nothing.
- **Restart and resume**: `animtime = now` starts the sequence over (even the one that already plays), `now - elapsed` resumes it
  partway, which is also what a client that joins late sees. A game that never sets `animtime` gets the client's stamp from the
  moment the sequence changes. Declare it as `animtime: number | null = null` unless the game sets it on every change: `null` sends nothing, a declared 0 is a start at time 0.
- **`GetSequenceDuration(model, sequence)`** is `Infinity` for a loop and `frames / rate` seconds for any other sequence (every frame is
  shown for one period), 0 for one that holds a pose. A level change resets the server clock to 1.0, so a game that carries an
  animating entity across levels sets `animtime` again.

## Tags

A tag is a named place on a model that something else can follow: the muzzle of a weapon, the hand of a monster, the head. **Every
joint of a skeletal model is a tag**, named like the joint (`modelinfo` lists them); the exporter renames the bones a game looks up
(`tag_weapon`, `tag_flash`). Nothing else has tags: alias, brush and sprite models answer "none".

```ts
// server or client: does this model have a muzzle?
const flash = engine.GetTagIndex('progs/weapon.iqm', 'tag_flash'); // -1 when it has none

// client: where is the muzzle of that entity on the screen right now?
const origin = new Vector();
const angles = new Vector();

if (engine.GetEntityTag(entity, 'tag_flash', origin, angles)) {
  const light = engine.AllocDlight(entity.num);   // an effect placed on the weapon that is drawn
  light.origin = origin;
}
```

- **`GetEntityTag(entity, tagName, outOrigin, outAngles)`** (client) answers for the entity as it is drawn this frame: its smoothed
  origin and angles applied to the tag of the pose it is in, which is the pose of the vertices (the same sequence or `lerp.frame`, the
  same blend), so an effect there sits on the weapon, the hand or the muzzle that is on the screen. `false` when the entity has no
  model with that tag, and the vectors are untouched. The angles are in the convention of an entity's `angles`, so giving them to an
  entity turns it the way the tag is turned. They are the only place a tag's turn becomes Euler angles; inside the engine it stays a quaternion.
- **`GetTagIndex(modelName, tagName)`** (both engine APIs) is the index of a tag, -1 for none. The model has to be precached; on the
  server it also has to have finished loading, so ask while the map runs.
- **Rigid**: a tag has an origin and a rotation, no scale. A rig that scales a bone (the LibreQuake player's gun bone is at 0.8) leaves
  that scale to the model that is attached; the tag's axes are the bone's, made orthonormal.
- **On the server too**: the server keeps the joints and frames of a model it precaches, so `GetTagIndex` works there and `sampleTag`
  can place a tag for a game that needs one (projectile origins); the world transform of an entity as it is drawn exists on the client only (the server
  works out where an attached child is only when its parent is freed).
- **The muzzle flash**: an entity with `EF_MUZZLEFLASH` puts its dynamic light on the model's `tag_flash` when it has one (the pose
  does not blend during a flash, like for alias models), and 20 units ahead and 16 up from the origin, as always, when it has not.
- **Beams** (the lightning gun, `te.lightning1` to `te.lightning3`): a beam starts at the muzzle of the entity that fired it, the same place the muzzle flash
  uses, and follows it every frame while the beam lasts (the end stays where the server's trace hit). A shooter without a muzzle starts it where the server sent it
  (its origin plus 16 up). The local player's own beam starts at the player's origin in first person (the player's model is not drawn, the viewmodel is, so
  its muzzle is not on the screen) and at the muzzle in a chase view (`chase_active 1`).
- **`entitytag <entity number> [tag]`** prints where a tag of an entity is in the world (and without a tag name lists the tags of its
  model). Run it again while the entity animates or moves and the numbers move with it; `entities` lists the numbers.

## Attachments

An entity can be attached to a tag of another entity, or to its origin, and then **follows it without the game placing it every
frame**: a weapon in a player's hand, a flash on a muzzle, a hat. It works as DarkPlaces' `setattachment` does.

```ts
// server, in the game: the weapon entity follows the player's `tag_weapon`
weapon.edict.setAttachment(player.edict, 'tag_weapon');   // weapon.solid is SOLID_NOT
weapon.origin = new Vector(0, 0, 2);                      // an offset in the tag's space, a holster shift
weapon.edict.clearAttachment();                           // let go

// client, for an entity of the game's own client code (nothing is sent)
flashSprite.setAttachment(weaponEntity, 'tag_flash');
```

- **The child's own `origin` and `angles` are its transform in the tag's space**: its world transform is the parent's origin and
  angles, times the tag, times that. That is how a game shifts a holstered gun without a tag of its own. Reading `origin` of an
  attached entity gives the offset, not a place in the world; `GetEntityTag` and `lerp.origin` give the place.
- **Server rules.** An attached entity should be `SOLID_NOT` and does not move by itself (`console.assert` in development).
  It is sent to a client **whenever its parent is**, wherever its offset would put it: PVS, PHS and culling follow the parent, and for
  a chain the root. Attaching to itself or in a loop is refused with a warning. The tag is looked up by name in the parent's *current*
  model each time it is sent, so a parent that changes model is followed; an unknown tag attaches to the parent's origin and says so once
  in developer mode. **Freeing the parent lets go of the children and keeps each where it was in the world** (turned as it was, for the
  pose the parent's `frame`, or `sequence` from the `animtime` the game set, was in), so a dropped weapon lies where it was held. Saves
  keep attachments (in the edict's record), so a held weapon is still held after a load.
- **Client rules.** An attached entity is drawn **exactly when its parent is**, with no PVS check of its own: hidden in first person when
  the parent is the view entity, shown with the chase camera, hidden when the parent has `EF_NODRAW` or no model, is freed, or is in a
  loop. Chains work (a flash on a weapon on a player), up to eight deep, in whatever order the entities are numbered.
  The child follows the pose its parent is drawn in, blended the same way, so it is on the hand that is on the screen.
- **Client-only entities** can attach to server entities and to each other. Their `origin` and `angles` start out non-finite, so
  set both before attaching. When the parent is freed the child stops being drawn, and the game frees or re-attaches it. They are not
  saved.
- **Renderers draw with `lerp.rotationMatrix`**, not `lerp.angles`: for an entity that stands free it is the matrix of its angles, for an
  attached one the rotation the attachment resolved, which never becomes angles on the way. An oriented sprite (`angles` selects its
  facing) takes the place of its parent but not the parent's turn; a flash sprite that faces the camera is not affected.
- **The muzzle flash** of an entity with `EF_MUZZLEFLASH` (the engine's default handler; a game that makes its own light asks `ClientEngineAPI.GetMuzzleFlashOrigin(entity, out)`, which answers the same way) goes to its own `tag_flash`, else to the `tag_flash` of an entity attached to it
  (the weapon it holds), else to the fixed place. Whichever place the game picks, the light of a server entity is pulled back out of a wall it ended up in (the fixed place is 20 units ahead,
  a player's hull is 16 wide), to 4 units before the wall on the line from the entity, so a flash against a wall still lights the room. The entity a dynamic light belongs to, and what is attached to it, does not cast into that light's cube shadow: the light sits at its weapon,
  where an arm or the weapon covers part of it in some poses.
- **On the wire** (protocol 45): update bit `u.attachment` (bit 17) is followed by the parent's entity number (`uint16`, 0 detaches) and the
  tag's index (signed short, -1 for the parent's origin).

## Joint rotations: bending a model with the game

A game can turn joints of one entity's skeletal model **on top of the animation**: a spine that bends with where a player looks, a head that
follows a target. It is the game's decision which joints turn and by how much; the engine only applies them, so there is no model format, no wire
traffic (it all happens on the client, from values the client has) and no per-model metadata.

```ts
// in a client entity handler, every frame, from interpolated values
this.engine.SetEntityJointAngles(this.clientEdict, 'spine1', new Vector(lookPitch * 0.25, 0, 0));
this.engine.SetEntityJointAngles(this.clientEdict, 'head', new Vector(lookPitch * 0.35, 0, 0));
this.engine.SetEntityPitchesBody(this.clientEdict, false);   // the body no longer tilts with the pitch
this.engine.ClearEntityJointAngles(this.clientEdict);        // back to the animation
```

- **`SetEntityJointAngles(entity, jointName, angles)`**: pitch, yaw and roll in degrees in the convention of an entity's `angles` (a positive pitch lifts what points
  along the model's X axis), applied **in model space about the joint's own origin**. The joint stays where it is and turns; the joints below it, the vertices
  skinned to them and so every tag and every entity attached to a tag follow. Angles of zero remove the rotation. It returns `false` (and changes nothing) for an
  entity without a skeletal model and for a joint the model does not have, which is how a game tells a rig that can bend from one that cannot (the alias player).
  The rotations of a joint and of a joint below it add up.
- **`ClearEntityJointAngles(entity)`** removes them all. A freed entity forgets them.
- **`SetEntityPitchesBody(entity, false)`** turns off the tilt of the whole body by the entity's pitch (the default for every model, and what an alias player does with a
  third of the view pitch). `lerp.angles` still holds the pitch; `lerp.bodyAngles` is what the body is turned by, `lerp.rotationMatrix` and the place of attached
  entities use it.
- **Poses and tags agree.** `SkeletalAnimation.computePose` and `sampleJointInto` take the rotations (`JointAdjustments`, a flat rotation per joint with a `version`) as their last
  argument, and the renderer's per-entity skinning cache is keyed on the set and its version, so the picture, `GetEntityTag` and an attached weapon never disagree. A set is sized for
  one model: an entity that gets another model gets a new set at the next call.
- **Not in this:** rotations on the server (its tags, and the pose a freed child is left in, ignore them), bone controllers on the wire (Half-Life style), model-declared aim joints.

An example in a game: id1's player handler spreads **three times the player entity's pitch** (the server sends `-v_angle[0] / 3` as `angles[0]`, which tilted an alias body
a little) over `spine0`, `spine1`, `neck` and `head` (0.15, 0.25, 0.25, 0.35, so the head turns the whole way), and keeps the body upright when the model has them.

## Drawing

`SkeletalModelRenderer` (`source/engine/client/renderer/models/`) is registered for `IQMModel`; a later format registers its own
class the same way. For every visible entity it picks the two frames to blend from its sequence (see above) or from `lerp.frame` (the plain `frame` while
`r_interpolation` is off or during a muzzle flash, like alias models), poses and skins the mesh on the CPU
(`SkeletalAnimation.skinMeshInto`) and draws it with the `skeletal` program, one range of triangles per material.

- **Skinning is cached per entity and pose**: the main pass and the shadow passes of a frame share one skinning, and an entity that is
  culled (the sphere of `boundingradius` around its origin against the view frustum) is never skinned. The skinned vertices are
  uploaded for every draw into the model's one dynamic vertex buffer. Measured in Node after warm-up, the pose of the player
  (25 joints) takes about 2 µs and skinning its 794 vertices about 16 µs, so a hundred skinned entities cost under 2 ms of CPU
  a frame; the numbers in a browser are still to be taken, and GPU skinning waits for them (`r_speeds`, `r_bench`).
- **Lighting and shadows** are those of the alias and mesh programs (`entity-lighting.glsl`): the entity's light, dynamic lights, the
  top-down shadow and point-light shadows on it, and its own shadow through `shadow-brush` and `shadow-point`.
- **Winding**: IQM triangles run counter-clockwise, and the engine culls the front face (`gl.cullFace(gl.FRONT)`), so the renderer
  turns every triangle round when it uploads the index buffer.
- **Translucent entities** (`alpha` between 0 and 1) draw in the blended pass and cast no shadow, as alias models do. The texture's own
  alpha channel is ignored.
- Counted with the alias models' polygons in `r_speeds`.

### Textures

A material is named by the file (`progs/player.mdl.0`, written by the exporter). `SkeletalMaterialLoader` looks the name up with `.png`
and then `.jpg` added (a name that already ends in an image extension is used as it is) and, when that exists, looks for the
companions that DarkPlaces defines and FTE reads too, in the same format:

| File | Used for |
|---|---|
| `<name>.png` | base color |
| `<name>_glow.png` | added to the lit color, so it stays visible in the dark, and sent to the bloom pass |
| `<name>_shirt.png`, `<name>_pants.png` | greyscale masks of the parts a player's shirt and pants color goes on |

The player colors are **added**: `base + shirt × shirtColor + pants × pantsColor`, so the base image must have those pixels blanked
(this is DarkPlaces' rule; the exporter's `--colormap` option, planned in Phase 7 of the plan, will write textures that way). The colors are the rows of the Quake palette
the `colors` byte of the player names, the same ones the alias player uses, for an entity with a `colormap` (and `gl_nocolors` 0).

A missing base image draws the checkerboard and is reported once. A missing companion is simply absent. Each miss is one request
for a file that is not there (a browser shows it as a 404 in its console): up to four per material and model, once per page load.

**Not supported yet:** `skinnum` (a model shows its file's materials; DarkPlaces' `.skin` files come with the Hellwave work),
`.qsmat.json` overrides per model, normal and specular maps, transparent textures.

### Texture units

Texture units are shared by all programs, and what a program leaves on a unit is what the next one finds there. The shadow textures
have a compare mode that a plain `sampler2D` rejects, and `brush` binds its `tSpecular` (unit 7) and `tNormal` (unit 8) only for a
world with a deluxemap, so a shadow texture left on one of them fails the next world draw (`GL_INVALID_OPERATION: Mismatch between
texture format and sampler type`, and the world draws black). That is why the `skeletal` program lists `null` for the units 4 to 9
and keeps its shadow samplers on the units 10 to 14, where `brush` has its own. The same rule holds for every program (a test in `shader-programs.test.ts` checks that no program but `brush` has a 2D shadow sampler on unit 7 or 8): the `player` program of colored MDL players broke the world for good until its `tPlayer` sampler moved behind the shadow samplers.

## `modelinfo <model>`

Prints bounds and counts of any model, and for a skeletal model the joint tree (each joint is a tag), the sequences with
their frame ranges and loop flags, the materials and the meshes. It loads the model if it is not loaded.

## Test fixture

`test/fixtures/skeletal/player.iqm` is the LibreQuake player exported as above (BSD 3-clause, see the README next to it). The
loader tests compare its decoded poses with the numbers of an independent reader and its bounds with the header of `player.mdl`.
`player-pose-reference.json` next to it holds joint matrices and skinned vertices of eight poses (whole frames and fractions)
worked out in float64 by `qs-tools`' reader, with `make-player-pose-reference.py` as the generator; the animation tests compare
`SkeletalAnimation` with it.
