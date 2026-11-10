import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGenerationHistoryEndpoint as resolve } from './generationHistoryConfig.js';
test('explicit isolated public endpoints', () => {
 assert.equal(resolve({target:'staging',stagingEndpoint:'https://example.test/staging/service/generation-history'}),'https://example.test/staging/service/generation-history');
 for (const config of [{}, {target:'staging',productionEndpoint:'https://example.test/service/generation-history'}, {target:'staging',stagingEndpoint:'https://example.test/service/generation-history'}, {target:'production',productionEndpoint:'https://secret@example.test/service/generation-history'}]) assert.throws(() => resolve(config));
});
