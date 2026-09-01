const express = require('express');
const router = express.Router();
const proxyService = require('../services/proxy');

router.post('/chat/completions', async (req, res) => {
  try {
    await proxyService.proxyChat(req, res, 'openai');
  } catch (error) {
    console.error('[routes/openai] proxyChat error:', error?.message);
    console.error('[routes/openai] proxyChat stack:', error?.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: (error?.message || 'Upstream connection failed'), type: 'proxy_error', code: 500 } });
    } else {
      try { res.end(); } catch (e) {}
    }
  }
});

router.post('/completions', async (req, res) => {
  try {
    await proxyService.proxyCompletions(req, res);
  } catch (error) {
    console.error('[routes/openai] proxyCompletions error:', error?.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: (error?.message || 'Upstream connection failed'), type: 'proxy_error', code: 500 } });
    } else {
      try { res.end(); } catch (e) {}
    }
  }
});

router.get('/models', async (req, res) => {
  proxyService.listModels(req, res);
});

router.post('/embeddings', async (req, res) => {
  res.status(501).json({ error: 'Embeddings not implemented yet' });
});

router.post('/images/generations', async (req, res) => {
  proxyService.proxyImage(req, res);
});

router.post('/audio/speech', async (req, res) => {
  proxyService.proxyTTS(req, res);
});

module.exports = router;
