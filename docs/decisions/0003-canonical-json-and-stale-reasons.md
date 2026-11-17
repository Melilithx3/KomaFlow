# 0003. Canonical JSON numbers and stale reasons

**Context.** docs/01 §5 says canonical JSON contains only integers and strings, but PsdSettings has floats (`line_height`, `text_padding`) and booleans. ExportStatus needs `stale_reasons`, the full hash alone cannot explain them.

**Decision.** `canonicalJson` accepts strings, safe integers, booleans, null, arrays, objects and throws on non-integers. Settings pass through `toCanonical`, which turns non-integer numbers into their shortest JS string (`1.15` -> `"1.15"`). The manifest page stores, besides `psd_input_hash`, `parts` = sub-hashes for clean, notes, markup, translation, settings (incl. layer flags); stale reasons = differing parts.

**Consequences.** Freshness is still decided by `psd_input_hash` only; `parts` is a UI hint. Hash is computed by sync pure-JS SHA-256 in contract (same result in Node and browser).
