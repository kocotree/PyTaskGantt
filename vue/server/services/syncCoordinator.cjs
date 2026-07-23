'use strict';

const {
  EXECUTION_STATUS,
  normalizeExecutionStatus,
  isTerminalStatus,
} = require('./executionStatus.cjs');
const { sanitizeForLog } = require('./yingdaoClient.cjs');
const { defaultSleep } = require('./rateLimiter.cjs');

const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const NAIVE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

function parseShanghaiTimestamp(value) {
  const match = NAIVE_TIMESTAMP_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = '0'] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const milliseconds = Number(fraction.padEnd(3, '0'));
  const timestamp = Date.UTC(
    parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], milliseconds
  ) - SHANGHAI_UTC_OFFSET_MS;
  const shifted = new Date(timestamp + SHANGHAI_UTC_OFFSET_MS);
  const valid = shifted.getUTCFullYear() === parts[0]
    && shifted.getUTCMonth() === parts[1] - 1
    && shifted.getUTCDate() === parts[2]
    && shifted.getUTCHours() === parts[3]
    && shifted.getUTCMinutes() === parts[4]
    && shifted.getUTCSeconds() === parts[5];
  return valid ? new Date(timestamp) : null;
}

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (!value) return null;
  const text = String(value).trim();
  const shanghaiDate = parseShanghaiTimestamp(text);
  if (shanghaiDate || NAIVE_TIMESTAMP_PATTERN.test(text)) return shanghaiDate;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoTimestamp(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function yingdaoTimestamp(value) {
  const date = asDate(value);
  if (!date) return '';
  const pad = number => String(number).padStart(2, '0');
  const shanghai = new Date(date.getTime() + SHANGHAI_UTC_OFFSET_MS);
  return [
    shanghai.getUTCFullYear(), '-', pad(shanghai.getUTCMonth() + 1), '-', pad(shanghai.getUTCDate()),
    ' ', pad(shanghai.getUTCHours()), ':', pad(shanghai.getUTCMinutes()), ':', pad(shanghai.getUTCSeconds()),
  ].join('');
}

function scheduleUuidOf(record) {
  return String(record && (
    record.sourceUuid
    || record.scheduleUuid
    || record.schedule_uuid
    || record.scheduleUuidAtRun
  ) || '').trim();
}

function taskUuidOf(record) {
  return String(record && (record.taskUuid || record.task_uuid) || '').trim();
}

function triggerTimeOf(record) {
  return isoTimestamp(record && (
    record.triggerTime
    || record.createTime
    || record.startTime
    || record.trigger_time
  ));
}

function clientsOf(record) {
  const clients = record && (
    record.taskClients
    || record.jobDataList
    || record.clients
  );
  return Array.isArray(clients) ? clients : [];
}

function errorRemarkOf(record) {
  const direct = String(record && (record.errorRemark || record.remark) || '').trim();
  if (direct) return direct;
  return clientsOf(record)
    .map(client => client && client.remark ? String(client.remark).trim() : '')
    .filter(Boolean)
    .join('；');
}

function normalizeExecutionRecord(record, {
  taskId,
  scheduleUuid,
  syncedAt,
  fallback = {},
} = {}) {
  const merged = { ...fallback, ...record };
  const taskUuid = taskUuidOf(merged);
  const triggerTime = triggerTimeOf(merged);
  if (!taskUuid || !taskId || !triggerTime) return null;

  const rawStatus = String(merged.status ?? merged.rawStatus ?? '').trim();
  const rawStatusName = String(merged.statusName ?? merged.rawStatusName ?? '').trim();
  const explicitNormalizedStatus = record
    && Object.prototype.hasOwnProperty.call(record, 'normalizedStatus')
    ? record.normalizedStatus
    : undefined;
  const clients = clientsOf(merged);
  const jobUuidList = Array.isArray(merged.jobUuidList)
    ? merged.jobUuidList.map(String)
    : Array.isArray(fallback.jobUuidList)
      ? fallback.jobUuidList.map(String)
      : [];

  return {
    taskUuid,
    rpaTaskId: String(taskId),
    scheduleUuidAtRun: String(scheduleUuid || scheduleUuidOf(merged)),
    normalizedStatus: normalizeExecutionStatus({
      ...merged,
      normalizedStatus: explicitNormalizedStatus,
      status: rawStatus,
      statusName: rawStatusName,
      errorRemark: errorRemarkOf(merged),
    }),
    rawStatus,
    rawStatusName,
    triggerTime,
    updatedTime: isoTimestamp(merged.updateTime || merged.updatedTime || merged.updated_time),
    endTime: isoTimestamp(merged.endTime || merged.end_time),
    jobUuidList,
    sourceType: String(merged.sourceType || merged.source_type || '').trim(),
    clients,
    errorRemark: errorRemarkOf(merged),
    syncedAt: isoTimestamp(syncedAt) || new Date().toISOString(),
    idempotentUuid: merged.idempotentUuid || fallback.idempotentUuid || null,
    startedByUserId: merged.startedByUserId || fallback.startedByUserId || null,
  };
}

function executionEventTime(execution) {
  for (const value of [execution && execution.endTime, execution && execution.updatedTime, execution && execution.triggerTime]) {
    const date = asDate(value);
    if (date) return date.getTime();
  }
  return Number.NEGATIVE_INFINITY;
}

class SyncCoordinatorError extends Error {
  constructor(message, { statusCode = 400, code = 'SYNC_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SyncCoordinatorError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class SyncCoordinator {
  constructor({
    client,
    tasksRepository,
    executionsRepository,
    now = () => new Date(),
    sleep = defaultSleep,
    random = Math.random,
    syncIntervalMs = 60_000,
    incrementalLookbackDays = 2,
    historyDays = 30,
    pollFastDurationMs = 120_000,
    pollFastIntervalMs = 5_000,
    pollSlowMinIntervalMs = 15_000,
    pollSlowMaxIntervalMs = 30_000,
    maxPollDurationMs = 6 * 60 * 60 * 1000,
    maxConsecutivePollErrors = Infinity,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    logger = null,
  } = {}) {
    if (!client) throw new TypeError('syncCoordinator 需要 yingdao client');
    if (!tasksRepository) throw new TypeError('syncCoordinator 需要 tasksRepository');
    if (!executionsRepository) throw new TypeError('syncCoordinator 需要 executionsRepository');

    this.client = client;
    this.tasksRepository = tasksRepository;
    this.executionsRepository = executionsRepository;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.syncIntervalMs = syncIntervalMs;
    this.incrementalLookbackDays = incrementalLookbackDays;
    this.historyDays = historyDays;
    this.pollFastDurationMs = pollFastDurationMs;
    this.pollFastIntervalMs = pollFastIntervalMs;
    this.pollSlowMinIntervalMs = pollSlowMinIntervalMs;
    this.pollSlowMaxIntervalMs = pollSlowMaxIntervalMs;
    this.maxPollDurationMs = maxPollDurationMs;
    this.maxConsecutivePollErrors = maxConsecutivePollErrors;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.logger = logger;

    this.globalSyncFlight = null;
    this.userSyncFlights = new Map();
    this.taskSyncFlights = new Map();
    this.pollFlights = new Map();
    this.executionWriteFlights = new Map();
    this.interval = null;
    this.started = false;
    this.stopRequested = false;
    this.activeSyncs = 0;
    this.state = {
      running: false,
      lastSync: null,
      lastError: null,
      records: 0,
    };
  }

  _nowDate() {
    const value = this.now();
    return asDate(value) || new Date();
  }

  _nowIso() {
    return this._nowDate().toISOString();
  }

  _sanitizeUpstream(value) {
    return typeof this.client.sanitize === 'function'
      ? this.client.sanitize(value)
      : sanitizeForLog(value);
  }

  _log(level, message, metadata = {}) {
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level](message, metadata);
    }
  }

  _beginSync() {
    this.activeSyncs += 1;
    this.state.running = true;
  }

  _endSync() {
    this.activeSyncs = Math.max(0, this.activeSyncs - 1);
    this.state.running = this.activeSyncs > 0;
  }

  getState() {
    return { ...this.state };
  }

  async _listBoundTasks() {
    const tasks = await this.tasksRepository.listBoundTasks();
    return Array.isArray(tasks) ? tasks : [];
  }

  _bindingSnapshot(task) {
    if (!task || !task.id || !task.scheduleUuid) return null;
    return {
      taskId: String(task.id),
      scheduleUuid: String(task.scheduleUuid),
      scheduleBoundAt: isoTimestamp(task.scheduleBoundAt),
    };
  }

  async _beginSyncAttempt(task) {
    const snapshot = this._bindingSnapshot(task);
    if (!snapshot) return null;
    if (typeof this.tasksRepository.beginSyncAttempt !== 'function') {
      return { ...snapshot, syncGeneration: null };
    }
    return this.tasksRepository.beginSyncAttempt(snapshot);
  }

  async _beginExecutionSyncAttempt({ taskId, scheduleUuid, triggerTime }) {
    if (!taskId || !scheduleUuid) return null;
    const task = await this.tasksRepository.findById(taskId, { includeDeleted: false });
    if (!task || task.deletedAt || String(task.scheduleUuid || '') !== String(scheduleUuid)) return null;
    const boundAt = asDate(task.scheduleBoundAt);
    const trigger = asDate(triggerTime);
    if (boundAt && trigger && trigger < boundAt) return null;
    return this._beginSyncAttempt(task);
  }

  async _updateSyncState(attempt, { lastSyncedAt = null, syncError = null } = {}) {
    if (!attempt) return null;
    return this.tasksRepository.updateSyncState({
      taskId: String(attempt.taskId),
      scheduleUuid: attempt.scheduleUuid,
      scheduleBoundAt: attempt.scheduleBoundAt,
      syncGeneration: attempt.syncGeneration,
      lastSyncedAt,
      syncError,
    });
  }

  async _markAttemptsFailed(attempts, error) {
    const message = String(error && error.message ? error.message : error || '同步失败');
    await Promise.allSettled(attempts.map(attempt => this._updateSyncState(attempt, {
      lastSyncedAt: null,
      syncError: message,
    })));
    return message;
  }

  async _resolveTaskForRecord(record, currentTasksBySchedule) {
    const scheduleUuid = scheduleUuidOf(record);
    const triggerTime = triggerTimeOf(record);
    if (!scheduleUuid || !triggerTime) return null;

    if (typeof this.tasksRepository.findBindingForScheduleAt === 'function') {
      const binding = await this.tasksRepository.findBindingForScheduleAt(scheduleUuid, triggerTime);
      if (binding) {
        const taskId = binding.rpaTaskId || binding.taskId || binding.rpa_task_id || binding.id;
        if (taskId) return { taskId: String(taskId), scheduleUuid, triggerTime, binding };
      }
    }

    const task = currentTasksBySchedule.get(scheduleUuid);
    if (!task) return null;
    const boundAt = asDate(task.scheduleBoundAt);
    const trigger = asDate(triggerTime);
    if (boundAt && trigger && trigger < boundAt) return null;
    return { taskId: String(task.id), scheduleUuid, triggerTime, binding: task };
  }

  _writeExecutionMonotonic(execution) {
    const taskUuid = taskUuidOf(execution);
    if (!taskUuid) return Promise.reject(new TypeError('执行记录缺少 taskUuid'));
    const previous = this.executionWriteFlights.get(taskUuid) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = typeof this.executionsRepository.findByTaskUuid === 'function'
        ? await this.executionsRepository.findByTaskUuid(taskUuid)
        : null;
      if (existing) {
        const existingTerminal = isTerminalStatus(existing.normalizedStatus || existing);
        const incomingTerminal = isTerminalStatus(execution.normalizedStatus || execution);
        if (existingTerminal && !incomingTerminal) {
          return { record: existing, written: false };
        }
        if (
          !(!existingTerminal && incomingTerminal)
          && executionEventTime(execution) < executionEventTime(existing)
        ) {
          return { record: existing, written: false };
        }
      }
      const saved = await this.executionsRepository.upsertExecution(execution);
      return { record: saved || execution, written: true };
    });
    this.executionWriteFlights.set(taskUuid, operation);
    operation.finally(() => {
      if (this.executionWriteFlights.get(taskUuid) === operation) {
        this.executionWriteFlights.delete(taskUuid);
      }
    }).catch(() => undefined);
    return operation;
  }

  async applyRecords(records, { boundTasks = null, syncedAt = this._nowIso() } = {}) {
    const rows = Array.isArray(records) ? records : [];
    const tasks = boundTasks || await this._listBoundTasks();
    const currentTasksBySchedule = new Map(tasks
      .filter(task => task.scheduleUuid)
      .map(task => [String(task.scheduleUuid), task]));

    let applied = 0;
    let skipped = 0;
    for (const record of rows) {
      const safeRecord = this._sanitizeUpstream(record);
      const binding = await this._resolveTaskForRecord(safeRecord, currentTasksBySchedule);
      if (!binding) {
        skipped += 1;
        continue;
      }
      const execution = normalizeExecutionRecord(safeRecord, {
        taskId: binding.taskId,
        scheduleUuid: binding.scheduleUuid,
        syncedAt,
      });
      if (!execution) {
        skipped += 1;
        continue;
      }
      const written = await this._writeExecutionMonotonic(execution);
      if (written.written) applied += 1;
      else skipped += 1;
    }
    return { received: rows.length, applied, skipped };
  }

  syncAll() {
    if (this.globalSyncFlight) return this.globalSyncFlight;
    this.globalSyncFlight = this._syncAll()
      .finally(() => {
        this.globalSyncFlight = null;
      });
    return this.globalSyncFlight;
  }

  async _syncAll() {
    this._beginSync();
    let tasks = [];
    let attempts = [];
    try {
      tasks = await this._listBoundTasks();
      attempts = (await Promise.all(tasks.map(task => this._beginSyncAttempt(task)))).filter(Boolean);
      const end = this._nowDate();
      const start = new Date(end.getTime() - this.incrementalLookbackDays * 24 * 60 * 60 * 1000);
      const records = await this.client.fetchNewestTasks({
        startTime: yingdaoTimestamp(start),
        endTime: yingdaoTimestamp(end),
        page: 1,
        size: 100,
      });
      const syncedAt = this._nowIso();
      const result = await this.applyRecords(records, { boundTasks: tasks, syncedAt });
      await Promise.all(attempts.map(attempt => this._updateSyncState(attempt, {
        lastSyncedAt: syncedAt,
        syncError: null,
      })));
      this.state.lastSync = syncedAt;
      this.state.lastError = null;
      this.state.records = result.applied;
      return { ...result, syncedAt };
    } catch (error) {
      const message = await this._markAttemptsFailed(attempts, error);
      this.state.lastError = message;
      throw error;
    } finally {
      this._endSync();
    }
  }

  syncUser(userId) {
    const key = String(userId);
    if (this.userSyncFlights.has(key)) return this.userSyncFlights.get(key);
    const flight = this._syncUser(key)
      .finally(() => {
        this.userSyncFlights.delete(key);
      });
    this.userSyncFlights.set(key, flight);
    return flight;
  }

  syncTask(userId, taskId) {
    const key = `${String(userId)}:${String(taskId)}`;
    if (this.taskSyncFlights.has(key)) return this.taskSyncFlights.get(key);
    const flight = this._syncTask(String(userId), String(taskId))
      .finally(() => {
        this.taskSyncFlights.delete(key);
      });
    this.taskSyncFlights.set(key, flight);
    return flight;
  }

  async _syncTask(userId, taskId) {
    this._beginSync();
    let task = null;
    let attempt = null;
    let attemptedRemoteSync = false;
    try {
      task = await this.tasksRepository.findById(taskId, { includeDeleted: false });
      if (!task || task.deletedAt) {
        throw new SyncCoordinatorError('未找到可同步任务', { statusCode: 404, code: 'TASK_NOT_FOUND' });
      }
      if (String(task.ownerUserId) !== String(userId)) {
        throw new SyncCoordinatorError('只有当前所有者可以同步任务', {
          statusCode: 403,
          code: 'NOT_TASK_OWNER',
        });
      }
      if (!task.scheduleUuid) {
        throw new SyncCoordinatorError('任务尚未绑定影刀计划', { statusCode: 409, code: 'TASK_UNBOUND' });
      }
      attempt = await this._beginSyncAttempt(task);
      if (!attempt) {
        throw new SyncCoordinatorError('任务绑定已变化，请刷新后重试', {
          statusCode: 409,
          code: 'TASK_BINDING_CHANGED',
        });
      }

      const end = this._nowDate();
      const start = new Date(end.getTime() - this.historyDays * 24 * 60 * 60 * 1000);
      attemptedRemoteSync = true;
      const records = await this.client.listTaskHistory(attempt.scheduleUuid, {
        startTime: yingdaoTimestamp(start),
        endTime: yingdaoTimestamp(end),
      });
      const allTasks = await this._listBoundTasks();
      const syncedAt = this._nowIso();
      const result = await this.applyRecords(records, { boundTasks: allTasks, syncedAt });
      const state = await this._updateSyncState(attempt, { lastSyncedAt: syncedAt, syncError: null });
      return { ...result, taskId: String(task.id), syncedAt, stateApplied: Boolean(state) };
    } catch (error) {
      if (attempt && attemptedRemoteSync) {
        await this._updateSyncState(attempt, {
          lastSyncedAt: null,
          syncError: String(error.message || error),
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      this._endSync();
    }
  }

  async _syncUser(userId) {
    this._beginSync();
    let allTasks = [];
    let tasks = [];
    const errors = [];
    let applied = 0;
    let received = 0;
    let succeededTasks = 0;
    let lastSuccessAt = null;
    try {
      allTasks = await this._listBoundTasks();
      tasks = allTasks.filter(task => String(task.ownerUserId) === String(userId));
      const end = this._nowDate();
      const start = new Date(end.getTime() - this.historyDays * 24 * 60 * 60 * 1000);
      for (const task of tasks) {
        let attempt = null;
        let attemptedRemoteSync = false;
        try {
          attempt = await this._beginSyncAttempt(task);
          if (!attempt) continue;
          attemptedRemoteSync = true;
          const records = await this.client.listTaskHistory(attempt.scheduleUuid, {
            startTime: yingdaoTimestamp(start),
            endTime: yingdaoTimestamp(end),
          });
          const syncedAt = this._nowIso();
          const result = await this.applyRecords(records, { boundTasks: allTasks, syncedAt });
          received += result.received;
          applied += result.applied;
          await this._updateSyncState(attempt, { lastSyncedAt: syncedAt, syncError: null });
          succeededTasks += 1;
          lastSuccessAt = syncedAt;
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          errors.push({ taskId: String(task.id), message });
          if (attempt && attemptedRemoteSync) {
            await this._updateSyncState(attempt, { lastSyncedAt: null, syncError: message });
          }
        }
      }
      if (tasks.length === 0) lastSuccessAt = this._nowIso();
      if (lastSuccessAt) this.state.lastSync = lastSuccessAt;
      this.state.lastError = errors.length ? errors.map(item => item.message).join('；') : null;
      this.state.records = applied;
      return {
        tasks: tasks.length,
        succeededTasks,
        received,
        applied,
        errors,
        syncedAt: lastSuccessAt,
      };
    } catch (error) {
      this.state.lastError = String(error.message || error);
      throw error;
    } finally {
      this._endSync();
    }
  }

  startPolling(execution, options = {}) {
    const taskUuid = taskUuidOf(execution);
    if (!taskUuid) return Promise.reject(new TypeError('轮询需要 taskUuid'));
    if (this.pollFlights.has(taskUuid)) return this.pollFlights.get(taskUuid);
    const flight = this._pollExecution(execution, options)
      .finally(() => {
        this.pollFlights.delete(taskUuid);
      });
    this.pollFlights.set(taskUuid, flight);
    return flight;
  }

  trackExecution(execution, options = {}) {
    return this.startPolling(execution, options);
  }

  async _pollExecution(execution, { maxPolls = Infinity } = {}) {
    const taskUuid = taskUuidOf(execution);
    const taskId = execution.rpaTaskId || execution.rpa_task_id;
    const scheduleUuid = execution.scheduleUuidAtRun || execution.schedule_uuid_at_run;
    const nowAtStart = this._nowDate().getTime();
    const persistedTriggerAt = asDate(execution.triggerTime || execution.trigger_time);
    const pollingStartedAt = persistedTriggerAt
      ? Math.min(nowAtStart, persistedTriggerAt.getTime())
      : nowAtStart;
    let current = { ...execution };
    let polls = 0;
    let consecutiveErrors = 0;

    while (!this.stopRequested && polls < maxPolls) {
      const elapsed = this._nowDate().getTime() - pollingStartedAt;
      if (elapsed > this.maxPollDurationMs && polls > 0) {
        const timedOutAt = this._nowIso();
        const timeoutRemark = `本平台轮询超过 ${this.maxPollDurationMs}ms`;
        const previousRemark = String(current.errorRemark || '').trim();
        const normalizedStatus = current.normalizedStatus === EXECUTION_STATUS.WAITING
          ? EXECUTION_STATUS.WAIT_TIMEOUT
          : current.normalizedStatus === EXECUTION_STATUS.RUNNING
            ? EXECUTION_STATUS.RUN_TIMEOUT
            : EXECUTION_STATUS.FAILED;
        const timeoutExecution = {
          ...current,
          normalizedStatus,
          errorRemark: previousRemark.includes(timeoutRemark)
            ? previousRemark
            : [previousRemark, timeoutRemark].filter(Boolean).join('；'),
          syncedAt: timedOutAt,
        };
        const written = await this._writeExecutionMonotonic(timeoutExecution);
        if (taskId) {
          const attempt = await this._beginExecutionSyncAttempt({
            taskId,
            scheduleUuid,
            triggerTime: current.triggerTime,
          }).catch(() => null);
          await this._updateSyncState(attempt, {
            lastSyncedAt: timedOutAt,
            syncError: null,
          }).catch(() => undefined);
        }
        return written.record;
      }
      const delayMs = elapsed < this.pollFastDurationMs
        ? this.pollFastIntervalMs
        : Math.round(this.pollSlowMinIntervalMs
          + this.random() * (this.pollSlowMaxIntervalMs - this.pollSlowMinIntervalMs));
      if (delayMs > 0) await this.sleep(delayMs);
      if (this.stopRequested) return current;

      let syncAttempt = null;
      try {
        syncAttempt = await this._beginExecutionSyncAttempt({
          taskId,
          scheduleUuid,
          triggerTime: current.triggerTime,
        });
        const result = await this.client.queryTask(taskUuid);
        const raw = {
          ...result.execution,
          taskUuid,
          sourceUuid: scheduleUuid,
          createTime: result.execution.triggerTime
            || result.execution.createTime
            || result.execution.startTime
            || current.triggerTime,
          jobUuidList: result.execution.jobUuidList || current.jobUuidList,
          idempotentUuid: current.idempotentUuid,
          startedByUserId: current.startedByUserId,
        };
        const normalized = normalizeExecutionRecord(this._sanitizeUpstream(raw), {
          taskId,
          scheduleUuid,
          syncedAt: this._nowIso(),
          fallback: current,
        });
        if (!normalized) throw new SyncCoordinatorError('影刀轮询结果缺少任务标识或触发时间');
        const written = await this._writeExecutionMonotonic(normalized);
        current = written.record;
        consecutiveErrors = 0;
        if (syncAttempt) {
          await this._updateSyncState(syncAttempt, {
            lastSyncedAt: normalized.syncedAt,
            syncError: null,
          }).catch(() => undefined);
        }
        polls += 1;
        if (isTerminalStatus(current.normalizedStatus || current)) return current;
      } catch (error) {
        consecutiveErrors += 1;
        if (syncAttempt) {
          await this._updateSyncState(syncAttempt, {
            lastSyncedAt: null,
            syncError: String(error.message || error),
          }).catch(() => undefined);
        }
        if (consecutiveErrors >= this.maxConsecutivePollErrors) throw error;
        polls += 1;
      }
    }
    return current;
  }

  async recoverPolling() {
    const active = await this.executionsRepository.listActiveExecutions({});
    const executions = Array.isArray(active) ? active : [];
    for (const execution of executions) {
      this.startPolling(execution).catch(error => {
        this._log('warn', '恢复执行轮询失败', {
          taskUuid: taskUuidOf(execution),
          message: error.message,
        });
      });
    }
    return executions.length;
  }

  waitForPolling(taskUuid) {
    return this.pollFlights.get(String(taskUuid)) || Promise.resolve(null);
  }

  start() {
    if (this.started) return this.startupPromise;
    this.started = true;
    this.stopRequested = false;

    // 故意异步启动，调用者不 await 即不会阻塞 health endpoint 就绪。
    this.startupPromise = Promise.resolve()
      .then(() => this.recoverPolling())
      .then(() => this.syncAll())
      .catch(error => {
        this._log('warn', '影刀启动恢复同步失败', { message: error.message });
        return null;
      });

    this.interval = this.setIntervalFn(() => {
      this.syncAll().catch(error => {
        this._log('warn', '影刀定时同步失败', { message: error.message });
      });
    }, this.syncIntervalMs);
    return this.startupPromise;
  }

  stop() {
    this.stopRequested = true;
    this.started = false;
    if (this.interval) this.clearIntervalFn(this.interval);
    this.interval = null;
  }
}

function createSyncCoordinator(options) {
  return new SyncCoordinator(options);
}

function createPollingCoordinator(syncCoordinatorOrOptions) {
  const coordinator = syncCoordinatorOrOptions instanceof SyncCoordinator
    ? syncCoordinatorOrOptions
    : createSyncCoordinator(syncCoordinatorOrOptions);
  return {
    trackExecution: (execution, options) => coordinator.trackExecution(execution, options),
    recover: () => coordinator.recoverPolling(),
    waitFor: taskUuid => coordinator.waitForPolling(taskUuid),
    stop: () => coordinator.stop(),
    coordinator,
  };
}

module.exports = {
  SyncCoordinator,
  SyncCoordinatorError,
  createSyncCoordinator,
  createPollingCoordinator,
  normalizeExecutionRecord,
  isoTimestamp,
  yingdaoTimestamp,
  taskUuidOf,
  scheduleUuidOf,
};
