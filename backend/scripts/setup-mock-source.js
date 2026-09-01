const db = require('../src/config/database');

(async () => {
  try {
    let sources = await db.all("SELECT id, name FROM sources WHERE name = 'mock-local'");
    let sourceId;
    if (sources.length === 0) {
      await db.run(
        `INSERT INTO sources (name, base_url, protocol, api_key, weight, is_active, max_concurrent, status, source_group, stack_mode, api_keys, api_urls, direct_status)
         VALUES ('mock-local', 'http://127.0.0.1:9999/v1', 'openai', 'mock-key', 1, true, 10000, 'valid', 'mock', 'merged', '{}', '{}', 'enabled')`
      );
      sources = await db.all("SELECT id, name FROM sources WHERE name = 'mock-local'");
    }
    sourceId = sources[0].id;
    console.log('mock source id:', sourceId);

    let models = await db.all("SELECT id FROM models WHERE model_id = 'mock-mimo' AND source_id = ?", [sourceId]);
    if (models.length === 0) {
      await db.run(
        `INSERT INTO models (source_id, model_id, source_model_id, model_alias, input_price, input_price_cache, output_price, max_tokens, is_active, priority, supports_tools, supports_json, max_concurrent, model_group, rate_multiplier)
         VALUES (?, 'mock-mimo', 'mock-mimo', 'mock-mimo', 0.1, 0.1, 0.1, 4096, true, 0, true, true, 10000, ?, 1)`,
        [sourceId, JSON.stringify(['default'])]
      );
      console.log('mock model created');
    } else {
      console.log('mock model already exists');
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
