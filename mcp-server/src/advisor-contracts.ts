/** Exact answers for the small set of contracts that must not depend on model
 * paraphrase. Keep this syntax aligned with worker/src/runtime/db.ts. */
export const SW_DB_WRITE_SIGNATURE_ANSWER = `## Exact \`sw.db\` write signatures

\`\`\`ts
sw.db.insert(table, values, options?: { onConflict?: 'ignore' | 'update' })
sw.db.update(table, { set, where? })
sw.db.remove(table, { where? }) // sw.db.delete is an alias
\`\`\`

One call example:

\`\`\`ts
await sw.db.update('notes', {
  set: { done: true },
  where: { id: 42 },
})
\`\`\`

\`update\` and \`remove\` take one options object; a third argument is rejected with \`SCOPE_ARGUMENT_REMOVED\`. See \`somewhere docs sw.db\` for the full return envelope and where operators.`;

/** Return a deterministic answer when an agent explicitly asks for the
 * structured database write contract. Architecture questions stay with the
 * project-aware model path. */
export function advisorContractAnswer(question: string): string | null {
  const normalized = question.toLowerCase();
  // The shortcut only supplies the write contract. A requested read, full
  // workflow, or additional example must keep the complete question on the
  // canonical-evidence answer path.
  if (/\b(?:from|select|count|numeric|examples|architecture|workflow|cron|checkout|cookie|auth|callback)\b/i.test(question)) return null;
  const namesDb = /\bsw\.?db\b/.test(normalized)
    || /\bsw\.db\.(?:insert|update|remove|delete)\b/.test(normalized);
  const namesWrite = /\b(?:insert|update|remove|delete|write)\b/.test(normalized);
  const asksContract = /\b(?:signatures?|contract|argument|parameter|syntax|call(?:ing)?|usage)\b/.test(normalized);
  return namesDb && namesWrite && asksContract ? SW_DB_WRITE_SIGNATURE_ANSWER : null;
}

/** Byte-level signing contracts are exact data, not model paraphrases. This
 * narrow match leaves integration architecture and registration questions on
 * the project-aware advisor path. */
export function advisorWebhookContractAnswer(question: string): string | null {
  // Event emission and fulfillment decisions require the flow-specific evidence
  // and authorized project facts; a byte contract alone cannot answer them.
  if (/\b(?:checkout|fulfill\w*|emit\w*|production path|platform[ -]managed)\b/i.test(question)) return null;
  if (!/project outbound|\/v1\/webhooks/i.test(question)
    || !/sign(?:ature|ing|ed)/i.test(question)
    || /architecture|recipe|registration command|file shapes|\bcron\b|cron_create|schedul/i.test(question)
    || !/invalid signature|signed bytes|timestamp units|headers, algorithm/i.test(question)) return null;
  return `## Project outbound webhook signatures

\`X-Somewhere-Signature\` is lowercase hexadecimal:

\`\`\`text
HMAC-SHA256(secret, rawBody)
\`\`\`

Read \`await req.text()\` once and verify the exact UTF-8 body bytes before parsing JSON. There is no additional timestamp prefix and no \`t=\`/\`v1=\` wrapper. Signing \`t + '.' + rawBody\` is incorrect for this delivery type.

The body is \`{ event, project_id, timestamp, source, data }\`. Its \`timestamp\` is ISO-8601 and **is authenticated as part of the signed JSON body**. It is not an epoch timestamp.

Delivery headers are \`X-Somewhere-Event\`, \`X-Somewhere-Project\`, \`X-Somewhere-Event-Id\`, \`X-Somewhere-Delivery-Id\`, and \`X-Somewhere-Attempt\`. A configured secret is required for the signature header. Deduplicate using event/delivery IDs; retries preserve the stored body and signature.

## Auth and database webhook signatures

\`\`\`text
X-Somewhere-Signature: t=<epoch milliseconds>,v1=<lowercase hex>
HMAC-SHA256(secret, timestamp_ms + '.' + rawBody)
\`\`\`

Here the separate timestamp is epoch **milliseconds**. Verify its freshness and the signature over the unchanged raw body.

A successful synthetic \`payment_received\` delivery does not establish real Checkout fulfillment: ad-hoc Checkout does not emit that event to project outbound subscriptions. Custom fulfillment uses a separate, manually configured Stripe webhook destination and its independent \`Stripe-Signature\` contract. See \`somewhere docs payments\`; shared dev test-account destinations require platform support.`;
}
