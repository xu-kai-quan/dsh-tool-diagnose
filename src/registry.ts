import { Context, Service } from '@deepseek-ai/cordis'

export type DiagnosticSeverity = 'info' | 'warning' | 'error'

export interface DiagnosticFinding {
  readonly checkId: string
  readonly severity: DiagnosticSeverity
  readonly summary: string
  readonly detail?: string
}

export interface DiagnosticCheck {
  /** Stable id, reported on every finding this check produces. */
  readonly id: string
  /** Shown in the tool schema's description so the model knows what a check covers. */
  readonly description: string
  /**
   * No `ctx` parameter: a check that needs live services (`ctx.loader`, `ctx.approval`, ...) must
   * close over its own already-scoped `ctx` reference at construction time — see the `create*`
   * factories in `checks.ts`. Cordis's injected-service access is granted per exact context
   * reference; it does NOT survive being stored as a plain value and handed back later through
   * another service's own `this.ctx` (verified against the real `@deepseek-ai/cordis` runtime — a
   * `ctx` forwarded that way throws `cannot get property "X" without inject` even for services
   * the original caller could read directly one line earlier). A `run(ctx, target)` signature here
   * would invite exactly that failure the moment `DiagnosticRegistry` mediates the call.
   * @param target - caller-supplied focus (a plugin module substring, a tool name, ...); check-specific meaning.
   */
  run(target: string | undefined): DiagnosticFinding[] | Promise<DiagnosticFinding[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    diagnostics: DiagnosticRegistry
  }
}

/**
 * Registry other plugins extend with their own checks, the same way this package's own
 * `checks.ts` does — `registerCheck` is the seam a third-party plugin depends on `inject:
 * ['diagnostics']` to reach. The registry itself never touches `ctx` to run a check; see
 * {@link DiagnosticCheck} for why.
 */
export class DiagnosticRegistry extends Service {
  static inject = []

  private readonly checks = new Map<string, DiagnosticCheck>()

  constructor(ctx: Context) {
    super(ctx, 'diagnostics')
  }

  /**
   * Register a check into the calling plugin's fiber. Disposing that fiber unregisters it.
   * @param check - a diagnostic check; `check.id` must be unique across every registered check.
   * @returns the disposer that unregisters this exact check.
   */
  registerCheck(check: DiagnosticCheck): () => void {
    if (this.checks.has(check.id)) {
      throw new Error(`diagnostic check "${check.id}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.checks.set(check.id, check)
      return () => {
        this.checks.delete(check.id)
      }
    })
  }

  /** Every currently registered check, for a catalog view. */
  list(): readonly DiagnosticCheck[] {
    return [...this.checks.values()]
  }

  /** Runs every registered check against `target` and concatenates their findings in registration order. */
  async run(target?: string): Promise<DiagnosticFinding[]> {
    const findings: DiagnosticFinding[] = []
    for (const check of this.checks.values()) {
      findings.push(...await check.run(target))
    }
    return findings
  }
}

export default DiagnosticRegistry
