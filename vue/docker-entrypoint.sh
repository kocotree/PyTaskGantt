#!/bin/sh
set -e

# 首次启动时，如果持久化数据目录为空，从默认种子文件拷贝一份
DATA_DIR="$(dirname "$TASKS_FILE")"
if [ ! -f "$TASKS_FILE" ]; then
  echo "📋 首次启动：初始化默认任务数据 → $TASKS_FILE"
  mkdir -p "$DATA_DIR"
  cp /app/default-tasks.json "$TASKS_FILE"
fi

echo "🚀 启动 PyTaskGantt 服务..."
exec "$@"
