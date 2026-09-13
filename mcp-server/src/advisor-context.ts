export interface AdvisorRunContext {
  command: string;
  args: string[];
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
  timestamp: string;
}

export interface AdvisorClientContext {
  project_ref?: string;
  last_run?: AdvisorRunContext;
  file?: { path: string; content: string };
}

const TEXT_LIMIT = 8_000;
const TAIL_LIMIT = 4_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.slice(0, limit);
  return trimmed ? redactAdvisorContextText(trimmed) : null;
}

/** The server repeats client redaction before context reaches the advisor or audit log. */
export function redactAdvisorContextText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s'"`]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:smt|smtr|sk|pk|whsec)_[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|secret|password)\s*([:=])\s*([^\s,;]+)/gi,
      (_match, name: string, separator: string) => `${name}${separator} [REDACTED]`,
    )
    .replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=).*$/gm, '$1[REDACTED]');
}

/** Keep only the documented envelope; snapshots remain untrusted data. */
export function sanitizeAdvisorContext(value: unknown): AdvisorClientContext | null {
  const input = asRecord(value);
  if (!input) return null;
  const context: AdvisorClientContext = {};
  const projectRef = text(input.project_ref, 500);
  if (projectRef) context.project_ref = projectRef;

  const run = asRecord(input.last_run);
  if (run) {
    const command = text(run.command, 500);
    const args = Array.isArray(run.args)
      ? run.args.filter((arg): arg is string => typeof arg === 'string').slice(0, 64).map((arg) => redactAdvisorContextText(arg.slice(0, 1_000)))
      : [];
    const exitCode = typeof run.exit_code === 'number' && Number.isFinite(run.exit_code)
      ? Math.round(run.exit_code)
      : null;
    const stdout = text(run.stdout_tail, TAIL_LIMIT);
    const stderr = text(run.stderr_tail, TAIL_LIMIT);
    const timestamp = text(run.timestamp, 100);
    if (command && exitCode !== null && stdout !== null && stderr !== null && timestamp) {
      context.last_run = { command, args, exit_code: exitCode, stdout_tail: stdout, stderr_tail: stderr, timestamp };
    }
  }

  const file = asRecord(input.file);
  if (file) {
    const path = text(file.path, 1_000);
    const content = text(file.content);
    if (path && content !== null) context.file = { path, content };
  }
  return Object.keys(context).length > 0 ? context : null;
}

export function formatAdvisorContext(context: AdvisorClientContext | null): string | null {
  return context ? JSON.stringify(context) : null;
}
