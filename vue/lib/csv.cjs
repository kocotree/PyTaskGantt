/**
 * CSV 格式工具：任务数组 <-> CSV 字符串
 * 与存储后端无关，供 fileStore 与 import/export 路由复用。
 */

/**
 * 解析 CSV 内容为任务数组
 */
function parseCSV(csvContent) {
  const lines = csvContent.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error('CSV 文件内容不足');
  }

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const requiredColumns = ['task', 'start', 'finish', 'bot'];
  const columnMap = {};

  requiredColumns.forEach(col => {
    const index = headers.findIndex(h => h === col);
    if (index === -1) {
      throw new Error(`CSV 缺少必要的列: ${col}`);
    }
    columnMap[col] = index;
  });

  const tasks = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',').map(v => v.trim());

    // 标准化时间
    const normalizeTime = (timeStr) => {
      if (!timeStr) return '00:00:00';
      const parts = timeStr.trim().split(' ');
      const timePart = parts[parts.length - 1];
      const timeSegments = timePart.split(':');
      while (timeSegments.length < 3) {
        timeSegments.push('00');
      }
      return timeSegments.slice(0, 3).join(':');
    };

    const task = {
      id: i,
      task: values[columnMap['task']] || '',
      start: normalizeTime(values[columnMap['start']]),
      finish: normalizeTime(values[columnMap['finish']]),
      bot: values[columnMap['bot']] || '未分类'
    };

    if (task.task) {
      tasks.push(task);
    }
  }

  return tasks;
}

/**
 * 将任务数组转换为 CSV 字符串
 */
function tasksToCSV(tasks) {
  const headers = ['Task', 'Start', 'Finish', 'Bot'];
  const rows = tasks.map(t => [t.task, t.start, t.finish, t.bot].join(','));
  return [headers.join(','), ...rows].join('\n');
}

module.exports = { parseCSV, tasksToCSV };
