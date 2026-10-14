/**
 * `file:` URI conversion for one execution world. The language server, the filesystem provider, and
 * the harness host can each be a different platform, so every conversion here takes the execution
 * platform explicitly and never reads the harness host's own rules. Pure — no I/O.
 * @module dsh-lsp-rename/lib/uri
 */

import { fileURLToPath } from 'node:url'
import { posix, win32 } from 'node:path'

/**
 * The path module for one execution world.
 * @param windows - whether the execution world is Windows.
 * @returns the matching `node:path` implementation.
 */
function pathModule(windows) {
  return windows ? win32 : posix
}

/**
 * Convert a `file:` URI to an absolute path in the execution world. A URI that is not `file:`, or
 * whose encoding this platform rejects, yields `undefined` so the caller reports the server's
 * verbatim URI instead of guessing at a path.
 * @param uri - the URI from the server.
 * @param windows - whether the execution world is Windows.
 * @returns the absolute path, or `undefined` when the URI is not a usable `file:` URI.
 */
export function uriToPath(uri, windows) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return undefined
  let url
  try {
    url = new URL(uri)
  } catch {
    return undefined
  }
  try {
    const path = fileURLToPath(url, { windows })
    // A NUL cannot name a file, and a path carrying one would reach the filesystem provider.
    return path.includes('\0') ? undefined : path
  } catch {
    return undefined
  }
}

/**
 * Render one server URI for the model: workspace-relative when the target is under the workspace
 * path, an absolute path otherwise, and the verbatim URI when it is not a `file:` URI or falls in
 * neither world. Separator style is always `/`, so a Windows path reads the same as a POSIX one.
 * @param uri - the target URI from the server.
 * @param workspacePath - the workspace root's absolute path in the execution world.
 * @param windows - whether the execution world is Windows.
 * @returns the display path or the verbatim URI.
 */
export function displayPath(uri, workspacePath, windows) {
  const targetPath = uriToPath(uri, windows)
  if (targetPath === undefined) return uri
  const path = pathModule(windows)
  const relative = path.relative(workspacePath, targetPath)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  const rendered = relative === '' ? '.' : outside ? targetPath : relative
  return windows ? rendered.replaceAll('\\', '/') : rendered
}
