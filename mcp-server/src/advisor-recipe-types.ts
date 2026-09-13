/** Two supported recipe selections; these are proposed source, never deployed state. */
export type AdvisorRecipe =
  | { kind: 'checkout_fulfillment'; table: string }
  | { kind: 'magic_link_browser' };
export interface AdvisorAction { tool: string; arguments: Record<string, unknown> }
export interface AdvisorComponent {
  decision: string;
  status: 'provided' | 'needs_input' | 'unavailable';
  explanation: string;
}
export interface AdvisorComposition {
  prose: string;
  components: AdvisorComponent[];
  recipes: AdvisorRecipe[];
  actions: AdvisorAction[];
}
export interface AdvisorRenderedRecipe { explanation: string; files: { path: string; source: string }[] }
