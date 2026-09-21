/**
 * The connected-account answer for the `account` tool
 * (tsk_cb44a06846b94897b258e493914eb144).
 *
 * WHY THIS EXISTS. An agent asked "which account am I connected as?" and had no
 * tool for it, so it guessed /v1/whoami, /me, /user and /account (all
 * ROUTE_FORBIDDEN), then inferred an identity from the project list and the
 * device keys. Guessing routes and inferring identity from side effects is the
 * failure; one obvious no-argument read answers it.
 *
 * NO NEW AUTHORITY. GET /v1/auth/platform-me already resolves exactly the
 * credentials the MCP surfaces carry — token kinds 'platform' and 'mcp_oauth',
 * key kinds 'developer' and 'cli_pair' (worker routes/auth-platform.ts). This
 * module only PROJECTS that verified answer. It never takes a target account,
 * so there is nothing to widen.
 *
 * ALLOWLIST, NOT A FILTER. platform-me's envelope carries more than identity —
 * is_admin, derived auth-method booleans, beta and onboarding state, account
 * stats. This builds a fresh object from named fields, so a new field upstream
 * can never appear here by accident, which a redaction list would eventually
 * let through. (The route SELECTs password_hash to derive one of those
 * booleans; it does not emit it. The allowlist is not what stops that.)
 *
 * NOT auth_me. That tool takes a required app_token and reads /v1/auth/me: the
 * END USER of a customer's app. This is the DEVELOPER ACCOUNT the MCP session
 * is connected as. Two different questions; both stay.
 */

/** Anonymous connector sessions get a synthetic address on this domain. The
 *  same rule is applied in anonymous-claim-prompt.ts and, worker-side, in
 *  utils/managed-email-lifecycle.ts — change it in all three or none. */
const ANONYMOUS_EMAIL_DOMAIN = '@anon.somewhere.tech';

export interface AccountIdentity {
  /** Platform account id — the developer account, not an app user. */
  id: string;
  /** Null for an anonymous connector session, whose address is synthetic. */
  email: string | null;
  name: string | null;
  username: string | null;
  /** True when this is an unclaimed connector session. */
  anonymous: boolean;
  /** Whether the address above has been confirmed by the person who owns it. */
  email_verified: boolean;
  /** Present only when platform-me already resolved it; never inferred. */
  tier?: string;
  /** The one sentence a caller can repeat back to the person who asked. */
  summary: string;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/**
 * Project the platform-me envelope. Returns null when the envelope is not the
 * shape this depends on — the caller surfaces the upstream response unchanged
 * rather than inventing an identity, because a wrong answer to "who am I" is
 * worse than no answer.
 */
export function projectAccountIdentity(envelope: unknown): AccountIdentity | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const data = (envelope as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const user = (data as { user?: unknown }).user;
  if (!user || typeof user !== 'object') return null;

  const row = user as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;

  const rawEmail = str(row.email);
  const anonymous = rawEmail !== null && rawEmail.endsWith(ANONYMOUS_EMAIL_DOMAIN);
  const email = anonymous ? null : rawEmail;
  const name = str(row.name);
  const username = str(row.username);
  // platform-me sends 0/1 from SQLite; anything else is treated as unverified.
  const email_verified = row.email_verified === true || row.email_verified === 1;
  const tier = str(row.effective_tier) ?? str(row.tech_tier);

  return {
    id,
    email,
    name,
    username,
    anonymous,
    email_verified,
    ...(tier ? { tier } : {}),
    summary: accountSummary({ anonymous, email, name, username, email_verified }),
  };
}

function accountSummary(account: {
  anonymous: boolean;
  email: string | null;
  name: string | null;
  username: string | null;
  email_verified: boolean;
}): string {
  if (account.anonymous) {
    return 'Connected as an anonymous guest session. It has no email address yet, '
      + 'so the work it owns cannot be recovered on another device until someone links one.';
  }
  const label = account.name ?? account.username ?? account.email;
  const who = label && account.email && label !== account.email
    ? `${label} (${account.email})`
    : label ?? 'an account with no email on file';
  return account.email_verified
    ? `Connected as ${who}. The email address is verified.`
    : `Connected as ${who}. The email address is NOT verified yet.`;
}
