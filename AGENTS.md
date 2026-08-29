# Everyone in Codex development rules

- Keep CodexHost, Codex Router, and WebGPT as separate modules joined through small interfaces.
- Never edit or stop Codex 1, its Profile, Router service, WebGPT service, or another task's working tree.
- Local live validation is restricted to the configured Codex 2 Profile and managed Desktop clone.
- Do not read, print, persist in Git, or pass on command lines any provider key, OAuth token, Router caller capability, cookie, or conversation body.
- Use `apply_patch` for source edits. Keep comments useful and in Chinese where design intent or compatibility handling is non-obvious.
- Tests target only `FusionController`, `RouterCatalogBridge`/`BridgeLease`, and the patched CodexHost command interface.
- Do not add a dynamic Adapter marketplace, a second provider router, broad performance suites, or Harness-by-model Cartesian tests.
- Runtime data belongs under ignored `.runtime/` or `.state/`; public artifacts must pass the release allowlist audit.
