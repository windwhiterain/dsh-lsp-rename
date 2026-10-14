/**
 * `WorkspaceEdit` application: turning the edit a rename request returned into writes on the mounted
 * filesystem. The plan is built and validated in full before anything is written, and a failed
 * write restores every file already written, so a rename either lands whole or not at all. Positions
 * are converted against the exact text read from disk, so line endings and encoding survive a
 * rename untouched — the file is never re-serialized from parsed lines.
 * @module dsh-lsp-rename/lib/workspace-edit
 */

import { displayPath as renderPath, uriToPath } from './uri.js'

/**
 * One change to one document, in protocol coordinates.
 */
function isTextEdit(value) {
  if (value === null || typeof value !== 'object') return false
  const { range, newText } = value
  if (typeof newText !== 'string' || range === null || typeof range !== 'object') return false
  return isPosition(range.start) && isPosition(range.end)
}

/**
 * A nonnegative integer protocol coordinate.
 * @param value - the candidate position.
 * @returns true when the value is a valid position.
 */
function isPosition(value) {
  if (value === null || typeof value !== 'object') return false
  const { line, character } = value
  return Number.isInteger(line) && line >= 0 && Number.isInteger(character) && character >= 0
}

/**
 * The byte offsets at which each line of one text starts. Built once per file so every position
 * lookup is a direct index rather than a rescan: LSP positions and JavaScript string indices are
 * both UTF-16 code units, so a line start plus a character is the exact offset.
 * @param text - the file's complete text.
 * @returns one start offset per line, always beginning with 0.
 */
export function lineStarts(text) {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

/**
 * Convert one protocol position to a character offset in the given text.
 * @param text - the file's complete text.
 * @param starts - that text's line start offsets.
 * @param position - the zero-based UTF-16 position.
 * @param where - a description of the position, for the rejection message.
 * @returns the character offset.
 * @throws Error when the position names a line or column past the end of the text.
 */
function offsetOf(text, starts, position, where) {
  const start = starts[position.line]
  if (start === undefined) {
    throw new Error(`the language server returned ${where} at line ${position.line + 1}, past the end of the file`)
  }
  const endOfLine = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : text.length
  const offset = start + position.character
  if (offset > endOfLine) {
    throw new Error(`the language server returned ${where} at line ${position.line + 1} column ${position.character + 1}, past the end of that line`)
  }
  return offset
}

/**
 * Apply one file's text edits, which the protocol defines against the document they were computed
 * on: every range is an offset into the original text, so the edits are applied back to front and
 * the offsets ahead of each one stay valid.
 * @param text - the file's complete original text.
 * @param edits - the validated edits for this file.
 * @returns the file's new text.
 * @throws Error when two edits overlap.
 */
export function applyTextEdits(text, edits) {
  const starts = lineStarts(text)
  const resolved = edits.map((edit) => ({
    start: offsetOf(text, starts, edit.range.start, 'a rename edit start'),
    end: offsetOf(text, starts, edit.range.end, 'a rename edit end'),
    newText: edit.newText,
  }))
  resolved.sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index].start < resolved[index - 1].end) {
      throw new Error('the language server returned two overlapping rename edits for one file')
    }
  }
  let result = text
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    const edit = resolved[index]
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end)
  }
  return result
}

/** The file-level operations a `WorkspaceEdit` may carry that this host does not apply. */
const UNSUPPORTED_FILE_OPERATIONS = new Set(['create', 'rename', 'delete'])

/**
 * Thrown when the returned edit is not a set of text edits — either the server declined the rename,
 * or the rename also creates, moves, or deletes a file.
 */
export class WorkspaceEditError extends Error {
  /**
   * @param message - the model-facing reason.
   * @param operations - the file operations that made this rename inapplicable, when it had any.
   */
  constructor(message, operations = []) {
    super(message)
    this.name = 'WorkspaceEditError'
    this.operations = operations
  }
}

/**
 * Build the write plan for one `WorkspaceEdit`, rejecting anything this host will not apply before
 * a single byte is written.
 * @param payload - the raw `textDocument/rename` result.
 * @returns the per-file edit plan, in the order the server listed the files.
 * @throws {WorkspaceEditError} when the server declined the rename, or when the edit carries a
 *   create/rename/delete file operation.
 */
export function planWorkspaceEdit(payload) {
  if (payload === null || payload === undefined) {
    throw new WorkspaceEditError('the language server cannot rename this position: it returned no edits')
  }
  const files = new Map()
  const addEdits = (uri, edits, source) => {
    if (typeof uri !== 'string') throw new WorkspaceEditError(`the language server returned ${source} without a document URI`)
    if (!Array.isArray(edits) || edits.some(edit => !isTextEdit(edit))) {
      throw new WorkspaceEditError(`the language server returned a malformed rename edit for ${uri}`)
    }
    const existing = files.get(uri) ?? []
    existing.push(...edits)
    files.set(uri, existing)
  }
  if (payload.documentChanges !== undefined) {
    if (!Array.isArray(payload.documentChanges)) {
      throw new WorkspaceEditError('the language server returned a malformed documentChanges list')
    }
    const operations = []
    for (const change of payload.documentChanges) {
      if (change === null || typeof change !== 'object') {
        throw new WorkspaceEditError('the language server returned a malformed document change')
      }
      if (change.kind !== undefined) {
        if (!UNSUPPORTED_FILE_OPERATIONS.has(change.kind)) {
          throw new WorkspaceEditError(`the language server returned an unknown document change kind "${String(change.kind)}"`)
        }
        operations.push(change)
        continue
      }
      addEdits(change.textDocument?.uri, change.edits, 'a document change')
    }
    if (operations.length > 0) {
      const described = operations
        .map((change) => `${change.kind} ${typeof change.oldUri === 'string' ? `${change.oldUri} → ${String(change.uri)}` : String(change.uri)}`)
        .join(', ')
      throw new WorkspaceEditError(
        `this rename also changes files on disk (${described}), which this tool will not do: nothing was written. `
        + 'Rename the symbol at a use site inside a file instead, or ask the user to move the file.',
        operations,
      )
    }
  } else if (payload.changes !== undefined) {
    if (payload.changes === null || typeof payload.changes !== 'object' || Array.isArray(payload.changes)) {
      throw new WorkspaceEditError('the language server returned a malformed changes map')
    }
    for (const [uri, edits] of Object.entries(payload.changes)) addEdits(uri, edits, 'a change entry')
  } else {
    throw new WorkspaceEditError('the language server returned neither documentChanges nor changes')
  }
  if (files.size === 0) {
    throw new WorkspaceEditError('the language server returned no edits for this position')
  }
  return [...files.entries()].map(([uri, edits]) => ({ uri, edits }))
}

