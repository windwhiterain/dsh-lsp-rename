# dsh-lsp-rename

One pooled language server per workspace, serving `goToDefinition`, `findReferences`,
`goToImplementation`, `hover` — and `rename`, which the shipped `lsp` tool cannot reach. A second
tool, `lsp_wait_for_index`, blocks until that server can answer for a position.

## Why this plugin exists

The harness `ctx.lsp` seam is closed to four read-only operations by design.
`LspOperation` is a compile-enforced union of exactly those four, the seam publishes "no generic
JSON-RPC escape hatch", and the stdio host answers `workspace/applyEdit` with a refusal, because
that host never applies edits. No `cordis.yml` writing reaches `textDocument/rename` through
`dsh-lsp` + `dsh-lsp-stdio` + `dsh-tool-lsp`, so a bundle that mounts those three rows (such as
`dsh-lsp-rust`) cannot be configured into renaming.

This plugin therefore speaks the protocol itself. It spawns one server per canonical workspace
through `ctx.subprocess`, reads and writes through `ctx.fs`, and applies the returned
`WorkspaceEdit` itself. It depends on no harness package, so it loads as a bare plugin against the
running installation.

## What it replaces

The tool is named **`lsp_rename`**, and the row takes the shipped **`lsp`** tool away from the
agents of the preset it is mounted in. One tool name means one language server: the shipped
`dsh-lsp-stdio` provider spawns a process lazily, on its first query, so a preset that never queries
the seam never starts a second rust-analyzer. The shipped rows stay enabled for the presets that
still want them.

The handover is a `tools.restrict({ deny: ['lsp'] })` on `agent/created`, not a same-name
registration. A restriction filters what an agent **inherits** — the global composition — and never
what shares the row's own layer, which is exactly the split needed here: the shipped `lsp` comes
from the host composition, and `lsp_rename` is this row's. The listener is guarded on the agent's own
catalog, so a preset that mounts no shipped provider never asks to restrict a name that was not
there. This is the same mechanism `dsh-skill-gate` uses to hide the skill loader.

## Operations

| Operation | Request | Result |
|---|---|---|
| `goToDefinition` | `textDocument/definition` | locations |
| `findReferences` | `textDocument/references` (always including the declaration) | locations |
| `goToImplementation` | `textDocument/implementation` | locations |
| `hover` | `textDocument/hover` | text or nothing |
| `rename` | `textDocument/rename` | a written workspace edit |

`line` and `character` are one-based UTF-16 cursor coordinates, matching the shipped tool;
`new_name` is required by `rename` and ignored by the other four.

## Choosing the workspace root

`workspace_root` selects the directory the server is rooted at. It defaults to the session's own
workspace, which is right for a single project; pass a crate or package directory when the code
belongs to a subproject, so the server indexes that root instead of the whole repository. Rendered
locations are relative to the chosen root.

Each distinct root gets **its own language-server process**, so a session that alternates between
roots pays a cold index per root and holds the memory for each.

A requested root must be the session workspace itself or a directory inside it. That is the one
boundary this tool keeps: the harness confines a session's writes to its workspace, and a root
outside it would run a server — and apply a rename — beyond where the session's own policy reaches.
A monorepo needs nothing more, since the crate directory is inside the workspace.

Each query is one `didOpen` → request → `didClose` lifecycle against the bytes currently on disk, so
the server never holds stale content and the host keeps no document state. One serialized lane per
workspace is what makes that lifecycle safe.

## Waiting for the index

A language server answers an unindexed file with **no results** rather than waiting, so the first
query after a cold start can report nothing for a symbol that exists. `lsp_wait_for_index` closes that
gap: give it a position you expect to hold a symbol, and it polls there until the server returns
results, returning the references it found along the way.

```
lsp_wait_for_index(file_path: "crates/foo/src/lib.rs", line: 12, character: 8, workspace_root: "crates/foo")
```

There is no readiness request in LSP and no portable way to ask "have you indexed yet", so the wait
polls the caller's own position with `findReferences` — which always includes the declaration, so any
real symbol eventually answers. It reports one of three outcomes:

| Outcome | Meaning |
|---|---|
| `answered` | The server returned references; `locations` holds them. |
| `answered-nothing` | The server answered with an **error**: it is serving that position and says there is no symbol there. The error text is reported verbatim. |
| `timed-out` | The whole budget passed with empty results. |

An empty result is ambiguous — it is what an unindexed file returns *and* what a position with no
symbol returns — so only a server error can settle it early. **A position that holds no symbol polls
out the full budget** rather than reporting "absent", because the protocol cannot tell the two apart.
Use the wait where you expect a symbol; the budget is `timeoutMs`.

A server may answer with a cancellation instead of a result — rust-analyzer sends `ContentModified`
(-32801) when its file watcher reloads a document — which says nothing about indexing, so those are
retried rather than reported.

The poll takes and releases the workspace lane between attempts, so a long wait never blocks another
query on the same workspace, and the wait tool is declared concurrency-safe.

## How a rename lands

1. The server's `WorkspaceEdit` is turned into a full write plan and validated **before** anything is
   written: URI shape, edit shape, non-overlap, and every position inside the text it was computed on.
2. A `create`/`rename`/`delete` file operation in the plan is **refused**, with a message naming the
   paths. Nothing is written, because `ctx.fs` has no move or delete and a partial file move is worse
   than a clear refusal.
3. Each file is resolved, stat'ed for its version, read, edited, and written with
   `replaceIfVersion` — a file that changed underneath the rename is refused, not overwritten.
4. If a later file fails, every file already written is restored from the text read before it. The
   model is told the rename landed whole or not at all.

