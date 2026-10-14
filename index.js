/**
 * `dsh-lsp-rename` — one pooled language server per workspace, serving the four read-only
 * navigation operations plus the rename the shipped `lsp` tool does not expose.
 *
 * The harness `ctx.lsp` seam is closed to four read-only operations by design and rejects
 * `workspace/applyEdit`, so no configuration of the shipped rows can reach `textDocument/rename`.
 * This plugin therefore speaks the protocol itself: it spawns one server per canonical workspace
 * through the subprocess seam, answers from the exact bytes on disk through the filesystem seam, and
 * applies the returned `WorkspaceEdit` itself. The tool is named `lsp`, so mounting this row in an
 * agent preset shadows the shipped `lsp` tool for that preset's agents — one tool name, one
 * language-server process, and no second server for a query nobody makes.
 *
 * @module dsh-lsp-rename
 */

import { Config, normalizeConfig } from './lib/config.js'
import { languageIdFor, OPERATIONS, parseToolArgs, positionOf } from './lib/args.js'
import { hoverText, normalizeLocations } from './lib/normalize.js'
import { formatHover, formatLocations, formatRename, renameDiff } from './lib/render.js'
import { ANSWERED, ANSWERED_NOTHING, awaitIndex, TIMED_OUT } from './lib/index-wait.js'
import { ServerPool } from './lib/pool.js'
import { applyRename, planWorkspaceEdit } from './lib/workspace-edit.js'

export { Config }

/** The tool name this row registers. */
const TOOL_NAME = 'lsp_rename'

/** The shipped read-only navigation tool this row replaces for the agents of its preset. */
const SHIPPED_LSP_TOOL = 'lsp'

/** The wait tool's name. It is a wait, not a protocol operation, so it does not join the operation enum. */
const WAIT_TOOL_NAME = 'lsp_wait_for_index'

/** Cordis plugin name for loader diagnostics. */
export const name = 'lsp-rename'

/** Services this plugin cannot serve a query or write a rename without. */
export const inject = ['fs', 'subprocess', 'tools', 'systemPrompt']

/**
 * The guidance this row publishes for its own tool.
 */
const PROMPT_TEXT = 'Use search/read for ordinary navigation. Use lsp_rename when textual matches are ambiguous, before a change requires precise definitions, implementations, references, or types, and whenever a caller asks to rename a symbol. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration. operation rename rewrites the symbol in every file the server reports, immediately, and does not move or create files: when the caller did not ask for a rename, do not use it. Pass workspace_root when the code belongs to a subproject — a crate or package directory inside this workspace — so the server answers from that root; each distinct root costs one language-server process. A language server answers an unindexed file with no results rather than waiting, so the first query after a cold start can report nothing for a symbol that exists: call lsp_wait_for_index on that position before concluding a symbol is absent.'

/**
 * The root-selection argument, declared once and shared by both tools so the query tool and the wait
 * can never drift into describing the same choice differently.
 */
const WORKSPACE_ROOT_FIELD = Object.freeze({
  type: 'string',
  description: 'Directory the language server treats as its workspace root, relative to the session workspace or absolute. Defaults to the session workspace. Pass a crate or package directory when the session workspace sits above it, so the server indexes that root instead of the whole repository.',
})

/**
 * The model-facing parameter schema, as plain JSON Schema.
 *
 * This plugin registers its definition directly rather than through `defineTool`, which is what
 * compiles the Harness's per-property `required: true` spec dialect into JSON Schema. The registry
 * projects `parameters` verbatim onto the model request, so the object below is exactly what the
 * model is asked to fill in: a top-level `required` list, not flags on scalar properties. Argument
 * checking is {@link parseToolArgs}'s job, which reports one model-facing reason at a time.
 */
