# Skeletal model fixtures

## `player.iqm`

The LibreQuake player (`lq1/progs/src/player.mdl.blend`) as an Inter-Quake Model v2, written by the Blender exporter of
`qs-tools` (`blender/export_iqm.py`, commit `8c489f3`):

```sh
blender -b lq1/progs/src/player.mdl.blend --python-exit-code 1 --python export_iqm.py -- \
  --output player.iqm --frames qcsrc/player.qc --loop stand,axstnd,axrun,rockrun \
  --normals smooth --material-prefix progs/
```

25 joints, 143 frames in the order of `player.mdl`, 20 animations named from the `$frame` lines of `qcsrc/player.qc`, 794
vertices, 1060 triangles, one material (`progs/player.mdl.0`). The union of its frame bounds equals the bounds in the header
of `player.mdl` to the last digit, and a reader written independently of the engine's loader skins it to within 0.015 units
of what Blender shows (see `plans/skeletal-models.md`, Phase 0 and 1). The texture is not part of the fixture.

## `player-pose-reference.json`

Joint matrices and skinned vertices (every seventh) of eight poses of `player.iqm`: five whole frames and three fractions between
neighbors (`frameA`, `frameB`, `blend`). Written by `make-player-pose-reference.py` with the IQM reader and skinning of `qs-tools`
(`blender/iqm_format.py`) and an interpolation written again in float64, so no engine code is involved:

```sh
python3 -I make-player-pose-reference.py <path to qs-tools/blender>
```

`test/common/skeletal-animation.test.ts` compares `SkeletalAnimation` with it. Regenerate only when `player.iqm` changes.

## License of the model

The model is part of LibreQuake and is used under its BSD 3-clause licence:

> Copyright © 2019-2023 Contributors to the LibreQuake project. All rights reserved.
>
> Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
> following conditions are met:
>
> * Redistributions of source code must retain the above copyright notice, this list of conditions and the following
>   disclaimer.
> * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
>   disclaimer in the documentation and/or other materials provided with the distribution.
> * Neither the name of the LibreQuake project nor the names of its contributors may be used to endorse or promote
>   products derived from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
> INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
> DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
> SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
> SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
> WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
> THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
>
> For a list of contributors to the LibreQuake project, see the file CREDITS.
