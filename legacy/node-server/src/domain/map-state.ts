import { isDeepStrictEqual } from "node:util";

export function copyMap<K, V>(source: Map<K, V>, copy: (value: V) => V): Map<K, V> {
  return new Map([...source].map(([key, value]) => [key, copy(value)]));
}

export function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

/** Apply only the keys changed by a staged command, preserving unrelated live changes. */
export function applyMapChanges<K, V>(
  target: Map<K, V>,
  before: Map<K, V>,
  after: Map<K, V>,
  copy: (value: V) => V,
): void {
  for (const key of before.keys()) {
    if (!after.has(key)) target.delete(key);
  }
  for (const [key, value] of after) {
    if (!before.has(key) || !isDeepStrictEqual(before.get(key), value)) {
      target.set(key, copy(value));
    }
  }
}
