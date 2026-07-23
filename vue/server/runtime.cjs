const {
  createYingdaoClient,
  createScheduleDirectory,
  createExecutionDetails,
} = require('./services/yingdaoClient.cjs');
const { createSyncCoordinator } = require('./services/syncCoordinator.cjs');
const { createRetentionService } = require('./services/retentionService.cjs');
const { createTaskMutationService } = require('./services/taskMutationService.cjs');
const { createTaskActionService } = require('./services/taskActionService.cjs');
const { createFeishuClient, createFeishuAuthService } = require('./services/feishuAuthService.cjs');

function appConfig(config, schema) {
  return {
    authMode: config.auth.mode,
    feishuEnabled: config.feishu.enabled,
    feishuAppBaseUrl: config.feishu.appBaseUrl,
    feishuStateTtlSeconds: config.feishu.stateTtlSeconds,
    corsOrigins: config.cors.origins,
    sessionSecret: config.session.secret,
    sessionMaxAgeSeconds: config.session.maxAgeSeconds,
    sessionCookieName: config.session.cookieName,
    sessionTableName: config.session.tableName,
    secureCookies: config.session.secure,
    schemaVersion: schema.currentVersion,
    uiRefreshSeconds: config.uiRefreshSeconds,
    trustProxy: config.isProduction ? 1 : false,
  };
}

function createRuntime({ config, pool, repositories, schema, logger = console }) {
  const feishuAuth = config.feishu.enabled
    ? createFeishuAuthService({
        pool,
        usersRepository: repositories.users,
        client: createFeishuClient({
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          redirectUri: config.feishu.redirectUri,
          authorizationUrl: config.feishu.authorizationUrl,
          apiBaseUrl: config.feishu.apiBaseUrl,
          timeoutMs: config.feishu.requestTimeoutMs,
        }),
        autoProvision: config.feishu.autoProvision,
        allowedTenantKeys: config.feishu.allowedTenantKeys,
      })
    : null;
  const yingdaoClient = createYingdaoClient({
    accessKeyId: config.yingdao.accessKeyId,
    accessKeySecret: config.yingdao.accessKeySecret,
    baseUrl: config.yingdao.baseUrl,
    timeoutMs: config.yingdao.requestTimeoutMs,
    scheduleCacheSeconds: config.yingdao.scheduleCacheSeconds,
    bindCacheMaxAgeSeconds: config.yingdao.bindCacheMaxAgeSeconds,
    jobLogCacheSeconds: config.retention.jobLogCacheSeconds,
    logger,
  });

  const scheduleDirectory = createScheduleDirectory({
    client: yingdaoClient,
    findBinding: (scheduleUuid, context = {}) => repositories.tasks.isScheduleBound(scheduleUuid, {
      excludeTaskId: context.excludeTaskId || context.taskId,
    }),
    listBindings: async (_schedules, filters = {}) => {
      const tasks = await repositories.tasks.listAll(filters.current_user_id || filters.currentUserId);
      return tasks
        .filter(task => task.scheduleUuid)
        .map(task => ({
          scheduleUuid: task.scheduleUuid,
          taskId: task.id,
          taskName: task.task,
          owner: task.owner,
        }));
    },
  });

  const syncCoordinator = createSyncCoordinator({
    client: yingdaoClient,
    tasksRepository: repositories.tasks,
    executionsRepository: repositories.executions,
    syncIntervalMs: config.yingdao.syncIntervalSeconds * 1000,
    historyDays: config.retention.executionDays,
    logger,
  });

  const retentionService = createRetentionService({
    executionsRepository: repositories.executions,
    retentionDays: config.retention.executionDays,
    logger,
  });

  const taskMutation = createTaskMutationService({ pool, scheduleDirectory });
  const taskActions = createTaskActionService({
    pool,
    scheduleDirectory,
    yingdaoClient,
    pollingCoordinator: syncCoordinator,
    syncCoordinator,
    runRequestsRepository: repositories.runRequests,
    logger,
  });
  const executionDetails = createExecutionDetails({
    client: yingdaoClient,
    executionsRepository: repositories.executions,
  });

  return {
    appConfig: appConfig(config, schema),
    services: {
      yingdaoClient,
      scheduleDirectory,
      syncCoordinator,
      retentionService,
      taskMutation,
      taskActions,
      executionDetails,
      feishuAuth,
    },
    startBackground() {
      taskActions.start();
      syncCoordinator.start();
      retentionService.start();
    },
    stopBackground() {
      taskActions.stop();
      syncCoordinator.stop();
      retentionService.stop();
    },
  };
}

module.exports = { appConfig, createRuntime };
