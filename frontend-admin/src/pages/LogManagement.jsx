import { useEffect, useState, useCallback } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { Search, RotateCcw, Trash2, Save, AlertTriangle, Database, Users, Settings2, ShieldCheck } from 'lucide-react';

const PAGE_SIZE = 20;

export default function LogManagement() {
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState({ default_log_retention_limit: 100000, transit_scan_enabled: true });
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState(null);
  const [editing, setEditing] = useState({});

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 3000);
  };

  const loadStats = useCallback(async () => {
    try {
      const [statsRes, settingsRes] = await Promise.all([
        api.get('/admin/log-management/stats'),
        api.get('/admin/log-management/settings')
      ]);
      setStats(statsRes.data);
      setSettings({
        default_log_retention_limit: settingsRes.data.default_log_retention_limit ?? 100000,
        transit_scan_enabled: settingsRes.data.transit_scan_enabled ?? true
      });
    } catch (e) {
      console.error('Failed to load log management stats:', e);
      showMessage('加载统计失败', 'error');
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/log-management/users', {
        params: { page, pageSize: PAGE_SIZE, search }
      });
      setUsers(res.data.users || []);
      setTotalPages(res.data.totalPages || 1);
    } catch (e) {
      console.error('Failed to load users:', e);
      showMessage('加载用户列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    loadUsers();
  };

  const updateDefaultLimit = async () => {
    try {
      await api.put('/admin/log-management/settings', {
        default_log_retention_limit: settings.default_log_retention_limit
      });
      showMessage('默认保留条数已保存');
      loadStats();
      loadUsers();
    } catch (e) {
      showMessage(e.response?.data?.error || '保存失败', 'error');
    }
  };

  const updateTransitScanEnabled = async (enabled) => {
    try {
      await api.put('/admin/log-management/settings', {
        transit_scan_enabled: enabled
      });
      setSettings(s => ({ ...s, transit_scan_enabled: enabled }));
      showMessage(`链路检测已${enabled ? '开启' : '关闭'}`);
    } catch (e) {
      showMessage(e.response?.data?.error || '保存失败', 'error');
    }
  };

  const updateUserLimit = async (userId) => {
    const limit = editing[userId];
    if (limit == null) return;
    try {
      await api.put(`/admin/log-management/users/${userId}/retention`, {
        log_retention_limit: Number(limit)
      });
      showMessage('用户保留条数已保存');
      setEditing(prev => { const n = { ...prev }; delete n[userId]; return n; });
      loadUsers();
    } catch (e) {
      showMessage(e.response?.data?.error || '保存失败', 'error');
    }
  };

  const trimUser = async (userId) => {
    if (!confirm('确定要清理该用户超出的历史日志吗？此操作不可恢复。')) return;
    try {
      const res = await api.post(`/admin/log-management/users/${userId}/trim`);
      showMessage(`已清理 ${res.data.deleted} 条日志`);
      loadStats();
      loadUsers();
    } catch (e) {
      showMessage(e.response?.data?.error || '清理失败', 'error');
    }
  };

  const trimAll = async () => {
    if (!confirm('确定要全局清理所有用户超出的历史日志吗？此操作将在后台执行。')) return;
    try {
      await api.post('/admin/log-management/trim-all');
      showMessage('全局清理已在后台启动');
    } catch (e) {
      showMessage(e.response?.data?.error || '启动失败', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">日志管理系统</h1>
        {message && (
          <div className={`px-4 py-2 rounded-md text-sm ${message.type === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'}`}>
            {message.text}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Database className="w-8 h-8 text-primary" />
            <div>
              <div className="text-2xl font-bold">{(stats?.total_logs || 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">总请求日志</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Users className="w-8 h-8 text-primary" />
            <div>
              <div className="text-2xl font-bold">{(stats?.total_users || 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">总用户</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-destructive" />
            <div>
              <div className="text-2xl font-bold">{(stats?.users_over_limit || 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">超出限制用户</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Settings2 className="w-8 h-8 text-primary" />
            <div>
              <div className="text-2xl font-bold">{(stats?.default_limit || 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">默认保留条数</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Default limit */}
      <Card>
        <CardHeader>
          <CardTitle>默认保留策略</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            每个用户的用量明细默认最多保留指定条数；超过后，最旧的历史记录会被自动删除（覆盖历史）。
          </p>
          <div className="flex items-center gap-3">
            <label className="text-sm whitespace-nowrap">默认保留条数</label>
            <Input
              type="number"
              min={1}
              className="w-40"
              value={settings.default_log_retention_limit}
              onChange={(e) => setSettings(s => ({ ...s, default_log_retention_limit: e.target.value }))}
            />
            <Button size="sm" onClick={updateDefaultLimit}>
              <Save className="w-4 h-4 mr-1" />
              保存
            </Button>
            <Button size="sm" variant="destructive" onClick={trimAll}>
              <Trash2 className="w-4 h-4 mr-1" />
              立即全局清理
            </Button>
            <Button size="sm" variant="outline" onClick={() => { loadStats(); loadUsers(); }}>
              <RotateCcw className="w-4 h-4 mr-1" />
              刷新
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Link detection toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            链路检测
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            开启后，每次请求/响应内容会经过安全扫描，命中恶意特征时记录到链路检测日志并嵌入 Token 日志。关闭后不再生成新的链路检测记录。
          </p>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center cursor-pointer gap-3">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={settings.transit_scan_enabled}
                onChange={(e) => updateTransitScanEnabled(e.target.checked)}
              />
              <div className="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
              <span className="text-sm font-medium">
                {settings.transit_scan_enabled ? '已开启' : '已关闭'}
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Users table */}
      <Card>
        <CardHeader>
          <CardTitle>用户用量明细</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSearch} className="flex gap-2">
            <Input
              placeholder="搜索用户名"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-sm"
            />
            <Button type="submit" size="sm" variant="outline">
              <Search className="w-4 h-4 mr-1" />
              搜索
            </Button>
          </form>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="p-3 text-left font-medium">用户 ID</th>
                  <th className="p-3 text-left font-medium">用户名</th>
                  <th className="p-3 text-left font-medium">角色</th>
                  <th className="p-3 text-left font-medium">当前日志数</th>
                  <th className="p-3 text-left font-medium">保留上限</th>
                  <th className="p-3 text-left font-medium">状态</th>
                  <th className="p-3 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">加载中...</td></tr>
                ) : users.length === 0 ? (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">暂无用户</td></tr>
                ) : (
                  users.map(u => {
                    const over = Number(u.log_count) > Number(u.log_retention_limit);
                    const editValue = editing[u.id] !== undefined ? editing[u.id] : u.log_retention_limit;
                    return (
                      <tr key={u.id} className="border-t hover:bg-muted/40">
                        <td className="p-3 font-mono">{u.id}</td>
                        <td className="p-3">{u.username}</td>
                        <td className="p-3">
                          <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role}</Badge>
                        </td>
                        <td className="p-3">{Number(u.log_count).toLocaleString()}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={1}
                              className="w-28 h-8"
                              value={editValue}
                              onChange={(e) => setEditing(prev => ({ ...prev, [u.id]: e.target.value }))}
                            />
                            <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => updateUserLimit(u.id)}>
                              <Save className="w-4 h-4" />
                            </Button>
                          </div>
                        </td>
                        <td className="p-3">
                          {over ? (
                            <Badge variant="destructive">超出 {Number(u.log_count - u.log_retention_limit).toLocaleString()} 条</Badge>
                          ) : (
                            <Badge variant="success">正常</Badge>
                          )}
                        </td>
                        <td className="p-3">
                          <Button size="sm" variant="outline" className="h-8" onClick={() => trimUser(u.id)} disabled={!over}>
                            <Trash2 className="w-4 h-4 mr-1" />
                            清理
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">共 {totalPages} 页</div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>上一页</Button>
                <span className="px-2 py-1 text-sm">{page}</span>
                <Button size="sm" variant="outline" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>下一页</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
