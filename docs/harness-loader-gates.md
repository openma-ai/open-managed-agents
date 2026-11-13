# Offline official harness configuration gate

Run from the repository root after the normal workspace dependency install:

```sh
node scripts/check-official-harness-loaders.mjs \
  /absolute/path/to/node_modules/@moonshot-ai/kimi-code \
  /absolute/path/to/opencode
```

The gate requires complete official **Kimi 2.6.0** and **OpenCode 1.2.21
Linux x64** distributions already installed outside the source tree. It never
installs or downloads them. Missing files, a different version or executable
hash, unavailable Linux user/network/mount namespaces, or loader errors fail
the command. There is no skip or substitute schema. The Kimi package name is
`@moonshot-ai/kimi-code`; its official release tag is
`@moonshot-ai/kimi-code@2.6.0` in `MoonshotAI/kimi-code` (commit
`740d6c0bdd777cd8ed0d91eb3d62766910401173`). OpenCode's official release is
`anomalyco/opencode` tag `v1.2.21`. Exact audited executable hashes are checked
in the script, before execution.

The script generates configuration from the current OMA adapters for Messages,
Responses, Google and Chat. It runs Kimi's `doctor config` and
`provider list --json`, and OpenCode's `debug config`, through their complete
normal loaders. Resolved provider, model and proxy settings must match.
Malformed TOML must be rejected by Kimi's doctor; an invalid model type must
be rejected by OpenCode. Kimi's provider-list command alone is insufficient as
a negative control: it can return empty maps with exit zero on malformed TOML.

Every subprocess has an isolated home, a clean environment containing only a
synthetic proxy token, a bounded timeout, and a network namespace with no
external route. Upstream controls disable telemetry, updates, model fetches,
plugins and downloads. OpenCode's configuration directory is mounted read-only
to prevent its implicit dependency installation. The gate does not run a model,
start ACP, or prove live provider compatibility. Generic executable integrations
remain version-dependent; these two audited versions are evidence boundaries,
not new product installation pins.

A JSON receipt is printed on success. This heavier gate is explicit because
ordinary CI does not provision these distributions. The ordinary adapter tests
remain useful fast tests, but do not replace this official-loader gate.
