const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeLegacyTasks } = require('../storage/importLegacyTasks.cjs');

test('legacy JSON rows retain ids and become unowned task payloads without destructive defaults', () => {
  const rows = normalizeLegacyTasks(JSON.stringify([
    { id: 42, Task: '历史任务', Start: '23:00:00', Finish: '01:00:00', Bot: '旧Bot' },
    { id: 43, Task: '' },
  ]), '.json');
  assert.deepEqual(rows, [{
    id: '42', task: '历史任务', start: '23:00:00', finish: '01:00:00', bot: '旧Bot', sourceRow: 1,
  }]);
});

test('legacy four-column CSV is parsed without requiring scheduleUuid', () => {
  const rows = normalizeLegacyTasks(
    'Task,Start,Finish,Bot\n"含,逗号的任务",09:00:00,10:00:00,旧Bot\n',
    '.csv'
  );
  assert.equal(rows[0].id, null);
  assert.equal(rows[0].task, '含,逗号的任务');
  assert.equal(rows[0].bot, '旧Bot');
});
