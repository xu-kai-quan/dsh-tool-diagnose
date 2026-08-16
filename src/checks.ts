import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-subagent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DiagnosticCheck, DiagnosticFinding } from './registry.js'

// Every check below is a FACTORY, not a static object: `ctx` is captured once, by closure, from
// whatever already-scoped context the factory is called with (see index.ts) — never accepted as a
// `run()` parameter. See DiagnosticCheck's own doc for why a passed-in ctx breaks at runtime.

// Mirrors the mapping @deepseek-ai/dsh-host-plugin-inventory uses for FiberState -> public phase.
const FIBER_PHASE: Record<number, string | null> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null, // disposed
  5: 'unloading',
}

/**
 * Reads `ctx.loader.entries()` directly (the same primitive
 * `@deepseek-ai/dsh-host-plugin-inventory` projects to the web UI) to report whether a plugin is
 * mounted, enabled, and past `active` in its fiber lifecycle.
 */
export function createPluginFiberStateCheck(ctx: Context): DiagnosticCheck {
  return {
    id: 'plugin-fiber-state',
    description: 'Reports Loader entries whose module name contains the target substring: enabled/disabled and fiber phase (pending/loading/active/failed/unloading/none). With no target, reports only entries NOT cleanly active.',
    run(target) {
      const findings: DiagnosticFinding[] = []
      for (const entry of ctx.loader.entries()) {
        if (entry.options.group) continue
        const name = entry.options.name
        if (target !== undefined && !name.includes(target)) continue

        const phase = entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? 'unknown')
        const healthy = !entry.disabled && phase === 'active'
        if (target === undefined && healthy) continue // unfiltered scan reports only trouble

        findings.push({
          checkId: 'plugin-fiber-state',
          severity: healthy ? 'info' : entry.disabled ? 'warning' : 'error',
          summary: `${name}: ${entry.disabled ? 'disabled' : 'enabled'}, fiber ${phase ?? 'none (no live root fiber)'}`,
          detail: entry.disabled
            ? 'Disabled entries never mount; check the profile/patch layer that set `disabled` for this row.'
            : phase !== 'active'
              ? 'A non-active fiber usually means an unmet `inject` dependency (stuck pending/loading) or a thrown error during apply() (failed) — read the loader/app boot logs for this entry\'s id.'
              : undefined,
        })
      }
      return findings
    },
  }
}

/**
 * Resolves a tool name through `ctx.tools.get()` the way the global scope sees it — a
 * restricted-away or never-registered tool both read back as `undefined`, so this check names
 * both possibilities rather than guessing which applies.
 */
export function createToolVisibilityCheck(ctx: Context): DiagnosticCheck {
  return {
    id: 'tool-visibility',
    description: 'Resolves a tool name against the global scope (ctx.tools.get). Requires a target tool name; a no-op without one.',
    run(target) {
      if (target === undefined) return []
      const definition = ctx.tools.get(target)
      if (definition === undefined) {
        return [{
          checkId: 'tool-visibility',
          severity: 'warning',
          summary: `Tool "${target}" is not visible in the global scope`,
          detail: 'Never registered, its owning plugin failed to load (see plugin-fiber-state), or an agent-scoped ctx.tools.restrict() shadowed it away for this scope specifically.',
        }]
      }
      return [{
        checkId: 'tool-visibility',
        severity: 'info',
        summary: `Tool "${target}" is registered and visible in the global scope`,
      }]
    },
  }
}

// --- Optional checks: each needs a service a minimal deployment may not mount. index.ts wires
// each one behind its own `ctx.inject([...])`, calling its factory with THAT scoped ctx, so a
// deployment without e.g. subagents keeps every other check working instead of failing the whole
// plugin's `inject`. ---

/**
 * Resolves a credential reference via `ctx.credentials.describe()` — never the value itself, per
 * that seam's own contract (`packages/credentials/credentials/README.md`).
 */
export function createCredentialResolutionCheck(ctx: Context): DiagnosticCheck {
  return {
    id: 'credential-resolution',
    description: 'Resolves a credential reference (a POSIX-shell-identifier-shaped name, e.g. DEEPSEEK_API_KEY) via ctx.credentials.describe() — reports configured/source/writable, never the value. Requires a target; a no-op without one.',
    async run(target) {
      if (target === undefined) return []
      let ref: ReturnType<typeof credentialRef>
      try {
        ref = credentialRef(target)
      } catch (error) {
        return [{
          checkId: 'credential-resolution',
          severity: 'warning',
          summary: `"${target}" is not a valid credential reference`,
          detail: error instanceof Error ? error.message : String(error),
        }]
      }
      const info = await ctx.credentials.describe(ref)
      return [{
        checkId: 'credential-resolution',
        severity: info.configured ? 'info' : 'warning',
        summary: info.configured
          ? `"${target}" is configured${info.source !== undefined ? ` (source: ${info.source})` : ''}`
          : `"${target}" is not configured`,
        detail: info.configured
          ? `writable: ${info.writable}`
          : 'Not resolvable by any credential provider in this deployment — check the provider chain (e.g. dsh-credentials-local layers the process environment over $DSH_HOME/.credentials.yaml, with launcher .env fallbacks).',
      }]
    },
  }
}

