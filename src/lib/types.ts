// Hand-written row types. Only the API-key slice ships in this cut; the
// full app's content, release, and telemetry types are omitted with the pages
// that use them.

// ── API keys ───────────────────────────────────────────────────────────────
// Mirrors the comment on `api_keys.scopes` in 0006. `verify-api-key.ts`
// enforces the scope at request time; this list bounds what the admin form
// may grant.
export const API_KEY_SCOPES = [
  "usage",
  "error",
  "feedback:write",
  "blog:read",
  "wiki:write",
  "wiki:read",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKey {
  id: string;
  product_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
