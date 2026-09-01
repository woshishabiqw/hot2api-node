const express = require('express');
const router = express.Router();
const db = require('../config/database');
const dispatcher = require('../services/dispatcher');
const proxyGemini = require('../services/proxy-gemini');

function parseGeminiAction(reqParam) {
  const match = reqParam.match(/^(.+?):(generateContent|streamGenerateContent|countTokens)$/);
  if (!match) return null;
  return { model: match[1], action: match[2] };
}

function buildProtocolError(modelName, requestedProtocol, availableProtocols) {
  const protocolNames = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', bedrock: 'Bedrock' };
  const available = availableProtocols.map(p => protocolNames[p] || p).join('、');
  return {
    error: {
      message: `【协议未开通】该模型不支持 ${protocolNames[requestedProtocol] || requestedProtocol} 协议。\n请使用已开通的协议进行对话：${available}\n\n提示：如果你配置的是 Gemini 客户端，请将 Base URL 改为 http://your-host/v1beta`,
      type: 'protocol_not_supported',
      available_protocols: availableProtocols,
      requested_protocol: requestedProtocol,
      hint: `Available protocols for ${modelName}: ${available}`
    }
  };
}

async function getModelProtocols(modelName) {
  const sources = await db.all(`
    SELECT DISTINCT s.protocol
    FROM models m
    JOIN sources s ON m.source_id = s.id
    WHERE m.model_id = ? AND m.is_active = true AND s.is_active = true
  `, [modelName]);
  return sources.map(s => s.protocol);
}

// Gemini-compatible model list
router.get('/models', async (req, res) => {
  try {
    const models = await db.all(`
      SELECT m.*, s.name as source_name, s.protocol
      FROM models m
      JOIN sources s ON m.source_id = s.id
      WHERE m.is_active = true AND s.is_active = true
      ORDER BY m.model_id
    `);

    const geminiModels = models.map(m => {
      const modelId = m.model_id;
      return {
        name: `models/${modelId}`,
        version: '001',
        displayName: m.model_alias || modelId,
        description: m.description || `${modelId} via ${m.source_name}`,
        inputTokenLimit: m.max_tokens || 128000,
        outputTokenLimit: m.max_tokens || 8192,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      };
    });

    res.json({ models: geminiModels });
  } catch (error) {
    console.error('[gemini] listModels error:', error);
    res.status(500).json({ error: { message: (error?.message || 'Upstream connection failed'), code: 500 } });
  }
});

// Single model info
router.get('/models/*', async (req, res) => {
  try {
    const raw = req.params[0];
    const modelName = raw.replace(/^models\//, '');
    const model = await db.get(`
      SELECT m.*, s.name as source_name
      FROM models m
      JOIN sources s ON m.source_id = s.id
      WHERE m.model_id = ? AND m.is_active = true AND s.is_active = true
    `, [modelName]);

    if (!model) {
      return res.status(404).json({
        error: { message: `Model ${modelName} not found`, code: 404 }
      });
    }

    res.json({
      name: `models/${model.model_id}`,
      version: '001',
      displayName: model.model_alias || model.model_id,
      description: model.description || `${model.model_id} via ${model.source_name}`,
      inputTokenLimit: model.max_tokens || 128000,
      outputTokenLimit: model.max_tokens || 8192,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    });
  } catch (error) {
    console.error('[gemini] getModel error:', error);
    res.status(500).json({ error: { message: (error?.message || 'Upstream connection failed'), code: 500 } });
  }
});

// All Gemini actions (generateContent, streamGenerateContent, countTokens)
router.post('/models/*', async (req, res, next) => {
  try {
    const raw = req.params[0];
    const parsed = parseGeminiAction(raw);

    if (!parsed) {
      return res.status(404).json({ error: { message: 'Invalid Gemini action path', code: 404 } });
    }

    const { model: modelName, action } = parsed;

    if (action === 'countTokens') {
      try {
        const source = await dispatcher.selectSource(modelName, 'gemini');
        if (!source || source.protocol !== 'gemini') {
          const protocols = await getModelProtocols(modelName);
          if (protocols.length === 0) {
            return res.status(404).json({ error: { message: `Model ${modelName} not found`, type: 'model_not_found' } });
          }
          return res.status(501).json(buildProtocolError(modelName, 'gemini', protocols));
        }

        const apiKey = db.getApiKey(source, 'gemini');
        const modelInfo = await db.get('SELECT source_model_id FROM models WHERE model_id = ? AND source_id = ? AND is_active = true', [modelName, source.id]);
        const upstreamModel = modelInfo?.source_model_id || modelName;
        const geminiModel = upstreamModel.replace('gemini/', '');
        const endpoint = `${db.getApiUrl(source, 'gemini')}/v1beta/models/${geminiModel}:countTokens?key=${apiKey}`;

        const axios = require('axios');
        const response = await axios.post(endpoint, req.body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });
        res.json(response.data);
      } catch (error) {
        const statusCode = error.response?.status || 500;
        const message = error.response?.data?.error?.message || error?.message;
        res.status(statusCode).json({ error: { message, code: statusCode } });
      }
      return;
    }

    // generateContent / streamGenerateContent
    const startTime = Date.now();
    const source = await dispatcher.selectSource(modelName, 'gemini');

    if (!source) {
      const protocols = await getModelProtocols(modelName);
      if (protocols.length === 0) {
        return res.status(404).json({ error: { message: `Model ${modelName} not found`, type: 'model_not_found' } });
      }
      // Fallback: convert Gemini → OpenAI and route to any available source
      const fallbackSource = await dispatcher.selectSource(modelName);
      if (fallbackSource) {
        const isStream = action === 'streamGenerateContent';
        console.log(`[gemini] Fallback: Gemini client → ${fallbackSource.protocol} source for ${modelName}, stream=${isStream}`);
        return proxyGemini.proxyGeminiClient(req, res, modelName, isStream);
      }
      return res.status(501).json(buildProtocolError(modelName, 'gemini', protocols));
    }

    if (source.protocol === 'gemini') {
      const isStream = action === 'streamGenerateContent';
      return proxyGemini.geminiPassthrough(req, res, source, startTime, modelName, isStream, 'gemini');
    }

    // Source exists but is not Gemini protocol → convert
    const isStream = action === 'streamGenerateContent';
    console.log(`[gemini] Convert: Gemini client → ${source.protocol} source for ${modelName}, stream=${isStream}`);
    return proxyGemini.proxyGeminiClient(req, res, modelName, isStream);
  } catch (err) {
    console.error('[gemini] Unexpected error in POST /models/*:', err?.message || err);
    next(err);
  }
});

module.exports = router;