export const PARAMETERS = Object.freeze({
  type: 'object',
  required: ['operation', 'file_path', 'line', 'character'],
  properties: {
    operation: {
      type: 'string',
      enum: [...OPERATIONS],
      description: 'goToDefinition, findReferences, goToImplementation, hover, or rename. rename writes the new identifier to every file the server reports and needs new_name.',
    },
    file_path: { type: 'string', description: 'The source file to query, relative to the workspace or absolute.' },
    line: { type: 'number', description: 'One-based line of the cursor.' },
    character: { type: 'number', description: 'One-based UTF-16 column of the cursor.' },
    new_name: { type: 'string', description: 'Required for operation rename: the new identifier. Ignored by the other four operations.' },
    workspace_root: WORKSPACE_ROOT_FIELD,
  },
})

/** One resolved location, reported as the start position every consumer renders. */
const LOCATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['uri', 'line', 'character'],
  properties: {
    uri: { type: 'string' },
    line: { type: 'integer' },
    character: { type: 'integer' },
  },
})

/** One written file, with the diff window the UI card renders when the change is small enough. */
const RENAMED_FILE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['path', 'edits'],
  properties: {
    path: { type: 'string' },
    edits: { type: 'integer' },
    oldText: { type: 'string' },
    newText: { type: 'string' },
  },
})

/**
 * The closed result schema.
 *
 * Plain JSON Schema, for the same reason as {@link PARAMETERS}: `register` asserts this against the
 * registry's supported subset, which allows a `required` flag only on `type: 'object'` properties
 * and never beside `oneOf`. In the spec dialect the row fails to activate, and a failed row inside
 * an agent preset takes the preset — and every session on it — down.
 */
export const OUTPUT_SCHEMA = Object.freeze({
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'locations', 'workspacePath'],
      properties: {
        kind: { type: 'string', const: 'locations' },
        locations: { type: 'array', items: LOCATION_SCHEMA },
        workspacePath: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'hover'],
      properties: {
        kind: { type: 'string', const: 'hover' },
        hover: { oneOf: [{ type: 'null' }, { type: 'string' }] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'renamedFrom', 'renamedTo', 'files'],
      properties: {
        kind: { type: 'string', const: 'rename' },
        renamedFrom: { type: 'string' },
        renamedTo: { type: 'string' },
        files: { type: 'array', items: RENAMED_FILE_SCHEMA },
      },
    },
  ],
})

/** The wait tool's parameters: the query tool's position arguments, without the operation. */
export const WAIT_PARAMETERS = Object.freeze({
  type: 'object',
  required: ['file_path', 'line', 'character'],
  properties: {
    file_path: { type: 'string', description: 'A source file holding a symbol you expect to find, relative to the workspace or absolute.' },
    line: { type: 'number', description: 'One-based line of a position on that symbol.' },
    character: { type: 'number', description: 'One-based UTF-16 column of that position.' },
    workspace_root: WORKSPACE_ROOT_FIELD,
  },
})

/** The wait's closed result: what happened, how long it took, and the references it already found. */
export const WAIT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'waitedMs', 'locations', 'workspacePath'],
  properties: {
    outcome: { type: 'string', enum: [ANSWERED, ANSWERED_NOTHING, TIMED_OUT] },
    waitedMs: { type: 'integer' },
    locations: { type: 'array', items: LOCATION_SCHEMA },
    workspacePath: { type: 'string' },
    detail: { type: 'string' },
  },
})

/**
 * Mount this plugin's `lsp` tool and its system-prompt guidance.
 * @param ctx - the plugin context carrying `fs`, `subprocess`, `tools`, and `systemPrompt`.
 * @param rawConfig - the row's configuration, validated here and by {@link Config}.
 * @throws {ConfigError} when a field is missing, unknown, or out of range.
 */
