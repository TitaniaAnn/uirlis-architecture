# Architecture

A reference cut of a multi-surface control plane: one Next.js app (App Router,
React Server Components) serving a public marketing/CMS site, an admin CMS, and
an internal team dashboard, over a single Supabase Postgres with row-level
security. A separate edge layer ingests product telemetry behind API keys.

The published code is a curated subset. The full application is private; this
repo exists to make the decisions below verifiable — every claim points at a
file you can read.

The shape:

```
src/app/(marketing)   public site            anon + RLS public-read-published
src/app/admin         CMS                    requireRole("admin") + RLS
src/app/dashboard     internal telemetry     requireRole("employee") + RLS
src/app/api           route handlers         signed downloads, revalidation, health
supabase/migrations   schema + RLS + RPCs    the source of truth
supabase/functions    telemetry ingestion    API-key auth, service role
```

---

## 1. Four Supabase clients, one per execution context

`src/lib/supabase/` ships four factories, not one, because Next.js runs code in
four places with different cookie semantics and trust levels:

- **`client.ts`** — `createBrowserClient`. Runs in the browser, anon key.
- **`server.ts`** — `createServerClient` bound to the request cookie store.
  Used by Server Components, Server Actions, and Route Handlers. Wraps cookie
  writes in a try/catch because Server Components get a read-only cookie store.
- **`middleware.ts`** — `createServerClient` that refreshes the session on every
  request and mirrors the rotated cookies onto the response.
- **`admin.ts`** — the service-role client. Bypasses RLS, so it is fenced behind
  `import "server-only"`: importing it into a Client Component is a build error,
  not a runtime accident.

The split is the security boundary. The anon key is safe in the browser; the
service-role key can only be reached from server code, and the bundler enforces
it.

The server-side factories read their env through `requireEnv`
(`src/lib/env.ts`), which throws naming the missing variable instead of the
`process.env.X!` pattern that constructs a client with `undefined` and only
fails opaquely deep in a later request. The browser client is the deliberate
exception: it keeps *static* `process.env.NEXT_PUBLIC_*` access (dynamic
`process.env[name]` is never inlined by the bundler, so `requireEnv` would
always see `undefined` in the browser) and validates the inlined values
explicitly.

## 2. Three-layer authorization

Auth is checked three independent times, and each layer assumes the others can
fail:

1. **Middleware** (`middleware.ts`) gates `/admin` and `/dashboard` on session
   *presence* only — unauthenticated requests redirect to `/login` with a
   `redirectTo`. It deliberately does **not** check role; middleware runs on the
   edge with no DB and shouldn't make trust decisions beyond "is anyone signed
   in."
2. **Server layout** — each protected segment's `layout.tsx` calls
   `requireRole("admin" | "employee")` (`src/lib/auth.ts`), which reads the
   caller's role server-side and redirects under-privileged users. This is where
   the real authorization decision lives.
3. **RLS** is the backstop. Even if both layers above were bypassed, every
   query runs under a Postgres policy keyed on the caller's role.

`src/lib/auth.ts` uses `supabase.auth.getUser()`, never `getSession()`.
`getUser()` revalidates the token against the auth server; `getSession()` trusts
whatever is in the cookie. In server code that difference is the difference
between authorization and a forgeable claim.

One subtlety worth copying: the role lookup filters `employee_roles` by the
caller's own `user_id` even though RLS already scopes the read. The SELECT
policy is `user_id = app_user_id() OR is_admin()`, so an *admin* sees every
row — an unfiltered `.maybeSingle()` resolves to `null` the moment a second
employee exists and quietly locks admins out. "RLS will filter it" is not the
same as "the query returns the row you meant"
(`tests/auth-role-scope.smoke.test.mjs` guards this).

## 3. Mutations are Server Actions with a Zod boundary

Every write is a `"use server"` action (`src/app/admin/*/actions.ts`), not a
client `fetch` to an API route. Each action:

1. calls `requireRole("admin")` first,
2. parses `FormData` through a Zod schema (untrusted input never reaches the DB
   un-validated),
3. writes via the request-scoped Supabase client (so RLS applies), and
4. revalidates exactly the affected paths.

`posts/actions.ts::updatePost` revalidates `/admin/posts`, `/posts`, and
`/posts/[slug]` — surgical, not a blanket cache flush. This is the RSC mutation
model done without a client-side data layer: no fetch wrappers, no optimistic
cache to reconcile, the server is the single source of truth and the action
tells the framework precisely what changed.

