export type ProjectDeployScope = 'functions' | 'static' | undefined;

export type NormalizedProjectDeployFiles =
  | { ok: true; files: Record<string, string> | undefined }
  | { ok: false; message: string };

/** MCP-side defense in depth for the worker's functions-only deploy contract. */
export function normalizeProjectDeployFiles(
  files: Record<string, string> | undefined,
  functions: unknown,
  scope: ProjectDeployScope,
): NormalizedProjectDeployFiles {
  if (files !== undefined || scope !== 'functions') return { ok: true, files };

  if (
    !functions ||
    typeof functions !== 'object' ||
    Array.isArray(functions) ||
    Object.keys(functions).length === 0 ||
    Object.values(functions).some((value) => typeof value !== 'string')
  ) {
    return {
      ok: false,
      message: 'When files is omitted with scope:"functions", functions must be a non-empty object mapping paths to source.',
    };
  }

  return { ok: true, files: {} };
}
