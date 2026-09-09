// /packages/calibrate/src/capture.ts
//
// The one call an integration makes: hand over the parsed response body and the
// context, get back an `OutputSample` or a refusal. Finds the usage object where
// each provider puts it and dispatches to the adapter in usage.ts.
//
// Still pure, still keyless. The integration made the call; this only reads what
// came back.

import type { OutputSample } from '@tokenomics/contracts';
import {
  sampleFromAnthropicUsage,
  sampleFromGeminiUsage,
  sampleFromOpenAIResponsesUsage,
  type SampleContext,
} from './usage';

export type CaptureProvider = 'anthropic' | 'openai' | 'google';

export type CaptureResult =
  | { status: 'CAPTURED'; sample: OutputSample }
  | { status: 'REFUSED'; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The provider's response id if the body carries a string `id`/`responseId`; else null. Best-effort — used only to dedupe. */
const idOf = (body: Record<string, unknown>, key: string): string | null =>
  typeof body[key] === 'string' && (body[key] as string).length > 0 ? (body[key] as string) : null;

export function sampleFromResponse(
  provider: CaptureProvider,
  body: unknown,
  ctx: Omit<SampleContext, 'response_id'> & { thoughts_known_zero?: boolean },
): CaptureResult {
  if (!isRecord(body)) return { status: 'REFUSED', reason: 'response body is not a JSON object' };
  try {
    switch (provider) {
      case 'anthropic': {
        if (!isRecord(body.usage)) return { status: 'REFUSED', reason: 'no `usage` object on the response' };
        return { status: 'CAPTURED', sample: sampleFromAnthropicUsage(body.usage, { ...ctx, response_id: idOf(body, 'id') }) };
      }
      case 'openai': {
        if (!isRecord(body.usage)) return { status: 'REFUSED', reason: 'no `usage` object on the response' };
        return { status: 'CAPTURED', sample: sampleFromOpenAIResponsesUsage(body.usage, { ...ctx, response_id: idOf(body, 'id') }) };
      }
      case 'google': {
        if (!isRecord(body.usageMetadata)) return { status: 'REFUSED', reason: 'no `usageMetadata` object on the response' };
        return {
          status: 'CAPTURED',
          sample: sampleFromGeminiUsage(body.usageMetadata, { ...ctx, response_id: idOf(body, 'responseId') }),
        };
      }
    }
  } catch (e) {
    return { status: 'REFUSED', reason: (e as Error).message };
  }
}
