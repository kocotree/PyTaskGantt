# AGENT.md

This file provides guidance to coding agents when working with code in this repository.

## 仓库结构概览

本仓库是一个 RPA / 多机器人任务编排的甘特图编辑器，并行维护两套实现：

- **`vue/`** — 首选版本。Vue 3 + Naive UI 前端 + Express 后端，支持拖拽改时间、CSV/JSON 双格式持久化。日常开发集中在这里。
- **`streamlit/`** — 纯 Python 单文件实现（Streamlit + Plotly + Pandas），主要用作对照基准。

两个版本共用 `Task,Start,Finish,Bot` 数据语义。`HH:MM:SS` 格式；当 `Finish < Start` 视为跨天，时长按次日计算。

## 常用命令

### Vue 版本（在 `vue/` 目录下）

```bash
cp .env.example .env   # 首次：拷一份默认配置
npm install
npm start              # 同时拉起后端 server.cjs + Vite 前端
npm run server         # 仅启动后端 (Express, 默认 :3002)
npm run dev            # 仅启动前端 (Vite, 默认 :5174)
npm run build          # 产物在 dist/
```

### Streamlit 版本（在 `streamlit/` 目录下）

```bash
copy .env.example .env    # 首次：拷一份默认数据源配置
start.bat    # Windows：uv 一键启动，http://localhost:8501
```

`start.bat` 会在 `streamlit/.venv` 创建本地 Python 环境，并把 uv 下载缓存放到 `streamlit/.uv-cache`。

仓库没有测试、lint、format 配置——不要假定 `npm test` 或 `npm run lint` 存在。

### Streamlit 数据源配置

`streamlit/.env`（不入库，从 `.env.example` 复制）控制 Streamlit 版的数据文件路径：

- `TASKS_FILE` — CSV 数据文件路径。相对路径以 `streamlit/` 目录为基准；也支持绝对路径，例如 `../ShadowBot_tasks.csv` 或 `D:/data/tasks.csv`。

配置优先级为系统环境变量 `TASKS_FILE` > `streamlit/.env` > 默认 `streamlit/ShadowBot_tasks.csv`。Streamlit 版继续只读写 CSV。

## Vue 架构要点

### .env 是单一事实源

`vue/.env`（不入库，从 `.env.example` 复制）控制所有运行时配置：

- `PORT` — Express 后端端口；前端会同步用这个端口拼 API 地址
- `VITE_DEV_PORT` / `VITE_DEV_HOST` — Vite dev server
- `CORS_ORIGIN` — 后端 CORS 白名单，`*` 或逗号分隔域名
- `TASKS_FILE` — 任务数据文件路径，**扩展名决定读写格式**：`.csv` 走 CSV 解析，其它一律当 JSON。可填相对路径（基准为 `vue/`）或绝对路径，例如 `Z:\…\ShadowBot_tasks.csv`。后端启动日志会打印实际格式标记。

`vite.config.js` 用 `loadEnv` 读取 `.env` 后通过 `define` 注入端口；前端 `dataService.js` 用 `window.location.hostname + ':' + API_PORT` 拼 API 地址，所以局域网访问也能直接连后端。

### 后端（`vue/server.cjs`）

单文件 Express 5，4 个端点：`GET /api/tasks`、`POST /api/tasks`（整表覆盖保存）、`POST /api/import`（CSV/JSON 内容字符串）、`GET /api/export/:format`。读写都通过 `readTasksFile()` / `writeTasksFile()` 两个 helper 统一处理格式分发，不要直接 `fs.readFileSync` 绕过它们。

### 前端关键文件

- `src/services/dataService.js` — 唯一的数据层。任务以模块级变量 `tasksData` 缓存；`getHasUnsavedChanges()` 是未保存状态的真相源（UI 各处只读这一个）。颜色按机器人名稳定分配自 `theme.js` 的 `BOT_PALETTE`。
- `src/components/GanttChart.vue` — 基于 vis-timeline。**每个任务独占一个 group**（一行）；任务条不显示文字，悬浮 tooltip 显示时间 + 时长。拖拽实现里有几个非平凡约束：
  - 用 `pointermove` + `capture: true` 监听光标，**不能换成 mousemove**——vis-timeline 内部 hammer.js 会 `setPointerCapture` 吞掉 mousemove。
  - 拖到容器边缘时 `tickAutoScroll()` 自动平移视窗；必须先 `advanceDragBaseline()` 推进 vis 内部的拖拽基线，再从 `timeline.itemSet.items[id].data` 读实时位置 update dataset，最后 `setWindow`。顺序错了任务条会反向瞬移。
  - 拖完会 emit `task-update` 让父组件回写数据，`suppressNextUpdate` 标志位用来吃掉随后的 watch 触发，避免重排闪烁。
- `src/components/FilterPanel.vue` / `TaskList.vue` / `TaskEditor.vue` — UI 层，所有数据操作走 `dataService.js` 的导出函数。

### 时间处理

所有时间字符串走 `dataService.js` 的 `normalizeTime`（补足 `HH:MM:SS`）。vis-timeline 需要 `Date` 对象时用 `parseTimeToDate(start, finish)`，它会拼上 `DUMMY_DATE = '2025-01-01'`；跨天任务自动把 end 推到次日。改动这部分逻辑务必同时验证跨天场景。

## 提交注意事项

- 不要把 `.env`、`dist/`、`node_modules/` 入库（已在 `.gitignore`）。
- `src/data/tasks.json` 是默认示例数据，会被前端在后端不可达时作为兜底加载；不要随手 commit 本地测试时被覆盖的版本。
- 未经用户明确要求，不要执行 `git commit` 或分支操作。
