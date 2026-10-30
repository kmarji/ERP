import { ConfigService } from '@nestjs/config';
import { OpenRouterAssessor, StubRuleAssessor, AssessInput } from './llm.adapters';

const input: AssessInput = {
  language: 'en',
  rubric: { scale: { min: 0, max: 5 }, competencies: [{ key: 'service', name: 'Service', weight: 1, keywords: ['listen', 'apolog', 'solution'] }], thresholds: { advance: 3.5, review: 2.5 } },
  questions: [{ id: 'q1', text: 'Describe handling an angry customer.', competency: 'service', minWords: 10 }],
  answers: [{ questionId: 'q1', text: 'I listened to the customer without interrupting. Then I apologised and offered a solution: a fresh replacement and a discount.' }],
};

describe('StubRuleAssessor', () => {
  it('scores by indicators, quotes evidence and explains itself', async () => {
    const r = await new StubRuleAssessor().assess(input);
    expect(r.scores[0].score).toBeGreaterThanOrEqual(4);
    expect(r.scores[0].evidence.length).toBeGreaterThan(0);
    expect(r.scores[0].reasoning).toContain('listen');
    expect(r.flags).toEqual([]);
  });

  it('flags short or missing answers and lowers confidence', async () => {
    const r = await new StubRuleAssessor().assess({ ...input, answers: [{ questionId: 'q1', text: 'I listen.' }] });
    expect(r.flags.map((f) => f.code)).toContain('SHORT_ANSWERS');
    expect(r.confidence).toBeLessThan(0.6);
    const none = await new StubRuleAssessor().assess({ ...input, answers: [] });
    expect(none.scores[0].score).toBe(0);
    expect(none.flags.map((f) => f.code)).toContain('UNANSWERED');
  });
});

describe('OpenRouterAssessor', () => {
  const cfg = new ConfigService({ OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'test/model' });
  const respond = (content: unknown, ok = true) => jest.spyOn(global, 'fetch').mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }) } as Response);
  afterEach(() => jest.restoreAllMocks());

  it('requires an API key', () => {
    expect(() => new OpenRouterAssessor(new ConfigService({}))).toThrow(/OPENROUTER_API_KEY/);
  });

  it('sends only job-related content (no identifiers) and validates the answer', async () => {
    const spy = respond({ scores: [{ questionId: 'q1', score: 4.5, evidence: ['I listened to the customer without interrupting.'], reasoning: 'Clear service behaviour.' }], confidence: 0.9, flags: [] });
    const r = await new OpenRouterAssessor(cfg).assess(input);
    expect(r.scores[0]).toMatchObject({ score: 4.5, evidence: ['I listened to the customer without interrupting.'] });
    expect(r.confidence).toBe(0.9);
    const sent = JSON.parse((spy.mock.calls[0][1] as any).body);
    expect(sent.model).toBe('test/model');
    expect(JSON.stringify(sent)).not.toMatch(/phone|email|name"/i);
    expect(sent.messages[0].content).toContain('protected characteristic');
  });

  it('discards invented quotes, clamps scores and distrusts an incomplete answer', async () => {
    respond({ scores: [{ questionId: 'q1', score: 9, evidence: ['I once saved the restaurant from a fire.'], reasoning: 'x' }], confidence: 0.95, flags: [] });
    const r = await new OpenRouterAssessor(cfg).assess(input);
    expect(r.scores[0].score).toBe(5);
    expect(r.scores[0].evidence).toEqual([]);
    expect(r.flags.map((f) => f.code)).toContain('EVIDENCE_NOT_FOUND');
    expect(r.confidence).toBeLessThanOrEqual(0.4);

    respond({ scores: [], confidence: 0.9, flags: [] });
    const r2 = await new OpenRouterAssessor(cfg).assess(input);
    expect(r2.flags.map((f) => f.code)).toContain('INCOMPLETE_ASSESSMENT');
  });

  it('fails loudly on malformed output or HTTP errors so a human takes over', async () => {
    respond('not json');
    await expect(new OpenRouterAssessor(cfg).assess(input)).rejects.toThrow();
    respond({ scores: 'nope' });
    await expect(new OpenRouterAssessor(cfg).assess(input)).rejects.toThrow();
    respond({}, false);
    await expect(new OpenRouterAssessor(cfg).assess(input)).rejects.toThrow(/HTTP 500/);
  });
});
