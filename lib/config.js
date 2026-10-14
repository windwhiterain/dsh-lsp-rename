/**
 * Configuration normalization for `dsh-lsp-rename`.
 *
 * Every field is optional except the language server command and its extension map, and every bound
 * is validated at load: a deployment that writes a bound the plugin cannot honour fails at plugin
 * activation with an actionable message instead of failing on the first query. {@link Config} adapts
 * {@link normalizeConfig} to the Standard Schema contract the Cordis Loader validates plugin config
 * with.
 *
 * @module dsh-lsp-rename/lib/config
 */

/** Node's maximum timer delay, the ceiling every millisecond field must respect. */
export const MAX_TIMER_DELAY_MS = 2147483647

/** Documented defaults for every configuration field. */
export const DEFAULT_CONFIG = Object.freeze({
  args: Object.freeze([]),
  env: Object.freeze({}),
  initializationOptions: null,
  configuration: null,
  timeoutMs: 180000,
  maxLocations: 100,
  maxResultChars: 16000,
  maxMessageBytes: 16000000,
  maxStderrBytes: 1000000,
  maxDocumentBytes: 4000000,
  shutdownTimeoutMs: 5000,
  killGraceMs: 2000,
})

/** Inclusive integer bounds per field. */
const BOUNDS = Object.freeze({
  timeoutMs: Object.freeze([1000, MAX_TIMER_DELAY_MS]),
  maxLocations: Object.freeze([1, 10000]),
  maxResultChars: Object.freeze([200, 1000000]),
  maxMessageBytes: Object.freeze([1024, 268435456]),
  maxStderrBytes: Object.freeze([0, 67108864]),
  maxDocumentBytes: Object.freeze([1, 67108864]),
  shutdownTimeoutMs: Object.freeze([1, MAX_TIMER_DELAY_MS]),
  killGraceMs: Object.freeze([1, MAX_TIMER_DELAY_MS]),
})

/** The fields a configuration may set, excluding the two required ones. */
const OPTIONAL_FIELDS = Object.freeze([
  'args',
  'env',
  'initializationOptions',
  'configuration',
  ...Object.keys(BOUNDS),
])

/** Thrown when configuration cannot be normalized; carries one issue per problem. */
export class ConfigError extends Error {
  /**
   * @param issues - every configuration problem found.
   */
  constructor(issues) {
    super(`lsp-rename: invalid configuration:\n${issues.map(issue => `  - ${issue}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/**
 * Report one integer field's bounds for the rejection message.
 * @param name - the field name.
 * @returns the human-readable bound clause.
 */
function boundText(name) {
  const [minimum, maximum] = BOUNDS[name]
  return `an integer between ${minimum} and ${maximum}`
}

/**
 * Validate the string→string map a server entry carries (arguments' sibling: environment overrides
 * or the extension map).
 * @param value - the raw field.
 * @param field - the field name, for the issue message.
 * @param issues - the issue sink, appended to in place.
 * @param keyCheck - accepts one key, returning false for a malformed one.
 * @returns true when the value is a usable map.
 */
function checkStringMap(value, field, issues, keyCheck) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ message: `${field} must be an object` })
    return false
  }
  let valid = true
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push({ message: `${field}["${key}"] must be a non-empty string` })
      valid = false
    } else if (!keyCheck(key)) {
      issues.push({ message: `${field} key "${key}" is malformed` })
      valid = false
    }
  }
  return valid
}

/**
 * Validate one raw configuration value and report value defects.
 * @param raw - the row's configuration, absent when the row declares none.
 * @returns either the normalized configuration or every issue found.
 */
function validate(raw) {
  if (raw === undefined || raw === null) {
    return { issues: [{ message: 'command and extensionToLanguage are required' }] }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'configuration must be an object' }] }
  }
  const issues = []
  const value = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(raw)) {
    if (key !== 'command' && key !== 'extensionToLanguage' && !OPTIONAL_FIELDS.includes(key)) {
      issues.push({ message: `unknown configuration field "${key}" (known fields: command, extensionToLanguage, ${OPTIONAL_FIELDS.join(', ')})` })
    }
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    issues.push({ message: 'command must be a non-empty string (an absolute path, or a bare name resolved on PATH at load)' })
  } else {
    value.command = raw.command
  }
  if (raw.extensionToLanguage === undefined) {
    issues.push({ message: 'extensionToLanguage is required (for example {".rs": "rust"})' })
  } else if (checkStringMap(raw.extensionToLanguage, 'extensionToLanguage', issues, () => true)) {
    const entries = new Map()
    for (const [key, languageId] of Object.entries(raw.extensionToLanguage)) {
      // Normalize the way the harness's own seam does: lowercase, with a leading dot added when
      // the key omits it, so `{rs: rust}` and `{'.RS': rust}` are the same route.
      const extension = key.startsWith('.') ? key.toLowerCase() : `.${key.toLowerCase()}`
      if (!EXTENSION_PATTERN.test(extension)) {
        issues.push({ message: `extensionToLanguage key "${key}" is not a file extension` })
        continue
      }
      if (entries.has(extension)) {
        issues.push({ message: `extensionToLanguage maps ${extension} more than once` })
        continue
      }
      entries.set(extension, languageId)
    }
    if (entries.size === 0) {
      issues.push({ message: 'extensionToLanguage must map at least one extension' })
    } else {
      value.extensionToLanguage = Object.freeze(Object.fromEntries(entries))
    }
  }
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some(entry => typeof entry !== 'string')) {
      issues.push({ message: 'args must be an array of strings' })
    } else {
      value.args = Object.freeze([...raw.args])
    }
  }
  if (raw.env !== undefined) {
    if (checkStringMap(raw.env, 'env', issues, () => true)) {
      value.env = Object.freeze({ ...raw.env })
    }
  }
  for (const name of Object.keys(BOUNDS)) {
    const provided = raw[name]
    if (provided === undefined) continue
    const [minimum, maximum] = BOUNDS[name]
    if (!Number.isInteger(provided) || provided < minimum || provided > maximum) {
      issues.push({ message: `${name} must be ${boundText(name)} (got ${JSON.stringify(provided)})` })
      continue
    }
    value[name] = provided
  }
  if (raw.initializationOptions !== undefined) value.initializationOptions = raw.initializationOptions
  if (raw.configuration !== undefined) value.configuration = raw.configuration
  return issues.length === 0 ? { value: Object.freeze(value) } : { issues }
}

/** A well-formed extension key: a leading dot and one or more non-dot, non-separator characters. */
const EXTENSION_PATTERN = /^\.[^./\\]+$/

/**
 * Normalize one row's configuration, failing loud on any defect.
 * @param raw - the row's configuration.
 * @returns the frozen normalized configuration.
 * @throws {ConfigError} when a field is missing, unknown, or out of range.
 */
export function normalizeConfig(raw) {
  const result = validate(raw)
  if (result.issues !== undefined) {
    throw new ConfigError(result.issues.map(issue => issue.message))
  }
  return result.value
}

/**
 * Standard Schema adapter over {@link normalizeConfig}, consumed by the Loader through
 * `Config['~standard'].validate`.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-lsp-rename',
    validate,
  }),
})
