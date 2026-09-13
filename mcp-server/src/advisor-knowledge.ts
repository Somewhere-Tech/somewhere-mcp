import { advisorWorkflows } from './advisor-workflows';
import { ADVISOR_TOPIC_DEPENDENCIES } from './platform-help';
import { advisorCapabilityDependencies, advisorSections, type AdvisorKnowledgeSelection } from './advisor-capabilities';
import type { ToolDefinition } from './tool-registry/types';

export type AdvisorTopicDependencies = Readonly<Record<string, readonly { topic: string; heading?: string }[]>>;

interface KnowledgeTool {
  name: string;
  description: string;
  inputSchema?: ToolDefinition['inputSchema'];
}

export interface AdvisorKnowledge {
  text: string;
  topics: string[];
  selection: AdvisorKnowledgeSelection;
}

export function advisorFallbackText(code: string, topics: string[], outcome?: string): string {
  const reason = outcome === 'not_configured' || outcome === 'invalid_parameter'
    ? 'Advisor is misconfigured and cannot answer right now.'
    : code === 'ADVISOR_TIMEOUT'
      ? 'Advisor is slow: this question exceeded its response budget.'
      : code === 'ADVISOR_INCOMPLETE_RESPONSE'
        ? 'Advisor is degraded: the answer was cut short, so it has not been presented as complete.'
        : 'Advisor is unavailable: it did not return a complete answer.';
  const commands = topics.filter((topic) => !['cli', 'guarantees', 'getting-started'].includes(topic)).slice(0, 3);
  return `${reason} Use ${commands.length ? commands.map((topic) => `\`somewhere docs ${topic}\``).join(', ') : '`somewhere docs getting-started`'} for the exact contracts, or read https://somewhere.tech/docs.txt. These references do not depend on the advisor. Repeating the same request now may hit the same failure.`;
}

const STOP_WORDS = new Set('a an the and or to of in on for with is are as at by be this that it i my your how what exact current give only use using project platform somewhere have from can do does'.split(' '));

function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_.-]+/g) ?? [])
    .map((word) => word.replace(/[_.-]+$/, ''))
    .filter((word) => !STOP_WORDS.has(word)))];
}

/** Select complete documentation sections, not a prefix of the million-character
 * corpus. No model, vector service, or project data is involved in retrieval. */
