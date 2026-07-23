const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { AppError, AuthenticationError, NotFoundError, ValidationError } = require('../errors.cjs');
const { presentUser } = require('../presenters.cjs');

const switchSchema = z.object({
  user_id: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
});

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session) return resolve();
    req.session.destroy(error => error ? reject(error) : resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

function sessionPayload(config, user = null) {
  return {
    authenticated: Boolean(user),
    user: presentUser(user, { includeAdmin: true }),
    auth_mode: config.authMode,
    feishu_enabled: Boolean(config.feishuEnabled),
    ui_refresh_seconds: config.uiRefreshSeconds,
  };
}

function safeRedirectPath(value, fallback = '/schedule') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.length > 1000 || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

function stateMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function frontendUrl(config, path, errorMessage = '') {
  const url = new URL(safeRedirectPath(path, '/login'), `${config.feishuAppBaseUrl}/`);
  if (errorMessage) url.searchParams.set('error', errorMessage);
  return url.toString();
}

function callbackErrorMessage(error) {
  return error instanceof AppError ? error.message : '飞书登录失败，请稍后重试';
}

function createAuthRouter({ config, usersRepository, feishuAuth = null, logger = console }) {
  const router = express.Router();

  router.get('/session', asyncHandler(async (req, res) => {
    const userId = req.session && (req.session.userId || req.session.user_id);
    if (!userId) {
      return res.json(sessionPayload(config));
    }
    const user = await usersRepository.findActiveById(String(userId));
    if (!user) {
      await destroySession(req);
      return res.json(sessionPayload(config));
    }
    res.json(sessionPayload(config, user));
  }));

  router.get('/dev/users', asyncHandler(async (_req, res) => {
    if (config.authMode !== 'dev') throw new NotFoundError('开发用户切换未启用');
    const listUsers = usersRepository.listActiveDevUsers || usersRepository.listActive;
    res.json({ users: (await listUsers()).map(presentUser) });
  }));

  router.post('/dev/switch', asyncHandler(async (req, res) => {
    if (config.authMode !== 'dev') throw new NotFoundError('开发用户切换未启用');
    const parsed = switchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('请选择有效用户', parsed.error.flatten());
    const user = await usersRepository.findActiveDevById(parsed.data.user_id);
    if (!user) throw new ValidationError('用户不存在或已停用');
    await regenerateSession(req);
    req.session.userId = String(user.id);
    await usersRepository.touchLastLogin(String(user.id));
    res.json(sessionPayload(config, user));
  }));

  router.get('/feishu/start', asyncHandler(async (req, res) => {
    if (!config.feishuEnabled || !feishuAuth) throw new NotFoundError('飞书登录未启用');
    const intent = req.query.intent === 'bind' ? 'bind' : 'login';
    const currentUserId = req.session && (req.session.userId || req.session.user_id);
    if (intent === 'bind' && !currentUserId) throw new AuthenticationError('请先登录后再绑定飞书');
    if (intent === 'bind' && !(await usersRepository.findActiveById(String(currentUserId)))) {
      throw new AuthenticationError('当前会话用户不存在或已停用');
    }

    const state = crypto.randomBytes(32).toString('base64url');
    req.session.feishuOAuth = {
      state,
      intent,
      bindUserId: intent === 'bind' ? String(currentUserId) : null,
      redirect: safeRedirectPath(req.query.redirect),
      expiresAt: Date.now() + Number(config.feishuStateTtlSeconds || 600) * 1000,
    };
    await saveSession(req);
    res.redirect(302, feishuAuth.createAuthorizationUrl({ state }));
  }));

  router.get('/feishu/callback', async (req, res) => {
    if (!config.feishuEnabled || !feishuAuth) return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '飞书登录未启用' },
    });

    try {
      const flow = req.session && req.session.feishuOAuth;
      if (!flow || !stateMatches(flow.state, req.query.state)) {
        throw new ValidationError('飞书登录状态已失效，请重新发起登录');
      }
      delete req.session.feishuOAuth;
      await saveSession(req);
      if (!Number.isFinite(Number(flow.expiresAt)) || Date.now() > Number(flow.expiresAt)) {
        throw new ValidationError('飞书登录已超时，请重新发起登录');
      }
      if (typeof req.query.code !== 'string' || !req.query.code) {
        throw new ValidationError('未获得飞书授权，请重新登录');
      }

      const user = await feishuAuth.completeAuthorization({
        code: req.query.code,
        bindUserId: flow.intent === 'bind' ? flow.bindUserId : null,
      });
      if (!user || !user.isActive) throw new AuthenticationError('当前用户不存在或已停用');
      await regenerateSession(req);
      req.session.userId = String(user.id);
      await saveSession(req);
      return res.redirect(303, frontendUrl(config, safeRedirectPath(flow.redirect)));
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('飞书登录回调失败', {
          code: error && error.code,
          message: callbackErrorMessage(error),
        });
      }
      return res.redirect(303, frontendUrl(config, '/login', callbackErrorMessage(error)));
    }
  });

  router.post('/logout', asyncHandler(async (req, res) => {
    await destroySession(req);
    res.clearCookie(config.sessionCookieName || 'pytaskgantt.sid');
    res.json({ success: true });
  }));

  return router;
}

module.exports = { createAuthRouter };
