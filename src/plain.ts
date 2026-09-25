/**
 * Detach the loader's live configuration into plain data.
 *
 * Since 0.1.7 a `Config` field declared `.volatile()` does not reach `apply()`
 * as its value: it arrives as a cosmokit reference — a frozen `{ get() }` whose
 * `get()` returns an immutable recursive snapshot — so that the settings UI can
 * change the field without remounting the plugin. Every other field is plain.
 * The plugin's config readers want one shape, so each read walks the object and
 * replaces references with their current snapshot.
 *
 * The reference is detected through the shared-protocol symbol rather than an
 * `instanceof` or a duck-typed `get` check: `@deepseek-ai/cosmokit` is a
 * transitive host dependency and not one of this plugin's peerDependencies, so
 * naming its class would import something the host does not guarantee, and a
 * `typeof value.get === 'function'` probe would also match any service object.
 * `Symbol.for` resolves across the separate copies of the library a plugin tree
 * can load, which is the same mechanism cosmokit's own `isVolatile` uses.
 *
 * @module dsh-voice/plain
 */

/** The global-registry symbol cosmokit brands its writable references with. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** A cosmokit config reference, structurally. */
interface VolatileRef {
  get(): unknown;
}

/**
 * @param value - any value, typically one held by a parsed config object.
 * @returns whether `value` is a live config reference.
 */
function isVolatile(value: unknown): value is VolatileRef {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/**
 * Replace every live reference in a config value with its current snapshot.
 * @param value - a parsed config value, an object, or an array of them.
 * @returns the same shape with all references detached; frozen snapshots taken
 *   from a reference are already plain, so they are not walked again.
 */
export function plainConfig(value: unknown): unknown {
  if (isVolatile(value)) return value.get();
  if (Array.isArray(value)) return value.map(plainConfig);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
  }
  return value;
}
