const test = require('node:test');
const assert = require('node:assert/strict');

const { describeError, sanitizeErrorText } = require('../storage/migrate.cjs');

test('migration errors expand an empty AggregateError into useful connection failures', () => {
  const ipv6 = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), {
    code: 'ECONNREFUSED',
  });
  const ipv4 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
  });
  const error = new AggregateError([ipv6, ipv4]);
  error.code = 'ECONNREFUSED';

  assert.equal(
    describeError(error),
    '[ECONNREFUSED] connect ECONNREFUSED ::1:5432; ' +
      '[ECONNREFUSED] connect ECONNREFUSED 127.0.0.1:5432'
  );
});

test('migration error formatting handles ordinary and non-Error values', () => {
  assert.equal(describeError(Object.assign(new Error('permission denied'), { code: '42501' })),
    '[42501] permission denied');
  assert.equal(describeError('connection unavailable'), 'connection unavailable');
  assert.equal(describeError(null), 'Unknown error');
});

test('migration error formatting redacts PostgreSQL URL credentials and password fields', () => {
  const text = sanitizeErrorText(
    'failed postgresql://user:secret@db.example/tasks password=plain-secret pwd=other-secret'
  );

  assert.equal(
    text,
    'failed postgresql://<credentials>@db.example/tasks password=<redacted> pwd=<redacted>'
  );
  assert.doesNotMatch(text, /user:secret|plain-secret|other-secret/);
});
