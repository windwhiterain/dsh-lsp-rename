/**
 * Diagnostic: does the `lsp-rename` row's `apply()` succeed against real Harness services?
 *
 * Boots the four services the row injects (`fs`, `subprocess`, `tools`, `systemPrompt`) in one
 * context, applies the row exactly as the Loader would, and reports the outcome. It is a
 * reproduction harness, not a test: it exists because a failing row inside an agent preset takes
 * the whole preset — and therefore session creation — down with it, and the Loader's own report
 * only reaches the Plugins page.
 *
 * Usage: node --import tsx/esm probe/row-boot.mjs
 */

import { Context } from '../../deepseek-harness/vendor/cordis/src/index.ts'
import FsLocal from '../../deepseek-harness/packages/fs/fs-local/src/index.ts'
import SubprocessLocal from '../../deepseek-harness/packages/subprocess/subprocess-local/src/index.ts'
import { ToolRuntime } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import SystemPrompt from '../../deepseek-harness/packages/core/system-prompt/src/index.ts'
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

const root = new Context()
await root.plugin(FsLocal, {})
await root.plugin(SubprocessLocal, {})
await root.plugin(ToolRuntime, {})
await root.plugin(SystemPrompt, {})

// The shipped stack, mounted globally exactly as the dsh-lsp-rust bundle does, so this probe
// reproduces the real contention: two rows registering a tool named `lsp`.
const lspService = await root.plugin(Lsp, {})
await root.plugin(LspStdio, { servers: { rust: { command: 'rust-analyzer', extensionToLanguage: { '.rs': 'rust' } } } })
await root.plugin(ToolLsp, {})
const globalNames = root.get('tools').schemas().map(schema => schema.name)
console.log('global tools include lsp:', globalNames.includes('lsp'))

// The preset's standing scope: a child context that inherits the global layer.
const presetScope = new Context(root)
const row = await presetScope.plugin(lspRename, CONFIG)
console.log('apply() resolved in a child scope')

const tools = root.get('tools')
// The preset's standing scope is created by the Loader, which a plain child context does not
// reproduce, so this probe asserts the two things that broke production directly on the exported
// definitions: `apply()` resolves, and the schemas are the dialect `register` accepts.
const parameters = JSON.stringify(PARAMETERS)
console.log('lsp_rename parameters:', parameters)
for (const pattern of [/"required":\s*\[/, /"required":\s*true/]) {
  console.log(`${pattern} ${pattern.test(parameters) ? 'present' : 'absent'}`)
}
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
console.log('shipped lsp still present:', tools.schemas().some(entry => entry.name === 'lsp'))

await row.dispose()
await lspService.dispose()
await root.fiber.dispose()
console.log('disposed cleanly')
