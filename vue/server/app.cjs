const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { createAuthRouter } = require('./routes/auth.cjs');
const { createTasksRouter } = require('./routes/tasks.cjs');
const { createImportsRouter } = require('./routes/imports.cjs');
const { createYingdaoRouter } = require('./routes/yingdao.cjs');
const { AuthorizationError } = require('./errors.cjs');
const { requireSession } = require('./middleware/requireSession.cjs');
const { requireAllowedOrigin } = require('./middleware/requireAllowedOrigin.cjs');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler.cjs');

function createCorsOptions(config) {
  const origins = config.corsOrigins || ['*'];
  const allowAny = origins.includes('*');
  return {
    origin(origin, callback) {
      if (!origin || allowAny || origins.includes(origin)) return callback(null, true);
      callback(new AuthorizationError('请求来源不在允许列表中'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'X-Requested-With'],
  };
}

function createDefaultSessionStore(pool, tableName = 'app_sessions') {
  const PgStore = connectPgSimple(session);
  return new PgStore({ pool, tableName, createTableIfMissing: false });
}

function createApp({
  config,
  pool,
  repositories,
  services,
  sessionStore,
  staticDir,
  logger = console,
}) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(cors(createCorsOptions(config)));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.get('/api/health', async (_req, res, next) => {
    try {
      if (repositories.healthCheck) await repositories.healthCheck();
      res.json({ status: 'ok', storage: 'postgres', schema_version: config.schemaVersion });
    } catch (error) {
      next(error);
    }
  });

  app.use(session({
    name: config.sessionCookieName || 'pytaskgantt.sid',
    secret: config.sessionSecret,
    store: sessionStore || createDefaultSessionStore(pool, config.sessionTableName),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: Boolean(config.secureCookies),
      maxAge: config.sessionMaxAgeSeconds * 1000,
    },
  }));

  app.use('/api/auth', requireAllowedOrigin(config.corsOrigins || ['*']));
  app.use('/api/auth', createAuthRouter({ config, usersRepository: repositories.users }));
  app.use('/api', requireAllowedOrigin(config.corsOrigins || ['*']), requireSession(repositories.users));
  app.use('/api', createTasksRouter({
    usersRepository: repositories.users,
    tasksRepository: repositories.tasks,
    taskMutationService: services.taskMutation,
    taskActionService: services.taskActions,
    syncCoordinator: services.syncCoordinator,
  }));
  app.use('/api', createImportsRouter({
    tasksRepository: repositories.tasks,
    taskMutationService: services.taskMutation,
  }));
  app.use('/api', createYingdaoRouter({
    scheduleDirectory: services.scheduleDirectory,
    executionDetails: services.executionDetails,
  }));

  app.use('/api', notFoundHandler);

  const resolvedStaticDir = staticDir && path.resolve(staticDir);
  if (resolvedStaticDir && fs.existsSync(resolvedStaticDir)) {
    app.use(express.static(resolvedStaticDir));
    app.get('/*splat', (req, res) => res.sendFile(path.join(resolvedStaticDir, 'index.html')));
  }

  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp, createCorsOptions };