export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  // The execution world, not the harness host, decides how a `file:` URI decodes and how a path
  // renders; the two can differ.
  const { platform } = await ctx.subprocess.terminalEnvironment()
  const windows = platform === 'windows'
  const pool = new ServerPool(config, await resolveServer(ctx, config), spec => ctx.subprocess.spawn(spec))

  ctx.systemPrompt.section({
    name: 'tool:lsp-rename',
    order: ctx.systemPrompt.getSectionOrder('TOOL_LSP'),
    text: PROMPT_TEXT,
  })
  ctx.effect(() => ctx.tools.register(defineLspTool(ctx, pool, config, windows)), 'lsp-rename.tool')
  ctx.effect(() => ctx.tools.register(defineIndexWaitTool(ctx, pool, config, windows)), 'lsp-rename.index-wait')
  // The effect body must yield a disposer; `pool.dispose` IS one, and its promise is the teardown's
  // settlement the fiber awaits.
  ctx.effect(() => () => pool.dispose(), 'lsp-rename.pool')
  // Take the shipped read-only tool away from this preset's agents, so one preset drives one
  // language server: the shipped provider starts a second rust-analyzer on its first query.
  //
  // `restrict()` masks what a scope INHERITS and never its own layer, which is exactly the split
  // needed here: `lsp` is inherited from the host composition, and `lsp_rename` shares this row's
  // layer. Guarding on the agent's own catalog keeps a preset that mounts no shipped provider from
  // asking to restrict a name that was never there (`restrict` rejects an unknown name).
  ctx.on('agent/created', ({ agent }) => {
    if (!ctx.tools.schemas(agent).some(schema => schema.name === SHIPPED_LSP_TOOL)) return
    agent.ctx.tools.restrict({ deny: [SHIPPED_LSP_TOOL] })
  })
}

/**
 * Resolve the configured executable at load, so a missing language server fails the row's
 * activation with an actionable message instead of the first query.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @returns the executable's absolute path in the execution world.
 */
async function resolveServer(ctx, config) {
  try {
    return await ctx.subprocess.resolveExecutable(config.command, config.env)
  } catch (error) {
    throw new Error(
      `lsp-rename: cannot run the configured language server "${config.command}": ${error instanceof Error ? error.message : String(error)}. `
      + 'Install it and put it on PATH, or set command to its absolute path.',
      { cause: error },
    )
  }
}

/**
 * Build the `lsp_wait_for_index` tool: block until the language server answers for one position.
 *
 * The probe is a `findReferences` query, so a successful wait hands the caller the references it was
 * polling for and the query that usually follows it is not needed.
 * @param ctx - the plugin context.
 * @param pool - the language-server pool.
 * @param config - the resolved plugin configuration.
 * @param windows - whether the execution world is Windows.
 * @returns the tool definition.
 */
function defineIndexWaitTool(ctx, pool, config, windows) {
  return {
    name: WAIT_TOOL_NAME,
    description: 'Block until a language server can answer for one position, and return the references it finds. '
      + 'A server answers an unindexed file with no results instead of waiting, so the first query after a cold start '
      + 'can report nothing for a symbol that exists. Give it a position on a symbol you expect to exist: it polls '
      + 'findReferences there until the server returns results, then reports what happened. A position that holds no '
      + 'symbol also returns nothing forever, so use this only where you expect a symbol; the budget is timeoutMs. '
      + 'line and character are one-based UTF-16 coordinates.',
    parameters: WAIT_PARAMETERS,
    // The poll takes and releases the workspace lane between attempts, so a wait never blocks another
    // query on the same workspace.
    isConcurrencySafe: () => true,
    timeoutMs: config.timeoutMs,
    output: {
      schema: WAIT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatIndexWait(value, windows, config.maxResultChars) }],
    },
    async execute(args, exec) {
      const sessionCwd = exec.agent?.session.header.cwd
      if (sessionCwd === undefined) throw new Error(`${WAIT_TOOL_NAME} requires a session workspace cwd`)
      if (typeof args.file_path !== 'string' || args.file_path.trim() === '') {
        throw new Error('file_path must be a non-empty string')
      }
      const position = positionOf(args)
      const languageId = languageIdFor(config.extensionToLanguage, args.file_path)
      const sessionRoot = await ctx.fs.resolve(sessionCwd, { signal: exec.signal })
      const workspace = await resolveWorkspace(ctx, sessionRoot, sessionCwd, args.workspace_root, exec.signal)
      const workspacePath = ctx.fs.processPath(workspace)
      const workspaceUri = ctx.fs.fileUrl(workspace)
      const source = await readSource(ctx, args.file_path, sessionCwd, config, exec.signal)
      const waited = await awaitIndex(
        () => pool.run(
          workspace,
          workspacePath,
          workspaceUri,
          'findReferences',
          instance => instance.query(
            { operation: 'findReferences', languageId, position, newName: undefined },
            source,
            exec.signal,
          ),
          exec.signal,
        ),
        { signal: exec.signal, budgetMs: config.timeoutMs },
      )
      return {
        outcome: waited.outcome,
        waitedMs: waited.waitedMs,
        locations: waited.payload === undefined ? [] : normalizeLocations(waited.payload),
        workspacePath,
        ...(waited.detail === '' ? {} : { detail: waited.detail }),
      }
    },
  }
}

