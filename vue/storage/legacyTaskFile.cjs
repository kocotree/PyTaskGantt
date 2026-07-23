const { parse } = require('csv-parse/sync');

function parseLegacyRows(content, extension) {
  if (extension.toLowerCase() === '.csv') {
    return parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  }
  const rows = JSON.parse(content);
  if (!Array.isArray(rows)) throw new Error('旧任务 JSON 顶层必须是数组');
  return rows;
}

function normalizeLegacyTasks(content, extension, { assignSequentialIds = false } = {}) {
  return parseLegacyRows(content, extension).map((row, index) => {
    const rawId = row.id ?? row.ID ?? row.Id;
    return {
      id: rawId == null || rawId === ''
        ? assignSequentialIds ? String(index + 1) : null
        : String(rawId),
      task: String(row.task ?? row.Task ?? '').trim(),
      start: String(row.start ?? row.Start ?? '00:00:00').trim(),
      finish: String(row.finish ?? row.Finish ?? '00:00:00').trim(),
      bot: String(row.bot ?? row.Bot ?? '未分类').trim(),
      sourceRow: index + 1,
    };
  }).filter(row => row.task);
}

module.exports = { parseLegacyRows, normalizeLegacyTasks };
