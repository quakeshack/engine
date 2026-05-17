import type { ClientSerializableType, SerializableType } from './GameInterfaces.ts';
import Vector from './Vector.ts';

type ComparableSerializableValue = SerializableType | ClientSerializableType;

/**
 * Returns true when the value is a plain serializable object payload.
 * @returns True when the value is a plain object payload.
 */
function isPlainSerializableObject(value: ComparableSerializableValue): value is Record<string, ComparableSerializableValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Vector) {
    return false;
  }

  return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Compares serializable values by value semantics.
 * @returns True when both values are semantically equal.
 */
export function areSerializableValuesEqual(left: ComparableSerializableValue, right: ComparableSerializableValue): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left === null || right === null) {
    return false;
  }

  if (left instanceof Vector && right instanceof Vector) {
    return left.equals(right);
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let i = 0; i < left.length; i++) {
      const leftValue = left[i];
      const rightValue = right[i];

      if (leftValue === undefined || rightValue === undefined || !areSerializableValuesEqual(leftValue, rightValue)) {
        return false;
      }
    }

    return true;
  }

  if (isPlainSerializableObject(left) && isPlainSerializableObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key) || !areSerializableValuesEqual(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
}