/**
 * Render one index wait for the model: the outcome in words, the wait, and the references the probe
 * already found.
 * @param value - the wait result.
 * @param windows - whether the execution world is Windows.
 * @param maxResultChars - the complete rendered-text bound.
 * @returns the rendered text.
 */
function formatIndexWait(value, windows, maxResultChars) {
  const found = value.locations.length
  const lines = [
    `${outcomeText(value.outcome)} after ${value.waitedMs} ms.`,
    `${found} reference${found === 1 ? '' : 's'} at the position you gave.`,
  ]
  if (value.detail !== undefined && value.detail !== '') lines.push(`The server said: ${value.detail}`)
  for (const location of value.locations) {
    lines.push(`${displayPath(location.uri, value.workspacePath, windows)}${location.line + 1}:${location.character + 1}`)
  }
  const text = lines.join('\n')
  return text.length <= maxResultChars ? text : `${text.slice(0, maxResultChars)}\n… truncated.`
}

/**
 * The model's reading of one outcome.
 * @param outcome - the wait outcome.
 * @returns the sentence that names it.
 */
function outcomeText(outcome) {
  if (outcome === ANSWERED) return 'The language server is answering for this position'
  if (outcome === ANSWERED_NOTHING) return 'The language server answered, and reports no symbol at this position'
  return 'The language server answered with nothing for this position the whole time. Either it is still indexing '
    + 'beyond this budget, or the position holds no symbol — only its own error can tell those apart, and it gave none'
}

/**
 * Build the `lsp_rename` tool. The workspace comes from the calling session, so one definition
 * serves every session that mounts this row.
 * @param ctx - the plugin context.
 * @param pool - the language-server pool.
 * @param config - the resolved plugin configuration.
 * @param windows - whether the execution world is Windows.
 * @returns the tool definition.
 */