/**
 * Apply one rename plan through the filesystem seam, and roll back what was written if any file
 * fails. Each write is guarded by the version read with it, so a file that changed underneath the
 * rename is refused instead of being overwritten with a stale edit.
 * @param fs - the filesystem service.
 * @param plan - the per-file edit plan from {@link planWorkspaceEdit}.
 * @param options - the workspace base for relative paths, whether the execution world is Windows,
 *   the cancellation signal, and the sandbox policy to stamp on every write.
 * @returns one entry per written file: its URI, its display path, its target, the version produced,
 *   the text before, the text after, the edit count, the identifier the edits displaced, and the
 *   changed span for the diff card.
 * @throws Error when a file cannot be read, edited, or written, after restoring the files already
 *   written.
 */
export async function applyRename(fs, plan, { cwd, windows, signal, policy }) {
  const written = []
  try {
    for (const file of plan) {
      const path = uriToPath(file.uri, windows)
      if (path === undefined) {
        throw new Error(`the language server wants to edit ${file.uri}, which is not a file this host can write`)
      }
      const target = await fs.resolve(path, { cwd, signal })
      const info = await fs.stat(target, signal)
      if (info === undefined) {
        throw new Error(`the language server wants to edit ${file.uri}, which no longer exists`)
      }
      const before = await fs.readText(target, signal)
      const after = applyTextEdits(before, file.edits)
      if (after === before) continue
      const outcome = await fs.writeText(target, after, { kind: 'replaceIfVersion', version: info.version }, signal, policy)
      written.push({
        uri: file.uri,
        displayPath: renderPath(file.uri, cwd, windows),
        target,
        version: outcome.version,
        before,
        after,
        edits: file.edits.length,
        replaced: replacedText(before, file.edits),
        span: changedSpan(before, file.edits),
      })
    }
  } catch (error) {
    if (written.length === 0) throw error
    try {
      await rollback(fs, written)
    } catch (restoreFailure) {
      throw new AggregateError(
        [error, restoreFailure],
        'the rename failed partway and a file this call had written could not be restored; read the files named in the causes before retrying',
      )
    }
    throw new Error(`${messageOf(error)} Every file this call had already written was restored, so no file is half-renamed.`, { cause: error })
  }
  return written
}

/**
 * The identifier the server's edits displaced: every edit of one rename replaces the same text, so
 * the shortest displaced run is that identifier, whatever order the server listed the edits in.
 * @param before - the file's text before the rename.
 * @param edits - the file's validated edits.
 * @returns the displaced text, or `''` for an insertion with nothing to displace.
 */
function replacedText(before, edits) {
  const starts = lineStarts(before)
  let shortest
  for (const edit of edits) {
    const start = offsetOf(before, starts, edit.range.start, 'a rename edit start')
    const end = offsetOf(before, starts, edit.range.end, 'a rename edit end')
    const text = before.slice(start, end)
    if (shortest === undefined || text.length < shortest.length) shortest = text
  }
  return shortest ?? ''
}

/**
 * The changed span of one file, in the before text, for the diff card's window.
 * @param before - the file's text before the rename.
 * @param edits - the file's validated edits.
 * @returns the changed span as `{ start, end }`.
 */
function changedSpan(before, edits) {
  const starts = lineStarts(before)
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (const edit of edits) {
    const editStart = offsetOf(before, starts, edit.range.start, 'a rename edit start')
    const editEnd = offsetOf(before, starts, edit.range.end, 'a rename edit end')
    start = Math.min(start, editStart)
    end = Math.max(end, editEnd)
  }
  return { start, end }
}

/**
 * Restore the files a failed rename already wrote, from the text read before each write. The
 * cancellation signal is deliberately dropped: a cancelled rename must still leave the workspace as
 * it found it.
 * @param fs - the filesystem service.
 * @param written - the already-written files, newest first.
 * @returns a promise that settles once every restore has been attempted.
 * @throws {AggregateError} when any restore failed, naming each file it could not put back.
 */
async function rollback(fs, written) {
  const failures = []
  for (const file of [...written].reverse()) {
    try {
      await fs.writeText(file.target, file.before)
    } catch (error) {
      failures.push(`${file.target.displayPath}: ${messageOf(error)}`)
    }
  }
  if (failures.length === 0) return
  throw new Error(`these files could not be restored: ${failures.join('; ')}`)
}

/**
 * The message of a thrown value, for composing a message without losing the original as `cause`.
 * @param error - the thrown value.
 * @returns its message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
