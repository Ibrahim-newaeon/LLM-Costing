// /packages/estimator/src/media.test.ts
//
// §A5.3 is two lines of arithmetic and four ways to be confidently wrong. Each of
// the four gets a test that would pass against the obvious implementation and fail
// against the careless one.
//
//   pnpm vitest src/media.test.ts     # offline, free

import { describe, it, expect } from 'vitest';
import { VisionProfile, AudioInputProfile, VideoInputProfile, MediaMetrics } from '@tokenomics/contracts';
import { countAudioTokens, countVideoTokens, sampleFrames, billableDuration } from './media';
import { isExact } from './range';

/** Warnings are `{code, message, severity}` now, so an assertion reads one half or the other. */
const codes = (ws: readonly { code: string }[]) => ws.map((w) => w.code);
const messages = (ws: readonly { message: string }[]) => ws.map((w) => w.message).join(' ');


/* ─────────────────────────── fixtures ─────────────────────────── */

const prov = (over: Record<string, unknown> = {}) => ({
  method: 'PROVIDER_FORMULA',
  confidence: 'HIGH',
  source_class: 'VENDOR_DOCS',
  source_url: 'https://example.invalid/docs',
  verified_at: '2026-09-08T00:00:00.000Z',
  verified_by: null,
  notes: null,
  ...over,
});

const src = (value: unknown, p: Record<string, unknown> = prov()) => ({ value, provenance: p });
const unsourced = (over: Record<string, unknown> = {}) =>
  src(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null, ...over }));

const visionProfile = () =>
  VisionProfile.parse({
    // 512px tiles, 85 base + 170 per tile. A 1024x1024 frame is 4 tiles = 765.
    geometry: {
      geometry: 'TILE_GRID',
      tile_w: src(512),
      tile_h: src(512),
      base_tokens: src(85),
      per_tile_tokens: src(170),
      small_image_flat_tokens: null,
      small_image_max_edge_px: null,
    },
    low_detail: { kind: 'UNSUPPORTED' },
    constraints: {
      max_edge_px: src(8000),
      min_edge_px: src(1),
      shortest_edge_target_px: src(null),
      max_bytes: src(20_000_000),
      max_pages: src(100),
      allowed_mime: ['image/png'],
      provider_auto_normalizes: true,
      min_legible_edge_px: [],
      max_context_tokens: src(200_000),
    },
    provenance: prov(),
  });

const FRAME = { width_px: 1024, height_px: 1024, detail_mode: null } as const;
const FRAME_TOKENS = 765; // 85 + 4 x 170

const audioProfile = (over: Record<string, unknown> = {}) =>
  AudioInputProfile.parse({
    billing_basis: 'PER_TOKEN',
    tokens_per_second: src(25),
    billing_granularity_seconds: src(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
    max_duration_seconds: src(9600),
    multichannel_multiplies: false,
    ...over,
  });

// ⚠️ Parsed, not cast. This helper used to return `any` from a hand-built literal,
// so the video fixtures were never checked against VideoInputProfile — a shape the
// contract would reject sailed through, and a field the estimator reads could be
// absent. Adding `tokens_per_frame` proved it: instead of a compile error at every
// call site, one test blew up at run time with `Cannot read properties of undefined`.
// Its sibling `audioProfile` had always parsed; this one was the odd one out.
const videoProfile = (over: Record<string, unknown> = {}) =>
  VideoInputProfile.parse({
    frame_sample_rate_hz: src(1),
    user_configurable_fps: false,
    per_frame_uses_vision_geometry: true,
    // Null on the geometry path, and the contract refuses it any other way.
    tokens_per_frame: src(null, prov({ method: 'UNAVAILABLE', confidence: 'NONE', source_url: null })),
    audio_tokens_per_second: src(25),
    audio_billed_separately: false,
    max_duration_seconds: src(3600),
    max_frames: src(3600),
    has_deterministic_formula: true,
    adaptive_mode_available: false,
    ...over,
  });

const media = (over: Record<string, unknown> = {}) =>
  MediaMetrics.parse({
    modality: 'video',
    duration_seconds: 60,
    duration_source: 'DERIVED_FROM_ASSET',
    ...over,
  });

const audio = (over: Record<string, unknown> = {}) =>
  media({ modality: 'audio', ...over });

/* ══════════════ TRAP 1 — audio is billed two different ways ══════════════ */

describe('audio: the two billing bases are not interchangeable', () => {
  it('PER_TOKEN converts duration at the published tokens-per-second', () => {
    const r = countAudioTokens(audioProfile(), audio({ duration_seconds: 90 }));
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.unit).toBe('tokens');
    expect(r.quantity.p50).toBe(90 * 25);
  });

  it('PER_SECOND bills seconds and refuses to synthesize a token figure', () => {
    const r = countAudioTokens(
      audioProfile({ billing_basis: 'PER_SECOND', tokens_per_second: unsourced() }),
      audio({ duration_seconds: 90 }),
    );
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.unit).toBe('seconds');
    expect(r.quantity.p50).toBe(90);
    expect(r.notes.join(' ')).toMatch(/fabricated figure wearing a plausible unit/);
  });

  it('the contract refuses a row asserting both bases at once', () => {
    expect(() => audioProfile({ billing_basis: 'PER_SECOND' })).toThrow(
      /two billing bases on one row/,
    );
  });

  it('refuses a PER_TOKEN model with no published conversion, rather than borrowing one', () => {
    const r = countAudioTokens(audioProfile({ tokens_per_second: unsourced() }), audio());
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/another model’s answer/);
  });
});

