import React, { useEffect, useRef, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import SkeletonUsers from '../components/skeletons/SkeletonUsers';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { MultiSelect } from '../components/MultiSelect';
import { useAdminSSE } from '../hooks/useAdminSSE';
import { Plus, Trash2, Key, Copy, Check, ChevronDown, ChevronUp, Edit3, Power, UserX, AlertCircle } from 'lucide-react';
import { showAlert, showConfirm } from '../components/Dialog';
import { formatCurrency } from '../utils/currency';

function CountdownConfirm({ count, countTotal, onConfirm, onCancel }) {
  const [left, setLeft] = useState(count);
  useEffect(() => {
    setLeft(count);
  }, [count]);
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft(v => v - 1), 1000);
    return () => clearInterval(t);
  }, [left]);
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card border rounded-lg shadow-lg p-6 max-w-sm w-full">
        <div className="flex items-center gap-2 mb-4 text-destructive">
          <AlertCircle className="w-5 h-5" />
          <h3 className="font-semibold">确认批量删除</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          确定要删除 <strong>{countTotal}</strong> 个用户吗？此操作不可恢复。
          <br />
          {left > 0 ? `请等待 ${left} 秒后确认...` : '现在可以确认删除。'}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
          <Button size="sm" variant="destructive" onClick={onConfirm} disabled={left > 0}>
            {left > 0 ? `确认 (${left})` : '确认删除'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Users() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [expandedUser, setExpandedUser] = useState(null);
  const [userKeys, setUserKeys] = useState({});
  const [newKey, setNewKey] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [editUserDialog, setEditUserDialog] = useState(null);
  const [editUserForm, setEditUserForm] = useState({});
  const [availableModels, setAvailableModels] = useState([]);
  const [availableGroups, setAvailableGroups] = useState([]);
  const [keyDialog, setKeyDialog] = useState(null);
  const [keyForm, setKeyForm] = useState({ name: '', model_limit: [], group_limit: [], quota_limit: 0, expires_at: '', workspace_id: '' });
  const [userWorkspaces, setUserWorkspaces] = useState([]);
  const [selectedUserIds, setSelectedUserIds] = useState(new Set());
  const [countdownDialog, setCountdownDialog] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef(0);

  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    role: 'user'
  });

  useAdminSSE(['users.changed', 'keys.changed'], {
    'users.changed': () => loadData({ preserveSelection: true }),
    'keys.changed': () => {
      if (expandedUser) loadUserKeys(expandedUser);
    }
  });

  useEffect(() => {
    loadData();
  }, []);

  // 保险：若请求超时或异常导致 loading 未复位，20s 后自动关闭骨架屏
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 20000);
    return () => clearTimeout(t);
  }, [loading]);

  const loadData = async ({ preserveSelection = false } = {}) => {
    scrollRef.current = window.scrollY;
    setRefreshing(true);
    try {
      const res = await api.get('/admin/users', { timeout: 15000 });
      const data = res.data || [];
      setUsers(data);
      // 如果被删除/变更的用户处于展开状态，且返回数据中已无该用户，则关闭展开
      if (expandedUser && !data.find(u => u.id === expandedUser)) {
        setExpandedUser(null);
      }
      if (!preserveSelection) {
        const existingIds = new Set(data.map(u => u.id));
        setSelectedUserIds(prev => {
          const next = new Set();
          for (const id of prev) {
            if (existingIds.has(id)) next.add(id);
          }
          return next;
        });
      }
    } catch (err) {
      console.error('[UsersCurrent] loadData error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
      requestAnimationFrame(() => window.scrollTo(0, scrollRef.current));
    }
  };

  const loadModelsAndGroups = async () => {
    try {
      const [modelsRes, groupsRes] = await Promise.all([
        api.get('/admin/models'),
        api.get('/admin/model-groups')
      ]);
      setAvailableModels(modelsRes.data || []);
      setAvailableGroups(groupsRes.data || []);
    } catch (e) {}
  };

  const loadUserKeys = async (userId) => {
    try {
      const res = await api.get(`/admin/users/${userId}/keys`);
      setUserKeys({ ...userKeys, [userId]: res.data });
    } catch (err) {
      console.error('Failed to load keys:', err);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    try {
      await api.post('/admin/users', newUser);
      setNewUser({ username: '', password: '', role: 'user' });
      setShowAdd(false);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '添加失败');
    }
  };

  const handleDelete = async (id) => {
    if (!await showConfirm('确定要删除这个用户吗？')) return;
    try {
      await api.delete(`/admin/users/${id}`);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const handleEditUserSave = async () => {
    try {
      const payload = { ...editUserForm };
      if (!payload.password) delete payload.password;
      await api.put(`/admin/users/${editUserDialog}`, payload);
      setEditUserDialog(null);
      await loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '保存失败');
    }
  };

  const toggleUser = async (id, isActive) => {
    try {
      await api.put(`/admin/users/${id}`, { is_active: isActive ? 0 : 1 });
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const toggleUserExpand = async (userId) => {
    if (expandedUser === userId) {
      setExpandedUser(null);
    } else {
      setExpandedUser(userId);
      if (!userKeys[userId]) {
        await loadUserKeys(userId);
      }
    }
  };

  const createKey = async (userId) => {
    try {
      const payload = {
        name: keyForm.name || 'API Key',
        model_limit: keyForm.model_limit.length > 0 ? JSON.stringify(keyForm.model_limit) : 'all',
        group_limit: keyForm.group_limit.length > 0 ? JSON.stringify(keyForm.group_limit) : 'all',
        quota_limit: parseFloat(keyForm.quota_limit) || 0,
      };
      if (keyForm.expires_at) payload.expires_at = keyForm.expires_at;
      if (keyForm.workspace_id) payload.workspace_id = parseInt(keyForm.workspace_id);
      const res = await api.post(`/admin/users/${userId}/keys`, payload);
      setNewKey(res.data);
      setKeyDialog(null);
      setKeyForm({ name: '', model_limit: [], group_limit: [], quota_limit: 0, expires_at: '', workspace_id: '' });
      await loadUserKeys(userId);
    } catch (err) {
      showAlert(err.response?.data?.error || '创建失败');
    }
  };

  const deleteKey = async (keyId, userId) => {
    if (!await showConfirm('确定要删除这个API密钥吗？')) return;
    try {
      await api.delete(`/admin/keys/${keyId}`);
      await loadUserKeys(userId);
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const toggleKey = async (keyId, isActive, userId) => {
    try {
      await api.put(`/admin/keys/${keyId}`, { is_active: isActive ? 0 : 1 });
      await loadUserKeys(userId);
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // 多选相关
  const toggleSelectUser = (id) => {
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allIds = users.map(u => u.id);
    const allSelected = allIds.every(id => selectedUserIds.has(id));
    if (allSelected) {
      setSelectedUserIds(prev => {
        const next = new Set(prev);
        for (const id of allIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedUserIds(prev => {
        const next = new Set(prev);
        for (const id of allIds) next.add(id);
        return next;
      });
    }
  };

  const batchToggle = async (isActive) => {
    const ids = Array.from(selectedUserIds);
    let success = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.put(`/admin/users/${id}`, { is_active: isActive ? 1 : 0 });
        success++;
      } catch (e) {
        failed++;
      }
    }
    await loadData({ preserveSelection: true });
    showAlert(`已${isActive ? '启用' : '禁用'} ${success} 个用户${failed ? `，${failed} 个失败` : ''}`);
  };

  const batchDelete = async () => {
    const ids = Array.from(selectedUserIds);
    let success = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.delete(`/admin/users/${id}`);
        success++;
      } catch (e) {
        failed++;
      }
    }
    setSelectedUserIds(new Set());
    await loadData();
    showAlert(`已删除 ${success} 个用户${failed ? `，${failed} 个失败` : ''}`);
  };

  const openBatchDeleteConfirm = () => {
    setCountdownDialog({ count: 3, ids: Array.from(selectedUserIds) });
  };

  if (loading) {
    return <SkeletonUsers />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">用户管理</h1>
        <div className="flex items-center gap-2">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={newUser.currency}
            onChange={(e) => setNewUser({ ...newUser, currency: e.target.value })}
          >
            <option value="CNY">¥ CNY</option>
            <option value="USD">$ USD</option>
          </select>
          <Button onClick={() => setShowAdd(!showAdd)}>
            <Plus className="w-4 h-4 mr-2" />
            添加用户
          </Button>
        </div>
      </div>

      {showAdd && (
        <Card>
          <CardHeader>
            <CardTitle>添加新用户</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">用户名</label>
                  <Input
                    value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">密码</label>
                  <Input
                    type="password"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">角色</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Button type="submit">添加</Button>
                <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>取消</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {newKey && (
        <Card className="border-green-500">
          <CardHeader>
            <CardTitle className="text-green-500">新API密钥已创建</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">请立即保存此密钥！您将无法再次查看它。</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 p-3 bg-muted rounded-md text-sm font-mono break-all">{newKey.key}</code>
              <Button variant="outline" onClick={() => copyToClipboard(newKey.key, 'new')}>
                {copiedId === 'new' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <Button variant="outline" className="mt-4" onClick={() => setNewKey(null)}>关闭</Button>
          </CardContent>
        </Card>
      )}

      {selectedUserIds.size > 0 && (
        <div className="flex items-center justify-between p-3 bg-muted/50 border rounded-lg">
          <div className="text-sm">
            已选择 <strong>{selectedUserIds.size}</strong> 个用户
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => batchToggle(true)}>
              <Power className="w-3 h-3 mr-1" />
              批量启用
            </Button>
            <Button size="sm" variant="outline" onClick={() => batchToggle(false)}>
              <Power className="w-3 h-3 mr-1" />
              批量禁用
            </Button>
            <Button size="sm" variant="destructive" onClick={openBatchDeleteConfirm}>
              <Trash2 className="w-3 h-3 mr-1" />
              批量删除
            </Button>
          </div>
        </div>
      )}

      <Card>
        {refreshing && (
          <div className="h-1 w-full bg-muted overflow-hidden">
            <div className="h-full bg-primary animate-pulse w-full" />
          </div>
        )}
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <th className="p-4 text-left text-sm font-medium w-10">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      checked={users.length > 0 && users.every(u => selectedUserIds.has(u.id))}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium">用户名</th>
                  <th className="p-4 text-left text-sm font-medium">角色</th>
                  <th className="p-4 text-left text-sm font-medium">余额</th>
                  <th className="p-4 text-left text-sm font-medium">状态</th>
                  <th className="p-4 text-left text-sm font-medium">限流配置</th>
                  <th className="p-4 text-left text-sm font-medium">创建时间</th>
                  <th className="p-4 text-left text-sm font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <React.Fragment key={user.id}>
                    <tr className="border-b group">
                      <td className="p-4">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input"
                          checked={selectedUserIds.has(user.id)}
                          onChange={() => toggleSelectUser(user.id)}
                        />
                      </td>
                      <td className="p-4">
                        <span className="font-medium">{user.username}</span>
                      </td>
                      <td className="p-4">
                        <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>{user.role === 'admin' ? '管理员' : '用户'}</Badge>
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-0.5">
                            <span className="text-sm">{user.currency === 'USD' ? '$' : '¥'}</span>
                            <span>{formatCurrency(user.balance)}</span>
                          </div>
                          {Number(user.quota_limit) > 0 && (
                            <div className="text-xs text-muted-foreground">
                              配额 {Number(user.quota_used || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} / {Number(user.quota_limit || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        <Badge variant={user.is_active ? 'success' : 'destructive'}>{user.is_active ? '启用' : '禁用'}</Badge>
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">
                        <div>TPM {Number(user.tpm || 0).toLocaleString()}</div>
                        <div>RPM {Number(user.rpm || 0).toLocaleString()}</div>
                        <div>TPD {Number(user.tpd || 0).toLocaleString()}</div>
                        <div>并发 {Number(user.max_concurrent || 0).toLocaleString()}</div>
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">{user.created_at ? (() => { const d = new Date(user.created_at); return isNaN(d.getTime()) ? String(user.created_at) : d.toLocaleDateString('zh-CN'); })() : '-'}</td>
                      <td className="p-4">
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => toggleUserExpand(user.id)} title="管理API密钥">
                            <Key className="w-3 h-3 md:mr-1" />
                            <span className="hidden md:inline">密钥</span>
                            {expandedUser === user.id ? <ChevronUp className="w-3 h-3 ml-1 hidden md:inline" /> : <ChevronDown className="w-3 h-3 ml-1 hidden md:inline" />}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => {
                            setEditUserDialog(user.id);
                            setEditUserForm({
                              username: user.username,
                              role: user.role,
                              password: '',
                              currency: user.currency || 'CNY',
                              tpm: user.tpm ?? 0,
                              rpm: user.rpm ?? 0,
                              tpd: user.tpd ?? 0,
                              max_concurrent: user.max_concurrent ?? 0
                            });
                          }} title="编辑">
                            <Edit3 className="w-3 h-3 md:mr-1" />
                            <span className="hidden md:inline">编辑</span>
                          </Button>
                          <Button size="sm" variant={user.is_active ? 'outline' : 'secondary'} onClick={() => toggleUser(user.id, user.is_active)} title={user.is_active ? '禁用' : '启用'}>
                            <Power className="w-3 h-3 md:mr-1" />
                            <span className="hidden md:inline">{user.is_active ? '禁用' : '启用'}</span>
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => handleDelete(user.id)} title="删除">
                            <UserX className="w-3 h-3 md:mr-1" />
                            <span className="hidden md:inline">删除</span>
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expandedUser === user.id && (
                      <tr className="border-b bg-muted/50">
                        <td colSpan={8} className="p-4">
                          <div className="space-y-4">
                            <div className="flex items-center justify-between">
                              <h4 className="font-medium">API密钥</h4>
                              <Button size="sm" onClick={() => {
                                setKeyDialog(user.id);
                                setKeyForm({ name: '', model_limit: [], group_limit: [], quota_limit: 0, expires_at: '' });
                                if (availableModels.length === 0 || availableGroups.length === 0) {
                                  loadModelsAndGroups();
                                }
                              }}>
                                <Plus className="w-3 h-3 mr-1" />
                                创建密钥
                              </Button>
                            </div>
                            {userKeys[user.id]?.length > 0 ? (
                              <table className="w-full">
                                <thead className="border-b">
                                  <tr>
                                    <th className="p-2 text-left text-xs font-medium">名称</th>
                                    <th className="p-2 text-left text-xs font-medium">Key</th>
                                    <th className="p-2 text-left text-xs font-medium">模型限制</th>
                                    <th className="p-2 text-left text-xs font-medium">分组限制</th>
                                    <th className="p-2 text-left text-xs font-medium">额度</th>
                                    <th className="p-2 text-left text-xs font-medium">过期</th>
                                    <th className="p-2 text-left text-xs font-medium">并发</th>
                                    <th className="p-2 text-left text-xs font-medium">请求/Token</th>
                                    <th className="p-2 text-left text-xs font-medium">状态</th>
                                    <th className="p-2 text-left text-xs font-medium">操作</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {userKeys[user.id].map((key) => {
                                    const isExpired = key.expires_at && new Date(key.expires_at) < new Date();
                                    const isQuotaExhausted = key.quota_limit > 0 && key.quota_used >= key.quota_limit;
                                    return (
                                    <tr key={key.id} className="border-b">
                                      <td className="p-2 text-sm">{key.name || 'API密钥'}</td>
                                      <td className="p-2 font-mono text-xs">
                                        <div className="flex items-center gap-1">
                                          <span>{key.key_prefix}</span>
                                          {key.key && (
                                            <button
                                              onClick={() => {navigator.clipboard.writeText(key.key); showAlert('已复制');}}
                                              className="p-0.5 hover:bg-accent rounded text-muted-foreground"
                                              title="复制完整Key"
                                            >
                                              <Copy className="w-3 h-3" />
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                      <td className="p-2 text-xs max-w-[160px]">
                                        {key.model_limit === 'all' ? (
                                          <Badge variant="outline" className="text-xs">全部</Badge>
                                        ) : (
                                          <div className="flex flex-wrap gap-0.5">
                                            {(() => { try { return JSON.parse(key.model_limit); } catch { return [key.model_limit]; } })().slice(0, 3).map(m => (
                                              <Badge key={m} variant="outline" className="text-xs">{m}</Badge>
                                            ))}
                                            {(() => { try { return JSON.parse(key.model_limit); } catch { return [key.model_limit]; } })().length > 3 && (
                                              <Badge variant="secondary" className="text-xs">+{(() => { try { return JSON.parse(key.model_limit); } catch { return [key.model_limit]; } })().length - 3}</Badge>
                                            )}
                                          </div>
                                        )}
                                      </td>
                                      <td className="p-2 text-xs max-w-[120px]">
                                        {key.group_limit === 'all' ? (
                                          <Badge variant="outline" className="text-xs">全部</Badge>
                                        ) : (
                                          <div className="flex flex-wrap gap-0.5">
                                            {(() => { try { return JSON.parse(key.group_limit); } catch { return [key.group_limit]; } })().map(g => (
                                              <Badge key={g} variant="outline" className="text-xs">{g}</Badge>
                                            ))}
                                          </div>
                                        )}
                                      </td>
                                      <td className="p-2 text-xs">
                                        {key.quota_limit > 0 ? (
                                          <div>
                                            <div>{key.quota_used?.toLocaleString() || 0} / {key.quota_limit?.toLocaleString()}</div>
                                            <div className="w-16 h-1 bg-secondary rounded-full overflow-hidden mt-1">
                                              <div className="h-full bg-primary" style={{ width: `${Math.min(100, (key.quota_used / key.quota_limit) * 100)}%` }} />
                                            </div>
                                            <span className="text-muted-foreground">{key.quota_type || 'tokens'}</span>
                                          </div>
                                        ) : (
                                          <span className="text-muted-foreground">无限制</span>
                                        )}
                                      </td>
                                      <td className="p-2 text-xs">
                                        {key.expires_at ? (
                                          <Badge variant={isExpired ? 'destructive' : 'secondary'}>
                                            {isExpired ? '已过期' : (() => { const d = new Date(key.expires_at); return isNaN(d.getTime()) ? String(key.expires_at) : d.toLocaleDateString(); })()}
                                          </Badge>
                                        ) : (
                                          <span className="text-muted-foreground">永不过期</span>
                                        )}
                                      </td>
                                      <td className="p-2 text-xs">{key.current_concurrent || 0}/{key.max_concurrent || 500}</td>
                                      <td className="p-2 text-xs">{key.total_requests || 0} / {key.total_tokens?.toLocaleString() || 0}</td>
                                      <td className="p-2">
                                        <Badge variant={key.is_active && !isExpired && !isQuotaExhausted ? 'success' : 'destructive'}>
                                          {!key.is_active ? '禁用' : isExpired ? '过期' : isQuotaExhausted ? '耗尽' : '正常'}
                                        </Badge>
                                      </td>
                                      <td className="p-2">
                                        <div className="flex items-center gap-1">
                                          <Button size="sm" variant={key.is_active ? 'secondary' : 'success'} onClick={() => toggleKey(key.id, key.is_active, user.id)}>
                                            {key.is_active ? '禁用' : '启用'}
                                          </Button>
                                          <Button size="sm" variant="destructive" onClick={() => deleteKey(key.id, user.id)}>
                                            <Trash2 className="w-3 h-3" />
                                          </Button>
                                        </div>
                                      </td>
                                    </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            ) : (
                              <p className="text-sm text-muted-foreground">暂无API密钥</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {keyDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[500px]">
            <CardHeader>
              <CardTitle>创建API密钥</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">密钥名称</label>
                <Input
                  value={keyForm.name}
                  onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })}
                  placeholder="API Key"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">模型限制</label>
                  <MultiSelect
                    options={availableModels.map(m => ({ value: m.model_id, label: m.model_id, description: m.model_group }))}
                    value={keyForm.model_limit}
                    onChange={(val) => setKeyForm({ ...keyForm, model_limit: val })}
                    placeholder="全部模型"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">分组限制</label>
                  <MultiSelect
                    options={availableGroups.map(g => ({ value: g.name, label: g.name, description: g.description }))}
                    value={keyForm.group_limit}
                    onChange={(val) => setKeyForm({ ...keyForm, group_limit: val })}
                    placeholder="全部分组"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">余额 (0=无限制)</label>
                  <Input
                    type="number"
                    value={keyForm.quota_limit}
                    onChange={(e) => setKeyForm({ ...keyForm, quota_limit: e.target.value })}
                    min="0"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">过期时间</label>
                  <Input
                    type="datetime-local"
                    value={keyForm.expires_at}
                    onChange={(e) => setKeyForm({ ...keyForm, expires_at: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">所属 Workspace（可选）</label>
                <select
                  value={keyForm.workspace_id}
                  onChange={(e) => setKeyForm({ ...keyForm, workspace_id: e.target.value })}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">个人密钥（不绑定 Workspace）</option>
                  {userWorkspaces.map(ws => (
                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setKeyDialog(null)}>取消</Button>
                <Button onClick={() => createKey(keyDialog)}>创建</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {countdownDialog && (
        <CountdownConfirm
          count={countdownDialog.count}
          countTotal={countdownDialog.ids.length}
          onCancel={() => setCountdownDialog(null)}
          onConfirm={() => {
            setCountdownDialog(null);
            batchDelete();
          }}
        />
      )}

      {editUserDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[400px]">
            <CardHeader>
              <CardTitle>编辑用户</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">用户名</label>
                <Input value={editUserForm.username} onChange={(e) => setEditUserForm({ ...editUserForm, username: e.target.value })} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">新密码 (留空不修改)</label>
                <Input type="password" value={editUserForm.password} onChange={(e) => setEditUserForm({ ...editUserForm, password: e.target.value })} placeholder="留空则不修改" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">角色</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editUserForm.role}
                  onChange={(e) => setEditUserForm({ ...editUserForm, role: e.target.value })}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">币种</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editUserForm.currency}
                  onChange={(e) => setEditUserForm({ ...editUserForm, currency: e.target.value })}
                >
                  <option value="CNY">CNY (¥)</option>
                  <option value="USD">USD ($)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">TPM (0=无限制)</label>
                  <Input
                    type="number"
                    min={0}
                    value={editUserForm.tpm}
                    onChange={(e) => setEditUserForm({ ...editUserForm, tpm: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">RPM (0=无限制)</label>
                  <Input
                    type="number"
                    min={0}
                    value={editUserForm.rpm}
                    onChange={(e) => setEditUserForm({ ...editUserForm, rpm: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">TPD (0=无限制)</label>
                  <Input
                    type="number"
                    min={0}
                    value={editUserForm.tpd}
                    onChange={(e) => setEditUserForm({ ...editUserForm, tpd: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">最大并发 (0=无限制)</label>
                  <Input
                    type="number"
                    min={0}
                    value={editUserForm.max_concurrent}
                    onChange={(e) => setEditUserForm({ ...editUserForm, max_concurrent: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setEditUserDialog(null)}>取消</Button>
                <Button onClick={handleEditUserSave}>保存</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
