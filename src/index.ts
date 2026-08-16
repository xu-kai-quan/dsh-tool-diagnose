import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import {
  createApprovalPolicyCheck,
  createCredentialResolutionCheck,
  createPluginFiberStateCheck,
  createSubagentTreeCheck,
  createTokenPressureCheck,
  createToolVisibilityCheck,
} from './checks.js'
import { DiagnosticRegistry } from './registry.js'

export const name = 'diagnose-tool'
export const inject = ['tools']

export interface Config {
  /** Register this package's own checks (built-ins plus the optional service-gated ones below). */
  enableBuiltinChecks: boolean
}

export const Config: Schema<Config> = Schema.object({
  enableBuiltinChecks: Schema.boolean().default(true),
})

export function apply(ctx: Context, config: Config) {
  ctx.plugin(DiagnosticRegistry)

  ctx.inject(['diagnostics'], (ctx) => {
    if (config.enableBuiltinChecks) {
      ctx.diagnostics.registerCheck(createToolVisibilityCheck(ctx))
    }

    ctx.tools.register(defineTool({
      name: 'diagnose',
      description: 'Run registered DSH runtime diagnostic checks (plugin load state, tool visibility, credential resolution, approval policy, token pressure, subagent tree — whichever this deployment has mounted, plus any checks other plugins registered on ctx.diagnostics) and return structured findings. Prefer this over asking the user to run --dump-config or read logs by hand.',
      parameters: {
        target: {
          type: 'string',
          description: 'Check-specific focus: a plugin module-name substring, a tool name, a credential-reference name, or a session id. Omit to run every check\'s unfiltered behavior (most session- or name-scoped checks are then a no-op).',
        },
      },
      output: {
        // defineTool's ValueSchemaSpec DSL marks a property optional/required with `required:
        // true` ON THE PROPERTY ITSELF (same as `parameters` above) — NOT a sibling
        // plain-JSON-Schema `required: [...]` array on the object node.
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              checkId: { type: 'string', required: true },
              severity: { type: 'string', required: true },
              summary: { type: 'string', required: true },
              detail: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return ctx.diagnostics.run(args.target)
      },
    }))
  })

  // Each optional check depends on a service a minimal deployment may not mount; gating
  // registration behind its own `ctx.inject` keeps every other check working when one capability
  // (loader, credentials, approval, token-meter, subagents) is absent, instead of stalling this
  // whole plugin's apply() the way requiring `loader` at the top level once did — headless
  // profiles never mount `ctx.loader` (it's a Host/dynamic-plugin-management capability), so that
  // coupling silently pended the `diagnose` tool's own registration forever. Each factory is
  // called with THIS scope's own `ctx` — never a ctx forwarded through the registry later — see
  // `DiagnosticCheck`'s doc in registry.ts for why that distinction is load-bearing.
  if (config.enableBuiltinChecks) {
    ctx.inject(['diagnostics', 'loader'], (ctx) => {
      ctx.diagnostics.registerCheck(createPluginFiberStateCheck(ctx))
    })
    ctx.inject(['diagnostics', 'credentials'], (ctx) => {
      ctx.diagnostics.registerCheck(createCredentialResolutionCheck(ctx))
    })
    ctx.inject(['diagnostics', 'approval', 'sessions'], (ctx) => {
      ctx.diagnostics.registerCheck(createApprovalPolicyCheck(ctx))
    })
    ctx.inject(['diagnostics', 'tokenMeter', 'sessions'], (ctx) => {
      ctx.diagnostics.registerCheck(createTokenPressureCheck(ctx))
    })
    ctx.inject(['diagnostics', 'subagents'], (ctx) => {
      ctx.diagnostics.registerCheck(createSubagentTreeCheck(ctx))
    })
  }
}