describe('audio: duration, not bytes', () => {
  it('refuses when no duration was measured and does not fall back to byte size', () => {
    const r = countAudioTokens(audioProfile(), audio({ duration_seconds: null }));
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/Byte size is not a substitute/);
  });

  it('applies §A5.3’s whole-second ceiling and says the granularity was assumed', () => {
    const r = countAudioTokens(audioProfile(), audio({ duration_seconds: 90.2 }));
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.quantity.p50).toBe(91 * 25);
    expect(r.notes.join(' ')).toMatch(/whole-second ceiling is applied/);
  });

  it('a published finer granularity overrides the spec ceiling', () => {
    const r = countAudioTokens(
      audioProfile({ billing_granularity_seconds: src(0.1) }),
      audio({ duration_seconds: 90.24 }),
    );
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.quantity.p50).toBeCloseTo(90.3 * 25, 6);
    expect(r.notes.join(' ')).not.toMatch(/whole-second ceiling is applied/);
  });

  it('excludes a recording longer than the model accepts rather than clamping it', () => {
    const r = countAudioTokens(audioProfile({ max_duration_seconds: src(60) }), audio({ duration_seconds: 600 }));
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.exclusion).toBe('ASSET_EXCEEDS_CONSTRAINTS');
  });

  it('flags an unrecorded multichannel rule — a stereo track may bill twice', () => {
    const r = countAudioTokens(audioProfile({ multichannel_multiplies: null }), audio());
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.notes.join(' ')).toMatch(/may bill twice/);
  });
});

describe('billableDuration', () => {
  it('rounds up at whatever granularity applies', () => {
    expect(billableDuration(90.2, null)).toEqual({ seconds: 91, granularity: 1, sourced: false });
    expect(billableDuration(90.24, 0.1).seconds).toBeCloseTo(90.3, 6);
    expect(billableDuration(90, null).seconds).toBe(90);
  });
});

/* ══════════════ TRAP 2 — the geometry IS the per-frame input ══════════════ */

