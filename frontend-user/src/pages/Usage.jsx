import { useEffect, useState, Fragment } from 'react';
import api from '../lib/api';
import { fmtMoney, currencySymbol } from '../lib/utils';
import { Card, CardContent } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Download, ShieldCheck, CheckCircle, AlertTriangle, HelpCircle } from 'lucide-react';
import * as XLSX from 'xlsx';

function exportToExcel(rows, filename = 'usage_export.xlsx') {
  if (!rows.length) return;
  const headers = [
    '时间', '协议', '思考', '源站', '模型', '输入 Tokens', '输出 Tokens',
    '总计 Tokens', '缓存命中率', '消费', '延迟(ms)', '状态码', '归属类型', '归属者', 'Request ID', '客户端类型'
  ];
  const data = rows.map(log => [
    log.created_at ? new Date(log.created_at + 'Z').toLocaleString() : '-',
    log.protocol || 'openai→openai',
    log.has_thinking ? '是' : '否',
    log.source_name || '-',
    log.model || '-',
    log.input_tokens ?? 0,
    log.output_tokens ?? 0,
    log.total_tokens ?? 0,
    log.input_tokens > 0 ? Math.round(Math.min((log.cached_tokens || 0) / log.input_tokens, 1) * 100) / 100 : 0,
    fmtMoney(log.cost, 8),
    log.latency_ms ?? 0,
    log.status_code ?? '-',
    log.owner_type || '-',
    log.owner_name || '-',
    log.request_id || log.id,
    log.client_type === 'webchat' ? '网页聊天' : (log.client_type === 'apikey' ? 'API密钥' : (log.client_type || '-'))
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [
    { wch: 20 }, { wch: 16 }, { wch: 8 }, { wch: 16 }, { wch: 24 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 24 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '用量明细');
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Usage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [logCurrency, setLogCurrency] = useState('CNY');
  const pageSize = 20;

  useEffect(() => {
    loadData(page);
  }, [page]);

  const loadData = async (p) => {
    setLoading(true);
    try {
      const [logRes, modelRes] = await Promise.all([
        api.get(`/user/logs?page=${p}&pageSize=${pageSize}`),
        api.get('/user/models').catch(() => ({ data: [] })),
      ]);
      setLogs(logRes.data.logs || []);
      setTotalPages(logRes.data.totalPages || 1);
      setTotal(logRes.data.total || 0);
      setLogCurrency(logRes.data.currency || 'CNY');
      setModels(modelRes.data || []);
      setSelectedIds([]);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === logs.length && logs.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(logs.map(l => l.id));
    }
  };

  const handleExport = () => {
    const rows = logs.filter(l => selectedIds.includes(l.id));
    if (!rows.length) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    exportToExcel(rows, `usage_export_${timestamp}.xlsx`);
  };

  const findModelPrice = (modelName) => {
    if (!modelName || !models.length) return null;
    return models.find(m => m.model_id === modelName) || models.find(m => m.model_alias === modelName) || null;
  };

  if (loading) {
    return <div className="text-center py-10">加载中...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">用量明细</h1>
        <span className="text-sm text-muted-foreground">共 {total.toLocaleString()} 条记录</span>
      </div>

      <div className="sticky top-0 z-20 -mx-6 px-6 py-3 bg-background/95 backdrop-blur border-b flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={logs.length > 0 && selectedIds.length === logs.length}
              onChange={toggleSelectAll}
              className="rounded border-input"
            />
            全选当前页
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={selectedIds.length === 0}
          >
            <Download className="w-4 h-4 mr-2" />
            导出 Excel ({selectedIds.length})
          </Button>
          {selectedIds.length > 0 && (
            <span className="text-sm text-muted-foreground">
              已选 {selectedIds.length} 条
            </span>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              第 {page} / {totalPages} 页
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
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
                size="sm"
                variant="outline"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              暂无使用数据，开始调用API吧！
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b">
                  <tr>
                    <th className="p-4 text-left text-sm font-medium w-10">
                      <input
                        type="checkbox"
                        checked={logs.length > 0 && selectedIds.length === logs.length}
                        onChange={toggleSelectAll}
                        className="rounded border-input"
                      />
                    </th>
                    <th className="p-4 text-left text-sm font-medium w-10"></th>
                    <th className="p-4 text-left text-sm font-medium">时间</th>
                    <th className="p-4 text-left text-sm font-medium">协议(客户端→源站)</th>
                    <th className="p-4 text-left text-sm font-medium">思考</th>
                    <th className="p-4 text-left text-sm font-medium">源站</th>
                    <th className="p-4 text-left text-sm font-medium">模型</th>
                    <th className="p-4 text-left text-sm font-medium">输入 (未命中/命中)</th>
                    <th className="p-4 text-left text-sm font-medium">输出</th>
                    <th className="p-4 text-left text-sm font-medium">总计</th>
                    <th className="p-4 text-left text-sm font-medium">缓存命中率</th>
                    <th className="p-4 text-left text-sm font-medium">消费 ({logCurrency})</th>
                    <th className="p-4 text-left text-sm font-medium">延迟</th>
                    <th className="p-4 text-left text-sm font-medium">状态</th>
                    <th className="p-4 text-left text-sm font-medium">归属类型</th>
                    <th className="p-4 text-left text-sm font-medium">客户端类型</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const cached = log.cached_tokens || 0;
                    const uncached = log.uncached_tokens || (log.input_tokens - cached);
                    const totalInput = log.input_tokens || cached;
                    const cacheRate = totalInput > 0 ? Math.min(cached / totalInput, 1) : 0;
                    const isExpanded = expandedId === log.id;
                    const modelPrice = findModelPrice(log.model);

                    return (
                      <Fragment key={log.id}>
                        <tr className="border-b hover:bg-muted/40 transition-colors">
                          <td className="p-4">
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(log.id)}
                              onChange={() => toggleSelect(log.id)}
                              className="rounded border-input"
                            />
                          </td>
                          <td className="p-4">
                            <button
                              onClick={() => toggleExpand(log.id)}
                              className="p-1 rounded hover:bg-muted transition-colors"
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-muted-foreground" />
                              )}
                            </button>
                          </td>
                          <td className="p-4 text-sm">
                            {new Date(log.created_at + 'Z').toLocaleString()}
                          </td>
                          <td className="p-4 text-sm">
                            <Badge variant="outline" className="text-xs">
                              {log.protocol || 'openai→openai'}
                            </Badge>
                          </td>
                          <td className="p-4">
                            {log.has_thinking ? (
                              <Badge variant="default" className="text-xs bg-purple-600 hover:bg-purple-700">思考</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </td>
                          <td className="p-4 text-sm">{log.source_name}</td>
                          <td className="p-4">
                            <code className="text-xs">{log.model}</code>
                          </td>
                          <td className="p-4">
                            <div className="text-sm">
                              <span>{log.input_tokens}</span>
                              <span className="text-muted-foreground ml-1">
                                (<span className="text-foreground">{uncached}</span>/<span className="text-green-600">{cached}</span>)
                              </span>
                            </div>
                            {(log.input_tokens > 0 || log.cached_tokens > 0) && (
                              <div className="w-24 h-1.5 bg-secondary rounded-full overflow-hidden mt-1">
                                <div className="h-full bg-green-500" style={{ width: `${cacheRate * 100}%` }} />
                              </div>
                            )}
                          </td>
                          <td className="p-4 text-sm">{log.output_tokens}</td>
                          <td className="p-4 text-sm font-medium">{log.total_tokens}</td>
                          <td className="p-4">
                            <Badge variant={cacheRate > 0 ? 'success' : 'secondary'} className="text-xs">
                              {Math.round(cacheRate * 100)}%
                            </Badge>
                          </td>
                          <td className="p-4 text-sm font-mono">{currencySymbol(logCurrency)}{fmtMoney(log.cost, 8)}</td>
                          <td className="p-4 text-sm">{log.latency_ms}ms</td>
                          <td className="p-4">
                            <Badge variant={log.status_code === 200 ? 'success' : 'destructive'}>
                              {log.status_code}
                            </Badge>
                          </td>
                          <td className="p-4 text-sm">
                            {log.owner_type === 'Workspace' ? (
                              <Badge variant="outline" className="text-xs">Workspace</Badge>
                            ) : (
                              <span className="text-muted-foreground">个人</span>
                            )}
                          </td>
                          <td className="p-4 text-sm">
                            {log.client_type === 'webchat' ? (
                              <Badge variant="default" className="text-xs bg-blue-600 hover:bg-blue-700">网页聊天</Badge>
                            ) : log.client_type === 'apikey' ? (
                              <Badge variant="outline" className="text-xs">API密钥</Badge>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <td colSpan={16} className="p-0 border-b">
                              <LogDetailPanel
                                log={log}
                                modelPrice={modelPrice}
                                currency={logCurrency}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}

function LogDetailPanel({ log, modelPrice, currency }) {
  const statusOk = log.status_code === 200;
  const inputPrice = modelPrice?.input_price ?? null;
  const outputPrice = modelPrice?.output_price ?? null;
  const cacheWritePrice = modelPrice?.input_price_cache ?? null;
  const displayCost = log.cost ?? 0;
  const usdCost = log.cost_usd != null ? log.cost_usd : log.cost;

  const formatPrice = (price) => {
    if (price == null) return '-';
    return `$${price.toFixed(6)} / 1M tokens`;
  };

  const buildBillingFormula = () => {
    const parts = [];
    if (log.input_tokens > 0 && inputPrice != null) {
      parts.push(`提示 ${log.input_tokens.toLocaleString()} tokens / 1M * $${inputPrice.toFixed(6)}`);
    }
    if (log.cache_creation_tokens > 0 && cacheWritePrice != null) {
      parts.push(`缓存写入 ${log.cache_creation_tokens.toLocaleString()} tokens / 1M * $${cacheWritePrice.toFixed(6)}`);
    }
    if (log.output_tokens > 0 && outputPrice != null) {
      parts.push(`补全 ${log.output_tokens.toLocaleString()} tokens / 1M * $${outputPrice.toFixed(6)}`);
    }
    if (parts.length === 0) return null;
    return parts.join(' + ') + ` = $${(usdCost || 0).toFixed(8)}`;
  };

  const billingFormula = buildBillingFormula();

  return (
    <div className="bg-muted/30 p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
        {/* 基础信息 */}
        <div className="space-y-3">
          <h4 className="font-semibold text-foreground">基础信息</h4>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">日志 ID</span>
              <span className="font-mono">{log.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">请求状态</span>
              <Badge variant={statusOk ? 'success' : 'destructive'} className="text-xs">
                {statusOk ? '成功' : '失败'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Request ID</span>
              <span className="font-mono text-xs">{log.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">归属类型</span>
              <Badge variant={log.owner_type === 'Workspace' ? 'outline' : 'secondary'} className="text-xs">
                {log.owner_type === 'Workspace' ? 'Workspace' : '个人'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">归属者</span>
              <span>{log.owner_name || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">客户端类型</span>
              {log.client_type === 'webchat' ? (
                <Badge className="text-xs bg-blue-600 hover:bg-blue-700">网页聊天</Badge>
              ) : log.client_type === 'apikey' ? (
                <Badge variant="outline" className="text-xs">API密钥</Badge>
              ) : (
                <span>-</span>
              )}
            </div>
          </div>
        </div>

        {/* 模型与密钥 */}
        <div className="space-y-3">
          <h4 className="font-semibold text-foreground">模型与密钥</h4>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">完整模型</span>
              <span className="font-mono text-xs">{log.model || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">协议</span>
              <span>{log.protocol || 'openai→openai'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">密钥</span>
              <span>{log.key_name || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">分组</span>
              <span>{log.source_group || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">源站</span>
              <span>{log.source_name || '-'}</span>
            </div>
          </div>
        </div>

        {/* Token 用量 */}
        <div className="space-y-3">
          <h4 className="font-semibold text-foreground">Token 用量</h4>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">输入 Token</span>
              <span>{log.input_tokens?.toLocaleString() || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">输出 Token</span>
              <span>{log.output_tokens?.toLocaleString() || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">缓存写入 Tokens</span>
              <span>{log.cache_creation_tokens?.toLocaleString() || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">缓存命中 Tokens</span>
              <span>{log.cached_tokens?.toLocaleString() || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">总 Token</span>
              <span className="font-medium">{log.total_tokens?.toLocaleString() || 0}</span>
            </div>
          </div>
        </div>

        {/* 日志详情（价格） */}
        <div className="space-y-3">
          <h4 className="font-semibold text-foreground">日志详情</h4>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">输入价格</span>
              <span className="font-mono text-xs">{formatPrice(inputPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">输出价格</span>
              <span className="font-mono text-xs">{formatPrice(outputPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">缓存读取价格</span>
              <span className="font-mono text-xs">{formatPrice(modelPrice?.input_price_cache)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">缓存创建价格</span>
              <span className="font-mono text-xs">{formatPrice(cacheWritePrice)}</span>
            </div>
          </div>
        </div>

        {/* 计费过程 */}
        <div className="space-y-3 md:col-span-2 lg:col-span-2">
          <h4 className="font-semibold text-foreground">计费过程</h4>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">输入价格</span>
              <span className="font-mono text-xs">{formatPrice(inputPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">输出价格</span>
              <span className="font-mono text-xs">{formatPrice(outputPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">缓存创建价格</span>
              <span className="font-mono text-xs">{formatPrice(cacheWritePrice)}</span>
            </div>
            {billingFormula ? (
              <div className="mt-2 text-xs font-mono leading-relaxed">
                {billingFormula}
              </div>
            ) : (
              <div className="mt-2 p-2 text-xs text-muted-foreground">
                未获取到模型单价，仅展示最终计费结果
              </div>
            )}
          </div>
        </div>

        {/* 链路检测 */}
        <TransitScanView log={log} />

        {/* 额度变化 */}
        <div className="space-y-3">
          <h4 className="font-semibold text-foreground">额度变化</h4>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">消费金额</span>
              <span className="font-semibold text-destructive">
                -{currencySymbol(currency)}{fmtMoney(displayCost, 8)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">延迟</span>
              <span>{log.latency_ms}ms</span>
            </div>
            {log.error_message && (
              <div className="mt-2 p-2 bg-destructive/10 rounded border border-destructive/20 text-xs text-destructive">
                {log.error_message}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const transitStatusConfig = {
  safe: { label: 'Safe', variant: 'success', icon: CheckCircle },
  unknown: { label: 'Unknown', variant: 'secondary', icon: HelpCircle },
  danger: { label: 'Danger', variant: 'destructive', icon: AlertTriangle }
};

function TransitScanView({ log }) {
  const result = log.transit_result;
  if (!result) {
    return (
      <div className="space-y-3">
        <h4 className="font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" />
          链路检测
        </h4>
        <div className="text-xs text-muted-foreground">暂无链路检测记录</div>
      </div>
    );
  }
  const cfg = transitStatusConfig[result] || transitStatusConfig.unknown;
  const Icon = cfg.icon || HelpCircle;
  let matched = [];
  try { matched = JSON.parse(log.transit_matched_rules || '[]'); } catch {}
  return (
    <div className="space-y-3">
      <h4 className="font-semibold text-foreground flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-primary" />
        链路检测
      </h4>
      <div className="space-y-2 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">检测结果</span>
          <Badge variant={cfg.variant} className="text-xs"><Icon className="w-3 h-3 mr-1" />{cfg.label}</Badge>
        </div>
        <div><span className="text-muted-foreground">说明：</span>{log.transit_details || '-'}</div>
        {matched.length > 0 && (
          <div><span className="text-muted-foreground">命中规则：</span>{matched.map(r => `${r.name} (${r.id})`).join('、')}</div>
        )}
        <div><span className="text-muted-foreground">Payload 样例：</span></div>
        <pre className="p-2 rounded bg-muted whitespace-pre-wrap break-all max-h-40 overflow-auto">{log.transit_payload_sample || '-'}</pre>
      </div>
    </div>
  );
}

function getPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  pages.push(1);
  if (current > 3) pages.push('...');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
    pages.push(i);
  }
  if (current < total - 2) pages.push('...');
  pages.push(total);
  return pages;
}
