import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceError, describeError } from '../lib/errors.js';

test('source diagnostics preserve upstream HTTP status without exposing stacks', () => {
    const err = new SourceError('Otakudesu menolak akses (HTTP 403).', {
        kind: 'blocked',
        source: 'otakudesu',
        httpStatus: 403,
    });
    const result = describeError(err);
    assert.equal(result.source, 'otakudesu');
    assert.equal(result.kind, 'blocked');
    assert.equal(result.httpStatus, 403);
    assert.equal(result.message, 'Otakudesu menolak akses (HTTP 403).');
    assert.equal('stack' in result, false);
});

test('robots diagnostics preserve status and stage separately from source HTTP errors', () => {
    const err = new SourceError('robots.txt sakunime.com tidak tersedia.', {
        kind: 'policy',
        source: 'sakunime',
        httpStatus: 404,
    });
    err.stage = 'robots';
    const result = describeError(err);
    assert.equal(result.stage, 'robots');
    assert.equal(result.httpStatus, 404);
});
