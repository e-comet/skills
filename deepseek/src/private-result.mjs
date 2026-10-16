/** Scrub canonical results and their JSON text projections with caller-owned privacy rules. */
export function scrubPrivateResult(value, secrets, privateKeys, label) {
  const retained = secrets.filter(secret => typeof secret === 'string' && secret);
  function visit(item) {
    if (typeof item === 'string') {
      // Scalar text can be an identifier: parsing it would lose formatting or precision.
      // Containers and quoted JSON still need decoding to find escaped private values.
      if (/^\s*(?:\{|\[|")/u.test(item)) {
        try { return JSON.stringify(visit(JSON.parse(item))); } catch { /* Scrub malformed JSON as text. */ }
      }
      // Prose embedding an escaped copy stays literal-only: "Escaped authorization inside prose"
      // in docs/local-agent-architecture.md#accepted-residuals.
      return retained.reduce((text, secret) => text.split(secret).join(label), item);
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item === null || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !privateKeys.has(key))
      .map(([key, entry]) => [key, visit(entry)]));
  }
  return visit(value);
}
