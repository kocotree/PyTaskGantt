'use strict';

const EXECUTION_STATUS = Object.freeze({
  NOT_RUN: '待运行',
  WAITING: '等待中',
  RUNNING: '运行中',
  WAIT_TIMEOUT: '等待超时',
  RUN_TIMEOUT: '运行超时',
  SUCCEEDED: '运行成功',
  FAILED: '运行失败',
  STOPPED: '已停止',
  UNKNOWN: '未知状态',
});

const WAITING_RAW = new Set([
  'created', 'pending', 'waiting', 'queued', 'dispatching',
]);
const RUNNING_RAW = new Set(['running', 'executing']);
const SUCCEEDED_RAW = new Set(['finish', 'finished', 'success', 'succeeded']);
const FAILED_RAW = new Set(['error', 'failed', 'fail']);
const STOPPED_RAW = new Set(['stopped', 'stop', 'cancelled', 'canceled']);
const TIMEOUT_RAW = new Set(['timeout', 'timedout', 'timed_out', 'time_out']);

const TERMINAL_NORMALIZED = new Set([
  EXECUTION_STATUS.WAIT_TIMEOUT,
  EXECUTION_STATUS.RUN_TIMEOUT,
  EXECUTION_STATUS.SUCCEEDED,
  EXECUTION_STATUS.FAILED,
  EXECUTION_STATUS.STOPPED,
]);

const NORMALIZED_VALUES = new Set(Object.values(EXECUTION_STATUS));

function textOf(record) {
  return [
    record && record.status,
    record && record.rawStatus,
    record && record.statusName,
    record && record.rawStatusName,
    record && record.errorRemark,
    record && record.remark,
    record && record.stage,
    record && record.phase,
    record && record.currentStage,
  ]
    .filter(value => value !== undefined && value !== null)
    .join(' ')
    .trim()
    .toLowerCase();
}

function containsTimeout(text) {
  return /timeout|time[ _-]?out|超时|超过.*(?:时长|时间)|最大(?:运行|执行)时长/.test(text);
}

function timeoutKind(record, fallbackStatus) {
  const text = textOf(record);

  // 优先采用影刀返回的阶段、statusName 和 errorRemark，不依赖单一 status。
  if (
    /等待(?:机器人|客户端|资源|调度)|排队|派发|分配机器人|机器人.*(?:空闲|上线)|waiting|queued|dispatch/.test(text)
  ) {
    return EXECUTION_STATUS.WAIT_TIMEOUT;
  }
  if (
    /应用.*(?:运行|执行)|执行.*超时|运行.*超时|流程.*超时|脚本.*超时|running|executing|process/.test(text)
  ) {
    return EXECUTION_STATUS.RUN_TIMEOUT;
  }

  if (fallbackStatus === EXECUTION_STATUS.WAITING) {
    return EXECUTION_STATUS.WAIT_TIMEOUT;
  }
  if (fallbackStatus === EXECUTION_STATUS.RUNNING) {
    return EXECUTION_STATUS.RUN_TIMEOUT;
  }

  // 无法可靠区分的 timeout 按实施方案保守落为运行失败，不凭空猜阶段。
  return EXECUTION_STATUS.FAILED;
}

