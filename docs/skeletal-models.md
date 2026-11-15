# Skeletal Models

Models that are posed by a joint hierarchy, with a mesh skinned to it (a player, a monster, a weapon with moving parts). The
format is [Inter-Quake Model](https://sourceforge.net/projects/iqm/) (`.iqm`), version 2. The plan and the order of the work are in
[plans/skeletal-models.md](../plans/skeletal-models.md).

**What works today:** loading, on the client and on the server, including `setModel()` sizing and the `modelinfo` command.
**What does not exist yet:** drawing a skeletal model, playing an animation, tags and attachments. Those are the next phases of the
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

## `modelinfo <model>`

Prints bounds and counts of any model, and for a skeletal model the joint tree (each joint is going to be a tag), the sequences with
their frame ranges and loop flags, the materials and the meshes. It loads the model if it is not loaded.

## Test fixture

`test/fixtures/skeletal/player.iqm` is the LibreQuake player exported as above (BSD 3-clause, see the README next to it). The
loader tests compare its decoded poses with the numbers of an independent reader and its bounds with the header of `player.mdl`.
`player-pose-reference.json` next to it holds joint matrices and skinned vertices of eight poses (whole frames and fractions)
worked out in float64 by `qs-tools`' reader, with `make-player-pose-reference.py` as the generator; the animation tests compare
`SkeletalAnimation` with it.
