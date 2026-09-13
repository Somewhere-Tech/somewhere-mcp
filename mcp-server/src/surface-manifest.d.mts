export type ToolSurface = 'chatgpt' | 'connector' | 'full';

export interface SurfaceManifest {
  readonly endpoint: string;
}

interface SurfaceToolSpec {
  definition: { name: string };
  visibility: 'authenticated' | 'public' | 'admin';
  surfaces: readonly ToolSurface[];
  /** Deprecated alias of another tool: callable, not advertised. */
  aliasOf?: string;
}

export const SURFACE_MANIFESTS: Readonly<Record<ToolSurface, SurfaceManifest>>;
export const SURFACE_NAMES: readonly ToolSurface[];
export function advertisedToolNames(surface: ToolSurface, toolSpecs: readonly SurfaceToolSpec[]): Set<string>;
export function executableToolNames(surface: ToolSurface, toolSpecs: readonly SurfaceToolSpec[]): Set<string>;
export function aliasToolNames(surface: ToolSurface, toolSpecs: readonly SurfaceToolSpec[]): Set<string>;
export function surfaceAllowsTool(surface: ToolSurface, toolName: string, toolSpecs: readonly SurfaceToolSpec[]): boolean;
export function toolReferences(text: string, registeredToolNames: Iterable<string>): string[];
export function constrainTextToSurface(text: string, surface: ToolSurface, registeredToolNames: Iterable<string>, allowedToolNames: Iterable<string>): string;