function defineLspTool(ctx, pool, config, windows) {
  return {
    name: TOOL_NAME,
    description: 'Query a language server for precise code navigation, or rename a symbol across the workspace. '
      + 'operation is one of goToDefinition, findReferences, goToImplementation, hover, rename. '
      + 'line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration. '
      + 'rename requires new_name and writes the new identifier into every file the server reports, immediately. '
      + 'workspace_root defaults to this session\'s workspace; pass a crate or package directory inside it when the code belongs to a subproject.',
    parameters: PARAMETERS,
    timeoutMs: config.timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        switch (value.kind) {
          case 'locations':
            return [{
              type: 'text',
              text: formatLocations(value.locations, value.workspacePath, windows, config.maxLocations, config.maxResultChars),
            }]
          case 'hover':
            return [{ type: 'text', text: formatHover(value.hover, config.maxResultChars) }]
          default:
            return [{ type: 'text', text: formatRename(value.renamedFrom, value.renamedTo, value.files, config.maxResultChars) }]
        }
      },
      presentationMeta: (_args, value) => (value.kind === 'rename'
        ? { operation: 'rename', diffs: renameDiffs(value) }
        : { operation: value.kind }),
    },
    async execute(args, exec) {
      const input = parseToolArgs(args)
      const sessionCwd = exec.agent?.session.header.cwd
      if (sessionCwd === undefined) throw new Error('the lsp_rename tool requires a session workspace cwd')
      const languageId = languageIdFor(config.extensionToLanguage, input.filePath)
      const sessionRoot = await ctx.fs.resolve(sessionCwd, { signal: exec.signal })
      const workspace = await resolveWorkspace(ctx, sessionRoot, sessionCwd, input.workspaceRoot, exec.signal)
      const workspacePath = ctx.fs.processPath(workspace)
      const source = await readSource(ctx, input.filePath, sessionCwd, config, exec.signal)
      const payload = await pool.run(
        workspace,
        workspacePath,
        ctx.fs.fileUrl(workspace),
        input.operation,
        instance => instance.query(
          { operation: input.operation, languageId, position: input.position, newName: input.newName },
          source,
          exec.signal,
        ),
        exec.signal,
      )
      if (input.operation === 'rename') {
        return renameResult(ctx, input, source.uri, payload, { workspaceCwd: workspacePath, windows, exec })
      }
      return input.operation === 'hover'
        ? { kind: 'hover', hover: hoverText(payload) }
        : { kind: 'locations', locations: normalizeLocations(payload), workspacePath }
    },
    presentCall(args) {
      if (args.operation === 'rename') {
        return {
          card: 'diff',
          title: `Rename to ${args.new_name ?? '(no new name)'} at ${args.file_path}:${args.line}`,
          // A call-time view has no post-rename content; the settled view below carries the diffs.
          diffs: [],
          locations: [{ path: args.file_path, line: args.line }],
        }
      }
      return {
        card: 'generic',
        kind: 'search',
        title: `LSP ${args.operation} ${args.file_path}:${args.line}:${args.character}`,
        locations: [{ path: args.file_path, line: args.line }],
      }
    },
    presentResult(args, result) {
      if (result.isError || result.meta?.operation !== 'rename') return undefined
      return {
        card: 'diff',
        title: `Rename to ${args.new_name ?? '(no new name)'} at ${args.file_path}:${args.line}`,
        diffs: result.meta.diffs ?? [],
      }
    },
  }
}

/**
 * Resolve the directory the language server is rooted at: the session workspace, or the root the
 * model asked for.
 *
 * The chosen root must be the session workspace itself or a directory inside it. That is the one
 * boundary this tool keeps: the harness confines a session's writes to its workspace, and a root
 * outside it would run a server — and apply a rename — beyond where the session's own policy
 * reaches. A monorepo needs nothing more: name the crate or package directory, which is inside the
 * workspace.
 * @param ctx - the plugin context.
 * @param sessionRoot - the resolved session workspace.
 * @param sessionCwd - the session workspace as the caller knows it, the base for a relative root.
 * @param requestedRoot - the model's requested root, or `undefined` for the session workspace.
 * @param signal - the call's cancellation.
 * @returns the resolved workspace target.
 * @throws Error when the requested root is missing, is not a directory, or leaves the session
 *   workspace.
 */
async function resolveWorkspace(ctx, sessionRoot, sessionCwd, requestedRoot, signal) {
  if (requestedRoot === undefined) return sessionRoot
  const target = await ctx.fs.resolve(requestedRoot, { cwd: sessionCwd, signal })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined || info.type !== 'directory') {
    throw new Error(`workspace_root "${requestedRoot}" is not a directory`)
  }
  if (!ctx.fs.contains(sessionRoot, target)) {
    throw new Error(
      `workspace_root "${requestedRoot}" is outside this session's workspace (${sessionRoot.displayPath}). `
      + 'Point it at the session workspace or a directory inside it.',
    )
  }
  return target
}

