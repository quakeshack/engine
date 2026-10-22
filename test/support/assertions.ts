import assert from 'node:assert/strict';

/**
 * Asserts that two numbers are equal within a tolerance, for floating-point results.
 * @param actual The value under test.
 * @param expected The value it should have.
 * @param epsilon The largest allowed difference.
 */
export function assertNear(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}
