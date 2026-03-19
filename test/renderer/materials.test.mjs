import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { materialFlags, resolveMaterialLuminanceTexture } from '../../source/engine/client/renderer/Materials.mjs';

describe('resolveMaterialLuminanceTexture', () => {
  test('keeps the explicit luminance texture when one is present', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.mjs').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.mjs').GLTexture} */ ({});
    const luminanceTexture = /** @type {import('../../source/engine/client/GL.mjs').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(materialFlags.MF_FULLBRIGHT, luminanceTexture, diffuseTexture, fallbackTexture),
      luminanceTexture,
    );
  });

  test('uses the diffuse texture as luminance for MF_FULLBRIGHT materials without an emissive map', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.mjs').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.mjs').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(materialFlags.MF_FULLBRIGHT, fallbackTexture, diffuseTexture, fallbackTexture),
      diffuseTexture,
    );
  });

  test('falls back to the renderer black texture for non-fullbright materials without emissive data', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.mjs').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.mjs').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(materialFlags.MF_NONE, null, diffuseTexture, fallbackTexture),
      fallbackTexture,
    );
  });
});
