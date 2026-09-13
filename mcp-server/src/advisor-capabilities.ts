/** Capability dependencies accompany an operation's syntax. These are not
 * question-specific answers. Canonical sections remain the prose owner; the
 * two temporary runtime-backed constraints below have real-source fixtures
 * and can move to those sections when the documentation owner adds them. */
export interface AdvisorKnowledgeSelection {
  selected: string[];
  workflows?: string[];
  required?: string[];
  omitted: Array<{ id: string; reason: 'budget' | 'unavailable' }>;
}

export function advisorSections(body: string): string[] {
  const sections: string[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!sections.length || (!fenced && /^#{1,3} /.test(line))) sections.push(line);
    else sections[sections.length - 1] += '\n' + line;
  }
  return sections;
}

interface RequiredSection { topic: string; heading: string }
interface CapabilityDependency {
  id: string;
  requested: (question: string, topics: string[]) => boolean;
  sections: RequiredSection[];
  evidence: string;
}

const DEPENDENCIES: CapabilityDependency[] = [
  {
    id: 'managed-schema',
    requested: (question, topics) => topics.includes('sw.db')
      && /\bschema\b|\bmanaged\b|\b(?:owner|shared|serverOnly)\s*\(|\barchitecture\b|\bfile shapes?\b|\bimplementation\b/i.test(question),
    sections: [{ topic: 'sw.db', heading: '## Start with the schema file — db/schema.ts' }],
    // Source: db-schema-deploy/differ.ts managed-scope + retention guards;
    // extract-schema-ts.ts readTable grammar. Tests exercise both directions.
    evidence: 'Managed schema capability constraints: A NEW table can use owner(), shared(), or serverOnly(). Changing the access scope or owner column of an EXISTING managed table is refused by production deploy, including an empty table. removedTable() retains the table and its scope; redeclaring it during retention must restore that same scope, so remove-and-recreate is not a scope-conversion workaround. A new differently named table is a separate table, not an in-place conversion; do not claim existing data or references migrate automatically. The schema file is a closed literal declaration grammar, not arbitrary TypeScript. Object-property trailing commas and trailing commas after nonempty table/helper/schema arguments are accepted; empty argument slots and extra arguments are refused.',
  },
  {
    id: 'scheduled-invocation',
    requested: (_question, topics) => topics.includes('cron'),
    sections: [{ topic: 'sw.jobs', heading: '## Job handler function' }],
    // Source: dispatch-crons enqueues source cron; job workflow signs that
    // source and target; runtime/jobs verifies the proof through the API.
    evidence: 'Scheduled invocation capability: Cron deliveries run through the signed job delivery path. A cron handler can call await sw.jobs.verifyInvocation(req) before trusting the payload; false must be refused. There is no sw.cron.verifyInvocation method. A source header alone is not authorization. Use the verifier rather than trusting the source header or an app-user session; keep handlers idempotent for repeated work. This proves platform delivery, not a signed-in app user.',
  },
];

export function advisorCapabilityDependencies(
  question: string,
  selectedTopics: string[],
  topics: Record<string, string>,
): { text: string; sectionIds: Set<string>; selection: AdvisorKnowledgeSelection } {
  const text: string[] = [];
  const sectionIds = new Set<string>();
  const selection: AdvisorKnowledgeSelection = { selected: [], omitted: [] };
  for (const dependency of DEPENDENCIES) {
    if (!dependency.requested(question, selectedTopics)) continue;
    selection.selected.push(`capability:${dependency.id}`);
    if (dependency.evidence) text.push(`## Required capability evidence\n${dependency.evidence}`);
    for (const { topic, heading } of dependency.sections) {
      const id = `${topic}:${heading}`;
      const section = advisorSections(topics[topic] ?? '').find((body) => body.split('\n')[0] === heading);
      sectionIds.add(id);
      if (section) {
        selection.selected.push(id);
        text.push(`## Required reference: ${topic}\n${section}`);
      } else {
        selection.omitted.push({ id, reason: 'unavailable' });
        text.push(`Required reference unavailable: ${id}. Do not invent its syntax or claim that its absence means the capability is unsupported.`);
      }
    }
  }
  return { text: text.join('\n\n'), sectionIds, selection };
}
