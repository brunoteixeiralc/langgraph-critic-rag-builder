import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUrls } from '../src/services/webContentService.ts';

// Detects URLs pasted into a user's topic/command so the specialist nodes
// can fetch them as live [WEB_DATA] grounding. Pure regex, no network calls.
test('extractUrls', async (t) => {
  await t.test('texto sem URL retorna array vazio', () => {
    assert.deepStrictEqual(extractUrls('Explain how async/await works'), []);
  });

  await t.test('extrai uma única URL', () => {
    const text = 'Check this out: https://developer.apple.com/documentation/swift/concurrency';
    assert.deepStrictEqual(extractUrls(text), ['https://developer.apple.com/documentation/swift/concurrency']);
  });

  await t.test('extrai múltiplas URLs (http e https)', () => {
    const text = 'See http://example.com/a and https://example.com/b for details';
    assert.deepStrictEqual(extractUrls(text), ['http://example.com/a', 'https://example.com/b']);
  });

  await t.test('não inclui pontuação de fechamento colada na URL', () => {
    const text = 'Source (https://example.com/page) explains this.';
    assert.deepStrictEqual(extractUrls(text), ['https://example.com/page']);
  });

  await t.test('não inclui aspas coladas na URL', () => {
    const text = 'link="https://example.com/page" more text';
    assert.deepStrictEqual(extractUrls(text), ['https://example.com/page']);
  });
});
