import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Input } from '../components/Input';
import { showConfirm } from '../components/Dialog';
import { HardDrive, RefreshCw, Trash2, Search, Zap, AlertTriangle, Wifi, WifiOff } from 'lucide-react';

export default function CacheManagement() {
  const [status, setStatus] = useState(null);
  const [keys, setKeys] = useState([]);
  const [pattern, setPattern] = useState('admin:*');
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    loadStatus();
    loadKeys();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const loadStatus = async () => {
    try {
      const res = await api.get('/admin/cache/status');
      setStatus(res.data);
    } catch (e) {
      console.error('[CacheManagement] Failed to load status:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadKeys = async () => {
    try {
      const res = await api.get('/admin/cache/keys', { params: { pattern, limit } });
      setKeys(res.data.keys || []);
    } catch (e) {
      console.error('[CacheManagement] Failed to load keys:', e);
    }
  };

  const handleInvalidateTag = async (tag) => {
    setActionLoading(true);
    try {
      const res = await api.post('/admin/cache/invalidate', { tags: [tag] });
      showMessage(`已失效标签 "${tag}"，清理 ${res.data.deleted} 个 key`);
      await loadStatus();
      await loadKeys();
    } catch (e) {
      showMessage('失效失败：' + (e.response?.data?.error || e.message), 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleInvalidatePattern = async () => {
    if (!pattern) return;
    const ok = await showConfirm(`确定按模式 "${pattern}" 清理缓存吗？匹配到的 key 将被立即删除。`, 'warning');
    if (!ok) return;
    setActionLoading(true);
    try {
      const res = await api.post('/admin/cache/invalidate', { patterns: [pattern] });
      showMessage(`已按模式 "${pattern}" 清理 ${res.data.deleted} 个 key`);
      await loadStatus();
      await loadKeys();
    } catch (e) {
      showMessage('清理失败：' + (e.response?.data?.error || e.message), 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteKey = async (key) => {
    const ok = await showConfirm(`确定删除 key "${key}" 吗？`);
    if (!ok) return;
    setActionLoading(true);
    try {
      await api.post('/admin/cache/invalidate', { keys: [key] });
      showMessage(`已删除 ${key}`);
      await loadStatus();
      await loadKeys();
    } catch (e) {
      showMessage('删除失败：' + (e.response?.data?.error || e.message), 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleFlush = async () => {
    const ok = await showConfirm('警告：这将清空所有被跟踪的业务缓存（包括仪表盘、路由、模型信息等），但会保留限流/会话计数。确定继续吗？', 'warning');
    if (!ok) return;
    setActionLoading(true);
    try {
      const res = await api.post('/admin/cache/flush', { confirm: true });
      showMessage(`已清空 ${res.data.deleted} 个缓存 key`);
      await loadStatus();
      await loadKeys();
    } catch (e) {
      showMessage('清空失败：' + (e.response?.data?.error || e.message), 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReconnect = async () => {
    setActionLoading(true);
    try {
      await api.post('/admin/cache/reconnect');
      showMessage('Redis 重连已触发');
      await loadStatus();
    } catch (e) {
      showMessage('重连失败：' + (e.response?.data?.error || e.message), 'error');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">缓存管理</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => { loadStatus(); loadKeys(); }} variant="outline" size="sm">
            <RefreshCw className="w-4 h-4 mr-2" />
            刷新
          </Button>
          <Button onClick={handleReconnect} variant="outline" size="sm" disabled={actionLoading}>
            <Wifi className="w-4 h-4 mr-2" />
            重连 Redis
          </Button>
        </div>
      </div>

      {message && (
        <div className={`p-3 rounded-lg text-sm ${message.type === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-600'}`}>
          {message.text}
        </div>
      )}

      {/* 状态卡片 */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Redis 状态</CardTitle>
            {status?.redisHealthy ? <Wifi className="w-4 h-4 text-emerald-500" /> : <WifiOff className="w-4 h-4 text-red-500" />}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status?.redisHealthy ? '正常' : '降级'}</div>
            <p className="text-xs text-muted-foreground">{status?.useRedis ? '使用 Redis' : '使用内存缓存'}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">内存缓存 Key</CardTitle>
            <HardDrive className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status?.memoryCacheSize || 0}</div>
            <p className="text-xs text-muted-foreground">内存回退中的条目数</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">已跟踪标签</CardTitle>
            <Zap className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{status?.tags?.length || 0}</div>
            <p className="text-xs text-muted-foreground">带标签的业务缓存分组</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">危险操作</CardTitle>
            <AlertTriangle className="w-4 h-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <Button variant="destructive" size="sm" onClick={handleFlush} disabled={actionLoading} className="w-full">
              <Trash2 className="w-4 h-4 mr-2" />
              清空全部缓存
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* 标签分布 */}
      <Card>
        <CardHeader>
          <CardTitle>标签分布</CardTitle>
        </CardHeader>
        <CardContent>
          {status?.tags?.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">标签 / 命名空间</th>
                    <th className="text-left p-2">Key 数量</th>
                    <th className="text-right p-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {status.tags.map((tag) => (
                    <tr key={tag.tag} className="border-b">
                      <td className="p-2">
                        <Badge variant="secondary">{tag.tag}</Badge>
                      </td>
                      <td className="p-2">{tag.count}</td>
                      <td className="p-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleInvalidateTag(tag.tag)}
                          disabled={actionLoading}
                        >
                          失效该标签
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground">暂无带标签的业务缓存</p>
          )}
        </CardContent>
      </Card>

      {/* 模式清理与 Key 浏览 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5" />
            Key 浏览与模式清理
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground block mb-1">Pattern</label>
              <Input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="例如 admin:* 或 available_sources:*"
              />
            </div>
            <div className="w-24">
              <label className="text-xs text-muted-foreground block mb-1">Limit</label>
              <Input
                type="number"
                min={1}
                max={1000}
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value) || 50)}
              />
            </div>
            <Button onClick={loadKeys} variant="outline" disabled={actionLoading}>
              <Search className="w-4 h-4 mr-2" />
              查询
            </Button>
            <Button onClick={handleInvalidatePattern} variant="destructive" disabled={actionLoading}>
              <Trash2 className="w-4 h-4 mr-2" />
              清理该模式
            </Button>
          </div>

          {keys.length > 0 ? (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left p-2">Key</th>
                    <th className="text-left p-2">TTL（秒）</th>
                    <th className="text-right p-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.key} className="border-t">
                      <td className="p-2 font-mono text-xs break-all">{k.key}</td>
                      <td className="p-2 whitespace-nowrap">
                        {k.ttl >= 0 ? k.ttl : (k.ttl === -1 ? '永久' : '不存在')}
                      </td>
                      <td className="p-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => handleDeleteKey(k.key)} disabled={actionLoading}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground">未匹配到 key</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
