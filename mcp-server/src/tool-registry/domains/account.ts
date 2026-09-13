import { defineDomainToolSpecs } from '../types';

export const ACCOUNT_TOOL_SPECS = defineDomainToolSpecs([
  {
    definition: {
      name: 'connector_link_email',
      description: `Save the current connector session's work to a recoverable account. This requires an email address supplied by the user and sends that address a one-click verification link. Nothing is merged or unlocked until the human clicks: before verification the email remains unverified; afterward the account is saved, or the session is merged into an existing account for that email. Returns { sent: true }. Repeated calls are rate-limited and become a no-op once the account is saved.`,
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: "The user's email address to send the one-click magic link to." },
        },
        required: ['email'],
      },
    },
    annotations: { title: "Send an account recovery link", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'account',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceAnnotations: { chatgpt: { openWorldHint: true }, connector: { destructiveHint: true } }, surfaceDescriptions: { connector: "Send an account recovery verification link to an email address supplied by the user. Account verification or merging occurs only after the recipient confirms the link; this call sends the email and records the pending request." }, oauthScopes: ['mcp'] },
    execute: (runtime, args) => runtime.callApi('POST', '/v1/oauth/connector/link-email', {
      email: args.email,
    }),
  },
] as const);
