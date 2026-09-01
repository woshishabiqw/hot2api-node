import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import {
  Shield, Search, RefreshCw, ChevronLeft, ChevronRight,
  Filter, Eye, User, Calendar, Activity, Database, FileText, Key,
  AlertTriangle, CheckCircle, HelpCircle, Trash2
} from 'lucide-react';
import { cn } from '../lib/utils';
import { showAlert, showConfirm } from '../components/Dialog';
import { formatCurrency } from '../utils/currency';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const ACTION_COLORS = {
  create: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  update: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  delete: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  login: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  logout: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
  test: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  import: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  batch_update: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  batch_delete: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
};

const ACTION_LABELS = {
  create: '创建', update: '更新', delete: '删除',
  login: '登录', logout: '登出', test: '测试',
  import: '导入', batch_update: '批量更新', batch_delete: '批量删除',
};

const RESOURCE_LABELS = {
  source: '源站', model: '模型', model_group: '模型分组',
  user: '用户', key: '密钥', dispatch_rule: '调度规则',
  setting: '设置', system: '系统',
};

const PROTOCOL_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', bedrock: 'Bedrock', relay: '透传' };
const fmtProtocol = (p) => {
  if (!p) return 'OpenAI';
  return p.split('→').map(s => PROTOCOL_NAMES[s] || s).join(' → ');
};

function getPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, '...', total];
  if (current >= total - 3) return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
  return [1, '...', current - 1, current, current + 1, '...', total];
}

