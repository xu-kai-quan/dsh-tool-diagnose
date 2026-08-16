import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPluginFiberStateCheck,
  createSubagentTreeCheck,
  createTokenPressureCheck,
  createToolVisibilityCheck,
} from '../src/checks.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

function makeContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('createPluginFiberStateCheck', () => {
  const activePlugin: Plugin.Function = () => {}
  const pendingPlugin: Plugin.Object = { inject: ['neverReady'], apply() {} }

  async function harness() {
    const ctx = makeContext()
    await ctx.plugin(Loader)
    ctx.loader.builtins.active = activePlugin
    ctx.loader.builtins.pending = pendingPlugin
    return ctx
  }

  it('reports every matching entry with a target, including a healthy one', async () => {
    const ctx = await harness()
    await ctx.loader.create({ name: 'cordis:active' })
    const check = createPluginFiberStateCheck(ctx)

    const findings = check.run('cordis:active')
    expect(findings).toEqual([{
      checkId: 'plugin-fiber-state',
      severity: 'info',
      summary: 'cordis:active: enabled, fiber active',
      detail: undefined,
    }])
  })

  it('reports a disabled entry as a warning with no target filter', async () => {
    const ctx = await harness()
    await ctx.loader.create({ name: 'cordis:active', disabled: true })
    const check = createPluginFiberStateCheck(ctx)

    const findings = check.run(undefined)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warning',
      summary: 'cordis:active: disabled, fiber none (no live root fiber)',
    })
  })

  it('reports a stuck-pending entry as an error with no target filter', async () => {
    const ctx = await harness()
    await ctx.loader.create({ name: 'cordis:pending' })
    const check = createPluginFiberStateCheck(ctx)

    const findings = check.run(undefined)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'error',
      summary: 'cordis:pending: enabled, fiber pending',
    })
  })

  it('omits healthy entries from an unfiltered scan', async () => {
    const ctx = await harness()
    await ctx.loader.create({ name: 'cordis:active' })
    await ctx.loader.create({ name: 'cordis:pending' })
    const check = createPluginFiberStateCheck(ctx)

    const findings = check.run(undefined)
    expect(findings.map((f) => f.summary)).toEqual(['cordis:pending: enabled, fiber pending'])
  })
})

describe('createToolVisibilityCheck', () => {
  // ToolRuntime's constructor reads ctx.systemPrompt synchronously to wire schema assembly, so
  // direct construction needs it mounted first — the pattern dsh-tools' own tests use.
  async function harness(): Promise<Context> {
    const ctx = makeContext()
    await ctx.plugin(SystemPrompt, {})
    new ToolRuntime(ctx)
    return ctx
  }

  it('is a no-op without a target', async () => {
    const ctx = await harness()
    const check = createToolVisibilityCheck(ctx)
    expect(check.run(undefined)).toEqual([])
  })

  it('reports a registered tool as visible', async () => {
    const ctx = await harness()
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'probe',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        return 'ok'
      },
    }))
    const check = createToolVisibilityCheck(ctx)

    expect(check.run('probe')).toEqual([{
      checkId: 'tool-visibility',
      severity: 'info',
      summary: 'Tool "probe" is registered and visible in the global scope',
    }])
  })

  it('reports an unknown tool name as not visible', async () => {
    const ctx = await harness()
    const check = createToolVisibilityCheck(ctx)

    const findings = check.run('nonexistent_tool')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warning',
      summary: 'Tool "nonexistent_tool" is not visible in the global scope',
    })
  })
})

describe('createTokenPressureCheck', () => {
  it('is a no-op without a target', () => {
    const ctx = makeContext()
    new SessionStore(ctx)
    new TokenMeter(ctx)
    const check = createTokenPressureCheck(ctx)
    expect(check.run(undefined)).toEqual([])
  })

  it('reports zero pressure for a freshly created empty session', () => {
    const ctx = makeContext()
    new SessionStore(ctx)
    new TokenMeter(ctx)
    const session = ctx.sessions.create()
    const check = createTokenPressureCheck(ctx)

    const findings = check.run(session.id)
    expect(findings).toEqual([{
      checkId: 'token-pressure',
      severity: 'info',
      summary: 'Session "' + session.id + '": totalTokens=0, surfaceTokens=0',
      detail: 'totalTokens is request-and-response pressure (provider-anchored when available); surfaceTokens is the fixed-heuristic surface-only total. If compaction should have run and hasn\'t, expect totalTokens high relative to the route\'s context window (ctx.llm.resolveModelInfo().context).',
    }])
  })

  it('reports a session id that is not live', () => {
    const ctx = makeContext()
    new SessionStore(ctx)
    new TokenMeter(ctx)
    const check = createTokenPressureCheck(ctx)

    const findings = check.run(SessionId('never-created'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'warning',
      summary: 'Session "never-created" is not live in ctx.sessions',
    })
  })
})

describe('createSubagentTreeCheck', () => {
  function harness() {
    const ctx = makeContext()
    new SessionStore(ctx)
    new SessionProjectionRegistry(ctx)
    new SubagentRuntime(ctx)
    return ctx
  }

  it('is a no-op without a target', async () => {
    const ctx = harness()
    const check = createSubagentTreeCheck(ctx)
    expect(await check.run(undefined)).toEqual([])
  })

  it('reports no descendants for a plain session with no subagent children', async () => {
    const ctx = harness()
    const session = ctx.sessions.create()
    const check = createSubagentTreeCheck(ctx)

    const findings = await check.run(session.id)
    expect(findings).toEqual([{
      checkId: 'subagent-tree',
      severity: 'info',
      summary: `Session "${session.id}" has no descendant subagents`,
    }])
  })
})
