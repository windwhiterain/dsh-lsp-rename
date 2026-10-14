/**
 * One language server, spoken to over JSON-RPC on the subprocess seam. This module owns message
 * framing, request/response correlation, the retained stderr tail, and bounded teardown; it knows
 * nothing about language-server operations. The server process is spawned through
 * `ctx.subprocess`, so it lives in the same execution world as the filesystem provider.
 * @module dsh-lsp-rename/lib/connection
 */

/** One framed message, per the base protocol: `Content-Length` in bytes, then the JSON body. */
const HEADER_SEPARATOR = '\r\n\r\n'

/** Server→client request methods answered with an empty result (no dynamic registration here). */
const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

/**
 * Frame one JSON-RPC message for the wire.
 * @param message - the message to send.
 * @returns the framed bytes.
 */
export function encodeMessage(message) {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}${HEADER_SEPARATOR}${body}`
}

/**
 * An incremental `Content-Length` frame decoder over a byte stream. A framing or JSON failure is
 * fatal by design: the stream position is unrecoverable once a frame is misread, so the caller
 * terminates the server rather than desynchronizing every later message.
 */
export class MessageDecoder {
  /**
   * @param maxBytes - the largest single framed body accepted.
   */
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.buffer = Buffer.alloc(0)
  }

  /**
   * Feed one stdout chunk and take every complete frame it produced.
   * @param chunk - the raw bytes read from the server's stdout.
   * @returns the decoded messages, in arrival order.
   * @throws Error when the chunk overflows the frame cap, the headers are malformed, or a body is
   *   not JSON.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages = []
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR)
      if (headerEnd === -1) {
        if (this.buffer.length > this.maxBytes) throw new Error(`language server sent a header over the ${this.maxBytes} byte frame cap`)
        return messages
      }
      const length = contentLength(this.buffer.subarray(0, headerEnd).toString('utf8'))
      const bodyStart = headerEnd + HEADER_SEPARATOR.length
      if (length > this.maxBytes) throw new Error(`language server announced a ${length} byte body over the ${this.maxBytes} byte frame cap`)
      if (this.buffer.length < bodyStart + length) return messages
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + length)
      try {
        messages.push(JSON.parse(body))
      } catch {
        throw new Error('language server sent a frame whose body is not JSON')
      }
    }
  }
}

/**
 * Read the `Content-Length` value out of one frame's header block.
 * @param header - the header text, without the terminating blank line.
 * @returns the announced body length in bytes.
 * @throws Error when the header carries no usable `Content-Length`.
 */
function contentLength(header) {
  for (const line of header.split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') continue
    const value = Number.parseInt(line.slice(separator + 1).trim(), 10)
    if (Number.isInteger(value) && value >= 0) return value
    throw new Error('language server sent a malformed Content-Length header')
  }
  throw new Error('language server sent a frame without a Content-Length header')
}

/**
 * A live JSON-RPC endpoint bound to one server process.
 */
export class LspConnection {
  #pending = new Map()
  #nextId = 1
  #closeReason = undefined
  #decoder
  #stdin
  #handle
  #configuration

  /**
   * @param spec - how to launch the server and answer its configuration requests.
   * @param spawn - the subprocess seam's spawn, which returns the managed handle.
   */
  constructor(spec, spawn) {
    this.#decoder = new MessageDecoder(spec.maxMessageBytes)
    this.#configuration = spec.configuration
    const handle = spawn({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: spec.maxStderrBytes } },
      graceMs: spec.killGraceMs,
      env: spec.env,
    })
    if (handle.stdin === undefined || handle.stdout === undefined) {
      throw new Error('lsp-rename: the subprocess provider dropped a piped protocol stream')
    }
    this.#stdin = handle.stdin
    this.#handle = handle
    this.closed = new Promise((resolve) => {
      const settle = () => {
        this.#closeReason ??= new Error(this.#exitMessage())
        this.#failAllPending(this.#closeReason)
        resolve()
      }
      handle.done.then(settle, (error) => {
        // A spawn-level failure produces no close event; the rejection is both the fatal cause and
        // the close boundary.
        this.#fail(new Error(String(error)))
        settle()
      })
    })
    this.#stdin.on('error', (error) => { this.#fail(error) })
    handle.stdout.on('data', (chunk) => { this.#onStdout(chunk) })
  }

  /**
   * @returns the retained stderr tail, for a diagnostic on a server that failed to start.
   */
  get stderrTail() {
    return this.#handle.collected.stderr?.readFrom(0).text.trim() ?? ''
  }

  /**
   * @returns whether the transport has failed, even if the close event has not arrived yet.
   */
  get failed() {
    return this.#closeReason !== undefined
  }

  /**
   * Test whether a caught error is this connection's retained fatal transport cause.
   * @param error - the error caught by the caller.
   * @returns true only when this connection produced that exact failure.
   */
  failedWith(error) {
    return this.#closeReason === error
  }

  /**
   * Send a request and await its result.
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @returns the response result; rejects on an error response, a write failure, or a close.
   */
  request(method, params) {
    const id = this.#nextId
    this.#nextId += 1
    const result = new Promise((resolve, reject) => {
      if (this.#closeReason !== undefined) {
        reject(this.#closeReason)
        return
      }
      this.#pending.set(id, { resolve, reject })
      // A write failure is recorded on the connection and rejects every pending request, so this
      // handler only has to consume its own write promise.
      void this.#write({ jsonrpc: '2.0', id, method, params }).catch(() => {})
    })
    // A caller that stops awaiting (an aborted query) leaves this promise to reject later, on close.
    // The handler keeps that from surfacing as an unhandled rejection; the caller's own await
    // still receives the rejection.
    result.catch(() => {})
    return result
  }

  /**
   * Send a notification, which carries no id and expects no response.
   * @param method - the JSON-RPC method.
   * @param params - the notification params.
   * @returns a promise that settles once the frame is written.
   */
  notify(method, params) {
    return this.#write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Ask the server to abandon an in-flight request. Best-effort: the server that ignores it is
   * torn down by the caller's cancel grace instead.
   * @param requestId - the id of the request to cancel.
   */
  cancel(requestId) {
    void this.#write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } }).catch(() => {})
  }

  /**
   * @returns the id the next {@link request} will use, so a caller can pre-arm a cancel.
   */
  peekNextId() {
    return this.#nextId
  }

  /**
   * Terminate the server's managed process range. Idempotent.
   */
  terminate() {
    this.#handle.terminate()
  }

  /**
   * Wait until the owned process range is empty.
   * @param signal - optional bound for the wait.
   * @returns true when the range emptied, or false when the signal aborted first.
   */
  async waitForExit(signal) {
    if (signal === undefined) return this.#handle.waitForExit()
    if (signal.aborted) return false
    return new Promise((resolve) => {
      const settle = (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => { settle(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.#handle.waitForExit(signal).then((value) => { settle(value) }, () => { settle(false) })
    })
  }

  #onStdout(chunk) {
    let messages
    try {
      messages = this.#decoder.push(chunk)
    } catch (error) {
      // The stream is desynchronized: fail the connection and terminate the range so a helper
      // process cannot outlive the server.
      this.#fail(error)
      this.#handle.terminate()
      return
    }
    for (const message of messages) this.#dispatch(message)
  }

  #dispatch(message) {
    if (message === null || typeof message !== 'object') return
    const { id, method, result, error, params } = message
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      void this.#answerServerRequest(id, method, params)
      return
    }
    if (typeof method === 'string') return // A server notification (diagnostics, logs): unused.
    if (typeof id !== 'number') return
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    if (error !== null && error !== undefined) {
      pending.reject(new Error(typeof error.message === 'string' ? error.message : 'the language server returned an error'))
      return
    }
    pending.resolve(result)
  }

  async #answerServerRequest(id, method, params) {
    try {
      await this.#write({ jsonrpc: '2.0', id, result: await this.#serverResult(method, params) })
    } catch {
      // The connection already failed and every pending request rejected; the error response is
      // best-effort bookkeeping on a dead stream.
    }
  }

  #serverResult(method, params) {
    if (method === 'workspace/configuration') {
      const items = Array.isArray(params?.items) ? params.items : []
      // The configured answer is one static value, repeated for every requested item.
      return items.map(() => this.#configuration)
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) return null
    if (method === 'workspace/applyEdit') {
      // This host applies the edits itself, from the WorkspaceEdit the rename request returned.
      return Promise.reject(new Error('workspace/applyEdit is not used by this host; the rename tool applies the returned WorkspaceEdit'))
    }
    return Promise.reject(new Error(`the language server made an unsupported request: ${method}`))
  }

  #write(message) {
    if (this.#closeReason !== undefined) return Promise.reject(this.#closeReason)
    return new Promise((resolve, reject) => {
      try {
        this.#stdin.write(encodeMessage(message), (error) => {
          if (error === undefined || error === null) {
            resolve()
            return
          }
          this.#fail(error)
          reject(error)
        })
      } catch (error) {
        // Node delivers write failures through the callback; a conforming Writable never throws.
        this.#fail(error)
        reject(error)
      }
    })
  }

  #exitMessage() {
    const tail = this.stderrTail
    return tail === '' ? 'the language server exited' : `the language server exited; stderr: ${tail}`
  }

  #fail(error) {
    this.#closeReason ??= error
    this.#failAllPending(this.#closeReason)
  }

  #failAllPending(error) {
    const waiting = [...this.#pending.values()]
    this.#pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}
