import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileText,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  AlertCircle,
  CheckCircle,
  Loader2,
  Trash2,
  CreditCard,
  Download,
  Check,
} from 'lucide-react';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import api from '../lib/api';
import { cn } from '../lib/utils';
import { useAuth } from '../hooks/useAuth';

const ORDER_STATUSES = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待支付' },
  { value: 'paid', label: '已支付' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '已过期' },
];

const CHANNELS = [
  { value: '', label: '全部渠道' },
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信支付' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'mock', label: 'Mock' },
];

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      className={cn(
        'fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium',
        type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
      )}
    >
      {type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
      {message}
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function DeleteConfirmModal({ order, countdown, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-background rounded-xl shadow-2xl border w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-destructive" />
            <h2 className="text-lg font-semibold">确认删除订单</h2>
          </div>
          <button onClick={onCancel} className="p-1.5 rounded-md hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            订单删除后不可恢复。请确认是否删除订单{' '}
            <span className="font-mono font-medium text-foreground">#{order?.id}</span>？
          </p>
          <div className="text-xs text-muted-foreground">
            {countdown > 0 ? `请等待 ${countdown} 秒后再确认` : '现在可以确认删除'}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onCancel}>
              取消
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={onConfirm}
              disabled={countdown > 0}
            >
              确认删除
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getInvoiceToastMessage(invoice) {
  if (invoice.status === 'issued' && invoice.invoice_no) {
    return `已开票：${invoice.invoice_no}`;
  }
  if (invoice.review_status === 'pending' || invoice.status === 'pending') {
    return '开票申请已提交，等待审核通过';
  }
  return '开票申请已提交';
}

function InvoiceProcessingModal({ open }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <style>{`
        @keyframes invoice-load {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(0%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
      <div className="bg-background rounded-xl shadow-2xl border w-full max-w-sm p-6 text-center space-y-4">
        <div className="flex justify-center">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
        </div>
        <h2 className="text-lg font-semibold">发票开具中</h2>
        <p className="text-sm text-muted-foreground">正在连接税务数字系统，请稍候…</p>
        <div className="h-2 w-full bg-muted rounded-full overflow-hidden relative">
          <div
            className="absolute inset-y-0 left-0 w-1/2 bg-primary rounded-full"
            style={{ animation: 'invoice-load 2.5s ease-in-out infinite' }}
          />
        </div>
        <p className="text-xs text-muted-foreground">预计等待 3 ~ 5 秒</p>
      </div>
    </div>
  );
}

export default function Orders() {
  const { token } = useAuth();
  const [orders, setOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const showToast = (message, type = 'success') => setToast({ message, type });

  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(30);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [selectedOrderIds, setSelectedOrderIds] = useState([]);

  const [invoicePage, setInvoicePage] = useState(1);
  const [invoiceTotalPages, setInvoiceTotalPages] = useState(1);
  const [invoiceTotal, setInvoiceTotal] = useState(0);

  const [deleteModalOrder, setDeleteModalOrder] = useState(null);
  const [deleteCountdown, setDeleteCountdown] = useState(3);
  const [invoiceProcessing, setInvoiceProcessing] = useState(false);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit };
      if (status) params.status = status;
      if (channel) params.channel = channel;
      if (workspaceId) params.workspace_id = workspaceId;

      const res = await api.get('/billing/admin/orders', { params });
      const data = res.data || {};
      setOrders(data.orders || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || Math.ceil((data.total || 0) / limit));
      setSelectedOrderIds([]);
    } catch (err) {
      showToast(err.response?.data?.error || '获取订单失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [status, channel, workspaceId, page, limit]);

  const fetchInvoices = useCallback(async () => {
    setInvoiceLoading(true);
    try {
      const res = await api.get('/billing/invoices', { params: { page: invoicePage, limit: 20 } });
      const data = res.data || {};
      setInvoices(data.invoices || []);
      setInvoiceTotal(data.total || 0);
      setInvoiceTotalPages(data.totalPages || 1);
    } catch (err) {
      showToast(err.response?.data?.error || '获取开票日志失败', 'error');
    } finally {
      setInvoiceLoading(false);
    }
  }, [invoicePage]);

  useEffect(() => {
    fetchOrders();
    fetchInvoices();
  }, [fetchOrders, fetchInvoices]);

  // SSE: real-time invoice status updates
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(`/api/billing/invoices/stream?token=${encodeURIComponent(token)}`);
    es.addEventListener('invoice:updated', () => { fetchInvoices(); });
    es.addEventListener('invoice:created', () => { fetchInvoices(); });
    es.onerror = (e) => { console.error('[SSE] invoice stream error', e); };
    return () => { es.close(); };
  }, [token, fetchInvoices]);

  useEffect(() => {
    if (!deleteModalOrder) return;
    setDeleteCountdown(3);
    const timer = setInterval(() => {
      setDeleteCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [deleteModalOrder]);

  const withInvoiceDelay = async (fn) => {
    setInvoiceProcessing(true);
    const delay = 3000 + Math.floor(Math.random() * 2000); // 3-5s
    await new Promise(r => setTimeout(r, delay));
    try {
      await fn();
    } finally {
      setInvoiceProcessing(false);
    }
  };

  const handleAction = async (id, action) => {
    setActionLoading(`${action}-${id}`);
    try {
      if (action === 'invoice') {
        await withInvoiceDelay(async () => {
          const res = await api.post(`/billing/admin/orders/${id}/invoice`);
          showToast(getInvoiceToastMessage(res.data.invoice));
        });
      } else if (action === 'delete') {
        await api.delete(`/billing/admin/orders/${id}`);
        showToast('订单已删除');
      } else if (action === 'cancel') {
        await api.post(`/billing/admin/orders/${id}/cancel`);
        showToast('订单已取消');
      }
      await fetchOrders();
      await fetchInvoices();
    } catch (err) {
      showToast(err.response?.data?.error || '操作失败', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const toggleSelectOrder = (id) => {
    setSelectedOrderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleSelectAll = () => {
    if (selectedOrderIds.length === orders.length) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(orders.map((o) => o.id));
    }
  };

  const runBatch = async (action) => {
    const ids = selectedOrderIds;
    if (ids.length === 0) return showToast('请先选择订单', 'error');
    setBatchLoading(true);
    try {
      let res;
      if (action === 'cancel') res = await api.post('/billing/admin/orders/batch-cancel', { ids });
      else if (action === 'invoice') {
        await withInvoiceDelay(async () => {
          res = await api.post('/billing/admin/orders/batch-invoice', { ids });
        });
      }
      else if (action === 'delete') res = await api.post('/billing/admin/orders/batch-delete', { ids });
      showToast(
        action === 'cancel'
          ? `已取消 ${res.data.cancelled} 个订单`
          : action === 'invoice'
          ? `开票完成：${res.data.results.filter((r) => r.success).length} / ${ids.length}（审核通过后生成文件）`
          : `已删除 ${res.data.deleted} 个订单`
      );
      setSelectedOrderIds([]);
      await fetchOrders();
      await fetchInvoices();
    } catch (err) {
      showToast(err.response?.data?.error || '批量操作失败', 'error');
    } finally {
      setBatchLoading(false);
    }
  };

  const handleRetryInvoice = async (id) => {
    setActionLoading(`invoice-retry-${id}`);
    try {
      const res = await api.post(`/billing/admin/invoices/${id}/retry`);
      showToast(`发票重试成功：${res.data.invoice.invoice_no}`);
      await fetchInvoices();
    } catch (err) {
      showToast(err.response?.data?.error || '重试失败', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReviewInvoice = async (id, action) => {
    setActionLoading(`invoice-review-${id}`);
    let reason = '';
    if (action === 'reject') {
      reason = window.prompt('请输入拒绝原因', '审核未通过') || '审核未通过';
    }
    try {
      const res = await api.post(`/billing/admin/invoices/${id}/review`, { action, reason });
      showToast(action === 'approve' ? '发票已通过审核' : '发票已拒绝');
      await fetchInvoices();
    } catch (err) {
      showToast(err.response?.data?.error || '审核失败', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDownloadInvoice = (inv) => {
    if (!inv.invoice_url) return showToast('发票文件未生成', 'error');
    if (inv.status === 'removed') return showToast('发票文件已过期', 'error');
    window.open('/api' + inv.invoice_url + '?token=' + encodeURIComponent(token), '_blank');
  };

  const formatDate = (str) => {
    if (!str) return '-';
    const d = new Date(str);
    return isNaN(d.getTime()) ? String(str) : d.toLocaleString('zh-CN');
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'pending':
        return <Badge variant="warning">待支付</Badge>;
      case 'paid':
        return <Badge variant="success">已支付</Badge>;
      case 'cancelled':
        return <Badge variant="secondary">已取消</Badge>;
      case 'expired':
        return <Badge variant="destructive">已过期</Badge>;
      case 'removed':
        return <Badge variant="secondary">已移除</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const invoiceMap = useMemo(() => {
    const map = {};
    invoices.forEach((inv) => { if (inv.order_id) map[inv.order_id] = inv; });
    return map;
  }, [invoices]);

  const getInvoiceStatusBadge = (status) => {
    switch (status) {
      case 'issued':
        return <Badge variant="success">已开票</Badge>;
      case 'failed':
        return <Badge variant="destructive">失败</Badge>;
      case 'rejected':
        return <Badge variant="outline">已拒绝</Badge>;
      case 'removed':
        return <Badge variant="secondary">已移除</Badge>;
      default:
        return <Badge variant="secondary">待处理</Badge>;
    }
  };

  const getInvoiceReviewStatusBadge = (status) => {
    switch (status) {
      case 'approved':
        return <Badge variant="success">已通过</Badge>;
      case 'rejected':
        return <Badge variant="destructive">已拒绝</Badge>;
      default:
        return <Badge variant="warning">审核中</Badge>;
    }
  };

  const formatChannel = (ch) => {
    const found = CHANNELS.find((c) => c.value === ch);
    return found ? found.label : ch || '-';
  };

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <InvoiceProcessingModal open={invoiceProcessing} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" />
            订单管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">查看并管理所有 Workspace 的充值订单</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { fetchOrders(); fetchInvoices(); }} disabled={loading || invoiceLoading}>
          <RefreshCw className={cn('w-4 h-4', (loading || invoiceLoading) && 'animate-spin')} />
        </Button>
      </div>

      {/* Orders Table */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <FileText className="w-5 h-5" />
              订单列表
            </h3>
            <span className="text-sm text-muted-foreground">共 {total} 条</span>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-36">
              <label className="text-xs text-muted-foreground mb-1 block">状态</label>
              <select
                value={status}
                onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                className="h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                {ORDER_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="w-full sm:w-36">
              <label className="text-xs text-muted-foreground mb-1 block">支付渠道</label>
              <select
                value={channel}
                onChange={(e) => { setChannel(e.target.value); setPage(1); }}
                className="h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="w-full sm:w-48">
              <label className="text-xs text-muted-foreground mb-1 block">Workspace ID</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="number"
                  placeholder="输入 Workspace ID"
                  value={workspaceId}
                  onChange={(e) => { setWorkspaceId(e.target.value); setPage(1); }}
                  className="pl-8 h-9"
                />
              </div>
            </div>
          </div>
        </div>

        {selectedOrderIds.length > 0 && (
          <div className="px-5 py-2 border-b bg-muted/30 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">已选 {selectedOrderIds.length} 项</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => runBatch('cancel')} disabled={batchLoading}>
              {batchLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <X className="w-3 h-3 mr-1" />}
              批量取消
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => runBatch('invoice')} disabled={batchLoading}>
              {batchLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CreditCard className="w-3 h-3 mr-1" />}
              批量开票
            </Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => runBatch('delete')} disabled={batchLoading}>
              {batchLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
              批量删除
            </Button>
          </div>
        )}

        <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-3 text-left font-medium w-10">
                  <input
                    type="checkbox"
                    checked={orders.length > 0 && selectedOrderIds.length === orders.length}
                    onChange={toggleSelectAll}
                    className="rounded border-input"
                  />
                </th>
                <th className="px-3 py-3 text-left font-medium">ID</th>
                <th className="px-3 py-3 text-left font-medium">订单号</th>
                <th className="px-3 py-3 text-left font-medium">Workspace</th>
                <th className="px-3 py-3 text-left font-medium">用户</th>
                <th className="px-3 py-3 text-left font-medium">渠道</th>
                <th className="px-3 py-3 text-left font-medium">金额</th>
                <th className="px-3 py-3 text-left font-medium">状态</th>
                <th className="px-3 py-3 text-left font-medium">发票</th>
                <th className="px-3 py-3 text-left font-medium">创建时间</th>
                <th className="px-3 py-3 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-muted-foreground">
                    暂无订单
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  const inv = invoiceMap[order.id];
                  return (
                  <tr key={order.id} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selectedOrderIds.includes(order.id)}
                        onChange={() => toggleSelectOrder(order.id)}
                        className="rounded border-input"
                      />
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{order.id}</td>
                    <td className="px-3 py-3 whitespace-nowrap font-mono text-muted-foreground">{order.trade_no}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {order.workspace_name || '-'}
                      {order.workspace_id ? <span className="text-xs text-muted-foreground ml-1">({order.workspace_id})</span> : null}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{order.user_name || '-'}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{formatChannel(order.channel)}</td>
                    <td className="px-3 py-3 whitespace-nowrap font-medium">¥{Number(order.amount).toFixed(2)}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{getStatusBadge(order.status)}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {inv ? (
                        <div className="space-y-0.5">
                          {getInvoiceStatusBadge(inv.status)}
                          {inv.invoice_no && <div className="text-[10px] text-muted-foreground font-mono">{inv.invoice_no}</div>}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">{formatDate(order.created_at)}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1 flex-wrap">
                        {order.status === 'pending' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={actionLoading === `cancel-${order.id}`}
                            onClick={() => handleAction(order.id, 'cancel')}
                          >
                            {actionLoading === `cancel-${order.id}` ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                            取消
                          </Button>
                        )}
                        {order.status === 'paid' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={actionLoading === `invoice-${order.id}` || inv?.status === 'issued'}
                            onClick={() => handleAction(order.id, 'invoice')}
                          >
                            {actionLoading === `invoice-${order.id}` ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CreditCard className="w-3 h-3 mr-1" />}
                            开票
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          disabled={actionLoading === `delete-${order.id}`}
                          onClick={() => setDeleteModalOrder(order)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );})
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <div className="text-sm text-muted-foreground">
              第 {page} / {totalPages} 页
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Invoice Log */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            开票日志
          </h3>
          <span className="text-sm text-muted-foreground">共 {invoiceTotal} 条</span>
        </div>
        <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 text-left font-medium">ID</th>
                <th className="px-4 py-3 text-left font-medium">订单号</th>
                <th className="px-4 py-3 text-left font-medium">Workspace</th>
                <th className="px-4 py-3 text-left font-medium">金额</th>
                <th className="px-4 py-3 text-left font-medium">开票状态</th>
                <th className="px-4 py-3 text-left font-medium">审核状态</th>
                <th className="px-4 py-3 text-left font-medium">发票号</th>
                <th className="px-4 py-3 text-left font-medium">创建时间</th>
                <th className="px-4 py-3 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">
                    暂无开票记录
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3">{inv.id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{inv.trade_no || '-'}</td>
                    <td className="px-4 py-3">{inv.workspace_name || '-'}</td>
                    <td className="px-4 py-3">¥{Number(inv.amount).toFixed(2)}</td>
                    <td className="px-4 py-3">{getInvoiceStatusBadge(inv.status)}</td>
                    <td className="px-4 py-3">{getInvoiceReviewStatusBadge(inv.review_status)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{inv.invoice_no || '-'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(inv.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 flex-wrap">
                        {inv.status === 'pending' && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={actionLoading === `invoice-review-${inv.id}`}
                              onClick={() => handleReviewInvoice(inv.id, 'approve')}
                            >
                              {actionLoading === `invoice-review-${inv.id}` ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Check className="w-3 h-3 mr-1" />}
                              通过
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 px-2 text-xs"
                              disabled={actionLoading === `invoice-review-${inv.id}`}
                              onClick={() => handleReviewInvoice(inv.id, 'reject')}
                            >
                              拒绝
                            </Button>
                          </>
                        )}
                        {inv.status === 'failed' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={actionLoading === `invoice-retry-${inv.id}`}
                            onClick={() => handleRetryInvoice(inv.id)}
                          >
                            {actionLoading === `invoice-retry-${inv.id}` ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                            重试
                          </Button>
                        )}
                        {inv.status === 'issued' && inv.invoice_url && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleDownloadInvoice(inv)}
                          >
                            <Download className="w-3 h-3 mr-1" />
                            下载
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {invoiceTotalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <div className="text-sm text-muted-foreground">
              第 {invoicePage} / {invoiceTotalPages} 页
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setInvoicePage((p) => Math.max(1, p - 1))}
                disabled={invoicePage <= 1 || invoiceLoading}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setInvoicePage((p) => Math.min(invoiceTotalPages, p + 1))}
                disabled={invoicePage >= invoiceTotalPages || invoiceLoading}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {deleteModalOrder && (
        <DeleteConfirmModal
          order={deleteModalOrder}
          countdown={deleteCountdown}
          onCancel={() => setDeleteModalOrder(null)}
          onConfirm={() => { handleAction(deleteModalOrder.id, 'delete'); setDeleteModalOrder(null); }}
        />
      )}
    </div>
  );
}
