#version 300 es
precision highp float;
precision highp sampler3D;
precision highp sampler2D;

out vec4 fragColor;

uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform float uGamma;

uniform vec3 uFogVolumeColor;
uniform float uFogVolumeDensity;
uniform float uFogVolumeMaxOpacity;
uniform vec3 uFogVolumeMins;
uniform vec3 uFogVolumeMaxs;

uniform sampler2D tDepth;
uniform sampler3D tLightProbe;
uniform vec2 uScreenSize;

// Dynamic lights (point lights): position.xyz + radius in w, color.rgb + unused w
const int MAX_FOG_DLIGHTS = 8;
uniform int uDlightCount;
uniform vec4 uDlightPos[MAX_FOG_DLIGHTS];
uniform vec4 uDlightColor[MAX_FOG_DLIGHTS];

in vec3 vWorldPos;

/**
 * Sample the light probe 3D texture at a world position.
 * The probe covers the fog volume AABB — normalize to [0,1] UVW and
 * let the GPU's LINEAR filtering handle trilinear interpolation.
 */
vec3 sampleLightProbe(vec3 worldPos) {
  vec3 size = uFogVolumeMaxs - uFogVolumeMins;
  vec3 uvw = clamp((worldPos - uFogVolumeMins) / size, 0.0, 1.0);
  return texture(tLightProbe, uvw).rgb;
}

/**
 * Convert a depth buffer value (non-linear) to linear view-space distance.
 * Derives near/far from the actual perspective matrix elements:
 *   uPerspective[2][2] = -(far+near)/(far-near)
 *   uPerspective[3][2] = -2*near*far/(far-near)
 * Uses highp to avoid precision artifacts in the near-plane division.
 */
float linearizeDepth(highp float depth) {
  highp float z_ndc = depth * 2.0 - 1.0;
  return uPerspective[3][2] / (z_ndc + uPerspective[2][2]);
}

/**
 * Intersect a ray with an axis-aligned bounding box.
 * Returns tNear and tFar (signed distances along the ray).
 * If tNear > tFar, there is no intersection.
 */
vec2 intersectAABB(vec3 rayOrigin, vec3 rayDir, vec3 boxMin, vec3 boxMax) {
  vec3 invDir = 1.0 / rayDir;
  vec3 t1 = (boxMin - rayOrigin) * invDir;
  vec3 t2 = (boxMax - rayOrigin) * invDir;
  vec3 tMin = min(t1, t2);
  vec3 tMax = max(t1, t2);
  float tNear = max(max(tMin.x, tMin.y), tMin.z);
  float tFar = min(min(tMax.x, tMax.y), tMax.z);
  return vec2(tNear, tFar);
}

void main(void) {
  // Ray from camera through this fragment in world space
  vec3 rayDir = normalize(vWorldPos - uViewOrigin);

  // Intersect the ray with the fog volume AABB before sampling depth,
  // to avoid unnecessary texture work on non-hitting fragments.
  vec2 tHit = intersectAABB(uViewOrigin, rayDir, uFogVolumeMins, uFogVolumeMaxs);

  // Clamp entry to 0 (camera might be inside the volume)
  float tEntry = max(tHit.x, 0.0);
  float tExit = tHit.y;

  // No intersection or volume is entirely behind camera
  if (tEntry >= tExit || tExit <= 0.0) {
    discard;
  }

  // Screen UV for depth texture lookup
  vec2 screenUV = gl_FragCoord.xy / uScreenSize;

  // Sample scene depth and linearize
  float rawDepth = texture(tDepth, screenUV).r;
  float sceneDepth = linearizeDepth(rawDepth);

  // Convert scene view-depth to world-space ray distance.
  // The view-space Y axis IS the forward direction, and linearizeDepth
  // returns the distance along forward. Dividing by the cosine of the angle
  // between the ray and the forward vector gives the radial ray distance.
  vec3 forward = vec3(uViewAngles[0][1], uViewAngles[1][1], uViewAngles[2][1]);
  float cosAngle = dot(rayDir, forward);
  float sceneRayDist = (abs(cosAngle) > 0.001) ? sceneDepth / cosAngle : 100000.0;

  // Also clamp by the back-face distance (useful for non-box brushes)
  float backFaceDist = length(vWorldPos - uViewOrigin);
  tExit = min(tExit, min(backFaceDist, sceneRayDist));

  // Fog thickness is the distance the ray travels through the volume
  float thickness = max(0.0, tExit - tEntry);

  // Exponential fog falloff
  float fogFactor = 1.0 - exp(-uFogVolumeDensity * thickness);
  fogFactor = clamp(fogFactor, 0.0, uFogVolumeMaxOpacity);

  // Discard fully transparent fragments
  if (fogFactor < 0.001) {
    discard;
  }

  // Sample light probe at the midpoint of the fog ray to tint the fog
  // by the local lighting environment (colored lights, etc.)
  vec3 fogMidpoint = uViewOrigin + rayDir * ((tEntry + tExit) * 0.5);

  // Edge fade: taper fog density towards zero near all six AABB faces so that
  // the volume boundary dissolves smoothly instead of cutting off sharply.
  // relPos = [0,1]^3 inside the volume; smoothstep creates a fade zone of
  // EDGE_FADE_FRAC (fraction of the volume extent) on each face.
  const float EDGE_FADE_FRAC = 0.12;
  vec3 relPos = clamp((fogMidpoint - uFogVolumeMins) / (uFogVolumeMaxs - uFogVolumeMins), 0.0, 1.0);
  vec3 edgeFade3 = smoothstep(vec3(0.0), vec3(EDGE_FADE_FRAC), relPos) *
                   smoothstep(vec3(1.0), vec3(1.0 - EDGE_FADE_FRAC), relPos);
  float edgeFade = edgeFade3.x * edgeFade3.y * edgeFade3.z;
  fogFactor *= edgeFade;

  vec3 lightTint = sampleLightProbe(fogMidpoint);

  // Accumulate dynamic light contributions at the fog midpoint.
  // Each dlight acts as a point light with linear falloff based on radius.
  vec3 dlightContrib = vec3(0.0);
  for (int i = 0; i < MAX_FOG_DLIGHTS; i++) {
    if (i >= uDlightCount) {
      break;
    }
    vec3 dlPos = uDlightPos[i].xyz;
    float dlRadius = uDlightPos[i].w;
    vec3 dlColor = uDlightColor[i].rgb;
    float dist = distance(fogMidpoint, dlPos);
    float atten = max(0.0, 1.0 - dist / dlRadius);
    dlightContrib += dlColor * atten;
  }

  // Apply gamma to light-tinted fog color (static probe + dynamic lights).
  // uFogVolumeColor is the scattering albedo and modulates all light sources.
  // Clamp to [0, 1] before pow to avoid undefined behaviour for over-bright inputs.
  vec3 color = pow(clamp(uFogVolumeColor * (lightTint + dlightContrib), 0.0, 1.0), vec3(uGamma));

  fragColor = vec4(color, fogFactor);
}
