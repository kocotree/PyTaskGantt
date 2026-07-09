/**
 * 后端 API 服务器
 * 端口、CORS 来源由 .env 控制（参考 .env.example）
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const storage = require('./storage/index.cjs');
const { parseCSV, tasksToCSV } = require('./lib/csv.cjs');

const app = express();
const PORT = Number(process.env.PORT) || 3002;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// 中间件 - CORS 配置（允许局域网跨域访问）
app.use(cors({
  origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// ============== 生产环境静态文件 ==============
// Docker 部署时 Vite build 产物在 dist/ 目录，由 Express 统一提供服务
const distPath = path.join(__dirname, 'dist');
const isProduction = fs.existsSync(distPath);
if (isProduction) {
  app.use(express.static(distPath));
  console.log('📦 生产模式：托管前端静态文件 (dist/)');
}

// ============== API 路由 ==============

/**
 * GET /api/health - 健康检查（供 Docker HEALTHCHECK / 负载均衡探测）
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', storage: storage.driver });
});

/**
 * GET /api/tasks - 获取任务数据
 */
app.get('/api/tasks', async (req, res) => {
  try {
    res.json(await storage.readTasks());
  } catch (error) {
    console.error('读取任务数据失败:', error);
    res.status(500).json({ error: '读取数据失败', message: error.message });
  }
});

/**
 * POST /api/tasks - 保存任务数据到源文件
 */
app.post('/api/tasks', async (req, res) => {
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

    const stat = await storage.saveTasks(cleanTasks);

    // pg 增量保存会回报逐行差异；file 整文件重写只有总数
    const message = stat && Number.isInteger(stat.updated)
      ? `已保存：新增 ${stat.inserted}、修改 ${stat.updated}、删除 ${stat.deleted}`
      : `成功保存 ${cleanTasks.length} 条任务`;

    res.json({
      success: true,
      message,
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
app.post('/api/import', async (req, res) => {
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

    await storage.replaceTasks(tasks);

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
app.get('/api/export/:format', async (req, res) => {
  try {
    const { format } = req.params;

    const tasks = await storage.readTasks();

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

// ============== SPA 回退（仅生产模式）==============
// 所有非 API 的 GET 请求返回 index.html，让 Vue Router 处理客户端路由
if (isProduction) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}

// 启动服务器 (0.0.0.0 允许局域网访问)
(async () => {
  try {
    await storage.initStorage();
  } catch (error) {
    // AggregateError（如 localhost 同时解析 ::1/127.0.0.1）的 message 可能为空，
    // 真正原因在 error.errors 里，逐条取出避免打印空信息
    const detail = error.message
      || (error.errors && error.errors.map(e => e.message).join('; '))
      || String(error);
    console.error(`\n❌ 存储后端初始化失败 (STORAGE_DRIVER=${storage.driver}):`);
    console.error(`   ${detail}\n`);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✨ 后端 API 服务器已启动`);
    console.log(`📍 地址: http://localhost:${PORT}`);
    console.log(`📍 局域网: http://0.0.0.0:${PORT}`);
    console.log(`💾 存储后端: ${storage.describe()}`);
    console.log(`\n可用接口:`);
    console.log(`  GET  /api/health       - 健康检查`);
    console.log(`  GET  /api/tasks        - 获取任务数据`);
    console.log(`  POST /api/tasks        - 保存任务数据`);
    console.log(`  POST /api/import       - 导入数据文件`);
    console.log(`  GET  /api/export/:fmt  - 导出数据 (csv/json)\n`);
  });
})();
