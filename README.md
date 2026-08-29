# Everyone in Codex

Everyone in Codex is a Windows-first integration layer that runs compatible agent Harnesses in Codex Desktop while reusing an existing Codex Router and WebGPT model plane.

The project deliberately keeps three responsibilities separate:

- codexhost owns Harness sessions and projects their tools, approvals, diffs and history into Codex Desktop;
- Codex Router owns model metadata, credentials, routing and provider compatibility;
- WebGPT owns browser-backed ChatGPT transport.

## Safety defaults

- The base Codex Profile is never rewritten. The managed launch publishes an owned catalog and passes only seven allowlisted `-c` overrides to `app-server`.
- Router and WebGPT are external dependencies. This CLI does not start, stop, restart, repair or upgrade them.
- The Router caller capability remains in the gateway process memory and is never exposed to a Harness.
- Models are capability-filtered. WebGPT models are visible only to the Codex Harness.
- Local real validation must use a non-primary Codex Profile explicitly allowlisted by `validation-policy.local.json`.

## CLI

```text
everyone-codex doctor
everyone-codex profile add|list|use
everyone-codex harness adopt|install|login|list|remove
everyone-codex models sync
everyone-codex launch
everyone-codex restore
```

The implementation is under active development. Until a portable release is produced, run commands only from a trusted source checkout.

For a local or portable setup, copy the two templates in `config/` to
`fusion.local.json` and `validation-policy.local.json`, then replace every
placeholder with the exact Codex 2, Router and Desktop paths. All four Codex 2
paths must be explicitly allowlisted; any symlink or Windows reparse ancestor is
rejected before a process starts.
