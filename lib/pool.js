/**
 * The server pool: one language-server process per canonical workspace, reused for the workspace's
 * whole life, with one serialized lane per workspace. The lane is what makes the transient
 * `didOpen`/`didClose` lifecycle safe — two overlapping lifecycles would let one query's `didClose`
 * invalidate the document another is querying. A read-only query whose transport failed is retried
 * once on a fresh process; a rename never is, because its edits may already be on disk.
 * @module dsh-lsp-rename/lib/pool
 */

import { ServerInstance } from './instance.js'

/** The operations whose failure may be retried on a fresh process, being side-effect free. */
const RETRYABLE = new Set(['goToDefinition', 'findReferences', 'goToImplementation', 'hover'])

/**
 * The cancellation error a waiting caller sees.
 * @param signal - the aborted signal.
 * @returns the error to reject with.
 */
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('the query was cancelled')
}

/**
 * A pool of language-server processes, keyed by canonical workspace identity.
 */
export class ServerPool {
  #config
  #executable
  #spawn
  #instances = new Map()
  #lanes = new Map()
  #disposed = false

  /**
   * @param config - the resolved plugin configuration.
   * @param executable - the server executable, already resolved to an absolute path.
   * @param spawn - the subprocess seam's spawn.
   */
  constructor(config, executable, spawn) {
    this.#config = config
    this.#executable = executable
    this.#spawn = spawn
  }

  /**
   * Run one task against this workspace's server, behind any earlier task on the same workspace.
   * The server starts on the first query of a workspace and lives until the plugin unloads.
   * @param workspace - the resolved workspace target, whose `targetKey` identifies the process.
   * @param workspacePath - that target's absolute path in the execution world (the server's cwd).
   * @param workspaceUri - that target's canonical `file:` URI (the server's root).
   * @param operation - the operation about to run, which decides retry eligibility.
   * @param task - receives the live instance to query.
   * @param signal - the calling tool call's cancellation.
   * @returns the task's result.
   * @throws Error when the pool is disposed, the call is cancelled, or the query fails.
   */
  run(workspace, workspacePath, workspaceUri, operation, task, signal) {
    if (this.#disposed) {
      return Promise.reject(new Error('the language server pool was disposed'))
    }
    const key = workspace.targetKey
    const previous = this.#lanes.get(key) ?? Promise.resolve()
    const result = this.#awaitLane(previous, signal).then(() => {
      if (this.#disposed) throw new Error('the language server pool was disposed')
      return this.#attempt(key, workspacePath, workspaceUri, operation, task, signal)
    })
    // The tail follows the real prior work and never rejects, so a later caller serializes without
    // inheriting an earlier failure and a finished lane leaves no residue.
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    this.#lanes.set(key, tail)
    void tail.then(() => {
      if (this.#lanes.get(key) === tail) this.#lanes.delete(key)
    })
    return result
  }

  /**
   * Wait for the previous task on a lane, or fail as soon as this call is cancelled.
   * @param previous - the lane's prior tail, which never rejects.
   * @param signal - the calling tool call's cancellation, or undefined to wait unconditionally.
   * @returns a promise that resolves once the lane is free.
   */
  #awaitLane(previous, signal) {
    if (signal === undefined) return previous
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return new Promise((resolve, reject) => {
      const release = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void previous.then(release, release)
    })
  }

  /**
   * Run one task on this workspace's process, replacing a dead process and retrying a read-only
   * query once when the failure was the transport rather than the server.
   * @param key - the workspace's pool key.
   * @param workspacePath - the workspace's execution-world path.
   * @param workspaceUri - the workspace's canonical URI.
   * @param operation - the operation being run.
   * @param task - receives the live instance to query.
   * @param signal - the calling tool call's cancellation.
   * @returns the task's result.
   */
  async #attempt(key, workspacePath, workspaceUri, operation, task, signal) {
    let instance = this.#instanceFor(key, workspacePath, workspaceUri)
    for (;;) {
      try {
        return await task(instance)
      } catch (error) {
        // A dead process is never reusable, whatever ended its last query.
        if (instance.dead) this.#evict(key, instance)
        if (this.#disposed || !RETRYABLE.has(operation) || !instance.isTransportFailure(error)) throw error
        instance = this.#instanceFor(key, workspacePath, workspaceUri)
      }
    }
  }

  /**
   * Return this workspace's live process, publishing a new one on the first query.
   * @param key - the workspace's pool key.
   * @param workspacePath - the workspace's execution-world path.
   * @param workspaceUri - the workspace's canonical URI.
   * @returns the live instance.
   */
  #instanceFor(key, workspacePath, workspaceUri) {
    const existing = this.#instances.get(key)
    if (existing !== undefined && !existing.dead) return existing
    const spec = {
      command: this.#executable,
      args: this.#config.args,
      cwd: workspacePath,
      env: this.#config.env,
      configuration: this.#config.configuration,
      initializationOptions: this.#config.initializationOptions,
      workspaceUri,
      maxMessageBytes: this.#config.maxMessageBytes,
      maxStderrBytes: this.#config.maxStderrBytes,
      killGraceMs: this.#config.killGraceMs,
      shutdownTimeoutMs: this.#config.shutdownTimeoutMs,
    }
    const created = new ServerInstance(spec, this.#spawn)
    this.#instances.set(key, created)
    return created
  }

  /**
   * Drop a slot only when it still holds this instance, so a replacement that already published
   * itself is not discarded.
   * @param key - the workspace's pool key.
   * @param instance - the instance to drop.
   */
  #evict(key, instance) {
    if (this.#instances.get(key) === instance) this.#instances.delete(key)
  }

  /**
   * Refuse further queries, let the running ones settle, then tear every process down. Teardown
   * failures are reported only after every sibling has settled.
   * @returns a promise that settles when no server process outlives the pool.
   */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    const live = [...this.#instances.values()]
    this.#instances.clear()
    const draining = [...this.#lanes.values()]
    this.#lanes.clear()
    const results = await Promise.allSettled([...live.map(instance => instance.dispose()), ...draining])
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'language server teardown failed')
  }
}
