<template>
  <div class="task-list glass-panel">
    <div class="list-header">
      <h3>
        <component :is="ListIcon" class="header-icon" />
        任务列表
      </h3>
      <span class="task-count">{{ tasks.length }} 条任务</span>
    </div>

    <div class="list-container">
      <table class="task-table">
        <thead>
          <tr>
            <th class="col-task">任务名称</th>
            <th class="col-time">开始时间</th>
            <th class="col-time">结束时间</th>
            <th class="col-bot">机器人</th>
            <th class="col-duration">时长</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="task in tasks"
            :key="task.id"
            class="task-row"
            :style="{ '--bot-color': task.color?.main || '#8b5cf6' }"
          >
            <td class="col-task">
              <span class="task-name">{{ task.task }}</span>
            </td>
            <td class="col-time">{{ formatTime(task.start) }}</td>
            <td class="col-time">{{ formatTime(task.finish) }}</td>
            <td class="col-bot">
              <span
                class="bot-badge"
                :style="{ background: task.color?.main || '#8b5cf6' }"
              >
                {{ task.bot }}
              </span>
            </td>
            <td class="col-duration">{{ task.duration }}</td>
            <td class="col-actions">
              <button
                class="action-btn edit-btn"
                @click="$emit('edit', task)"
                title="编辑"
              >
                <component :is="PencilIcon" />
              </button>
              <button
                class="action-btn delete-btn"
                @click="handleDelete(task)"
                title="删除"
              >
                <component :is="TrashIcon" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="tasks.length === 0" class="empty-state">
        <component :is="InboxIcon" class="empty-icon" />
        <p>暂无任务数据</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import {
  List as ListIcon,
  Pencil as PencilIcon,
  Trash2 as TrashIcon,
  Inbox as InboxIcon,
} from "lucide-vue-next";

defineProps({
  tasks: {
    type: Array,
    required: true,
  },
});

const emit = defineEmits(["edit", "delete"]);

// 格式化时间显示
const formatTime = (timeStr) => {
  if (!timeStr) return "--:--";
  return timeStr.substring(0, 5);
};

// 删除确认
const handleDelete = (task) => {
  if (confirm(`确定要删除任务 "${task.task}" 吗？`)) {
    emit("delete", task.id);
  }
};
</script>

<style scoped>
.task-list {
  display: flex;
  flex-direction: column;
  padding: 20px;
  overflow: hidden;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.list-header h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.header-icon {
  width: 20px;
  height: 20px;
  color: var(--accent);
}

.task-count {
  font-size: 0.75rem;
  color: var(--text-muted);
  padding: 4px 10px;
  background: rgba(139, 92, 246, 0.1);
  border-radius: 12px;
}

.list-container {
  flex: 1;
  overflow-x: auto;
  overflow-y: auto;
  max-height: 300px;
}

.task-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.task-table th {
  position: sticky;
  top: 0;
  background: var(--bg-secondary);
  padding: 10px 12px;
  text-align: left;
  font-weight: 500;
  color: var(--text-muted);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  white-space: nowrap;
  z-index: 1;
}

.task-table td {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.task-row {
  transition: background 0.2s ease;
}

.task-row:hover {
  background: rgba(139, 92, 246, 0.05);
}

.col-task {
  min-width: 180px;
}

.col-time {
  min-width: 80px;
  font-family: "SF Mono", "Fira Code", monospace;
  color: var(--text-secondary) !important;
}

.col-bot {
  min-width: 100px;
}

.col-duration {
  min-width: 70px;
  color: var(--text-muted) !important;
}

.col-actions {
  min-width: 80px;
  text-align: center;
}

.task-name {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 10px;
  font-size: 0.75rem;
  color: white;
  white-space: nowrap;
}

.action-btn {
  background: none;
  border: none;
  padding: 6px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-muted);
  transition: all 0.2s ease;
}

.action-btn svg {
  width: 16px;
  height: 16px;
}

.edit-btn:hover {
  background: rgba(139, 92, 246, 0.2);
  color: var(--accent);
}

.delete-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--text-muted);
}

.empty-icon {
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-state p {
  margin: 0;
  font-size: 0.875rem;
}
</style>