export default function AuditLogs() {
  const { token } = useAuth();
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ total: 0, today: 0, byAction: [], byResource: [] });
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [jumpPage, setJumpPage] = useState('');

  const [activeTab, setActiveTab] = useState('audit');
  const [filters, setFilters] = useState({
    action: '',
    resource_type: '',
    search: '',
    start_date: '',
    end_date: '',
  });

  // Transit security scan state
  const [transitLogs, setTransitLogs] = useState([]);
  const [transitTotal, setTransitTotal] = useState(0);
  const [transitTotalPages, setTransitTotalPages] = useState(1);
  const [transitPage, setTransitPage] = useState(1);
  const [transitStatus, setTransitStatus] = useState('');
  const [transitDetail, setTransitDetail] = useState(null);
  const [tokenDetailId, setTokenDetailId] = useState(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/admin/audit-logs/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setStats((await res.json()) || { total: 0, today: 0, byAction: [], byResource: [] });
    } catch (e) { console.error(e); }
  }, [token]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      let url = `${API_URL}/admin/audit-logs`;
      const params = new URLSearchParams();
      params.set('page', page);

      if (activeTab === 'token') {
        url = `${API_URL}/admin/token-logs`;
        params.set('pageSize', limit);
      } else {
        params.set('limit', limit);
      }

      if (activeTab === 'user') {
        url = `${API_URL}/admin/user-logs`;
      }

      if (activeTab === 'audit') {
        if (filters.action) params.set('action', filters.action);
        if (filters.resource_type) params.set('resource_type', filters.resource_type);
        if (filters.search) params.set('search', filters.search);
        if (filters.start_date) params.set('start_date', filters.start_date);
        if (filters.end_date) params.set('end_date', filters.end_date);
      }

      const res = await fetch(`${url}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setLogs(data.logs || []);
      const totalRecords = data.total || 0;
      setTotal(totalRecords);
      setTotalPages(Math.ceil(totalRecords / limit) || 1);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [token, page, limit, filters, activeTab]);

  const fetchTransitScans = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', transitPage);
      params.set('pageSize', limit);
      if (transitStatus) params.set('status', transitStatus);
      const res = await fetch(`${API_URL}/admin/transit-scans?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setTransitLogs(data.logs || []);
      const totalRecords = data.total || 0;
      setTransitTotal(totalRecords);
      setTransitTotalPages(Math.ceil(totalRecords / limit) || 1);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [token, transitPage, limit, transitStatus]);

  useEffect(() => {
    if (activeTab === 'audit') fetchStats();
    if (activeTab === 'transit') {
      fetchTransitScans();
    } else {
      fetchLogs();
    }
  }, [fetchStats, fetchLogs, fetchTransitScans, activeTab]);

  useEffect(() => {
    setPage(1);
  }, [activeTab, limit]);

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const formatDate = (str) => {
    if (!str) return '-';
    const d = new Date(str);
    return isNaN(d.getTime()) ? String(str) : d.toLocaleString('zh-CN');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            日志
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            记录所有管理操作，支持追溯与合规审计
          </p>
        </div>
        <Button variant="outline" onClick={() => { fetchStats(); fetchLogs(); }}>
          <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Database className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-2xl font-bold truncate">{stats?.total || 0}</div>
              <div className="text-xs text-muted-foreground">总日志数</div>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <Calendar className="w-5 h-5 text-emerald-500" />
            </div>
            <div>
              <div className="text-2xl font-bold truncate">{stats.today}</div>
              <div className="text-xs text-muted-foreground">今日日志</div>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Activity className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <div className="text-2xl font-bold truncate">{stats?.byAction?.length || 0}</div>
              <div className="text-xs text-muted-foreground">操作类型</div>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Shield className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <div className="text-2xl font-bold truncate">{stats.byResource?.length || 0}</div>
              <div className="text-xs text-muted-foreground">资源类型</div>
            </div>
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 items-center justify-between">
        <div className="flex gap-2">
          {[
            { key: 'audit', label: '审计日志', icon: Shield },
            { key: 'user', label: '用户日志', icon: User },
            { key: 'token', label: 'Token日志', icon: Key },
          ].map(tab => (
            <Button
              key={tab.key}
              variant={activeTab === tab.key ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setActiveTab(tab.key); setPage(1); setTransitPage(1); setTransitStatus(''); }}
            >
              <tab.icon className="w-4 h-4 mr-1" />
              {tab.label}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:bg-destructive/10"
          onClick={async () => {
            const label = { audit: '审计日志', user: '用户日志', token: 'Token日志' }[activeTab];
            if (!await showConfirm(`确定要清空【${label}】吗？此操作不可恢复。`)) return;
            try {
              const res = await fetch(`${API_URL}/admin/logs/clear`, {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ type: activeTab }),
              });
              const data = await res.json();
              if (res.ok) {
                await showAlert(`已清空 ${data.deleted} 条记录`);
                if (activeTab === 'transit') fetchTransitScans();
                else fetchLogs();
                if (activeTab === 'audit') fetchStats();
              } else {
                await showAlert(data.error || '清空失败');
              }
            } catch (e) {
              console.error(e);
              await showAlert('清空失败');
            }
          }}
        >
          <Trash2 className="w-4 h-4 mr-1" />
          清空日志
        </Button>
      </div>

      {/* Filters */}
      {activeTab === 'audit' && (
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">搜索</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="用户名、资源名..."
                value={filters.search}
                onChange={e => handleFilterChange('search', e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">操作</label>
            <select
              value={filters.action}
              onChange={e => handleFilterChange('action', e.target.value)}
              className="h-10 px-3 rounded-md border border-input bg-background text-sm"
            >
              <option value="">全部</option>
              {Object.entries(ACTION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">资源</label>
            <select
              value={filters.resource_type}
              onChange={e => handleFilterChange('resource_type', e.target.value)}
              className="h-10 px-3 rounded-md border border-input bg-background text-sm"
            >
              <option value="">全部</option>
              {Object.entries(RESOURCE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">开始日期</label>
            <Input
              type="date"
              value={filters.start_date}
              onChange={e => handleFilterChange('start_date', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">结束日期</label>
            <Input
              type="date"
              value={filters.end_date}
              onChange={e => handleFilterChange('end_date', e.target.value)}
            />
          </div>
          <Button variant="outline" onClick={() => { setFilters({ action: '', resource_type: '', search: '', start_date: '', end_date: '' }); setPage(1); }}>
            <Filter className="w-4 h-4 mr-2" />
            重置
          </Button>
        </div>
      </Card>
      )}

      {activeTab !== 'transit' && (
      <>
      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">时间</th>
                {activeTab === 'token' ? (
                  <>
                    <th className="px-4 py-3 text-left font-medium">用户</th>
                    <th className="px-4 py-3 text-left font-medium">模型</th>
                    <th className="px-4 py-3 text-left font-medium">协议</th>
                    <th className="px-4 py-3 text-left font-medium">Tokens</th>
                    <th className="px-4 py-3 text-left font-medium">消费</th>
                    <th className="px-4 py-3 text-left font-medium">耗时</th>
                    <th className="px-4 py-3 text-left font-medium">状态</th>
                    <th className="px-4 py-3 text-left font-medium">链路检测</th>
                    <th className="px-4 py-3 text-left font-medium">源站</th>
                  </>
                ) : (
                  <>
                    <th className="px-4 py-3 text-left font-medium">用户</th>
                    <th className="px-4 py-3 text-left font-medium">操作</th>
                    <th className="px-4 py-3 text-left font-medium">资源</th>
                    <th className="px-4 py-3 text-left font-medium">资源名</th>
                    <th className="px-4 py-3 text-left font-medium">IP</th>
                    <th className="px-4 py-3 text-left font-medium">详情</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={activeTab === 'token' ? 10 : 7} className="px-4 py-12 text-center text-muted-foreground">
                    暂无日志
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDate(log.created_at)}
                    </td>
                    {activeTab === 'token' ? (
                      <>
                        <td className="px-4 py-3 whitespace-nowrap">{log.username || '-'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">{log.model || '-'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">
                          <Badge variant="outline" className="text-xs">{fmtProtocol(log.protocol)}</Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">{log.total_tokens?.toLocaleString() || 0}</td>
                        <td className="px-4 py-3 whitespace-nowrap font-mono">${formatCurrency(log.cost, 8)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">{log.latency_ms ? `${log.latency_ms}ms` : '-'}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge className={cn("text-xs", log.status_code === 200 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>
                            {log.status_code || '-'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <TokenTransitCell log={log} detailId={tokenDetailId} onToggle={setTokenDetailId} />
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">{log.source_name || '-'}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <User className="w-3.5 h-3.5 text-muted-foreground" />
                            <span>{log.username || '-'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge className={cn("text-xs", ACTION_COLORS[log.action] || 'bg-gray-100 text-gray-700')}>
                            {ACTION_LABELS[log.action] || log.action}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          {RESOURCE_LABELS[log.resource_type] || log.resource_type}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {log.resource_name || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground font-mono text-xs">
                          {log.ip_address || '-'}
                        </td>
                        <td className="px-4 py-3">
                          <AuditDetail oldValue={log.old_value} newValue={log.new_value} />
                        </td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              第 {page} / {totalPages} 页，共 {total.toLocaleString()} 条
            </span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              {[20, 50, 100, 200].map((s) => (
                <option key={s} value={s}>{s} 条/页</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            {getPageNumbers(page, totalPages).map((p, i) => (
              p === '...' ? (
                <span key={`dots-${i}`} className="px-1 text-muted-foreground">...</span>
              ) : (
                <Button
                  key={p}
                  size="sm"
                  variant={p === page ? 'default' : 'outline'}
                  onClick={() => setPage(p)}
                  className="w-8 h-8 p-0"
                >
                  {p}
                </Button>
              )
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-1 ml-2">
              <Input
                type="number"
                min={1}
                max={totalPages}
                value={jumpPage}
                onChange={(e) => setJumpPage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const target = Math.max(1, Math.min(totalPages, parseInt(jumpPage) || 1));
                    setPage(target);
                    setJumpPage('');
                  }
                }}
                className="w-16 h-8 text-sm"
                placeholder="页"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => {
                  const target = Math.max(1, Math.min(totalPages, parseInt(jumpPage) || 1));
                  setPage(target);
                  setJumpPage('');
                }}
              >
                跳转
              </Button>
            </div>
          </div>
        </div>
      </Card>
      </>
      )}

      {activeTab === 'transit' && (
        <TransitScanPanel
          token={token}
          logs={transitLogs}
          total={transitTotal}
          page={transitPage}
          totalPages={transitTotalPages}
          pageSize={limit}
          status={transitStatus}
          loading={loading}
          detail={transitDetail}
          onStatusChange={setTransitStatus}
          onPageChange={setTransitPage}
          onDetail={setTransitDetail}
          onRefresh={fetchTransitScans}
        />
      )}
    </div>
  );
}

function TransitScanPanel({ logs, total, page, totalPages, pageSize, status, loading, detail, onStatusChange, onPageChange, onDetail }) {
  const formatDate = (str) => {
    if (!str) return '-';
    const d = new Date(str);
    return isNaN(d.getTime()) ? String(str) : d.toLocaleString('zh-CN');
  };
  const statusConfig = {
    safe: { label: 'Safe', variant: 'success', icon: CheckCircle },
    unknown: { label: 'Unknown', variant: 'secondary', icon: HelpCircle },
    danger: { label: 'Danger', variant: 'destructive', icon: AlertTriangle }
  };

  const handleDetail = (log) => {
    if (detail?.id === log.id) {
      onDetail(null);
    } else {
      onDetail(log);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { key: '', label: '全部' },
            { key: 'safe', label: 'Safe' },
            { key: 'unknown', label: 'Unknown' },
            { key: 'danger', label: 'Danger' }
          ].map(s => {
            const cfg = statusConfig[s.key] || {};
            const Icon = cfg.icon || null;
            return (
              <Button
                key={s.key || 'all'}
                size="sm"
                variant={status === s.key ? 'default' : 'outline'}
                onClick={() => onStatusChange(s.key)}
              >
                {Icon && <Icon className="w-3.5 h-3.5 mr-1" />}
                {s.label}
              </Button>
            );
          })}
          <span className="text-sm text-muted-foreground ml-auto">共 {total.toLocaleString()} 条</span>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">时间</th>
                <th className="px-4 py-3 text-left font-medium">用户</th>
                <th className="px-4 py-3 text-left font-medium">模型</th>
                <th className="px-4 py-3 text-left font-medium">源站</th>
                <th className="px-4 py-3 text-left font-medium">协议</th>
                <th className="px-4 py-3 text-left font-medium">状态</th>
                <th className="px-4 py-3 text-left font-medium">命中规则</th>
                <th className="px-4 py-3 text-left font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">加载中...</td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">暂无链路检测记录</td></tr>
              ) : logs.map((log) => {
                const cfg = statusConfig[log.result] || statusConfig.unknown;
                const Icon = cfg.icon || HelpCircle;
                let matched = [];
                try { matched = JSON.parse(log.matched_rules || '[]'); } catch {}
                return (
                  <tr key={log.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(log.created_at)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{log.username || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">{log.model || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">{log.source_name || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      <Badge variant="outline" className="text-xs">{fmtProtocol(log.protocol)}</Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant={cfg.variant} className="text-xs"><Icon className="w-3 h-3 mr-1" />{cfg.label}</Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">{matched.length > 0 ? matched.map(r => r.name || r.id).join('、') : '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <button onClick={() => handleDetail(log)} className="text-xs text-primary hover:underline flex items-center gap-0.5">
                        <Eye className="w-3.5 h-3.5" />{detail?.id === log.id ? '收起' : '查看'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {detail && (
          <div className="border-t p-4 bg-muted/20">
            <div className="text-sm font-medium mb-2">检测详情 #{detail.id}</div>
            <div className="space-y-2 text-xs font-mono">
              <div><span className="text-muted-foreground">结果：</span>{detail.result}</div>
              <div><span className="text-muted-foreground">说明：</span>{detail.details || '-'}</div>
              {(() => {
                let matched = [];
                try { matched = JSON.parse(detail.matched_rules || '[]'); } catch {}
                return matched.length > 0 ? (
                  <div><span className="text-muted-foreground">命中规则：</span>{matched.map(r => `${r.name} (${r.id})`).join('、')}</div>
                ) : null;
              })()}
              <div><span className="text-muted-foreground">Payload 样例：</span></div>
              <pre className="p-2 rounded bg-muted whitespace-pre-wrap break-all max-h-60 overflow-auto">{detail.payload_sample || '-'}</pre>
            </div>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t">
            <span className="text-sm text-muted-foreground">第 {page} / {totalPages} 页，共 {total.toLocaleString()} 条</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onPageChange(p => Math.max(1, p - 1))} disabled={page <= 1}><ChevronLeft className="w-4 h-4" /></Button>
              {getPageNumbers(page, totalPages).map((p, i) => p === '...' ? (
                <span key={`dots-${i}`} className="px-1 text-muted-foreground">...</span>
              ) : (
                <Button key={p} size="sm" variant={p === page ? 'default' : 'outline'} onClick={() => onPageChange(p)} className="w-8 h-8 p-0">{p}</Button>
              ))}
              <Button variant="outline" size="sm" onClick={() => onPageChange(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}><ChevronRight className="w-4 h-4" /></Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

const tokenStatusConfig = {
  safe: { label: 'Safe', variant: 'success', icon: CheckCircle },
  unknown: { label: 'Unknown', variant: 'secondary', icon: HelpCircle },
  danger: { label: 'Danger', variant: 'destructive', icon: AlertTriangle }
};

function TokenTransitCell({ log, detailId, onToggle }) {
  const result = log.transit_result;
  if (!result) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }
  const cfg = tokenStatusConfig[result] || tokenStatusConfig.unknown;
  const Icon = cfg.icon || HelpCircle;
  const isOpen = detailId === log.id;
  let matched = [];
  try { matched = JSON.parse(log.transit_matched_rules || '[]'); } catch {}
  return (
    <div className="space-y-1">
      <Badge variant={cfg.variant} className="text-xs"><Icon className="w-3 h-3 mr-1" />{cfg.label}</Badge>
      <button
        onClick={() => onToggle(isOpen ? null : log.id)}
        className="block text-xs text-primary hover:underline"
      >
        {isOpen ? '收起' : '查看'}
      </button>
      {isOpen && (
        <div className="text-xs font-mono space-y-1 pt-1">
          <div><span className="text-muted-foreground">结果：</span>{log.transit_result}</div>
          <div><span className="text-muted-foreground">说明：</span>{log.transit_details || '-'}</div>
          {matched.length > 0 && (
            <div><span className="text-muted-foreground">命中规则：</span>{matched.map(r => `${r.name} (${r.id})`).join('、')}</div>
          )}
          <div><span className="text-muted-foreground">Payload 样例：</span></div>
          <pre className="p-2 rounded bg-muted whitespace-pre-wrap break-all max-h-40 overflow-auto">{log.transit_payload_sample || '-'}</pre>
        </div>
      )}
    </div>
  );
}

function AuditDetail({ oldValue, newValue }) {
  const [open, setOpen] = useState(false);

  if (!oldValue && !newValue) return <span className="text-muted-foreground text-xs">-</span>;

  const oldObj = safeJsonParse(oldValue);
  const newObj = safeJsonParse(newValue);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <Eye className="w-3.5 h-3.5" />
        {open ? '收起' : '查看'}
      </button>
      {open && (
        <div className="mt-2 p-3 rounded-md bg-muted/50 text-xs font-mono space-y-2 max-w-[400px] overflow-auto">
          {oldValue && (
            <div>
              <div className="text-muted-foreground mb-1">变更前:</div>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(oldObj, null, 2)}</pre>
            </div>
          )}
          {newValue && (
            <div>
              <div className="text-muted-foreground mb-1">变更后:</div>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(newObj, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
