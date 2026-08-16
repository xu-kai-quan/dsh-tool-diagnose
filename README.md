# dsh-tool-diagnose

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **Cordis plugin** (not a
Skill — see [Plugin vs Skill](#plugin-vs-skill)) that exposes a model-facing `diagnose` tool backed
by an extensible check registry, `ctx.diagnostics`. Where a symptom-table Skill tells the agent
which shell command to run and how to read its output, this plugin runs the introspection itself,
inside the process, against live Cordis state — and lets other plugins contribute more checks the
same way this package's own `checks.ts` does.

## Layout

```
src/
  registry.ts    # ctx.diagnostics: DiagnosticRegistry Service — registerCheck/list/run
  checks.ts       # create*Check FACTORIES (2 always-on) + optional checks (4, service-gated)
  index.ts        # the plugin: mounts the registry, calls each factory, registers the `diagnose` tool
tests/
  registry.spec.ts            # registry mechanics + the closure-vs-passed-ctx regression test
  checks.spec.ts                # credential-format / approval-policy branches + the index.ts wiring regression test
  checks-integration.spec.ts     # all 6 checks against real Loader/ToolRuntime/SessionStore/etc.
cordis.patch.yml    # the bundle layer a profile applies when it lists this package
package.json         # declares dsh.bundle, pointing at cordis.patch.yml
```

## What the checks actually do

Every one reads a real, already-shipped service — no invented APIs. Two are always registered
(they only need `ctx.tools`, which this plugin already requires, or nothing beyond `ctx.diagnostics`
itself); four more register only when their service is actually mounted in this deployment (see
[Optional checks](#optional-checks-service-gated)).

- **`plugin-fiber-state`** reads `ctx.loader.entries()` — the same primitive
  `@deepseek-ai/dsh-host-plugin-inventory` projects to the web UI — and reports each matching
  entry's `enabled`/`disabled` state and fiber phase (`pending`/`loading`/`active`/`failed`/
  `unloading`/none). This is the live version of manually running `dsh --profile <p>
  --dump-config` and reading it by eye. (It's gated on `ctx.loader` like the other optional checks
  below, even though the description here groups it with the "always on" pair for token-cost
  purposes — see `index.ts`.)
- **`tool-visibility`** calls `ctx.tools.get(name)` to tell you whether a tool is registered and
  visible in the global scope, or absent (never registered, owning plugin failed to load, or
  scope-restricted away).

Call the tool with an optional `target` (check-specific: a plugin module-name substring, a tool
name, a credential-reference name, or a session id); omit it to get every check's unfiltered view.

### Optional checks (service-gated)

Each depends on a service `dsh-base` normally provides but an unusual deployment might not mount;
`index.ts` registers each one inside its own `ctx.inject([...])`, so a deployment missing one
service still gets every other check instead of the whole plugin failing to load.

- **`credential-resolution`** (needs `ctx.credentials`) — resolves a credential reference (e.g.
  `DEEPSEEK_API_KEY`) via `ctx.credentials.describe()`: configured/source/writable, **never the
  value itself**, per that seam's own doctrine.
- **`approval-policy`** (needs `ctx.approval`, `ctx.sessions`) — reports the deployment default
  approval policy (`"ask"`/`"never"`), or a specific session's override when given a session-id
  target.
- **`token-pressure`** (needs `ctx.tokenMeter`, `ctx.sessions`) — measures a live session's current
  `totalTokens` (request/response pressure) vs. `surfaceTokens` (fixed-heuristic total), useful for
  "why hasn't compaction run yet" symptoms.
- **`subagent-tree`** (needs `ctx.subagents`) — flattens a session's descendant subagent tree,
  reporting count, max depth, and any descendant the registry couldn't interpret
  (`corrupt`/`unavailable`).

## Extending it: a third-party check

Any other plugin can depend on this one and register more checks. **A check is a factory that
closes over its own already-scoped `ctx`** — construct it inside the `ctx.inject` callback for
whatever services it needs, not as a standalone object built ahead of time (see
[Audit notes](#audit-notes) for exactly why that distinction is load-bearing):

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-extra-diagnostics'

export function apply(ctx: Context) {
  ctx.inject(['diagnostics' /* , 'whateverServiceThisCheckNeeds' */], (ctx) => {
    ctx.diagnostics.registerCheck({
      id: 'my-check',
      description: 'What this check looks at and what target means for it.',
      run(target) {
        // read ctx (closed over above) here — never accept ctx as a run() parameter
        return []
      },
    })
  })
}
```

Disposing that plugin's fiber automatically unregisters its check — `registerCheck` returns the
disposer but you rarely need to call it directly; Cordis calls it for you on unload.

## Try it locally

```sh
pnpm dsh plugin --profile demo add /path/to/dsh-tool-diagnose
dsh --profile demo --dump-config   # confirm the "diagnose-tool" row is present
dsh --profile demo
```

Then, in a session: "Use the diagnose tool to check why the bash_run tool isn't showing up."

On Windows, if you instead point a `--patch` overlay directly at `src/index.ts` (the
tutorial-style local-file pattern) for a quick source-launch test, the module `name` must be a
`file:///` URL, not a bare `D:/...` path — Node's ESM loader rejects the latter with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`.

## Plugin vs Skill

If you want a portable, no-build, copy-into-`~/.agents/skills/` symptom table any DSH session can
read instead, that's a Skill, not a plugin — see the original share in
[Discussion #1739](https://github.com/deepseek-ai/deepseek-harness/discussions/1739), which is what
this plugin took its methodology cues from (especially version-anchoring knowledge to a specific
dsh release). The two compose well: a Skill can tell the agent "call the `diagnose` tool first,
then read its findings against this table" instead of asking it to run shell commands and parse
the output itself.

## Status

- [x] Published on GitHub, public, tagged with the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic.
- [x] `LICENSE` filled in with a real copyright holder.
- [x] Published on npm as [`dsh-tool-diagnose`](https://www.npmjs.com/package/dsh-tool-diagnose) —
      install with `dsh plugin add dsh-tool-diagnose`. The GitHub source install
      (`dsh plugin add github:xu-kai-quan/dsh-tool-diagnose`, see the build-script caveat below)
      still works too, and tracks `master` rather than the last tagged npm release.

If you fork or extend this:

1. Confirm dependency versions against what you actually build/test against — this skeleton pins
   the versions available at scaffold time: `@deepseek-ai/cordis@4.0.1`,
   `@deepseek-ai/cordis-plugin-loader@1.0.2`, `@deepseek-ai/schemastery@3.18.1`, and
   `@deepseek-ai/dsh-tools`/`dsh-credentials`/`dsh-user-approval`/`dsh-token-meter`/`dsh-session`/
   `dsh-subagent` all at `0.1.0-rc.5` (the dsh family is versioned in lockstep).
2. Ship prebuilt output (`npm publish`, or `pnpm pack` + tarball) rather than relying on installers
   allowing a git-install `prepare` script, unless you want users to opt into that.
3. `npm install && npm test && npm run build` before tagging a release — and, per the audit notes
   below, actually boot it inside a real `dsh` process at least once. This package's own bugs were
   invisible to its test suite until that step.
4. Write real checks — the six shipped here are a useful starting set, not the ceiling; port
   whatever mechanism chains you'd otherwise write as Skill symptom rows into `DiagnosticCheck`s
   that actually read the live state instead of describing how to. Grep the target package's
   README for its `ctx.<key>` service surface first, the way this package's checks were built.

## Audit notes

### Two real bugs a full test suite (22 passing tests) did not catch

Both were found only by actually running this exact plugin inside a real `dsh --profile headless`
process and asking the agent to call the `diagnose` tool for real — every unit and integration
test up to that point passed cleanly while the tool was either unregistered or broken.

1. **Wrong `output.schema` DSL for `defineTool`.** `dsh-tools`' `ValueSchemaSpec` marks a property
   optional/required with `required: true` **on the property itself**, mirroring `parameters` —
   NOT a sibling plain-JSON-Schema `required: [...]` array on the object node. The wrong form
   compiled fine under `tsc` and looked identical to the (correct) `parameters` block a few lines
   above it, but threw `JsonSchemaError: schema.items.required is not supported by the value
   schema DSL` the instant `defineTool()` ran — which happens at plugin-load time, so the entire
   `diagnose` tool silently failed to register with no crash and no log line, in every profile.
2. **A ctx reference does not survive being stored and handed back through another service's
   `this.ctx`.** The original registry design captured `ctx` (or `this.ctx`) once and passed it to
   each check's `run(ctx, target)` later. Verified against the real `@deepseek-ai/cordis` 4.0.1
   runtime with isolated repro scripts: a scope's injected-service access (`ctx.approval`,
   `ctx.tools`, even a **statically** `inject`-declared dependency) is granted per exact context
   reference and does *not* propagate when that reference is stored as a plain value inside
   another `Service` instance and read back via `this.ctx` in a later method call — it throws
   `cannot get property "X" without inject`, regardless of whether the original grant was static
   or from a nested `ctx.inject()`. The fix: `DiagnosticCheck.run` takes no `ctx` parameter at
   all; every check is a **factory** (`create*Check(ctx)`) that closes over its scope's `ctx`
   directly at construction time, and the registry only ever calls `check.run(target)`.

`tests/registry.spec.ts` and `tests/checks.spec.ts` both now carry regression tests for bug #2
(a check registered from a deeper scope than `run()` is later called from); nothing in the suite
directly regression-tests bug #1 (a wrong-but-type-checking `output.schema` shape) — if you touch
that schema, boot the plugin for real again rather than trusting `npm test` alone.

### What was verified this way, end-to-end, with a live model call

Against a real `dsh --profile headless` boot (no mocks, no fakes, real npm-installed
dependencies): the `diagnose` tool appears in the model's tool list; called with no target, it
returns real findings from `plugin-fiber-state` (4 real disabled-plugin rows: `cordis-plugin-hmr`,
`dsh-bash-sandbox`, `dsh-tool-bash`, `dsh-skill-badge`) and `approval-policy` (`"ask"`, the real
deployment default); called with `target: 'DEEPSEEK_API_KEY'`, `credential-resolution` correctly
reported it configured (source: file, writable) **without leaking the value**; called with
`target: 'write'`, `tool-visibility` correctly reported it registered and visible. `credentials`,
`approval`, `sessions`, `tokenMeter`, and `subagents` all turned out to be mounted in the
`headless` profile — only `loader` gating was ever a real portability concern, and it's now
handled the same way as the other four.

### Per-check unit-test technique, in case you extend these further

- `plugin-fiber-state`: `ctx.plugin(Loader)` + `ctx.loader.builtins.<name> = fn` +
  `ctx.loader.create({ name })` — the same harness `dsh-host-plugin-inventory`'s own test suite
  uses, avoiding any real file/module resolution.
- `tool-visibility`: direct `new ToolRuntime(ctx)` — but its constructor reads `ctx.systemPrompt`
  synchronously, so `await ctx.plugin(SystemPrompt, {})` has to happen first, or construction
  throws `Cannot read properties of undefined (reading 'tools')`. `dsh-tools`' own
  `code-mode.spec.ts` has the same prerequisite.
- `token-pressure` / `approval-policy`: direct `new SessionStore(ctx)` + `new TokenMeter(ctx)` /
  `new ApprovalService(ctx, config)`, then `ctx.sessions.create()` for a live session — no
  persistence or agent loop needed since `measure()` and `overrideOf()` take the session object
  directly rather than reading it back through a service.
- `subagent-tree`: direct `new SessionStore(ctx)` + `new SessionProjectionRegistry(ctx)` +
  `new SubagentRuntime(ctx)`. `listDescendants()` throws `SubagentError` before any candidate
  scan if `sessionProjections` isn't mounted — even for a session with zero children — so that
  service is not skippable even for the trivial empty-tree case tested here.

### A real dependency-declaration bug, separately caught and fixed

`@deepseek-ai/dsh-credentials` was briefly marked `optional` in `peerDependenciesMeta`, but
`checks.ts` does a hard value-import of `credentialRef` from it — so the module import would fail
at load time regardless of whether the credential check is ever registered, contradicting
"optional". `dsh-user-approval`, `dsh-token-meter`, and `dsh-subagent` are genuinely optional:
they're referenced only via `import type {}` side-effect imports, which TypeScript erases, leaving
no runtime import to fail if the package is absent.

### Still not covered

The non-trivial branches of `subagent-tree` (an actual descendant, or a `corrupt`/`unavailable`
diagnostic entry) aren't tested — reaching them needs a real subagent provider and a started child
(see `packages/subagent/subagent/tests/list-children.spec.ts` in the harness repo for the full
weight of that harness: JSONL persistence, a mock LLM adapter, a real spawn/fork provider). The
trivial empty-tree path is covered, and was independently confirmed by the live boot test above.
