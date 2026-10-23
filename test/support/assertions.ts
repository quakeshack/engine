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

/**
 * Runs a check until it stops throwing, for what arrives over a message channel or after a timer. A fixed wait is
 * too short on a busy machine (a CI agent running the test files side by side): the timer that ends the wait can fire
 * before the message posted earlier is delivered.
 * @param check Throws (an assertion) while what it waits for has not happened.
 * @param timeout How long to keep trying, in milliseconds, before the last failure is thrown.
 */
export async function eventually(check: () => void, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
    }

    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}
