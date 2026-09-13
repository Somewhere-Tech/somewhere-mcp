export interface AnonymousClaimPrompt {
  prompt_user: true;
  reason: 'anonymous_account_with_work';
  message: string;
  action: {
    tool: 'connector_link_email';
    requires: 'user_email';
  };
  dashboard_url: string;
}

const WORK_MUTATION_TOOLS = new Set([
  'project_create',
  'project_deploy',
  'project_patch',
  'project_promote',
  'project_restore',
  'project_rollback',
  'db_migrate',
  'db_batch',
  'fs_write',
  'fs_upload',
  'env_set',
]);

export function isAnonymousClaimPromptCandidate(toolName: string): boolean {
  return WORK_MUTATION_TOOLS.has(toolName);
}

export function anonymousClaimPrompt(
  toolName: string,
  platformMeEnvelope: unknown,
): AnonymousClaimPrompt | null {
  if (!isAnonymousClaimPromptCandidate(toolName)) return null;
  if (!platformMeEnvelope || typeof platformMeEnvelope !== 'object') return null;
  const outer = platformMeEnvelope as { data?: unknown };
  if (!outer.data || typeof outer.data !== 'object') return null;
  const account = outer.data as { user?: unknown; stats?: unknown };
  if (!account.user || typeof account.user !== 'object') return null;
  if (!account.stats || typeof account.stats !== 'object') return null;
  const user = account.user as { email?: unknown; signup_source?: unknown };
  const stats = account.stats as { projects?: unknown };
  const isAnonymousConnector = (
    user.signup_source === 'mcp_connector'
    && typeof user.email === 'string'
    && user.email.endsWith('@anon.somewhere.tech')
  );
  // Temporary deploys use their token-bound claim_url, not the MCP email-link
  // tool. Their dashboard prompt is handled separately if they have a browser
  // session; never recommend an action that cannot bind their temp token.
  if (!isAnonymousConnector || typeof stats.projects !== 'number' || stats.projects <= 0) return null;
  return {
    prompt_user: true,
    reason: 'anonymous_account_with_work',
    message: 'This work is stored but remains tied to this guest session. connector_link_email requires an email supplied by the user and sends a human-verification link; recovery on another device becomes available only after verification.',
    action: { tool: 'connector_link_email', requires: 'user_email' },
    dashboard_url: 'https://somewhere.tech/auth?intent=signup&switch=1&claim=1',
  };
}
