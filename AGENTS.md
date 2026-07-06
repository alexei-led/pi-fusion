# Contributor notes

- Keep the extension small, typed, and testable.
- Do not own or replace the Pi footer. Publish only the `fusion` status key.
- Use `pi-subagents` RPC for panel and judge execution. Do not import its internals.
- Keep bundled panel agents read-only by default.
- Do not add runtime dependencies unless the task needs them.
