const express = require('express');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { ValidationError } = require('../errors.cjs');
const { parseTaskImport, exportTasks } = require('../../lib/taskTransfer.cjs');
const { presentTask } = require('../presenters.cjs');

function createImportsRouter({ tasksRepository, taskMutationService }) {
  const router = express.Router();

  router.post('/import', asyncHandler(async (req, res) => {
    const format = String(req.body && req.body.format || '').toLowerCase();
    if (!['csv', 'json'].includes(format)) throw new ValidationError('导入格式必须是 csv 或 json');
    const rows = parseTaskImport(req.body.content, format);
    const result = await taskMutationService.applyBatch(req.userId, {
      mutations: rows.map((row, index) => ({ type: 'create', temp_id: `import:${index}`, ...row })),
      audit_action: 'import',
    });
    res.json({
      ...result,
      tasks: (result.tasks || []).map(presentTask),
      count: rows.length,
      message: `成功新增 ${rows.length} 条任务`,
    });
  }));

  router.get('/export/:format', asyncHandler(async (req, res) => {
    const format = String(req.params.format || '').toLowerCase();
    if (!['csv', 'json'].includes(format)) throw new ValidationError('导出格式必须是 csv 或 json');
    const tasks = await tasksRepository.listAll(req.userId);
    const output = exportTasks(tasks.map(presentTask), format);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', output.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="tasks_${date}.${format}"`);
    res.send(output.body);
  }));

  return router;
}

module.exports = { createImportsRouter };
