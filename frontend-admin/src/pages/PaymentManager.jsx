import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';

import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import SearchableSelect from '../components/SearchableSelect';
import {
  Wallet, Landmark, Smartphone, ArrowUp, ArrowDown, RefreshCw,
  History, CreditCard, ChevronLeft, ChevronRight, Terminal,
  AlertCircle, CheckCircle, X, Loader2, Eye, EyeOff
} from 'lucide-react';
import { cn } from '../lib/utils';
import api from '../lib/api';
import { formatCurrency } from '../utils/currency';

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className={cn(
      "fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium",
      type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
    )}>
      {type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
      {message}
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}

const LOG_ACTION_LABELS = {
  recharge_order_created: '创建充值订单',
  fulfill_order_success: '订单完成',
  fulfill_order_duplicate: '订单重复完成',
  fulfill_order_failed: '订单完成失败',
  stripe_session_created: 'Stripe 会话创建',
  stripe_session_failed: 'Stripe 会话失败',
  stripe_webhook_fulfilled: 'Stripe Webhook 完成',
  alipay_order_created: '支付宝订单创建',
  alipay_order_failed: '支付宝订单失败',
  mock_payment_url: '模拟支付链接',
  order_cancelled: '取消订单',
  admin_order_cancelled: '管理员取消订单',
  admin_order_refunded: '管理员退款',
  admin_order_deleted: '删除订单',
  admin_order_batch_cancelled: '批量取消订单',
  admin_order_batch_refunded: '批量退款订单',
  admin_order_batch_deleted: '批量删除订单',
  invoice_auto_issued: '自动开票',
  invoice_auto_failed: '自动开票失败',
  admin_recharge: '管理员增值',
  admin_invoice_reviewed: '发票审核',
};

