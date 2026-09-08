// /packages/estimator/src/media.ts
//
// §A5.3 — audio and video input. "Duration-driven, not byte-driven."
//
//   audio_tokens = ceil(duration_seconds) x tokens_per_second[model]
//   video_tokens = frames_sampled x per_frame_image_tokens + audio_track_tokens
//
// Two lines of arithmetic with four ways to be confidently wrong:
//
//   1. Audio is billed two different ways.  Some providers convert duration to
//      tokens; others bill seconds against a per-second rate (§A5.8's identity
//      writes `audio_seconds x audio_rate`). Reading a row as the wrong one is a
//      mispricing that scales with the length of the recording. `billing_basis`
//      discriminates and there is no fallback between them.
//
//   2. `per_frame_image_tokens` is a §A5.2 geometry result.  A video is a stack of
//      images, so the vision geometry IS the per-frame input — the same coupling
//      §A5.9.1 makes for VRAM. A geometry error multiplies by the frame count.
//
//   3. The frame sample rate may not be yours to set.  §A5.3 calls sampling "the
//      whole cost" and the profile records whether the provider lets you configure
//      it. A user who lowers fps on a model that ignores the setting has changed
//      nothing and been told they saved money.
//
//   4. Video is the highest-variance modality.  §A5.3: "force confidence: LOW
//      unless the provider publishes a deterministic formula." That is a ceiling on
//      the ANSWER, not a note attached to it, so it is applied here and cannot be
//      argued away downstream by strong provenance on the constants.
//
// Where the count is arithmetic, it is returned as an exact range: what is uncertain
// is whether the CONSTANTS are right, and `range.ts` explains at length why that
// belongs on method + confidence rather than on a widened band. The exception is
// adaptive sampling, where the provider decides at run time how much to load — there
// the quantity itself varies, the band is real, and with nothing measured the honest
// output is a refusal rather than a fabricated spread.

import {
  minConfidence,
  type AudioInputProfile,
  type Confidence,
  type MediaMetrics,
  type Method,
  type Range,
  type VideoInputProfile,
  type VisionProfile,
} from '@tokenomics/contracts';
import { exactRange } from './range';
import { countVisionTokens, type VisionRequest } from './vision';

/* ═══════════════════════ shared result shape ═══════════════════════ */

export interface MediaCounted {
  status: 'COUNTED';
  quantity: Range;
  /** `tokens` for a token-billed asset, `seconds` for a duration-billed one. */
  unit: 'tokens' | 'seconds';
  method: Method;
  confidence: Confidence;
  warnings: string[];
  notes: string[];
}

export interface MediaUnavailable {
  status: 'UNAVAILABLE';
  reason: string;
  method: 'UNAVAILABLE';
  confidence: 'NONE';
  /** Set when the asset itself is out of spec rather than the data being missing. */
  exclusion: 'ASSET_EXCEEDS_CONSTRAINTS' | null;
}

export type MediaCount = MediaCounted | MediaUnavailable;

const refuse = (
  reason: string,
  exclusion: MediaUnavailable['exclusion'] = null,
): MediaUnavailable => ({
  status: 'UNAVAILABLE',
  reason,
  method: 'UNAVAILABLE',
  confidence: 'NONE',
  exclusion,
});

/* ═══════════════════════ 1. audio ═══════════════════════ */

/**
 * §A5.3's ceiling, at whatever granularity the provider publishes.
 *
 * The spec writes `ceil(duration_seconds)`. Where a vendor publishes a finer
 * granularity that overrides it; where none is published the whole-second ceiling
 * applies and says so, because "the spec rounds up to a second" and "this vendor
 * bills whole seconds" are different claims and only one of them is sourced.
 */
export function billableDuration(
  durationSeconds: number,
  granularitySeconds: number | null,
): { seconds: number; granularity: number; sourced: boolean } {
  const g = granularitySeconds ?? 1;
  return {
    seconds: Math.ceil(durationSeconds / g) * g,
    granularity: g,
    sourced: granularitySeconds !== null,
  };
}

