#version 300 es
precision highp float;

uniform float uInterpolation;

in vec3 aPositionA;
in vec3 aPositionB;
in vec3 aNormal;
in vec2 aTexCoord;

#include "entity-vertex.glsl"

void main(void) {
  emitEntityVertex(mix(aPositionA, aPositionB, uInterpolation), aNormal, aTexCoord);
}
