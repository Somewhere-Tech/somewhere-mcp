export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: JsonSchemaProperty | boolean;
  required?: string[];
  maxItems?: number;
  oneOf?: JsonSchemaProperty[];
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolMetadata {
  'openai/fileParams'?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
  };
  outputSchema?: {
    type: 'object';
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
  _meta?: ToolMetadata;
}

export type CanonicalToolSurface = 'full' | 'connector' | 'chatgpt';
export type ToolVisibility = 'authenticated' | 'public' | 'admin';

export interface ToolUpstreamResult {
  status: number;
  data: unknown;
}

export interface ToolExecutionRuntime {
  callApi(method: string, path: string, body?: unknown): Promise<ToolUpstreamResult>;
}

export interface ToolProtocolMetadata {
  oauthScopes?: readonly string[];
  surfaceAnnotations?: Partial<Record<CanonicalToolSurface, ToolAnnotations>>;
  surfaceDescriptions?: Partial<Record<CanonicalToolSurface, string>>;
}

export interface ToolSpec<
  TRuntime extends ToolExecutionRuntime = ToolExecutionRuntime,
  TResult = ToolUpstreamResult,
> {
  definition: ToolDefinition;
  annotations: ToolAnnotations;
  group: string;
  core: boolean;
  coreRank?: number;
  visibility: ToolVisibility;
  paid: boolean;
  surfaces: readonly CanonicalToolSurface[];
  /**
   * A DEPRECATED ALIAS of another tool: still registered and still callable on
   * every surface it lists, but NOT advertised in tools/list or the catalog.
   *
   * This is how a surface gets consolidated without breaking anyone (rule 9 —
   * no new guardrail may block existing working code). The old name keeps
   * working for every agent and customer that already calls it; only the
   * advertised surface shrinks, so new callers see one tool instead of three.
   * `aliasOf` names the tool that replaced it, for the deprecation notice.
   */
  aliasOf?: string;
  /**
   * WIRED BUT NOT ADVERTISED: excluded from tools/list and the catalog on
   * every surface, but still callable for existing callers (rule 9), exactly
   * like an `aliasOf` spec. For features the founder wants off the visible
   * surface without unwiring them — see dashboard/HIDDEN-FEATURES.md.
   */
  hidden?: boolean;
  protocol?: ToolProtocolMetadata;
  execute(runtime: TRuntime, args: Record<string, unknown>): Promise<TResult>;
}

export function defineDomainToolSpecs<const T extends readonly ToolSpec[]>(specs: T): T {
  return specs;
}

export function publicToolDefinitions(specs: readonly { definition: ToolDefinition }[]): ToolDefinition[] {
  return specs.map((spec) => spec.definition);
}
