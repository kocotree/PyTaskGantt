<template>
  <aside class="filter-panel glass-panel">
    <div class="panel-header">
      <component :is="FilterIcon" class="header-icon" />
      <h2>筛选与操作</h2>
    </div>

    <!-- 数据操作按钮组 -->
    <div class="action-group">
      <button
        class="btn btn-secondary"
        @click="$emit('refresh')"
        title="从服务器重新加载数据"
      >
        <component :is="RefreshCwIcon" class="btn-icon" />
        刷新
      </button>
      <button
        class="btn btn-secondary"
        @click="triggerImport"
        title="导入CSV/JSON文件到源数据"
      >
        <component :is="UploadIcon" class="btn-icon" />
        导入
      </button>
      <button
        class="btn btn-secondary"
        @click="$emit('export')"
        title="下载导出数据文件"
      >
        <component :is="DownloadIcon" class="btn-icon" />
        导出
      </button>
    </div>

    <!-- 保存按钮 -->
    <button
      class="btn btn-save"
      @click="$emit('save')"
      title="保存修改到源文件"
    >
      <component :is="SaveIcon" class="btn-icon" />
      保存更改
    </button>

    <!-- 隐藏的文件输入 -->
    <input
      type="file"
      ref="fileInput"
      accept=".csv,.json"
      style="display: none"
      @change="handleFileSelect"
    />

    <!-- 搜索框 -->
    <div class="filter-group">
      <label>
        <component :is="SearchIcon" class="label-icon" />
        搜索任务
      </label>
      <div class="search-input-wrapper">
        <input
          type="text"
          v-model="localSearchTerm"
          placeholder="输入关键词..."
          class="search-input"
          @input="handleSearchChange"
        />
        <button v-if="localSearchTerm" class="clear-btn" @click="clearSearch">
          <component :is="XIcon" />
        </button>
      </div>
    </div>

    <!-- 机器人筛选 -->
    <div class="filter-group">
      <label>
        <component :is="BotIcon" class="label-icon" />
        筛选机器人
      </label>
      <div class="bot-checkboxes">
        <label
          v-for="bot in bots"
          :key="bot"
          class="checkbox-item"
          :style="{ '--bot-color': getBotColor(bot).main }"
        >
          <input
            type="checkbox"
            :value="bot"
            v-model="localSelectedBots"
            @change="handleBotChange"
          />
          <span class="checkbox-label">{{ bot }}</span>
        </label>
      </div>
      <div class="bot-actions">
        <button class="link-btn" @click="selectAllBots">全选</button>
        <span class="divider">|</span>
        <button class="link-btn" @click="clearAllBots">清空</button>
      </div>
    </div>

    <!-- 排序方式 -->
    <div class="filter-group">
      <label>
        <component :is="ArrowUpDownIcon" class="label-icon" />
        排序方式
      </label>
      <div class="sort-options">
        <button
          class="sort-btn"
          :class="{ active: localSortBy === 'bot' }"
          @click="handleSortChange('bot')"
        >
          按机器人
        </button>
        <button
          class="sort-btn"
          :class="{ active: localSortBy === 'time' }"
          @click="handleSortChange('time')"
        >
          按时间
        </button>
      </div>
    </div>

    <div class="divider-line"></div>

    <!-- 统计信息 -->
    <div class="stats">
      <div class="stat-item">
        <span class="stat-value">{{ filteredCount }}</span>
        <span class="stat-label">当前显示</span>
      </div>
      <span class="stat-divider">/</span>
      <div class="stat-item">
        <span class="stat-value">{{ totalCount }}</span>
        <span class="stat-label">总任务数</span>
      </div>
    </div>

    <!-- 添加任务按钮 -->
    <button class="btn btn-primary" @click="$emit('add-task')">
      <component :is="PlusIcon" class="btn-icon" />
      添加任务
    </button>
  </aside>
</template>

<script setup>
import { ref, watch } from "vue";
import {
  Filter as FilterIcon,
  Search as SearchIcon,
  RefreshCw as RefreshCwIcon,
  Bot as BotIcon,
  ArrowUpDown as ArrowUpDownIcon,
  Plus as PlusIcon,
  X as XIcon,
  Upload as UploadIcon,
  Download as DownloadIcon,
  Save as SaveIcon,
} from "lucide-vue-next";
import { getBotColor } from "../services/dataService";

