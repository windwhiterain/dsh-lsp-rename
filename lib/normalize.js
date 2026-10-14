/**
 * Result normalization: the two read-only operations' server payloads as the closed values the tool
 * declares. Every accessor treats the payload as untrusted wire data — a server that answers with
 * an unexpected shape fails the call with a named reason rather than reaching the model as
 * `undefined`. Pure — no I/O.
 * @module dsh-lsp-rename/lib/normalize
 */

/**
 * A protocol coordinate: a nonnegative integer line and UTF-16 character.
 * @param value - the candidate position.
 * @returns true when the value is a valid position.
 */
function isPosition(value) {
  if (value === null || typeof value !== 'object') return false
  const { line, character } = value
  return Number.isInteger(line) && line >= 0 && Number.isInteger(character) && character >= 0
}

/**
 * A protocol range: two valid positions.
 * @param value - the candidate range.
 * @returns true when the value is a valid range.
 */
function isRange(value) {
  return value !== null && typeof value === 'object' && isPosition(value.start) && isPosition(value.end)
}

/**
 * Whether a record is a `LocationLink`, which carries its target under different keys.
 * @param record - the candidate entry.
 * @returns true when the entry names a target URI and selection range.
 */
function isLocationLink(record) {
  return typeof record.targetUri === 'string' && isRange(record.targetSelectionRange)
}

/**
 * Whether a record is a `Location`.
 * @param record - the candidate entry.
 * @returns true when the entry names a URI and a range.
 */
function isLocation(record) {
  return typeof record.uri === 'string' && isRange(record.range)
}

/**
 * Normalize a navigation result to one entry per resolved location, keeping the start position only:
 * every consumer of this result renders `path:line:character`, and the end position of a definition
 * or a reference is not what a reader needs.
 * @param payload - the raw `textDocument/definition|references|implementation` result.
 * @returns the normalized locations, empty for `null` or `[]`.
 * @throws Error when the payload is missing, non-object, or holds an entry of neither shape.
 */
export function normalizeLocations(payload) {
  if (payload === null) return []
  if (payload === undefined) throw new Error('the language server returned no navigation result')
  const entries = Array.isArray(payload) ? payload : [payload]
  const locations = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('the language server returned a navigation entry that is not an object')
    }
    const record = entry
    if (isLocationLink(record)) {
      locations.push({
        uri: record.targetUri,
        line: record.targetSelectionRange.start.line,
        character: record.targetSelectionRange.start.character,
      })
    } else if (isLocation(record)) {
      locations.push({ uri: record.uri, line: record.range.start.line, character: record.range.start.character })
    } else {
      throw new Error('the language server returned a navigation entry that is neither a Location nor a LocationLink')
    }
  }
  return locations
}

/**
 * Render one `MarkedString`: the string form verbatim, the language-tagged form as a fenced block.
 * @param value - the marked string.
 * @returns its text.
 */
function renderMarkedString(value) {
  if (typeof value === 'string') return value
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

/**
 * Whether an untrusted value is either form of `MarkedString`.
 * @param value - the candidate.
 * @returns true when the value is a MarkedString.
 */
function isMarkedString(value) {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object') return false
  return typeof value.language === 'string' && typeof value.value === 'string'
}

/**
 * Render the three `Hover.contents` encodings into one string.
 * @param contents - the untrusted contents value.
 * @returns the hover text.
 * @throws Error when the value is none of the three encodings.
 */
function renderHoverContents(contents) {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents
      .map((value) => {
        if (!isMarkedString(value)) throw new Error('the language server returned a malformed hover part')
        return renderMarkedString(value)
      })
      .join('\n\n')
  }
  if (contents === null || typeof contents !== 'object') {
    throw new Error('the language server returned hover contents that are not MarkupContent, MarkedString, or an array')
  }
  if (contents.kind === 'markdown' || contents.kind === 'plaintext') {
    if (typeof contents.value !== 'string') throw new Error('the language server returned a hover whose value is not text')
    return contents.value
  }
  if (isMarkedString(contents)) return renderMarkedString(contents)
  throw new Error('the language server returned hover contents that are not MarkupContent, MarkedString, or an array')
}

/**
 * Normalize a `Hover` result to its text.
 * @param payload - the raw `textDocument/hover` result.
 * @returns the hover text, or `null` when the position carries none.
 * @throws Error when the payload is missing or malformed.
 */
export function hoverText(payload) {
  if (payload === null) return null
  if (payload === undefined) throw new Error('the language server returned no hover result')
  if (payload === null || typeof payload !== 'object') {
    throw new Error('the language server returned a hover that is not an object')
  }
  const text = renderHoverContents(payload.contents)
  return text === '' ? null : text
}
