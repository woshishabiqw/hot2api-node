/**
 * Admin endpoints for managing the web chat portal configuration.
 */

const express = require('express');
const router = express.Router();
const { getConfig, setConfig } = require('../../services/webChatConfig');
const { testSearch } = require('../../services/webSearchTester');

/**
 * GET /admin/webchat/config
 * Return the current web chat configuration (including secrets; admin only).
 */
router.get('/config', async (req, res) => {
  try {
    const config = await getConfig();
    res.json({ success: true, config });
  } catch (err) {
    console.error('[admin/webchat] Failed to get config:', err?.message);
    res.status(500).json({ error: err.message || '获取配置失败' });
  }
});

/**
 * PUT /admin/webchat/config
 * Update one or more web chat configuration values.
 */
router.put('/config', async (req, res) => {
  try {
    await setConfig(req.body || {});
    const config = await getConfig();
    res.json({ success: true, config });
  } catch (err) {
    console.error('[admin/webchat] Failed to set config:', err?.message);
    res.status(400).json({ error: err.message || '保存配置失败' });
  }
});

/**
 * POST /admin/webchat/test-search
 * Execute a single probe query against the configured search provider.
 */
router.post('/test-search', async (req, res) => {
  try {
    const result = await testSearch(req.body || {});
    res.json({ success: result.ok, result });
  } catch (err) {
    console.error('[admin/webchat] Test search failed:', err?.message);
    res.status(400).json({ success: false, error: err.message || '测试失败' });
  }
});

module.exports = router;