Edits are applied to the exact text read from disk, so CRLF, a missing final newline, and BOM-free
UTF-8 all survive a rename: the file is never re-serialized from parsed lines. Positions are
converted against a per-file line index, and JavaScript string indices are UTF-16 code units, so a
rename after an emoji lands correctly (the probe checks this).

## Configuration

`command` and `extensionToLanguage` are required; every other field has a default. Unknown fields,
malformed extensions, and out-of-range bounds fail the row's **activation** with every problem listed
at once.

| Field | Default | Meaning |
|---|---|---|
| `command` | — | Executable to spawn: an absolute path, or a bare name resolved on `PATH` at load. |
| `extensionToLanguage` | — | Lowercase extension → LSP language id. `{rs: rust}` and `{'.RS': rust}` normalize to `{'.rs': 'rust'}`. |
| `args` | `[]` | Arguments passed to the executable, without a shell. |
| `env` | `{}` | Environment entries merged on top of the subprocess seam's scrub. |
| `initializationOptions` | `null` | Static `initialize` options. |
| `configuration` | `null` | Static answer to every `workspace/configuration` item. |
| `timeoutMs` | `180000` | Tool-call budget covering the whole open/query/close lifecycle. |
| `maxLocations` | `100` | Locations rendered before an omission marker. |
| `maxResultChars` | `16000` | Bound on the complete rendered result, notice included. |
| `maxMessageBytes` | `16000000` | Largest single framed message accepted from the server. |
| `maxStderrBytes` | `1000000` | Retained stderr tail, used in a failure diagnostic. |
| `maxDocumentBytes` | `4000000` | Largest source file this plugin opens. |
| `shutdownTimeoutMs` | `5000` | `shutdown`/`exit` budget before escalating to termination. |
| `killGraceMs` | `2000` | `$/cancelRequest` grace, and the SIGTERM→SIGKILL window. |

The executable is resolved at load, so a missing language server fails activation rather than the
first query. The server process is **not** sandboxed: it inherits the filesystem and process
authority of the mounted execution world.

## Mounting

Add the dependency to the profile and mount one row inside the preset that should own the tool:

```json
"dependencies": { "dsh-lsp-rename": "link:C:/resource/dsh-lsp-rename" }
```

```yaml
- id: lsp-rename
  name: "dsh-lsp-rename"
  config:
    command: rust-analyzer
    extensionToLanguage:
      ".rs": rust
    timeoutMs: 180000
```

A newly installed `link:` dependency needs one host restart before the row resolves. Afterwards,
listing the plugin's files as file-level `hmr` roots re-applies the row on every save without a
restart.

To retire the shipped rows entirely, disable them by id in the same patch layer:

```yaml
- id: tool-lsp
  disabled: true
- id: lsp-rust
  disabled: true
```

## Verifying a change

`probe/rename-probe.mjs` runs the plugin's own `ServerInstance` against a real rust-analyzer over
stdio, so a protocol mismatch shows up there instead of in a session. It needs no harness process:

```sh
cd probe && node rename-probe.mjs
```

It copies `probe/workspace/` to a scratch directory and reports, in order: the advertised
capabilities, the index wait's three outcomes (cold convergence, warm return, and a position with no
symbol polled out to the budget), the four read-only operations, the raw `WorkspaceEdit`, the planned
file and edit counts, whether the applied text still contains the old identifier, whether CRLF and
astral-plane offsets survived, and — by refusing one file's write — whether the rollback restores the
others byte for byte. It exits non-zero when any check fails.

`probe/row-boot.mjs` boots the four services this row injects in one context and applies the row
exactly as the Loader would, then asserts the model-facing parameter schema carries a top-level
`required` list rather than per-property flags. Run it from a Harness checkout, because it imports
the service classes from source:

```sh
cd <deepseek-harness> && node --import tsx/esm C:/resource/dsh-lsp-rename/probe/row-boot.mjs
```

Both probes exist because a row that fails to activate inside an agent preset takes the whole preset
down with it: no session, no agent, no model picker, and the Loader's own report only reaches the
Plugins page.

A cold workspace takes a few seconds to index, and the probe reports that wait rather than reading
an empty answer as success.

## Known limitations and deferred work

- **A rename that moves a file is refused, not applied.** rust-analyzer emits a `RenameFile`
  document change when a rename renames a module with its file. `ctx.fs` has no move or delete, and
  the shipped `write`/`edit` tools have no delete either, so the tool reports the paths and writes
  nothing. Renaming a use site inside a file works normally.
- **The first query after a cold start can be empty.** rust-analyzer indexes the crate graph
  asynchronously and answers an unindexed file with no results instead of waiting, so `timeoutMs`
  does not bound the index. Call `lsp_wait_for_index` before concluding a symbol is absent; a retry
  succeeds. The file watcher also cancels an in-flight request with `ContentModified` (-32801),
  which surfaces as a failed call and is retried by the wait tool.
- **No escalation argument.** Writes carry the calling session's standing sandbox policy, and the
  tool advertises no `sandbox_permissions`. A denial is reported to the model, which can reissue the
  change through `write` or `edit` with an explicit escalation.
- **One process per workspace root, for the host's lifetime.** A server is not evicted when idle,
  which matches the shipped provider; a session that names several roots through `workspace_root`
  holds one process per root. Add an idle budget to `lib/pool.js` if a long-lived host must not hold
  a rust-analyzer open.
- **A root outside the session workspace is refused.** Sibling subprojects that share no ancestor
  with the session workspace need the session workspace set one level up.
- **Symbols only.** No code actions, no `documentSymbol`, no cross-file type information beyond what
  the four navigation operations expose.
- **The `ctx.fs` write path is probe-covered through a stub, not the real provider.** The probe's
  filesystem stub reproduces resolve/stat/readText/writeText and the version guard; the sandbox
  policy and `fs/observed` emission are exercised only in a live host.
