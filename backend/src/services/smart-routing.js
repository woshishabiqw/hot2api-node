const db = require('../config/database');
const probeService = require('./probe');

class SmartRoutingService {
  constructor() {
    this.enabled = false;
    this.checkTimers = new Map(); // sourceId -> timer
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('[SmartRouting] Started');
    this.scheduleChecks();
  }

  async stop() {
    this.running = false;
    for (const timer of this.checkTimers.values()) {
      clearTimeout(timer);
    }
    this.checkTimers.clear();
    console.log('[SmartRouting] Stopped');
  }

  async getRoutingMode() {
    const setting = await db.get("SELECT value FROM settings WHERE key = 'routing_mode'");
    return setting?.value || 'auto';
  }

  async getSetting(key, defaultValue) {
    const setting = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return setting ? setting.value : defaultValue;
  }

  async getCheckInterval(status) {
    const intervalKey = `direct_check_interval_${status}`;
    const raw = await this.getSetting(intervalKey, '15');
    const minutes = parseInt(raw, 10);
    if (Number.isNaN(minutes) || minutes <= 0) {
      console.warn(`[SmartRouting] Invalid interval for ${intervalKey}: "${raw}", falling back to 15min`);
      return 15 * 60 * 1000;
    }
    return minutes * 60 * 1000;
  }

  async scheduleChecks() {
    if (!this.running) return;

    const mode = await this.getRoutingMode();
    if (mode !== 'auto') {
      await this.stop();
      return;
    }

    const sources = await db.all('SELECT id, protocol, direct_status, direct_disabled_until FROM sources WHERE is_active = true');
    for (const source of sources) {
      this.scheduleSourceCheck({ ...source, direct_status: source.direct_status || 'enabled' });
    }
  }

  async scheduleSourceCheck(source) {
    const timer = this.checkTimers.get(source.id);
    if (timer) clearTimeout(timer);

    const interval = await this.getCheckInterval(source.direct_status || 'enabled');
    const nextCheck = () => {
      this.checkSource(source).catch(err => {
        console.error('[SmartRouting] checkSource error:', err.message);
      });
      this.scheduleSourceCheck(source).catch(err => {
        console.error('[SmartRouting] scheduleSourceCheck error:', err.message);
      });
    };

    this.checkTimers.set(source.id, setTimeout(nextCheck, interval));
  }

  async checkSource(source) {
    const mode = await this.getRoutingMode();
    if (mode !== 'auto') return;

    const now = new Date().toISOString();
    const protocol = source.protocol || 'openai';

    // 检查是否在禁用期内
    if (source.direct_disabled_until) {
      const disabledUntil = new Date(source.direct_disabled_until);
      if (new Date() < disabledUntil) {
        console.log(`[SmartRouting] Source ${source.id} is disabled until ${disabledUntil.toISOString()}`);
        return;
      }
    }

    // 获取探针延迟数据
    const probeData = probeService.getResults();
    const sourceProbe = probeData[source.id];
    if (!sourceProbe || !sourceProbe[protocol]) {
      console.log(`[SmartRouting] No probe data for source ${source.id} protocol ${protocol}`);
      return;
    }

    const latency = sourceProbe[protocol].latencyMs;
    const status = sourceProbe[protocol].status;

    // 更新直通延迟（安全更新，列不存在则跳过）
    try {
      await db.run(
        'UPDATE sources SET direct_latency_ms = ?, direct_last_check = ? WHERE id = ?',
        [latency, now, source.id]
      );
    } catch (e) {
      console.log('[SmartRouting] Columns not yet migrated, skipping update');
    }

    // 判断是否需要禁用直通
    const shouldDisable = await this.shouldDisableDirect(source, protocol, latency);

    if (shouldDisable) {
      await this.disableDirect(source, protocol);
    } else if (status === 'ok') {
      await this.enableDirect(source, protocol);
    } else {
      await this.markDirectFailed(source, protocol);
    }
  }

  async shouldDisableDirect(source, protocol, latency) {
    const multiplier = parseFloat(await this.getSetting('direct_latency_multiplier', '2'));
    const threshold = parseInt(await this.getSetting('direct_latency_threshold_ms', '300'));

    // 获取所有协议的延迟
    const probeData = probeService.getResults();
    const allLatencies = [];

    for (const [sourceId, sourceProbe] of Object.entries(probeData)) {
      for (const [proto, data] of Object.entries(sourceProbe)) {
        if (data.status === 'ok' && data.latencyMs > 0) {
          allLatencies.push(data.latencyMs);
        }
      }
    }

    if (allLatencies.length === 0) return false;

    const minLatency = Math.min(...allLatencies);
    const dynamicThreshold = Math.max(threshold, minLatency * multiplier);

    return latency > dynamicThreshold;
  }

