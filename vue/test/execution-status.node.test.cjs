'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXECUTION_STATUS,
  normalizeExecutionStatus,
  aggregateExecutionStatus,
  isActiveStatus,
  isTerminalStatus,
} = require('../server/services/executionStatus.cjs');

test('影刀原始状态映射为平台状态', () => {
  for (const status of ['created', 'pending', 'waiting', 'queued', 'dispatching']) {
    assert.equal(normalizeExecutionStatus({ status }), EXECUTION_STATUS.WAITING);
  }
  for (const status of ['running', 'executing']) {
    assert.equal(normalizeExecutionStatus({ status }), EXECUTION_STATUS.RUNNING);
  }
  for (const status of ['finish', 'success']) {
    assert.equal(normalizeExecutionStatus({ status }), EXECUTION_STATUS.SUCCEEDED);
  }
  for (const status of ['error', 'failed', 'fail']) {
    assert.equal(normalizeExecutionStatus({ status }), EXECUTION_STATUS.FAILED);
  }
  for (const status of ['stopped', 'stop', 'cancelled', 'canceled']) {
    assert.equal(normalizeExecutionStatus({ status }), EXECUTION_STATUS.STOPPED);
  }
  assert.equal(normalizeExecutionStatus({ status: 'new-future-status' }), EXECUTION_STATUS.UNKNOWN);
});

test('超时优先根据 statusName、errorRemark 和阶段信息区分', () => {
  assert.equal(normalizeExecutionStatus({
    status: 'timeout',
    statusName: '等待机器人超时',
  }), EXECUTION_STATUS.WAIT_TIMEOUT);
  assert.equal(normalizeExecutionStatus({
    status: 'failed',
    errorRemark: '应用运行超过最大时长',
  }), EXECUTION_STATUS.RUN_TIMEOUT);
  assert.equal(normalizeExecutionStatus({
    status: 'waiting',
    errorRemark: '调度等待超时',
  }), EXECUTION_STATUS.WAIT_TIMEOUT);
  assert.equal(normalizeExecutionStatus({
    status: 'timeout',
    statusName: '处理超时',
  }), EXECUTION_STATUS.FAILED);
});

test('多实例汇总优先运行中，其次等待中，再取最近终态', () => {
  const terminal = [
    { normalizedStatus: EXECUTION_STATUS.SUCCEEDED, endTime: '2026-07-22T01:00:00.000Z' },
    { normalizedStatus: EXECUTION_STATUS.FAILED, endTime: '2026-07-22T02:00:00.000Z' },
  ];
  assert.equal(aggregateExecutionStatus([]).normalizedStatus, EXECUTION_STATUS.NOT_RUN);
  assert.equal(aggregateExecutionStatus(terminal).normalizedStatus, EXECUTION_STATUS.FAILED);
  assert.equal(aggregateExecutionStatus([
    ...terminal,
    { normalizedStatus: EXECUTION_STATUS.WAITING, triggerTime: '2026-07-22T03:00:00.000Z' },
  ]).normalizedStatus, EXECUTION_STATUS.WAITING);
  assert.equal(aggregateExecutionStatus([
    ...terminal,
    { normalizedStatus: EXECUTION_STATUS.WAITING, triggerTime: '2026-07-22T03:00:00.000Z' },
    { normalizedStatus: EXECUTION_STATUS.RUNNING, triggerTime: '2026-07-22T00:30:00.000Z' },
  ]).normalizedStatus, EXECUTION_STATUS.RUNNING);
});

test('活动与终态判断保持保守', () => {
  assert.equal(isActiveStatus(EXECUTION_STATUS.WAITING), true);
  assert.equal(isActiveStatus(EXECUTION_STATUS.RUNNING), true);
  assert.equal(isActiveStatus(EXECUTION_STATUS.UNKNOWN), true);
  assert.equal(isTerminalStatus(EXECUTION_STATUS.SUCCEEDED), true);
  assert.equal(isTerminalStatus(EXECUTION_STATUS.WAIT_TIMEOUT), true);
  assert.equal(isTerminalStatus(EXECUTION_STATUS.UNKNOWN), false);
});