## 4. RLS rests on SECURITY DEFINER role helpers

`0002_users_and_roles.sql` defines three `STABLE SECURITY DEFINER` functions —
`app_user_id()`, `is_admin()`, `is_employee()` — and every later policy is
written in terms of them (`using (public.is_admin())`).

Two reasons this matters:

- **No recursion.** A policy that inlined "is this user an admin?" by selecting
  from a table that itself has RLS would re-enter the policy evaluator and
  deadlock or error. `SECURITY DEFINER` runs the lookup as the function owner,
  outside the caller's RLS path, breaking the cycle.
- **One definition of "admin."** The predicate lives in one function. Change the
  role model once and all ~12 policies follow. A new auth user is mirrored into
  `public.users` by an `AFTER INSERT` trigger (`handle_new_user`), also
  `SECURITY DEFINER`, so sign-up doesn't need an anon insert policy.

## 5. The telemetry firehose is isolated from the read path

`0006_ingestion.sql` enables RLS on `usage_events` and `ingest_nonces` and
defines **no policy** for them. RLS-enabled-with-no-policy means anon and
authenticated roles can touch *nothing*; only the service role (which bypasses
RLS) can write. The edge functions run as the service role.

The dashboard never reads the raw firehose. `0007_usage_aggregates.sql` rolls
events into `usage_daily` and `usage_active_users`, and *those* tables carry an
employee-read policy. So the high-cardinality write target and the
employee-readable aggregates are different tables with different access — a
firehose write can never widen what an employee query can see.

`rollup_usage(day)` is an idempotent upsert keyed on `(product_id, day,
event_name)`; re-running it is safe, which is what lets it run on a schedule
(§8) without coordination.

## 6. API-key authentication with replay protection

Product telemetry authenticates with bearer API keys
(`supabase/functions/_shared/verify-api-key.ts`), and the key handling is the
part worth copying:

- **Hashed at rest.** The admin action (`api-keys/actions.ts`) mints
  `rcp_live_<random>`, stores only the SHA-256 hex and a 14-char display prefix,
  and returns the raw key exactly once. A database leak yields hashes, not keys.
- **Scoped.** Keys carry a `scopes` array validated against an allowlist; the
  verifier checks the required scope per endpoint (`"usage"`, `"error"`, ...).
- **Replay-bounded.** Each request carries a `nonce` and `timestamp`. The
  verifier rejects timestamps outside a 90-second skew window *and* inserts the
  nonce into a `UNIQUE(api_key_id, nonce)` table — a replayed request hits the
  unique violation and is rejected as a seen nonce. A sweep keeps the nonce
  table to ~3 minutes (twice the skew window).
- **Rate-limited.** Recent nonce rows double as a per-key request counter.
- **Revocable.** A `revoked_at` stamp fails auth without deleting the row.
- **Size-bounded.** The per-batch row caps bound row *count*, not payload size,
  so the verifier also rejects bodies over ~1 MB (Content-Length up front, a
  post-read length check to backstop chunked uploads).

The same module exposes a lighter read-only verifier (no nonce) for idempotent
pull feeds, where replay isn't a threat. And its error path distinguishes 4xx
from 5xx: 4xx messages are our own validation text and are returned verbatim,
while 5xx `VerifyError`s wrap raw DB errors — those are logged (and fanned out
to the alerting sink, §13) and the caller gets a generic `internal`.

The endpoints themselves are one config object each.
`_shared/batch-ingest.ts` owns the shared pipeline — auth → rate limit →
bound the batch → map+validate each item (dropping invalid rows) → persist →
`{ accepted }` — and an ingestion function like `ingest-usage/index.ts` supplies
only its scope, caps, per-row mapping, and insert. The per-row helpers
(`_shared/payload.ts`) are small and pure: `str` clamps untrusted strings,
`clampJson` bounds free-form jsonb payloads, `normalizeTimestamp` prevents one
malformed client timestamp from failing a whole batch insert.

## 7. Counted downloads via a private bucket + atomic RPC

`src/app/api/downloads/[version]/route.ts` never serves a file directly. It
looks up the published release, bumps the counter through the
`increment_download()` RPC (`0005_releases.sql`), then 307-redirects to a
60-second signed URL. The artifact bucket is private.

The counter is a single SQL `UPDATE ... set download_count = download_count + 1`,
not a read-modify-write in application code — two concurrent downloads can't
lose a count. That's the same "let the database do the increment atomically"
discipline applied to any balance or counter in the wider system.

