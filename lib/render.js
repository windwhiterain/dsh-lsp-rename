/**
 * Model-facing rendering and UI presentation for the `lsp` tool. Every function is pure and
 * depends only on its arguments, so the same code serves an executing call, a live-streaming
 * presenter, and a session-log replay. No I/O and no configuration.
 * @module dsh-lsp-rename/lib/render
 */

import { displayPath } from './uri.js'

/**
 * Bound a complete rendered result, including the truncation notice itself, so a capped result
 * never exceeds the bound the tool advertised.
 * @param text - the rendered text.
 * @param maxChars - the complete rendered-text bound.
 * @param label - the result kind named in the notice.
 * @returns the text, truncated with a notice when it exceeds the bound.
 */
function bound(text, maxChars, label) {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label} truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/**
 * Render locations grouped by file, each as a one-based `path:line:character` entry.
 * @param locations - the server's locations, already normalized to `uri` plus a start position.
 * @param workspacePath - the workspace root's absolute path in the execution world.
 * @param windows - whether the execution world is Windows.
 * @param maxLocations - the cap before an omission marker is appended.
 * @param maxResultChars - the complete rendered-text bound.
 * @returns the rendered text, or a distinct no-result line.
 */
export function formatLocations(locations, workspacePath, windows, maxLocations, maxResultChars) {
  if (locations.length === 0) return 'No results.'
  const shown = locations.slice(0, maxLocations)
  const omitted = locations.length - shown.length
  const grouped = new Map()
  for (const location of shown) {
    const path = displayPath(location.uri, workspacePath, windows)
    const entries = grouped.get(path) ?? []
    entries.push(`${path}:${location.line + 1}:${location.character + 1}`)
    grouped.set(path, entries)
  }
  const lines = []
  for (const entries of grouped.values()) lines.push(...entries)
  if (omitted > 0) {
    lines.push(`… ${omitted} more location${omitted === 1 ? '' : 's'} omitted (limit ${maxLocations}).`)
  }
  return bound(lines.join('\n'), maxResultChars, 'locations')
}

/**
 * Render one hover result.
 * @param hover - the normalized hover text, or `null` when the position carries none.
 * @param maxResultChars - the complete rendered-text bound.
 * @returns the hover text, or a distinct no-result line.
 */
export function formatHover(hover, maxResultChars) {
  return bound(hover === null ? 'No hover information.' : hover, maxResultChars, 'hover')
}

/**
 * Render one applied rename: the identifier change, then every touched file with its edit count.
 * @param renamedFrom - the identifier the server replaced.
 * @param renamedTo - the identifier the model asked for.
 * @param files - the written files, each a `path` plus an `edits` count.
 * @param maxResultChars - the complete rendered-text bound.
 * @returns the rendered confirmation.
 */
export function formatRename(renamedFrom, renamedTo, files, maxResultChars) {
  const lines = [
    `Renamed ${renamedFrom} → ${renamedTo} in ${files.length} file${files.length === 1 ? '' : 's'}:`,
  ]
  for (const file of files) {
    const edits = file.edits
    lines.push(`${file.path} (${edits} occurrence${edits === 1 ? '' : 's'})`)
  }
  return bound(lines.join('\n'), maxResultChars, 'rename')
}

/**
 * The number of context lines kept on each side of a rename's changed span, so a diff card shows
 * the renamed lines with their surroundings rather than a whole file.
 */
const DIFF_CONTEXT_LINES = 1

/**
 * The largest changed span a diff window may cover before the card falls back to the whole file, and
 * the largest whole file it will show. A rename that touches scattered regions of a large file gets
 * a path-only card entry instead of an unreadable one.
 */
const DIFF_MAX_WINDOW_CHARS = 8000
const DIFF_MAX_FILE_CHARS = 40000

/**
 * Count the line terminators in one window, which is how many lines it spans.
 * @param text - the window text.
 * @returns the number of `\n` occurrences.
 */
function countLines(text) {
  let lines = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines += 1
  return lines
}

/**
 * Build one file's diff pair from its before/after text and the span the edits changed. The window
 * is the changed range widened by {@link DIFF_CONTEXT_LINES} on each side, and it is taken from the
 * after text by LINE COUNT rather than by character offset: a rename may change an identifier's
 * length, so the after text's offsets past the first edit are not the before text's. No edit lies
 * before the window's first line, so that line starts at the same offset in both texts.
 * @param before - the file's text before the rename.
 * @param after - the file's text after the rename.
 * @param start - the first changed character offset in `before`.
 * @param end - the last changed character offset (exclusive) in `before`.
 * @returns the diff pair, or `undefined` when the change is too large to render.
 */
export function renameDiff(before, after, start, end) {
  const lineStart = before.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const lineEndIndex = before.indexOf('\n', end)
  const lineEnd = lineEndIndex === -1 ? before.length : lineEndIndex + 1
  let contextStart = lineStart
  for (let i = 1; i <= DIFF_CONTEXT_LINES; i += 1) {
    if (contextStart === 0) break
    contextStart = before.lastIndexOf('\n', contextStart - 2) + 1
  }
  let contextEnd = lineEnd
  for (let i = 1; i <= DIFF_CONTEXT_LINES; i += 1) {
    if (contextEnd >= before.length) break
    const next = before.indexOf('\n', contextEnd)
    if (next === -1) {
      contextEnd = before.length
      break
    }
    contextEnd = next + 1
  }
  const beforeWindow = before.slice(contextStart, contextEnd)
  if (beforeWindow.length <= DIFF_MAX_WINDOW_CHARS) {
    return { oldText: beforeWindow, newText: afterWindow(after, contextStart, countLines(beforeWindow)) }
  }
  if (before.length <= DIFF_MAX_FILE_CHARS && after.length <= DIFF_MAX_FILE_CHARS) {
    return { oldText: before, newText: after }
  }
  return undefined
}

/**
 * Take the same number of complete lines from the after text, starting at an offset that no edit
 * has moved.
 * @param after - the file's text after the rename.
 * @param start - the window's first character offset, identical in both texts.
 * @param lines - the line count to take.
 * @returns the window text, ending at a line boundary.
 */
function afterWindow(after, start, lines) {
  let cursor = start
  for (let remaining = lines; remaining > 0; remaining -= 1) {
    const next = after.indexOf('\n', cursor)
    if (next === -1) return after.slice(start)
    cursor = next + 1
  }
  const end = after.indexOf('\n', cursor)
  return after.slice(start, end === -1 ? after.length : end + 1)
}
