# Audit checklist

Hand this to each area agent. It's a prompt for attention, not a form to fill
in: report only what you find, with `file:line` and quoted evidence.

## Errors (things that produce a wrong result or crash)

- Unhandled promise: `async` call without `await`, or a `.then` with no
  rejection path, on a path where the result matters.
- Supabase calls whose `{ error }` is never checked, so a failed write looks
  like success to the caller.
- `.single()` where zero rows is a normal case (throws/errors instead of
  returning null); `.maybeSingle()` where more than one row is possible.
- Off-by-one and boundary bugs in pagination, date ranges (`isoDaysAgo`-style
  helpers, UTC vs local), slicing, and rate-limit windows.
- Zod schema that accepts what the DB rejects (length, enum, nullability), or
  the reverse. Compare the schema with the column definition in the migration.
- `revalidatePath` missing after a write, or pointing at a path that doesn't
  exist anymore, so the page shows stale data.
- Race conditions: read-then-write without a transaction or atomic RPC;
  check-then-insert without a unique constraint.
- Server Action or route that trusts an id from `FormData` without checking the
  caller may touch that row (RLS may cover it; confirm the policy does).
- Redirects inside `try` blocks (Next's `redirect()` throws; a broad `catch`
  swallows it).
- SQL: policies that reference the table they protect (recursive RLS), missing
  `with check` on insert/update policies, functions callable by roles that
  shouldn't, `security definer` without `set search_path`.
- Edge functions: missing method check, body parsed before auth, unbounded
  batch size, errors that leak internal detail in the response.

## Bad practices (works today, costs later)

- Errors swallowed or degraded silently (fallback value, `?error=` redirect)
  without `logError`/`selectOrLog` first.
- `logError` scopes that aren't dotted (`area.module.function`) or carry PII in
  `meta` (emails, names, IPs, tokens).
- Required env vars read with `process.env.X` (no fallback, no `requireEnv`).
- Any `any`, unchecked casts (`as Foo` on external data), non-null assertions
  on values that can be null.
- Client Components doing work that belongs on the server (data fetching in
  `useEffect`, secrets or service-role imports, `fetch('/api/...')` mutations).
- Missing `import "server-only"` on modules that read secrets.
- Overly broad `select("*")`, N+1 query loops, missing indexes for columns used
  in filters/joins (check the migration).
- Dead code: unused exports, unreachable branches, components no route imports.
- Comments that contradict the code beneath them.
- Tests that assert on implementation strings so loosely they can't fail, or so
  tightly they break on a rename.

## Duplication

- Same logic in two places that has already drifted (one copy got a fix the
  other didn't). This is the one worth reporting first.
- Validation or auth checks re-implemented per file instead of a shared helper.
- Constants (limits, durations, role names, table names) repeated as literals.
- Copy-pasted SQL across migrations where one should call the other's function.
- For each duplicate: name the copy that should survive and where it should
  live (`src/lib/…`, `supabase/functions/_shared/…`, a SQL function).

## Inconsistencies

- A convention from CLAUDE.md/AGENTS.md broken in some files and kept in others.
- Sibling files (all `actions.ts`, all `route.ts`, all edge functions) doing the
  same job in different shapes: different error return types, different order
  of auth/validation, different naming.
- Naming drift: `apiKey` vs `api_key` vs `key` for the same thing in TS;
  table/column naming in SQL.
- Docs (README, ARCHITECTURE, docs/*.md) describing behavior the code no longer
  has, or file paths that moved.
- `.env.example` missing a var the code reads, or listing one nothing reads.
- `package.json` scripts or CI steps that reference files/commands that don't
  exist.
