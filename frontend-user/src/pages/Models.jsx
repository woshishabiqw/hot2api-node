import { useEffect, useState, useMemo, useRef, useCallback, memo } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { MultiSelect } from '../components/MultiSelect';
import {
  Search, Copy, Check, Eye, Wrench, FileJson, Code2,
  Sparkles, Server, Globe, Radio, X, ArrowDownAZ, ArrowUpZA,
  ArrowUp01, ArrowDown01, Star, AlignLeft, Zap, Coins,
  SlidersHorizontal, BrainCircuit, TrendingDown, ChevronDown,
  AlertCircle, CheckCircle, Clock
} from 'lucide-react';

const PROTOCOLS = [
  { value: 'all', label: '全部协议' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'bedrock', label: 'Bedrock' },
  { value: 'relay', label: 'Relay' },
];

const CAPABILITIES = [
  { key: 'is_vision', label: 'Vision', icon: Eye, className: 'bg-purple-500' },
  { key: 'supports_tools', label: 'Tools', icon: Wrench, className: 'bg-blue-500' },
  { key: 'supports_json', label: 'JSON', icon: FileJson, className: 'bg-emerald-500' },
  { key: 'supports_fim', label: 'FIM', icon: Code2, className: 'bg-orange-500' },
];

const SORT_OPTIONS = [
  { value: 'priority', label: '默认排序', icon: Star },
  { value: 'input_price_asc', label: '输入价格 ↑', icon: ArrowUp01 },
  { value: 'input_price_desc', label: '输入价格 ↓', icon: ArrowDown01 },
  { value: 'output_price_asc', label: '输出价格 ↑', icon: ArrowUp01 },
  { value: 'output_price_desc', label: '输出价格 ↓', icon: ArrowDown01 },
  { value: 'name_asc', label: '名称 A-Z', icon: ArrowDownAZ },
  { value: 'name_desc', label: '名称 Z-A', icon: ArrowUpZA },
  { value: 'tokens_desc', label: '上下文 ↓', icon: AlignLeft },
];

const SMART_PRESETS = [
  { value: 'all', label: '全部模型', icon: Star, desc: '显示所有可用模型' },
  { value: 'best_value', label: '性价比推荐', icon: Zap, desc: '低价 + 支持工具 + 上下文 ≥ 8K' },
  { value: 'vision', label: '视觉模型', icon: Eye, desc: '支持图像识别与理解' },
  { value: 'coding', label: '代码助手', icon: Code2, desc: '支持代码补全与结构化输出' },
  { value: 'long_context', label: '长上下文', icon: AlignLeft, desc: '上下文长度 ≥ 128K' },
  { value: 'free', label: '免费/低价', icon: Coins, desc: '输入免费或输出极低价格' },
];

// Price range min/max inputs (no hardcoded ranges)

const FILTER_STORAGE_KEY = 'models-smart-filter-v1';
const PROBE_HISTORY_KEY = 'user-probe-history-v1';
const PROBE_BARS = 40;

// 全局tooltip单例管理
let currentTooltipId = null;

function loadProbeHistory() {
  try { return JSON.parse(localStorage.getItem(PROBE_HISTORY_KEY) || '{}'); }
  catch { return {}; }
}
function saveProbeHistory(h) {
  try { localStorage.setItem(PROBE_HISTORY_KEY, JSON.stringify(h)); } catch {}
}
function mergeProbeHistory(history, fresh) {
  const activeIds = new Set(Object.keys(fresh));
  let changed = false;
  const next = {};

  // 丢弃已不存在的源站
  for (const [sid, protos] of Object.entries(history)) {
    if (activeIds.has(sid)) next[sid] = protos;
    else changed = true;
  }

  const ts = Date.now();
  for (const [sid, protos] of Object.entries(fresh)) {
    const existingProtos = next[sid] || {};
    const mergedProtos = {};
    let sidChanged = !next[sid];

    for (const [proto, info] of Object.entries(protos || {})) {
      const arr = existingProtos[proto] || [];
      const last = arr[arr.length - 1];
      const newData = { ms: info.latencyMs || 0, status: info.status, error: info.error || null, ts };

      if (!last || last.ms !== newData.ms || last.status !== newData.status) {
        mergedProtos[proto] = [...arr.slice(-(PROBE_BARS - 1)), newData];
        sidChanged = true;
      } else {
        mergedProtos[proto] = arr;
      }
    }

    if (sidChanged) {
      changed = true;
      next[sid] = { ...existingProtos, ...mergedProtos };
    } else {
      next[sid] = existingProtos;
    }
  }

  return changed ? next : history;
}

function fmtPrice(v) {
  if (v == null || v === 0) return '0';
  return parseFloat(Number(v).toFixed(4)).toString();
}

function getProtocolColor(protocol) {
  const map = { openai: 'bg-green-500', anthropic: 'bg-amber-500', gemini: 'bg-blue-500', bedrock: 'bg-orange-500', relay: 'bg-gray-500' };
  return map[protocol] || 'bg-gray-500';
}

function getProtocolLabel(protocol) {
  const map = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', bedrock: 'Bedrock', relay: 'Relay' };
  return map[protocol] || protocol;
}

function parseGroups(str) {
  if (!str) return ['default'];
  if (Array.isArray(str)) return str.length > 0 ? str : ['default'];
  try { const arr = JSON.parse(str); return Array.isArray(arr) && arr.length > 0 ? arr : ['default']; }
  catch { return [str]; }
}

function applySmartPreset(preset, allModels) {
  switch (preset) {
    case 'best_value':
      return allModels.filter(m => (m.input_price || 0) < 0.01 && (m.supports_tools === 1 || m.supports_tools === true) && (m.max_tokens || 0) >= 8000);
    case 'vision':
      return allModels.filter(m => m.is_vision === 1 || m.is_vision === true);
    case 'coding':
      return allModels.filter(m => (m.supports_fim === 1 || m.supports_fim === true) && (m.supports_json === 1 || m.supports_json === true));
    case 'long_context':
      return allModels.filter(m => (m.max_tokens || 0) >= 128000);
    case 'free':
      return allModels.filter(m => (m.input_price || 0) <= 0 && (m.output_price || 0) <= 0.01);
    default:
      return allModels;
  }
}

