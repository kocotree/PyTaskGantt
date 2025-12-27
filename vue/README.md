# 交互式任务甘特图编辑器 (Vue 版本) 📊

基于 Vue 3 + Vite + ECharts 构建的现代化任务甘特图应用，带有后端 API 支持文件读写。

## ✨ 特性

- 🌙 深色赛博朋克主题
- 💎 Glassmorphism 玻璃态 UI
- ✨ 动态粒子背景
- 📊 ECharts 甘特图可视化
- 🔍 智能筛选与搜索
- ✏️ 任务编辑器
- 📋 任务列表视图
- 💾 数据持久化到源文件
- 📱 响应式设计

## 🚀 快速开始

### 一键启动
```bash
# 双击 start.bat 即可启动前后端服务并打开浏览器
```

### 手动启动
```bash
# 1. 安装依赖
npm install

# 2. 启动后端 API (http://localhost:3001)
npm run server

# 3. 新终端启动前端 (http://localhost:5173)
npm run dev
```

### 停止服务
```bash
# 双击 stop.bat 或运行
taskkill /f /im node.exe
```

## 📁 项目结构

```
vue/
├── start.bat           # 一键启动脚本
├── stop.bat            # 停止服务脚本
├── server.cjs          # 后端 API 服务器
├── src/
│   ├── App.vue
│   ├── components/
│   │   ├── GanttChart.vue
│   │   ├── FilterPanel.vue
│   │   ├── TaskEditor.vue
│   │   ├── TaskList.vue
│   │   └── ParticleBackground.vue
│   ├── services/
│   │   └── dataService.js
│   └── data/
│       └── tasks.json
└── public/
```

## 🎮 功能按钮

| 按钮 | 功能 |
|------|------|
| 刷新 | 从服务器重新加载数据 |
| 导入 | 导入 CSV/JSON 到源文件 |
| 导出 | 下载 CSV 或 JSON 文件 |
| 保存更改 | 保存修改到源文件 |

## 📊 数据格式

```json
{
  "id": 1,
  "task": "任务名称",
  "start": "09:00:00",
  "finish": "09:30:00",
  "bot": "机器人名"
}
```

## 🛠️ 技术栈

- Vue 3 + Composition API
- Vite
- ECharts
- Express.js
- Lucide Icons
