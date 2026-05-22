/**
 * 后端 API 服务器
 * 端口、CORS 来源由 .env 控制（参考 .env.example）
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT) || 3002;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// 数据文件路径（来自 .env 的 TASKS_FILE，相对路径以本目录为基准）
// 扩展名决定读写格式：.csv → CSV，其它一律按 JSON 处理
const TASKS_FILE_ENV = process.env.TASKS_FILE || 'src/data/tasks.json';
const TASKS_FILE_PATH = path.isAbsolute(TASKS_FILE_ENV)
  ? TASKS_FILE_ENV
  : path.resolve(__dirname, TASKS_FILE_ENV);
const DATA_DIR = path.dirname(TASKS_FILE_PATH);
const TASKS_FORMAT = TASKS_FILE_PATH.toLowerCase().endsWith('.csv') ? 'csv' : 'json';

// 中间件 - CORS 配置（允许局域网跨域访问）
app.use(cors({
  origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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

// 按 TASKS_FORMAT 读 / 写源文件，统一封装供各路由调用
function readTasksFile() {
  if (!fs.existsSync(TASKS_FILE_PATH)) return [];
  const content = fs.readFileSync(TASKS_FILE_PATH, 'utf-8');
  return TASKS_FORMAT === 'csv' ? parseCSV(content) : JSON.parse(content);
}

function writeTasksFile(tasks) {
  const content = TASKS_FORMAT === 'csv'
    ? tasksToCSV(tasks)
    : JSON.stringify(tasks, null, 2);
  fs.writeFileSync(TASKS_FILE_PATH, content, 'utf-8');
}

// ============== API 路由 ==============

/**
 * GET /api/tasks - 获取任务数据
 */
app.get('/api/tasks', (req, res) => {
  try {
    res.json(readTasksFile());
  } catch (error) {
    console.error('读取任务数据失败:', error);
    res.status(500).json({ error: '读取数据失败', message: error.message });
  }
});

/**
 * POST /api/tasks - 保存任务数据到源文件
 */
app.post('/api/tasks', (req, res) => {
  try {
    const tasks = req.body;

    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: '无效的数据格式' });
    }

    const cleanTasks = tasks.map((t, index) => ({
      id: t.id || index + 1,
      task: t.task,
      start: t.start,
      finish: t.finish,
      bot: t.bot
    }));

    writeTasksFile(cleanTasks);

    res.json({
      success: true,
      message: `成功保存 ${cleanTasks.length} 条任务`,
      count: cleanTasks.length
    });
  } catch (error) {
    console.error('保存任务数据失败:', error);
    res.status(500).json({ error: '保存失败', message: error.message });
  }
});

/**
 * POST /api/import - 导入 CSV 或 JSON 文件
 */
app.post('/api/import', (req, res) => {
  try {
    const { content, format } = req.body;

    if (!content) {
      return res.status(400).json({ error: '没有提供文件内容' });
    }

    let tasks;

    if (format === 'json') {
      tasks = JSON.parse(content);
      if (!Array.isArray(tasks)) {
        throw new Error('JSON 格式无效，需要数组');
      }
      tasks = tasks.map((t, i) => ({
        id: t.id || i + 1,
        task: t.task || t.Task || '',
        start: t.start || t.Start || '00:00:00',
        finish: t.finish || t.Finish || '00:00:00',
        bot: t.bot || t.Bot || '未分类'
      }));
    } else {
      tasks = parseCSV(content);
    }

    writeTasksFile(tasks);

    res.json({
      success: true,
      message: `成功导入 ${tasks.length} 条任务`,
      count: tasks.length
    });
  } catch (error) {
    console.error('导入失败:', error);
    res.status(400).json({ error: '导入失败', message: error.message });
  }
});

/**
 * GET /api/export/:format - 导出数据文件
 */
app.get('/api/export/:format', (req, res) => {
  try {
    const { format } = req.params;

    if (!fs.existsSync(TASKS_FILE_PATH)) {
      return res.status(404).json({ error: '没有数据可导出' });
    }

    const tasks = readTasksFile();

    if (format === 'csv') {
      const csvContent = tasksToCSV(tasks);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=tasks_${new Date().toISOString().slice(0, 10)}.csv`);
      res.send(csvContent);
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=tasks_${new Date().toISOString().slice(0, 10)}.json`);
      res.send(JSON.stringify(tasks, null, 2));
    }
  } catch (error) {
    console.error('导出失败:', error);
    res.status(500).json({ error: '导出失败', message: error.message });
  }
});

// 启动服务器 (0.0.0.0 允许局域网访问)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✨ 后端 API 服务器已启动`);
  console.log(`📍 地址: http://localhost:${PORT}`);
  console.log(`📍 局域网: http://0.0.0.0:${PORT}`);
  console.log(`📁 数据文件: ${TASKS_FILE_PATH} (${TASKS_FORMAT.toUpperCase()})`);
  console.log(`\n可用接口:`);
  console.log(`  GET  /api/tasks        - 获取任务数据`);
  console.log(`  POST /api/tasks        - 保存任务数据`);
  console.log(`  POST /api/import       - 导入数据文件`);
  console.log(`  GET  /api/export/:fmt  - 导出数据 (csv/json)\n`);
});
