/**
 * Model-facing argument vocabulary for the `lsp` tool: the five operations this plugin serves, the
 * one-based cursor validation, and the rule that only `rename` takes a new identifier. Pure — no
 * I/O, no configuration, so the same parse serves an executing call and a replayed one.
 * @module dsh-lsp-rename/lib/args
 */

/** The operations this tool serves, in schema-enum order. */
export const OPERATIONS = Object.freeze(['goToDefinition', 'findReferences', 'goToImplementation', 'hover', 'rename'])

/** The one operation that writes to the workspace. */
const RENAME = 'rename'

/**
 * Test one raw argument against the operation vocabulary.
 * @param value - the raw `operation`.
 * @returns true when the value names a served operation.
 */
function isOperation(value) {
  return OPERATIONS.includes(value)
}

/**
 * Validate a one-based coordinate is a positive integer.
 * @param value - the raw coordinate.
 * @param name - the coordinate's field name.
 * @returns the validated integer.
 * @throws Error when the coordinate is not a positive integer.
 */
function oneBased(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (one-based)`)
  }
  return value
}

/**
 * Validate the replacement identifier of a rename. The server decides whether a name is legal for
 * the language; this check refuses only what could not be applied as a single-range text edit.
 * @param value - the raw `new_name`.
 * @returns the validated identifier.
 * @throws Error when the identifier is empty or spans lines.
 */
function newNameOf(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('new_name is required for operation "rename" and must be a non-empty identifier')
  }
  if (/[\r\n]/u.test(value)) {
    throw new Error('new_name must be a single-line identifier')
  }
  return value
}

/**
 * Validate one-based cursor coordinates and convert them to the protocol's zero-based position.
 * @param args - the raw `line`/`character`.
 * @returns the zero-based UTF-16 position.
 * @throws Error when a coordinate is not a positive integer.
 */
export function positionOf(args) {
  return { line: oneBased(args.line, 'line') - 1, character: oneBased(args.character, 'character') - 1 }
}

/**
 * Validate the optional workspace root. The session's own workspace is the default and the common
 * case, so this only refuses a value that is present and unusable.
 * @param value - the raw `workspace_root`, if the model supplied one.
 * @returns the requested root, or `undefined` to use the session workspace.
 * @throws Error when a supplied root is blank.
 */
function workspaceRootOf(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('workspace_root must be a non-empty directory path when supplied')
  }
  return value
}

/**
 * Validate and convert model arguments: `operation` must be one of the five; `line`/`character` are
 * positive one-based integers converted to the protocol's zero-based position; `rename` requires
 * `new_name` and the other four ignore it; `workspace_root` overrides the session workspace the
 * server is rooted at.
 * @param args - the schema-validated raw arguments.
 * @returns the validated input with a zero-based position.
 * @throws Error when the operation is unknown, a coordinate is not a positive integer, a rename
 *   carries no usable identifier, or a supplied workspace root is blank.
 */
export function parseToolArgs(args) {
  if (!isOperation(args.operation)) {
    throw new Error(`operation must be one of ${OPERATIONS.join(', ')}`)
  }
  if (typeof args.file_path !== 'string' || args.file_path.trim() === '') {
    throw new Error('file_path must be a non-empty string')
  }
  return {
    operation: args.operation,
    filePath: args.file_path,
    position: positionOf(args),
    newName: args.operation === RENAME ? newNameOf(args.new_name) : undefined,
    workspaceRoot: workspaceRootOf(args.workspace_root),
  }
}

/**
 * Extract a file's final extension as a lowercase, leading-dot key, the form the configuration's
 * `extensionToLanguage` map is keyed by. Returns `''` for a name with no extension or a dotfile
 * (`.bashrc`), which no route matches.
 * @param filePath - the source path to inspect.
 * @returns the extension key, or `''` when there is none.
 */
export function extensionOf(filePath) {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
  const dot = base.lastIndexOf('.')
  // dot <= 0 covers both "no dot" (-1) and a leading-dot dotfile (0): neither has an extension.
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/**
 * Select the language id configured for a path, refusing a query this server does not own. A
 * refused query must not start a server: one workspace keeps exactly one language-server process
 * for whichever language configured it.
 * @param extensionToLanguage - the configured extension map.
 * @param filePath - the queried source path.
 * @returns the configured language id.
 * @throws Error when no configured extension matches the path.
 */
export function languageIdFor(extensionToLanguage, filePath) {
  const extension = extensionOf(filePath)
  const languageId = extensionToLanguage[extension]
  if (languageId === undefined) {
    throw new Error(
      `no language server is configured for "${filePath}" (extension ${extension === '' ? '(none)' : extension}); `
      + `this plugin serves ${Object.keys(extensionToLanguage).join(', ')}`,
    )
  }
  return languageId
}
