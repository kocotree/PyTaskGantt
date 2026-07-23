const { AuthorizationError } = require('../errors.cjs');

function requireAllowedOrigin(allowedOrigins = []) {
  const allowed = new Set(allowedOrigins);
  const allowAny = allowed.has('*');
  return function checkOrigin(req, _res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || allowAny || allowed.has(origin)) return next();
    next(new AuthorizationError('请求来源不在允许列表中'));
  };
}

module.exports = { requireAllowedOrigin };
