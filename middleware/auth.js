const crypto = require('crypto');

function safeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function authMiddleware(env) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match || !safeEquals(match[1].trim(), env.apiToken)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    return next();
  };
}

module.exports = { authMiddleware };