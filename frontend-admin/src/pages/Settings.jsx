import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { Plus, Trash2, Check, X, Copy, RefreshCw } from 'lucide-react';
import { showAlert, showConfirm } from '../components/Dialog';

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [gatewayUrls, setGatewayUrls] = useState([]);
  const [newUrl, setNewUrl] = useState('');
  const [newUrlName, setNewUrlName] = useState('');
  const [newUrlType, setNewUrlType] = useState('node');
  const [showAddUrl, setShowAddUrl] = useState(false);
  const [copied, setCopied] = useState(null);

  // Gateway URLs are the API base URLs used by Keys/callers.
  // Access ports for the admin/user portals are managed by /config/server.json.
  const buildDefaultGatewayUrls = (cfg) => {
    const ports = cfg?.ports || {};
    return [
      { name: 'Node.js API', url: `http://localhost:${ports.api ?? 3000}`, type: 'node', active: true },
    ];
  };

  const [serverConfig, setServerConfig] = useState(null);
  const [serverConfigSaving, setServerConfigSaving] = useState(false);
  const [serverConfigMessage, setServerConfigMessage] = useState('');
  const [gatewayStatus, setGatewayStatus] = useState(null);
  const [gatewayStatusLoading, setGatewayStatusLoading] = useState(false);
  const [apiStatusRefreshing, setApiStatusRefreshing] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    let urls = [];
    try {
      const parsed = JSON.parse(settings.gateway_urls || '[]');
      urls = Array.isArray(parsed) ? parsed : [];
    } catch {
      if (settings.gateway_url) {
        urls = [{ name: '默认', url: settings.gateway_url, type: 'node', active: true }];
      }
    }
    setGatewayUrls(urls);
  }, [settings.gateway_urls, settings.gateway_url]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [settingsRes, serverCfgRes] = await Promise.all([
        api.get('/admin/settings'),
        api.get('/admin/server-config')
      ]);
      let loadedSettings = settingsRes.data || {};
      const loadedServerConfig = serverCfgRes.data || {};

      // Seed default gateway URLs if none exist, and migrate legacy portal URLs.
      let gatewayUrlsValue = loadedSettings.gateway_urls;
      let parsedUrls = [];
      try {
        parsedUrls = JSON.parse(gatewayUrlsValue || '[]');
        if (!Array.isArray(parsedUrls)) parsedUrls = [];
      } catch {
        parsedUrls = [];
      }

      // Drop legacy nginx entries and seed defaults if none exist.
      const filteredUrls = parsedUrls.filter(u => u.type !== 'nginx');
      if (filteredUrls.length !== parsedUrls.length) {
        const migratedValue = JSON.stringify(filteredUrls);
        await api.put('/admin/settings', { key: 'gateway_urls', value: migratedValue });
        loadedSettings.gateway_urls = migratedValue;
      } else if (parsedUrls.length === 0 && Object.keys(loadedServerConfig).length > 0) {
        const defaults = buildDefaultGatewayUrls(loadedServerConfig);
        const defaultValue = JSON.stringify(defaults);
        await api.put('/admin/settings', { key: 'gateway_urls', value: defaultValue });
        loadedSettings.gateway_urls = defaultValue;
      }

      setSettings(loadedSettings);
      setServerConfig(loadedServerConfig);
    } finally {
      setLoading(false);
    }
  };

  const loadGatewayStatus = async () => {
    setGatewayStatusLoading(true);
    try {
      const res = await api.get('/admin/gateway-status');
      setGatewayStatus(res.data);
    } catch (err) {
      // Ignore probe errors.
    } finally {
      setGatewayStatusLoading(false);
    }
  };

  const refreshApiStatus = async () => {
    if (apiStatusRefreshing || gatewayStatusLoading) return;
    setApiStatusRefreshing(true);
    const delay = 1000 + Math.floor(Math.random() * 2000);
    await new Promise(resolve => setTimeout(resolve, delay));
    await loadGatewayStatus();
    setApiStatusRefreshing(false);
  };

  useEffect(() => {
    loadGatewayStatus();
    const interval = setInterval(() => {
      loadGatewayStatus();
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const updateSetting = async (key, value) => {
    try {
      await api.put('/admin/settings', { key, value });
      setSettings({ ...settings, [key]: value });
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const updateServerConfigPath = (path, value) => {
    setServerConfig(prev => {
      const next = { ...prev };
      const keys = path.split('.');
      let cur = next;
      for (let i = 0; i < keys.length - 1; i++) {
        cur[keys[i]] = { ...cur[keys[i]] };
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
      return next;
    });
    setServerConfigMessage('');
  };

  const saveServerConfig = async () => {
    setServerConfigSaving(true);
    setServerConfigMessage('');
    try {
      const payload = {
        ports: {
          api: Number(serverConfig.ports?.api),
          admin: Number(serverConfig.ports?.admin),
          user: Number(serverConfig.ports?.user),
        }
      };
      const res = await api.put('/admin/server-config', payload);
      setServerConfig(res.data.config);
      const parts = [];
      if (res.data.restart_required) parts.push('Node.js 端口有变更，需重启后端服务后生效');
      else parts.push('端口配置已保存');
      setServerConfigMessage(parts.join('；'));
    } catch (err) {
      showAlert(err.response?.data?.error || '保存端口配置失败');
    } finally {
      setServerConfigSaving(false);
    }
  };

  const saveGatewayUrls = async (urls) => {
    setGatewayUrls(urls);
    await updateSetting('gateway_urls', JSON.stringify(urls));
  };

  const addGatewayUrl = async () => {
    if (!newUrl.trim()) return;
    const updated = [...gatewayUrls, { name: newUrlName || `节点${gatewayUrls.length + 1}`, url: newUrl.trim(), type: newUrlType, active: true }];
    await saveGatewayUrls(updated);
    setNewUrl('');
    setNewUrlName('');
    setNewUrlType('node');
    setShowAddUrl(false);
  };

  const removeGatewayUrl = async (index) => {
    if (gatewayUrls.length <= 1) {
      showAlert('至少保留一个网关地址');
      return;
    }
    const updated = gatewayUrls.filter((_, i) => i !== index);
    await saveGatewayUrls(updated);
  };

  const toggleUrlActive = async (index) => {
    const updated = gatewayUrls.map((u, i) => i === index ? { ...u, active: !u.active } : u);
    await saveGatewayUrls(updated);
  };

  const copyUrl = (url) => {
    navigator.clipboard.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(null), 2000);
  };

  const getUrlStatus = (url) => {
    if (!gatewayStatus) return null;
    const found = gatewayStatus.urls?.find(u => u.url === url);
    if (!found) return null;
    if (found.active === false || found.skipped) {
      return { ok: false, text: '已禁用', disabled: true };
    }
    return found.ok ? { ok: true, text: `可达 (HTTP ${found.status})` } : { ok: false, text: found.status ? `异常 (HTTP ${found.status})` : '不可达' };
  };

  if (loading) {
    return <div className="text-center py-10">加载中...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">系统设置</h1>

      <Card>
        <CardHeader>
          <CardTitle>系统配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4">
            <div className="p-4 border rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-medium">网关地址</div>
                  <div className="text-sm text-muted-foreground">
                    配置 Key 调用的 API 接口地址（Node.js 直连）
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={loadGatewayStatus} disabled={gatewayStatusLoading}>
                    {gatewayStatusLoading ? '检测中…' : '检测'}
                  </Button>
                  <Button size="sm" onClick={() => setShowAddUrl(!showAddUrl)}>
                    <Plus className="w-3 h-3 mr-1" />
                    添加
                  </Button>
                </div>
              </div>

              {['node'].map(type => (
                <div key={type} className="mb-3">
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    Node.js API 接口
                  </div>
                  <div className="space-y-2">
                    {gatewayUrls.filter(u => u.type === type || !u.type).map((item, index) => {
                      const realIndex = gatewayUrls.indexOf(item);
                      const status = getUrlStatus(item.url);
                      return (
                        <div key={realIndex} className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
                          <Badge variant={item.active ? 'success' : 'secondary'} className="text-xs shrink-0">
                            {item.active ? '启用' : '禁用'}
                          </Badge>
                          <span className="text-sm font-medium shrink-0 w-24">{item.name}</span>
                          <code className="text-xs flex-1 truncate">{item.url}</code>
                          {status && (
                            <Badge variant={status.ok ? 'success' : status.disabled ? 'secondary' : 'destructive'} className="text-xs shrink-0">
                              {status.text}
                            </Badge>
                          )}
                          <button
                            onClick={() => copyUrl(item.url)}
                            className="p-1 hover:bg-accent rounded"
                            title="复制"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                          <Button
                            size="sm"
                            variant={item.active ? 'outline' : 'secondary'}
                            className="h-6 px-2 text-xs"
                            onClick={() => toggleUrlActive(realIndex)}
                          >
                            {item.active ? '禁用' : '启用'}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 w-6 p-0"
                            onClick={() => removeGatewayUrl(realIndex)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {showAddUrl && (
                <div className="mt-3 flex items-center gap-2">
                  <select
                    value={newUrlType}
                    onChange={(e) => setNewUrlType(e.target.value)}
                    className="h-8 rounded border bg-background px-2 text-xs"
                  >
                    <option value="node">Node</option>
                  </select>
                  <Input
                    value={newUrlName}
                    onChange={(e) => setNewUrlName(e.target.value)}
                    placeholder="名称"
                    className="w-24 h-8 text-xs"
                  />
                  <Input
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="http://localhost:3000"
                    className="flex-1 h-8 text-xs"
                  />
                  <Button size="sm" className="h-8" onClick={addGatewayUrl}>
                    <Check className="w-3 h-3" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => { setShowAddUrl(false); setNewUrl(''); setNewUrlName(''); setNewUrlType('node'); }}>
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              )}

              {copied && (
                <div className="text-xs text-green-600 mt-2">已复制到剪贴板</div>
              )}

            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <div className="font-medium">默认分发策略</div>
                <div className="text-sm text-muted-foreground">
                  Key分发策略
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="flex h-10 w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={settings.dispatch_strategy || 'round_robin'}
                  onChange={(e) => updateSetting('dispatch_strategy', e.target.value)}
                >
                  <option value="round_robin">轮询</option>
                  <option value="random">随机</option>
                  <option value="weight">权重</option>
                  <option value="failover">故障转移</option>
                  <option value="least_used">最少使用</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <div className="font-medium">日志级别</div>
                <div className="text-sm text-muted-foreground">
                  日志详细程度
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="flex h-10 w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={settings.log_level || 'info'}
                  onChange={(e) => updateSetting('log_level', e.target.value)}
                >
                  <option value="debug">调试</option>
                  <option value="info">信息</option>
                  <option value="warn">警告</option>
                  <option value="error">错误</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <div className="font-medium">默认币种</div>
                <div className="text-sm text-muted-foreground">
                  系统默认货币单位
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="flex h-10 w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={settings.currency || 'CNY'}
                  onChange={(e) => updateSetting('currency', e.target.value)}
                >
                  <option value="CNY">CNY (元)</option>
                  <option value="USD">USD ($)</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <div className="font-medium">汇率 (CNY to USD)</div>
                <div className="text-sm text-muted-foreground">
                  1 USD = ? CNY
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={settings.exchange_rate || '7.25'}
                  onChange={(e) => setSettings({ ...settings, exchange_rate: e.target.value })}
                  className="w-32"
                  step="0.01"
                />
                <Button onClick={() => updateSetting('exchange_rate', settings.exchange_rate)}>
                  保存
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>前台横幅</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div>
              <div className="font-medium">启用横幅</div>
              <div className="text-sm text-muted-foreground">
                在用户前台顶部显示滚动横幅
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                className="flex h-10 w-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={settings.banner_enabled || 'false'}
                onChange={(e) => {
                  setSettings({ ...settings, banner_enabled: e.target.value });
                  updateSetting('banner_enabled', e.target.value);
                }}
              >
                <option value="false">禁用</option>
                <option value="true">启用</option>
              </select>
            </div>
          </div>
          <div className="p-4 border rounded-lg space-y-3">
            <div>
              <div className="font-medium">横幅内容</div>
              <div className="text-sm text-muted-foreground">
                支持多行文本，将在用户前台顶部横向滚动显示
              </div>
            </div>
            <textarea
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={settings.banner_text || ''}
              onChange={(e) => setSettings({ ...settings, banner_text: e.target.value })}
              placeholder="输入横幅内容，例如：系统维护通知、新功能公告等"
            />
            <Button onClick={() => updateSetting('banner_text', settings.banner_text)}>
              保存横幅内容
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>服务端口</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!serverConfig ? (
            <div className="text-sm text-muted-foreground">加载端口配置中...</div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Node.js API 端口</label>
                  <Input
                    type="number"
                    min="1"
                    max="65535"
                    value={serverConfig.ports?.api ?? ''}
                    onChange={(e) => updateServerConfigPath('ports.api', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Node.js Admin 端口</label>
                  <Input
                    type="number"
                    min="1"
                    max="65535"
                    value={serverConfig.ports?.admin ?? ''}
                    onChange={(e) => updateServerConfigPath('ports.admin', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Node.js User 端口</label>
                  <Input
                    type="number"
                    min="1"
                    max="65535"
                    value={serverConfig.ports?.user ?? ''}
                    onChange={(e) => updateServerConfigPath('ports.user', e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button onClick={saveServerConfig} disabled={serverConfigSaving}>
                  {serverConfigSaving ? '保存中...' : '保存端口配置'}
                </Button>
                {serverConfigMessage && (
                  <span className={`text-xs ${serverConfigMessage.includes('失败') ? 'text-red-500' : 'text-green-600'}`}>
                    {serverConfigMessage}
                  </span>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Node.js 端口变更需要重启后端服务才能生效。
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>API接口</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={refreshApiStatus}
              disabled={apiStatusRefreshing || gatewayStatusLoading}
            >
              {apiStatusRefreshing ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              立即刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {gatewayUrls.filter(u => u.active).map((item, index) => {
              const status = gatewayStatus?.urls?.find(u => u.url === item.url)?.apiStatus;
              return (
                <div key={index} className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline" className="text-xs">{item.name}</Badge>
                    <span className="text-sm text-muted-foreground">{item.url}</span>
                  </div>
                  <div className="space-y-1">
                    <code className="text-xs bg-muted px-2 py-1 rounded flex items-center justify-between">
                      <span>POST {item.url}/v1/chat/completions</span>
                      {status && (
                        <Badge variant={status.ok ? 'success' : 'destructive'} className="text-[10px]">
                          {status.ok
                            ? `正常 ${status.latencyMs}ms`
                            : status.status
                              ? `异常 ${status.status}`
                              : '不可达'}
                        </Badge>
                      )}
                    </code>
                    <code className="text-xs bg-muted px-2 py-1 rounded block">
                      POST {item.url}/v1/messages
                    </code>
                    <code className="text-xs bg-muted px-2 py-1 rounded block">
                      GET {item.url}/v1/models
                    </code>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}

