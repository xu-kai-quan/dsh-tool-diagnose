import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { DiagnosticCheck } from '../src/registry.ts'
import { DiagnosticRegistry } from '../src/registry.ts'

function makeCheck(id: string, summary: string): DiagnosticCheck {
  return {
    id,
    description: id,
    run: () => [{ checkId: id, severity: 'info', summary }],
  }
}

describe('DiagnosticRegistry', () => {
  it('runs every registered check in registration order', async () => {
    const ctx = new Context()
    new DiagnosticRegistry(ctx)
    ctx.diagnostics.registerCheck(makeCheck('a', 'finding a'))
    ctx.diagnostics.registerCheck(makeCheck('b', 'finding b'))

    const findings = await ctx.diagnostics.run()
    expect(findings.map((f) => f.summary)).toEqual(['finding a', 'finding b'])
  })

  it('rejects a duplicate check id', () => {
    const ctx = new Context()
    new DiagnosticRegistry(ctx)
    ctx.diagnostics.registerCheck(makeCheck('dup', 'first'))
    expect(() => ctx.diagnostics.registerCheck(makeCheck('dup', 'second'))).toThrow(/already registered/)
  })

  it('unregisters a check when its disposer runs', async () => {
    const ctx = new Context()
    new DiagnosticRegistry(ctx)
    const dispose = ctx.diagnostics.registerCheck(makeCheck('transient', 'gone soon'))
    dispose()
    expect(await ctx.diagnostics.run()).toEqual([])
  })

  it('forwards the target argument to each check', async () => {
    const ctx = new Context()
    new DiagnosticRegistry(ctx)
    let seenTarget: string | undefined
    ctx.diagnostics.registerCheck({
      id: 'echo',
      description: 'echo',
      run: (target) => {
        seenTarget = target
        return []
      },
    })
    await ctx.diagnostics.run('bash_run')
    expect(seenTarget).toBe('bash_run')
  })

  // Regression coverage for why `DiagnosticCheck.run` takes no `ctx` parameter at all: an earlier
  // version stored a ctx reference on the registered check and handed it back to `run(ctx,
  // target)` later. That broke against the real @deepseek-ai/cordis runtime — a service-mediated
  // ctx reference doesn't preserve the caller's injected-service access — so a check that reads a
  // service must close over its own already-scoped ctx at construction time instead (see the
  // `create*Check` factories in checks.ts). This test proves the registry itself imposes no
  // barrier to that pattern: a check whose closure reads an external value still works when run
  // from code that has no relationship at all to where the check was registered.
  it('runs a closure-based check correctly regardless of who calls run()', async () => {
    const ctx = new Context()
    new DiagnosticRegistry(ctx)
    const externallyOwnedState = { value: 'captured-at-registration' }
    ctx.diagnostics.registerCheck({
      id: 'closure-check',
      description: 'closure-check',
      run: () => [{ checkId: 'closure-check', severity: 'info', summary: externallyOwnedState.value }],
    })

    async function unrelatedCaller(registry: typeof ctx.diagnostics) {
      return registry.run()
    }
    expect(await unrelatedCaller(ctx.diagnostics)).toEqual([{
      checkId: 'closure-check',
      severity: 'info',
      summary: 'captured-at-registration',
    }])
  })
})
