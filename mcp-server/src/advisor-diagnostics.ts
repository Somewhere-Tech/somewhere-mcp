import type { AdvisorKnowledgeSelection } from './advisor-capabilities';

export interface AdvisorDiagnostics {
  requested_model?: string;
  served_model?: string;
  served_tier?: string;
  usage_status?: 'unconfirmed' | 'token_estimate' | 'unpriced_model';
  usage?: { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number };
  context_ms: number;
  context_reads: Array<{ path: string; duration_ms: number; status: number | null; outcome: string }>;
  prompt_chars: number;
  topics: string[];
  knowledge?: AdvisorKnowledgeSelection;
  attempts: Array<{ duration_ms: number; status: number | null; outcome: string; request_id: string | null }>;
}

/** All snapshot reads share one deadline, including project resolution. Each
 * still uses the caller's credential; diagnostics contain no response bodies. */
export function advisorContextFetcher(fetcher: Fetcher, diagnostics: AdvisorDiagnostics): Fetcher {
  const deadline = Date.now() + 1_500;
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const startedAt = Date.now();
      const row = { path: new URL(request.url).pathname, duration_ms: 0, status: null as number | null, outcome: 'timeout' };
      diagnostics.context_reads.push(row);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (Date.now() >= deadline) throw new Error('Context deadline');
        return await Promise.race([
          (async () => {
            const response = await fetcher.fetch(new Request(request, { signal: controller.signal }));
            // Include response consumption in the deadline, not just headers.
            const body = await response.text();
            if (controller.signal.aborted) throw new Error('Context deadline');
            row.status = response.status;
            row.outcome = response.ok ? 'loaded' : 'unavailable';
            return new Response(body, { status: response.status, headers: response.headers });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Context deadline')); }, deadline - Date.now());
          }),
        ]);
      } catch (error) {
        if (!controller.signal.aborted && Date.now() < deadline) row.outcome = 'unavailable';
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        row.duration_ms = Date.now() - startedAt;
      }
    },
  } as Fetcher;
}
