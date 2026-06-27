/**
 * 文件存储后端（默认）
 * 读写 .env 的 TASKS_FILE 指定的 CSV / JSON 文件，扩展名决定格式。
 * 行为与改造前 server.cjs 的 readTasksFile / writeTasksFile 逐字节等价。
 */

const path = require('path');
const fs = require('fs');
const { parseCSV, tasksToCSV } = require('../lib/csv.cjs');

// 数据文件路径（来自 .env 的 TASKS_FILE，相对路径以 vue/ 目录为基准）
// 扩展名决定读写格式：.csv → CSV，其它一律按 JSON 处理
const TASKS_FILE_ENV = process.env.TASKS_FILE || 'src/data/tasks.json';
const TASKS_FILE_PATH = path.isAbsolute(TASKS_FILE_ENV)
  ? TASKS_FILE_ENV
  : path.resolve(__dirname, '..', TASKS_FILE_ENV);
const DATA_DIR = path.dirname(TASKS_FILE_PATH);
const TASKS_FORMAT = TASKS_FILE_PATH.toLowerCase().endsWith('.csv') ? 'csv' : 'json';

async function initStorage() {
  // 确保数据目录存在
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

async function readTasks() {
  if (!fs.existsSync(TASKS_FILE_PATH)) return [];
  const content = fs.readFileSync(TASKS_FILE_PATH, 'utf-8');
  return TASKS_FORMAT === 'csv' ? parseCSV(content) : JSON.parse(content);
}

// 文件存储天然整文件重写，没有「增量」概念：保存与替换都重写整个文件。
function writeAll(tasks) {
  const content = TASKS_FORMAT === 'csv'
    ? tasksToCSV(tasks)
    : JSON.stringify(tasks, null, 2);
  fs.writeFileSync(TASKS_FILE_PATH, content, 'utf-8');
  return tasks.length;
}

async function saveTasks(tasks) {
  // 文件存储整文件重写，没有逐行差异信息，只回报总数
  return { total: writeAll(tasks) };
}

async function replaceTasks(tasks) {
  return writeAll(tasks);
}

function describe() {
  return `file: ${TASKS_FILE_PATH} (${TASKS_FORMAT.toUpperCase()})`;
}

module.exports = { initStorage, readTasks, saveTasks, replaceTasks, describe };