export function countAudioTokens(profile: AudioInputProfile, m: MediaMetrics): MediaCount {
  if (m.modality !== 'audio') {
    return refuse(`countAudioTokens received ${m.modality} metrics.`);
  }
  if (m.duration_seconds === null) {
    return refuse(
      'Audio cost is duration-driven and no duration was measured. Byte size is not a substitute — the same minute of speech varies by an order of magnitude in bytes across codecs (§A5.3).',
    );
  }
  if (m.duration_seconds === 0) {
    return refuse('A zero-length recording has nothing to price.');
  }

  const notes: string[] = [];
  const warnings: string[] = [];

  const maxDuration = profile.max_duration_seconds.value;
  if (maxDuration !== null && m.duration_seconds > maxDuration) {
    return refuse(
      `The recording is ${m.duration_seconds}s and this model accepts ${maxDuration}s. It must be split before it can be priced, and the split is a decision for the caller, not a clamp applied here.`,
      'ASSET_EXCEEDS_CONSTRAINTS',
    );
  }

  const billed = billableDuration(m.duration_seconds, profile.billing_granularity_seconds.value);
  if (!billed.sourced) {
    notes.push(
      'No published billing granularity, so §A5.3’s whole-second ceiling is applied. A vendor billing finer than that is overcharged here by under a second per request.',
    );
  }

  if (profile.multichannel_multiplies === null) {
    notes.push(
      'Whether a multichannel or diarized track multiplies the count is unrecorded for this model. A stereo recording may bill twice; this figure assumes one channel.',
    );
  }

  if (profile.billing_basis === 'PER_SECOND') {
    return {
      status: 'COUNTED',
      quantity: exactRange(billed.seconds),
      unit: 'seconds',
      method: 'PROVIDER_FORMULA',
      confidence: profile.max_duration_seconds.provenance.confidence,
      warnings,
      notes: [
        `Billed per second at ${billed.granularity}s granularity. This model publishes no token equivalence, and displaying a synthesized one would be a fabricated figure wearing a plausible unit.`,
        ...notes,
      ],
    };
  }

  const tps = profile.tokens_per_second.value;
  if (tps === null) {
    return refuse(
      'This model bills audio per token but publishes no tokens-per-second. The conversion cannot be guessed, and a rate borrowed from another model is another model’s answer (§A3.2).',
    );
  }

  return {
    status: 'COUNTED',
    quantity: exactRange(billed.seconds * tps),
    unit: 'tokens',
    method: 'PROVIDER_FORMULA',
    confidence: profile.tokens_per_second.provenance.confidence,
    warnings,
    notes: [`ceil(${m.duration_seconds}s / ${billed.granularity}) x ${tps} tokens/s.`, ...notes],
  };
}

/* ═══════════════════════ 2. frame sampling ═══════════════════════ */

export interface FrameSampling {
  frames: number;
  fps_used: number;
  /** True when the caller's requested fps was discarded because it is not settable. */
  fps_request_ignored: boolean;
  /** True when max_frames bit — the provider samples fewer than the rate implies. */
  clamped: boolean;
  warnings: string[];
  notes: string[];
}

export type FrameSamplingResult =
  | ({ status: 'OK' } & FrameSampling)
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * §A5.3 — "frame sampling IS the video cost."
 *
 * The trap here is `user_configurable_fps`. A task may state a sample rate because
 * the person believes lowering it lowers the bill. On a model that does not expose
 * the setting, the provider samples at its own rate and the request is silently
 * discarded — so it is discarded LOUDLY here instead. Quietly honouring it would
 * hand back a smaller number for a change that never happened.
 */
