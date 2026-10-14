/**
 * Probe: does rust-analyzer answer `textDocument/rename` under the exact sequence
 * `dsh-lsp-rename` speaks, and do this plugin's planning, offset, and rollback
 * code land the edit it describes?
 *
 * The probe runs the plugin's OWN `ServerInstance` (and through it the connection
 * and framing code) against a real rust-analyzer, so a protocol mismatch shows up
 * here instead of in a session. It then applies the returned `WorkspaceEdit` twice:
 * once through `applyRename` over a filesystem stub, and once deliberately failing
 * mid-plan to prove the rollback restores what was already written.
 *
 * Everything happens inside this directory: `workspace/` is the fixture, `scratch/`
 * is a disposable copy the edits are applied to. Nothing outside is touched.
 *
 * Usage: node probe/rename-probe.mjs
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ServerInstance } from '../lib/instance.js'
import { applyRename, planWorkspaceEdit } from '../lib/workspace-edit.js'
import { normalizeLocations, hoverText } from '../lib/normalize.js'
import { ANSWERED, awaitIndex, TIMED_OUT } from '../lib/index-wait.js'
import { renameDiff } from '../lib/render.js'
import { uriToPath } from '../lib/uri.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'workspace')
const COMMAND = process.env.PROBE_COMMAND ?? 'rust-analyzer'
const READY_TIMEOUT_MS = 120_000
const QUERY_TIMEOUT_MS = 150_000
const TIMEOUT_MS = 180_000

/** The symbol the probe renames, and the name it renames it to. */
const OLD_NAME = 'widget_count'
const NEW_NAME = 'gadget_total'

/** Every failure the probe records; a non-empty list fails the run. */
const failures = []

/**
 * Record one failed expectation.
 * @param message - what did not hold.
 */
function fail(message) {
  failures.push(message)
  console.error(`FAIL ${message}`)
}

/**
 * Record one satisfied expectation.
 * @param message - what held.
 */
function pass(message) {
  console.log(`ok   ${message}`)
}

/**
 * The `subprocess` seam handle over a Node child process, so the plugin's own
 * connection code runs unmodified.
 * @param spec - the spawn spec the plugin passes.
 * @returns the handle shape the seam documents.
 */
function spawnAdapter(spec) {
  const [command, ...args] = spec.argv
  const child = spawn(command, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderrText = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderrText = (stderrText + chunk).slice(-spec.maxStderrBytes) })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    collected: { stderr: { readFrom: () => ({ text: stderrText, nextOffset: 0, lossy: false }) } },
    done: new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    }),
    terminate: () => { child.kill('SIGTERM') },
    waitForExit: async () => true,
  }
}

/** The configuration the plugin would resolve for rust-analyzer. */
const CONFIG = {
  command: COMMAND,
  args: [],
  env: {},
  configuration: null,
  initializationOptions: null,
  maxMessageBytes: 16_000_000,
  maxStderrBytes: 1_000_000,
  killGraceMs: 2_000,
  shutdownTimeoutMs: 5_000,
}

