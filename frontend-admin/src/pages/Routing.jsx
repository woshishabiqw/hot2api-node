import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Input } from '../components/Input';
import { Activity, Zap, Shield, RefreshCw, Search, Check, X, Clock, TrendingUp, AlertCircle, ChevronDown, Save, Play, Settings } from 'lucide-react';
import { useAdminSSE } from '../hooks/useAdminSSE';

export default function Routing() {
  const [routingStatus, setRoutingStatus] = useState(null);
  const [configStatus, setConfigStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProtocol, setSelectedProtocol] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [selectedSources, setSelectedSources] = useState([]);
  const [expandedSource, setExpandedSource] = useState(null);
  const [routingMode, setRoutingMode] = useState('auto');
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [hotRestarting, setHotRestarting] = useState(false);

  useAdminSSE(['routing.changed'], {
    'routing.changed': () => {
      loadRoutingStatus();
      loadConfigStatus();
    }
  });

  useEffect(() => {
    loadRoutingStatus();
    loadConfigStatus();
    const interval = setInterval(() => {
      loadRoutingStatus();
      loadConfigStatus();
    }, 10000);

    const handleRoutingModeChange = () => {
      loadRoutingStatus();
      loadConfigStatus();
    };
    window.addEventListener('routingModeChanged', handleRoutingModeChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener('routingModeChanged', handleRoutingModeChange);
    };
  }, []);

  const loadRoutingStatus = async () => {
    try {
      const res = await api.get('/admin/routing/status');
      setRoutingStatus(res.data);
      setRoutingMode(res.data?.settings?.mode || 'auto');
    } catch (e) {
      console.error('[Routing] Failed to load status:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadConfigStatus = async () => {
    try {
      const res = await api.get('/admin/routing/config/status');
      setConfigStatus(res.data);
    } catch (e) {
      console.error('[Routing] Failed to load config status:', e);
    }
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const res = await api.post('/admin/routing/config/save');
      await loadConfigStatus();
      alert(`配置已保存为版本 ${res.data.version}`);
    } catch (e) {
      console.error('[Routing] Failed to save config:', e);
      alert('保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleActivateConfig = async (version) => {
    setActivating(true);
    try {
      await api.post('/admin/routing/config/activate', { version });
      await loadConfigStatus();
      alert(`版本 ${version} 已激活`);
    } catch (e) {
      console.error('[Routing] Failed to activate config:', e);
      alert('激活配置失败');
    } finally {
      setActivating(false);
    }
  };

  const handleHotRestart = async () => {
    setHotRestarting(true);
    try {
      const res = await api.post('/admin/routing/config/hot-restart');
      await loadConfigStatus();
      alert(res.data.message);
    } catch (e) {
      console.error('[Routing] Failed to hot restart:', e);
      alert('热重启失败');
    } finally {
      setHotRestarting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (routingMode === 'auto') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-30" />
          <h2 className="text-xl font-semibold mb-2">自动模式</h2>
          <p className="text-muted-foreground">当前为自动路由模式，手动管理功能已禁用</p>
          <p className="text-sm text-muted-foreground mt-2">请切换到手动模式以使用此功能</p>
        </div>
      </div>
    );
  }

  const handleSourceDirect = async (sourceId, enabled) => {
    setUpdating(sourceId);
    try {
      await api.put(`/admin/routing/sources/${sourceId}/status`, { status: enabled ? 'enabled' : 'disabled' });
      await loadRoutingStatus();
    } catch (e) {
      console.error('[Routing] Failed to update source status:', e);
    } finally {
      setUpdating(null);
    }
  };

  const handleRelaySourceChange = async (sourceId, relaySourceId) => {
    setUpdating(sourceId);
    try {
      await api.put(`/admin/routing/sources/${sourceId}/relay-source`, { relaySourceId });
      await loadRoutingStatus();
    } catch (e) {
      console.error('[Routing] Failed to update relay source:', e);
    } finally {
      setUpdating(null);
    }
  };

  const getSourcesByProtocol = (protocol) => {
    if (!routingStatus?.sources) return [];
    return routingStatus.sources.filter(s => s.protocol === protocol);
  };

  const handleBatchDirect = async (enabled) => {
    if (selectedSources.length === 0) return;
    try {
      for (const sourceId of selectedSources) {
        await api.put(`/admin/routing/sources/${sourceId}/status`, { status: enabled ? 'enabled' : 'disabled' });
      }
      setSelectedSources([]);
      await loadRoutingStatus();
    } catch (e) {
      console.error('[Routing] Failed to batch update:', e);
    }
  };

  const toggleSelectAll = () => {
    const filtered = getFilteredSources();
    if (selectedSources.length === filtered.length) {
      setSelectedSources([]);
    } else {
      setSelectedSources(filtered.map(s => s.id));
    }
  };

  const getFilteredSources = () => {
    if (!routingStatus?.sources) return [];
    return routingStatus.sources.filter(source => {
      const matchesSearch = source.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           source.protocol.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesProtocol = selectedProtocol === 'all' || source.protocol === selectedProtocol;
      const matchesStatus = selectedStatus === 'all' || source.direct_status === selectedStatus;
      return matchesSearch && matchesProtocol && matchesStatus;
    });
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'enabled':
        return <Badge variant="success" className="text-xs"><Zap className="w-3 h-3 mr-1" />直通</Badge>;
      case 'disabled':
        return <Badge variant="destructive" className="text-xs"><Shield className="w-3 h-3 mr-1" />中继</Badge>;
      default:
        return <Badge variant="secondary" className="text-xs">{status}</Badge>;
    }
  };

  const protocols = [...new Set(routingStatus?.sources?.map(s => s.protocol) || [])];
  const filteredSources = getFilteredSources();
  const enabledCount = filteredSources.filter(s => s.direct_status === 'enabled').length;
  const disabledCount = filteredSources.filter(s => s.direct_status === 'disabled').length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">源站路由管理</h1>
        <div className="flex items-center gap-2">
          <Button onClick={loadRoutingStatus} variant="outline" size="sm">
            <RefreshCw className="w-4 h-4 mr-2" />
            刷新
          </Button>
        </div>
      </div>

      {/* 配置状态指示 */}
      {configStatus && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              配置状态
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-sm text-muted-foreground">当前版本</div>
                <div className="font-medium">{configStatus.activeVersion || '未设置'}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">总版本数</div>
                <div className="font-medium">{configStatus.totalVersions}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">活跃会话</div>
                <div className="font-medium">{configStatus.sessions?.activeSessions || 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">缓存状态</div>
                <div className="font-medium">{configStatus.cache?.useRedis ? 'Redis' : '内存'}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-4">
              <Button 
                size="sm" 
                onClick={handleSaveConfig}
                disabled={saving}
              >
                <Save className="w-4 h-4 mr-1" />
                {saving ? '保存中...' : '保存配置'}
              </Button>
              <Button 
                size="sm" 
                variant="outline"
                onClick={handleHotRestart}
                disabled={hotRestarting || !configStatus.activeVersion}
              >
                <Play className="w-4 h-4 mr-1" />
                {hotRestarting ? '重启中...' : '热重启'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 实时监控表盘 */}
      <Card>
        <CardHeader>
          <CardTitle>实时监控</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <Zap className="w-5 h-5" />
                <span className="text-sm">直通源站</span>
              </div>
              <div className="text-2xl font-bold truncate mt-2">{enabledCount}</div>
            </div>
            <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                <Shield className="w-5 h-5" />
                <span className="text-sm">中继源站</span>
              </div>
              <div className="text-2xl font-bold truncate mt-2">{disabledCount}</div>
            </div>
            <div className="p-4 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="flex items-center gap-2 text-purple-600 dark:text-purple-400">
                <Activity className="w-5 h-5" />
                <span className="text-sm">总源站数</span>
              </div>
              <div className="text-2xl font-bold truncate mt-2">{filteredSources.length}</div>
            </div>
            <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <TrendingUp className="w-5 h-5" />
                <span className="text-sm">直通率</span>
              </div>
              <div className="text-2xl font-bold truncate mt-2">
                {filteredSources.length > 0 ? Math.round((enabledCount / filteredSources.length) * 100) : 0}%
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 搜索和过滤 */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="搜索源站名称或协议..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <select
              className="flex h-10 w-full md:w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedProtocol}
              onChange={(e) => setSelectedProtocol(e.target.value)}
            >
              <option value="all">所有协议</option>
              {protocols.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select
              className="flex h-10 w-full md:w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
            >
              <option value="all">所有状态</option>
              <option value="enabled">直通</option>
              <option value="disabled">中继</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* 批量操作 */}
      {selectedSources.length > 0 && (
        <Card className="border-primary">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Check className="w-5 h-5 text-primary" />
                <span className="font-medium">已选择 {selectedSources.length} 个源站</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => handleBatchDirect(true)}>
                  <Zap className="w-4 h-4 mr-1" />
                  批量直通
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleBatchDirect(false)}>
                  <Shield className="w-4 h-4 mr-1" />
                  批量中继
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedSources([])}>
                  <X className="w-4 h-4 mr-1" />
                  取消选择
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 源站列表 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>源站列表</CardTitle>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selectedSources.length === filteredSources.length && filteredSources.length > 0}
                onChange={toggleSelectAll}
                className="w-4 h-4"
              />
              <span className="text-sm text-muted-foreground">全选</span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {filteredSources.map(source => {
              const protocolSources = getSourcesByProtocol(source.protocol);
              const hasMultipleSources = protocolSources.length > 1;
              const isExpanded = expandedSource === source.id;

              return (
                <div key={source.id} className="rounded-lg border hover:bg-accent/50 transition-colors">
                  <div className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-4">
                      <input
                        type="checkbox"
                        checked={selectedSources.includes(source.id)}
                        onChange={() => {
                          setSelectedSources(prev =>
                            prev.includes(source.id)
                              ? prev.filter(id => id !== source.id)
                              : [...prev, source.id]
                          );
                        }}
                        className="w-4 h-4"
                      />
                      <div className="flex items-center gap-3">
                        <Activity className="w-5 h-5 text-primary" />
                        <div>
                          <div className="font-medium">{source.name}</div>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs">{source.protocol}</Badge>
                            {getStatusBadge(source.direct_status)}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={updating === source.id}
                        onClick={() => handleSourceDirect(source.id, true)}
                      >
                        <Zap className="w-4 h-4 mr-1" />
                        直通
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updating === source.id}
                        onClick={() => {
                          if (hasMultipleSources) {
                            setExpandedSource(isExpanded ? null : source.id);
                          } else {
                            handleSourceDirect(source.id, false);
                          }
                        }}
                      >
                        <Shield className="w-4 h-4 mr-1" />
                        中继
                        {hasMultipleSources && <ChevronDown className={`w-4 h-4 ml-1 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />}
                      </Button>
                    </div>
                  </div>
                  {isExpanded && hasMultipleSources && (
                    <div className="border-t p-4 bg-accent/30">
                      <div className="text-sm text-muted-foreground mb-3">选择中继源站：</div>
                      <div className="space-y-2">
                        {protocolSources.map(relaySource => (
                          <button
                            key={relaySource.id}
                            onClick={() => handleRelaySourceChange(source.id, relaySource.id)}
                            disabled={updating === source.id}
                            className={`w-full text-left p-3 rounded-lg border transition-colors ${
                              source.relay_source_id === relaySource.id
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'hover:bg-accent'
                            }`}
                          >
                            <div className="font-medium">{relaySource.name}</div>
                            <div className="text-xs opacity-70">{relaySource.protocol}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredSources.length === 0 && (
              <div className="text-center py-10 text-muted-foreground">
                <AlertCircle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>没有找到匹配的源站</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
