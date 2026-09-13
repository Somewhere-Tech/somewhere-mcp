export type SupportTicketToolName = 'support_ticket';

export interface SupportTicketRestRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: {
    message?: unknown;
    project_id?: unknown;
    context?: unknown;
    parent_id?: unknown;
    status?: 'resolved';
    response?: string;
  };
}