const props = defineProps({
  bots: {
    type: Array,
    required: true,
  },
  searchTerm: {
    type: String,
    default: "",
  },
  selectedBots: {
    type: Array,
    default: () => [],
  },
  sortBy: {
    type: String,
    default: "bot",
  },
  filteredCount: {
    type: Number,
    default: 0,
  },
  totalCount: {
    type: Number,
    default: 0,
  },
});

const emit = defineEmits([
  "update:searchTerm",
  "update:selectedBots",
  "update:sortBy",
  "refresh",
  "add-task",
  "import-file",
  "export",
  "save",
]);

// 文件输入引用
const fileInput = ref(null);

// 本地状态
const localSearchTerm = ref(props.searchTerm);
const localSelectedBots = ref([...props.selectedBots]);
const localSortBy = ref(props.sortBy);

// 监听 props 变化
watch(
  () => props.searchTerm,
  (val) => {
    localSearchTerm.value = val;
  }
);
watch(
  () => props.selectedBots,
  (val) => {
    localSelectedBots.value = [...val];
  }
);
watch(
  () => props.sortBy,
  (val) => {
    localSortBy.value = val;
  }
);

// 事件处理
const handleSearchChange = () => {
  emit("update:searchTerm", localSearchTerm.value);
};

const clearSearch = () => {
  localSearchTerm.value = "";
  emit("update:searchTerm", "");
};

const handleBotChange = () => {
  emit("update:selectedBots", [...localSelectedBots.value]);
};

const selectAllBots = () => {
  localSelectedBots.value = [...props.bots];
  emit("update:selectedBots", [...props.bots]);
};

const clearAllBots = () => {
  localSelectedBots.value = [];
  emit("update:selectedBots", []);
};

const handleSortChange = (sort) => {
  localSortBy.value = sort;
  emit("update:sortBy", sort);
};

// 文件导入
const triggerImport = () => {
  fileInput.value?.click();
};

const handleFileSelect = (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  // 检测文件格式
  const format = file.name.endsWith(".json") ? "json" : "csv";

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target?.result;
    if (content) {
      emit("import-file", { content, format });
    }
  };
  reader.readAsText(file);

  // 重置输入以便再次选择同一文件
  event.target.value = "";
};
</script>

<style scoped>
.filter-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
  height: fit-content;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-header h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
}

.header-icon {
  width: 24px;
  height: 24px;
  color: var(--accent);
}

.action-group {
  display: flex;
  gap: 8px;
}

.action-group .btn {
  flex: 1;
  padding: 8px 10px;
  font-size: 0.75rem;
}

.action-group .btn-icon {
  width: 14px;
  height: 14px;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.filter-group label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.label-icon {
  width: 16px;
  height: 16px;
}

.search-input-wrapper {
  position: relative;
}

.search-input {
  width: 100%;
  padding: 10px 36px 10px 14px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  transition: all 0.2s ease;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.search-input::placeholder {
  color: var(--text-muted);
}

.clear-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s ease;
}

.clear-btn:hover {
  color: var(--text-primary);
}

.clear-btn svg {
  width: 16px;
  height: 16px;
}

.bot-checkboxes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 6px;
  transition: background 0.2s ease;
}

.checkbox-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.checkbox-item input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--bot-color, var(--accent));
  cursor: pointer;
}

.checkbox-label {
  font-size: 0.875rem;
  color: var(--text-primary);
}

.bot-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
  transition: color 0.2s ease;
}

.link-btn:hover {
  color: var(--accent-light);
  text-decoration: underline;
}

.bot-actions .divider {
  color: var(--text-muted);
  font-size: 0.75rem;
}

.sort-options {
  display: flex;
  gap: 8px;
}

.sort-btn {
  flex: 1;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sort-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.sort-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.divider-line {
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.1),
    transparent
  );
}

.stats {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px;
  background: rgba(139, 92, 246, 0.1);
  border-radius: 8px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--accent);
}

.stat-label {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.stat-divider {
  color: var(--text-muted);
  font-size: 1.25rem;
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  border: none;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-icon {
  width: 18px;
  height: 18px;
}

.btn-primary {
  background: linear-gradient(135deg, var(--accent), #a855f7);
  color: white;
  box-shadow: 0 4px 15px var(--accent-glow);
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px var(--accent-glow);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.1);
}

.btn-save {
  background: linear-gradient(135deg, #10b981, #059669);
  color: white;
  box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);
}

.btn-save:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(16, 185, 129, 0.5);
}
</style>
