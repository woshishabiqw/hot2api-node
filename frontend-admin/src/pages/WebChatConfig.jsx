import { useEffect, useState, useCallback } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import {
  Save, RefreshCw, Globe, Brain, Bot, Search, AlertCircle, CheckCircle,
  Play, Terminal, Loader2
} from 'lucide-react';
import { cn } from '../lib/utils';

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className={cn(
      "fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-in slide-in-from-right",
      type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
    )}>
      {type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
      {message}
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100">×</button>
    </div>
  );
}

const PROVIDERS = [
  { value: 'none', label: '关闭联网搜索' },
  { value: 'searxng', label: 'SearXNG' },
  { value: 'bing', label: 'Bing Search' },
  { value: 'bocha', label: '博查 Bocha' },
  { value: 'metaso', label: '秘塔搜索 Metaso' },
  { value: 'uapi', label: 'UAPI 智能搜索' },
  { value: 'baidu_suggest', label: '百度下拉词' },
  { value: 'sogou_suggest', label: '搜狗下拉词' },
  { value: 'custom', label: '自定义接口' },
];

const PRESET_DEFAULTS = {
  bocha: { search_endpoint: 'https://api.bocha.cn/v1/web-search', search_method: 'POST', search_query_param: 'query' },
  metaso: { search_endpoint: 'https://metaso.cn/api/v1/search', search_method: 'POST', search_query_param: 'q' },
  uapi: { search_endpoint: 'https://uapis.cn/api/v1/search/aggregate', search_method: 'POST', search_query_param: 'query' },
  baidu_suggest: { search_endpoint: 'https://www.baidu.com/sugrec?ie=utf-8&json=1&prod=pc', search_method: 'GET', search_query_param: 'wd' },
  sogou_suggest: { search_endpoint: 'https://www.sogou.com/suggnew/ajajjson?type=web', search_method: 'GET', search_query_param: 'key' },
  custom: { search_endpoint: '', search_method: 'POST', search_query_param: 'query' },
};

const NEEDS_KEY_PROVIDERS = ['bocha', 'metaso', 'custom'];

