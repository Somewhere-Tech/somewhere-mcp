import type {
  SupportTicketRestRequest,
  SupportTicketToolName,
} from './types/support-ticket';

/** Keep every MCP support-ticket mode on the canonical worker route. */
export function buildSupportTicketRestRequest(
  toolName: SupportTicketToolName,
  args: Record<string, unknown>,
): SupportTicketRestRequest {
  if (toolName === 'support_ticket' && args.action === 'resolve') {
    const response = typeof args.response === 'string' && args.response.trim()
      ? args.response.trim()
      : undefined;
    return {
      method: 'PATCH',
      path: `/v1/platform-feedback/${encodeURIComponent(String(args.ticket_id || ''))}`,
      body: {
        status: 'resolved',
        ...(response ? { response } : {}),
      },
    };
  }

  if (toolName === 'support_ticket' && typeof args.ticket_id === 'string' && args.ticket_id) {
    return {
      method: 'GET',
      path: `/v1/platform-feedback/${encodeURIComponent(args.ticket_id)}`,
    };
  }

  if (toolName === 'support_ticket' && typeof args.message === 'string' && args.message) {
    return {
      method: 'POST',
      path: '/v1/platform-feedback',
      body: {
        message: args.message,
        project_id: args.project_id,
        context: args.context,
        parent_id: args.parent_id,
      },
    };
  }

  const params = new URLSearchParams();
  if (typeof args.status === 'string') params.set('status', args.status);
  if (typeof args.limit === 'number') params.set('limit', String(args.limit));
  const qs = params.toString();
  return {
    method: 'GET',
    path: `/v1/platform-feedback${qs ? `?${qs}` : ''}`,
  };
}
