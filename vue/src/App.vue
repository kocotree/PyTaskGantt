<template>
  <div class="app">
    <!-- 粒子背景 -->
    <ParticleBackground />

    <!-- 主内容 -->
    <div class="app-container">
      <!-- 头部 -->
      <header class="app-header glass-panel">
        <div class="header-content">
          <div class="logo">
            <component :is="LayoutDashboardIcon" class="logo-icon" />
            <div class="logo-text">
              <h1>交互式任务甘特图编辑器</h1>
            </div>
          </div>
          <div class="header-stats">
            <div class="stat-badge">
              <component :is="ActivityIcon" class="stat-icon" />
              <span>{{ filteredTasks.length }} 任务运行中</span>
            </div>
          </div>
        </div>
      </header>

      <!-- 主体布局 -->
      <main class="app-main">
        <!-- 左侧主要内容 -->
        <div class="main-content">
          <!-- 甘特图区域 -->
          <section class="chart-section glass-panel">
            <div class="section-header">
              <h2>
                <component :is="BarChart3Icon" class="section-icon" />
                任务执行甘特图
              </h2>
              <span class="time-badge">24小时视图</span>
            </div>
            <div class="chart-container">
              <GanttChart
                :tasks="filteredTasks"
                :onTaskClick="handleTaskClick"
              />
            </div>
          </section>

          <!-- 任务列表编辑区 -->
          <TaskList
            :tasks="filteredTasks"
            @edit="handleTaskClick"
            @delete="handleDeleteTask"
          />
        </div>

        <!-- 筛选面板 -->
        <FilterPanel
          :bots="allBots"
          v-model:searchTerm="searchTerm"
          v-model:selectedBots="selectedBots"
          v-model:sortBy="sortBy"
          :filteredCount="filteredTasks.length"
          :totalCount="allTasks.length"
          @refresh="handleRefresh"
          @add-task="openAddModal"
          @import-file="handleImportFile"
          @export="handleExport"
          @save="handleSave"
        />
      </main>

      <!-- 底部 -->
      <footer class="app-footer">
        <p>Powered by Vue 3 + ECharts | 交互式任务甘特图编辑器 ✨</p>
      </footer>
    </div>

    <!-- 任务编辑器 -->
    <TaskEditor
      :show="showEditor"
      :task="editingTask"
      :bots="allBots"
      @close="closeEditor"
      @save="handleSaveTask"
      @delete="handleDeleteTask"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import {
  LayoutDashboard as LayoutDashboardIcon,
  Activity as ActivityIcon,
  BarChart3 as BarChart3Icon,
} from "lucide-vue-next";
import ParticleBackground from "./components/ParticleBackground.vue";
import GanttChart from "./components/GanttChart.vue";
import FilterPanel from "./components/FilterPanel.vue";
import TaskEditor from "./components/TaskEditor.vue";
import TaskList from "./components/TaskList.vue";
import {
  getAllTasks,
  getAllBots,
  filterTasks,
  addTask,
  updateTask,
  deleteTask,
  loadTasksFromServer,
  saveTasksToServer,
  importToServer,
  exportFromServer,
} from "./services/dataService";

// 数据状态
const allTasks = ref([]);
const allBots = ref([]);

// 筛选状态
const searchTerm = ref("");
const selectedBots = ref([]);
const sortBy = ref("bot");

// 编辑器状态
const showEditor = ref(false);
const editingTask = ref(null);

// 计算筛选后的任务
const filteredTasks = computed(() => {
  return filterTasks(allTasks.value, {
    searchTerm: searchTerm.value,
    selectedBots: selectedBots.value,
    sortBy: sortBy.value,
  });
});

// 初始化/刷新数据
const loadData = () => {
  allTasks.value = getAllTasks();
  allBots.value = getAllBots();
  if (selectedBots.value.length === 0) {
    selectedBots.value = [...allBots.value];
  }
};

// 从服务器刷新数据
const handleRefresh = async () => {
  try {
    await loadTasksFromServer();
    loadData();
  } catch (error) {
    alert("刷新失败: " + error.message);
  }
};

// 点击任务
const handleTaskClick = (task) => {
  editingTask.value = task;
  showEditor.value = true;
};

// 打开新增弹窗
const openAddModal = () => {
  editingTask.value = null;
  showEditor.value = true;
};

// 关闭编辑器
const closeEditor = () => {
  showEditor.value = false;
  editingTask.value = null;
};

// 保存任务 (仅内存)
const handleSaveTask = (taskData) => {
  if (taskData.id) {
    updateTask(taskData.id, taskData);
  } else {
    addTask(taskData);
  }
  loadData();
};

// 删除任务 (仅内存)
const handleDeleteTask = (id) => {
  deleteTask(id);
  loadData();
};

// 导入文件
const handleImportFile = async ({ content, format }) => {
  try {
    const result = await importToServer(content, format);
    loadData();
    // 更新机器人筛选列表
    selectedBots.value = [...getAllBots()];
    alert(result.message);
  } catch (error) {
    alert("导入失败: " + error.message);
  }
};

// 导出文件
const handleExport = () => {
  const format = prompt(
    "选择导出格式:\n1 - CSV\n2 - JSON\n\n(输入 1 或 2)",
    "1"
  );

  if (format === "1") {
    exportFromServer("csv");
  } else if (format === "2") {
    exportFromServer("json");
  }
};

// 保存更改到源文件
const handleSave = async () => {
  try {
    const result = await saveTasksToServer();
    alert(result.message);
  } catch (error) {
    alert("保存失败: " + error.message);
  }
};

onMounted(async () => {
  await loadTasksFromServer();
  loadData();
});
</script>

<style scoped>
.app {
  min-height: 100vh;
  position: relative;
}

.app-container {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 20px;
  max-width: 1800px;
  margin: 0 auto;
}

/* Header */
.app-header {
  padding: 16px 24px;
}

.header-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo-icon {
  width: 40px;
  height: 40px;
  color: var(--accent);
  filter: drop-shadow(0 0 8px var(--accent-glow));
}

.logo-text h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent), #ec4899);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  font-size: 0.75rem;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}

.header-stats {
  display: flex;
  gap: 12px;
}

.stat-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(139, 92, 246, 0.1);
  border: 1px solid rgba(139, 92, 246, 0.2);
  border-radius: 20px;
  font-size: 0.875rem;
  color: var(--accent);
}

.stat-icon {
  width: 16px;
  height: 16px;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* Main Layout */
.app-main {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 20px;
}

.main-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Chart Section */
.chart-section {
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.section-header h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
}

.section-icon {
  width: 24px;
  height: 24px;
  color: var(--accent);
}

.time-badge {
  padding: 6px 12px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 14px;
  font-size: 0.75rem;
  color: #10b981;
}

.chart-container {
  flex: 1;
  min-height: 500px;
}

/* Footer */
.app-footer {
  text-align: center;
  padding: 16px;
  color: var(--text-muted);
  font-size: 0.875rem;
}

/* Responsive */
@media (max-width: 1024px) {
  .app-main {
    grid-template-columns: 1fr;
  }

  .app-main > :last-child {
    order: -1;
  }
}

@media (max-width: 640px) {
  .header-content {
    flex-direction: column;
    gap: 12px;
    text-align: center;
  }

  .logo {
    justify-content: center;
  }
}
</style>