export default function WebChatConfig() {
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const [testQuery, setTestQuery] = useState('人工智能');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const showToast = (msg, type = 'success') => setToast({ message: msg, type });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, modelsRes] = await Promise.all([
        api.get('/admin/webchat/config'),
        api.get('/admin/models'),
      ]);
      setConfig(cfgRes.data?.config || {});
      const allModels = modelsRes.data || [];
      setModels(allModels.filter(m => m.is_active !== false));
    } catch (err) {
      showToast(err.response?.data?.error || '加载配置失败', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateField = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleProviderChange = (provider) => {
    setConfig(prev => {
      const next = { ...prev, search_provider: provider };
      const preset = PRESET_DEFAULTS[provider];
      if (preset) {
        next.search_endpoint = preset.search_endpoint;
        next.search_method = preset.search_method;
        next.search_query_param = preset.search_query_param;
      }
      if (provider === 'bing') {
        next.bing_endpoint = next.bing_endpoint || 'https://api.bing.microsoft.com/v7.0/search';
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const payload = {
        search_provider: config.search_provider,
        searxng_url: config.searxng_url,
        bing_api_key: config.bing_api_key,
        bing_endpoint: config.bing_endpoint,
        search_api_key: config.search_api_key,
        search_endpoint: config.search_endpoint,
        search_method: config.search_method,
        search_query_param: config.search_query_param,
        default_model: config.default_model,
        reasoning_default: !!config.reasoning_default,
        search_max_steps: Number(config.search_max_steps),
        search_enabled: !!config.search_enabled,
      };
      const res = await api.put('/admin/webchat/config', payload);
      setConfig(res.data?.config || config);
      showToast('保存成功');
    } catch (err) {
      showToast(err.response?.data?.error || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!config || config.search_provider === 'none') {
      showToast('请先选择一个搜索提供商', 'error');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post('/admin/webchat/test-search', { query: testQuery || '人工智能' });
      setTestResult(res.data?.result || res.data);
    } catch (err) {
      showToast(err.response?.data?.error || '测试失败', 'error');
    } finally {
      setTesting(false);
    }
  };

  const activeProvider = config?.search_provider || 'none';
  const showGenericFields = ['bocha', 'metaso', 'uapi', 'baidu_suggest', 'sogou_suggest', 'custom'].includes(activeProvider);
  const showBingFields = activeProvider === 'bing';
  const showSearxngFields = activeProvider === 'searxng';
  const showKeyField = ['searxng', 'bing', 'bocha', 'metaso', 'custom'].includes(activeProvider);

  return (
    <div className="space-y-5 max-w-4xl">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">网页聊天配置</h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理用户网页聊天的默认模型、思考开关与联网搜索参数
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={loadData} disabled={loading}>
            <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
            刷新
          </Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            <Save className="w-4 h-4 mr-2" />
            {saving ? '保存中…' : '保存配置'}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Bot className="w-5 h-5" />
            默认聊天行为
          </CardTitle>
          <CardDescription>控制新会话的默认模型与思考模式</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-2">
            <label className="text-sm font-medium">默认模型</label>
            <select
              value={config?.default_model || ''}
              onChange={e => updateField('default_model', e.target.value)}
              disabled={loading}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">未指定</option>
              {models.map(m => (
                <option key={m.id} value={m.model_id}>
                  {m.model_alias || m.model_id}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              留空时网页聊天将使用用户前端的内置默认模型。
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex items-start gap-3">
              <Brain className="w-5 h-5 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-sm font-medium">默认开启思考模式</p>
                <p className="text-xs text-muted-foreground">新会话创建时是否默认启用模型思考</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => updateField('reasoning_default', !config?.reasoning_default)}
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                config?.reasoning_default ? 'bg-primary' : 'bg-input'
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
                  config?.reasoning_default ? 'translate-x-6' : 'translate-x-1'
                )}
              />
            </button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Globe className="w-5 h-5" />
            联网搜索
          </CardTitle>
          <CardDescription>配置网页聊天可用的搜索后端</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex items-start gap-3">
              <Globe className="w-5 h-5 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-sm font-medium">启用联网搜索</p>
                <p className="text-xs text-muted-foreground">关闭后用户网页聊天的搜索按钮将完全隐藏</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => updateField('search_enabled', !config?.search_enabled)}
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                config?.search_enabled ? 'bg-primary' : 'bg-input'
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
                  config?.search_enabled ? 'translate-x-6' : 'translate-x-1'
                )}
              />
            </button>
          </div>

          {!config?.search_enabled && (
            <Badge variant="secondary" className="text-xs">前台搜索按钮已隐藏</Badge>
          )}

          <div className="grid gap-2">
            <label className="text-sm font-medium">搜索提供商</label>
            <select
              value={activeProvider}
              onChange={e => handleProviderChange(e.target.value)}
              disabled={loading}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {PROVIDERS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {showSearxngFields && (
            <div className="grid gap-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Search className="w-4 h-4" />
                SearXNG 地址
              </label>
              <Input
                placeholder="https://searx.example.com"
                value={config?.searxng_url || ''}
                onChange={e => updateField('searxng_url', e.target.value)}
                disabled={loading}
              />
            </div>
          )}

          {showBingFields && (
            <>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Bing API Key</label>
                <Input
                  type="password"
                  placeholder="请输入 Bing Search API Key"
                  value={config?.bing_api_key || ''}
                  onChange={e => updateField('bing_api_key', e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Bing Endpoint</label>
                <Input
                  placeholder="https://api.bing.microsoft.com/v7.0/search"
                  value={config?.bing_endpoint || ''}
                  onChange={e => updateField('bing_endpoint', e.target.value)}
                  disabled={loading}
                />
              </div>
            </>
          )}

          {showGenericFields && (
            <>
              {showKeyField && (
                <div className="grid gap-2">
                  <label className="text-sm font-medium">API Key</label>
                  <Input
                    type="password"
                    placeholder={activeProvider === 'custom' ? '如需要请填写' : '请输入 API Key'}
                    value={config?.search_api_key || ''}
                    onChange={e => updateField('search_api_key', e.target.value)}
                    disabled={loading}
                  />
                </div>
              )}
              <div className="grid gap-2">
                <label className="text-sm font-medium">Endpoint</label>
                <Input
                  placeholder="https://api.example.com/search"
                  value={config?.search_endpoint || ''}
                  onChange={e => updateField('search_endpoint', e.target.value)}
                  disabled={loading || activeProvider !== 'custom'}
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">请求方式</label>
                <select
                  value={config?.search_method || 'POST'}
                  onChange={e => updateField('search_method', e.target.value)}
                  disabled={loading || activeProvider !== 'custom'}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">查询参数名</label>
                <Input
                  placeholder="query / q / wd / key"
                  value={config?.search_query_param || ''}
                  onChange={e => updateField('search_query_param', e.target.value)}
                  disabled={loading || activeProvider !== 'custom'}
                />
              </div>
            </>
          )}

          <div className="grid gap-2">
            <label className="text-sm font-medium">最大搜索步数</label>
            <Input
              type="number"
              min={1}
              max={10}
              value={config?.search_max_steps ?? 3}
              onChange={e => updateField('search_max_steps', e.target.value)}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">多轮搜索/反思时的上限，建议 1-5。</p>
          </div>

          {activeProvider === 'none' && (
            <Badge variant="secondary" className="text-xs">已关闭联网搜索</Badge>
          )}

          {activeProvider !== 'none' && (
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Terminal className="w-4 h-4" />
                连接测试
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  placeholder="测试关键词"
                  value={testQuery}
                  onChange={e => setTestQuery(e.target.value)}
                  disabled={testing}
                  className="sm:flex-1"
                />
                <Button variant="secondary" onClick={handleTest} disabled={testing || loading}>
                  {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                  测试搜索
                </Button>
              </div>
              {testResult && (
                <div className={cn(
                  "rounded-md p-3 text-xs overflow-auto max-h-80",
                  testResult.ok ? 'bg-muted' : 'bg-red-50 text-red-900 border border-red-200'
                )}>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={testResult.ok ? 'success' : 'destructive'}>
                      {testResult.ok ? '成功' : '失败'}
                    </Badge>
                    <span className="text-muted-foreground">{testResult.latency_ms} ms</span>
                  </div>
                  {testResult.error ? (
                    <div className="space-y-1">
                      <p><strong>错误：</strong>{testResult.error}</p>
                      {testResult.status && <p><strong>HTTP：</strong>{testResult.status}</p>}
                      {testResult.response && (
                        <pre className="mt-2 p-2 bg-white/50 rounded">{JSON.stringify(testResult.response, null, 2)}</pre>
                      )}
                    </div>
                  ) : (
                    <>
                      <p className="mb-2"><strong>查询：</strong>{testResult.query}</p>
                      <p className="mb-2"><strong>预览：</strong></p>
                      <pre className="p-2 bg-white/50 rounded">{JSON.stringify(testResult.preview, null, 2)}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || loading}>
          <Save className="w-4 h-4 mr-2" />
          {saving ? '保存中…' : '保存配置'}
        </Button>
      </div>
    </div>
  );
}
