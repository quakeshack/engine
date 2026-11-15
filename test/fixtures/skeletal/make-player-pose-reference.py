#!/usr/bin/env python3
"""Writes player-pose-reference.json: poses of player.iqm computed independently of the engine.

The engine's SkeletalAnimation is tested against this file (test/common/skeletal-animation.test.ts). The numbers
come from the IQM reader and skinning code in the qs-tools repository (blender/iqm_format.py, checked against
Blender's own evaluated mesh to 0.015 units), with the pose interpolation written out again here in float64, so no
engine code takes part.

Usage: make-player-pose-reference.py <path to qs-tools/blender> [player.iqm] [output.json]
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, sys.argv[1])
import iqm_format as iqm  # noqa: E402

HERE = Path(__file__).parent
SOURCE = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "player.iqm"
TARGET = Path(sys.argv[3]) if len(sys.argv) > 3 else HERE / "player-pose-reference.json"

# (frame a, frame b, blend). Whole frames, then fractions between neighbors and across the loop of the data.
CASES = [(0, 0, 0.0), (19, 19, 0.0), (59, 59, 0.0), (99, 99, 0.0), (142, 142, 0.0),
         (19, 20, 0.35), (59, 60, 0.8), (141, 142, 0.5)]
VERTEX_STRIDE = 7


def slerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    """Shortest-path spherical interpolation of unit quaternions (..., 4), exact (no linear fallback)."""
    dot = np.sum(a * b, axis=-1, keepdims=True)
    b = np.where(dot < 0.0, -b, b)
    dot = np.abs(dot)
    theta = np.arccos(np.clip(dot, -1.0, 1.0))
    sine = np.sin(theta)
    safe = sine > 1e-9
    first = np.where(safe, np.sin((1.0 - t) * theta) / np.where(safe, sine, 1.0), 1.0 - t)
    second = np.where(safe, np.sin(t * theta) / np.where(safe, sine, 1.0), t)
    return first * a + second * b


def interpolate(poses: np.ndarray, frame_a: int, frame_b: int, blend: float) -> np.ndarray:
    a, b = poses[frame_a].astype(np.float64), poses[frame_b].astype(np.float64)
    result = a + (b - a) * blend
    result[:, 3:7] = slerp(iqm.normalize_quaternions(a[:, 3:7]), iqm.normalize_quaternions(b[:, 3:7]), blend)
    return result


model = iqm.read_iqm(SOURCE.read_bytes())
inverse_bind = np.linalg.inv(iqm.absolute_matrices(model.joint_rest, model.joint_parents))
picked = list(range(0, len(model.positions), VERTEX_STRIDE))
homogeneous = np.concatenate([model.positions.astype(np.float64), np.ones((len(model.positions), 1))], axis=1)

cases = []
for frame_a, frame_b, blend in CASES:
    local = interpolate(model.poses, frame_a, frame_b, blend)
    joints = iqm.absolute_matrices(local, model.joint_parents)
    palette = joints @ inverse_bind
    skinned = np.zeros((len(model.positions), 3))
    for influence in range(iqm.MAX_INFLUENCES):
        matrices = palette[model.blend_indexes[:, influence], :3, :]
        skinned += model.blend_weights[:, influence:influence + 1] * np.einsum("vij,vj->vi", matrices, homogeneous)
    cases.append({
        "frameA": frame_a, "frameB": frame_b, "blend": blend,
        "jointMatrices": np.round(joints[:, :3, :].reshape(len(joints), 12), 5).tolist(),
        "vertices": np.round(skinned[picked], 4).flatten().tolist(),
    })

TARGET.write_text(json.dumps({
    "source": SOURCE.name, "jointCount": len(model.joint_names), "vertexStride": VERTEX_STRIDE, "cases": cases,
}, separators=(",", ":")) + "\n")
print(f"wrote {TARGET} ({TARGET.stat().st_size} bytes)")
