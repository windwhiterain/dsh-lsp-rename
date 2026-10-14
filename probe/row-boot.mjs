/**
 * Diagnostic: does the `lsp-rename` row's `apply()` succeed against real Harness services?
 *
 * Boots the four services the row injects (`fs`, `subprocess`, `tools`, `systemPrompt`) in one
 * context, applies the row exactly as the Loader would, and reports the outcome. It is a
 * reproduction harness, not a test: it exists because a failing row inside an agent preset takes
 * the whole preset — and therefore session creation — down with it, and the Loader's own report
 * only reaches the Plugins page.
 *
 * Every run asserts: a row that never starts, or that starts without registering its tools, fails
 * this probe. Awaiting a plugin is not such an assertion — Cordis resolves a fiber whose injected
 * services never arrived — so each mount checks the fiber reached `ACTIVE`, and the tool registry
 * is read back afterwards.
 *
 * Usage: from a DeepSeek Harness checkout, which is what makes `tsx` resolvable:
 *
 *   node --import tsx/esm C:/resource/dsh-lsp-rename/probe/row-boot.mjs
 */

import { Context, FiberState } from '../../deepseek-harness/vendor/cordis/src/index.ts'
import FsLocal from '../../deepseek-harness/packages/fs/fs-local/src/index.ts'
import SubprocessLocal from '../../deepseek-harness/packages/subprocess/subprocess-local/src/index.ts'
import { ToolRuntime } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import SystemPrompt from '../../deepseek-harness/packages/core/system-prompt/src/index.ts'
import SessionProjectionRegistry from '../../deepseek-harness/packages/session/session-projection/src/index.ts'
import WorkingDirectory from '../../deepseek-harness/packages/session/working-directory/src/index.ts'
import * as ToolLsp from '../../deepseek-harness/packages/lsp/tool-lsp/src/index.ts'
import Lsp from '../../deepseek-harness/packages/lsp/lsp/src/index.ts'
import { OUTPUT_SCHEMA, PARAMETERS, WAIT_OUTPUT_SCHEMA, WAIT_PARAMETERS } from '../index.js'
import * as LspStdio from '../../deepseek-harness/packages/lsp/lsp-stdio/src/index.ts'
import * as lspRename from '../index.js'

const CONFIG = {
  command: 'rust-analyzer',
  extensionToLanguage: { '.rs': 'rust' },
  timeoutMs: 180000,
}

/** Every expectation this run failed to meet, so one run reports every problem it found. */
const failures = []

/**
 * Record one unmet expectation.
 * @param condition - what the probe observed.
 * @param description - what it expected instead.
 */
function check(condition, description) {
  if (!condition) failures.push(description)
}

/**
 * Mount one plugin and require it to activate, because awaiting a fiber also resolves for a plugin
 * whose injected services never arrived and whose `apply` therefore never ran.
 * @param root - the context the plugin mounts into.
 * @param plugin - the plugin module.
 * @param config - the plugin's row configuration.
 * @param label - the plugin's name, for the failure message.
 * @returns the mounted fiber.
 */
async function mount(root, plugin, config, label) {
  const fiber = root.plugin(plugin, config)
  await fiber
  check(fiber.state === FiberState.ACTIVE, `${label} never activated (fiber state ${fiber.state})`)
  return fiber
}

const root = new Context()
await mount(root, FsLocal, {}, 'fs')
await mount(root, SubprocessLocal, {}, 'subprocess')
// `tools` injects `systemPrompt`, so it can only activate once the prompt service is mounted.
await mount(root, SystemPrompt, {}, 'systemPrompt')
await mount(root, ToolRuntime, {}, 'tools')

// The shipped stack, mounted globally exactly as the dsh-lsp-rust bundle does, so this probe
// reproduces the real contention: two rows registering a tool named `lsp`. `tool-lsp` injects
// `workingDirectory`, which itself needs the projection registry and an absolute fallback
// directory; without them it stays pending and the shipped tool never registers at all.
await mount(root, SessionProjectionRegistry, {}, 'sessionProjections')
await mount(root, WorkingDirectory, { defaultDirectory: process.cwd() }, 'workingDirectory')
await mount(root, Lsp, {}, 'lsp')
await mount(root, LspStdio, { servers: { rust: { command: 'rust-analyzer', extensionToLanguage: { '.rs': 'rust' } } } }, 'lsp-stdio')
await mount(root, ToolLsp, {}, 'tool-lsp')