export default function Models() {
  const [models, setModels] = useState([]);
  const [groups, setGroups] = useState([]);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);

  // Search & Sort
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('priority');

  // Filters
  const [protocolFilter, setProtocolFilter] = useState('all');
  const [capFilters, setCapFilters] = useState(new Set());
  const [sourceFilters, setSourceFilters] = useState([]);
  const [groupFilters, setGroupFilters] = useState([]);
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [smartPreset, setSmartPreset] = useState('all');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Model health / latency probe
  const [modelHealth, setModelHealth] = useState({});
  const [sourceProbeHistory, setSourceProbeHistory] = useState(loadProbeHistory);

  const [copiedId, setCopiedId] = useState(null);
  const [drawerModel, setDrawerModel] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const loadHealth = async () => {
    try {
      const res = await api.get('/user/models/health');
      setModelHealth(res.data || {});
    } catch {}
  };

  const loadSourceLatency = useCallback(async () => {
    try {
      const res = await api.get('/user/sources/latency');
      const fresh = res.data || {};
      setSourceProbeHistory(prev => {
        const next = mergeProbeHistory(prev, fresh);
        saveProbeHistory(next);
        return next;
      });
    } catch {}
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [modelsRes, groupsRes] = await Promise.all([
        api.get('/user/models'),
        api.get('/user/model-groups')
      ]);
      const m = modelsRes.data || [];
      setModels(m);
      setGroups(groupsRes.data || []);
      const sourceMap = new Map();
      m.forEach(model => {
        if (model.source_id && !sourceMap.has(String(model.source_id))) {
          sourceMap.set(String(model.source_id), { id: String(model.source_id), name: model.source_name || '未知源站' });
        }
      });
      setSources(Array.from(sourceMap.values()));
    } catch {
      setModels([]); setGroups([]); setSources([]);
    } finally {
      setLoading(false);
    }
  };

  // Load data & restore filters
  useEffect(() => {
    loadData();
    loadHealth();
    loadSourceLatency();

    // Models/health refresh every 5 minutes; probe every 5 seconds
    const interval = setInterval(() => { loadData(); loadHealth(); }, 5 * 60 * 1000);
    const probeInterval = setInterval(loadSourceLatency, 5_000);

    // Restore saved filters
    try {
      const saved = localStorage.getItem(FILTER_STORAGE_KEY);
      if (saved) {
        const prefs = JSON.parse(saved);
        if (!prefs || typeof prefs !== 'object') return;
        if (prefs.search) setSearch(prefs.search);
        if (prefs.sortBy) setSortBy(prefs.sortBy);
        if (prefs.protocolFilter) setProtocolFilter(prefs.protocolFilter);
        if (prefs.capFilters) setCapFilters(new Set(prefs.capFilters));
        if (prefs.sourceFilters) setSourceFilters(prefs.sourceFilters);
        if (prefs.groupFilters) setGroupFilters(prefs.groupFilters);
        if (prefs.priceMin !== undefined) setPriceMin(prefs.priceMin);
        if (prefs.priceMax !== undefined) setPriceMax(prefs.priceMax);
        if (prefs.smartPreset) setSmartPreset(prefs.smartPreset);
        if (prefs.showAdvanced) setShowAdvanced(prefs.showAdvanced);
      }
    } catch {}

    return () => { clearInterval(interval); clearInterval(probeInterval); };
  }, []);

  // Persist filters
  useEffect(() => {
    const prefs = {
      search, sortBy, protocolFilter,
      capFilters: Array.from(capFilters),
      sourceFilters, groupFilters, priceMin, priceMax, smartPreset, showAdvanced
    };
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(prefs));
  }, [search, sortBy, protocolFilter, capFilters, sourceFilters, groupFilters, priceMin, priceMax, smartPreset, showAdvanced]);

  const toggleCap = (key) => {
    setCapFilters((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  };

  // Core filter logic
  const filtered = useMemo(() => {
    let result = [...models];

    // Smart preset (sets base pool, then other filters refine)
    if (smartPreset !== 'all') {
      result = applySmartPreset(smartPreset, result);
    }

    // Search
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter((m) =>
        (m.model_id || '').toLowerCase().includes(q) ||
        (m.model_alias || '').toLowerCase().includes(q) ||
        (m.description || '').toLowerCase().includes(q) ||
        (m.source_name || '').toLowerCase().includes(q)
      );
    }

    // Protocol
    if (protocolFilter !== 'all') {
      result = result.filter((m) => m.protocol === protocolFilter);
    }

    // Capabilities (AND)
    for (const cap of capFilters) {
      result = result.filter((m) => m[cap] === 1 || m[cap] === true);
    }

    // Source
    if (sourceFilters.length > 0) {
      result = result.filter((m) => sourceFilters.includes(String(m.source_id)));
    }

    // Group (OR within selected groups)
    if (groupFilters.length > 0) {
      result = result.filter((m) => {
        const mg = parseGroups(m.model_group);
        return groupFilters.some((gf) => mg.includes(gf));
      });
    }

    // Price range (input form)
    const pMin = priceMin !== '' ? parseFloat(priceMin) : null;
    const pMax = priceMax !== '' ? parseFloat(priceMax) : null;
    if (pMin !== null || pMax !== null) {
      result = result.filter((m) => {
        const inp = m.input_price || 0;
        if (pMin !== null && inp < pMin) return false;
        if (pMax !== null && inp > pMax) return false;
        return true;
      });
    }

    // Sort
    switch (sortBy) {
      case 'input_price_asc': result.sort((a, b) => (a.input_price || 0) - (b.input_price || 0)); break;
      case 'input_price_desc': result.sort((a, b) => (b.input_price || 0) - (a.input_price || 0)); break;
      case 'output_price_asc': result.sort((a, b) => (a.output_price || 0) - (b.output_price || 0)); break;
      case 'output_price_desc': result.sort((a, b) => (b.output_price || 0) - (a.output_price || 0)); break;
      case 'name_asc': result.sort((a, b) => (a.model_alias || a.model_id || '').localeCompare(b.model_alias || b.model_id || '')); break;
      case 'name_desc': result.sort((a, b) => (b.model_alias || b.model_id || '').localeCompare(a.model_alias || a.model_id || '')); break;
      case 'tokens_desc': result.sort((a, b) => (b.max_tokens || 0) - (a.max_tokens || 0)); break;
      default: result.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.model_id || '').localeCompare(b.model_id || ''));
    }

    return result;
  }, [models, search, protocolFilter, capFilters, sourceFilters, groupFilters, priceMin, priceMax, smartPreset, sortBy]);

  // Deduplicate by model_id + source_name, keep highest priority
  const { dedupedModels, dupCounts } = useMemo(() => {
    const groups = new Map();
    for (const m of filtered) {
      const key = `${m.model_id || ''}::${m.source_name || ''}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(m);
    }
    const deduped = [];
    const counts = {};
    for (const [key, items] of groups) {
      items.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.id || 0) - (b.id || 0));
      const winner = items[0];
      deduped.push(winner);
      if (items.length > 1) {
        counts[winner.id] = items.length;
      }
    }
    // Preserve original sort order within deduped groups
    const orderMap = new Map(filtered.map((m, i) => [`${m.model_id || ''}::${m.source_name || ''}`, i]));
    deduped.sort((a, b) => (orderMap.get(`${a.model_id || ''}::${a.source_name || ''}`) || 0) - (orderMap.get(`${b.model_id || ''}::${b.source_name || ''}`) || 0));
    return { dedupedModels: deduped, dupCounts: counts };
  }, [filtered]);

  // Real-time counts for filter options
  const counts = useMemo(() => {
    const base = [...models];
    // Protocol counts (respecting all other filters except protocol)
    const protocolCounts = {};
    PROTOCOLS.forEach((p) => {
      if (p.value === 'all') { protocolCounts[p.value] = base.length; return; }
      let r = base.filter((m) => m.protocol === p.value);
      if (smartPreset !== 'all') r = applySmartPreset(smartPreset, r);
      if (search.trim()) { const q = search.trim().toLowerCase(); r = r.filter((m) => (m.model_id || '').toLowerCase().includes(q) || (m.model_alias || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q) || (m.source_name || '').toLowerCase().includes(q)); }
      for (const cap of capFilters) r = r.filter((m) => m[cap] === 1 || m[cap] === true);
      if (sourceFilters.length > 0) r = r.filter((m) => sourceFilters.includes(String(m.source_id)));
      if (groupFilters.length > 0) r = r.filter((m) => { const mg = parseGroups(m.model_group); return groupFilters.some((gf) => mg.includes(gf)); });
      const pmMin = priceMin !== '' ? parseFloat(priceMin) : null;
      const pmMax = priceMax !== '' ? parseFloat(priceMax) : null;
      if (pmMin !== null || pmMax !== null) {
        r = r.filter((m) => {
          const inp = m.input_price || 0;
          if (pmMin !== null && inp < pmMin) return false;
          if (pmMax !== null && inp > pmMax) return false;
          return true;
        });
      }
      protocolCounts[p.value] = r.length;
    });

    // Capability counts
    const capabilityCounts = {};
    CAPABILITIES.forEach((cap) => {
      let r = base.filter((m) => m[cap.key] === 1 || m[cap.key] === true);
      if (smartPreset !== 'all') r = applySmartPreset(smartPreset, r);
      if (search.trim()) { const q = search.trim().toLowerCase(); r = r.filter((m) => (m.model_id || '').toLowerCase().includes(q) || (m.model_alias || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q) || (m.source_name || '').toLowerCase().includes(q)); }
      if (protocolFilter !== 'all') r = r.filter((m) => m.protocol === protocolFilter);
      // Other caps still apply
      for (const c of capFilters) { if (c !== cap.key) r = r.filter((m) => m[c] === 1 || m[c] === true); }
      if (sourceFilters.length > 0) r = r.filter((m) => sourceFilters.includes(String(m.source_id)));
      if (groupFilters.length > 0) r = r.filter((m) => { const mg = parseGroups(m.model_group); return groupFilters.some((gf) => mg.includes(gf)); });
      const pcMin = priceMin !== '' ? parseFloat(priceMin) : null;
      const pcMax = priceMax !== '' ? parseFloat(priceMax) : null;
      if (pcMin !== null || pcMax !== null) {
        r = r.filter((m) => {
          const inp = m.input_price || 0;
          if (pcMin !== null && inp < pcMin) return false;
          if (pcMax !== null && inp > pcMax) return false;
          return true;
        });
      }
      capabilityCounts[cap.key] = r.length;
    });

    return { protocol: protocolCounts, capability: capabilityCounts };
  }, [models, search, protocolFilter, capFilters, sourceFilters, groupFilters, priceMin, priceMax, smartPreset]);

  const hasActiveFilters = search.trim() || protocolFilter !== 'all' || capFilters.size > 0 || sourceFilters.length > 0 || groupFilters.length > 0 || priceMin !== '' || priceMax !== '' || smartPreset !== 'all';

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); });
  };

  const openDrawer = (model) => {
    setDrawerModel(model);
    // delay to ensure DOM mount before CSS transition
    setTimeout(() => setDrawerOpen(true), 10);
  };
  const closeDrawer = () => { setDrawerOpen(false); setTimeout(() => setDrawerModel(null), 350); };

  const clearAllFilters = () => {
    setSearch(''); setProtocolFilter('all'); setCapFilters(new Set());
    setSourceFilters([]); setGroupFilters([]); setPriceMin(''); setPriceMax('');
    setSmartPreset('all');
  };

  const applyPreset = (preset) => {
    setSmartPreset(preset);
    if (preset === 'all') {
      // keep other filters, just clear preset
    } else {
      // Optionally clear conflicting filters for cleaner UX
      setProtocolFilter('all');
      setCapFilters(new Set());
      setPriceMin('');
      setPriceMax('');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">模型广场</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader><div className="h-6 w-2/3 rounded bg-muted" /></CardHeader>
              <CardContent className="space-y-3">
                <div className="h-4 w-full rounded bg-muted" />
                <div className="h-4 w-4/5 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">模型广场</h1>
          <p className="text-xs text-muted-foreground mt-1.5 max-w-xl">
            中转站统一以 OpenAI 格式对外服务。源站协议标注了上游实际接口类型，其中 Relay 表示直通原协议不做转换。
          </p>
        </div>
      </div>

      {/* Smart Filter Panel */}
      <div className="rounded-2xl bg-white/40 dark:bg-white/[0.03] border border-black/5 dark:border-white/10 backdrop-blur-sm p-4 space-y-3.5">
        {/* Row 1: Search + Sort + Count */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索模型名称、ID、源站..."
              className="pl-10 h-10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <SortPanel value={sortBy} onChange={setSortBy} />
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            共 <span className="font-semibold text-foreground">{dedupedModels.length}</span> 个模型
            {dedupedModels.length < filtered.length && (
              <span className="text-xs text-muted-foreground ml-1">(已去重 {filtered.length - dedupedModels.length} 个)</span>
            )}
          </span>
        </div>

        {/* Row 2: Smart Presets */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mr-1">智能推荐</span>
          {SMART_PRESETS.map((preset) => {
            const Icon = preset.icon;
            const active = smartPreset === preset.value;
            return (
              <button
                key={preset.value}
                onClick={() => applyPreset(preset.value)}
                title={preset.desc}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                  active
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                <Icon className="h-3 w-3" />
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* Row 3: Protocol + Capability filters with live counts */}
        <div className="flex flex-wrap items-center gap-2">
          {PROTOCOLS.map((p) => {
            const active = protocolFilter === p.value;
            const count = counts.protocol[p.value] ?? 0;
            return (
              <button
                key={p.value}
                onClick={() => setProtocolFilter(p.value)}
                disabled={count === 0 && !active}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                {p.value !== 'all' && <span className={`h-2 w-2 rounded-full ${getProtocolColor(p.value)}`} />}
                {p.label}
                <span className={`text-[10px] px-1 py-0 rounded-full ${active ? 'bg-primary-foreground/20' : 'bg-background/60'}`}>{count}</span>
              </button>
            );
          })}
          <div className="mx-1 h-4 w-px bg-border" />
          {CAPABILITIES.map((cap) => {
            const Icon = cap.icon;
            const active = capFilters.has(cap.key);
            const count = counts.capability[cap.key] ?? 0;
            return (
              <button
                key={cap.key}
                onClick={() => toggleCap(cap.key)}
                disabled={count === 0 && !active}
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                <Icon className="h-3 w-3" />
                {cap.label}
                <span className={`text-[10px] px-1 py-0 rounded-full ${active ? 'bg-primary-foreground/20' : 'bg-background/60'}`}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Row 4: Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {showAdvanced ? '收起高级筛选' : '展开高级筛选'}
          {(sourceFilters.length > 0 || groupFilters.length > 0 || priceMin !== '' || priceMax !== '') && (
            <span className="ml-1 inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </button>

        {/* Row 5: Advanced filters */}
        {showAdvanced && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-black/5 dark:border-white/10">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">源站</label>
              <MultiSelect
                options={sources.map((s) => ({ value: s.id, label: s.name }))}
                value={sourceFilters}
                onChange={setSourceFilters}
                placeholder="全部源站"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">分组</label>
              <MultiSelect
                options={groups.map((g) => ({ value: g.name, label: g.name }))}
                value={groupFilters}
                onChange={setGroupFilters}
                placeholder="全部分组"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">价格区间 (输入价格)</label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="最低"
                  value={priceMin}
                  onChange={(e) => setPriceMin(e.target.value)}
                  className="h-9 text-xs"
                />
                <span className="text-muted-foreground text-xs">-</span>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="最高"
                  value={priceMax}
                  onChange={(e) => setPriceMax(e.target.value)}
                  className="h-9 text-xs"
                />
                {(priceMin !== '' || priceMax !== '') && (
                  <button onClick={() => { setPriceMin(''); setPriceMax(''); }} className="p-1 rounded hover:bg-muted transition-colors">
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Row 6: Active filter chips */}
        {hasActiveFilters && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-black/5 dark:border-white/10">
            {smartPreset !== 'all' && (
              <FilterChip
                label={`智能: ${SMART_PRESETS.find((p) => p.value === smartPreset)?.label}`}
                onRemove={() => setSmartPreset('all')}
              />
            )}
            {search.trim() && <FilterChip label={`搜索: ${search}`} onRemove={() => setSearch('')} />}
            {protocolFilter !== 'all' && <FilterChip label={`协议: ${getProtocolLabel(protocolFilter)}`} onRemove={() => setProtocolFilter('all')} />}
            {Array.from(capFilters).map((capKey) => {
              const cap = CAPABILITIES.find((c) => c.key === capKey);
              return <FilterChip key={capKey} label={`能力: ${cap?.label}`} onRemove={() => toggleCap(capKey)} />;
            })}
            {sourceFilters.map((sid) => {
              const s = sources.find((ss) => ss.id === sid);
              return <FilterChip key={sid} label={`源站: ${s?.name || sid}`} onRemove={() => setSourceFilters((prev) => prev.filter((id) => id !== sid))} />;
            })}
            {groupFilters.map((g) => (
              <FilterChip key={g} label={`分组: ${g}`} onRemove={() => setGroupFilters((prev) => prev.filter((x) => x !== g))} />
            ))}
            {(priceMin !== '' || priceMax !== '') && (
              <FilterChip
                label={`价格: ${priceMin || '0'} - ${priceMax || '∞'}`}
                onRemove={() => { setPriceMin(''); setPriceMax(''); }}
              />
            )}
            <button onClick={clearAllFilters} className="text-xs text-muted-foreground hover:text-foreground underline ml-1">重置全部</button>
          </div>
        )}
      </div>

      {/* Grid */}
      {dedupedModels.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BrainCircuit className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-lg font-medium">未找到匹配的模型</p>
          <p className="text-sm mt-1">尝试调整筛选条件或搜索关键词</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={clearAllFilters}>
            <TrendingDown className="h-3.5 w-3.5 mr-1.5" />
            清空所有筛选
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 overflow-visible">
          {dedupedModels.map((m) => {
            const cardOutbound = m.protocol === 'relay' ? 'Relay 直通' : 'OpenAI / Anthropic / Gemini / Bedrock';
            const cardSame = m.protocol === 'openai';
            const dupCount = dupCounts[m.id];
            return (
              <Card
                key={m.id}
                className="group flex flex-col transition-shadow hover:shadow-md cursor-pointer overflow-visible"
                onClick={() => openDrawer(m)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-lg truncate" title={m.model_alias || m.model_id}>
                        {m.model_alias || m.model_id}
                      </CardTitle>
                      <CardDescription className="mt-1 flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-block h-2 w-2 rounded-full ${getProtocolColor(m.protocol)}`} />
                          <span className="truncate">{m.source_name || '未知源站'}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            <Globe className="h-2.5 w-2.5" />
                            出站: {cardOutbound}
                          </span>
                          {!cardSame && (
                            <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                              <Radio className="h-2.5 w-2.5" />
                              源站: {getProtocolLabel(m.protocol)}
                            </span>
                          )}
                        </div>
                      </CardDescription>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {dupCount && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1 border-amber-500 text-amber-600" title={`${dupCount} 个源站提供此模型（已去重）`}>
                          ×{dupCount}
                        </Badge>
                      )}
                      {m.source_status === 'valid' ? (
                        <Badge variant="success" className="text-[10px]">正常</Badge>
                      ) : (
                        <Badge variant="destructive" className="text-[10px]">{m.source_status}</Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="flex-1 space-y-3 overflow-visible">
                  <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                    <code className="flex-1 text-xs truncate text-muted-foreground">{m.model_id}</code>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCopy(m.model_id, m.id); }}
                      className="shrink-0 rounded p-1 hover:bg-muted transition-colors"
                      title="复制 model_id"
                    >
                      {copiedId === m.id ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {CAPABILITIES.map((cap) => {
                      const hasCap = m[cap.key] === 1 || m[cap.key] === true;
                      if (!hasCap) return null;
                      const Icon = cap.icon;
                      return (
                        <span key={cap.key} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-white ${cap.className}`}>
                          <Icon className="h-3 w-3" />{cap.label}
                        </span>
                      );
                    })}
                    {m.max_tokens > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                        <Server className="h-3 w-3" />{m.max_tokens.toLocaleString()} tokens
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border bg-background/50 px-2.5 py-2">
                      <div className="text-muted-foreground">输入 / 1K</div>
                      <div className="mt-0.5 font-semibold text-foreground">¥{fmtPrice(m.input_price)}</div>
                    </div>
                    <div className="rounded-md border bg-background/50 px-2.5 py-2">
                      <div className="text-muted-foreground">输出 / 1K</div>
                      <div className="mt-0.5 font-semibold text-foreground">¥{fmtPrice(m.output_price)}</div>
                    </div>
                  </div>

                  {m.description && <p className="text-xs text-muted-foreground line-clamp-2">{m.description}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Drawer */}
      {drawerModel && (
        <>
          <div
            className={`fixed inset-0 z-[110] bg-black/40 backdrop-blur-md transition-opacity duration-300 ${
              drawerOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={closeDrawer}
          />
          <div
            className={`fixed inset-y-0 right-0 z-[110] w-full max-w-[520px] flex flex-col rounded-l-2xl ${
              drawerOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
            style={{
              transition: 'transform 350ms cubic-bezier(0.32, 0.72, 0, 1)',
              background: 'linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(255,255,255,0.88) 100%)',
              borderLeft: '1px solid rgba(255,255,255,0.35)',
              boxShadow: '-20px 0 60px rgba(0,0,0,0.2), inset 1px 0 0 rgba(255,255,255,0.5)',
              backdropFilter: 'blur(40px) saturate(140%)',
              WebkitBackdropFilter: 'blur(40px) saturate(140%)',
            }}
          >
            <div className="dark:hidden h-full flex flex-col">
              <DrawerContent model={drawerModel} onClose={closeDrawer} health={modelHealth[drawerModel?.model_id]} probeHistory={sourceProbeHistory[String(drawerModel?.source_id)]?.[drawerModel?.protocol] || []} />
            </div>
          </div>
          <div
            className={`fixed inset-y-0 right-0 z-[110] w-full max-w-[520px] hidden dark:flex flex-col rounded-l-2xl ${
              drawerOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
            style={{
              transition: 'transform 350ms cubic-bezier(0.32, 0.72, 0, 1)',
              background: 'linear-gradient(180deg, rgba(10,14,28,0.94) 0%, rgba(6,8,18,0.90) 100%)',
              borderLeft: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '-20px 0 60px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.04)',
              backdropFilter: 'blur(40px) saturate(140%)',
              WebkitBackdropFilter: 'blur(40px) saturate(140%)',
            }}
          >
            <DrawerContent model={drawerModel} onClose={closeDrawer} health={modelHealth[drawerModel?.model_id]} probeHistory={sourceProbeHistory[String(drawerModel?.source_id)]?.[drawerModel?.protocol] || []} />
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────────────────── Filter Chip ───────────────────────── */

function FilterChip({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
      {label}
      <button onClick={onRemove} className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/* ───────────────────────── Drawer Content ───────────────────────── */

function DrawerContent({ model, onClose, health, probeHistory = [] }) {
  const [copiedKey, setCopiedKey] = useState(null);
  const outboundProtocol = model.protocol === 'relay' ? 'Relay 直通' : 'OpenAI / Anthropic / Gemini / Bedrock';
  const isSameProtocol = model.protocol === 'openai';

  const handleCopy = (text, key) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  };

  return (
    <>
      <div className="flex items-center justify-between px-6 py-5 border-b border-black/5 dark:border-white/[0.08] shrink-0">
        <div className="min-w-0">
          <h2 className="text-xl font-bold truncate">{model.model_alias || model.model_id}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 truncate font-mono">{model.model_id}</p>
        </div>
        <button onClick={onClose} className="shrink-0 p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-6 space-y-6">
        <Section title="接口协议">
          <div className="flex flex-wrap gap-2">
            <GlassBadge variant="primary" icon={<Globe className="h-3.5 w-3.5" />}>出站: {outboundProtocol}</GlassBadge>
            {!isSameProtocol && (
              <GlassBadge variant="muted" icon={<Radio className="h-3.5 w-3.5" />}>源站: {getProtocolLabel(model.protocol)}</GlassBadge>
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed mt-2.5">
            {model.protocol === 'relay'
              ? '此模型为 Relay 直通模式，出站协议与源站协议一致，不做任何格式转换。'
              : ''}
          </p>
        </Section>

        <Section title="源站信息">
          <GlassCard>
            <InfoRow label="源站名称" value={model.source_name || '-'} />
            <InfoRow label="源站状态" value={<Badge variant={model.source_status === 'valid' ? 'success' : 'destructive'} className="text-[10px]">{model.source_status === 'valid' ? '正常' : model.source_status}</Badge>} />
          </GlassCard>
        </Section>

        <Section title="源站延迟">
          <GlassCard className="!p-2">
            <ModelSparkline health={health} probeHistory={probeHistory} />
          </GlassCard>
        </Section>

        <Section title="模型标识">
          <div className="space-y-2">
            <CopyRow label="中转站模型ID" sub="调用时使用" value={model.model_id} copied={copiedKey === 'model_id'} onCopy={() => handleCopy(model.model_id, 'model_id')} />
            {model.source_model_id && model.source_model_id !== model.model_id && (
              <GlassCard className="px-3.5 py-2.5">
                <div className="text-[10px] text-muted-foreground">源站模型ID</div>
                <code className="text-sm font-mono">{model.source_model_id}</code>
              </GlassCard>
            )}
          </div>
        </Section>

        <Section title="模型能力">
          <div className="grid grid-cols-2 gap-2">
            {CAPABILITIES.map((cap) => {
              const hasCap = model[cap.key] === 1 || model[cap.key] === true;
              const Icon = cap.icon;
              return (
                <div
                  key={cap.key}
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 border text-xs font-medium transition-colors ${
                    hasCap
                      ? 'bg-gradient-to-br from-white/70 to-white/30 dark:from-white/[0.08] dark:to-white/[0.02] border-black/5 dark:border-white/10'
                      : 'bg-white/30 dark:bg-white/[0.02] border-black/[0.03] dark:border-white/[0.04] opacity-60'
                  }`}
                >
                  <div className={`shrink-0 p-1 rounded-lg ${hasCap ? cap.className + ' text-white' : 'bg-muted text-muted-foreground'}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="leading-tight min-w-0">
                    <div className="font-medium truncate">{cap.label}</div>
                    <div className={`text-[10px] ${hasCap ? 'text-muted-foreground' : 'text-muted-foreground/60'}`}>{hasCap ? '已支持' : '未支持'}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="价格 (元 / 1K tokens)">
          <div className="grid grid-cols-3 gap-2">
            <PriceCard label="输入" sub="未命中缓存" value={model.input_price} accent="blue" />
            <PriceCard label="输入" sub="缓存命中" value={model.input_price_cache} accent="emerald" />
            <PriceCard label="输出" sub="" value={model.output_price} accent="amber" />
          </div>
        </Section>

        <Section title="规格">
          <GlassCard>
            <InfoRow label="上下文长度" value={model.max_tokens ? `${model.max_tokens.toLocaleString()} tokens` : '-'} />
            <InfoRow
              label="分组"
              value={
                <div className="flex flex-wrap gap-1 justify-end">
                  {(() => {
                    try {
                      const arr = JSON.parse(model.model_group);
                      return Array.isArray(arr)
                        ? arr.map((g) => <Badge key={g} variant="outline" className="text-[10px]">{g}</Badge>)
                        : <Badge variant="outline" className="text-[10px]">{model.model_group}</Badge>;
                    } catch {
                      return <Badge variant="outline" className="text-[10px]">{model.model_group || 'default'}</Badge>;
                    }
                  })()}
                </div>
              }
            />
            <InfoRow label="优先级" value={model.priority || 0} />
          </GlassCard>
        </Section>

        {model.description && (
          <Section title="描述">
            <p className="text-sm text-muted-foreground leading-relaxed">{model.description}</p>
          </Section>
        )}
      </div>
    </>
  );
}

/* ───────────────────────── UI Primitives ───────────────────────── */

function Section({ title, children }) {
  return (
    <div className="space-y-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{title}</h3>
      {children}
    </div>
  );
}

function GlassCard({ children, className = '' }) {
  return (
    <div className={`rounded-2xl bg-white/60 dark:bg-white/[0.04] border border-black/[0.04] dark:border-white/[0.08] backdrop-blur-sm px-3.5 py-3 text-sm space-y-2 ${className}`}>
      {children}
    </div>
  );
}

function GlassBadge({ variant, icon, children }) {
  const styles = {
    primary: 'bg-primary/10 text-primary border-primary/15',
    muted: 'bg-black/5 dark:bg-white/[0.06] text-foreground border-black/5 dark:border-white/10',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium border backdrop-blur-sm ${styles[variant] || styles.muted}`}>
      {icon}{children}
    </span>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground text-xs shrink-0">{label}</span>
      <span className="font-medium text-xs text-right">{value}</span>
    </div>
  );
}

function CopyRow({ label, sub, value, copied, onCopy }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-white/60 dark:bg-white/[0.04] border border-black/[0.04] dark:border-white/[0.08] backdrop-blur-sm px-3.5 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">{label}</span>
          {sub && <span className="text-[10px] text-muted-foreground/60">({sub})</span>}
        </div>
        <code className="text-sm font-mono">{value}</code>
      </div>
      <button onClick={onCopy} className="shrink-0 rounded-lg p-1.5 hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
        {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
      </button>
    </div>
  );
}

function PriceCard({ label, sub, value, accent }) {
  const accents = {
    blue: 'from-blue-500/10 to-transparent border-blue-500/15 dark:border-blue-400/15',
    emerald: 'from-emerald-500/10 to-transparent border-emerald-500/15 dark:border-emerald-400/15',
    amber: 'from-amber-500/10 to-transparent border-amber-500/15 dark:border-amber-400/15',
  };
  return (
    <div className={`rounded-xl bg-gradient-to-br ${accents[accent]} border px-3 py-3 text-center`}>
      <div className="text-[10px] text-muted-foreground leading-tight">
        {label}{sub && <span className="block opacity-70">{sub}</span>}
      </div>
      <div className="text-lg font-bold mt-1 tracking-tight">¥{fmtPrice(value)}</div>
    </div>
  );
}


/* ───────────────────────── Latency Sparkline (哪吒风，与后台一致) ───────────────────────── */

function spkColor(ms, status) {
  if (!ms || status === 'error' || status === 'invalid_key') return { bar: '#374151', text: '#6b7280' };
  if (ms < 200)  return { bar: '#22c55e', text: '#16a34a' };
  if (ms < 500)  return { bar: '#84cc16', text: '#65a30d' };
  if (ms < 800)  return { bar: '#f59e0b', text: '#d97706' };
  if (ms < 1500) return { bar: '#f97316', text: '#ea580c' };
  return { bar: '#ef4444', text: '#dc2626' };
}

function spkFmt(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function SparklineTooltip({ isError, lastOk, lastErr, validMs }) {
  const avg = validMs.length > 0 ? Math.round(validMs.reduce((a, b) => a + b, 0) / validMs.length) : 0;
  const min = validMs.length > 0 ? Math.min(...validMs) : 0;
  const max = validMs.length > 0 ? Math.max(...validMs) : 0;
  const fmtTs = ts => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
  return (
    <div
      className="absolute z-[9999] bottom-full left-1/2 mb-2 w-56 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-xs"
      style={{ transform: 'translateX(-50%)' }}
    >
      <div className="px-3 py-2.5 space-y-2">
        {isError ? (
          <>
            <div className="flex items-center gap-1.5 text-red-500 font-semibold">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              源站探测失败
            </div>
            <div className="text-slate-500 dark:text-slate-400 break-all leading-snug">
              {lastErr?.error || lastErr?.status || '未知错误'}
            </div>
            <div className="flex items-center gap-1 text-slate-400 text-[10px]">
              <Clock className="w-3 h-3" />
              最后探测 {fmtTs(lastErr?.ts)}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-semibold">
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
              URL 延迟正常
            </div>
            {validMs.length > 0 ? (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div><div className="text-slate-400 text-[10px]">最低</div><div className="font-semibold tabular-nums">{spkFmt(min)}</div></div>
                  <div><div className="text-slate-400 text-[10px]">平均</div><div className="font-semibold tabular-nums">{spkFmt(avg)}</div></div>
                  <div><div className="text-slate-400 text-[10px]">最高</div><div className="font-semibold tabular-nums">{spkFmt(max)}</div></div>
                </div>
                <div className="flex items-center gap-1 text-slate-400 text-[10px]">
                  <Clock className="w-3 h-3" />
                  最后成功 {fmtTs(lastOk?.ts)}
                </div>
              </>
            ) : (
              <div className="text-slate-400 text-[10px]">暂无有效数据</div>
            )}
          </>
        )}
      </div>
      <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
        style={{ borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '6px solid hsl(var(--border))' }} />
    </div>
  );
}

function lastPointEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.ms === b.ms && a.status === b.status && a.ts === b.ts;
}

function probeHistoryEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return lastPointEqual(a[a.length - 1], b[b.length - 1]);
}

function healthEqual(a, b) {
  if (a === b) return true;
  const hasA = !!(a && a.sparkline && a.sparkline.length > 0);
  const hasB = !!(b && b.sparkline && b.sparkline.length > 0);
  if (!hasA && !hasB) return true;
  if (hasA !== hasB) return false;
  return a.avgLatency === b.avgLatency && lastPointEqual(
    a.sparkline?.[a.sparkline.length - 1],
    b.sparkline?.[b.sparkline.length - 1]
  );
}

const ModelSparkline = memo(function ModelSparkline({ health, probeHistory = [] }) {
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef(null);
  const rowRef = useRef(null);
  const tooltipId = useRef(`sparkline-${Math.random().toString(36).substr(2, 9)}`);

  // 优先使用探针历史；无探针时回退到 request-log health
  const hasProbeData = probeHistory.length > 0 && probeHistory.some(
    h => (h?.status === 'ok' && h?.ms > 0) || h?.status === 'error' || h?.status === 'invalid_key'
  );
  const hasHealthData = !!(health && health.sparkline && health.sparkline.length > 0);

  if (!hasProbeData && !hasHealthData) {
    return (
      <div className="flex items-center gap-2 py-1 w-full overflow-hidden">
        <span className="h-2 w-2 rounded-full bg-muted shrink-0" />
        <div className="flex items-end gap-[2px] flex-1">
          {Array.from({ length: PROBE_BARS }).map((_, i) => (
            <div key={i} className="w-1 rounded-[2px] bg-muted" style={{ height: 10 }} />
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground/50 tabular-nums w-12 text-right shrink-0">—</span>
      </div>
    );
  }

  if (hasProbeData) {
    // 探针历史模式（与后台 ProtoRow 完全一致）
    const bars = Array.from({ length: PROBE_BARS }, (_, i) => probeHistory[i] || null);
    const lastOk = [...probeHistory].reverse().find(h => h?.status === 'ok' && h.ms > 0);
    const lastErr = [...probeHistory].reverse().find(h => h?.status === 'error' || h?.status === 'invalid_key');
    const col = spkColor(lastOk?.ms, lastOk?.status);
    const validMs = bars.filter(b => b?.status === 'ok' && b.ms > 0).map(b => b.ms);
    const maxMs = validMs.length > 0 ? Math.max(...validMs) : 500;
    const isError = !lastOk && !!lastErr;
    const MAX_BAR_HEIGHT = 32; // 限制最大高度

    // 移出 3s CD
    const handleMouseLeave = () => {
      setHovered(false);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setVisible(false), 3000);
    };

    // 全局tooltip单例显示
    useEffect(() => {
      const handleClickOutside = (e) => {
        if (rowRef.current && !rowRef.current.contains(e.target)) {
          setVisible(false);
          if (hideTimer.current) clearTimeout(hideTimer.current);
          if (currentTooltipId === tooltipId.current) {
            currentTooltipId = null;
          }
        }
      };

      const handleOtherTooltipShow = (e) => {
        if (e.detail.tooltipId !== tooltipId.current) {
          setVisible(false);
          if (hideTimer.current) clearTimeout(hideTimer.current);
        }
      };

      if (visible) {
        document.addEventListener('click', handleClickOutside);
        document.addEventListener('tooltip-show', handleOtherTooltipShow);
        // 通知其他tooltip隐藏
        document.dispatchEvent(new CustomEvent('tooltip-show', { detail: { tooltipId: tooltipId.current } }));
      }

      return () => {
        document.removeEventListener('click', handleClickOutside);
        document.removeEventListener('tooltip-show', handleOtherTooltipShow);
        if (hideTimer.current) clearTimeout(hideTimer.current);
      };
    }, [visible]);

    return (
      <div className="relative">
        {visible && (
          <SparklineTooltip isError={isError} lastOk={lastOk} lastErr={lastErr} validMs={validMs} />
        )}
        <div ref={rowRef} className="flex items-center gap-2 py-1 w-full overflow-hidden min-w-0"
          onMouseEnter={() => { 
            setHovered(true); 
            if (hideTimer.current) clearTimeout(hideTimer.current);
            setVisible(true);
          }}
          onMouseLeave={handleMouseLeave}>
          {/* 状态点 */}
          <span className="relative flex h-2 w-2 shrink-0">
            {!isError && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50" style={{ backgroundColor: col.bar }} />}
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: isError ? '#ef4444' : col.bar }} />
          </span>
          {/* 方块行 */}
          <div className="flex items-end gap-[2px] flex-1 h-8">
            {bars.map((b, i) => {
              if (!b) return <div key={i} className="w-1 rounded-[2px] bg-muted" style={{ height: 10 }} />;
              if (b.status !== 'ok') {
                return <div key={i} className="w-1 rounded-[2px]"
                  style={{ height: 4, backgroundColor: '#ef4444', opacity: i === bars.length - 1 ? 0.9 : 0.35 }} />;
              }
              const { bar } = spkColor(b.ms, b.status);
              const h = Math.min(MAX_BAR_HEIGHT, Math.max(4, Math.round((b.ms / maxMs) * MAX_BAR_HEIGHT)));
              return (
                <div key={i} className="w-1 rounded-[2px]"
                  style={{ height: h, backgroundColor: bar, opacity: i === bars.length - 1 ? 1 : 0.5 + (i / PROBE_BARS) * 0.5 }} />
              );
            })}
          </div>
          {/* 数值 */}
          <span className="shrink-0 text-[11px] tabular-nums font-semibold w-12 text-right truncate"
            style={{ color: isError ? '#ef4444' : col.text }}>
            {isError ? '离线' : spkFmt(lastOk?.ms)}
          </span>
        </div>
      </div>
    );
  }

  // request-log health 模式（回退）
  const data = health.sparkline;
  const displayMs = health.avgLatency || data[data.length - 1] || 0;
  const col = spkColor(displayMs, 'ok');
  const maxMs = Math.max(...data, 1);
  const padded = Array.from({ length: PROBE_BARS }, (_, i) => {
    const idx = i - (PROBE_BARS - data.length);
    return idx >= 0 ? data[idx] : 0;
  });

  return (
    <div className="flex items-center gap-2 py-1 w-full overflow-hidden">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50" style={{ backgroundColor: col.bar }} />
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: col.bar }} />
      </span>
      <div className="flex items-end gap-[2px] flex-1">
        {padded.map((v, i) => {
          const c = spkColor(v, 'ok');
          const isRecent = i >= PROBE_BARS - data.length;
          const h = v > 0 ? Math.max(4, Math.min(18, (v / maxMs) * 18)) : 4;
          return (
            <div key={i} className="w-1 rounded-[2px] transition-all duration-300"
              style={{ height: h, backgroundColor: isRecent ? c.bar : 'var(--muted)',
                opacity: !isRecent ? 0.2 : i === PROBE_BARS - 1 ? 1 : 0.45 + ((i - (PROBE_BARS - data.length)) / data.length) * 0.55 }} />
          );
        })}
      </div>
      <span className="text-[11px] tabular-nums font-semibold shrink-0 w-12 text-right truncate" style={{ color: col.text }}>
        {spkFmt(displayMs)}
      </span>
    </div>
  );
}, (prev, next) => probeHistoryEqual(prev.probeHistory, next.probeHistory) && healthEqual(prev.health, next.health));

/* ───────────────────────── Sort Panel (Win11 style) ───────────────────────── */

function SortPanel({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handle = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const selected = SORT_OPTIONS.find((s) => s.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 h-10 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent transition-colors"
      >
        <span className="text-muted-foreground text-xs mr-0.5">排序</span>
        <span>{selected?.label}</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          ref={(el) => {
            if (el) {
              requestAnimationFrame(() => {
                el.classList.add('opacity-100', 'scale-100', 'translate-y-0');
                el.classList.remove('opacity-0', 'scale-95', '-translate-y-1');
              });
            }
          }}
          className="absolute right-0 mt-2 z-50 w-56 rounded-2xl bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl border border-white/20 dark:border-white/10 shadow-2xl p-2 space-y-0.5 opacity-0 scale-95 -translate-y-1 transition-all duration-200 ease-out"
        >
          {SORT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = value === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-black/5 dark:hover:bg-white/10 text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