describe('video: per-frame tokens come from the §A5.2 geometry', () => {
  it('multiplies the frame count by the geometry result, not a flat guess', () => {
    const r = countVideoTokens({ video: videoProfile(), vision: visionProfile(), metrics: media({ duration_seconds: 60 }), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.per_frame_tokens).toBe(FRAME_TOKENS);
    expect(r.frames).toBe(60);
    expect(r.quantity.p50).toBe(60 * FRAME_TOKENS);
  });

  it('a geometry error multiplies by the frame count — half the frame size, half the bill', () => {
    const small = countVideoTokens({ video: videoProfile(), vision: visionProfile(), metrics: media(), frame: { width_px: 512, height_px: 512, detail_mode: null } });
    const large = countVideoTokens({ video: videoProfile(), vision: visionProfile(), metrics: media(), frame: FRAME });
    if (small.status !== 'COUNTED' || large.status !== 'COUNTED') throw new Error('geometry');
    expect(large.quantity.p50 - small.quantity.p50).toBe(60 * (FRAME_TOKENS - 255));
  });

  it('refuses when the model prices frames off its geometry and publishes no figure', () => {
    const r = countVideoTokens({ video: videoProfile({ per_frame_uses_vision_geometry: false }), vision: visionProfile(), metrics: media(), frame: FRAME });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/nothing to multiply by/);
  });

  it('refuses the whole video when the frame geometry is unavailable', () => {
    const noGeometry = VisionProfile.parse({
      geometry: { geometry: 'UNAVAILABLE', reason: 'undocumented' },
      low_detail: { kind: 'UNSUPPORTED' },
      constraints: {
        max_edge_px: src(8000), min_edge_px: src(1), shortest_edge_target_px: src(null),
        max_bytes: src(20_000_000), max_pages: src(100), allowed_mime: ['image/png'],
        provider_auto_normalizes: true, min_legible_edge_px: [], max_context_tokens: src(200_000),
      },
      provenance: prov(),
    });
    const r = countVideoTokens({ video: videoProfile(), vision: noGeometry, metrics: media(), frame: FRAME });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/Per-frame geometry is unavailable/);
  });
});

/* ══════════ video: the second way a provider prices a frame ══════════ */