  async disableDirect(source, protocol) {
    const hours = parseInt(await this.getSetting('direct_disable_duration_hours', '24'));
    const disabledUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

    try {
      await db.run(
        `UPDATE sources SET direct_status = 'disabled', direct_disabled_until = ?, direct_fail_count = direct_fail_count + 1, direct_flap_count = direct_flap_count + 1 WHERE id = ?`,
        [disabledUntil, source.id]
      );
      console.log(`[SmartRouting] Disabled direct for source ${source.id} until ${disabledUntil}`);
    } catch (e) {
      console.log('[SmartRouting] Columns not yet migrated, skipping disable');
    }
  }

  async enableDirect(source, protocol) {
    try {
      await db.run(
        `UPDATE sources SET direct_status = 'enabled', direct_disabled_until = NULL, direct_success_count = direct_success_count + 1 WHERE id = ?`,
        [source.id]
      );
      console.log(`[SmartRouting] Enabled direct for source ${source.id}`);
    } catch (e) {
      console.log('[SmartRouting] Columns not yet migrated, skipping enable');
    }
  }

  async markDirectFailed(source, protocol) {
    try {
      await db.run(
        `UPDATE sources SET direct_status = 'pending', direct_fail_count = direct_fail_count + 1 WHERE id = ?`,
        [source.id]
      );
      console.log(`[SmartRouting] Marked direct as pending for source ${source.id}`);
    } catch (e) {
      console.log('[SmartRouting] Columns not yet migrated, skipping mark failed');
    }
  }

  async getRoutingStatus() {
    // 使用基础查询，避免列不存在错误
    const sources = await db.all(`
      SELECT id, name, protocol
      FROM sources WHERE is_active = true
    `);

    // 尝试获取智能路由相关数据
    const sourcesWithDefaults = await Promise.all(sources.map(async (s) => {
      try {
        const routingData = await db.get(`
          SELECT direct_status, direct_disabled_until, direct_latency_ms, 
                 direct_last_check, direct_fail_count, direct_success_count, direct_flap_count, relay_source_id
          FROM sources WHERE id = ?
        `, [s.id]);
        
        return {
          ...s,
          direct_status: routingData?.direct_status || 'enabled',
          direct_disabled_until: routingData?.direct_disabled_until || null,
          direct_latency_ms: routingData?.direct_latency_ms || null,
          direct_last_check: routingData?.direct_last_check || null,
          direct_fail_count: routingData?.direct_fail_count || 0,
          direct_success_count: routingData?.direct_success_count || 0,
          direct_flap_count: routingData?.direct_flap_count || 0,
          relay_source_id: routingData?.relay_source_id || null
        };
      } catch (e) {
        // 如果列不存在，返回默认值
        return {
          ...s,
          direct_status: 'enabled',
          direct_disabled_until: null,
          direct_latency_ms: null,
          direct_last_check: null,
          direct_fail_count: 0,
          direct_success_count: 0,
          direct_flap_count: 0,
          relay_source_id: null
        };
      }
    }));

    const mode = await this.getRoutingMode();
    const settings = {
      mode,
      latencyMultiplier: await this.getSetting('direct_latency_multiplier', '2'),
      latencyThreshold: await this.getSetting('direct_latency_threshold_ms', '300'),
      disableDuration: await this.getSetting('direct_disable_duration_hours', '24'),
      strategy: await this.getSetting('routing_strategy', 'balanced')
    };

    return { sources: sourcesWithDefaults, settings };
  }

  async setRoutingMode(mode) {
    const existing = await db.get("SELECT value FROM settings WHERE key = 'routing_mode'");
    if (existing) {
      await db.run("UPDATE settings SET value = ? WHERE key = 'routing_mode'", [mode]);
    } else {
      await db.run("INSERT INTO settings (key, value) VALUES ('routing_mode', ?)", [mode]);
    }

    if (mode === 'auto') {
      await this.start();
    } else {
      await this.stop();
    }

    console.log(`[SmartRouting] Routing mode set to ${mode}`);
  }

  async updateSourceDirectStatus(sourceId, status) {
    await db.run('UPDATE sources SET direct_status = ? WHERE id = ?', [status, sourceId]);
    console.log(`[SmartRouting] Manual update: source ${sourceId} direct_status = ${status}`);
  }
}

module.exports = new SmartRoutingService();
