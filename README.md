# PyTaskGantt · 交互式任务甘特图编辑器

面向 RPA / 多机器人任务编排场景的可视化甘特图仪表盘，支持拖拽编辑、筛选排序、CSV/JSON 导入导出、PostgreSQL 持久化。

## 🚀 快速开始

```bash
cd vue
cp .env.example .env   # 首次运行：复制默认配置（端口/CORS/存储驱动）
npm install
npm start              # concurrently 同时拉起 Express 后端 + Vite 前端
```

也可以分别启动：

```bash
npm run server  # 终端1：Express 后端 API
npm run dev     # 终端2：Vite 前端
```

**默认端口**：后端 `3002`、前端 `5174`，由 `vue/.env` 控制。首次运行执行 `cp .env.example .env` 即可，不需额外配置。

| 环境变量 | 说明 | 默认值 |
|:---|:---|:---|
| `PORT` | Express 端口 | `3002` |
| `CORS_ORIGIN` | 跨域白名单 | `*` |
| `STORAGE_DRIVER` | 存储后端：`file` / `postgres` | `file` |
| `TASKS_FILE` | 文件存储路径（相对路径以 `vue/` 为基准） | `src/data/tasks.json` |
| `VITE_DEV_PORT` | Vite 端口 | `5174` |

**PostgreSQL 支持**：设 `STORAGE_DRIVER=postgres` 即可切换至数据库存储，详见 [vue/POSTGRESQL.md](vue/POSTGRESQL.md)。

---

## 📸 效果预览

### 主界面：甘特图 + 任务列表 + 操作面板

上栏甘特图区：每个任务独占一行的 vis-timeline 时间条，配色按机器人稳定分配，支持鼠标拖拽改时间（拖到视窗边缘自动平移）；下栏任务列表：表格展示任务名、起止时间、机器人（彩色标签）、时长、跨天标记（"次日"），支持分页；右侧固定面板：数据刷新 / 导入导出 / 保存、搜索筛选、多选机器人过滤、排序切换。

![Vue 主界面](images/vue-main.png)

### 任务编辑器

Modal 表单编辑：任务名（最长 100 字）、机器人（下拉选择或输入新标签，自动补全颜色）、起止时间（HH:MM:SS 时间选择器，支持"此刻"快捷按钮）。跨天任务（`finish < start`）自动识别并以橙色提示条展示时长。编辑完成后点「保存编辑器修改」将修改持久化至磁盘或 PostgreSQL。

![任务编辑器](images/vue-edit.png)

### 筛选与搜索

支持任务名模糊搜索、多选机器人筛选、三种排序方式（按机器人名 / 开始时间 / 结束时间）。筛选后甘特图与任务列表同步更新，无匹配时显示空状态提示。

![筛选功能](images/vue-filter.png)

### 拖拽编辑时间

在甘特图上按住任务条左右拖拽即可调整起止时间。拖拽过程中显示浮动 tooltip（任务名、机器人色块、起止时间、时长），拖到视窗边缘自动平移画布，松手后立即反映到任务列表，未保存红点提示。

![拖拽编辑](images/vue-drag.png)

---

## 📊 数据格式

支持 CSV 导入导出，默认以 JSON 持久化到 `vue/src/data/tasks.json`：

```csv
Task,Start,Finish,Bot
数据同步#1,09:00:00,09:25:00,机器人A
日志分析#1,10:00:00,10:30:00,机器人B
```

| 字段 | 格式 | 说明 |
|:---|:---|:---|
| Task | 文本 | 任务名称 |
| Start | HH:MM:SS | 开始时间 |
| Finish | HH:MM:SS | 结束时间 |
| Bot | 文本 | 机器人 / 执行者名称 |

**跨天任务**：若 `Finish < Start`（字符串比较），识别为跨越午夜，时长自动按次日计算。

---

## ✨ 功能一览

| 功能 | 说明 |
|:---|:---|
| 甘特图可视化 | vis-timeline 渲染，每个任务独占一行，配色按机器人稳定分配 |
| 鼠标拖拽改时间 | 甘特图时间条左右拖拽调整起止时间 |
| 拖到边缘自动滚动 | 拖拽接近视窗边缘时画布自动平移，任务条跟随 |
| 任务编辑器 | Modal 表单：任务名、机器人（含新标签输入）、起止时间选择器 |
| 任务列表 | 表格展示：名称、起止时间、机器人标签、时长、跨天标记，分页 |
| 搜索筛选 | 任务名模糊搜索 + 多选机器人过滤 |
| 排序 | 按机器人名 / 开始时间 / 结束时间 |
| CSV/JSON 导入导出 | 前端选择文件导入，一键导出为 CSV 或 JSON |
| 数据持久化 | 支持 JSON 文件存储和 PostgreSQL 两种后端 |
| 未保存提示 | Header 红点 + 保存按钮状态变化 |

---

## 📁 项目结构

```
PyTaskGantt/
├── README.md
├── ShadowBot_tasks.csv          # 示例 CSV 数据
├── images/                      # README 截图
├── vue/
│   ├── package.json
│   ├── .env.example
│   ├── server.cjs               # Express 后端
│   ├── start.bat                # Windows 一键启动
│   ├── vite.config.js
│   ├── POSTGRESQL.md            # PostgreSQL 存储说明
│   ├── lib/csv.cjs              # CSV 解析工具
│   ├── storage/                 # 存储后端（file / postgres）
│   └── src/
│       ├── App.vue              # 根组件（Shell + 编排）
│       ├── main.js
│       ├── theme.js             # Naive UI AntD 风主题
│       ├── style.css
│       ├── components/
│       │   ├── GanttChart.vue   # 甘特图（vis-timeline）
│       │   ├── TaskList.vue     # 任务表格
│       │   ├── TaskEditor.vue   # 编辑 Modal
│       │   └── FilterPanel.vue  # 筛选与操作面板
│       ├── services/
│       │   └── dataService.js   # 数据层（API + 工具函数）
│       └── data/
│           └── tasks.json       # 默认数据文件
```

---

## 📝 License

MIT