describe('a published per-frame count is a different path, not a fallback', () => {
  const published = (tokens: number | null, over: Record<string, unknown> = {}) =>
    videoProfile({
      per_frame_uses_vision_geometry: false,
      tokens_per_frame: src(tokens),
      ...over,
    });

  it('prices off the published figure and never touches the image geometry', () => {
    // The geometry here would give FRAME_TOKENS (765). The provider says 100.
    // Reaching for 765 would be a different number wearing the same unit.
    const r = countVideoTokens({ video: published(100), vision: visionProfile(), metrics: media({ duration_seconds: 60 }), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.per_frame_tokens).toBe(100);
    expect(r.per_frame_tokens).not.toBe(FRAME_TOKENS);
    expect(r.quantity.p50).toBe(60 * 100);
  });

  it('prices a model whose image geometry is UNAVAILABLE — the two are independent', () => {
    // The case that motivated this: a provider that publishes a video figure and no
    // usable image geometry. Before, the geometry refusal took the video with it.
    const noGeometry = VisionProfile.parse({
      geometry: { geometry: 'UNAVAILABLE', reason: 'no worked example published' },
      low_detail: { kind: 'UNSUPPORTED' },
      constraints: {
        max_edge_px: src(8000), min_edge_px: src(1), shortest_edge_target_px: src(null),
        max_bytes: src(20_000_000), max_pages: src(100), allowed_mime: ['image/png'],
        provider_auto_normalizes: true, min_legible_edge_px: [], max_context_tokens: src(200_000),
      },
      provenance: prov(),
    });
    const r = countVideoTokens({ video: published(100), vision: noGeometry, metrics: media({ duration_seconds: 10 }), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.quantity.p50).toBe(10 * 100);
  });

  it('scales with the configured frame rate, and the max_frames clamp still applies', () => {
    // Per FRAME, not per second — the distinction only shows up off 1 fps.
    const r = countVideoTokens({
      video: published(100, { user_configurable_fps: true, frame_sample_rate_hz: src(1) }),
      vision: visionProfile(),
      metrics: media({ duration_seconds: 60, frame_sample_rate_hz: 2 }),
      frame: FRAME,
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.frames).toBe(120);
    expect(r.quantity.p50).toBe(120 * 100);

    const clamped = countVideoTokens({
      video: published(100, { max_frames: src(30) }),
      vision: visionProfile(),
      metrics: media({ duration_seconds: 60 }),
      frame: FRAME,
    });
    if (clamped.status !== 'COUNTED') throw new Error(clamped.reason);
    expect(clamped.frames).toBe(30);
  });

  it('carries the published figure’s own confidence, not the geometry’s', () => {
    const r = countVideoTokens({
      video: published(100, {
        tokens_per_frame: src(100, prov({ method: 'DERIVED', confidence: 'MEDIUM' })),
      }),
      vision: visionProfile(),
      metrics: media(),
      frame: FRAME,
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.confidence).toBe('MEDIUM');
  });

  it('the contract refuses a row that carries BOTH a geometry path and a figure', () => {
    // Two prices for one frame. Which one gets read is then an implementation
    // detail, which is the same defect as two definitions of a contract shape.
    const r = VideoInputProfile.safeParse({
      frame_sample_rate_hz: src(1),
      user_configurable_fps: false,
      per_frame_uses_vision_geometry: true,
      tokens_per_frame: src(100),
      audio_tokens_per_second: src(25),
      audio_billed_separately: false,
      max_duration_seconds: src(3600),
      max_frames: src(3600),
      has_deterministic_formula: true,
      adaptive_mode_available: false,
    });
    expect(r.success).toBe(false);
  });
});

/* ══════════════ TRAP 3 — the sample rate may not be yours to set ══════════════ */

describe('sampleFrames', () => {
  it('uses the requested rate where the provider exposes the setting', () => {
    const r = sampleFrames(videoProfile({ user_configurable_fps: true }), media({ duration_seconds: 60, frame_sample_rate_hz: 0.5 }));
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fps_used).toBe(0.5);
    expect(r.frames).toBe(30);
    expect(r.fps_request_ignored).toBe(false);
  });

  it('DISCARDS a requested rate the provider ignores, loudly', () => {
    // The failure this exists to prevent: a person lowers fps to save money on a
    // model that does not expose the setting, and is handed a smaller number for a
    // change that never happened.
    const r = sampleFrames(videoProfile({ user_configurable_fps: false }), media({ duration_seconds: 60, frame_sample_rate_hz: 0.5 }));
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fps_used).toBe(1);
    expect(r.frames).toBe(60);
    expect(r.fps_request_ignored).toBe(true);
    expect(codes(r.warnings)).toContain('FPS_NOT_CONFIGURABLE');
    expect(messages(r.warnings)).toMatch(/changes nothing, including the cost/);
  });

  it('clamps at max_frames and says coverage stops rising too', () => {
    const r = sampleFrames(videoProfile({ max_frames: src(100) }), media({ duration_seconds: 600 }));
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.frames).toBe(100);
    expect(r.clamped).toBe(true);
    expect(codes(r.warnings)).toContain('VIDEO_FRAMES_CLAMPED_TO_MAX');
    expect(messages(r.warnings)).toMatch(/more thinly sampled/);
  });

  it('refuses an unsourced sample rate — it is the whole cost', () => {
    const r = sampleFrames(videoProfile({ frame_sample_rate_hz: unsourced() }), media());
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/scales the entire estimate/);
  });

  it('rounds partial frames up', () => {
    const r = sampleFrames(videoProfile({ frame_sample_rate_hz: src(0.3) }), media({ duration_seconds: 10 }));
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.frames).toBe(3);
  });
});

/* ══════════════ TRAP 4 — the LOW ceiling is on the answer ══════════════ */

describe('video: §A5.3 forces LOW without a deterministic formula', () => {
  it('keeps the inputs’ confidence when the provider publishes the formula', () => {
    const r = countVideoTokens({ video: videoProfile({ has_deterministic_formula: true }), vision: visionProfile(), metrics: media(), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.confidence).toBe('HIGH');
    expect(r.method).toBe('PROVIDER_FORMULA');
    expect(codes(r.warnings)).not.toContain('VIDEO_HIGH_VARIANCE');
  });

  it('caps at LOW without one, however well sourced every constant is', () => {
    // Every input here is HIGH. The ceiling is a property of the ANSWER, not a
    // footnote that strong provenance can argue away.
    const r = countVideoTokens({ video: videoProfile({ has_deterministic_formula: false }), vision: visionProfile(), metrics: media(), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.confidence).toBe('LOW');
    expect(r.method).toBe('CALIBRATED_HEURISTIC');
    expect(codes(r.warnings)).toContain('VIDEO_HIGH_VARIANCE');
    // and the quantity is unchanged — the ceiling moves confidence, not the number
    expect(r.quantity.p50).toBe(60 * FRAME_TOKENS);
  });

  it('refuses an adaptive sampler with no measured band rather than inventing a spread', () => {
    const r = countVideoTokens({ video: videoProfile({ adaptive_mode_available: true }), vision: visionProfile(), metrics: media(), frame: FRAME });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/P50\/P90 or nothing|fabricated spread/);
  });

  it('prices an adaptive sampler once a measured band is supplied, and the band survives', () => {
    const r = countVideoTokens({
      video: videoProfile({ adaptive_mode_available: true }),
      vision: visionProfile(),
      metrics: media(),
      frame: FRAME,
      observed_frames: { p50: 20, p90: 200, p99: null },
    });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.quantity.p50).toBe(20 * FRAME_TOKENS);
    expect(r.quantity.p90).toBe(200 * FRAME_TOKENS);
    expect(isExact(r.quantity)).toBe(false);
  });
});