function normalizeExecutionStatus(recordOrStatus) {
  const record = recordOrStatus && typeof recordOrStatus === 'object'
    ? recordOrStatus
    : { status: recordOrStatus };

  if (NORMALIZED_VALUES.has(record.normalizedStatus)) {
    return record.normalizedStatus;
  }

  const raw = String(record.status ?? record.rawStatus ?? '').trim().toLowerCase();
  const text = textOf(record);

  if (WAITING_RAW.has(raw)) {
    return containsTimeout(text)
      ? timeoutKind(record, EXECUTION_STATUS.WAITING)
      : EXECUTION_STATUS.WAITING;
  }
  if (RUNNING_RAW.has(raw)) {
    return containsTimeout(text)
      ? timeoutKind(record, EXECUTION_STATUS.RUNNING)
      : EXECUTION_STATUS.RUNNING;
  }
  if (SUCCEEDED_RAW.has(raw)) return EXECUTION_STATUS.SUCCEEDED;
  if (FAILED_RAW.has(raw)) {
    return containsTimeout(text)
      ? timeoutKind(record, null)
      : EXECUTION_STATUS.FAILED;
  }
  if (STOPPED_RAW.has(raw)) return EXECUTION_STATUS.STOPPED;
  if (TIMEOUT_RAW.has(raw) || containsTimeout(text)) return timeoutKind(record, null);

  // 某些返回只提供本地化 statusName，做有限且保守的补充识别。
  if (/成功|完成/.test(text) && !/未完成|失败/.test(text)) return EXECUTION_STATUS.SUCCEEDED;
  if (/停止|取消/.test(text)) return EXECUTION_STATUS.STOPPED;
  if (/失败|错误|异常/.test(text)) return EXECUTION_STATUS.FAILED;
  if (/运行中|执行中|正在运行|正在执行/.test(text)) return EXECUTION_STATUS.RUNNING;
  if (/等待|排队|派发/.test(text)) return EXECUTION_STATUS.WAITING;

  return EXECUTION_STATUS.UNKNOWN;
}

function isActiveStatus(statusOrRecord) {
  const status = NORMALIZED_VALUES.has(statusOrRecord)
    ? statusOrRecord
    : normalizeExecutionStatus(statusOrRecord);
  return status === EXECUTION_STATUS.WAITING
    || status === EXECUTION_STATUS.RUNNING
    || status === EXECUTION_STATUS.UNKNOWN;
}

function isTerminalStatus(statusOrRecord) {
  const status = NORMALIZED_VALUES.has(statusOrRecord)
    ? statusOrRecord
    : normalizeExecutionStatus(statusOrRecord);
  return TERMINAL_NORMALIZED.has(status);
}

function timestampOf(execution) {
  for (const value of [execution.endTime, execution.updatedTime, execution.triggerTime]) {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value || '');
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function aggregateExecutionStatus(executions) {
  const rows = Array.isArray(executions) ? executions : [];
  if (rows.length === 0) {
    return {
      normalizedStatus: EXECUTION_STATUS.NOT_RUN,
      execution: null,
      lastRunAt: null,
      activeCount: 0,
    };
  }

  const decorated = rows.map(execution => ({
    execution,
    normalizedStatus: normalizeExecutionStatus(execution),
    timestamp: timestampOf(execution),
  }));

  const mostRecent = candidates => [...candidates].sort((a, b) => b.timestamp - a.timestamp)[0];
  const running = decorated.filter(item => item.normalizedStatus === EXECUTION_STATUS.RUNNING);
  const waiting = decorated.filter(item => item.normalizedStatus === EXECUTION_STATUS.WAITING);
  const unknown = decorated.filter(item => item.normalizedStatus === EXECUTION_STATUS.UNKNOWN);
  const selected = running.length > 0
    ? mostRecent(running)
    : waiting.length > 0
      ? mostRecent(waiting)
      : unknown.length > 0
        ? mostRecent(unknown)
        : mostRecent(decorated);

  return {
    normalizedStatus: selected.normalizedStatus,
    execution: selected.execution,
    lastRunAt: Number.isFinite(selected.timestamp)
      ? new Date(selected.timestamp).toISOString()
      : null,
    activeCount: running.length + waiting.length + unknown.length,
  };
}

function aggregateNormalizedStatus(executions) {
  return aggregateExecutionStatus(executions).normalizedStatus;
}

module.exports = {
  EXECUTION_STATUS,
  normalizeExecutionStatus,
  aggregateExecutionStatus,
  aggregateNormalizedStatus,
  isActiveStatus,
  isTerminalStatus,
};
