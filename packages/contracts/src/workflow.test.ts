import { describe, it, expect } from 'vitest';
import {
  MetricSource,
  ScriptFamily,
  DetectedScript,
  Languages,
  ParseMeta,
  TextMetrics,
  AssetDisposition,
  ImageMetrics,
  Task,
  WorkflowInput,
} from './workflow';
import { Script } from './vision';

const flags = { requires_reasoning: false, requires_vision: false, requires_tool_calling: false };

const task = (over: Record<string, unknown> = {}) => ({
  task_id: 't1',
  sequence_index: 0,
  type: 'READ' as const,
  volume: 1,
  flags,
  ...over,
});

const workflow = (over: Record<string, unknown> = {}) => ({
  languages: { payload_languages: [{ code: 'en', share: 1 }] },
  tasks: [task()],
  assumptions: [],
  ambiguities: [],
  missing_data: [],
  confidence: 'MEDIUM' as const,
  needs_human_review: false,
  ...over,
});

describe('MetricSource is not Provenance', () => {
  // The prior JSON schema called this `provenance`, colliding with the object in
  // provenance.ts. Renamed; this test exists so the rename is not undone.
  it('is the five-value metric-origin enum, not method/confidence/source_url', () => {
    expect(MetricSource.options).toEqual([
      'USER_STATED',
      'MEASURED_FROM_ASSET',
      'DERIVED_FROM_ASSET',
      'DEFAULT_APPLIED',
      'MISSING',
    ]);
  });
});

describe('script vocabularies stay at their own granularity', () => {
  it('ScriptFamily is coarse families; Script is calibration buckets', () => {
    expect(ScriptFamily.options).toEqual(['latin', 'arabic', 'han', 'cyrillic', 'other']);
    expect(Script.options).toContain('ar_vocalized');
    expect(Script.options).not.toContain('arabic');
  });

  it('FINDING: cyrillic has a family but no legibility-floor bucket', () => {
    // Recorded as a test rather than a comment so it surfaces when someone
    // extends Script. Delete this test when a cyrillic bucket lands.
    expect(ScriptFamily.options).toContain('cyrillic');
    expect(Script.options).not.toContain('cyrillic');
  });

  it('DetectedScript is the families plus the two non-answers', () => {
    expect(DetectedScript.options).toContain('mixed');
    expect(DetectedScript.options).toContain('unknown');
    for (const f of ScriptFamily.options) expect(DetectedScript.options).toContain(f);
  });
});

describe('Languages', () => {
  it('requires payload shares to sum to 1', () => {
    expect(
      Languages.safeParse({ payload_languages: [{ code: 'ar', share: 0.5 }] }).success,
    ).toBe(false);
    expect(
      Languages.safeParse({
        payload_languages: [
          { code: 'ar', share: 0.7 },
          { code: 'en', share: 0.3 },
        ],
      }).success,
    ).toBe(true);
  });

  it('does not let a UI language enter the cost math', () => {
    const l = Languages.parse({
      ui_language: 'ar',
      payload_languages: [{ code: 'en', share: 1 }],
    });
    expect(l.payload_languages.map((p) => p.code)).toEqual(['en']);
  });
});

describe('ParseMeta', () => {
  it('makes an L2 parse name its parser, because it is a billable call', () => {
    expect(
      ParseMeta.safeParse({ layer: 'L2_LLM_PARSE', parse_confidence: 0.8 }).success,
    ).toBe(false);
    expect(
      ParseMeta.safeParse({
        layer: 'L2_LLM_PARSE',
        parse_confidence: 0.8,
        parser_model_id: 'some-parser',
      }).success,
    ).toBe(true);
  });

  it('leaves L1 alone', () => {
    expect(ParseMeta.safeParse({ layer: 'L1_DETERMINISTIC', parse_confidence: 1 }).success).toBe(
      true,
    );
  });
});

describe('TextMetrics', () => {
  const tm = (over: Record<string, unknown> = {}) => ({
    character_count_source: 'MEASURED_FROM_ASSET' as const,
    ...over,
  });

  it('refuses arabic_vocalized without the density it is derived from', () => {
    expect(TextMetrics.safeParse(tm({ arabic_vocalized: true })).success).toBe(false);
    expect(
      TextMetrics.safeParse(tm({ arabic_vocalized: true, diacritic_density: 0.42 })).success,
    ).toBe(true);
  });

  it('requires a window size for SLIDING_WINDOW', () => {
    expect(TextMetrics.safeParse(tm({ history_strategy: 'SLIDING_WINDOW' })).success).toBe(false);
    expect(
      TextMetrics.safeParse(tm({ history_strategy: 'SLIDING_WINDOW', history_window_k: 8 })).success,
    ).toBe(true);
  });

  it('will not let present-but-uncounted tool schemas silently bill as zero', () => {
    expect(TextMetrics.safeParse(tm({ tool_schemas_present: true })).success).toBe(false);
    expect(
      TextMetrics.safeParse(tm({ tool_schemas_present: true, tool_schema_character_count: 900 }))
        .success,
    ).toBe(true);
  });

  it('accepts a partial script_mix that sums to 1', () => {
    expect(TextMetrics.safeParse(tm({ script_mix: { arabic: 1 } })).success).toBe(true);
    expect(TextMetrics.safeParse(tm({ script_mix: { arabic: 0.6, latin: 0.4 } })).success).toBe(
      true,
    );
    expect(TextMetrics.safeParse(tm({ script_mix: { arabic: 0.6 } })).success).toBe(false);
  });

  it('leaves pdf_has_text_layer null by default — UNKNOWN, not false', () => {
    expect(TextMetrics.parse(tm()).pdf_has_text_layer).toBeNull();
  });
});

