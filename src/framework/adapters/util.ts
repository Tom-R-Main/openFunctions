/**
 * Adapter helpers shared across providers.
 */

/**
 * JSON.parse that doesn't throw. Adapters consume strings from the
 * history (which the framework controls) and from API responses (which
 * providers usually shape correctly), but a malformed value should not
 * crash the entire chat — it should degrade to a safe fallback so the
 * loop can continue.
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
