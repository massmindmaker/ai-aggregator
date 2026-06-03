import { describe, it, expect, vi } from 'vitest';
import { buildContestEvalProcessor } from '../contest-eval.js';

function makeJob(data: Record<string, unknown>) {
  return { name: 'eval', data, queue: { add: vi.fn() } } as unknown as Parameters<
    ReturnType<typeof buildContestEvalProcessor>
  >[0];
}

describe('contest-eval processor', () => {
  it('maps successful run to status=success with score', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ ok: true, score: 0.87, output: '{"score":0.87}' });
    const proc = buildContestEvalProcessor({ run, sink });
    await proc(
      makeJob({
        submissionId: 's1',
        evaluatorScriptId: 'e1',
        scriptSource: 'print(1)',
        submissionFiles: [],
        inputJson: {},
      }),
      'tok'
    );
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 's1', status: 'success', publicScore: 0.87 })
    );
  });

  it('maps timeout error to status=timeout', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ ok: false, error: 'timeout', output: '' });
    const proc = buildContestEvalProcessor({ run, sink });
    await proc(
      makeJob({
        submissionId: 's2',
        evaluatorScriptId: 'e1',
        scriptSource: '',
        submissionFiles: [],
        inputJson: {},
      }),
      'tok'
    );
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ status: 'timeout' }));
  });

  it('maps invalid JSON to status=invalid', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ ok: false, error: 'Invalid JSON output', output: 'lol' });
    const proc = buildContestEvalProcessor({ run, sink });
    await proc(
      makeJob({
        submissionId: 's3',
        evaluatorScriptId: 'e1',
        scriptSource: '',
        submissionFiles: [],
        inputJson: {},
      }),
      'tok'
    );
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid' }));
  });
});
