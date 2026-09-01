import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import {
  Search, RefreshCw, Eye, EyeOff, AlertCircle, CheckCircle,
  Server, Layers, Loader2
} from 'lucide-react';
import { cn } from '../lib/utils';

const PROTOCOL_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  bedrock: 'Bedrock',
  relay: 'Relay',
};

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
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100">×</button>
    </div>
  );
}

export default function ModelPlazaConfig() {
  const [models, setModels] = useState([]);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  const showToast = (msg, type = 'success') => setToast({ message: msg, type });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, sRes] = await Promise.all([
        api.get('/admin/models'),
        api.get('/admin/sources'),
      ]);
      setModels(mRes.data || []);
      setSources(sRes.data || []);
    } catch (e) {
      showToast('加载数据失败', 'error');
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = useMemo(() => {
    let result = [...models];
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(m =>
        (m.model_id || '').toLowerCase().includes(q) ||
        (m.model_alias || '').toLowerCase().includes(q)
      );
    }
    if (sourceFilter !== 'all') {
      result = result.filter(m => String(m.source_id) === sourceFilter);
    }
    return result;
  }, [models, search, sourceFilter]);

  // Detect duplicates by model_id + source_name
  const dupGroupIds = useMemo(() => {
    const groups = new Map();
    for (const m of models) {
      const key = `${m.model_id || ''}::${m.source_name || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m.id);
    }
    const dups = new Set();
    for (const ids of groups.values()) {
      if (ids.length > 1) ids.forEach(id => dups.add(id));
    }
    return dups;
  }, [models]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(m => m.id)));
    }
  };

  const updateModel = async (id, data) => {
    setActionLoading(true);
    try {
      await api.put(`/admin/models/${id}`, data);
      setModels(prev => prev.map(m => m.id === id ? { ...m, ...data } : m));
      showToast('更新成功');
    } catch (e) {
      showToast(e.response?.data?.error || '更新失败', 'error');
    }
    setActionLoading(false);
  };

  const batchUpdate = async (data) => {
    if (selectedIds.size === 0) return;
    setActionLoading(true);
    try {
      await api.post('/admin/models/batch-update', { ids: Array.from(selectedIds), ...data });
      setModels(prev => prev.map(m => selectedIds.has(m.id) ? { ...m, ...data } : m));
      showToast(`已更新 ${selectedIds.size} 个模型`);
      setSelectedIds(new Set());
    } catch (e) {
      showToast(e.response?.data?.error || '批量更新失败', 'error');
    }
    setActionLoading(false);
  };

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">模型广场配置</h1>
          <p className="text-sm text-muted-foreground mt-1">
            控制模型广场中模型的显示/隐藏，查看模型-源站映射关系
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchData} disabled={loading}>
            <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="搜索模型 ID 或别名..."
                className="pl-10"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              value={sourceFilter}
              onChange={e => setSourceFilter(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="all">全部源站</option>
              {sources.map(s => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
            <Badge variant="secondary">共 {filtered.length} 个模型</Badge>
            {dupGroupIds.size > 0 && (
              <Badge variant="outline" className="border-amber-500 text-amber-600">
                <AlertCircle className="w-3 h-3 mr-1" />
                {dupGroupIds.size} 个重复模型
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Batch actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
          <span className="text-sm text-muted-foreground">已选 <span className="font-semibold text-foreground">{selectedIds.size}</span> 个</span>
          <Button size="sm" variant="outline" onClick={() => batchUpdate({ is_active: 1 })} disabled={actionLoading}>
            <Eye className="w-3.5 h-3.5 mr-1" />
            批量显示
          </Button>
          <Button size="sm" variant="outline" onClick={() => batchUpdate({ is_active: 0 })} disabled={actionLoading}>
            <EyeOff className="w-3.5 h-3.5 mr-1" />
            批量隐藏
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>取消选择</Button>
        </div>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left w-10">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && selectedIds.size === filtered.length}
                    onChange={toggleAll}
                    className="rounded border-gray-300"
                  />
                </th>
                <th className="px-4 py-3 text-left font-medium">模型</th>
                <th className="px-4 py-3 text-left font-medium">协议</th>
                <th className="px-4 py-3 text-left font-medium">源站</th>
                <th className="px-4 py-3 text-right font-medium">输入价格</th>
                <th className="px-4 py-3 text-right font-medium">输出价格</th>
                <th className="px-4 py-3 text-center font-medium">状态</th>
                <th className="px-4 py-3 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        加载中...
                      </div>
                    ) : (
                      <div>
                        <Server className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        暂无模型
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map(m => {
                  const isDup = dupGroupIds.has(m.id);
                  const isSelected = selectedIds.has(m.id);
                  return (
                    <tr
                      key={m.id}
                      className={cn(
                        "border-b hover:bg-muted/30 transition-colors",
                        isDup && "bg-amber-50/50 dark:bg-amber-950/20",
                        isSelected && "bg-primary/5"
                      )}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(m.id)}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0">
                            <div className="font-medium truncate" title={m.model_alias || m.model_id}>
                              {m.model_alias || m.model_id}
                            </div>
                            <div className="text-xs text-muted-foreground font-mono truncate">{m.model_id}</div>
                          </div>
                          {isDup && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1 border-amber-500 text-amber-600 shrink-0" title="该模型在此源站下存在重复记录">
                              重复
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-[10px]">
                          {PROTOCOL_LABELS[m.protocol] || m.protocol}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Layers className="w-3 h-3" />
                          {m.source_name || '未知'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{m.input_price ?? '-'}</td>
                      <td className="px-4 py-3 text-right font-mono">{m.output_price ?? '-'}</td>
                      <td className="px-4 py-3 text-center">
                        {m.is_active ? (
                          <Badge variant="success" className="text-[10px]">显示</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">隐藏</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          onClick={() => updateModel(m.id, { is_active: m.is_active ? 0 : 1 })}
                          disabled={actionLoading}
                        >
                          {m.is_active ? (
                            <><EyeOff className="w-3.5 h-3.5 mr-1" />隐藏</>
                          ) : (
                            <><Eye className="w-3.5 h-3.5 mr-1" />显示</>
                          )}
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
