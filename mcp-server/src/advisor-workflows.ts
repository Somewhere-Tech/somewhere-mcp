export interface AdvisorWorkflow {
  id: 'scheduled-work' | 'database-work' | 'browser-session' | 'email-delivery' | 'public-file';
  topics: readonly string[];
}

/** Deterministic task vocabulary seeds the canonical dependency graph. This is
 * a bounded recall aid, not proof that every natural-language task was found. */
export function advisorWorkflows(question: string): AdvisorWorkflow[] {
  const workflows: AdvisorWorkflow[] = [];
  const cadence = /\b(?:schedul\w*|hourly|daily|nightly|weekly|periodic(?:ally)?|every\s+(?:(?:\d+|one|two|three|four|five|six|twelve)\s+)?(?:minute|hour|day|week)s?)\b/i.test(question);
  const recurring = /\bcron\b/i.test(question) || (cadence && /\b(?:job|task|handlers?|invocations?|cleanup|clean[ -]?up|expir\w*|run|invok(?:e[ds]?|ing)|remind\w*|send|deliver|background|prune|purge)\b/i.test(question));
  if (recurring) workflows.push({ id: 'scheduled-work', topics: ['cron'] });
  if (/\b(?:database|sw\.db|records?)\b|\bcross-user feed\b|\bownership[ -]only edits\b/i.test(question) || (/\b(?:table|rows?)\b/i.test(question) && !/\b(?:css|html|layout)\b/i.test(question))) workflows.push({ id: 'database-work', topics: ['sw.db'] });
  if (/\b(?:magic[ -]links?|sign[ -]?in|log[ -]?in|verifyOtp|signInWithOtp|setSessionCookies|cookie[ -]session|auth(?:entication)?\s+callback)\b/i.test(question)) workflows.push({ id: 'browser-session', topics: ['sw.auth'] });
  if (/\bsw\.email\b|\b(?:remind\w*|send|deliver)\b[^.?!]{0,100}\bemails?\b|\bemails?\b[^.?!]{0,100}\bremind\w*/i.test(question)) workflows.push({ id: 'email-delivery', topics: ['sw.email'] });
  if (/\bpublic\b[^.?!]{0,60}\b(?:screenshots?|images?|files?|uploads?)\b|\b(?:screenshots?|images?|files?|uploads?)\b[^.?!]{0,60}\bpublic\b/i.test(question)) workflows.push({ id: 'public-file', topics: ['sw.fs'] });
  return workflows;
}
