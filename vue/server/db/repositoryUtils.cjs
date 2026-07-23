function resolveExecutor(options, fallback) {
  if (options && typeof options.query === 'function') return options;
  if (options && options.executor && typeof options.executor.query === 'function') {
    return options.executor;
  }
  return fallback;
}

async function withTransaction(queryable, work) {
  if (!queryable || typeof queryable.query !== 'function') {
    throw new TypeError('A PostgreSQL Pool or Client is required');
  }
  if (typeof queryable.connect !== 'function') return work(queryable);

  const client = await queryable.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Preserve the original failure; a broken connection will be discarded by pg.
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { resolveExecutor, withTransaction };
