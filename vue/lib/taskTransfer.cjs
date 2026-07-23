const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { ValidationError } = require('../server/errors.cjs');

function normalizeTags(value, csv = false) {
  const values = Array.isArray(value) ? value : String(value || '').split(csv ? ';' : ',');
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
}

function normalizeImportedTask(raw, index, csv = false) {
  const task = {
    task: String(raw.task ?? raw.Task ?? '').trim(),
    start: String(raw.start ?? raw.Start ?? '').trim(),
    finish: String(raw.finish ?? raw.Finish ?? '').trim(),
    bot: String(raw.bot ?? raw.Bot ?? '').trim(),
    schedule_uuid: String(raw.schedule_uuid ?? raw.ScheduleUuid ?? '').trim(),
    tags: normalizeTags(raw.tags ?? raw.Tags, csv),
    note: String(raw.note ?? raw.Note ?? '').trim(),
  };
  const missing = ['task', 'start', 'finish', 'bot', 'schedule_uuid'].filter(key => !task[key]);
  if (missing.length) {
    throw new ValidationError(`导入第 ${index + 1} 条记录缺少字段：${missing.join(', ')}`);
  }
  return task;
}

function parseTaskImport(content, format) {
  if (typeof content !== 'string' || !content.trim()) throw new ValidationError('没有提供文件内容');
  if (format === 'json') {
    let rows;
    try {
      rows = JSON.parse(content);
    } catch (_error) {
      throw new ValidationError('JSON 内容无法解析');
    }
    if (!Array.isArray(rows)) throw new ValidationError('JSON 顶层必须是任务数组');
    return rows.map((row, index) => normalizeImportedTask(row, index, false));
  }
  let rows;
  try {
    rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (error) {
    throw new ValidationError(`CSV 内容无法解析：${error.message}`);
  }
  return rows.map((row, index) => normalizeImportedTask(row, index, true));
}

function exportTasks(tasks, format) {
  const rows = tasks.map(item => ({
    Task: item.task,
    Start: item.start,
    Finish: item.finish,
    Bot: item.bot,
    Owner: item.owner && item.owner.display_name || '',
    ScheduleUuid: item.schedule_uuid || '',
    Tags: (item.tags || []).join(';'),
    Note: item.note || '',
  }));
  if (format === 'json') {
    return { contentType: 'application/json; charset=utf-8', body: JSON.stringify(rows, null, 2) };
  }
  return { contentType: 'text/csv; charset=utf-8', body: stringify(rows, { header: true, bom: true }) };
}

module.exports = { normalizeTags, parseTaskImport, exportTasks };
