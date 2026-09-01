/**
 * Enforce the billing PIN (second-auth) on mutating admin routes while leaving
 * read-only GET/HEAD/OPTIONS requests unrestricted.
 */
const { secondAuthMiddleware } = require('./second-auth');

function requireSecondAuthForMutations(req, res, next) {
  // Read-only operations should not require the PIN so the UI can load data
  // before the admin completes the SecondAuthGate challenge.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  return secondAuthMiddleware(req, res, next);
}

module.exports = requireSecondAuthForMutations;
