const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { NotFoundError, ValidationError } = require('../errors.cjs');
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

function createAuthRouter({ config, usersRepository }) {
  const router = express.Router();

  router.get('/session', asyncHandler(async (req, res) => {
    const userId = req.session && (req.session.userId || req.session.user_id);
    if (!userId) {
      return res.json({
        authenticated: false,
        user: null,
        auth_mode: config.authMode,
        ui_refresh_seconds: config.uiRefreshSeconds,
      });
    }
    const user = await usersRepository.findActiveById(String(userId));
    if (!user) {
      await destroySession(req);
      return res.json({
        authenticated: false,
        user: null,
        auth_mode: config.authMode,
        ui_refresh_seconds: config.uiRefreshSeconds,
      });
    }
    res.json({
      authenticated: true,
      user: presentUser(user),
      auth_mode: config.authMode,
      ui_refresh_seconds: config.uiRefreshSeconds,
    });
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
    res.json({
      authenticated: true,
      user: presentUser(user),
      auth_mode: config.authMode,
      ui_refresh_seconds: config.uiRefreshSeconds,
    });
  }));

  router.post('/logout', asyncHandler(async (req, res) => {
    await destroySession(req);
    res.clearCookie(config.sessionCookieName || 'pytaskgantt.sid');
    res.json({ success: true });
  }));

  return router;
}

module.exports = { createAuthRouter };