/* ══════════════ the audio track ══════════════ */

describe('video: which side of the + the audio track lands on', () => {
  it('folds the track into the video figure where the provider meters them together', () => {
    const r = countVideoTokens({ video: videoProfile({ audio_billed_separately: false }), vision: visionProfile(), metrics: media({ has_audio_track: true }), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.separate_audio).toBeNull();
    expect(r.quantity.p50).toBe(60 * FRAME_TOKENS + 60 * 25);
    expect(codes(r.warnings)).toContain('AUDIO_TRACK_FOLDED_INTO_VIDEO_TOKENS');
  });

  it('returns its own line where it is charged apart, and does not double-count', () => {
    const r = countVideoTokens({ video: videoProfile({ audio_billed_separately: true }), vision: visionProfile(), metrics: media({ has_audio_track: true }), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.quantity.p50).toBe(60 * FRAME_TOKENS);
    expect(r.separate_audio!.quantity.p50).toBe(60 * 25);
  });

  it('a silent clip carries no audio term either way', () => {
    const r = countVideoTokens({ video: videoProfile(), vision: visionProfile(), metrics: media({ has_audio_track: false }), frame: FRAME });
    if (r.status !== 'COUNTED') throw new Error(r.reason);
    expect(r.separate_audio).toBeNull();
    expect(r.quantity.p50).toBe(60 * FRAME_TOKENS);
  });

  it('refuses a clip WITH a track on a model that publishes no audio rate — dropping it understates', () => {
    const r = countVideoTokens({ video: videoProfile({ audio_tokens_per_second: unsourced() }), vision: visionProfile(), metrics: media({ has_audio_track: true }), frame: FRAME });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.reason).toMatch(/understate every clip that has one/);
  });

  it('the audio rate’s confidence only counts when there IS a track', () => {
    const weakAudio = videoProfile({ audio_tokens_per_second: src(25, prov({ method: 'USER_SUPPLIED', confidence: 'LOW', source_class: 'USER_ENTERED', verified_by: 'ops' })) });
    const silent = countVideoTokens({ video: weakAudio, vision: visionProfile(), metrics: media({ has_audio_track: false }), frame: FRAME });
    const withTrack = countVideoTokens({ video: weakAudio, vision: visionProfile(), metrics: media({ has_audio_track: true }), frame: FRAME });
    if (silent.status !== 'COUNTED' || withTrack.status !== 'COUNTED') throw new Error('audio');
    expect(silent.confidence).toBe('HIGH');
    expect(withTrack.confidence).toBe('LOW');
  });
});

describe('video: constraints', () => {
  it('excludes a clip longer than the model accepts', () => {
    const r = countVideoTokens({ video: videoProfile({ max_duration_seconds: src(30) }), vision: visionProfile(), metrics: media({ duration_seconds: 600 }), frame: FRAME });
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') expect(r.exclusion).toBe('ASSET_EXCEEDS_CONSTRAINTS');
  });

  it('rejects mismatched metrics rather than counting the wrong modality', () => {
    expect(countAudioTokens(audioProfile(), media({ modality: 'video' })).status).toBe('UNAVAILABLE');
    expect(countVideoTokens({ video: videoProfile(), vision: visionProfile(), metrics: audio(), frame: FRAME }).status).toBe('UNAVAILABLE');
  });
});
