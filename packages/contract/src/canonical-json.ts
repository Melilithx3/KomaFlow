/**
 * Canonical JSON (docs/01-data-model.md §5): keys sorted, no whitespace,
 * only strings, integers, booleans, null, arrays and plain objects.
 * Non-integer numbers are rejected: encode them as strings first (see {@link canonicalNumber}).
 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalJson: non-integer number ${value}`);
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]!)).join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** Integers stay numbers; other finite numbers become their shortest round-trip string. */
export function canonicalNumber(n: number): number | string {
  if (!Number.isFinite(n)) throw new TypeError(`canonicalNumber: ${n}`);
  return Number.isSafeInteger(n) ? n : String(n);
}

/** Recursively converts arbitrary JSON-like data (e.g. settings) into canonical-safe values. */
export function toCanonical(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toCanonical);
  if (typeof value === 'object') {
    const out: Record<string, CanonicalValue> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toCanonical(v);
    return out;
  }
  throw new TypeError(`toCanonical: unsupported type ${typeof value}`);
}
