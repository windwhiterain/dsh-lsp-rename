/**
 * One initialized language-server process, serving one workspace. The instance owns the
 * `initialize` handshake, the transient `didOpen` → request → `didClose` lifecycle that lets the
 * server answer from the bytes on disk, the capability check each operation runs against the
 * server's own advertised set, and bounded teardown. A workspace keeps one instance for its whole
 * life, so a second query reuses the indexed state instead of paying the cold index again.
 * @module dsh-lsp-rename/lib/instance
 */

import { setTimeout as delay } from 'node:timers/promises'
import { LspConnection } from './connection.js'

/** The `textDocument/*` request method for each served operation. */
const REQUEST_METHOD = Object.freeze({
  goToDefinition: 'textDocument/definition',
  findReferences: 'textDocument/references',
  goToImplementation: 'textDocument/implementation',
  hover: 'textDocument/hover',
  rename: 'textDocument/rename',
})

/** The `ServerCapabilities` provider field backing each served operation. */
const CAPABILITY_FIELD = Object.freeze({
  goToDefinition: 'definitionProvider',
  findReferences: 'referencesProvider',
  goToImplementation: 'implementationProvider',
  hover: 'hoverProvider',
  rename: 'renameProvider',
})

/**
 * The client capabilities this host advertises: UTF-16 positions, workspace folders and
 * configuration, transient document synchronization, rename, and the `documentChanges` form of a
 * workspace edit. No dynamic registration — the server's returned capabilities are authoritative.
 */
const CLIENT_CAPABILITIES = Object.freeze({
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true, applyEdit: false },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    rename: { prepareSupport: true },
  },
})

/** How often the cancel grace re-checks whether the server honored `$/cancelRequest`. */
const CANCEL_POLL_MS = 25

/**
 * A provider capability is present when the server sent `true` or an options object; `false`, `null`,
 * and an absent field all mean unsupported.
 * @param value - the advertised capability.
 * @returns true when the operation that field backs may be requested.
 */
function supports(value) {
  return value !== undefined && value !== false && value !== null
}

/**
 * Whether `textDocumentSync` permits the transient `didOpen`/`didClose` this host relies on. The
 * legacy enum form implies open/close for Full and Incremental; the options form requires an
 * explicit `openClose: true`, because the protocol defaults an omitted one to false.
 * @param sync - the advertised synchronization capability.
 * @returns true when transient open/close is supported.
 */
function supportsTransientOpen(sync) {
  if (sync === undefined) return false
  if (typeof sync === 'number') return sync === 1 || sync === 2
  return sync.openClose === true
}

/**
 * The cancellation error a caller sees, carrying the signal's own reason when it has one.
 * @param signal - the aborted signal.
 * @returns the error to throw.
 */
function abortError(signal) {
  const reason = signal.reason
  return reason instanceof Error ? reason : new Error('the language server query was cancelled')
}

/**
 * Await one promise, or fail as soon as the signal aborts.
 * @param promise - the promise to await.
 * @param signal - the cancellation signal, or undefined to wait unconditionally.
 * @returns the promise's value.
 * @throws the signal's reason when the signal aborts first.
 */
async function abortable(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) throw abortError(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * Race one request against cancellation. On abort the request is cancelled and then given a bounded
 * grace to be acknowledged; a server that ignores it has its process range terminated, so a request
 * still running cannot overlap the next query's document lifecycle.
 * @param send - the in-flight request.
 * @param requestId - its id, for `$/cancelRequest`.
 * @param signal - the cancellation signal.
 * @param connection - the connection to cancel on and terminate.
 * @param graceMs - the acknowledgement budget.
 * @returns the request's result.
 * @throws the cancellation error, after the grace.
 */
async function raceCancel(send, requestId, signal, connection, graceMs) {
  try {
    return await abortable(send, signal)
  } catch (error) {
    if (!signal.aborted) throw error
    connection.cancel(requestId)
    let settled = false
    void send.then(() => { settled = true }, () => { settled = true })
    const deadline = Date.now() + graceMs
    while (!settled) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await delay(Math.min(CANCEL_POLL_MS, remaining))
    }
    if (!settled) connection.terminate()
    throw error
  }
}

/**
 * A single initialized server process, not a pool member: the pool owns reuse and serialization.
 */
export class ServerInstance {
  #connection
  #capabilities
  #killGraceMs
  #shutdownTimeoutMs
  #disposed = false
  #teardown
  #ready

  /**
   * @param spec - the launch, workspace, and teardown parameters.
   * @param spawn - the subprocess seam's spawn.
   */
  constructor(spec, spawn) {
    this.#killGraceMs = spec.killGraceMs
    this.#shutdownTimeoutMs = spec.shutdownTimeoutMs
    this.#connection = new LspConnection(spec, spawn)
    this.#ready = this.#initialize(spec)
    // A handshake rejection must not surface as an unhandled rejection before the first query
    // awaits it; the query attaches the real handler.
    this.#ready.catch(() => {})
  }