/**
 * Reads the effective approval policy. Without a target it reports only the deployment default
 * (`ApprovalService.config.policy`); with a session-id target it also reads that session's
 * `approval/policy` override via the public `overrideOf()` method.
 */
export function createApprovalPolicyCheck(ctx: Context): DiagnosticCheck {
  return {
    id: 'approval-policy',
    description: 'Reports the effective approval policy ("ask" or "never"). With a session-id target, reports that session\'s override (if any) plus the effective value; without one, reports only the deployment default.',
    run(target) {
      const deploymentDefault = ctx.approval.config.policy ?? 'ask'
      if (target === undefined) {
        return [{
          checkId: 'approval-policy',
          severity: 'info',
          summary: `Deployment default approval policy: "${deploymentDefault}"`,
          detail: 'No session id given — pass one as target to see whether that session overrides it.',
        }]
      }
      const session = ctx.sessions.get(SessionId(target))
      if (session === undefined) {
        return [{
          checkId: 'approval-policy',
          severity: 'warning',
          summary: `Session "${target}" is not live in ctx.sessions`,
          detail: `Deployment default policy is "${deploymentDefault}"; a persisted-but-unloaded session's override can't be read this way — resume it first.`,
        }]
      }
      const override = ctx.approval.overrideOf(session)
      const effective = override ?? deploymentDefault
      return [{
        checkId: 'approval-policy',
        severity: 'info',
        summary: `Session "${target}" effective approval policy: "${effective}"`,
        detail: override === undefined
          ? `No session override; using the deployment default ("${deploymentDefault}").`
          : `Session override is "${override}" (deployment default: "${deploymentDefault}").`,
      }]
    },
  }
}

/**
 * Measures current token pressure for a live session via the synchronous `ctx.tokenMeter.measure()`.
 */
export function createTokenPressureCheck(ctx: Context): DiagnosticCheck {
  return {
    id: 'token-pressure',
    description: 'Measures current token pressure for a live session (ctx.tokenMeter.measure): totalTokens (request/response pressure) vs. surfaceTokens (fixed-heuristic surface total). Requires a session-id target.',
    run(target) {
      if (target === undefined) return []
      const session = ctx.sessions.get(SessionId(target))
      if (session === undefined) {
        return [{
          checkId: 'token-pressure',
          severity: 'warning',
          summary: `Session "${target}" is not live in ctx.sessions`,
          detail: 'Only a currently-loaded session can be measured; resume it first.',
        }]
      }
      const measurement = ctx.tokenMeter.measure(session)
      return [{
        checkId: 'token-pressure',
        severity: 'info',
        summary: `Session "${target}": totalTokens=${measurement.totalTokens}, surfaceTokens=${measurement.surfaceTokens}`,
        detail: 'totalTokens is request-and-response pressure (provider-anchored when available); surfaceTokens is the fixed-heuristic surface-only total. If compaction should have run and hasn\'t, expect totalTokens high relative to the route\'s context window (ctx.llm.resolveModelInfo().context).',
      }]
    },
  }
}

/**
 * Flattens a session's descendant subagent tree via `ctx.subagents.listDescendants()` and reports
 * count, max depth, and any entries the registry could not interpret (`kind: 'diagnostic'`).
 */
export function createSubagentTreeCheck(ctx: Context): DiagnosticCheck {
  return {
    id: 'subagent-tree',
    description: 'Flattens a session\'s descendant subagent tree (ctx.subagents.listDescendants) and reports count, max depth, and any corrupt/unavailable descendants. Requires a root session-id target.',
    async run(target) {
      if (target === undefined) return []
      const entries = await ctx.subagents.listDescendants(SessionId(target))
      if (entries.length === 0) {
        return [{
          checkId: 'subagent-tree',
          severity: 'info',
          summary: `Session "${target}" has no descendant subagents`,
        }]
      }
      const maxDepth = Math.max(...entries.map((entry) => entry.depth))
      const diagnostics = entries.filter((entry) => entry.kind === 'diagnostic')
      const findings: DiagnosticFinding[] = [{
        checkId: 'subagent-tree',
        severity: diagnostics.length > 0 ? 'warning' : 'info',
        summary: `Session "${target}": ${entries.length} descendant(s), max depth ${maxDepth}`,
        detail: diagnostics.length > 0
          ? `${diagnostics.length} descendant(s) could not be interpreted — see the per-entry findings below.`
          : undefined,
      }]
      for (const entry of diagnostics) {
        findings.push({
          checkId: 'subagent-tree',
          severity: 'warning',
          summary: `Descendant ${entry.id} at depth ${entry.depth}: ${entry.reason}`,
          detail: entry.reason === 'corrupt'
            ? 'Missing, malformed, or unrecognized-version descriptor.'
            : 'Persistence inspection failed; retried on the next listing.',
        })
      }
      return findings
    },
  }
}
