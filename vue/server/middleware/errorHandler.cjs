const { AppError, databaseError } = require('../errors.cjs');

function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `未找到接口：${req.method} ${req.path}` },
  });
}

function errorHandler(logger = console) {
  return function handleError(rawError, req, res, _next) {
    const error = databaseError(rawError);
    const serviceStatus = Number(error && error.statusCode);
    const isYingdaoError = error && error.name === 'YingdaoApiError';
    const yingdaoStatus = isYingdaoError && Number(error.status) === 404 ? 404 : 502;
    const status = error instanceof AppError
      ? error.status
      : serviceStatus >= 400 && serviceStatus <= 599 ? serviceStatus
        : isYingdaoError ? yingdaoStatus : 500;
    const code = error instanceof AppError
      ? error.code
      : isYingdaoError ? 'YINGDAO_UPSTREAM_ERROR'
        : status < 500 && error && error.code ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof AppError || status < 500 || isYingdaoError
      ? error.message
      : '服务器内部错误';

    if (status >= 500) {
      logger.error('请求处理失败', {
        method: req.method,
        path: req.path,
        code: rawError && rawError.code,
        message: rawError && rawError.message,
      });
    }

    const body = { error: { code, message } };
    if (error instanceof AppError && error.details !== undefined) {
      body.error.details = error.details;
    }
    res.status(status).json(body);
  };
}

module.exports = { notFoundHandler, errorHandler };
