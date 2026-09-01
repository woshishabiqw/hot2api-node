import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Receipt,
  RefreshCw,
  Search,
  Download,
  Check,
  X,
  Loader2,
  AlertCircle,
  CheckCircle,
  Settings2,
  RotateCcw,
  FileText,
  Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/Card';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import api from '../lib/api';
import { cn } from '../lib/utils';
import { useAuth } from '../hooks/useAuth';

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className={cn(
      'fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium',
      type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
    )}>
      {type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
      {message}
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}

function ReviewModal({ invoice, onClose, onConfirm, action, reason, setReason, loading, error }) {
  if (!invoice) return null;
  const isReject = action === 'reject';
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-background rounded-xl shadow-2xl border w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            {isReject ? <X className="w-5 h-5 text-destructive" /> : <Check className="w-5 h-5 text-emerald-500" />}
            <h2 className="text-lg font-semibold">{isReject ? '拒绝发票' : '通过发票'}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            发票 <span className="font-mono font-medium text-foreground">#{invoice.id}</span>
            {invoice.invoice_no ? ` (${invoice.invoice_no})` : ''}
          </p>
          {isReject && (
            <div className="space-y-2">
              <label className="text-sm font-medium">拒绝原因（1~2000 字）</label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="请输入拒绝原因"
                rows={4}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              />
              <div className="flex items-center justify-between text-xs">
                <span className={cn('text-muted-foreground', reason.length > 2000 && 'text-destructive')}>{reason.length} / 2000</span>
                {error && <span className="text-destructive">{error}</span>}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>取消</Button>
            <Button className="flex-1" variant={isReject ? 'destructive' : 'default'} onClick={onConfirm} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              确认
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatMoney(amount) {
  return Number(amount || 0).toFixed(2);
}

function formatFileExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function hoursUntilExpiry(iso) {
  if (!iso) return Infinity;
  const ms = new Date(iso).getTime() - Date.now();
  return ms / (1000 * 60 * 60);
}

const INVOICE_STATUSES = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待处理' },
  { value: 'issued', label: '已开具' },
  { value: 'failed', label: '失败' },
  { value: 'rejected', label: '已拒绝' },
];

const REVIEW_STATUSES = [
  { value: '', label: '全部审核状态' },
  { value: 'pending', label: '审核中' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已拒绝' },
];

export default function InvoiceManager() {
  const { token } = useAuth();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewFilter, setReviewFilter] = useState('');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState(null);
  const [mode, setMode] = useState('auto');
  const [modeLoading, setModeLoading] = useState(false);
  const [reviewModal, setReviewModal] = useState(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const PAGE_SIZE = 20;

  const showToast = (message, type = 'success') => setToast({ message, type });

  const fetchInvoices = useCallback(async (p = page) => {
    setLoading(true);
    try {
      const res = await api.get('/billing/invoices', {
        params: {
          page: p,
          limit: PAGE_SIZE,
          status: statusFilter,
          review_status: reviewFilter,
        }
      });
      setInvoices(res.data?.invoices || []);
      setTotal(res.data?.total || 0);
      setTotalPages(res.data?.totalPages || 1);
      setPage(res.data?.page || p);
    } catch (e) {
      showToast(e.response?.data?.error || '获取发票列表失败', 'error');
    }
    setLoading(false);
  }, [page, statusFilter, reviewFilter]);

  const fetchMode = useCallback(async () => {
    try {
      const res = await api.get('/billing/admin/invoice-settings');
      setMode(res.data?.mode || 'auto');
    } catch (e) {
      console.error('Failed to fetch invoice review mode:', e);
    }
  }, []);

  const fetchAuditLogs = useCallback(async (p = auditPage) => {
    setAuditLoading(true);
    try {
      const res = await api.get('/billing/admin/invoices/audit-log', {
        params: { page: p, limit: PAGE_SIZE }
      });
      setAuditLogs(res.data?.logs || []);
      setAuditTotalPages(res.data?.totalPages || 1);
      setAuditPage(res.data?.page || p);
    } catch (e) {
      console.error('Failed to fetch audit logs:', e);
    }
    setAuditLoading(false);
  }, [auditPage]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  useEffect(() => {
    fetchMode();
    fetchAuditLogs();
  }, [fetchMode, fetchAuditLogs]);

  // SSE: real-time invoice status updates with auto reconnect
  useEffect(() => {
    if (!token) return;
    let es = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000;
    const connect = () => {
      es = new EventSource(`/api/billing/invoices/stream?token=${encodeURIComponent(token)}`);
      es.addEventListener('invoice:updated', () => { fetchInvoices(); });
      es.addEventListener('invoice:created', () => { fetchInvoices(); });
      es.onopen = () => { reconnectDelay = 2000; };
      es.onerror = () => {
        if (es) es.close();
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      };
    };
    connect();
    return () => {
      clearTimeout(reconnectTimer);
      if (es) es.close();
    };
  }, [token, fetchInvoices]);

  const filteredInvoices = useMemo(() => {
    if (!search.trim()) return invoices;
    const q = search.trim().toLowerCase();
    return invoices.filter(inv =>
      String(inv.id).includes(q) ||
      (inv.invoice_no || '').toLowerCase().includes(q) ||
      (inv.trade_no || '').toLowerCase().includes(q) ||
      (inv.user_name || '').toLowerCase().includes(q) ||
      (inv.workspace_name || '').toLowerCase().includes(q)
    );
  }, [invoices, search]);

  const handleModeChange = async (newMode) => {
    setModeLoading(true);
    try {
      const res = await api.post('/billing/admin/invoice-settings', { mode: newMode });
      setMode(res.data?.mode || newMode);
      showToast(`已切换为 ${newMode === 'auto' ? '自动审核' : '仅手动审核'}`);
      fetchAuditLogs(1);
    } catch (e) {
      showToast(e.response?.data?.error || '切换模式失败', 'error');
    }
    setModeLoading(false);
  };

  const handleReview = async () => {
    if (!reviewModal) return;
    setReviewError('');
    if (reviewModal.action === 'reject') {
      const len = reviewReason.trim().length;
      if (len < 1 || len > 2000) {
        setReviewError('拒绝说明必须为 1~2000 字');
        return;
      }
    }
    setReviewLoading(true);
    try {
      const res = await api.post(`/billing/admin/invoices/${reviewModal.id}/review`, {
        action: reviewModal.action,
        reason: reviewReason,
      });
      showToast(`发票 #${res.data.invoice.id} ${reviewModal.action === 'approve' ? '已通过' : '已拒绝'}`);
      setReviewModal(null);
      setReviewReason('');
      fetchInvoices();
      fetchAuditLogs(1);
    } catch (e) {
      showToast(e.response?.data?.error || '审核失败', 'error');
    }
    setReviewLoading(false);
  };

  const handleRetry = async (invoice) => {
    try {
      const res = await api.post(`/billing/admin/invoices/${invoice.id}/retry`);
      showToast(`发票 #${res.data.invoice.id} 重试成功`);
      fetchInvoices();
      fetchAuditLogs(1);
    } catch (e) {
      showToast(e.response?.data?.error || '重试失败', 'error');
    }
  };

  const handleDownload = (invoice) => {
    if (!invoice.invoice_url) return showToast('发票文件未生成', 'error');
    if (invoice.status === 'removed') return showToast('发票文件已过期', 'error');
    const liveToken = localStorage.getItem('token') || token;
    window.open('/api' + invoice.invoice_url + '?token=' + encodeURIComponent(liveToken), '_blank');
  };

  const statusBadge = (status) => {
    switch (status) {
      case 'issued': return { variant: 'success', label: '已开具' };
      case 'failed': return { variant: 'destructive', label: '失败' };
      case 'rejected': return { variant: 'outline', label: '已拒绝' };
      case 'removed': return { variant: 'secondary', label: '已移除' };
      default: return { variant: 'secondary', label: '待处理' };
    }
  };

  const reviewBadge = (status) => {
    switch (status) {
      case 'approved': return { variant: 'success', label: '已通过' };
      case 'rejected': return { variant: 'destructive', label: '已拒绝' };
      default: return { variant: 'warning', label: '审核中' };
    }
  };

  return (
    <div className="space-y-6">
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: hsl(var(--muted)); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: hsl(var(--muted-foreground) / 0.3); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: hsl(var(--muted-foreground) / 0.5); }
      `}</style>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <ReviewModal
        invoice={reviewModal}
        action={reviewModal?.action}
        reason={reviewReason}
        setReason={setReviewReason}
        onClose={() => { setReviewModal(null); setReviewReason(''); setReviewError(''); }}
        onConfirm={handleReview}
        loading={reviewLoading}
        error={reviewError}
      />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Receipt className="w-8 h-8" />
            发票管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">管理发票审核、下载、重试与审计日志</p>
        </div>
        <Button variant="outline" onClick={() => { fetchInvoices(1); fetchMode(); fetchAuditLogs(1); }} disabled={loading}>
          <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            审核模式
          </CardTitle>
          <CardDescription>默认自动审核（3~5 秒），可切换为仅手动审核</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-muted/40 rounded-lg p-1">
              <button
                onClick={() => handleModeChange('auto')}
                disabled={modeLoading || mode === 'auto'}
                className={cn(
                  'px-4 py-2 rounded-md text-sm font-medium transition-colors',
                  mode === 'auto' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                )}
              >
                自动审核
              </button>
              <button
                onClick={() => handleModeChange('manual')}
                disabled={modeLoading || mode === 'manual'}
                className={cn(
                  'px-4 py-2 rounded-md text-sm font-medium transition-colors',
                  mode === 'manual' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                )}
              >
                仅手动审核
              </button>
            </div>
            {modeLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            <span className="text-sm text-muted-foreground">
              当前模式：<span className="font-medium text-foreground">{mode === 'auto' ? '自动审核' : '仅手动审核'}</span>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              发票列表
              <span className="text-sm font-normal text-muted-foreground">共 {total} 条</span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="搜索发票号 / 订单号 / 用户 / Workspace"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9 w-72"
                />
              </div>
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                {INVOICE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <select
                value={reviewFilter}
                onChange={e => { setReviewFilter(e.target.value); setPage(1); }}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                {REVIEW_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && invoices.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" /> 加载中…
            </div>
          ) : filteredInvoices.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center bg-muted/30 rounded-md">暂无发票记录</div>
          ) : (
            <div className="overflow-x-auto overflow-y-auto max-h-[420px] -mx-6 px-6 custom-scrollbar">
              <table className="w-full text-sm min-w-[1100px]">
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">ID</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">发票号</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">订单号</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">Workspace</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">用户</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">金额</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">状态</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">审核状态</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">审核操作</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">创建时间</th>
                    <th className="pb-2 pr-4 font-medium whitespace-nowrap">文件有效期</th>
                    <th className="pb-2 font-medium whitespace-nowrap text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredInvoices.map(inv => {
                    const s = statusBadge(inv.status);
                    const r = reviewBadge(inv.review_status);
                    return (
                      <tr key={inv.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{inv.id}</td>
                        <td className="py-3 pr-4 font-mono text-xs">{inv.invoice_no || '-'}</td>
                        <td className="py-3 pr-4 font-mono text-xs">{inv.trade_no || '-'}</td>
                        <td className="py-3 pr-4">{inv.workspace_name || '-'}</td>
                        <td className="py-3 pr-4">{inv.user_name || '-'}</td>
                        <td className="py-3 pr-4 text-right font-medium">¥{formatMoney(inv.amount)}</td>
                        <td className="py-3 pr-4"><Badge variant={s.variant} className="text-[10px] h-5">{s.label}</Badge></td>
                        <td className="py-3 pr-4"><Badge variant={r.variant} className="text-[10px] h-5">{r.label}</Badge></td>
                        <td className="py-3 pr-4">
                          {inv.review_status === 'pending' ? (
                            <div className="flex items-center gap-1">
                              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setReviewModal({ ...inv, action: 'approve' })}>
                                <Check className="w-3 h-3 mr-1" /> 通过
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={() => setReviewModal({ ...inv, action: 'reject' })}>
                                <X className="w-3 h-3 mr-1" /> 拒绝
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground whitespace-nowrap">
                          {inv.created_at ? new Date(inv.created_at).toLocaleString('zh-CN') : '-'}
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap">
                          {inv.status === 'issued' && inv.file_expires_at ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-xs">{formatFileExpiry(inv.file_expires_at)}</span>
                              {hoursUntilExpiry(inv.file_expires_at) <= 24 && (
                                <Badge variant="destructive" className="text-[10px] h-5 w-fit">即将过期</Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {inv.status === 'issued' && inv.review_status === 'approved' && inv.invoice_url ? (
                              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleDownload(inv)}>
                                <Download className="w-3 h-3 mr-1" /> 下载
                              </Button>
                            ) : null}
                            {inv.status === 'failed' ? (
                              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleRetry(inv)}>
                                <RotateCcw className="w-3 h-3 mr-1" /> 重试
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t mt-4">
              <div className="text-xs text-muted-foreground">第 {page} / {totalPages} 页</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || loading}>上一页</Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading}>下一页</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            审核日志
          </CardTitle>
          <CardDescription>记录发票自动开具、人工审核与模式切换事件</CardDescription>
        </CardHeader>
        <CardContent>
          {auditLoading && auditLogs.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" /> 加载中…
            </div>
          ) : auditLogs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center bg-muted/30 rounded-md">暂无审计日志</div>
          ) : (
            <div className="space-y-2 max-h-[360px] overflow-auto pr-1 custom-scrollbar">
              {auditLogs.map(log => (
                <div key={log.id} className="flex items-start justify-between px-4 py-3 rounded-md bg-muted/30 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{log.action}</span>
                      <span className="text-xs text-muted-foreground">#{log.id}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 break-all">
                      {typeof log.data === 'object' ? JSON.stringify(log.data) : String(log.data)}
                    </div>
                  </div>
                  <div className="shrink-0 ml-4 text-xs text-muted-foreground whitespace-nowrap">
                    {log.created_at ? new Date(log.created_at).toLocaleString('zh-CN') : '-'}
                  </div>
                </div>
              ))}
            </div>
          )}
          {auditTotalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t mt-4">
              <div className="text-xs text-muted-foreground">第 {auditPage} / {auditTotalPages} 页</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAuditPage(p => Math.max(1, p - 1))} disabled={auditPage <= 1 || auditLoading}>上一页</Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))} disabled={auditPage >= auditTotalPages || auditLoading}>下一页</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
