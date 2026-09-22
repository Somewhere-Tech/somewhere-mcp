export interface ProjectNotice {
  id: string;
  title: string;
  body_md: string;
  severity: 'info' | 'action_required' | 'critical';
  action_hint: string;
  target_runtime_version: number;
  current_runtime_version: number | null;
  project_id: string;
  project_name?: string;
  project_subdomain?: string;
  resurface_interval_ms: number;
  created_at: number;
}

export interface ProjectNoticePayload {
  project_id?: string;
  notices: ProjectNotice[];
  newly_delivered_notice_ids: string[];
}

export type ProjectNoticeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ProjectNoticeToolResult {
  content: ProjectNoticeContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

function compactLine(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function severityLabel(severity: ProjectNotice['severity']): string {
  return severity === 'action_required' ? 'action required' : severity;
}

export function projectNoticeBanner(notices: ProjectNotice[]): string | null {
  const first = notices[0];
  if (!first) return null;
  const more = notices.length > 1 ? ` (+${notices.length - 1} more)` : '';
  const project = first.project_subdomain ? ` · ${compactLine(first.project_subdomain, 80)}` : '';
  return `[somewhere notice · ${severityLabel(first.severity)}${project}] ${compactLine(first.title, 120)} — ${compactLine(first.body_md, 300)} ${compactLine(first.action_hint, 220)}${more}`;
}

export function projectNoticeConnectInstructions(payload: ProjectNoticePayload): string {
  if (payload.notices.length === 0) return '';
  const lines = payload.notices.slice(0, 10).map((notice) => {
    const project = notice.project_subdomain ? `, project=${compactLine(notice.project_subdomain, 80)}` : '';
    return `[somewhere notice due: severity=${severityLabel(notice.severity)}${project}, project_id=${notice.project_id}, notice_id=${notice.id}] `
      + 'The complete notice is available through catalog with project_id. project_notice_acknowledge records acknowledgement or snooze delivery state without resolving the underlying project issue.';
  });
  const more = payload.notices.length > 10
    ? `\n${payload.notices.length - 10} additional notices are due and are available through catalog with the relevant project_id.`
    : '';
  return `${lines.join('\n')}\n${more}\n\n`;
}

function noticeListBlock(payload: ProjectNoticePayload): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: JSON.stringify({
      project_notices: {
        project_id: payload.project_id,
        count: payload.notices.length,
        notices: payload.notices,
      },
    }, null, 2),
  };
}

export function injectProjectNotices(
  result: ProjectNoticeToolResult,
  toolName: string,
  payload: ProjectNoticePayload,
): ProjectNoticeToolResult {
  const newlyDelivered = new Set(payload.newly_delivered_notice_ids);
  const bannerNotices = payload.notices.filter((notice) => newlyDelivered.has(notice.id));
  const banner = projectNoticeBanner(bannerNotices);
  const listRequested = toolName === 'catalog' || toolName === 'docs';
  const content = [
    ...(banner ? [{ type: 'text' as const, text: banner }] : []),
    ...result.content,
    ...(listRequested ? [noticeListBlock(payload)] : []),
  ];

  let structuredContent = result.structuredContent;
  if (listRequested && structuredContent && typeof structuredContent === 'object' && !Array.isArray(structuredContent)) {
    structuredContent = {
      ...(structuredContent as Record<string, unknown>),
      project_notices: payload.notices,
    };
  }

  return {
    ...result,
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}