/** Run one coroutine under a deadline, so a wedged server fails the probe instead of hanging it. */
function deadline(label, promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${TIMEOUT_MS} ms`)), TIMEOUT_MS)),
  ])
}

/**
 * A filesystem stub over `node:fs` implementing the four seam methods `applyRename` uses. The
 * version is content-derived, so a stale-version write fails exactly as the real provider's does.
 * @param root - the directory the stub treats as its world.
 * @param options - `failOnBasename` refuses the write of one file, to exercise the rollback.
 * @returns the seam-shaped filesystem plus a write counter.
 */
function filesystemStub(root, options = {}) {
  const state = { writes: 0 }
  const windows = process.platform === 'win32'
  const versionOf = content => `v${Buffer.byteLength(content, 'utf8')}:${[...content].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 7)}`
  return {
    state,
    // The server hands out absolute paths, with a lowercase drive letter on Windows; the real
    // provider resolves them case-insensitively, so the stub must too.
    async resolve(path) {
      const absolute = path.startsWith('/') || /^[a-z]:/i.test(path) ? path : join(root, path)
      const relative = (windows ? win32 : posix).relative(root, absolute)
      return { targetKey: absolute, displayPath: (windows ? relative.replaceAll('\\', '/') : relative) || absolute }
    },
    async stat(target) {
      const info = await stat(target.targetKey).catch(() => undefined)
      if (info === undefined || !info.isFile()) return undefined
      return { version: versionOf(await readFile(target.targetKey, 'utf8')), type: 'file', size: info.size }
    },
    async readText(target) {
      return readFile(target.targetKey, 'utf8')
    },
    async writeText(target, content, expected) {
      state.writes += 1
      if (options.failOnBasename !== undefined && basename(target.targetKey) === options.failOnBasename) {
        throw new Error(`probe: refusing to write ${options.failOnBasename}`)
      }
      const current = await readFile(target.targetKey, 'utf8').catch(() => undefined)
      if (expected?.kind === 'replaceIfVersion' && current !== undefined && versionOf(current) !== expected.version) {
        throw new Error('probe: FS_STALE_VERSION')
      }
      await writeFile(target.targetKey, content)
      return { operation: current === undefined ? 'create' : 'update', version: versionOf(content), before: current ?? null, after: content }
    },
  }
}

/** Count the non-overlapping occurrences of one substring. */
function countOccurrences(text, needle) {
  let count = 0
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count += 1
  return count
}

/** The cursor the probe queries: the declaration of {@link OLD_NAME} in `src/lib.rs`. */
async function declarationCursor(root) {
  const file = join(root, 'src', 'lib.rs')
  const text = await readFile(file, 'utf8')
  // Anchor on `fn <name>`, not on the name: the fixture's module doc comment mentions the symbol
  // first, and a cursor in a comment is not on a symbol at all.
  const declaration = text.indexOf(`fn ${OLD_NAME}`)
  if (declaration === -1) throw new Error(`probe: ${file} has no fn ${OLD_NAME}`)
  const offset = declaration + 'fn '.length
  const before = text.slice(0, offset)
  return {
    uri: pathToFileURL(file).href,
    line: before.split('\n').length - 1,
    character: offset - (before.lastIndexOf('\n') + 1),
    text,
  }
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-lsp-rename-probe-'))
  const world = join(scratch, 'workspace')
  await mkdir(world, { recursive: true })
  await cp(FIXTURE, world, { recursive: true })
  const instance = new ServerInstance({
    ...CONFIG,
    cwd: world,
    workspaceUri: pathToFileURL(world).href,
  }, spawnAdapter)

  try {
    await deadline('initialize', instance.capabilities === undefined ? waitForCapabilities(instance) : undefined)
    const capabilities = instance.capabilities
    for (const field of ['definitionProvider', 'referencesProvider', 'implementationProvider', 'hoverProvider', 'renameProvider']) {
      if (capabilities[field] === undefined || capabilities[field] === false) {
        fail(`the server does not advertise ${field}`)
      } else {
        pass(`advertises ${field}`)
      }
    }
    if (capabilities.textDocumentSync?.openClose !== true) fail('the server does not permit transient didOpen')
    else pass('permits transient didOpen')
    if ((capabilities.positionEncoding ?? 'utf-16') !== 'utf-16') fail(`unexpected positionEncoding ${capabilities.positionEncoding}`)
    else pass('negotiated utf-16')

    const cursor = await declarationCursor(world)
    const source = { uri: cursor.uri, text: cursor.text }
    const at = { operation: 'rename', languageId: 'rust', position: { line: cursor.line, character: cursor.character }, newName: NEW_NAME }

    // rust-analyzer answers an unindexed file with an empty result instead of waiting, so a cold
    // start looks like "this symbol does not exist". `awaitIndex` is the shipped wait: poll the
    // caller's own position until the server answers, and report which of three things happened.
    const cold = Date.now()
    const ready = await awaitIndex(
      () => instance.query({ ...at, operation: 'findReferences' }, source),
      { budgetMs: READY_TIMEOUT_MS, pollMs: 500 },
    )
    const locations = normalizeLocations(ready.payload ?? [])
    if (ready.outcome !== ANSWERED) {
      fail(`the wait did not converge on a real symbol: ${ready.outcome}${ready.detail === '' ? '' : ` (${ready.detail})`}`)
    } else {
      pass(`cold wait converged after ${ready.waitedMs} ms (${Date.now() - cold} ms wall) with ${locations.length} location(s)`)
    }
    if (ready.payload !== undefined && locations.length === 0) fail('the wait reported ANSWERED with no locations')

    // A warm server must return on the first poll, not burn the budget.
    const warm = await awaitIndex(
      () => instance.query({ ...at, operation: 'findReferences' }, source),
      { budgetMs: 60_000, pollMs: 500 },
    )
    if (warm.outcome !== ANSWERED) fail(`a warm wait did not answer: ${warm.outcome}`)
    else pass(`warm wait answered after ${warm.waitedMs} ms`)

    // A position holding no symbol also answers with nothing, forever — that ambiguity is inherent to the
// protocol, so the wait must poll it out and report the budget outcome rather than claim the symbol
    // is absent. A short budget keeps the probe quick.
    const text = source.text
    const commentOffset = text.indexOf('//')
    const beforeComment = text.slice(0, commentOffset)
    const bogus = {
      ...at,
      position: {
        line: beforeComment.split('\n').length - 1,
        character: commentOffset - (beforeComment.lastIndexOf('\n') + 1) + 3,
      },
    }
    const wrongPosition = await awaitIndex(
      () => instance.query({ ...bogus, operation: 'findReferences' }, source),
      { budgetMs: 2000, pollMs: 250 },
    )
    if (wrongPosition.outcome !== TIMED_OUT) {
      fail(`a position with no symbol should not resolve: got ${wrongPosition.outcome} after ${wrongPosition.waitedMs} ms`)
    } else {
      pass(`a position with no symbol polled out to the budget (${wrongPosition.waitedMs} ms), reported as unresolved`)
    }

    for (const operation of ['goToDefinition', 'findReferences', 'goToImplementation', 'hover']) {
      const payload = await deadline(operation, instance.query({ ...at, operation, newName: undefined }, source))
      const rendered = operation === 'hover' ? hoverText(payload) : normalizeLocations(payload)
      if (operation === 'hover') pass(`hover: ${String(rendered).split('\n')[0]}`)
      else pass(`${operation}: ${rendered.length} location(s)`)
    }

    const payload = await deadline('rename', instance.query(at, source))
    console.log(`raw WorkspaceEdit (${JSON.stringify(payload).length} bytes):\n${JSON.stringify(payload, null, 2).slice(0, 1200)}`)
    const plan = planWorkspaceEdit(payload)
    pass(`rename planned ${plan.length} file(s), ${plan.reduce((sum, file) => sum + file.edits.length, 0)} edit(s)`)
    if (plan.length < 2) fail('expected the rename to touch more than one file')

    const probeFs = filesystemStub(world)
    const written = await applyRename(probeFs, plan, { cwd: world, windows: process.platform === 'win32' })
    if (written.length !== plan.length) fail(`expected ${plan.length} written file(s), got ${written.length}`)
    for (const file of written) {
      const after = await readFile(file.target.targetKey, 'utf8')
      if (after !== file.after) fail(`${file.displayPath} does not hold the computed text`)
      // The fixture mentions the symbol in prose, which a rename does not rewrite, so the count must
      // fall by exactly the edits this file received.
      const removed = countOccurrences(file.before, OLD_NAME) - countOccurrences(after, OLD_NAME)
      if (removed !== file.edits) fail(`${file.displayPath} removed ${removed} occurrence(s), expected ${file.edits}`)
      const diff = renameDiff(file.before, file.after, file.span.start, file.span.end)
      if (diff === undefined) fail(`${file.displayPath} produced no diff window`)
      else if (diff.newText === diff.oldText) fail(`${file.displayPath} produced an empty diff window`)
      else if (!diff.newText.includes(NEW_NAME)) fail(`${file.displayPath} diff window does not show the new name`)
    }
    pass(`applied ${written.length} file(s); every occurrence the server reported is gone`)
    pass(`replaced identifier reported as "${written[0].replaced}"`)

    // A CRLF file and an astral-plane character before a renamed span prove the offset math counts
    // UTF-16 code units and never re-serializes line endings.
    const crlf = written.find(file => file.before.includes('\r\n'))
    if (crlf === undefined) fail('the fixture has no CRLF file to check')
    else if (!crlf.after.includes('\r\n')) fail(`${crlf.displayPath} lost its CRLF line endings`)
    else pass(`${crlf.displayPath} kept CRLF line endings`)
    const astral = written.find(file => /[\u{1F300}-\u{1FAFF}]/u.test(file.before.slice(0, file.span.end)))
    if (astral === undefined) fail('the fixture has no astral character before a renamed span')
    else pass(`${astral.displayPath} renamed correctly across an astral character (UTF-16 offsets)`)

    // Rollback: the same plan with a later file's write refused must leave the earlier file as it
    // was. The fixture is restored by overwriting it — the server still watches the directory, and
    // deleting it underneath a live rust-analyzer is EBUSY on Windows.
    await cp(FIXTURE, world, { recursive: true, force: true })
    if (plan.length < 2) fail('the rollback check needs at least two files in the plan')
    else {
      const second = uriToPath(plan[1].uri, process.platform === 'win32')
      let rollbackError
      try {
        await applyRename(filesystemStub(world, { failOnBasename: basename(second) }), plan, {
          cwd: world,
          windows: process.platform === 'win32',
        })
      } catch (error) {
        rollbackError = error
      }
      if (rollbackError === undefined) fail('the forced failure did not fail the rename')
      else if (!String(rollbackError.message).includes('restored')) {
        fail(`the rollback was not reported: ${rollbackError.message}`)
      } else {
        pass(`rollback reported: ${rollbackError.message}`)
      }
      const restored = await readFile(written[0].target.targetKey, 'utf8')
      if (restored !== written[0].before) fail('the first file was not restored after the forced failure')
      else pass('the first file was restored byte for byte')
    }
  } finally {
    await instance.dispose()
    // A file a terminating helper still holds open keeps the scratch directory alive for a moment;
    // the retries are the documented remedy and a leftover temp directory is never worth a failure.
    await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {})
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('\nall checks passed')
}

/** Wait for the handshake, which the instance starts in its constructor. */
function waitForCapabilities(instance) {
  return new Promise((resolve, reject) => {
    const deadlineAt = Date.now() + READY_TIMEOUT_MS
    const poll = () => {
      if (instance.capabilities !== undefined) {
        resolve()
        return
      }
      if (Date.now() > deadlineAt) {
        reject(new Error(`the server did not finish initialize within ${READY_TIMEOUT_MS} ms`))
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

await main()
