const { logger } = require('@librechat/data-schemas');

/**
 * Logs HTTP status (and duration) for API and OAuth routes when the response finishes.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function logApiResponse(req, res, next) {
  const pathname = req.path || '';
  if (!pathname.startsWith('/api') && !pathname.startsWith('/oauth')) {
    return next();
  }

  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const path = req.originalUrl || req.path || '';
    const { statusCode } = res;
    const line = `${req.method} ${path} ${statusCode} ${ms}ms`;
    const meta = {
      msg: 'http_request',
      method: req.method,
      path,
      status: statusCode,
      ms,
    };
    if (statusCode >= 400) {
      logger.error(line, meta);
    } else {
      logger.info(line, meta);
    }
  });
  next();
}

module.exports = logApiResponse;
