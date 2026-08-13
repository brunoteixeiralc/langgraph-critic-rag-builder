import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, chunkId, isRateLimitError } from '../src/scripts/ingest.ts';

// These are the building blocks of the Pinecone ingestion pipeline: how a
// source page gets split into chunks, how each chunk's ID is derived
// (determines whether re-ingesting the same source overwrites cleanly
// instead of duplicating), and how a Gemini rate-limit error gets detected
// to trigger the ~65s backoff instead of a short retry. All pure functions —
// importing this module must NOT trigger a real ingestion run (see the
// `isMainModule` guard at the bottom of ingest.ts).
test('chunkText', async (t) => {
  await t.test('texto vazio não gera chunks', () => {
    assert.deepStrictEqual(chunkText('', 100, 10), []);
  });

  await t.test('texto menor que chunkSize vira um único chunk', () => {
    assert.deepStrictEqual(chunkText('hello world', 100, 10), ['hello world']);
  });

  await t.test('texto longo é dividido com overlap correto', () => {
    // 10 chars, chunkSize=4, overlap=1 -> "0123","3456","6789"
    const result = chunkText('0123456789', 4, 1);
    assert.deepStrictEqual(result, ['0123', '3456', '6789']);
  });

  await t.test('último chunk nunca ultrapassa o fim do texto', () => {
    const result = chunkText('abcde', 3, 1);
    for (const chunk of result) {
      assert.ok(chunk.length <= 3);
    }
    assert.strictEqual(result[result.length - 1].endsWith('e'), true);
  });
});

test('chunkId', async (t) => {
  await t.test('é determinístico: mesma fonte + índice gera o mesmo id', () => {
    const id1 = chunkId('https://example.com/page', 0);
    const id2 = chunkId('https://example.com/page', 0);
    assert.strictEqual(id1, id2);
  });

  await t.test('índices diferentes geram ids diferentes', () => {
    const id0 = chunkId('https://example.com/page', 0);
    const id1 = chunkId('https://example.com/page', 1);
    assert.notStrictEqual(id0, id1);
  });

  await t.test('fontes diferentes geram ids diferentes', () => {
    const idA = chunkId('https://example.com/a', 0);
    const idB = chunkId('https://example.com/b', 0);
    assert.notStrictEqual(idA, idB);
  });

  await t.test('formato é hex de 32 caracteres', () => {
    const id = chunkId('https://example.com/page', 0);
    assert.match(id, /^[0-9a-f]{32}$/);
  });
});

test('isRateLimitError', async (t) => {
  await t.test('reconhece as mensagens de rate limit/quota que já vimos em produção', () => {
    assert.strictEqual(isRateLimitError('Vector dimension 0 does not match the dimension of the index 3072'), true);
    assert.strictEqual(isRateLimitError('[429 Too Many Requests] rate limit exceeded'), true);
    assert.strictEqual(isRateLimitError('RESOURCE_EXHAUSTED: quota exceeded'), true);
    assert.strictEqual(isRateLimitError('Your prepayment credits are depleted (429)'), true);
  });

  await t.test('não confunde erro genérico com rate limit', () => {
    assert.strictEqual(isRateLimitError('Network request failed'), false);
    assert.strictEqual(isRateLimitError('Invalid API key'), false);
  });
});
