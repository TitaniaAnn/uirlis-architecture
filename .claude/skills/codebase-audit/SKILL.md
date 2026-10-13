---
name: codebase-audit
description: Audit the whole repository (or a given path) for bugs, bad coding practices, duplicated code, and inconsistencies with the repo's own conventions, then write a verified, ranked report to .audit/REPORT.md. Use when asked to audit, sweep, health-check, or "find everything wrong with" the codebase, hunt duplicate code, or check that the code follows CLAUDE.md. Not for reviewing a single diff (use /code-review for that).
argument-hint: "[path] [--fix] [--quick]"
---

# Codebase audit

Two passes, then verification. The mechanical pass (`scripts/scan.mjs`) is
cheap and exhaustive but dumb: regex rules, duplicate-block hashing, repeated
definitions, and the repo's own typecheck/lint/test. The judgment pass reads the
code and finds what regex can't: logic errors, races, missing checks, drift
between sibling files. Nothing goes in the report until it has been read in
context and survives an attempt to prove it wrong.

## Arguments

- `path` (optional): limit the audit to this directory. Default is the repo root.
- `--quick`: mechanical pass plus verification only, no area agents.
- `--fix`: after the report, apply fixes for findings marked `fix: safe`. Never
  without the report first, and never for findings marked `fix: needs-decision`.

## Step 1: Load the repo's rules of the road

Read `CLAUDE.md`, `ARCHITECTURE.md`, and `README.md`. Write down every stated convention as a
one-line checkable claim ("server code uses getUser(), never getSession()",
"new public-read tables need an anon SELECT grant"). These claims are the
yardstick for the **inconsistency** category. A convention the docs state but
the code breaks is a finding; a pattern the code follows everywhere but the docs
don't mention is not.

This repo's code exists to make ARCHITECTURE.md and README.md verifiable, so
every concrete claim those docs make (a file path, a function name, a policy, a
"the dashboard never reads X") is also a checkable claim. A doc claim the code
doesn't back is a **high** inconsistency here, not a low one.

Also skim `tests/*.test.mjs`: the source-level smoke tests encode conventions
that were already enforced once. Regressions against those are high signal.

