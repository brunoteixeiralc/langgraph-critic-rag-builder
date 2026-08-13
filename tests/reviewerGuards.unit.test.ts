import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrokenCodeSnippets } from '../src/graph/nodes/reviewerNode.ts';

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
