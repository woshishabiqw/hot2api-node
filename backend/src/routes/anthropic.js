const express = require('express');
const router = express.Router();
const proxyService = require('../services/proxy');

router.post('/messages', async (req, res) => {
  try {
    await proxyService.proxyChat(req, res, 'anthropic');
  } catch (error) {
    console.error('[routes/anthropic] proxyChat error:', error?.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: (error?.message || 'Upstream connection failed'), type: 'proxy_error', code: 500 } });
    } else {
      try { res.end(); } catch (e) {}
    }
  }
});

module.exports = router;