## 8. Periodic jobs run in the database, not over HTTP

`0017_schedule_maintenance.sql` schedules `rollup_usage()` and
`sweep_ingest_nonces()` directly with `pg_cron`. Both are idempotent
`SECURITY DEFINER` functions living in this database, so scheduling them
in-process has fewer moving parts than routing through an edge function over
HTTP with a stored secret — and it can't be reached from outside.

The (re)scheduling block unschedules any prior job of the same name first, so
`supabase db reset` and re-applies stay clean. An edge-function entry point
remains for *external* schedulers/uptime monitors; either path alone suffices,
and running both is harmless because the jobs are idempotent.

## 9. On-demand revalidation for out-of-band writes

Admin actions revalidate in-process (§3). `src/app/api/revalidate/route.ts`
covers the other case — a content change that originates outside the app (a
future webhook). It's a POST gated by a shared secret (`REVALIDATE_SECRET`) that
revalidates a single path. Constant-time-ish secret comparison, same-origin path
guard, 401 on mismatch.

## 10. Explicit base-table grants beneath RLS

RLS decides which **rows** a role sees; a role must first hold the base-table
**privilege** to reach the table at all. The schema originally relied on
Supabase's hosted default privileges for that lower layer — and a local CLI
stack doesn't apply the same defaults, so the posture silently differed between
environments (a local `set role anon; select from products` failed with
`permission denied` even though the public-read *policy* was correct).

Migrations `0020`–`0022` make the lower layer explicit and uniform:

- **`0020`** grants `anon` SELECT on exactly the public-read tables (`products`,
  `posts`, `releases`) — the tables with a `_public_read` policy — and nothing
  else. Identity, API-key, and ingestion tables stay unreachable.
- **`0021`** grants `authenticated` the RLS-gated DML on the schema. RLS still
  decides every row, so this exposes nothing a policy wouldn't; without it,
  `requireRole()`'s own lookup dies on `permission denied` *before* RLS is
  consulted. Deliberately not `GRANT ALL`: that would include TRUNCATE, which
  RLS does **not** gate.
- **`0022`** does the same for `service_role`, which bypasses RLS but not
  grants — the gap surfaced as SQLSTATE 42501 in the health probe and was latent
  in the download route.

`supabase/tests/grants_test.sql` asserts the resulting matrix (and that every
base table in `public` has RLS enabled — the classic forgotten-new-table leak).

## 11. Privileged RPCs are locked to the service role