export function selectAdvisorKnowledge(
  question: string,
  topics: Record<string, string>,
  tools: KnowledgeTool[],
  options: { caller?: string; dependencies?: AdvisorTopicDependencies } = {},
): AdvisorKnowledge {
  // Native browser history is not a request for the platform automation tool.
  // Keep the original question intact for the answer; only retrieval sees this.
  const retrievalQuestion = question.replace(/\bbrowser\s+(?:history|back button|address bar)\b/gi, '');
  const query = terms(retrievalQuestion);
  const workflows = advisorWorkflows(retrievalQuestion);
  const workflowTopics = new Set(workflows.flatMap(workflow => [...workflow.topics]));
  const aliases: Record<string, RegExp> = {
    cron: /\bcron\b/i,
    payments: /\b(?:payments?|stripe|checkout)\b/i,
    'sw.db': /\b(?:database|sw\.db|serverOnly)\b/i,
    'sw.auth': /\b(?:oauth|signup|login|authentication|magic[ -]links?|verifyOtp|signInWithOtp|setSessionCookies)\b/i,
    'sw.fs': /\b(?:uploads?|files|sw\.fs)\b/i,
  };
  const pages = Object.entries(topics).filter(([name]) => name !== 'api-surface');
  const weights = new Map(query.map((word) => [word,
    Math.log(1 + pages.length / (1 + pages.filter(([, body]) => body.toLowerCase().includes(word)).length)),
  ]));
  const score = (text: string): number => {
    const lower = text.toLowerCase();
    return query.reduce((sum, word) => sum + (lower.includes(word) ? weights.get(word)! : 0), 0);
  };
  const namesTopic = (name: string): boolean => (name !== 'browser' || !workflowTopics.has('sw.auth') || /somewhere browser|browser (?:tool|test|verification|automation)|--session/i.test(question)) && (workflowTopics.has(name) || query.includes(name.toLowerCase())
    || Boolean(aliases[name]?.test(question))
    || (name.startsWith('sw.') && query.includes(name.slice(3).toLowerCase()))
    || (name.startsWith('recipe-') && query.includes(name.slice('recipe-'.length))));
  const scoredPages = pages.map(([name, body]) => ({
    name, body, named: namesTopic(name), score: (namesTopic(name) ? 50 : 0) + score(name) * 4 + score(body),
  })).filter((page) => page.score > 0).sort((a, b) => b.score - a.score);
  // Explicit domains establish the scope. A focused question does not need
  // unrelated pages merely because common words gave them a positive score.
  // Broad questions without a named domain retain corpus-wide discovery.
  const focused = scoredPages.filter((page) => page.named);
  const navigationTopics = new Set(['cli', 'sdk', 'sdks', 'guarantees', 'getting-started', 'setup', 'troubleshooting', 'common-mistakes', 'architecture-patterns']);
  const hasDomainFocus = focused.some((page) => !navigationTopics.has(page.name) && !page.name.startsWith('recipe-'));
  const ranked = (hasDomainFocus ? focused : scoredPages).slice(0, 6);
  // An architecture answer needs the setup/readback commands too. Their short
  // descriptions can otherwise lose to large descriptions repeating the query.
  const companions = new Set([
    ...(aliases.payments.test(question) ? ['payments_checkout', 'payments_onboard', 'payments_status'] : []),
    ...(workflowTopics.has('cron') ? ['cron_create', 'cron_list', 'cron_run'] : []),
    ...(aliases['sw.db'].test(question) ? ['db_import', 'db_migrate', 'db_query'] : []),
  ]);
  // Recognized task components are required scope even if optional relevance
  // ranking has filled its six page slots with other named domains.
  const requiredTopics = [...new Set([...ranked.map(page => page.name), ...workflowTopics])];
  const dependencies = advisorCapabilityDependencies(question, requiredTopics, topics);
  for (const topic of workflowTopics) {
    if (!topics[topic]) dependencies.selection.omitted.push({ id: `topic:${topic}`, reason: 'unavailable' });
  }
  dependencies.selection.workflows = workflows.map(workflow => workflow.id);
  const selected: Array<{ text: string; ids: string[] }> = [{ text: dependencies.text, ids: [...dependencies.selection.selected] }];
  const dependencyTopics = [...requiredTopics];
  const visitedTopics = new Set<string>();
  for (const topic of dependencyTopics) {
    if (visitedTopics.has(topic)) continue;
    visitedTopics.add(topic);
    if (visitedTopics.size > 64) { dependencies.selection.omitted.push({ id: `topic:${topic}`, reason: 'budget' }); continue; }
    for (const reference of (options.dependencies ?? ADVISOR_TOPIC_DEPENDENCIES)[topic] ?? []) {
      // A headed reference imports one contract, not every dependency of its
      // topic. Explicit roots and whole-topic references still expand normally.
      if (reference.heading === undefined && !visitedTopics.has(reference.topic) && !dependencyTopics.includes(reference.topic)) dependencyTopics.push(reference.topic);
      const sections = advisorSections(topics[reference.topic] ?? '').filter(section => section.length > 0
        && (reference.heading === undefined || section.split('\n')[0] === reference.heading));
      if (!sections.length) dependencies.selection.omitted.push({ id: `${reference.topic}:${reference.heading ?? '*'}`, reason: 'unavailable' });
      for (const section of sections) {
        const id = `${reference.topic}:${section.split('\n')[0]}`;
        if (dependencies.sectionIds.has(id)) continue;
        dependencies.sectionIds.add(id);
        dependencies.selection.selected.push(id);
        selected.push({ text: `## Required reference: ${reference.topic}\n${section}`, ids: [id] });
      }
    }
  }
  const namedMethods = [...new Set(question.match(/\bsw\.[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*/g) ?? [])];
  const visitedMethods = new Set<string>();
  for (const method of namedMethods) {
    if (visitedMethods.has(method)) continue;
    visitedMethods.add(method);
    if (visitedMethods.size > 64) { dependencies.selection.omitted.push({ id: `method:${method}`, reason: 'budget' }); continue; }
    const topic = method.split('.').slice(0, 2).join('.');
    const matches = advisorSections(topics[topic] ?? '').filter(section => section.includes(method));
    if (!matches.length) dependencies.selection.omitted.push({ id: `method:${method}`, reason: 'unavailable' });
    for (const section of matches) {
      const id = `${topic}:${section.split('\n')[0]}`;
      if (dependencies.sectionIds.has(id)) continue;
      dependencies.sectionIds.add(id);
      dependencies.selection.selected.push(id);
      selected.push({ text: `## Required reference: ${topic}\n${section}`, ids: [id] });
    }
  }

  dependencies.selection.required = [...dependencies.selection.selected, ...dependencies.selection.omitted.map(item => item.id)];
  for (const page of ranked) {
    const sections = advisorSections(page.body);
    // Exact identifiers and the selected domain's canonical setup operations
    // beat incidental prose matches. Otherwise long worked examples win simply
    // by containing more query words than the operation's own contract.
    const identifiers = (question.match(/[a-z][a-z0-9_.-]*/gi) ?? [])
      .map((word) => word.replace(/[_.-]+$/, ''))
      .filter((word) => /[_.]|[a-z][A-Z]/.test(word) && !pages.some(([name]) => name.toLowerCase() === word.toLowerCase()))
      .map((word) => word.toLowerCase());
    const pageDomain = page.name.replace(/^sw\./, '');
    const domainCompanions = [...companions].filter((name) => name.startsWith(`${pageDomain}_`));
    const candidates = sections.map((body, order) => ({
      body, order,
      exact: identifiers.some((identifier) => body.toLowerCase().includes(identifier)),
      score: identifiers.filter((identifier) => body.toLowerCase().includes(identifier)).length * 100
        + domainCompanions.filter((name) => body.includes(name)).length * 20
        + score(body) / (1 + Math.log2(1 + body.length / 500)),
    })).filter((section) => {
      if (page.name !== 'cli' || !hasDomainFocus) return true;
      const heading = section.body.split('\n')[0];
      return section.order === 0 || section.body.includes('somewhere call')
        || focused.some((topic) => !navigationTopics.has(topic.name)
          && (aliases[topic.name]?.test(heading) || heading.toLowerCase().includes(topic.name.replace(/^sw\./, ''))));
    }).sort((a, b) => b.score - a.score || a.order - b.order);
    let remaining = 5_000;
    const excerpts: typeof candidates = [];
    for (const section of candidates) {
      // A specifically requested contract is kept whole even when it exceeds
      // the ordinary topic budget. Never substitute unrelated small sections
      // for a requested identifier such as serverOnly in the schema section.
      if (!excerpts.length && section.exact && section.body.length <= 12_000) remaining = Math.max(remaining, section.body.length);
      const id = `${page.name}:${section.body.split('\n')[0]}`;
      if (dependencies.sectionIds.has(id)) continue;
      if (section.body.length > remaining) {
        dependencies.selection.omitted.push({ id, reason: 'budget' });
        continue;
      }
      dependencies.selection.selected.push(id);
      excerpts.push(section);
      remaining -= section.body.length;
    }
    for (const section of excerpts.sort((a, b) => a.order - b.order)) selected.push({ text: `## Topic: ${page.name}\n${section.body}`, ids: [`${page.name}:${section.body.split('\n')[0]}`] });
  }
  const domainWord = (word: string): string => word.toLowerCase().replace(/s$/, '');
  const requestedDomains = new Set([
    ...query.flatMap((word) => word.split(/[_.-]/)),
    ...focused.map((page) => page.name.replace(/^sw\./, '')),
  ].map(domainWord));
  const genericToolParts = new Set('project platform cli create get set list delete update read write send run status query'.split(' '));
  const topicDomains = new Set(pages.map(([name]) => domainWord(name.replace(/^sw\./, '').split('-')[0])));
  const focusedDomains = new Set(focused.map((page) => domainWord(page.name.replace(/^sw\./, '').split('-')[0])));
  const companionDomains = new Set([...companions].map((name) => name.split('_')[0]));
  const toolRequested = (name: string): boolean => {
    if (companions.has(name) || query.includes(name)) return true;
    const parts = name.split('_');
    if (companionDomains.has(parts[0])) {
      if (!parts.slice(1).some((part) => requestedDomains.has(domainWord(part)))) return false;
      const runtimeName = `sw.${name.replace('_', '.')}`;
      if (!selected.some(({ text }) => text.includes(name) || text.includes(runtimeName))) return false;
    }
    if (topicDomains.has(domainWord(parts[0])) && !parts.some((part) => focusedDomains.has(domainWord(part)))) return false;
    // The leading namespace identifies the operation. Secondary words only
    // establish a domain when the docs actually have that domain: a request for
    // customer URL tokens does not imply project_design_tokens or view_urls.
    return name.split('_').some((part, index) => !genericToolParts.has(part)
      && (index === 0 || topicDomains.has(domainWord(part)))
      && requestedDomains.has(domainWord(part)));
  };
  const requiredToolNames = new Set([...companions, ...tools.filter(tool => query.includes(tool.name)).map(tool => tool.name)]);
  const selectedTools = tools.filter((tool) => options.caller !== 'cli' || tool.name !== 'project_deploy' || query.includes('project_deploy')).map((tool) => ({ ...tool, score: (requiredToolNames.has(tool.name) ? 100 : 0) + score(tool.name) * 4 + score(tool.description) }))
    .filter((tool) => tool.score > 0 && (!hasDomainFocus || toolRequested(tool.name)))
    .sort((a, b) => Number(requiredToolNames.has(b.name)) - Number(requiredToolNames.has(a.name)) || b.score - a.score).slice(0, 16);
  for (const name of requiredToolNames) {
    dependencies.selection.required!.push(`tool:${name}`);
    if (!tools.some(tool => tool.name === name)) dependencies.selection.omitted.push({ id: `tool:${name}`, reason: 'unavailable' });
    else if (!selectedTools.some(tool => tool.name === name)) dependencies.selection.omitted.push({ id: `tool:${name}`, reason: 'budget' });
  }
  const bounded: string[] = [];
  let remainingBytes = 60_000;
  let remainingSections = 36;
  const appendReference = (block: typeof selected[number]): void => {
    const size = new TextEncoder().encode(block.text).byteLength;
    const sectionCount = block.ids.filter(id => !id.startsWith('capability:')).length;
    if (size > remainingBytes || sectionCount > remainingSections) {
      dependencies.selection.selected = dependencies.selection.selected.filter(id => !block.ids.includes(id));
      for (const id of block.ids) dependencies.selection.omitted.push({ id, reason: 'budget' });
      return;
    }
    bounded.push(block.text); remainingBytes -= size; remainingSections -= sectionCount;
  };
  const appendTool = (tool: typeof selectedTools[number], output: string[]): void => {
    const id = `tool:${tool.name}`;
    if (!tool.inputSchema) { dependencies.selection.omitted.push({ id, reason: 'unavailable' }); return; }
    const block = `- ${tool.name}: ${tool.description.split('\n\n')[0].slice(0, 700)}\nArguments: ${JSON.stringify(tool.inputSchema)}`;
    const size = new TextEncoder().encode(block).byteLength;
    if (size > remainingBytes) dependencies.selection.omitted.push({ id, reason: 'budget' });
    else { output.push(block); dependencies.selection.selected.push(id); remainingBytes -= size; }
  };
  const requiredIds = new Set(dependencies.selection.required);
  const requiredReferences = selected.filter(block => block.ids.some(id => requiredIds.has(id)));
  const optionalReferences = selected.filter(block => !block.ids.some(id => requiredIds.has(id)));
  // Reserve executable argument contracts before prose can consume their budget.
  const requiredToolBlocks: string[] = [];
  for (const tool of selectedTools.filter(tool => requiredToolNames.has(tool.name))) appendTool(tool, requiredToolBlocks);
  for (const block of requiredReferences) appendReference(block);
  if (requiredToolBlocks.length) bounded.push('## Required caller-visible tools\n' + requiredToolBlocks.join('\n'));
  for (const block of optionalReferences) appendReference(block);
  const toolBlocks: string[] = [];
  for (const tool of selectedTools.filter(tool => !requiredToolNames.has(tool.name))) appendTool(tool, toolBlocks);
  const missingRequired = dependencies.selection.omitted.filter(item => dependencies.selection.required?.includes(item.id));
  const displayedMissing: typeof missingRequired = [];
  for (const item of missingRequired) {
    if (new TextEncoder().encode(JSON.stringify([...displayedMissing, item])).byteLength > 2_000) break;
    displayedMissing.push(item);
  }
  const missingNotice = missingRequired.length ? '\n\nRequired canonical references or tool schemas omitted (do not invent them): ' + JSON.stringify(displayedMissing) + ` (${missingRequired.length} total; full identities retained in diagnostics).` : '';
  return {
    topics: requiredTopics,
    selection: dependencies.selection,
    text: bounded.join('\n\n') + '\n\n## Relevant tools\n' + toolBlocks.join('\n') + missingNotice,
  };
}

/** Runtime-backed distinctions absent from the broad discovery index. The
 * corresponding fixtures check the signing implementation and event emitter. */
export function advisorIntegrationContext(question: string): string {
  if (!/webhook|payment|checkout/i.test(question)) return '';
  return `## Current payment and webhook evidence (takes precedence over older examples)
Project outbound /v1/webhooks and auth/database webhooks are DIFFERENT contracts.
Project outbound X-Somewhere-Signature is lowercase hex HMAC-SHA256(secret, rawBody), with NO t= or v1= wrapper and NO timestamp prefix. Read req.text() once; verify the exact UTF-8 bytes before parsing. Body: {event, project_id, timestamp, source, data}; timestamp is ISO-8601, not epoch units. That timestamp field IS authenticated inside the raw JSON body; only an ADDITIONAL timestamp prefix is absent. Never say the body timestamp is excluded from the MAC. Headers: X-Somewhere-Event, X-Somewhere-Project, X-Somewhere-Event-Id, X-Somewhere-Delivery-Id, X-Somewhere-Attempt. Deduplicate on event/delivery ID; redrives preserve the original body/signature. A configured secret is required for a signed delivery.
Auth/database webhooks instead use X-Somewhere-Signature: t=<epoch milliseconds>,v1=<hex HMAC-SHA256(secret, milliseconds + '.' + rawBody)>.
An app-created ad-hoc Checkout does NOT emit payment_received, subscription_created, subscription_cancelled, or payment.completed to project outbound subscriptions. A successful synthetic test is NOT evidence that a real payment emits that event. Do not recommend registering those events for fulfillment.
sw.payments.events() exposes summary fields, NOT Checkout session metadata or a reliable request-id fulfillment mapping. Do not invent event.metadata or event.payment_intent_id there.
For custom fulfillment, configure a separate Stripe webhook destination to your own api/ handler and verify Stripe-Signature with that destination's signing secret, independently of project outbound signatures. This setup is manual and requires access to the connected account. Default dev Checkout may use a shared test account; the developer cannot configure their own destination there. Do not promise self-service custom fulfillment on that shared test path: ask platform support to arrange the destination or verify test-account setup first. The platform's built-in payment handling does not update your arbitrary requests table. Keep the signing secret in a server environment variable. Match the server-created Checkout session, amount/currency and paid status, then update idempotently; browser redirects are never payment proof.
sw.payments.checkout(options) returns {session_id,url}; options include env ('dev' for test), mode ('payment'), line_items (name, amount, currency, quantity), success_url, cancel_url, and metadata. Amount is integer cents chosen on the server; do not guess a missing amount. For signed-in plan upgrades the current runtime signature is sw.payments.checkoutForUser({plan,...}); subject is derived from the signed-in request, not a positional userId.
Use crypto.getRandomValues(new Uint8Array(32)) for independent customer/admin URL tokens; persist hashes and do not expose admin tokens to public intake callers.
If the requested table is serverOnly(), preserve that policy. Anonymous intake can go through a validating server handler; do not replace serverOnly() with shared() or require signup to work around it.
`;
}