describe('AssetDisposition (§A5.2.1)', () => {
  it('only proposes a resize when the recomputed grid is actually smaller', () => {
    expect(
      AssetDisposition.safeParse({ rung: 'RESIZE_PROPOSED', recomputed_tile_delta: 4 }).success,
    ).toBe(false);
    expect(
      AssetDisposition.safeParse({ rung: 'RESIZE_PROPOSED', recomputed_tile_delta: 0 }).success,
    ).toBe(false);
    expect(
      AssetDisposition.safeParse({ rung: 'RESIZE_PROPOSED', recomputed_tile_delta: -6 }).success,
    ).toBe(true);
  });

  it('makes a normalizing provider name its rule', () => {
    expect(AssetDisposition.safeParse({ rung: 'PROVIDER_NORMALIZED' }).success).toBe(false);
    expect(
      AssetDisposition.safeParse({
        rung: 'PROVIDER_NORMALIZED',
        transform_rule: 'long edge clamped to 1568px by the provider',
      }).success,
    ).toBe(true);
  });
});

describe('ImageMetrics', () => {
  const im = (over: Record<string, unknown> = {}) => ({
    dimensions_source: 'MEASURED_FROM_ASSET' as const,
    operation: 'analyze' as const,
    ...over,
  });

  it('requires a transform rule behind a derived measurement', () => {
    expect(ImageMetrics.safeParse(im({ dimensions_source: 'DERIVED_FROM_ASSET' })).success).toBe(
      false,
    );
    expect(
      ImageMetrics.safeParse(
        im({
          dimensions_source: 'DERIVED_FROM_ASSET',
          asset_disposition: { rung: 'FITS_AS_IS', transform_rule: 'accepted resize to 1024px' },
        }),
      ).success,
    ).toBe(true);
  });

  it('blocks the resize rung when the user marked the asset fidelity-critical', () => {
    const r = ImageMetrics.safeParse(
      im({
        fidelity_critical: true,
        asset_disposition: { rung: 'RESIZE_PROPOSED', recomputed_tile_delta: -3 },
      }),
    );
    expect(r.success).toBe(false);
  });

  it('requires a mask to inpaint and a multiplier to upscale', () => {
    expect(ImageMetrics.safeParse(im({ operation: 'inpaint' })).success).toBe(false);
    expect(ImageMetrics.safeParse(im({ operation: 'inpaint', mask_present: true })).success).toBe(
      true,
    );
    expect(ImageMetrics.safeParse(im({ operation: 'upscale' })).success).toBe(false);
    expect(
      ImageMetrics.safeParse(im({ operation: 'upscale', upscale_multiplier: 2 })).success,
    ).toBe(true);
  });
});

describe('Task', () => {
  it('defaults execution_probability to 1', () => {
    expect(Task.parse(task()).execution_probability).toBe(1);
  });

  it('makes a task carrying image metrics declare it requires vision', () => {
    const withImage = task({
      image_metrics: { dimensions_source: 'USER_STATED', operation: 'analyze' },
    });
    expect(Task.safeParse(withImage).success).toBe(false);
    expect(
      Task.safeParse({ ...withImage, flags: { ...flags, requires_vision: true } }).success,
    ).toBe(true);
  });

  it('rejects a READ task with an unbounded output band', () => {
    expect(Task.safeParse(task({ expected_output_band: 'unbounded' })).success).toBe(false);
    expect(
      Task.safeParse(task({ type: 'WRITE', expected_output_band: 'unbounded' })).success,
    ).toBe(true);
  });
});

describe('WorkflowInput', () => {
  it('accepts the empty-tasks refusal the analyzer is told to return', () => {
    const r = WorkflowInput.safeParse(
      workflow({
        tasks: [],
        confidence: 'LOW',
        needs_human_review: true,
        missing_data: [
          { field: 'everything', question: 'What are you trying to do?', blocks_estimate: true },
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it('will not let a blocking gap be filed as a footnote', () => {
    const r = WorkflowInput.safeParse(
      workflow({
        needs_human_review: false,
        missing_data: [
          { field: 'pdf_has_text_layer', question: 'Scanned or text layer?', blocks_estimate: true },
        ],
      }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects confidence NONE — that is reserved for a produced figure', () => {
    expect(WorkflowInput.safeParse(workflow({ confidence: 'NONE' })).success).toBe(false);
    expect(WorkflowInput.safeParse(workflow({ confidence: 'LOW' })).success).toBe(true);
  });

  it('requires unique task ids', () => {
    expect(
      WorkflowInput.safeParse(workflow({ tasks: [task(), task({ sequence_index: 1 })] })).success,
    ).toBe(false);
  });

  it('requires expands_from to name a task in this workflow', () => {
    const r = WorkflowInput.safeParse(
      workflow({ tasks: [task({ expands_from: 'nonexistent' })] }),
    );
    expect(r.success).toBe(false);
  });

  it('accepts a compound verb expanded into a real pair', () => {
    const r = WorkflowInput.safeParse(
      workflow({
        tasks: [
          task(),
          task({ task_id: 't2', sequence_index: 1, type: 'WRITE', expands_from: 't1' }),
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it('rejects an assumption scoped to a task that does not exist', () => {
    const r = WorkflowInput.safeParse(
      workflow({
        assumptions: [
          {
            task_id: 'ghost',
            field: 'page_count',
            value: 10,
            basis: 'DEFAULT_APPLIED',
            impact_if_wrong: 'HIGH',
          },
        ],
      }),
    );
    expect(r.success).toBe(false);
  });
});