export default function PaymentManager() {
  const { token, user } = useAuth();
  const [toast, setToast] = useState(null);
  const showToast = (m, t = 'success') => setToast({ message: m, type: t });

  // Data state
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWs, setSelectedWs] = useState(null);
  const [records, setRecords] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [userBalance, setUserBalance] = useState(0);
  const [selectedUserBalance, setSelectedUserBalance] = useState(0);
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);

  // UI state
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeTarget, setRechargeTarget] = useState('workspace'); // 'workspace' | 'account'
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logsPage, setLogsPage] = useState(1);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);

  const isCurrentMonth = (dateStr) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  };

  const loadBaseData = useCallback(async () => {
    setLoading(true);
    try {
      const [wsRes, balRes, usersRes] = await Promise.all([
        api.get('/workspaces'),
        api.get('/billing/user-balance'),
        api.get('/admin/users').catch(() => ({ data: [] })),
      ]);
      const ws = wsRes.data || [];
      setWorkspaces(ws);
      if (ws.length > 0) setSelectedWs(prev => prev || ws[0]);
      setUserBalance(balRes?.data?.balance || 0);
      const userList = usersRes.data || [];
      setUsers(userList);
      if (userList.length > 0) setSelectedUser(prev => prev || userList[0]);
    } catch (e) {
      showToast('加载基础数据失败', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRecords = useCallback(async () => {
    if (!selectedWs) return;
    setLoading(true);
    try {
      const res = await api.get(`/workspaces/${selectedWs.id}/billing?page=${recordsPage}&limit=20`);
      setRecords(res.data?.records || []);
      setRecordsTotal(res.data?.total || 0);
    } catch (e) {
      showToast('加载账单失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedWs, recordsPage]);

  const loadLogs = useCallback(async () => {
    if (!showLogs) return;
    setLogsLoading(true);
    try {
      const res = await api.get(`/billing/logs?page=${logsPage}&limit=20`);
      setLogs(res.data?.logs || []);
      setLogsTotal(res.data?.total || 0);
    } catch (e) {
      showToast('加载日志失败', 'error');
    } finally {
      setLogsLoading(false);
    }
  }, [showLogs, logsPage]);

  const refreshAll = useCallback(async () => {
    await loadBaseData();
    await loadRecords();
    await loadLogs();
  }, [loadBaseData, loadRecords, loadLogs]);

  useEffect(() => { loadBaseData(); }, [loadBaseData]);
  useEffect(() => { loadRecords(); }, [loadRecords]);
  useEffect(() => { loadLogs(); }, [loadLogs]);

  // Fetch selected user's account balance in account mode
  useEffect(() => {
    if (rechargeTarget !== 'account' || !selectedUser) return;
    let cancelled = false;
    api.get(`/billing/user-balance?user_id=${selectedUser.id}`)
      .then(res => { if (!cancelled) setSelectedUserBalance(res.data?.balance || 0); })
      .catch(() => { if (!cancelled) setSelectedUserBalance(0); });
    return () => { cancelled = true; };
  }, [rechargeTarget, selectedUser]);

  const recharge = async () => {
    const amount = parseFloat(rechargeAmount);
    // Workspace 余额充值必须选择 Workspace；账户独立余额充值不强制关联 Workspace。
    if (rechargeTarget === 'workspace' && !selectedWs) { showToast('请先选择一个 Workspace', 'error'); return; }
    if (rechargeTarget === 'account' && !selectedUser) { showToast('请选择要充值的用户', 'error'); return; }
    if (!amount || amount <= 0 || !isFinite(amount)) { showToast('请输入有效金额', 'error'); return; }
    setActionLoading(true);
    try {
      const payload = {
        amount,
        description: '管理员快速充值',
        target: rechargeTarget,
      };
      if (rechargeTarget === 'workspace' && selectedWs) payload.workspace_id = selectedWs.id;
      if (rechargeTarget === 'account' && selectedUser) payload.user_id = selectedUser.id;
      const res = await api.post('/billing/admin/quick-recharge', payload);
      const d = res.data || {};
      const targetLabel = d.target === 'account' ? '账户独立余额' : 'Workspace 余额';
      const targetValue = d.target === 'account' ? d.userBalance : d.balance;
      showToast(`充值成功！${targetLabel} ¥${Number(targetValue).toFixed(2)}`);
      setRechargeAmount('');
      // Update balances immediately before refetch
      if (d.target === 'workspace') {
        setWorkspaces(prev => prev.map(w => w.id === selectedWs.id ? { ...w, balance: d.balance } : w));
        setSelectedWs(prev => prev ? { ...prev, balance: d.balance } : prev);
      } else if (d.target === 'account') {
        if (selectedUser && selectedUser.id === d.user_id) {
          // update displayed balance if the selected user is the one recharged
          setSelectedUserBalance(d.userBalance);
        }
      }
      await refreshAll();
    } catch (e) {
      showToast(e.response?.data?.error || '充值失败', 'error');
    }
    setActionLoading(false);
  };

  const formatDate = (str) => {
    if (!str) return '-';
    const d = new Date(str);
    return isNaN(d.getTime()) ? String(str) : d.toLocaleString('zh-CN');
  };

  const totalRechargeThisMonth = records
    .filter(r => r.type === 'recharge' && isCurrentMonth(r.created_at))
    .reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const totalConsumeThisMonth = records
    .filter(r => r.type === 'consume' && isCurrentMonth(r.created_at))
    .reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="w-6 h-6 text-primary" />
            计费中心
          </h1>
          <p className="text-sm text-muted-foreground mt-1">余额管理、充值、账单查询与日志</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowLogs(s => !s)}>
            <Terminal className="w-4 h-4 mr-1" />
            {showLogs ? '隐藏日志' : '操作日志'}
          </Button>
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={loading}>
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Balance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-5">
          <div className="text-xs text-muted-foreground">{selectedWs?.name || 'Workspace'}</div>
          <div className="text-sm text-muted-foreground mt-0.5">Workspace 可用余额</div>
          <div className="text-3xl font-bold text-primary mt-1">¥{formatCurrency(selectedWs?.balance)}</div>
        </Card>
        <Card className="p-5">
          <div className="text-xs text-muted-foreground">{user?.username || '当前登录账户'}</div>
          <div className="text-sm text-muted-foreground mt-0.5">账户独立余额</div>
          <div className="text-3xl font-bold text-indigo-600 mt-1">¥{(userBalance || 0).toFixed(2)}</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-muted-foreground">本月充值</div>
          <div className="text-2xl font-bold truncate text-emerald-600 mt-1">¥{totalRechargeThisMonth.toFixed(2)}</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-muted-foreground">本月消费</div>
          <div className="text-2xl font-bold truncate text-red-500 mt-1">¥{totalConsumeThisMonth.toFixed(2)}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Recharge + Workspace selector */}
        <Card className="p-5 lg:col-span-1">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            快速充值
          </h3>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">充值目标</label>
              <div className="flex items-center gap-2 bg-muted/40 rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => setRechargeTarget('workspace')}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                    rechargeTarget === 'workspace' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  Workspace 余额
                </button>
                <button
                  type="button"
                  onClick={() => setRechargeTarget('account')}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                    rechargeTarget === 'account' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  账户独立余额
                </button>
              </div>
            </div>
            {rechargeTarget === 'workspace' ? (
              <>
                <div className="rounded-lg bg-primary/5 p-3 text-center ring-2 ring-primary">
                  <div className="text-xs text-muted-foreground">{selectedWs?.name || 'Workspace'}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">当前 Workspace 余额</div>
                  <div className="text-xl font-bold text-primary mt-1">¥{formatCurrency(selectedWs?.balance)}</div>
                </div>
                <SearchableSelect
                  label="选择 Workspace"
                  placeholder="搜索 Workspace 名称 / ID"
                  options={workspaces}
                  value={selectedWs?.id}
                  onChange={w => { setSelectedWs(w); setRecordsPage(1); }}
                  getValue={w => w.id}
                  getLabel={w => `${w.name} (ID: ${w.id})`}
                />
              </>
            ) : (
              <>
                <div className="rounded-lg bg-primary/5 p-3 text-center ring-2 ring-primary">
                  <div className="text-xs text-muted-foreground">{selectedUser?.username || '当前用户'}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">账户独立余额</div>
                  <div className="text-xl font-bold text-indigo-600 mt-1">¥{(selectedUserBalance || 0).toFixed(2)}</div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    不关联 Workspace，仅充值账户独立余额
                  </div>
                </div>
                <SearchableSelect
                  label="选择用户"
                  placeholder="搜索用户名 / ID"
                  options={users}
                  value={selectedUser?.id}
                  onChange={u => setSelectedUser(u)}
                  getValue={u => u.id}
                  getLabel={u => `${u.username} (ID: ${u.id})`}
                  disabled={users.length === 0}
                />
              </>
            )}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">充值金额</label>
              <Input
                type="number" step="0.01" min="0.01"
                placeholder="输入金额"
                value={rechargeAmount}
                onChange={e => setRechargeAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {[10, 50, 100, 500].map(amt => (
                <Button key={amt} variant="outline" size="sm" onClick={() => setRechargeAmount(String(amt))}>
                  ¥{amt}
                </Button>
              ))}
            </div>
            <Button className="w-full" disabled={actionLoading || !rechargeAmount} onClick={recharge}>
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Landmark className="w-4 h-4 mr-2" />}
              快速充值
            </Button>
          </div>
        </Card>

        {/* Records Table */}
        <Card className="overflow-hidden lg:col-span-2">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <History className="w-5 h-5" />
              账单流水
            </h3>
            <span className="text-sm text-muted-foreground">共 {recordsTotal} 条</span>
          </div>
          <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">时间</th>
                  <th className="px-4 py-3 text-left font-medium">类型</th>
                  <th className="px-4 py-3 text-left font-medium">金额</th>
                  <th className="px-4 py-3 text-left font-medium">Workspace 余额</th>
                  <th className="px-4 py-3 text-left font-medium">账户余额</th>
                  <th className="px-4 py-3 text-left font-medium">说明</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">暂无记录</td></tr>
                ) : records.map(r => (
                  <tr key={r.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(r.created_at)}</td>
                    <td className="px-4 py-3">
                      <Badge variant={r.type === 'recharge' ? 'default' : r.type === 'refund' ? 'outline' : 'secondary'}>
                        {r.type === 'recharge' ? '充值' : r.type === 'refund' ? '退款' : r.type === 'consume' ? '消费' : r.type}
                      </Badge>
                    </td>
                    <td className={cn("px-4 py-3 font-medium", r.type === 'recharge' ? 'text-emerald-600' : r.type === 'refund' ? 'text-blue-600' : 'text-red-600')}>
                      {r.type === 'recharge' ? '+' : r.type === 'refund' ? '-' : '-'}{r.amount}
                    </td>
                    <td className="px-4 py-3">¥{formatCurrency(r.balance_after)}</td>
                    <td className="px-4 py-3">¥{formatCurrency(r.user_balance_after)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.description || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {recordsTotal > 20 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="text-sm text-muted-foreground">第 {recordsPage} 页</div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setRecordsPage(p => Math.max(1, p - 1))} disabled={recordsPage <= 1}><ChevronLeft className="w-4 h-4" /></Button>
                <Button size="sm" variant="outline" onClick={() => setRecordsPage(p => p + 1)} disabled={records.length < 20}><ChevronRight className="w-4 h-4" /></Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Operation Logs */}
      {showLogs && (
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              操作日志
            </h3>
            <span className="text-sm text-muted-foreground">共 {logsTotal} 条</span>
          </div>
          <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">时间</th>
                  <th className="px-4 py-3 text-left font-medium">操作</th>
                  <th className="px-4 py-3 text-left font-medium">数据</th>
                </tr>
              </thead>
              <tbody>
                {logsLoading ? (
                  <tr><td colSpan={3} className="px-4 py-12 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />加载中…</td></tr>
                ) : logs.length === 0 ? (
                  <tr><td colSpan={3} className="px-4 py-12 text-center text-muted-foreground">暂无日志</td></tr>
                ) : logs.map(l => (
                  <tr key={l.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(l.created_at)}</td>
                    <td className="px-4 py-3">
                      <Badge variant={l.action === 'admin_recharge' ? 'success' : 'secondary'}>
                        {LOG_ACTION_LABELS[l.action] || l.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{l.data || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {logsTotal > 20 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="text-sm text-muted-foreground">第 {logsPage} 页</div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setLogsPage(p => Math.max(1, p - 1))} disabled={logsPage <= 1}><ChevronLeft className="w-4 h-4" /></Button>
                <Button size="sm" variant="outline" onClick={() => setLogsPage(p => p + 1)} disabled={logs.length < 20}><ChevronRight className="w-4 h-4" /></Button>
              </div>
            </div>
          )}
        </Card>
      )}

    </div>
  );
}