The pages are deliberately omitted (ARCHITECTURE.md § "What this cut leaves
out"), and so are migrations 0008–0016. Missing pages, imports that would only
resolve in the full app, and `npm run dev` not working are **not** findings.
Never propose writing the omitted pieces.

Next.js here is 16; check `node_modules/next/dist/docs/` before flagging any
Next API as wrong or deprecated.

## Step 2: Mechanical pass

```bash
[ -d node_modules ] || npm ci          # tsc/eslint need it; skip if offline
node .claude/skills/codebase-audit/scripts/scan.mjs --tools
```

If the Supabase CLI and Docker are available, also run `supabase db reset` and
the four SQL suites in `supabase/tests/`; that's the canonical check for the
database boundary. Note it as skipped in the report if not.

This writes `.audit/scan.md` (read this) and `.audit/scan.json`. Sections:

- **Tools**: typecheck, lint, unit tests, `deno check` for edge functions. Any
  failure here is an automatic **error** finding; quote the first real error.
  Typecheck errors that only come from the omitted pages are the exception:
  list them under "Checked and dismissed".
- **Rule hits**: patterns from `rules.json`, already graded error/warn/info.
  Comments are masked out before matching, so a hit is in code.
- **Duplicate blocks**: runs of 6+ identical significant lines (whitespace and
  comments ignored, trivial lines like `}` skipped). `--min-lines 4` digs deeper.
- **Same name defined in multiple files**: top-level functions/consts defined
  twice. Cheapest signal of a helper that was re-written instead of imported.

Treat every item as a lead. Expect false positives; that's the point of step 4.

## Step 3: Judgment pass (skip with --quick)

Split the scoped tree into areas that each fit one reader. This repo is small,
so four is enough:

1. `middleware.ts`, `src/lib/**` (auth, env, observability, request context,
   rate limit, the four Supabase clients)
2. `src/app/**`, `src/components/**` (layout guards, admin actions, API routes,
   auth callback)
3. `supabase/migrations/**`, `supabase/tests/**`
4. `supabase/functions/**`, `tests/**`, plus ARCHITECTURE.md and README.md read
   against the code they describe

Launch one `general-purpose` agent per area **in a single message** so they run
in parallel. Give each:

- its area's file list
- the convention claims from step 1
- the scan hits that fall inside its area
- the checklist in [references/checklist.md](references/checklist.md)
- this output contract: a list of findings, each with `category` (error |
  practice | duplication | inconsistency), `severity` (high | medium | low),
  `file:line`, a one-sentence `claim`, the `evidence` (quoted code), and for
  errors a concrete `failure` (input or state → wrong result). Tell them to
  read whole files, not grep excerpts, and to report nothing they haven't read.

While they run, do the **cross-file consistency** sweep yourself. It needs the
whole picture, which no single area agent has. Put sibling files side by side
and diff their shape:

- every `actions.ts`: same order of requireRole → Zod parse → write → logError →
  revalidatePath? same error-return shape? same `logError` scope format?
- every `route.ts`: same auth check, same error responses, same `withRequestId` use?
- every edge function `index.ts`: same API-key verification, same payload
  validation, same error envelope?
- migrations: every table has RLS enabled, policies use the role helpers,
  grants match the 0020–0022 pattern, every `security definer` has the
  revoke/grant pair
- duplicated blocks from the scan: is this a real copy that should be a shared
  helper, or two things that look alike today and will diverge for good reason?

## Step 4: Verify

For every candidate (scan hit, agent finding, or your own), before it goes in
the report:

1. Open the file at the cited line and read enough around it to understand it.
2. Try to prove it wrong: is there a guard upstream? a comment explaining the
   choice? a test that covers it? a convention in CLAUDE.md that permits it?
3. For an **error**, trace a real path from a caller or input to the failure.
   No path, no error (it may still be a practice finding).
4. For **duplication**, only report when merging would remove real maintenance
   risk (logic, validation, security checks, SQL). Identical JSX scaffolding or
   two three-line `searchParams` destructures are not worth a helper. Say which
   copy should become the shared one and where it should live.
5. Dedupe: the same root cause across ten files is one finding with ten
   locations.

Drop anything that fails. Keep a short "checked and dismissed" list; it stops
the next audit from re-litigating the same lines and tells you which
`rules.json` rules need tightening.

## Step 5: Report

Write `.audit/REPORT.md` (gitignored). Structure:

```markdown
# Codebase audit — <date>

Scope: <path> · <n> files · tools: typecheck ✓ lint ✗ unit ✓ deno skipped

| | high | medium | low |
|---|---|---|---|
| Errors | … | … | … |
| Bad practices | … | … | … |
| Duplication | … | … | … |
| Inconsistencies | … | … | … |

## Errors
### E1 · high · `src/app/…/actions.ts:42`
What's wrong, in one or two sentences.
Failure: concrete input/state → wrong outcome.
Fix: what to change. `fix: safe` | `fix: needs-decision`

## Bad practices
## Duplication
## Inconsistencies

## Checked and dismissed
- `file:line` (rule or claim): why it's fine.

## Scanner tuning
- Rules that produced only false positives, with the proposed rules.json change.
```

Rank by severity within each section. Use `file:line` everywhere so findings
are clickable. Lead with the finding, not the rule name.

Severity guide:
- **high**: wrong result, data exposure, auth bypass, crash on a reachable path,
  failing typecheck/tests, a broken security convention (RLS, grants,
  service-role isolation).
- **medium**: swallowed errors, missing validation at a boundary, duplicated
  logic that has already started to drift, convention breaks with real cost.
- **low**: style drift, dead code, naming inconsistency, duplication that hasn't
  drifted yet.

Don't name the private upstream repos or products anywhere in the report or in
any fix (CLAUDE.md: this cut stays generic).

Then tell the user, in a few lines: counts per category, the top three findings,
where the report is. Don't paste the whole report into chat.

## Step 6: Fix (only with --fix, or when the user asks after reading)

Apply `fix: safe` findings one category at a time, smallest blast radius first.
After each batch run `npm run lint`, `npm test`, and `npx tsc --noEmit`. Never
edit an applied migration; a database fix is a new migration with the next
number. Leave `needs-decision` findings for the user and list them.

## Maintaining the scanner

`rules.json` is per-repo and meant to be edited. When an audit dismisses the
same rule hit twice, tighten the rule (narrow `include`, add `skipIfFileMatches`)
or delete it. When an audit finds a real bug class regex could have caught, add
a rule. `scripts/scan.mjs --help` lists the flags; the `$comment` at the top of
`rules.json` documents the rule fields.
