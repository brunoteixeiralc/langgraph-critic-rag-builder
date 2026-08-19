import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrokenCodeSnippets, findTruncatedApproval, looksLikeReasoningLeak } from '../src/graph/nodes/reviewerNode.ts';

// Regression coverage for the exact bug chased down in production: the
// specialist LLM sometimes echoes the "[CODE_SNIPPET_N]" placeholder token
// itself (or leaves it empty) instead of writing real code, which used to
// silently skip Carbonara image generation and let a post get approved with
// zero code images. This is a pure regex check — no LLM/API calls, free to
// run on every commit.
test('findBrokenCodeSnippets', async (t) => {
  await t.test('undefined ou array vazio não tem snippets quebrados', () => {
    assert.deepStrictEqual(findBrokenCodeSnippets(undefined), []);
    assert.deepStrictEqual(findBrokenCodeSnippets([]), []);
  });

  await t.test('código real não é considerado quebrado', () => {
    const snippets = ['import Foundation\nfunc fetchData() async throws -> Data { ... }'];
    assert.deepStrictEqual(findBrokenCodeSnippets(snippets), []);
  });

  await t.test('placeholder exato é detectado como quebrado', () => {
    assert.deepStrictEqual(findBrokenCodeSnippets(['[CODE_SNIPPET_1]']), [1]);
  });

  await t.test('placeholder com dois-pontos e espaço à volta é detectado', () => {
    assert.deepStrictEqual(findBrokenCodeSnippets(['  [CODE_SNIPPET_1]:  ']), [1]);
  });

  await t.test('string vazia ou só espaços é detectada como quebrada', () => {
    assert.deepStrictEqual(findBrokenCodeSnippets(['']), [1]);
    assert.deepStrictEqual(findBrokenCodeSnippets(['   ']), [1]);
  });

  await t.test('placeholder seguido de código real NÃO é quebrado (só o rótulo sobrou)', () => {
    const snippets = ['[CODE_SNIPPET_1]\nimport Foundation\nfunc x() {}'];
    assert.deepStrictEqual(findBrokenCodeSnippets(snippets), []);
  });

  await t.test('array misto reporta só os índices quebrados (1-indexed)', () => {
    const snippets = ['const x = 1;', '[CODE_SNIPPET_2]', 'const y = 2;'];
    assert.deepStrictEqual(findBrokenCodeSnippets(snippets), [2]);
  });

  await t.test('múltiplos snippets quebrados são todos reportados', () => {
    const snippets = ['[CODE_SNIPPET_1]', '', 'const real = true;'];
    assert.deepStrictEqual(findBrokenCodeSnippets(snippets), [1, 2]);
  });
});

// Regression coverage for a real production bug: the Reviewer has to
// reproduce the entire final post inside one structured-output field on
// approval — for a long draft, a model can quietly cut that field short
// (still valid JSON, just incomplete content) instead of erroring out. The
// post that shipped was ~250 chars, ended mid-sentence inside a raw code
// line, and had zero [IMAGE_CODE_N] placeholders despite 3 code snippets
// having been generated.
test('findTruncatedApproval', async (t) => {
  await t.test('post longo com todos os placeholders presentes não é truncado', () => {
    const post = 'A'.repeat(150) + ' [IMAGE_CODE_1] more text ' + '[IMAGE_CODE_2]';
    assert.strictEqual(findTruncatedApproval(post, 2), null);
  });

  await t.test('post text-only (sem snippets) só precisa passar do tamanho mínimo', () => {
    assert.strictEqual(findTruncatedApproval('A'.repeat(150), 0), null);
  });

  await t.test('post curto demais é reportado como too_short mesmo sem snippets', () => {
    assert.strictEqual(findTruncatedApproval('short', 0), 'too_short');
  });

  await t.test('post curto demais é reportado como too_short mesmo com placeholders presentes', () => {
    assert.strictEqual(findTruncatedApproval('[IMAGE_CODE_1]', 1), 'too_short');
  });

  await t.test('faltando um placeholder no meio é reportado (1-indexed)', () => {
    const post = 'A'.repeat(150) + ' [IMAGE_CODE_1] text [IMAGE_CODE_3]';
    assert.deepStrictEqual(findTruncatedApproval(post, 3), [2]);
  });

  await t.test('faltando todos os placeholders é reportado', () => {
    const post = 'A'.repeat(150);
    assert.deepStrictEqual(findTruncatedApproval(post, 2), [1, 2]);
  });

  await t.test('placeholders fora de ordem ainda contam como presentes', () => {
    const post = 'A'.repeat(150) + ' [IMAGE_CODE_2] then [IMAGE_CODE_1]';
    assert.strictEqual(findTruncatedApproval(post, 2), null);
  });
});

// Regression coverage for a real production bug: with structured output
// forced via tool-calling, a reasoning model's 'feedback' field ended up
// containing its raw internal monologue instead of a verdict — burning a
// review attempt (out of only MAX_REVIEW_ATTEMPTS=3) on unusable text.
test('looksLikeReasoningLeak', async (t) => {
  await t.test('undefined ou string vazia não é reasoning leak', () => {
    assert.strictEqual(looksLikeReasoningLeak(undefined), false);
    assert.strictEqual(looksLikeReasoningLeak(null), false);
    assert.strictEqual(looksLikeReasoningLeak(''), false);
  });

  await t.test('feedback normal e decisivo não é reasoning leak', () => {
    const feedback = 'The draft claims `#expect(processExitsWith:)` is the correct macro, but the real API requires the `.failure` exit condition argument: `#expect(processExitsWith: .failure) { ... }`. Fix snippet 3.';
    assert.strictEqual(looksLikeReasoningLeak(feedback), false);
  });

  await t.test('feedback com um "wait," isolado não é reasoning leak (falante mas decisivo)', () => {
    const feedback = 'Wait, actually the version number cited (iOS 16) is wrong — the API was introduced in iOS 17. Reject and correct.';
    assert.strictEqual(looksLikeReasoningLeak(feedback), false);
  });

  await t.test('monólogo real (do print de produção) é detectado como reasoning leak', () => {
    const feedback = `The correct API is #expect(processExitsWith: .failure) { ... } — wait, that's what the draft has. Actually, the correct API is #expect(processExitsWith: .failure) { ... } — no, the real API is #expect(processExitsWith: .failure) { ... }. Hmm, I need to verify. Let me re-check carefully. I'm going in circles. I need to stop.`;
    assert.strictEqual(looksLikeReasoningLeak(feedback), true);
  });
});
