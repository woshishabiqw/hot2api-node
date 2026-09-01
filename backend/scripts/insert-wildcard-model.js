const db = require('../src/config/database');

(async () => {
  try {
    // Check if wildcard model already exists for source 1
    const existing = await db.get("SELECT * FROM models WHERE (model_id = '*' OR model_alias = '*') AND source_id = 1");
    if (existing) {
      console.log('Wildcard model already exists for source 1:', existing);
    } else {
      await db.run(
        `INSERT INTO models (model_id, model_alias, source_id, source_model_id, input_price, output_price, is_vision, supports_tools, supports_json, supports_fim, model_group)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['*', '*', 1, '*', 0, 0, false, true, true, false, 'default']
      );
      console.log('Inserted wildcard model for source 1 (cs)');
    }

    const existing2 = await db.get("SELECT * FROM models WHERE (model_id = '*' OR model_alias = '*') AND source_id = 2");
    if (existing2) {
      console.log('Wildcard model already exists for source 2:', existing2);
    } else {
      await db.run(
        `INSERT INTO models (model_id, model_alias, source_id, source_model_id, input_price, output_price, is_vision, supports_tools, supports_json, supports_fim, model_group)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['*', '*', 2, '*', 0, 0, false, true, true, false, 'default']
      );
      console.log('Inserted wildcard model for source 2 (mimo-1.0)');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
