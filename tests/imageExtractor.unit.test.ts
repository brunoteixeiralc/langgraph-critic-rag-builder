import test from 'node:test';
import assert from 'node:assert/strict';
import { getExtension } from '../src/graph/nodes/imageExtractorNode.ts';

// Decides the file extension used when saving a specialist's raw code
// snippet to disk (and, indirectly, whether Carbonara syntax-highlights it
// as the right language). Pure function, no I/O.
test('getExtension', async (t) => {
  await t.test('niche "ios" sempre usa .swift, independente do código', () => {
    assert.strictEqual(getExtension('ios', 'anything'), 'swift');
    assert.strictEqual(getExtension('ios', undefined), 'swift');
  });

  await t.test('niche "node_react" sempre usa .ts', () => {
    assert.strictEqual(getExtension('node_react', 'const x = 1;'), 'ts');
  });

  await t.test('niche desconhecida cai no default .ts', () => {
    assert.strictEqual(getExtension(undefined, undefined), 'ts');
  });

  await t.test('niche "ai_engineering" com código Python detecta .py', () => {
    assert.strictEqual(getExtension('ai_engineering', 'def fetch():\n    pass'), 'py');
    assert.strictEqual(getExtension('ai_engineering', 'import numpy as np'), 'py');
    assert.strictEqual(getExtension('ai_engineering', 'print("hello")'), 'py');
  });

  await t.test('niche "ai_engineering" sem código cai no default .ts', () => {
    assert.strictEqual(getExtension('ai_engineering', undefined), 'ts');
  });

  await t.test('niche "ai_engineering" com console.log nunca é tratado como Python (mesmo tendo "import ")', () => {
    const jsLikeCode = 'import { foo } from "bar";\nconsole.log(foo);';
    assert.strictEqual(getExtension('ai_engineering', jsLikeCode), 'ts');
  });
});