  /**
   * @returns the server's own advertised capabilities, for a diagnostic in a failed query.
   */
  get capabilities() {
    return this.#capabilities
  }

  /**
   * @returns whether this process can no longer serve a query, answered without awaiting.
   */
  get dead() {
    return this.#disposed || this.#connection.failed
  }

  /**
   * Test whether a caught query error came from this instance's transport, the one failure a
   * read-only query may transparently retry on a fresh process.
   * @param error - the error caught by the caller.
   * @returns true only when the connection produced that exact failure.
   */
  isTransportFailure(error) {
    return this.#connection.failedWith(error)
  }

  /**
   * Run one query through the transient document lifecycle.
   * @param query - the prepared request: operation, language id, zero-based position, and, for a
   *   rename, the new identifier.
   * @param source - the document's canonical URI and its current text, read by the caller.
   * @param signal - cancellation for this query's whole lifecycle.
   * @returns the server's raw result payload, unvalidated.
   * @throws Error when the server does not advertise the operation, does not permit transient open,
   *   the query is cancelled, or the transport fails.
   */
  async query(query, source, signal) {
    if (this.#disposed) throw new Error('the language server for this workspace was disposed')
    if (signal?.aborted === true) throw abortError(signal)
    await abortable(this.#ready, signal)
    const capabilities = this.#capabilities
    if (capabilities === undefined) throw new Error('the language server is not initialized')
    if (!supports(capabilities[CAPABILITY_FIELD[query.operation]])) {
      throw new Error(`the language server does not support ${query.operation}`)
    }
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new Error('the language server does not support the transient document open this host requires')
    }
    let opened = false
    try {
      await abortable(this.#connection.notify('textDocument/didOpen', {
        textDocument: { uri: source.uri, languageId: query.languageId, version: 1, text: source.text },
      }), signal)
      opened = true
      return await this.#sendRequest(query, source.uri, signal)
    } finally {
      // A torn-down instance is already closing its process; a didClose would race that teardown and
      // let a cancelled request overlap the next query's document lifecycle.
      if (opened && !this.dead) {
        try {
          await this.#connection.notify('textDocument/didClose', { textDocument: { uri: source.uri } })
        } catch {
          // A close-write failure does not replace the settled outcome, but the transport can no
          // longer be trusted, so the instance reports itself dead and the pool replaces it.
          this.#disposed = true
        }
      }
    }
  }

  /**
   * Reject further work, attempt a graceful `shutdown`/`exit` within its budget, then terminate the
   * managed process range and await its quiescence. A second call awaits the same teardown.
   * @returns the shared teardown result.
   */
  dispose() {
    this.#disposed = true
    this.#teardown ??= this.#tearDown()
    return this.#teardown
  }

  async #initialize(spec) {
    const result = await this.#connection.request('initialize', {
      // The subprocess may run in another PID namespace; the harness host's pid would let the
      // server monitor an unrelated process.
      processId: null,
      rootUri: spec.workspaceUri,
      workspaceFolders: [{ uri: spec.workspaceUri, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: spec.initializationOptions,
    })
    const capabilities = result?.capabilities
    if (capabilities === null || typeof capabilities !== 'object') {
      throw new Error(`the language server returned no capabilities${this.#diagnostic()}`)
    }
    const encoding = capabilities.positionEncoding
    // An omitted encoding defaults to utf-16, which is the encoding every position here is.
    if (encoding !== undefined && encoding !== 'utf-16') {
      throw new Error(`the language server negotiated unsupported position encoding "${String(encoding)}"; this host requires utf-16`)
    }
    this.#capabilities = capabilities
    await this.#connection.notify('initialized', {})
  }

  async #sendRequest(query, uri, signal) {
    const params = {
      textDocument: { uri },
      position: { line: query.position.line, character: query.position.character },
      // findReferences always includes declarations: the model gets no flag, and impact analysis
      // never omits the defining site.
      ...(query.operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
      ...(query.operation === 'rename' ? { newName: query.newName } : {}),
    }
    const requestId = this.#connection.peekNextId()
    const send = this.#connection.request(REQUEST_METHOD[query.operation], params)
    if (signal === undefined) return send
    return raceCancel(send, requestId, signal, this.#connection, this.#killGraceMs)
  }

  async #tearDown() {
    const deadline = AbortSignal.timeout(this.#shutdownTimeoutMs)
    try {
      await abortable(this.#connection.request('shutdown', null), deadline.signal)
      await this.#connection.notify('exit', null)
      await abortable(this.#connection.closed, deadline.signal)
    } catch {
      // A server that ignores shutdown is escalated below, which is what teardown owes callers.
    }
    this.#connection.terminate()
    // Unbounded on purpose: quiescence, not another timer, is the postcondition disposal owes.
    await Promise.all([this.#connection.closed, this.#connection.waitForExit()])
  }

  #diagnostic() {
    const tail = this.#connection.stderrTail
    return tail === '' ? '' : `; stderr: ${tail}`
  }
}
