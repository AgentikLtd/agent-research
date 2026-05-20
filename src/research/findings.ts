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

export function parseAngles(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    throw new FindingsParseError(
      `angles JSON did not parse: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const result = AnglesArraySchema.safeParse(raw);
  if (!result.success) {
    throw new FindingsParseError(`angles failed validation: ${result.error.message}`);
  }
  return result.data;
}
