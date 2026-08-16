import { Context } from '@deepseek-ai/cordis'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { createApprovalPolicyCheck, createCredentialResolutionCheck } from '../src/checks.ts'
import { DiagnosticRegistry } from '../src/registry.ts'

describe('createCredentialResolutionCheck', () => {
  it('is a no-op without a target', async () => {
    const ctx = new Context()
    const check = createCredentialResolutionCheck(ctx)
    expect(await check.run(undefined)).toEqual([])
  })

  it('reports an invalid reference without touching ctx.credentials', async () => {
    const ctx = new Context() // no credentials service mounted — would throw if the check touched it
    const check = createCredentialResolutionCheck(ctx)
    const findings = await check.run('not a valid ref!')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.summary).toMatch(/not a valid credential reference/)
  })
})

describe('createApprovalPolicyCheck', () => {
  it('reports the deployment default with no target', () => {
    const ctx = new Context()
    new ApprovalService(ctx, { policy: 'never' })
    const check = createApprovalPolicyCheck(ctx)

    const findings = check.run(undefined)
    expect(findings).toEqual([{
      checkId: 'approval-policy',
      severity: 'info',
      summary: 'Deployment default approval policy: "never"',
      detail: 'No session id given — pass one as target to see whether that session overrides it.',
    }])
  })

  it('falls back to "ask" when config omits a policy', () => {
    const ctx = new Context()
    new ApprovalService(ctx, {})
    const check = createApprovalPolicyCheck(ctx)

    const [finding] = check.run(undefined) as Array<{ summary: string }>
    expect(finding?.summary).toBe('Deployment default approval policy: "ask"')
  })
})

// Regression test for the exact index.ts wiring pattern, not just the check function in
// isolation: DiagnosticRegistry mounted on a BASE context that never injects 'approval', a check
// registered from a NESTED `ctx.inject(['diagnostics', 'approval'], ...)` scope (the only place
// 'approval' is actually available), then run() called from the base context — the same
// mismatch a model-facing tool's execute() closure has relative to where optional checks
// register. This exact shape threw `cannot get property "approval" without inject` against the
// real @deepseek-ai/cordis runtime before checks.ts moved to the closure-factory pattern; a
// version that reverts to passing `ctx` through DiagnosticRegistry.run() will fail this test.
describe('index.ts wiring pattern: registry on base ctx, check behind a nested ctx.inject', () => {
  it('runs an approval-policy check registered from a deeper scope than run() is called from', async () => {
    const base = new Context()
    new DiagnosticRegistry(base)
    await base.plugin(ApprovalService, { policy: 'never' })

    await base.inject(['diagnostics', 'approval'], (scopedCtx) => {
      scopedCtx.diagnostics.registerCheck(createApprovalPolicyCheck(scopedCtx))
    })
    await new Promise((resolve) => setImmediate(resolve))

    // Called from `base`, which has no 'approval' injection of its own.
    const findings = await base.diagnostics.run()
    expect(findings).toEqual([{
      checkId: 'approval-policy',
      severity: 'info',
      summary: 'Deployment default approval policy: "never"',
      detail: 'No session id given — pass one as target to see whether that session overrides it.',
    }])
  })
})