const tools = root.get('tools')
/** The tool names the registry publishes to the model, right now. */
const names = () => tools.schemas().map(schema => schema.name)
const before = names()
console.log('global tools before the row:', before.join(', ') || '(none)')
check(before.includes('lsp'), 'the shipped lsp tool is absent, so this run reproduces no contention')

// The row mounts into the context its injected services resolve from. A bare `new Context(root)`
// is the wrong topology: the row reads them off the property proxy, which a child context does
// not carry, so the row would sit pending forever and look like it had started.
const row = await mount(root, lspRename, CONFIG, 'lsp-rename')

const after = names()
console.log('global tools after the row:', after.join(', ') || '(none)')
check(after.includes('lsp_rename'), 'the row did not register its lsp_rename tool')
check(after.includes('lsp_wait_for_index'), 'the row did not register its lsp_wait_for_index tool')
check(after.includes('lsp'), 'the shipped lsp tool disappeared when the row mounted')

// The pending-state card a UI renders while the rename runs must be a diff card, and must carry
// the hunks that card requires. The settled card replaces it with the applied diffs.
const pending = tools.get('lsp_rename')?.presentCall?.({
  operation: 'rename', file_path: 'src/lib.rs', line: 3, character: 5, new_name: 'renamed',
})
check(pending?.card === 'diff', `a pending rename renders ${JSON.stringify(pending?.card)} instead of a diff card`)
check(Array.isArray(pending?.diffs), 'a pending rename card carries no diff hunks')

// The preset's standing scope is created by the Loader, which a plain child context does not
// reproduce, so this probe asserts the two things that broke production directly on the exported
// definitions: that the row activates and registers, and that the schemas are the dialect
// `register` accepts.
const parameters = JSON.stringify(PARAMETERS)
console.log('lsp_rename parameters:', parameters)
if (!/"required":\s*\[/.test(parameters)) throw new Error('parameters carry no top-level required list')
if (/"required":\s*true/.test(parameters)) throw new Error('parameters carry a per-property required flag')
if (/"required":\s*true/.test(JSON.stringify(OUTPUT_SCHEMA))) throw new Error('the output schema carries a per-property required flag')
for (const optional of ['new_name', 'workspace_root']) {
  if (PARAMETERS.required.includes(optional)) throw new Error(`${optional} must be optional`)
}
if (PARAMETERS.properties.workspace_root?.type !== 'string') throw new Error('workspace_root must be a string')
for (const name of ['operation', 'file_path', 'line', 'character']) {
  if (!PARAMETERS.required.includes(name)) throw new Error(`${name} must be required`)
}

// The wait tool: its parameters and its closed result, in the same dialect.
const waitParameters = JSON.stringify(WAIT_PARAMETERS)
if (/"required":\s*true/.test(waitParameters)) throw new Error('wait parameters carry a per-property required flag')
if (/"required":\s*true/.test(JSON.stringify(WAIT_OUTPUT_SCHEMA))) throw new Error('wait output carries a per-property required flag')
if (WAIT_PARAMETERS.required.includes('workspace_root')) throw new Error('wait workspace_root must be optional')
for (const name of ['file_path', 'line', 'character']) {
  if (!WAIT_PARAMETERS.required.includes(name)) throw new Error(`wait ${name} must be required`)
}
for (const name of ['outcome', 'waitedMs', 'locations', 'workspacePath']) {
  if (!WAIT_OUTPUT_SCHEMA.required.includes(name)) throw new Error(`wait output ${name} must be required`)
}
console.log('wait tool schemas:', waitParameters)

// Disposing the row must take its tools with it, or a hot reload would leave the old ones live.
await row.dispose()
check(!names().includes('lsp_rename'), 'lsp_rename outlived the row disposing')
check(names().includes('lsp'), 'the shipped lsp tool went away with the row')

await root.fiber.dispose()

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  console.error(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\ndisposed cleanly; every check passed')
}
