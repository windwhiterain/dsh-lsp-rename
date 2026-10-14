/**
 * Waiting for a language server to finish indexing, as far as the protocol allows.
 *
 * There is no readiness request in LSP and no portable way to ask "have you indexed yet": a server
 * answers an unindexed file with an empty result rather than waiting. The only signal that
 * distinguishes "indexing" from "nothing there" is a position the caller knows holds a symbol
 * eventually answering with something — and `findReferences` qualifies, because it always includes
 * the declaration. So the wait polls the caller's own position and reports which of three things
 * happened.
 *
 * Each poll is a full query through the pool, which releases its workspace lane between attempts, so
 * a long wait never blocks another query on the same workspace.
 * @module dsh-lsp-rename/lib/index-wait
 */

/** The server answered, and the position holds a symbol. */
export const ANSWERED = 'answered'

/** The server answered definitively: there is no symbol at that position, or it refused the query. */
export const ANSWERED_NOTHING = 'answered-nothing'

/** The budget expired while the server was still answering with empty results. */
export const TIMED_OUT = 'timed-out'

/** How long to wait between polls. Short enough to feel immediate, long enough not to spam a server that is indexing. */
export const DEFAULT_POLL_MS = 500

/**
 * A server may answer with a cancellation instead of a result — rust-analyzer sends
 * `ContentModified` (-32801) when its file watcher reloads a document — which says nothing about
 * whether the crate is indexed. These answers are retried rather than reported.
 */
const CANCELLATION_PATTERN = /-32801|content modified|request (?:was )?cancelled|canceled/i

/**
 * Poll one position until the server answers for it.
 *
 * An empty result is ambiguous — it is what an unindexed file returns AND what a position with no
 * symbol returns — so it is polled until the budget runs out. Only a server ERROR is a definitive
 * answer, and only that stops the wait early.
 * @param probe - runs one `findReferences` query and returns its raw payload, or throws what the
 *   server or the transport reported.
 * @param options - the cancellation signal, the total budget in milliseconds, and the poll interval.
 * @returns the outcome, the milliseconds spent waiting, and the last payload that carried locations.
 * @throws Error only when the call itself was cancelled; every other failure is an outcome.
 */
export async function awaitIndex(probe, { signal, budgetMs, pollMs = DEFAULT_POLL_MS }) {
  const startedAt = Date.now()
  let detail = ''
  for (;;) {
    if (signal?.aborted === true) throw abortError(signal)
    const elapsed = Date.now() - startedAt
    let payload
    try {
      payload = await probe()
    } catch (error) {
      if (signal?.aborted === true) throw abortError(signal)
      const message = messageOf(error)
      if (!CANCELLATION_PATTERN.test(message)) {
        // A server that answers with an error has answered: it is serving this position, and its
        // message is the answer. Report it verbatim rather than burning the rest of the budget.
        return { outcome: ANSWERED_NOTHING, waitedMs: Date.now() - startedAt, payload: undefined, detail: message }
      }
      detail = message
    }
    if (Array.isArray(payload) ? payload.length > 0 : payload !== null && payload !== undefined) {
      return { outcome: ANSWERED, waitedMs: Date.now() - startedAt, payload, detail: '' }
    }
    if (elapsed >= budgetMs) {
      return { outcome: TIMED_OUT, waitedMs: elapsed, payload, detail }
    }
    await delay(Math.min(pollMs, budgetMs - elapsed), signal)
  }
}

/**
 * The cancellation error a waiting caller sees.
 * @param signal - the aborted signal.
 * @returns the error to throw.
 */
function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('the lsp index wait was cancelled')
}

/**
 * Sleep between polls, failing at once on cancellation.
 * @param ms - milliseconds to wait.
 * @param signal - the cancellation signal.
 * @returns a promise that settles after the delay.
 */
async function delay(ms, signal) {
  if (ms <= 0) return
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The message of a thrown value.
 * @param error - the thrown value.
 * @returns its message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}