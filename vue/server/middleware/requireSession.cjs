const { AuthenticationError } = require('../errors.cjs');

function requireSession(usersRepository) {
  return function requireValidSession(req, _res, next) {
    const userId = req.session && (req.session.userId || req.session.user_id);
    if (!userId) return next(new AuthenticationError());
    Promise.resolve(usersRepository.findActiveById(String(userId)))
      .then(user => {
        if (!user) return next(new AuthenticationError('登录已失效，请重新登录'));
        req.userId = String(user.id);
        req.currentUser = user;
        req.actor = Object.freeze({
          userId: String(user.id),
          isAdmin: Boolean(user.isAdmin ?? user.is_admin),
        });
        next();
      })
      .catch(next);
  };
}

module.exports = { requireSession };
