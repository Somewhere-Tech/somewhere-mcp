/**
 * json-exact-integers.ts — catch a whole number that JSON.parse already
 * rounded, BEFORE the platform binds it into a statement.
 *
 * A request body is JSON TEXT. `JSON.parse` turns every number into a
 * JavaScript number, which is exact only up to 9007199254740991. A caller who
 * writes a Snowflake id as a JSON number therefore hands the platform a
 * DIFFERENT number than the one they sent, and every layer below is faithful to
 * the wrong value: it binds, it stores, it reads back — no error anywhere. That
 * is the same silent-wrong-value failure the read paths fixed (tsk_ab509b2d),
 * one step earlier, and the parsed value alone cannot reveal it.
 *
 * The RAW TEXT can. This module scans the body the request actually sent and
 * reports every plain-digit whole number whose digits do not survive the parse.
 * It is the mirror of `parseD1ResponseDetails` in utils/d1.ts, which does the
 * same scan on the database's RESPONSE bytes.
 *
 * Deliberately narrow (rule 9):
 *   - Only tokens OUTSIDE string literals are considered, so a value already
 *     sent in the documented exact form ("9223372036854775807") is never
 *     mistaken for a damaged number.
 *   - Only PLAIN-DIGIT integer tokens. A number written with a decimal point or
 *     an exponent is a decimal by construction; it was never expected to be
 *     exact and keeps its long-standing behaviour. Same carve-out the batch
 *     literal escaper uses (utils/db-direct-write.ts).
 *   - A token whose digits DO survive the parse is not reported, so every value
 *     that works today keeps working — including exact whole numbers above
 *     9007199254740991 such as 10000000000000000.
 */

/** Fewest digits a whole number needs before a JavaScript number can lose it:
 *  15 digits is at most 999999999999999, well inside the exact range. */
const MIN_INEXACT_DIGITS = 16;

/** The largest whole number a JSON number carries exactly. */
export const EXACT_JSON_INTEGER_LIMIT = '9007199254740991';

export interface LostPrecisionInteger {
  /** Where the value sits in the body, e.g. `statements[0].params[1]`. */
  field: string;
  /** The digits the caller sent. */
  sent: string;
  /** The number the parse produced instead. */
  received: string;
}

interface Frame {
  array: boolean;
  index: number;
  key: string | null;
}

function renderPath(stack: Frame[], leafKey: string | null): string {
  let path = '';
  for (const frame of stack) {
    if (frame.key !== null) path += path ? `.${frame.key}` : frame.key;
    if (frame.array) path += `[${frame.index}]`;
  }
  if (leafKey !== null) path += path ? `.${leafKey}` : leafKey;
  return path || 'the request body';
}

/**
 * Every plain-digit whole number in `raw` whose value changed when it was
 * parsed. Returns [] for a body with nothing out of range — the overwhelmingly
 * common case — after one linear pass and no allocation per token.
 */
export function scanLostPrecisionIntegers(raw: string, limit = 5): LostPrecisionInteger[] {
  const found: LostPrecisionInteger[] = [];
  const stack: Frame[] = [];
  let pendingKey: string | null = null;
  let index = 0;

  while (index < raw.length && found.length < limit) {
    const ch = raw[index];

    // String literal — copy past it, then decide whether it was an object key.
    if (ch === '"') {
      const start = index + 1;
      index++;
      let escaped = false;
      while (index < raw.length) {
        if (raw[index] === '\\') {
          escaped = true;
          index += 2;
          continue;
        }
        if (raw[index] === '"') break;
        index++;
      }
      const text = raw.slice(start, Math.min(index, raw.length));
      index++;
      let after = index;
      while (after < raw.length && (raw[after] === ' ' || raw[after] === '\n' || raw[after] === '\r' || raw[after] === '\t')) after++;
      if (raw[after] === ':') {
        // Escapes in a key are rare; the raw slice still identifies it.
        pendingKey = escaped ? text.replace(/\\(.)/g, '$1') : text;
      }
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push({ array: ch === '[', index: 0, key: pendingKey });
      pendingKey = null;
      index++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      stack.pop();
      pendingKey = null;
      index++;
      continue;
    }

    if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.array) top.index++;
      pendingKey = null;
      index++;
      continue;
    }

    // Number token.
    const tokenStart = index;
    if (ch === '-') index++;
    if (index >= raw.length || raw[index] < '0' || raw[index] > '9') {
      index = tokenStart + 1;
      continue;
    }
    while (index < raw.length && raw[index] >= '0' && raw[index] <= '9') index++;
    let plainInteger = true;
    if (raw[index] === '.') {
      plainInteger = false;
      index++;
      while (index < raw.length && raw[index] >= '0' && raw[index] <= '9') index++;
    }
    if (raw[index] === 'e' || raw[index] === 'E') {
      plainInteger = false;
      index++;
      if (raw[index] === '+' || raw[index] === '-') index++;
      while (index < raw.length && raw[index] >= '0' && raw[index] <= '9') index++;
    }
    if (!plainInteger) {
      pendingKey = null;
      continue;
    }
    const token = raw.slice(tokenStart, index);
    const digits = token.charCodeAt(0) === 45 /* '-' */ ? token.length - 1 : token.length;
    if (digits >= MIN_INEXACT_DIGITS) {
      const parsed = Number(token);
      const roundTrip = String(parsed);
      if (roundTrip !== token) {
        found.push({
          field: renderPath(stack, pendingKey),
          sent: token,
          received: roundTrip,
        });
      }
    }
    pendingKey = null;
  }

  return found;
}

/**
 * Customer-facing copy for the refusal. Names the field, both numbers, and the
 * form that works — the same decimal string a read returns, so a value read out
 * of the database can be written straight back.
 */
export function lostPrecisionMessage(lost: LostPrecisionInteger[]): string {
  const first = lost[0];
  const more = lost.length > 1
    ? ` ${lost.length - 1} other value${lost.length > 2 ? 's' : ''} in this request ${lost.length > 2 ? 'have' : 'has'} the same problem.`
    : '';
  return (
    `The whole number ${first.sent} in "${first.field}" is wider than a JSON number carries: ` +
    `it arrived as ${first.received}, so storing it would have saved a different number. ` +
    `Send whole numbers above ${EXACT_JSON_INTEGER_LIMIT} as a string — "${first.sent}" — ` +
    `which this database stores exactly and returns in the same form. Nothing was written.${more}`
  );
}