Postgres grants EXECUTE to PUBLIC by default, and PostgREST exposes every
`public` schema function as an RPC endpoint. That combination means a
`SECURITY DEFINER` maintenance function is, by default, callable by any
anonymous visitor: `sweep_ingest_nonces()` would let an attacker purge replay
nonces (defeating §6's replay protection), and `rollup_usage()` would let anyone
trigger a full firehose scan on demand.

`0018` (and `0019` for the rate limiter) revoke the PUBLIC grant and re-grant
EXECUTE to `service_role` only — pg_cron keeps working because the owner runs
the jobs. The carve-outs are as deliberate as the lockdown: the identity helpers
(`is_admin()`, …) must stay callable because RLS policies evaluate them as
`anon`/`authenticated`, and `increment_download()` stays public as the download
counter. `supabase/tests/function_privileges_test.sql` pins all of it.

## 12. Abuse control that fails open

The public marketing forms (pages omitted from this cut) write through
service-role server actions guarded by a honeypot — which does nothing against
a scripted client that costs money per submit (a confirmation email each time).
`0019` adds a fixed-window counter in the database: one `rate_limit_hits` table
keyed by `(bucket, window_start)`, one `SECURITY DEFINER` upsert
(`rate_limit_check`) that returns whether the caller is within budget. Fixed
window, not sliding: one round-trip, one row per caller per window — cheap and
good enough to blunt abuse.

The app-side helper (`src/lib/rate-limit.ts`) buckets by `<action>:<client-ip>`
and **fails open**: if the limiter RPC errors, the write goes through rather
than blocking a legitimate user — but it logs first (§13), because a silent
limiter outage means abuse protection quietly stopped working. Failing open
degrades to "no rate limit", not "no protection" — validation and the honeypot
still apply. `supabase/tests/rate_limit_test.sql` exercises the window
behaviour in-database.

## 13. Observability without an APM

The app deliberately swallows failures at the UX layer — a failed form insert
redirects to `?error=1`, a degrading read renders a partial page — which is the
right user experience and, unguarded, makes every failure invisible. The
observability layer keeps the degrade-gracefully behaviour and makes the
failures observable, with no agent or vendor SDK:

- **`logError(scope, error, meta)`** (`src/lib/observability.ts`) — one
  greppable stderr line per failure, which the host platform already captures.
  `selectOrLog` wraps the degrade-to-fallback read convention so a blanked page
  still leaves a record. Write actions log before surfacing
  (`admin.apiKeys.createApiKey`, `download.route.counter`, …).
- **An opt-in webhook sink.** When `ERROR_WEBHOOK_URL` is set, `logError` also
  POSTs to it (Slack-compatible payload) — scheduled with Next's `after()` so it
  never blocks a response, and coalesced per `(scope, message)` per minute so an
  error storm pages once, not hundreds of times. The edge functions fan their
  5xx to the same sink (`reportEdgeError`), so the product-facing telemetry
  intake can't 500 indefinitely while only the app's failures page anyone.
- **One correlation id, client → app → edge.** The middleware reuses-or-mints
  `x-rcp-request-id` per request, forwards it on the request headers, and echoes
  it on every response (including redirects). Server code re-enters the scope
  via `withRequestId` (`src/lib/request-context.ts`, `AsyncLocalStorage`), and
  `logError` folds the id into every line and sink payload — a burst of failures
  from one request is greppable as a unit.
- **A least-privilege health probe.** `src/app/api/health/route.ts` pings the DB
  with the *anon* client — the same read path real visitors hit — returns
  200/503 with `no-store`, and never leaks error detail; the failure goes
  through `logError` instead.

---

## What this cut leaves out

This is a subset chosen to demonstrate the patterns above, not a runnable
product:

- The marketing/auth/admin/dashboard **pages** are omitted; the `layout.tsx`
  guards and the `actions.ts` write paths are included because they're where
  the architecture lives. The pages are public content views, login and
  password-reset forms, CRUD editors over the content tables, and read views
  over the rollups (§5): they add lines, not decisions.
- The **app shell and styling** are omitted with them: no root
  `src/app/layout.tsx`, `globals.css`, or Tailwind setup. The three shared
  components that do ship (`workspace-shell`, `nav-link`, `sign-out-button`)
  are there because the guarded layouts render them; their class names
  (`bg-cream`, `text-clay`, …) refer to theme tokens defined in the omitted
  stylesheet.
- **`src/lib/types.ts`** ships only its API-key slice (`API_KEY_SCOPES`, the
  `ApiKey` row type), which `src/app/admin/api-keys/actions.ts` imports. The
  rest of the full app's hand-written row types go with the omitted pages.
- Only **one ingestion function** (`ingest-usage`) ships, as the worked example
  of the shared `batch-ingest` harness (§6). Error, feedback, and wiki
  ingestion are further config objects on the same pipeline; including them
  would be repetition.
- The **public form actions** that consult the rate limiter (§12) are part of
  the omitted marketing pages; the limiter itself (`0019`,
  `src/lib/rate-limit.ts`) is included because the pattern is where the
  decisions live.
- Migration numbers preserve the production app's original sequence, so there
  are **gaps** (0008–0016 are not in this cut). That's expected, and the
  idempotent runner tolerates it.
- No CI, no `package-lock.json`, no real seed data. The `lint` and `test:e2e`
  scripts in `package.json` have no ESLint config, Playwright config, or e2e
  specs behind them in this cut.

## Verifying the claims

```bash
npm test                      # pure-logic invariants + source-level wiring guards
supabase db reset             # applies every migration in order
psql "$DATABASE_URL" -f supabase/tests/rls_test.sql                  # §2, §5: RLS predicates & firehose isolation
psql "$DATABASE_URL" -f supabase/tests/grants_test.sql               # §10: grant matrix + blanket RLS coverage
psql "$DATABASE_URL" -f supabase/tests/function_privileges_test.sql  # §11: privileged RPC lockdown
psql "$DATABASE_URL" -f supabase/tests/rate_limit_test.sql           # §12: fixed-window behaviour
```

The SQL suites prove the load-bearing isolation claims at the database, not in
app code: drafts and soft-deleted rows are invisible to `anon` and `anon`
cannot write (§2), the usage firehose is unreadable by `authenticated` (§5),
the grant matrix matches §10, and the privileged RPCs are locked per §11. Each
file runs in a rolled-back transaction and raises on failure, so a clean exit
is a pass.