export function sampleFrames(profile: VideoInputProfile, m: MediaMetrics): FrameSamplingResult {
  if (m.duration_seconds === null) {
    return { status: 'UNAVAILABLE', reason: 'Frame count is duration x sample rate, and no duration was measured.' };
  }
  const modelFps = profile.frame_sample_rate_hz.value;
  if (modelFps === null) {
    return {
      status: 'UNAVAILABLE',
      reason: 'The frame sample rate is unsourced, and it is the whole cost — a guess here scales the entire estimate.',
    };
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  let fps = modelFps;
  let ignored = false;

  if (m.frame_sample_rate_hz !== null && m.frame_sample_rate_hz !== modelFps) {
    if (profile.user_configurable_fps) {
      fps = m.frame_sample_rate_hz;
      notes.push(`Sampling at the requested ${fps} Hz rather than the model default of ${modelFps} Hz.`);
    } else {
      ignored = true;
      warnings.push('FPS_NOT_CONFIGURABLE');
      notes.push(
        `A sample rate of ${m.frame_sample_rate_hz} Hz was requested, but this model does not expose the setting and samples at ${modelFps} Hz. The request changes nothing, including the cost.`,
      );
    }
  }

  const uncapped = Math.ceil(m.duration_seconds * fps);
  const maxFrames = profile.max_frames.value;
  let frames = uncapped;
  let clamped = false;

  if (maxFrames !== null && uncapped > maxFrames) {
    frames = maxFrames;
    clamped = true;
    warnings.push('VIDEO_FRAMES_CLAMPED_TO_MAX');
    notes.push(
      `The rate implies ${uncapped} frames and the model caps at ${maxFrames}. The cost stops rising at the cap, but so does the coverage — beyond here a longer video is not more expensive, it is more thinly sampled.`,
    );
  }

  return { status: 'OK', frames, fps_used: fps, fps_request_ignored: ignored, clamped, warnings, notes };
}

/* ═══════════════════════ 3. video ═══════════════════════ */

export interface VideoCountInput {
  video: VideoInputProfile;
  /** §A5.2 geometry. A video is a stack of images and this is what prices one. */
  vision: VisionProfile;
  metrics: MediaMetrics;
  /** Dimensions of a sampled frame. Frames of one video share them. */
  frame: VisionRequest;
  /**
   * A measured band for a model that samples adaptively. Without it an adaptive
   * model is refused rather than given an invented spread.
   */
  observed_frames?: Range;
}

export interface VideoCounted extends MediaCounted {
  frames: number;
  per_frame_tokens: number;
  /**
   * Present when the audio track bills on its own line. Null when there is no track,
   * or when the provider folds it into the video token count (in which case it is
   * already inside `quantity`).
   */
  separate_audio: { quantity: Range; unit: 'tokens' } | null;
}

export type VideoCount = VideoCounted | MediaUnavailable;

/**
 *   video_tokens = frames_sampled x per_frame_image_tokens + audio_track_tokens
 *
 * `audio_billed_separately` decides which side of that `+` the audio lands on: folded
 * into the video quantity when the provider meters them together, or returned as its
 * own line when it is charged apart. Both are real and the difference is visible on
 * an invoice, so the flag is honoured rather than one convention being picked.
 */
export function countVideoTokens(input: VideoCountInput): VideoCount {
  const { video, vision, metrics: m } = input;

  if (m.modality !== 'video') return refuse(`countVideoTokens received ${m.modality} metrics.`);
  if (m.duration_seconds === null) {
    return refuse('Video cost is duration x sample rate x per-frame tokens, and no duration was measured.');
  }

  const maxDuration = video.max_duration_seconds.value;
  if (maxDuration !== null && m.duration_seconds > maxDuration) {
    return refuse(
      `The clip is ${m.duration_seconds}s and this model accepts ${maxDuration}s.`,
      'ASSET_EXCEEDS_CONSTRAINTS',
    );
  }

  // §A5.3 — an adaptive sampler decides at run time how much to load, so the
  // QUANTITY genuinely varies. The contracts put it plainly: that is P50/P90 or
  // nothing. With nothing measured, nothing is the honest answer.
  if (video.adaptive_mode_available && input.observed_frames === undefined) {
    return refuse(
      'This model can sample adaptively, so the frame count is not a function of duration — the band can span an order of magnitude on one input. Supply an observed frame range or the estimate is a fabricated spread (§A5.3).',
    );
  }

  const sampling = sampleFrames(video, m);
  if (sampling.status === 'UNAVAILABLE') return refuse(sampling.reason);

  if (!video.per_frame_uses_vision_geometry) {
    return refuse(
      'This model does not price video frames through its image geometry, and no alternative per-frame count is published. There is nothing to multiply by (§A5.3).',
    );
  }

  const frame = countVisionTokens(vision, input.frame);
  if (frame.status === 'UNAVAILABLE') {
    return refuse(`Per-frame geometry is unavailable, so the video cannot be priced: ${frame.reason}`);
  }

  const warnings = [...sampling.warnings];
  const notes = [...sampling.notes, ...frame.notes];

  const frames = input.observed_frames === undefined ? sampling.frames : null;
  const frameRange: Range =
    input.observed_frames ?? exactRange(sampling.frames);

  let videoTokens: Range = {
    p50: frameRange.p50 * frame.tokens,
    p90: frameRange.p90 * frame.tokens,
    p99: frameRange.p99 === null ? null : frameRange.p99 * frame.tokens,
  };

  // ── the audio track ──────────────────────────────────────────────────────────
  let separateAudio: VideoCounted['separate_audio'] = null;
  if (m.has_audio_track) {
    const aps = video.audio_tokens_per_second.value;
    if (aps === null) {
      return refuse(
        'The clip has an audio track and this model publishes no audio tokens-per-second. Dropping the track from the estimate would understate every clip that has one.',
      );
    }
    const audioTokens = Math.ceil(m.duration_seconds) * aps;
    if (video.audio_billed_separately) {
      separateAudio = { quantity: exactRange(audioTokens), unit: 'tokens' };
      notes.push(`Audio track billed separately: ceil(${m.duration_seconds}s) x ${aps} tokens/s.`);
    } else {
      videoTokens = {
        p50: videoTokens.p50 + audioTokens,
        p90: videoTokens.p90 + audioTokens,
        p99: videoTokens.p99 === null ? null : videoTokens.p99 + audioTokens,
      };
      warnings.push('AUDIO_TRACK_FOLDED_INTO_VIDEO_TOKENS');
      notes.push(
        `Audio track metered with the frames on this model, so ${audioTokens} tokens are inside the video figure rather than on their own line.`,
      );
    }
  }

  // ── §A5.3's confidence ceiling ───────────────────────────────────────────────
  // A ceiling on the ANSWER, not a footnote on it. Applied last so that strong
  // provenance on the sample rate and the geometry cannot lift a figure the
  // provider never committed to.
  const inputs = minConfidence(
    frame.confidence,
    video.frame_sample_rate_hz.provenance.confidence,
    ...(m.has_audio_track ? [video.audio_tokens_per_second.provenance.confidence] : []),
  );
  let confidence = inputs;
  if (!video.has_deterministic_formula) {
    confidence = minConfidence(inputs, 'LOW');
    warnings.push('VIDEO_HIGH_VARIANCE');
    notes.push(
      'This provider publishes no deterministic frame-sampling formula, so the count is what the documented parameters imply rather than what the provider guarantees. §A5.3 caps that at LOW however well sourced the individual constants are.',
    );
  }

  return {
    status: 'COUNTED',
    quantity: videoTokens,
    unit: 'tokens',
    method: video.has_deterministic_formula ? 'PROVIDER_FORMULA' : 'CALIBRATED_HEURISTIC',
    confidence,
    warnings,
    notes,
    frames: frames ?? frameRange.p50,
    per_frame_tokens: frame.tokens,
    separate_audio: separateAudio,
  };
}