/**
 * The queried document, read through the filesystem seam so the server answers from exactly the
 * bytes a write would replace, and named by the URI the server keys its document on.
 * @param ctx - the plugin context.
 * @param filePath - the model-supplied path.
 * @param cwd - the session workspace, for a relative path.
 * @param config - the resolved plugin configuration.
 * @param signal - the call's cancellation.
 * @returns the document's canonical URI and its complete text.
 * @throws Error when the file exceeds the configured document cap.
 */
async function readSource(ctx, filePath, cwd, config, signal) {
  const target = await ctx.fs.resolve(filePath, { cwd, signal })
  const text = await ctx.fs.readText(target, signal)
  if (Buffer.byteLength(text, 'utf8') > config.maxDocumentBytes) {
    throw new Error(`${filePath} is larger than this plugin opens (limit ${config.maxDocumentBytes} bytes)`)
  }
  return { uri: ctx.fs.fileUrl(target), text }
}

/**
 * Turn one `WorkspaceEdit` into writes on the mounted filesystem, then the tool's own closed result.
 * @param ctx - the plugin context.
 * @param input - the validated tool input, carrying the new identifier.
 * @param sourceUri - the queried document's URI, which identifies the file whose replaced text is
 *   the old identifier.
 * @param payload - the raw `textDocument/rename` result.
 * @param options - the workspace base, the execution world's path rules, and the call's context.
 * @returns the rename result value.
 * @throws Error when the edit is not applicable, or when a write fails after a rollback.
 */
async function renameResult(ctx, input, sourceUri, payload, { workspaceCwd, windows, exec }) {
  const written = await applyRename(ctx.fs, planWorkspaceEdit(payload), {
    cwd: workspaceCwd,
    windows,
    signal: exec.signal,
    policy: resolvePolicy(ctx, exec),
  })
  if (written.length === 0) {
    throw new Error(`renaming to "${input.newName}" produced no change on disk: the server's edits replaced text with itself. Nothing was written.`)
  }
  for (const file of written) {
    ctx.emit('fs/observed', file.target, { kind: 'present', version: file.version }, exec)
  }
  return {
    kind: 'rename',
    // The server does not name the identifier it replaced; the text its own edit displaced is that
    // identifier, and the queried document is where the model's cursor pointed.
    renamedFrom: written.find(file => file.uri === sourceUri)?.replaced ?? written[0]?.replaced ?? '',
    renamedTo: input.newName,
    files: written.map(file => {
      const diff = renameDiff(file.before, file.after, file.span.start, file.span.end)
      return {
        path: file.displayPath,
        edits: file.edits,
        ...(diff === undefined ? {} : { oldText: diff.oldText, newText: diff.newText }),
      }
    }),
  }
}

/**
 * The sandbox policy to stamp on this call's writes: the calling session's standing mode under a
 * confining filesystem, and nothing at all under a bare one. This tool advertises no escalation
 * argument, so a denial is reported to the model, which can reissue the change through `write` or
 * `edit` with an explicit escalation.
 * @param ctx - the plugin context.
 * @param exec - the tool-execution context.
 * @returns the policy to pass to a write, or `undefined` for an unsandboxed backend.
 */
function resolvePolicy(ctx, exec) {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) {
    throw new Error('the mounted filesystem confines writes but ctx.sandboxPolicy is missing')
  }
  return exec.agent === undefined ? undefined : policy.resolve({ session: exec.agent.session })
}

/**
 * The diff entries one applied rename's UI card renders, skipping a file whose change is too large
 * to show — the path is still in the rendered result.
 * @param value - the rename result value.
 * @returns one diff entry per file that has a window.
 */
function renameDiffs(value) {
  const diffs = []
  for (const file of value.files) {
    if (file.oldText === undefined || file.newText === undefined) continue
    diffs.push({ path: file.path, oldText: file.oldText, newText: file.newText })
  }
  return diffs
}
