// The brightness of the four lightstyles of a surface, looked up per vertex: the styles are the same at every vertex of
// a face, so the fragment stage would repeat the same eight reads for every fragment. Matched by lightstyle-fragment.glsl.
uniform sampler2D tLightStyleA;
uniform sampler2D tLightStyleB;
uniform float uLightstyleInterpolation;

flat out vec4 vLightstyleBrightness;

/** Scales a lightstyle texel (0 to 1) to the brightness the lightmap is multiplied with. */
const float LIGHTSTYLE_SCALE = 43.828125;

/**
 * Writes vLightstyleBrightness: the four styles of the surface, interpolated between the two lightstyle frames.
 * @param lightStyles Coordinates of the surface's four styles in the lightstyle textures.
 */
void emitLightstyleBrightness(vec4 lightStyles) {
  vec4 lightstyleA = vec4(
    texture(tLightStyleA, vec2(lightStyles.x, 0.0)).r,
    texture(tLightStyleA, vec2(lightStyles.y, 0.0)).r,
    texture(tLightStyleA, vec2(lightStyles.z, 0.0)).r,
    texture(tLightStyleA, vec2(lightStyles.w, 0.0)).r
  );
  vec4 lightstyleB = vec4(
    texture(tLightStyleB, vec2(lightStyles.x, 0.0)).r,
    texture(tLightStyleB, vec2(lightStyles.y, 0.0)).r,
    texture(tLightStyleB, vec2(lightStyles.z, 0.0)).r,
    texture(tLightStyleB, vec2(lightStyles.w, 0.0)).r
  );
  vLightstyleBrightness = mix(lightstyleA, lightstyleB, uLightstyleInterpolation) * LIGHTSTYLE_SCALE;
}
