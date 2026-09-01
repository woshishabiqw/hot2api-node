import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import {
  Building2, Users, Plus, Trash2, RefreshCw, Crown, UserCheck,
  Wallet, X, AlertCircle, CheckCircle, Loader2, UserMinus,
  Receipt, CreditCard, History, ArrowRight, Activity, Edit3, Power
} from 'lucide-react';
import { cn } from '../lib/utils';
import api from '../lib/api';
import { showConfirm } from '../components/Dialog';
import { useAdminSSE } from '../hooks/useAdminSSE';
import { formatCurrency } from '../utils/currency';

const API_URL = import.meta.env.VITE_API_URL || '/api';

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className={cn(
      "fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-in slide-in-from-right",
      type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
    )}>
      {type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
      {message}
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}

function TokenQuotaView({ ws }) {
  const tokenLimit = Number(ws?.token_quota_limit) || 0;
  const tokenUsed = Number(ws?.token_quota_used) || 0;
  const usagePct = tokenLimit > 0 ? Math.min(100, (tokenUsed / tokenLimit) * 100) : 0;
  const statusColor = usagePct >= 90 ? 'text-red-500' : usagePct >= 70 ? 'text-amber-500' : 'text-emerald-500';
  const barColor = usagePct >= 90 ? 'bg-red-500' : usagePct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Token 配额</span>
        <span className={cn("font-medium tabular-nums", statusColor)}>
          {tokenUsed.toLocaleString()} / {tokenLimit > 0 ? tokenLimit.toLocaleString() : '∞'}
          {tokenLimit > 0 && <span className="ml-1">({usagePct.toFixed(1)}%)</span>}
        </span>
      </div>
      {tokenLimit > 0 && (
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", barColor)}
            style={{ width: `${usagePct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function Workspaces() {
  const { token, user } = useAuth();
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [users, setUsers] = useState([]);
  const [selectedWs, setSelectedWs] = useState(null);
  const [wsDetail, setWsDetail] = useState(null);
  const [inviteName, setInviteName] = useState('');
  const [toast, setToast] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [billingRecords, setBillingRecords] = useState([]);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeChannel, setRechargeChannel] = useState('');
  const [channels, setChannels] = useState([]);
  const [wsKeys, setWsKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [keyConcurrency, setKeyConcurrency] = useState({});
  const [editingKeyId, setEditingKeyId] = useState(null);
  const [editKeyForm, setEditKeyForm] = useState({ max_concurrent: 500, rate_limit: 60 });
  const [editingTokenQuota, setEditingTokenQuota] = useState(false);
  const [tokenQuotaInput, setTokenQuotaInput] = useState('');

  const showToast = (message, type = 'success') => setToast({ message, type });
  const isAdmin = user?.role === 'admin';

  const fetchWorkspaces = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = isAdmin ? `${API_URL}/admin/workspaces` : `${API_URL}/workspaces`;
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setWorkspaces((await res.json()) || []);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || '获取 Workspace 失败', 'error');
      }
    } catch (e) { showToast('网络错误', 'error'); }
    setLoading(false);
  }, [token, isAdmin]);

  const fetchDetail = async (id) => {
    try {
      const endpoint = isAdmin ? `${API_URL}/admin/workspaces/${id}` : `${API_URL}/workspaces/${id}`;
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setWsDetail(await res.json());
      }
    } catch (e) { console.error(e); }
  };

  const fetchBillingRecords = async (id) => {
    try {
      const res = await api.get(`/workspaces/${id}/billing`);
      setBillingRecords(res.data.records || []);
    } catch (e) {
      console.error('Failed to fetch billing records:', e);
    }
  };

  const fetchChannels = async () => {
    try {
      const res = await api.get('/payment-gateway/payment-channels');
      setChannels(res.data.filter(c => c.is_active) || []);
    } catch (e) {
      console.error('Failed to fetch channels:', e);
    }
  };

  const fetchWsKeys = async (id) => {
    try {
      const res = await api.get(`/admin/workspaces/${id}/keys`);
      setWsKeys(res.data || []);
    } catch (e) {
      console.error('Failed to fetch workspace keys:', e);
    }
  };

  const createWsKey = async () => {
    if (!newKeyName.trim()) { showToast('请输入密钥名称', 'error'); return; }
    if (!selectedWs) return;
    setActionLoading(true);
    try {
      const res = await api.post(`/admin/workspaces/${selectedWs.id}/keys`, { name: newKeyName.trim() });
      showToast('Workspace API Key 创建成功');
      setNewKeyName('');
      fetchWsKeys(selectedWs.id);
    } catch (e) {
      showToast(e.response?.data?.error || '创建失败', 'error');
    }
    setActionLoading(false);
  };

  const deleteWsKey = async (keyId) => {
    const confirmed = await showConfirm('确定删除此 API Key？此操作无法撤销。');
    if (!confirmed) return;
    setActionLoading(true);
    try {
      await api.delete(`/admin/workspaces/${selectedWs.id}/keys/${keyId}`);
      showToast('已删除');
      if (selectedWs) fetchWsKeys(selectedWs.id);
    } catch (e) {
      showToast('删除失败', 'error');
    }
    setActionLoading(false);
  };

  const updateWsKey = async (keyId) => {
    if (!selectedWs) return;
    setActionLoading(true);
    try {
      await api.put(`/admin/keys/${keyId}`, {
        max_concurrent: parseInt(editKeyForm.max_concurrent, 10) || 0,
        rate_limit: parseInt(editKeyForm.rate_limit, 10) || 0
      });
      showToast('Key 配置已更新');
      setEditingKeyId(null);
      fetchWsKeys(selectedWs.id);
    } catch (e) {
      showToast(e.response?.data?.error || '更新失败', 'error');
    }
    setActionLoading(false);
  };

  const toggleWsKey = async (key) => {
    if (!selectedWs) return;
    setActionLoading(true);
    try {
      await api.put(`/admin/keys/${key.id}`, { is_active: key.is_active ? 0 : 1 });
      showToast(key.is_active ? 'Key 已禁用' : 'Key 已启用');
      fetchWsKeys(selectedWs.id);
    } catch (e) {
      showToast(e.response?.data?.error || '操作失败', 'error');
    }
    setActionLoading(false);
  };

  useEffect(() => { fetchWorkspaces(); fetchChannels(); }, [fetchWorkspaces]);

  useEffect(() => {
    if (!isAdmin) return;
    const loadUsers = async () => {
      try {
        const res = await fetch(`${API_URL}/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) setUsers((await res.json()) || []);
      } catch (e) { console.error('Failed to load users', e); }
    };
    loadUsers();
  }, [token, isAdmin]);

  useAdminSSE(['keys.concurrency'], {
    'keys.concurrency': (payload) => {
      setKeyConcurrency(prev => ({ ...prev, ...payload }));
    }
  });

  useEffect(() => {
    if (selectedWs) {
      fetchDetail(selectedWs.id);
      fetchBillingRecords(selectedWs.id);
      fetchWsKeys(selectedWs.id);
      setTokenQuotaInput(String(selectedWs.token_quota_limit || 0));
      setEditingTokenQuota(false);
    } else {
      setWsDetail(null);
      setBillingRecords([]);
      setWsKeys([]);
      setTokenQuotaInput('');
      setEditingTokenQuota(false);
    }
  }, [selectedWs?.id]);

  const createWorkspace = async () => {
    const name = newName.trim();
    if (!name) { showToast('请输入名称', 'error'); return; }
    if (name.length < 2 || name.length > 50) { showToast('名称需要 2-50 个字符', 'error'); return; }

    setActionLoading(true);
    const payload = { name };
    const owner = newOwner.trim();
    if (isAdmin && owner) {
      payload.owner_username = owner;
    }
    try {
      const res = await fetch(`${API_URL}/workspaces`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast('Workspace 创建成功');
        setNewName('');
        setNewOwner('');
        setShowCreate(false);
        fetchWorkspaces();
      } else {
        showToast(data.error || '创建失败', 'error');
      }
    } catch (e) { showToast('网络错误', 'error'); }
    setActionLoading(false);
  };

  const inviteMember = async () => {
    const name = inviteName.trim();
    if (!name) { showToast('请输入用户名', 'error'); return; }
    if (!selectedWs) return;

    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/workspaces/${selectedWs.id}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(`已邀请 ${name}`);
        setInviteName('');
        fetchDetail(selectedWs.id);
      } else {
        showToast(data.error || '邀请失败', 'error');
      }
    } catch (e) { showToast('网络错误', 'error'); }
    setActionLoading(false);
  };

  const removeMember = async (userId, username) => {
    if (!confirm(`确定移除成员 ${username}？`)) return;
    if (!selectedWs) return;

    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/workspaces/${selectedWs.id}/members/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        showToast('成员已移除');
        fetchDetail(selectedWs.id);
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || '移除失败', 'error');
      }
    } catch (e) { showToast('网络错误', 'error'); }
    setActionLoading(false);
  };

  const deleteWorkspace = async (ws) => {
    if (!confirm(`确定删除 Workspace「${ws.name}」？此操作不可恢复。`)) return;

    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/workspaces/${ws.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        showToast('Workspace 已删除');
        setSelectedWs(null);
        fetchWorkspaces();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || '删除失败', 'error');
      }
    } catch (e) { showToast('网络错误', 'error'); }
    setActionLoading(false);
  };

  const handleRecharge = async () => {
    const amount = parseFloat(rechargeAmount);
    if (!amount || amount <= 0) {
      showToast('请输入有效的充值金额', 'error');
      return;
    }
    if (!rechargeChannel) {
      showToast('请选择支付渠道', 'error');
      return;
    }
    if (!selectedWs) return;

    setActionLoading(true);
    try {
      const res = await api.post('/billing/recharge', {
        workspace_id: selectedWs.id,
        amount,
        channel: rechargeChannel,
        return_url: window.location.href
      });
      
      if (res.data.paymentUrl) {
        window.location.href = res.data.paymentUrl;
      } else if (res.data.form) {
        document.body.innerHTML = res.data.form;
        document.body.querySelector('form')?.submit();
      } else {
        showToast('充值请求已提交', 'success');
        fetchWorkspaces();
      }
    } catch (e) {
      showToast(e.response?.data?.error || '充值失败', 'error');
    }
    setActionLoading(false);
  };

  const updateTokenQuota = async () => {
    if (!selectedWs) return;
    const limit = parseFloat(tokenQuotaInput);
    if (!isFinite(limit) || limit < 0) {
      showToast('请输入有效的 Token 配额上限', 'error');
      return;
    }

    setActionLoading(true);
    try {
      const endpoint = isAdmin ? `/admin/workspaces/${selectedWs.id}/quota` : `/workspaces/${selectedWs.id}`;
      await api.put(endpoint, { token_quota_limit: limit });
      showToast('Token 配额已更新');
      setEditingTokenQuota(false);
      fetchWorkspaces();
      fetchDetail(selectedWs.id);
    } catch (e) {
      showToast(e.response?.data?.error || '更新失败', 'error');
    }
    setActionLoading(false);
  };

  const toggleBilling = () => {
    setShowBilling(!showBilling);
    if (!showBilling && selectedWs) {
      fetchBillingRecords(selectedWs.id);
    }
  };

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="w-6 h-6 text-primary" />
            Workspace 管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理您的工作空间和团队成员
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchWorkspaces} disabled={loading}>
            <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
            刷新
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" />
            新建 Workspace
          </Button>
        </div>
      </div>

      {showCreate && (
        <Card className="p-4">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">名称 *</label>
              <Input
                placeholder="我的工作空间"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createWorkspace()}
              />
              <div className="text-xs text-muted-foreground mt-1">2-50 个字符</div>
            </div>
            {isAdmin && (
              <div className="flex-1 min-w-[180px]">
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">归属者</label>
                <Input
                  list="owner-list"
                  placeholder="默认自己，可输入用户名"
                  value={newOwner}
                  onChange={e => setNewOwner(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createWorkspace()}
                />
                <datalist id="owner-list">
                  {users.map(u => <option key={u.id} value={u.username} />)}
                </datalist>
                <div className="text-xs text-muted-foreground mt-1">留空则归属当前用户</div>
              </div>
            )}
            <Button onClick={createWorkspace} disabled={actionLoading}>
              {actionLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              创建
            </Button>
            <Button variant="outline" onClick={() => { setShowCreate(false); setNewName(''); setNewOwner(''); }}>取消</Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {workspaces.map(ws => (
          <Card key={ws.id} className={cn("p-5 transition-all", selectedWs?.id === ws.id && "ring-2 ring-primary shadow-lg")}>
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold truncate">{ws.name}</h3>
                  <Badge variant={ws.status === 'active' ? 'default' : 'secondary'}>
                    {ws.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1 font-mono">{ws.slug}</div>
              </div>
              <div className="flex items-center gap-1 text-sm text-muted-foreground shrink-0">
                <Wallet className="w-4 h-4" />
                <span className="font-medium text-foreground">¥{formatCurrency(ws.balance)}</span>
              </div>
            </div>

            <div className="flex items-center gap-4 mt-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <Crown className="w-4 h-4 text-amber-500" />
                <span>{ws.member_role === 'owner' ? '所有者' : ws.member_role === 'admin' ? '管理员' : '成员'}</span>
              </div>
              <div className="flex items-center gap-1">
                <Users className="w-4 h-4" />
                <span>成员 {ws.member_count ?? (ws.members?.length ?? 0)}</span>
              </div>
            </div>
            <div className="mt-3">
              <TokenQuotaView ws={ws} />
            </div>

            <div className="flex gap-2 mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedWs(ws)}
              >
                编辑
              </Button>
              <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => deleteWorkspace(ws)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>


          </Card>
        ))}

        {workspaces.length === 0 && !loading && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            暂无 Workspace，点击右上角创建
          </div>
        )}
      </div>

      {/* Workspace edit modal */}
      {selectedWs && (
        <div>
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setSelectedWs(null)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <div className="bg-card border shadow-2xl rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col pointer-events-auto">
              <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-primary" />
                    {selectedWs.name}
                  </h2>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">{selectedWs.slug}</div>
                </div>
                <button
                  onClick={() => setSelectedWs(null)}
                  className="p-2 rounded-md hover:bg-muted transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Member Management */}
              <div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">邀请成员（输入用户名）</label>
                    <Input
                      placeholder="例如: zhangsan"
                      value={inviteName}
                      onChange={e => setInviteName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && inviteMember()}
                    />
                  </div>
                  <Button size="sm" onClick={inviteMember} disabled={actionLoading}>
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4 mr-1" />}
                    邀请
                  </Button>
                </div>

                <div className="mt-3">
                  <div className="text-xs font-medium text-muted-foreground mb-2">成员列表</div>
                  {!wsDetail?.members || wsDetail.members.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4 text-center bg-muted/30 rounded-md">
                      暂无成员
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {wsDetail.members.map(m => (
                        <div key={m.user_id} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 text-sm">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary">
                              {(m.username || '?').charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-medium">{m.username}</div>
                              <div className="text-xs text-muted-foreground">
                                {m.role === 'owner' ? '所有者' : m.role === 'admin' ? '管理员' : '成员'}
                              </div>
                            </div>
                          </div>
                          {selectedWs.member_role === 'owner' && m.role !== 'owner' && (
                            <button
                              onClick={() => removeMember(m.user_id, m.username)}
                              className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                              title="移除成员"
                            >
                              <UserMinus className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* API Keys */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <CreditCard className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">Workspace API Keys</span>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">密钥名称</label>
                    <Input
                      placeholder="例如: 生产环境 Key"
                      value={newKeyName}
                      onChange={e => setNewKeyName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && createWsKey()}
                    />
                  </div>
                  <Button size="sm" onClick={createWsKey} disabled={actionLoading}>
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
                    创建
                  </Button>
                </div>
                {!wsKeys || wsKeys.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-3 text-center bg-muted/30 rounded-md">
                    暂无 API Key
                  </div>
                ) : (
                  <div className="space-y-2">
                    {wsKeys.map(k => {
                      const live = keyConcurrency[k.id] || {};
                      const currentConcurrent = live.current_concurrent ?? k.current_concurrent ?? 0;
                      const maxConcurrent = k.max_concurrent || 500;
                      const rateLimit = k.rate_limit || 60;
                      const utilization = maxConcurrent > 0 ? Math.min(100, (currentConcurrent / maxConcurrent) * 100) : 0;
                      const isEditing = editingKeyId === k.id;
                      return (
                        <div key={k.id} className="px-3 py-2 rounded-md bg-muted/30 text-sm">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="font-mono text-xs text-muted-foreground">{k.key_prefix}</div>
                              <div className="font-medium truncate">{k.name}</div>
                              <Badge variant={k.is_active ? 'default' : 'secondary'} className="text-[10px] h-5">
                                {k.is_active ? '启用' : '禁用'}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1">
                              {!isEditing && (
                                <button
                                  onClick={() => { setEditingKeyId(k.id); setEditKeyForm({ max_concurrent: k.max_concurrent ?? 500, rate_limit: k.rate_limit ?? 60 }); }}
                                  className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                                  title="编辑并发/限流"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {!isEditing && (
                                <button
                                  onClick={() => toggleWsKey(k)}
                                  className={cn(
                                    "p-1.5 rounded-md transition-colors",
                                    k.is_active
                                      ? "hover:bg-amber-500/10 text-muted-foreground hover:text-amber-500"
                                      : "hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-500"
                                  )}
                                  title={k.is_active ? '禁用 Key' : '启用 Key'}
                                >
                                  <Power className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => { navigator.clipboard.writeText(k.key); showToast('已复制'); }}
                                className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                                title="复制 Key"
                              >
                                <Receipt className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => deleteWsKey(k.id)}
                                className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                                title="删除"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {isEditing ? (
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs text-muted-foreground mb-1 block">最大并发（0=无限制）</label>
                                <Input
                                  type="number"
                                  min="0"
                                  value={editKeyForm.max_concurrent}
                                  onChange={e => setEditKeyForm({ ...editKeyForm, max_concurrent: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-muted-foreground mb-1 block">每分钟请求数（0=无限制）</label>
                                <Input
                                  type="number"
                                  min="0"
                                  value={editKeyForm.rate_limit}
                                  onChange={e => setEditKeyForm({ ...editKeyForm, rate_limit: e.target.value })}
                                />
                              </div>
                              <div className="col-span-2 flex gap-2">
                                <Button size="sm" onClick={() => updateWsKey(k.id)} disabled={actionLoading}>保存</Button>
                                <Button size="sm" variant="outline" onClick={() => setEditingKeyId(null)}>取消</Button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-2 space-y-1">
                              <div className="flex items-center gap-2 text-xs">
                                <Activity className="w-3 h-3 text-muted-foreground" />
                                <span className="tabular-nums">并发 {currentConcurrent}/{maxConcurrent > 0 ? maxConcurrent : '∞'}</span>
                                <span className="text-muted-foreground">·</span>
                                <span className="text-muted-foreground">限流 {rateLimit > 0 ? `${rateLimit}/min` : '无限制'}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                                  <div
                                    className={cn("h-full rounded-full", utilization >= 90 ? 'bg-red-500' : utilization >= 70 ? 'bg-amber-500' : 'bg-emerald-500')}
                                    style={{ width: `${maxConcurrent > 0 ? utilization : 0}%` }}
                                  />
                                </div>
                                <span className="text-[10px] text-muted-foreground w-8 text-right">{maxConcurrent > 0 ? `${Math.round(utilization)}%` : '-'}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Token Quota */}
              <div className="p-4 bg-muted/30 rounded-md">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium">Token 配额</span>
                  </div>
                  {!editingTokenQuota && (
                    <button
                      onClick={() => setEditingTokenQuota(true)}
                      className="text-xs text-primary hover:underline"
                    >
                      编辑上限
                    </button>
                  )}
                </div>
                <TokenQuotaView ws={selectedWs} />
                {editingTokenQuota && (
                  <div className="mt-3 flex items-end gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-muted-foreground mb-1 block">Token 配额上限（0=无限制）</label>
                      <Input
                        type="number"
                        min="0"
                        value={tokenQuotaInput}
                        onChange={e => setTokenQuotaInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && updateTokenQuota()}
                      />
                    </div>
                    <Button size="sm" onClick={updateTokenQuota} disabled={actionLoading}>保存</Button>
                    <Button size="sm" variant="outline" onClick={() => { setEditingTokenQuota(false); setTokenQuotaInput(String(selectedWs.token_quota_limit || 0)); }}>取消</Button>
                  </div>
                )}
              </div>

              {/* Billing & Recharge */}
              <div className="space-y-4">
                {/* Recharge */}
                <div className="p-4 bg-muted/30 rounded-md">
                  <div className="flex items-center gap-2 mb-3">
                    <CreditCard className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium">余额充值</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">充值金额</label>
                      <Input
                        type="number"
                        placeholder="100"
                        value={rechargeAmount}
                        onChange={e => setRechargeAmount(e.target.value)}
                        min="1"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">支付渠道</label>
                      <select
                        value={rechargeChannel}
                        onChange={e => setRechargeChannel(e.target.value)}
                        className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="">请选择</option>
                        {channels.map(ch => (
                          <option key={ch.id} value={ch.type}>{ch.name} ({ch.env === 'production' ? '生产' : '沙盒'})</option>
                        ))}
                      </select>
                    </div>
                    <Button size="sm" onClick={handleRecharge} disabled={actionLoading} className="w-full">
                      {actionLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
                      充值
                    </Button>
                  </div>
                </div>

                {/* Billing Records */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <History className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium">计费记录</span>
                  </div>
                  {!billingRecords || billingRecords.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4 text-center bg-muted/30 rounded-md">
                      暂无计费记录
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-60 overflow-auto">
                      {billingRecords.map(record => (
                        <div key={record.id} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 text-sm">
                          <div className="flex-1">
                            <div className="font-medium">{record.description || record.type}</div>
                            <div className="text-xs text-muted-foreground">{record.created_at ? new Date(record.created_at).toLocaleString('zh-CN') : '-'}</div>
                          </div>
                          <div className={cn(
                            "font-medium",
                            record.type === 'recharge' ? 'text-green-600' : 'text-red-600'
                          )}>
                            {record.type === 'recharge' ? '+' : '-'}¥{Math.abs(record.amount).toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
