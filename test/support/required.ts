import assert from 'node:assert/strict';

export function required<T>(
  value: T | null | undefined,
  message = 'Expected a defined value',
): NonNullable<T> {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}
