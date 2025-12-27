// 数据服务层 - 任务数据管理 (API 版本)

// 动态获取 API 地址（支持局域网访问）
const API_BASE = `http://${window.location.hostname}:3001/api`;

// 当前任务数据 (内存缓存)
let tasksData = [];

// 机器人颜色配置 - 赛博朋克风格
const BOT_COLORS = {
  机器人A: { main: "#8b5cf6", glow: "rgba(139, 92, 246, 0.4)" },
  机器人B: { main: "#06b6d4", glow: "rgba(6, 182, 212, 0.4)" },
  机器人C: { main: "#f59e0b", glow: "rgba(245, 158, 11, 0.4)" },
  运维机器人: { main: "#10b981", glow: "rgba(16, 185, 129, 0.4)" },
  数据中心服务: { main: "#ec4899", glow: "rgba(236, 72, 153, 0.4)" },
};

// 默认颜色池 - 用于动态分配
const DEFAULT_COLORS = [
  { main: "#a855f7", glow: "rgba(168, 85, 247, 0.4)" },
  { main: "#3b82f6", glow: "rgba(59, 130, 246, 0.4)" },
  { main: "#14b8a6", glow: "rgba(20, 184, 166, 0.4)" },
  { main: "#f97316", glow: "rgba(249, 115, 22, 0.4)" },
  { main: "#ef4444", glow: "rgba(239, 68, 68, 0.4)" },
];

// 获取机器人颜色
export function getBotColor(botName) {
  if (BOT_COLORS[botName]) {
    return BOT_COLORS[botName];
  }
  const allBots = getAllBots();
  const index = allBots.indexOf(botName);
  return DEFAULT_COLORS[Math.abs(index) % DEFAULT_COLORS.length];
}

// 解析时间字符串为分钟数
function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(":").map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

// 格式化持续时间
function formatDuration(startTime, finishTime) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(finishTime);
  const duration = endMinutes - startMinutes;
  if (duration >= 60) {
    const hours = Math.floor(duration / 60);
    const mins = duration % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${duration}m`;
}

// ============== API 调用 ==============

/**
 * 从后端加载任务数据
 */
export async function loadTasksFromServer() {
  try {
    const response = await fetch(`${API_BASE}/tasks`);
    if (!response.ok) {
      throw new Error("加载失败");
    }
    tasksData = await response.json();
    return tasksData;
  } catch (error) {
    console.error("从服务器加载数据失败:", error);
    // 回退到默认数据
    const defaultData = await import("../data/tasks.json");
    tasksData = defaultData.default || [];
    return tasksData;
  }
}

/**
 * 保存任务数据到源文件
 */
export async function saveTasksToServer() {
  try {
    const response = await fetch(`${API_BASE}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tasksData),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "保存失败");
    }

    return await response.json();
  } catch (error) {
    console.error("保存到服务器失败:", error);
    throw error;
  }
}

/**
 * 导入数据文件到服务器
 */
export async function importToServer(content, format) {
  try {
    const response = await fetch(`${API_BASE}/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content, format }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "导入失败");
    }

    const result = await response.json();
    // 重新加载数据
    await loadTasksFromServer();
    return result;
  } catch (error) {
    console.error("导入失败:", error);
    throw error;
  }
}

/**
 * 导出数据文件
 */
export function exportFromServer(format) {
  const url = `${API_BASE}/export/${format}`;
  const link = document.createElement("a");
  link.href = url;
  link.download = `tasks_${new Date().toISOString().slice(0, 10)}.${format}`;
  link.click();
}

// ============== 本地数据操作 ==============

// 获取所有任务数据
export function getAllTasks() {
  return tasksData.map((task) => ({
    ...task,
    duration: formatDuration(task.start, task.finish),
    color: getBotColor(task.bot),
  }));
}

// 获取所有机器人名称
export function getAllBots() {
  const bots = [...new Set(tasksData.map((t) => t.bot))];
  return bots.sort();
}

// 筛选任务
export function filterTasks(
  tasks,
  { searchTerm = "", selectedBots = [], sortBy = "bot" }
) {
  let filtered = [...tasks];

  if (searchTerm.trim()) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter((t) => t.task.toLowerCase().includes(term));
  }

  if (selectedBots.length > 0) {
    filtered = filtered.filter((t) => selectedBots.includes(t.bot));
  }

  if (sortBy === "time") {
    filtered.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  } else {
    filtered.sort((a, b) => {
      const botCompare = a.bot.localeCompare(b.bot);
      if (botCompare !== 0) return botCompare;
      return timeToMinutes(a.start) - timeToMinutes(b.start);
    });
  }

  return filtered;
}

// 添加任务 (仅内存，需要调用 saveTasksToServer 保存)
export function addTask(task) {
  const newId =
    tasksData.length > 0 ? Math.max(...tasksData.map((t) => t.id)) + 1 : 1;
  const newTask = { id: newId, ...task };
  tasksData.push(newTask);
  return newTask;
}

// 更新任务 (仅内存)
export function updateTask(id, updates) {
  const index = tasksData.findIndex((t) => t.id === id);
  if (index !== -1) {
    tasksData[index] = { ...tasksData[index], ...updates };
    return tasksData[index];
  }
  return null;
}

// 删除任务 (仅内存)
export function deleteTask(id) {
  const index = tasksData.findIndex((t) => t.id === id);
  if (index !== -1) {
    tasksData.splice(index, 1);
    return true;
  }
  return false;
}

// 获取时间范围
export function getTimeRange(tasks) {
  if (tasks.length === 0) {
    return { start: "08:00", end: "18:00" };
  }

  let minMinutes = Infinity;
  let maxMinutes = -Infinity;

  tasks.forEach((task) => {
    const startMins = timeToMinutes(task.start);
    const endMins = timeToMinutes(task.finish);
    minMinutes = Math.min(minMinutes, startMins);
    maxMinutes = Math.max(maxMinutes, endMins);
  });

  minMinutes = Math.max(0, minMinutes - 15);
  maxMinutes = Math.min(24 * 60, maxMinutes + 15);

  const formatTime = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  };

  return { start: formatTime(minMinutes), end: formatTime(maxMinutes) };
}

// 检查是否有未保存的更改
let hasUnsavedChanges = false;

export function markAsChanged() {
  hasUnsavedChanges = true;
}

export function markAsSaved() {
  hasUnsavedChanges = false;
}

export function getHasUnsavedChanges() {
  return hasUnsavedChanges;
}
