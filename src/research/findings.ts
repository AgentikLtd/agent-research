/**
 * Structured research findings — the contract passed between the research,
 * challenge and synthesis stages of the brief pipeline.
 *
 * Each producing stage emits findings as JSON in its LLM text output;
 * `parseFindings` extracts and zod-validates that JSON. A parse failure is a
 * typed `FindingsParseError` so run-brief can degrade one stage without
 * aborting the brief.
 */
import { z } from 'zod';

export type FindingLabel = 'GA' | 'BETA' | 'ROADMAP' | 'RUMOUR' | 'CONTEXT';
export type FindingConfidence = 'high' | 'medium' | 'low';
export type FindingVerdict = 'confirmed' | 'disputed' | 'unverified';

export interface FindingSource {
  readonly url: string;
  readonly title?: string;
  readonly publisher?: string;
}

export interface Finding {
  /** One-sentence factual claim. */
  readonly claim: string;
  /** Supporting detail and analysis. */
  readonly detail: string;
  readonly label: FindingLabel;
  readonly confidence: FindingConfidence;
  /** Free-text theme; synthesis groups findings by it. */
  readonly category: string;
  readonly sources: readonly FindingSource[];
  /** e.g. 'vendor-marketing', 'single-source', 'conflicting'. */
  readonly flags: readonly string[];
  /** ISO date of the underlying news item, when known. */
  readonly publishedAt?: string;
  /** Set by the challenge stage. */
  readonly verdict?: FindingVerdict;
}

export class FindingsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingsParseError';
  }
}

const SourceSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  publisher: z.string().optional(),
});

const FindingSchema = z.object({
  claim: z.string().min(1),
  detail: z.string(),
  label: z.enum(['GA', 'BETA', 'ROADMAP', 'RUMOUR', 'CONTEXT']),
  confidence: z.enum(['high', 'medium', 'low']),
  category: z.string(),
  sources: z.array(SourceSchema),
  flags: z.array(z.string()),
  publishedAt: z.string().optional(),
  verdict: z.enum(['confirmed', 'disputed', 'unverified']).optional(),
});

const FindingsArraySchema = z.array(FindingSchema);
const AnglesArraySchema = z.array(z.string().min(1));

/**
 * Pull the first JSON array/object out of an LLM text response — handles a
 * ```json fenced block, a bare array, or prose wrapped around the JSON.
 */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const a0 = text.indexOf('[');
  const a1 = text.lastIndexOf(']');
  if (a0 !== -1 && a1 > a0) return text.slice(a0, a1 + 1);
  const o0 = text.indexOf('{');
  const o1 = text.lastIndexOf('}');
  if (o0 !== -1 && o1 > o0) return text.slice(o0, o1 + 1);
  return text.trim();
}

export function parseFindings(text: string): Finding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    throw new FindingsParseError(
      `findings JSON did not parse: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const result = FindingsArraySchema.safeParse(raw);
  if (!result.success) {
    throw new FindingsParseError(`findings failed validation: ${result.error.message}`);
  }
  // zod's optional-field inference adds `| undefined`; the Finding interface
  // uses bare `?:`. The data is validated — cast the array once.
  return result.data as Finding[];
}

/**
 * Coerce a parsed JSON value into a flat array of angle strings. Models
 * deviate from "a JSON array of strings" in predictable ways — an array of
 * objects (`[{"angle":"…"}]`), an object nesting the array under a key, or a
 * single string — and `parseAngles` tolerates all of them.
 */
function coerceToAngleArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item): string => {
        if (typeof item === 'string') return item;
        if (item !== null && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          for (const key of ['angle', 'question', 'text', 'q', 'title']) {
            const v = o[key];
            if (typeof v === 'string') return v;
          }
          const firstString = Object.values(o).find((v) => typeof v === 'string');
          if (typeof firstString === 'string') return firstString;
        }
        return '';
      })
      .filter((s) => s.trim().length > 0);
  }
  if (typeof raw === 'string') {
    return raw.trim().length > 0 ? [raw] : [];
  }
  if (raw !== null && typeof raw === 'object') {
    const arrays = Object.values(raw as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return coerceToAngleArray(arrays[0]);
  }
  return [];
}

/**
 * Recover the complete leading elements of a truncated JSON array. A thinking
 * model can exhaust its output-token budget mid-array, leaving the final
 * element unterminated (`Unterminated string in JSON …`). This walks the text
 * tracking string/escape/nesting state and returns everything up to the last
 * top-level comma, re-closed with `]` — dropping the incomplete tail element.
 * Returns null when no complete element precedes the truncation.
 */
function salvageTruncatedArray(json: string): string | null {
  const start = json.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastTopLevelComma = -1;
  for (let i = start; i < json.length; i += 1) {
    const ch = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 1) lastTopLevelComma = i;
  }
  if (lastTopLevelComma === -1) return null;
  return `${json.slice(start, lastTopLevelComma)}]`;
}

/**
 * Parse the angle-plan JSON, tolerating the two deviations real models
 * produce: a trailing comma, and — for thinking models that run out of output
 * budget mid-response — a truncated, unterminated array.
 */
function parseAnglesJson(text: string): unknown {
  const json = extractJson(text);
  try {
    return JSON.parse(json);
  } catch (firstError) {
    // Retry tolerating trailing commas — a common model JSON deviation.
    try {
      return JSON.parse(json.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      // Last resort: salvage the complete leading elements of a truncated
      // array rather than losing the whole research plan to one cut-off angle.
      // Salvage scans the ORIGINAL text — extractJson can mis-slice a truncated
      // array (an unclosed `[…` of objects falls into its `{…}` branch).
      const salvaged = salvageTruncatedArray(text);
      if (salvaged !== null) {
        try {
          return JSON.parse(salvaged);
        } catch {
          /* fall through to the typed error */
        }
      }
      throw new FindingsParseError(
        `angles JSON did not parse: ${
          firstError instanceof Error ? firstError.message : String(firstError)
        }`,
      );
    }
  }
}

export function parseAngles(text: string): string[] {
  const raw = parseAnglesJson(text);
  const angles = coerceToAngleArray(raw);
  const result = AnglesArraySchema.safeParse(angles);
  if (!result.success) {
    throw new FindingsParseError(`angles failed validation: ${result.error.message}`);
  }
  if (result.data.length === 0) {
    throw new FindingsParseError('no research angles found in plan response');
  }
  return result.data;
}
