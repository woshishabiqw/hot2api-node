import { useEffect, useState, Fragment } from 'react';
import { cn } from '../lib/utils';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import SkeletonSources from '../components/skeletons/SkeletonSources';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { StatusTooltip } from '../components/StatusTooltip';
import { Plus, Trash2, RefreshCw, Check, X, Eye, EyeOff, Activity, Edit2, Download, Layers, ChevronDown, ChevronUp, Inbox, Users, ChevronLeft, ChevronRight, Database } from 'lucide-react';
import { useAdminSSE } from '../hooks/useAdminSSE';
import { showAlert, showConfirm } from '../components/Dialog';

// Display base model_id (strip auto-suffix like _2, _3)
function displayModelId(modelId) {
  return modelId.replace(/_\d+$/, '');
}

function parseGroups(str) {
  if (!str) return ['default'];
  if (Array.isArray(str)) return str.filter(g => typeof g === 'string' && g.length > 0).length > 0 ? str.filter(g => typeof g === 'string') : ['default'];
  try {
    const arr = JSON.parse(str);
    if (Array.isArray(arr) && arr.length > 0) {
      const filtered = arr.filter(g => typeof g === 'string' && g.length > 0);
      return filtered.length > 0 ? filtered : ['default'];
    }
    return ['default'];
  } catch { return typeof str === 'string' && str.length > 0 ? [str] : ['default']; }
}

export default function Sources() {
  const [sources, setSources] = useState([]);
  const [models, setModels] = useState([]);
  const [concurrency, setConcurrency] = useState([]);
  const [instances, setInstances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [testing, setTesting] = useState(null);
  const [testingModelId, setTestingModelId] = useState(null);
  const [showKey, setShowKey] = useState({});
  const [editingModel, setEditingModel] = useState(null);
  const [fetchDialog, setFetchDialog] = useState(null);
  const [fetchResult, setFetchResult] = useState(null);
  const [validateDialog, setValidateDialog] = useState(null);
  const [validateResult, setValidateResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validateProtocolDialog, setValidateProtocolDialog] = useState(null);
  const [validateProtocol, setValidateProtocol] = useState('openai');
  const [initLoading, setInitLoading] = useState(false);
  const [detectedModels, setDetectedModels] = useState(null);
  const [selectedModels, setSelectedModels] = useState([]);
  const [detecting, setDetecting] = useState(false);
  const [detectedProtocol, setDetectedProtocol] = useState(null);
  const [importing, setImporting] = useState(false);
  const [groups, setGroups] = useState([]);
  const [instancePage, setInstancePage] = useState(0);
  const [editDialog, setEditDialog] = useState(null);
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModel, setNewModel] = useState({ source_id: '', model_id: '', model_group: ['default'] });
  const [editForm, setEditForm] = useState({});
  const [modelGroupFilter, setModelGroupFilter] = useState('all');
  const [modelSearch, setModelSearch] = useState('');
  const [groupEditModel, setGroupEditModel] = useState(null);
  const [modelPage, setModelPage] = useState(0);
  const MODEL_PAGE_SIZE = 10;
  const [mgmtPage, setMgmtPage] = useState(0);
  const [selectedModelIds, setSelectedModelIds] = useState([]);
  const MGMT_PAGE_SIZE = 20;
  const [sourcePage, setSourcePage] = useState(0);
  const SOURCE_PAGE_SIZE = 12;
  const [selectedSourceIds, setSelectedSourceIds] = useState([]);
  const [routingMode, setRoutingMode] = useState('auto');
  const [switchingMode, setSwitchingMode] = useState(false);
  const [expandedInstances, setExpandedInstances] = useState(new Set());
  const [showAddInstance, setShowAddInstance] = useState(false);
  const [newInstance, setNewInstance] = useState({
    name: '',
    inbound_model_id: '',
    inbound_source_id: '',
    outbound_model_id: '',
    stack_mode: 'merged',
    member_source_ids: [],
    outbound_configs: {}
  });
  const [editInstanceDialog, setEditInstanceDialog] = useState(null);
  const [editInstanceForm, setEditInstanceForm] = useState({
    name: '',
    outbound_model_id: '',
    stack_mode: 'merged',
    member_source_ids: [],
    outbound_configs: {}
  });
  const [newInstanceEligibleSources, setNewInstanceEligibleSources] = useState([]);
  const [editInstanceEligibleSources, setEditInstanceEligibleSources] = useState([]);
  const INSTANCE_PAGE_SIZE = 10;

  function findInboundModel(inboundModelId, inboundSourceId) {
    return models.find(m => m.model_id === inboundModelId && m.source_id === inboundSourceId);
  }

  function getInboundModelIdentifiers(inboundModel) {
    const ids = new Set();
    if (inboundModel?.model_id) ids.add(inboundModel.model_id);
    if (inboundModel?.model_alias) ids.add(inboundModel.model_alias);
    if (inboundModel?.source_model_id) ids.add(inboundModel.source_model_id);
    return ids;
  }

  function modelMatchesInbound(m, identifiers) {
    if (!identifiers || identifiers.size === 0) return false;
    if (m.instance_id) return false;
    return identifiers.has(m.model_id) || identifiers.has(m.model_alias) || identifiers.has(m.source_model_id);
  }

  function computeEligibleSources(inboundModelId, inboundSourceId, allSources, allModels) {
    const inboundModel = findInboundModel(inboundModelId, inboundSourceId);
    if (!inboundModel) return [];
    const identifiers = getInboundModelIdentifiers(inboundModel);
    return allSources.filter(s => {
      if (s.id === inboundSourceId) return false;
      return allModels.some(m => m.source_id === s.id && modelMatchesInbound(m, identifiers));
    });
  }

  function makeDefaultOutboundConfig(sid, inboundModel, outboundModelId, isInbound) {
    return {
      source_model_id: isInbound
        ? (inboundModel.source_model_id || inboundModel.model_id)
        : `${outboundModelId || inboundModel.model_id} -均衡管理`,
      input_price: inboundModel.input_price ?? 0.025,
      input_price_cache: inboundModel.input_price_cache ?? 0.02,
      output_price: inboundModel.output_price ?? 2,
      rate_multiplier: inboundModel.rate_multiplier ?? 1,
      supports_tools: inboundModel.supports_tools ?? 1,
      supports_json: inboundModel.supports_json ?? 1,
      supports_fim: inboundModel.supports_fim ?? 0,
      is_vision: inboundModel.is_vision ?? 0
    };
  }

  function modelToOutboundConfig(model) {
    return {
      source_model_id: model.source_model_id || '',
      input_price: model.input_price ?? 0.025,
      input_price_cache: model.input_price_cache ?? 0.02,
      output_price: model.output_price ?? 2,
      rate_multiplier: model.rate_multiplier ?? 1,
      supports_tools: model.supports_tools ?? 1,
      supports_json: model.supports_json ?? 1,
      supports_fim: model.supports_fim ?? 0,
      is_vision: model.is_vision ?? 0
    };
  }

  // 新建/编辑实例弹窗打开时，只计算一次均衡源站候选列表
  useEffect(() => {
    if (!showAddInstance || !newInstance.inbound_source_id) {
      setNewInstanceEligibleSources([]);
      return;
    }
    setNewInstanceEligibleSources(
      computeEligibleSources(newInstance.inbound_model_id, newInstance.inbound_source_id, sources, models)
    );
  }, [showAddInstance, newInstance.inbound_model_id, newInstance.inbound_source_id, sources, models]);

  useEffect(() => {
    if (!editInstanceDialog) {
      setEditInstanceEligibleSources([]);
      return;
    }
    const inst = instances.find(i => i.id === editInstanceDialog);
    if (!inst) return;
    setEditInstanceEligibleSources(
      computeEligibleSources(inst.inbound_model_id, inst.inbound_source_id, sources, models)
    );
  }, [editInstanceDialog, instances, sources, models]);

  function OutboundConfigSection({ configs, onChange, memberSourceIds, inboundSourceId, inboundModel, outboundModelId }) {
    const allIds = [inboundSourceId, ...(memberSourceIds || []).filter(id => id !== inboundSourceId)].filter(Boolean);
    if (allIds.length === 0 || !inboundModel) return null;
    return (
      <div className="space-y-2">
        <label className="text-sm font-medium">出站模型配置</label>
        <p className="text-xs text-muted-foreground">为每个成员源站的出站模型设置中转站模型ID、价格、倍率及能力</p>
        <div className="border rounded-md p-3 space-y-3 max-h-80 overflow-y-auto">
          {allIds.map(sid => {
            const s = sources.find(src => src.id === sid);
            const cfg = configs[sid] || makeDefaultOutboundConfig(sid, inboundModel, outboundModelId, sid === inboundSourceId);
            const update = (patch) => onChange({ ...configs, [sid]: { ...cfg, ...patch } });
            return (
              <div key={sid} className="rounded-lg border bg-muted/20 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>{s?.name || `源站#${sid}`}</span>
                  {sid === inboundSourceId && <Badge variant="secondary" className="text-[10px]">主</Badge>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground">中转站模型 ID</label>
                    <Input
                      value={cfg.source_model_id || ''}
                      onChange={(e) => update({ source_model_id: e.target.value })}
                      className="h-8 text-xs"
                      placeholder={sid === inboundSourceId ? (inboundModel.source_model_id || inboundModel.model_id) : `${outboundModelId || inboundModel.model_id} -均衡管理`}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground">倍率</label>
                    <Input type="number" value={cfg.rate_multiplier ?? inboundModel.rate_multiplier ?? 1} onChange={(e) => update({ rate_multiplier: parseFloat(e.target.value) })} className="h-8 text-xs" step="0.01" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground">输入价格（未缓存）</label>
                    <Input type="number" value={cfg.input_price ?? inboundModel.input_price ?? 0.025} onChange={(e) => update({ input_price: parseFloat(e.target.value) })} className="h-8 text-xs" step="0.001" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground">输入价格（缓存）</label>
                    <Input type="number" value={cfg.input_price_cache ?? inboundModel.input_price_cache ?? 0.02} onChange={(e) => update({ input_price_cache: parseFloat(e.target.value) })} className="h-8 text-xs" step="0.001" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground">输出价格</label>
                    <Input type="number" value={cfg.output_price ?? inboundModel.output_price ?? 2} onChange={(e) => update({ output_price: parseFloat(e.target.value) })} className="h-8 text-xs" step="0.01" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {[
                    { key: 'supports_tools', label: '工具' },
                    { key: 'supports_json', label: 'JSON' },
                    { key: 'supports_fim', label: 'FIM' },
                    { key: 'is_vision', label: 'Vision' }
                  ].map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={!!cfg[key]}
                        onChange={(e) => update({ [key]: e.target.checked ? 1 : 0 })}
                        className="rounded border-gray-300"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const [newSource, setNewSource] = useState({
    name: '',
    base_url: '',
    protocol: 'openai',
    api_key: '',
    is_relay: false,
    api_keys: {},
    api_urls: {},
    weight: 1,
    max_concurrent: 1000000,
    source_group: '',
    quota_limit: 1000000,
    strip_tools: false
  });

  const [fetchParams, setFetchParams] = useState({
    default_input_price: 0.025,
    default_input_price_cache: 0.02,
    default_output_price: 2,
    default_groups: ['default']
  });

  // 诊断：监听 state 变化，如果 models/sources 中出现非预期的对象值就报警
  useEffect(() => {
    for (const m of models) {
      for (const [k, v] of Object.entries(m)) {
        if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
          console.error(`[Sources DIAGNOSE] models[${m.id}].${k} 是对象:`, v);
        }
      }
    }
  }, [models]);

  useEffect(() => {
    for (const s of sources) {
      for (const [k, v] of Object.entries(s)) {
        if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) && k !== 'api_keys' && k !== 'api_urls' && k !== 'effective_status') {
          console.error(`[Sources DIAGNOSE] sources[${s.id}].${k} 是对象:`, v);
        }
      }
    }
  }, [sources]);

  useAdminSSE(['sources.changed', 'instances.changed', 'routing.changed'], {
    'sources.changed': () => loadData(),
    'instances.changed': () => { loadInstances(); loadData(); },
    'routing.changed': () => loadRoutingMode()
  });

  useEffect(() => {
    loadData();
    loadRoutingMode();
    // 并发数没有 SSE 持续推送，保留 10s 轮询作为补充
    const interval = setInterval(loadConcurrency, 10000);

    // 监听路由模式变化事件
    const handleRoutingModeChange = () => {
      loadRoutingMode();
    };
    window.addEventListener('routingModeChanged', handleRoutingModeChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener('routingModeChanged', handleRoutingModeChange);
    };
  }, []);

  const loadRoutingMode = async () => {
    try {
      // 优先从 localStorage 读取，保持用户选择
      const localMode = localStorage.getItem('routingMode');
      if (localMode) {
        setRoutingMode(localMode);
      }

      // 从 API 加载最新状态并同步到 localStorage
      const res = await api.get('/admin/routing/status');
      const apiMode = res.data?.settings?.mode || 'auto';
      setRoutingMode(apiMode);
      localStorage.setItem('routingMode', apiMode);
    } catch (e) {
      console.error('[Sources] Failed to load routing mode:', e);
      // 如果 API 失败，使用 localStorage 的值
      const localMode = localStorage.getItem('routingMode');
      setRoutingMode(localMode || 'auto');
    }
  };

  const handleRoutingModeToggle = async () => {
    setSwitchingMode(true);
    try {
      const newMode = routingMode === 'auto' ? 'manual' : 'auto';
      await api.put('/admin/routing/mode', { mode: newMode });
      setRoutingMode(newMode);
      localStorage.setItem('routingMode', newMode); // 同步到 localStorage
      window.dispatchEvent(new Event('routingModeChanged')); // 通知其他组件
    } catch (e) {
      console.error('[Sources] Failed to toggle routing mode:', e);
      showAlert('切换失败', 'error');
    } finally {
      setSwitchingMode(false);
    }
  };

  // 防御性数据清洗：保留后端返回的对象/数组结构，仅对真正会被 React child 渲染出错的值兜底转字符串
  function sanitizeApiData(items, knownObjects = new Set()) {
    if (!Array.isArray(items)) return [];
    return items.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        console.error(`[Sources] API 返回了非对象元素 [${idx}]:`, item);
        return {};
      }
      const clean = {};
      for (const [k, v] of Object.entries(item)) {
        if (v === null || v === undefined) {
          clean[k] = v;
        } else if ((knownObjects.has(k) || (!Array.isArray(v) && typeof v === 'object')) && v !== null) {
          // 保留已知对象字段以及所有普通对象（后端现在会返回结构化状态对象）
          clean[k] = v;
        } else if (Array.isArray(v)) {
          // 数组字段保持原样（也是后端常见返回）
          clean[k] = v;
        } else if (typeof v === 'object') {
          console.warn(`[Sources] API 返回了未预期的对象值：${k} =`, v, 'item =', item);
          clean[k] = String(v);
        } else {
          clean[k] = v;
        }
      }
      return clean;
    });
  }

  const loadData = async () => {
    const scrollY = window.scrollY;
    setLoading(true);
    try {
      const [sourcesRes, modelsRes, groupsRes] = await Promise.all([
        api.get('/admin/sources'),
        api.get('/admin/models'),
        api.get('/admin/model-groups')
      ]);
      console.log('[Sources loadData] sourcesRes.data type:', typeof sourcesRes.data, Array.isArray(sourcesRes.data));
      console.log('[Sources loadData] modelsRes.data type:', typeof modelsRes.data, Array.isArray(modelsRes.data), 'length:', modelsRes.data?.length);
      console.log('[Sources loadData] groupsRes.data type:', typeof groupsRes.data, Array.isArray(groupsRes.data));
      const MODEL_STATUS_OBJECTS = new Set(['routing_status', 'balance_status', 'effective_source_status']);
      const sanitizedSources = sanitizeApiData(sourcesRes.data, new Set(['api_keys', 'api_urls', 'effective_status']));
      const sanitizedModels = sanitizeApiData(modelsRes.data, MODEL_STATUS_OBJECTS);
      setSources(sanitizedSources);
      // 收集所有虚拟源站（去重、非空）
      const vg = [...new Set(sanitizedSources.map(s => s.source_group).filter(Boolean))].sort();

      // 计算虚拟源站详情
      const groupsMap = new Map();
      for (const s of sanitizedSources) {
        if (!s.source_group) continue;
        if (!groupsMap.has(s.source_group)) {
          groupsMap.set(s.source_group, {
            name: s.source_group,
            stack_mode: s.stack_mode,
            sources: [],
            models: [],
            total_max_concurrent: 0,
            total_current_concurrent: 0
          });
        }
        const g = groupsMap.get(s.source_group);
        g.sources.push({
          id: s.id,
          name: s.name,
          current_concurrent: s.current_concurrent || 0,
          max_concurrent: s.max_concurrent || 0,
          status: s.status
        });
        g.total_max_concurrent += (s.max_concurrent || 0);
        g.total_current_concurrent += (s.current_concurrent || 0);
      }
      // 关联模型到虚拟源站
      for (const m of sanitizedModels) {
        const s = sanitizedSources.find(src => src.id === m.source_id);
        if (s && s.source_group && groupsMap.has(s.source_group)) {
          const g = groupsMap.get(s.source_group);
          if (m.model_id && !g.models.includes(m.model_id)) g.models.push(m.model_id);
          if (m.model_alias && m.model_alias !== m.model_id && !g.models.includes(m.model_alias)) {
            g.models.push(m.model_alias);
          }
        }
      }

      setModels(sanitizedModels);
      setGroups(sanitizeApiData(groupsRes.data));
      loadConcurrency();
      loadInstances();
    } catch (err) {
      console.error('[Sources loadData] API error:', err);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  };

  const loadConcurrency = async () => {
    try {
      const res = await api.get('/admin/sources/concurrency');
      setConcurrency(res.data || []);
    } catch (e) {}
  };

  const loadInstances = async () => {
    try {
      const res = await api.get('/admin/instances');
      setInstances(res.data || []);
    } catch (e) {
      console.error('[Sources] Failed to load instances:', e);
    }
  };

  const handleCreateInstance = async (e) => {
    e.preventDefault();
    if (!newInstance.member_source_ids || newInstance.member_source_ids.length === 0) {
      showAlert('请至少选择一个均衡源站');
      return;
    }
    try {
      await api.post('/admin/instances', newInstance);
      setNewInstance({ name: '', inbound_model_id: '', inbound_source_id: '', outbound_model_id: '', stack_mode: 'merged', member_source_ids: [], outbound_configs: {} });
      setShowAddInstance(false);
      loadInstances();
    } catch (err) {
      showAlert(err.response?.data?.error || '创建失败');
    }
  };

  const handleDeleteInstance = async (id) => {
    if (!await showConfirm('确定要删除这个实例吗？')) return;
    try {
      await api.delete(`/admin/instances/${id}`);
      loadInstances();
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const handleUpdateInstanceStackMode = async (id, mode) => {
    try {
      await api.put(`/admin/instances/${id}`, { stack_mode: mode });
      setInstances(prev => prev.map(inst => inst.id === id ? { ...inst, stack_mode: mode } : inst));
    } catch (err) {
      showAlert('更新失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleOpenEditInstance = (inst) => {
    setEditInstanceDialog(inst.id);
    const memberIds = (inst.members || []).map(m => m.source_id).filter(sid => sid !== inst.inbound_source_id);
    const inboundModel = findInboundModel(inst.inbound_model_id, inst.inbound_source_id);
    const configs = {};
    for (const sid of [inst.inbound_source_id, ...memberIds]) {
      const model = models.find(m => m.instance_id === inst.id && m.source_id === sid);
      if (model) configs[sid] = modelToOutboundConfig(model);
      else if (inboundModel) configs[sid] = makeDefaultOutboundConfig(sid, inboundModel, inst.outbound_model_id, sid === inst.inbound_source_id);
    }
    setEditInstanceForm({
      name: inst.name || '',
      outbound_model_id: inst.outbound_model_id || '',
      stack_mode: inst.stack_mode || 'merged',
      member_source_ids: memberIds,
      outbound_configs: configs
    });
  };

  const handleUpdateInstance = async (e) => {
    e.preventDefault();
    if (!editInstanceForm.member_source_ids || editInstanceForm.member_source_ids.length === 0) {
      showAlert('请至少选择一个均衡源站');
      return;
    }
    try {
      const id = editInstanceDialog;
      await api.put(`/admin/instances/${id}`, {
        name: editInstanceForm.name,
        outbound_model_id: editInstanceForm.outbound_model_id,
        stack_mode: editInstanceForm.stack_mode
      });
      await api.put(`/admin/instances/${id}/members`, {
        member_source_ids: editInstanceForm.member_source_ids,
        outbound_configs: editInstanceForm.outbound_configs
      });
      setEditInstanceDialog(null);
      loadInstances();
    } catch (err) {
      showAlert(err.response?.data?.error || '更新失败');
    }
  };

  // 智能检测协议：根据 api_urls 推断
  const detectProtocol = (apiUrls) => {
    if (apiUrls?.openai) return 'openai';
    if (apiUrls?.anthropic) return 'anthropic';
    if (apiUrls?.gemini) return 'gemini';
    if (apiUrls?.bedrock) return 'bedrock';
    return 'openai';
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...newSource };
      payload.protocol = payload.is_relay ? 'relay' : detectProtocol(payload.api_urls);
      // 如果没有设置 base_url，从 api_urls 中取第一个非空的作为 base_url
      if (!payload.base_url) {
        const firstUrl = Object.values(payload.api_urls).find(u => u);
        if (firstUrl) payload.base_url = firstUrl;
      }
      delete payload.is_relay;
      await api.post('/admin/sources', payload);
      setNewSource({ name: '', base_url: '', protocol: 'openai', api_key: '', is_relay: false, api_keys: {}, api_urls: {}, weight: 1, max_concurrent: 1000000, source_group: '', quota_limit: 1000000, strip_tools: false });
      setShowAdd(false);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '添加失败');
    }
  };

  const handleDelete = async (id) => {
    if (!await showConfirm('确定要删除这个源站吗？')) return;
    try {
      await api.delete(`/admin/sources/${id}`);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const handleTest = async (id) => {
    setTesting(id);
    try {
      const res = await api.post(`/admin/sources/${id}/test`);
      showAlert(res.data.valid ? 'Key 有效！' : `失败: ${res.data.error}`);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '测试失败');
    } finally {
      setTesting(null);
    }
  };

  const handleTestModel = async (model) => {
    setTestingModelId(model.id);
    try {
      const res = await api.post(`/admin/models/${model.id}/test-key`);
      showAlert(res.data.valid ? `Key 有效！（${res.data.modelId}）` : `失败: ${res.data.error}`);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '测试失败');
    } finally {
      setTestingModelId(null);
    }
  };

  const handleFetchModels = async (id) => {
    setFetchDialog(id);
    setDetectedModels(null);
    setSelectedModels([]);
    setFetchParams({ default_input_price: 0.025, default_input_price_cache: 0.02, default_output_price: 2, default_groups: ['default'] });
    setDetecting(true);
    try {
      const res = await api.post(`/admin/sources/${id}/detect-models`);
      if (res.data.success) {
        setDetectedModels(res.data.models || []);
        setDetectedProtocol(res.data.detectedProtocol || null);
        setModelPage(0);
        // Default: no models selected
        setSelectedModels([]);
      } else {
        showAlert(res.data.error || '检测模型失败');
        setFetchDialog(null);
      }
    } catch (err) {
      showAlert(err.response?.data?.error || '检测模型失败');
      setFetchDialog(null);
    } finally {
      setDetecting(false);
    }
  };

  const executeImportModels = async () => {
    if (!fetchDialog || selectedModels.length === 0) return;
    setImporting(true);
    try {
      const res = await api.post(`/admin/sources/${fetchDialog}/import-models`, {
        model_ids: selectedModels,
        ...fetchParams
      });
      console.log('[Sources import] API response:', res.data);
      if (res.data.success) {
        const result = {
          imported: res.data.imported || 0,
          skipped: res.data.skipped || [],
          total: selectedModels.length
        };
        console.log('[Sources import] setting fetchResult:', result);
        setFetchResult(result);
        setFetchDialog(null);
        setDetectedModels(null);
        setSelectedModels([]);
        console.log('[Sources import] calling loadData...');
        await loadData();
        console.log('[Sources import] loadData done');
      } else {
        showAlert(res.data.error || '导入失败');
      }
    } catch (err) {
      console.error('[Sources import] error:', err);
      showAlert(err.response?.data?.error || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const handleValidateModel = (model) => {
    setValidateProtocolDialog(model);
    setValidateProtocol(model.protocol || 'openai');
  };

  const runValidateModel = async (model, protocol) => {
    setValidateDialog(model.id);
    setValidating(true);
    setValidateResult(null);
    try {
      const res = await api.post(`/admin/models/${model.id}/validate`, { protocol });
      setValidateResult(res.data);
    } catch (err) {
      setValidateResult({
        status: 'error',
        error: err.response?.data?.error || err.message || '验证失败',
        sourceName: model.source_name,
        protocol,
        modelId: model.source_model_id || model.model_id,
        checkedAt: new Date().toISOString()
      });
    } finally {
      setValidating(false);
    }
  };

  const handleConfirmValidateProtocol = () => {
    const model = validateProtocolDialog;
    setValidateProtocolDialog(null);
    if (model) runValidateModel(model, validateProtocol);
  };

  const handleInitAllSources = async () => {
    if (!await showConfirm('确定要立即初始化全部源站的路由检测并重置禁用状态吗？')) return;
    setInitLoading(true);
    try {
      const res = await api.post('/admin/sources/probe-all');
      const count = res.data?.count || 0;
      showAlert(`已初始化 ${count} 个源站的路由检测`);
      await loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '源站路由检测初始化失败');
    } finally {
      setInitLoading(false);
    }
  };

  const toggleModelSelection = (modelId) => {
    setSelectedModels(prev =>
      prev.includes(modelId) ? prev.filter(id => id !== modelId) : [...prev, modelId]
    );
  };

  const toggleAllModels = () => {
    if (!detectedModels) return;
    const allSelectable = detectedModels.filter(m => !m.already_exists);
    const pageModels = detectedModels.slice(modelPage * MODEL_PAGE_SIZE, (modelPage + 1) * MODEL_PAGE_SIZE);
    const pageSelectable = pageModels.filter(m => !m.already_exists);
    const allPageSelected = pageSelectable.length > 0 && pageSelectable.every(m => selectedModels.includes(m.id));
    const allAllSelected = allSelectable.length > 0 && allSelectable.every(m => selectedModels.includes(m.id));

    if (allAllSelected) {
      // All selected → deselect all
      setSelectedModels([]);
    } else if (allPageSelected) {
      // Current page all selected → select all pages
      setSelectedModels(allSelectable.map(m => m.id));
    } else {
      // None or partial → select current page
      setSelectedModels(prev => [...new Set([...prev, ...pageSelectable.map(m => m.id)])]);
    }
  };

  const handleAddModel = async () => {
    if (!newModel.source_id || !newModel.model_id.trim()) {
      showAlert('请选择源站并输入模型ID');
      return;
    }
    try {
      const res = await api.post('/admin/models', {
        source_id: parseInt(newModel.source_id),
        model_id: newModel.model_id.trim(),
        model_group: newModel.model_group
      });
      if (res.data.renamed) {
        showAlert(`模型ID已存在，自动重命名为: ${res.data.model_id}`);
      }
      setNewModel({ source_id: '', model_id: '', model_group: ['default'] });
      setShowAddModel(false);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '添加失败');
    }
  };

  const toggleSource = async (id, isActive) => {
    try {
      await api.put(`/admin/sources/${id}`, { is_active: isActive ? 0 : 1 });
      setSources(prev => prev.map(s => s.id === id ? { ...s, is_active: isActive ? 0 : 1 } : s));
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const updateConcurrent = async (id, maxConcurrent) => {
    try {
      await api.put(`/admin/sources/${id}`, { max_concurrent: parseInt(maxConcurrent) });
      setSources(prev => prev.map(s => s.id === id ? { ...s, max_concurrent: parseInt(maxConcurrent) } : s));
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const updateModel = async (id, data) => {
    try {
      await api.put(`/admin/models/${id}`, data);
      setEditingModel(null);
      setModels(prev => prev.map(m => m.id === id ? { ...m, ...data } : m));
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const deleteModel = async (id) => {
    if (!await showConfirm('确定要删除这个模型吗？')) return;
    try {
      await api.delete(`/admin/models/${id}`);
      setModels(prev => prev.filter(m => m.id !== id));
      setSelectedModelIds(prev => prev.filter(i => i !== id));
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const batchDeleteModels = async () => {
    if (selectedModelIds.length === 0) return;
    if (!await showConfirm(`确定要删除选中的 ${selectedModelIds.length} 个模型吗？`)) return;
    try {
      await api.post('/admin/models/batch-delete', { ids: selectedModelIds });
      setModels(prev => prev.filter(m => !selectedModelIds.includes(m.id)));
      setSelectedModelIds([]);
    } catch (err) {
      showAlert(err.response?.data?.error || '批量删除失败');
    }
  };

  const batchUpdateModels = async (data) => {
    if (selectedModelIds.length === 0) return;
    try {
      await api.post('/admin/models/batch-update', { ids: selectedModelIds, ...data });
      setModels(prev => prev.map(m => selectedModelIds.includes(m.id) ? { ...m, ...data } : m));
    } catch (err) {
      showAlert(err.response?.data?.error || '批量更新失败');
    }
  };

  const toggleModelSelect = (id) => {
    setSelectedModelIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const toggleSourceSelect = (id) => {
    setSelectedSourceIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const batchDeleteSources = async () => {
    if (selectedSourceIds.length === 0) return;
    if (!await showConfirm(`确定要删除选中的 ${selectedSourceIds.length} 个源站吗？`)) return;
    try {
      await api.post('/admin/sources/batch-delete', { ids: selectedSourceIds });
      setSources(prev => prev.filter(s => !selectedSourceIds.includes(s.id)));
      setSelectedSourceIds([]);
    } catch (err) {
      showAlert(err.response?.data?.error || '批量删除失败');
    }
  };

  const batchUpdateSources = async (data) => {
    if (selectedSourceIds.length === 0) return;
    try {
      await api.post('/admin/sources/batch-update', { ids: selectedSourceIds, ...data });
      setSources(prev => prev.map(s => selectedSourceIds.includes(s.id) ? { ...s, ...data } : s));
      setSelectedSourceIds([]);
    } catch (err) {
      showAlert(err.response?.data?.error || '批量更新失败');
    }
  };

  const batchProbeSources = async () => {
    if (selectedSourceIds.length === 0) return;
    setInitLoading(true);
    try {
      const res = await api.post('/admin/sources/probe-selected', { ids: selectedSourceIds });
      showAlert(`已初始化 ${res.data?.count || selectedSourceIds.length} 个源站的路由检测`);
      setSelectedSourceIds([]);
      await loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '批量初始化失败');
    } finally {
      setInitLoading(false);
    }
  };

  const getSourceStatus = (source) => {
    const eff = source?.effective_status;
    if (eff && typeof eff === 'object' && eff.label) {
      return (
        <StatusTooltip
          label={eff.label}
          variant={eff.variant || 'secondary'}
          reason={eff.short_reason || eff.reason || ''}
          statusCode={eff.status_code}
          detail={eff.detail}
          lastCheckText={eff.last_check_text}
        >
          <Badge variant={eff.variant || 'secondary'}>{eff.label}</Badge>
        </StatusTooltip>
      );
    }
    // Fallback for old data shape
    const safeStatus = typeof source?.status === 'string' ? source.status : 'unknown';
    const variants = {
      valid: 'success',
      checking: 'warning',
      invalid: 'destructive',
      insufficient: 'warning',
      unavailable: 'warning',
      error: 'destructive',
      unknown: 'secondary'
    };
    const labels = {
      valid: '有效',
      checking: '失效中',
      invalid: '停用',
      insufficient: '余额不足',
      unavailable: '源站不可用',
      error: '错误',
      unknown: '未知'
    };
    return <Badge variant={variants[safeStatus] || 'secondary'}>{labels[safeStatus] || safeStatus}</Badge>;
  };

  const getModelRoutingStatus = (model) => {
    const rs = model?.routing_status;
    if (rs && typeof rs === 'object' && rs.label) {
      return (
        <StatusTooltip
          label={rs.label}
          variant={rs.variant || 'secondary'}
          reason={rs.reason || ''}
        >
          <Badge variant={rs.variant || 'secondary'}>{rs.label}</Badge>
        </StatusTooltip>
      );
    }
    // Fallback for old data shape
    return <Badge variant={model?.is_active ? 'success' : 'destructive'}>{model?.is_active ? '启用' : '禁用'}</Badge>;
  };

  const getModelBalanceStatus = (model) => {
    const bs = model?.balance_status;
    if (bs && typeof bs === 'object' && bs.label) {
      const dotColors = {
        success: 'bg-green-500',
        warning: 'bg-yellow-500',
        destructive: 'bg-red-500',
        secondary: 'bg-gray-400'
      };
      return (
        <StatusTooltip
          label={bs.label}
          variant={bs.variant || 'secondary'}
          reason={bs.reason || ''}
        >
          <div className="flex items-center gap-1 cursor-help">
            <span className={cn('w-2 h-2 rounded-full', dotColors[bs.variant] || 'bg-gray-400')} />
            <span className="text-xs">{bs.label}</span>
            {bs.instance_name && <Badge variant="secondary" className="text-[10px]">{bs.instance_name}</Badge>}
            {bs.group_name && <Badge variant="secondary" className="text-[10px]">{bs.group_name}</Badge>}
          </div>
        </StatusTooltip>
      );
    }
    // Fallback for old data shape
    return (
      <div className="flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-gray-300" />
        <span className="text-xs text-muted-foreground">直连</span>
      </div>
    );
  };

  const getConcurrencyInfo = (sourceId) => {
    if (!Array.isArray(concurrency)) return { current_concurrent: 0, utilization: 0 };
    return concurrency.find(c => c.id === sourceId) || { current_concurrent: 0, utilization: 0 };
  };

  const maskKey = (key) => {
    if (!key) return '-';
    return key.substring(0, 8) + '...' + key.substring(key.length - 4);
  };

  if (loading) {
    return <SkeletonSources />;
  }

  // 计算哪些模型真正在均衡实例中（按模型ID匹配，而非源站source_group）
  const modelInstanceMap = new Map();
  for (const inst of instances) {
    if (inst.inbound_model_id) modelInstanceMap.set(inst.inbound_model_id, inst);
    if (inst.outbound_model_id && inst.outbound_model_id !== inst.inbound_model_id) {
      modelInstanceMap.set(inst.outbound_model_id, inst);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">源站管理</h1>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={handleInitAllSources} disabled={initLoading} title="立即初始化全部源站的路由检测并重置禁用状态">
            {initLoading ? (
              <><RefreshCw className="w-4 h-4 animate-spin mr-2" /> 初始化中...</>
            ) : (
              <><Database className="w-4 h-4 mr-2" /> 检测系统手动初始化</>
            )}
          </Button>
          <div className="flex items-center gap-2 bg-muted rounded-lg p-1">
            <button
              onClick={handleRoutingModeToggle}
              disabled={switchingMode}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                routingMode === 'auto'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Activity className="w-4 h-4" />
              自动
            </button>
            <button
              onClick={handleRoutingModeToggle}
              disabled={switchingMode}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                routingMode === 'manual'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Edit2 className="w-4 h-4" />
              手动
            </button>
          </div>
          <Button onClick={() => setShowAdd(!showAdd)}>
            <Plus className="w-4 h-4 mr-2" />
            添加源站
          </Button>
        </div>
      </div>

      {showAdd && (
        <Card>
          <CardHeader>
            <CardTitle>添加新源站</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">名称</label>
                <Input
                  value={newSource.name}
                  onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                  placeholder="我的源站"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Key</label>
                <Input
                  type="password"
                  value={newSource.api_key}
                  onChange={(e) => setNewSource({ ...newSource, api_key: e.target.value })}
                  placeholder="sk-..."
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">各协议独立 URL（可选，留空则使用默认 URL）</label>
                <p className="text-sm font-medium text-muted-foreground">冗余使用，不建议一个源站出现其他地方的url，如果需要请使用叠加模式的主备模式。</p>
                <div className="grid grid-cols-2 gap-3">
                  {[['openai', 'OpenAI URL'], ['anthropic', 'Anthropic URL'], ['gemini', 'Gemini URL'], ['bedrock', 'Bedrock URL']].map(([proto, label]) => (
                    <div key={proto} className="space-y-1">
                      <label className="text-xs text-muted-foreground">{label}</label>
                      <Input
                        value={newSource.api_urls[proto] || ''}
                        onChange={(e) => setNewSource({ ...newSource, api_urls: { ...newSource.api_urls, [proto]: e.target.value } })}
                        placeholder="https://..."
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">权重</label>
                  <Input
                    type="number"
                    value={newSource.weight}
                    onChange={(e) => setNewSource({ ...newSource, weight: parseInt(e.target.value) })}
                    min="1"
                    max="10000000"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">最大并发</label>
                  <Input
                    type="number"
                    value={newSource.max_concurrent}
                    onChange={(e) => setNewSource({ ...newSource, max_concurrent: parseInt(e.target.value) })}
                    min="1"
                    max="10000000"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">额度限制 (Token数, 0=无限制)</label>
                <Input
                  type="number"
                  value={newSource.quota_limit}
                  onChange={(e) => setNewSource({ ...newSource, quota_limit: parseInt(e.target.value) })}
                  min="0"
                  placeholder="1000000"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="new-strip-tools"
                  checked={newSource.strip_tools}
                  onChange={(e) => setNewSource({ ...newSource, strip_tools: e.target.checked })}
                />
                <label htmlFor="new-strip-tools" className="text-sm font-medium">剥离Tools参数</label>
              </div>
              <div className="flex gap-2">
                <Button type="submit">添加</Button>
                <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>取消</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {selectedSourceIds.length > 0 && (
            <div className="p-3 border-b bg-muted/30 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">已选 {String(selectedSourceIds.length)} 个源站</span>
              <Button size="sm" variant="outline" onClick={() => batchUpdateSources({ is_active: 1 })}>批量启用</Button>
              <Button size="sm" variant="outline" onClick={() => batchUpdateSources({ is_active: 0 })}>批量禁用</Button>
              <Button size="sm" variant="outline" onClick={batchProbeSources} disabled={initLoading}>批量初始化</Button>
              <Button size="sm" variant="destructive" onClick={batchDeleteSources}>
                <Trash2 className="w-3 h-3 mr-1" /> 批量删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedSourceIds([])}>取消选择</Button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <th className="p-4 w-10">
                    <input
                      type="checkbox"
                      ref={el => {
                        if (!el) return;
                        const pageSources = sources.slice(sourcePage * SOURCE_PAGE_SIZE, (sourcePage + 1) * SOURCE_PAGE_SIZE);
                        const allPageSelected = pageSources.length > 0 && pageSources.every(s => selectedSourceIds.includes(s.id));
                        const somePageSelected = pageSources.some(s => selectedSourceIds.includes(s.id));
                        el.checked = allPageSelected;
                        el.indeterminate = somePageSelected && !allPageSelected;
                      }}
                      onChange={() => {
                        const pageSources = sources.slice(sourcePage * SOURCE_PAGE_SIZE, (sourcePage + 1) * SOURCE_PAGE_SIZE);
                        const allPageSelected = pageSources.length > 0 && pageSources.every(s => selectedSourceIds.includes(s.id));
                        if (allPageSelected) {
                          setSelectedSourceIds(prev => prev.filter(id => !pageSources.some(s => s.id === id)));
                        } else {
                          setSelectedSourceIds(prev => [...new Set([...prev, ...pageSources.map(s => s.id)])]);
                        }
                      }}
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium">名称</th>
                  <th className="p-4 text-left text-sm font-medium">URL</th>
                  <th className="p-4 text-left text-sm font-medium">模式</th>
                  <th className="p-4 text-left text-sm font-medium">Key</th>
                  <th className="p-4 text-left text-sm font-medium">虚拟源站</th>
                  <th className="p-4 text-left text-sm font-medium">状态</th>
                  <th className="p-4 text-left text-sm font-medium">并发</th>
                  <th className="p-4 text-left text-sm font-medium">权重</th>
                  <th className="p-4 text-left text-sm font-medium">额度</th>
                  <th className="p-4 text-left text-sm font-medium">统计</th>
                  <th className="p-4 text-left text-sm font-medium min-w-[180px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {sources.slice(sourcePage * SOURCE_PAGE_SIZE, (sourcePage + 1) * SOURCE_PAGE_SIZE).map((source) => {
                  const concInfo = getConcurrencyInfo(source.id);
                  return (
                    <tr key={source.id} className={`border-b ${selectedSourceIds.includes(source.id) ? 'bg-muted/30' : ''}`}>
                      <td className="p-4">
                        <input
                          type="checkbox"
                          checked={selectedSourceIds.includes(source.id)}
                          onChange={() => toggleSourceSelect(source.id)}
                        />
                      </td>
                      <td className="p-4"><div className="font-medium">{source.name}</div></td>
                      <td className="p-4"><code className="text-xs bg-muted px-2 py-1 rounded">{(typeof source.api_urls?.[source.protocol] === 'string' && source.api_urls[source.protocol]) || Object.values(source.api_urls || {}).find(u => typeof u === 'string' && u) || source.base_url}</code></td>
                      <td className="p-4"><Badge variant="secondary">{{relay:'透传',openai:'OpenAI',anthropic:'Anthropic',gemini:'Gemini',bedrock:'Bedrock'}[source.protocol] || source.protocol}</Badge></td>
                      <td className="p-4">
                        {typeof source.source_group === 'string' && source.source_group ? (
                          <div className="space-y-1">
                            <Badge variant="outline">{source.source_group}</Badge>
                            <span className="text-[10px] text-muted-foreground">({source.stack_mode === 'merged' ? '负载均衡' : source.stack_mode === 'failover' ? '主备' : '独立'})</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">独立源站</span>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <code className="text-xs">{showKey[source.id] ? source.api_key : maskKey(source.api_key)}</code>
                          <button onClick={() => setShowKey({ ...showKey, [source.id]: !showKey[source.id] })} className="p-1 hover:bg-accent rounded">
                            {showKey[source.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          </button>
                          {source.api_urls && Object.keys(source.api_urls).filter(k => source.api_urls[k]).length > 0 && (
                            <span className="text-[10px] text-muted-foreground" title={Object.entries(source.api_urls).filter(([p, u]) => u).map(([p]) => p).join(', ')}>
                              +{String(Object.keys(source.api_urls).filter(k => source.api_urls[k]).length)}协议URL
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-4">{getSourceStatus(source)}</td>
                      <td className="p-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Activity className="w-3 h-3" />
                            <span className="text-xs">{String(concInfo.current_concurrent)}/{String(source.max_concurrent)}</span>
                          </div>
                          <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                            <div className="h-full bg-primary" style={{ width: `${concInfo.utilization}%` }} />
                          </div>
                        </div>
                      </td>
                      <td className="p-4">{source.weight}</td>
                      <td className="p-4">
                        <div className="space-y-1 min-w-[140px]">
                          {(() => {
                            const qUsed = Number(source.quota_used) || 0;
                            const qLimit = Number(source.quota_limit) || 0;
                            return qLimit > 0 ? (
                              <>
                                <div className="text-xs">
                                  <span className={qLimit > 0 && qUsed >= qLimit ? 'text-destructive font-medium' : ''}>
                                    {qUsed.toLocaleString()}
                                  </span>
                                  <span className="text-muted-foreground"> / {qLimit.toLocaleString()}</span>
                                </div>
                                <div className="w-20 h-1.5 bg-secondary rounded-full overflow-hidden">
                                  <div
                                    className={`h-full ${qLimit > 0 && qUsed >= qLimit ? 'bg-destructive' : 'bg-primary'}`}
                                    style={{ width: `${Math.min(100, (qUsed / qLimit) * 100)}%` }}
                                  />
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">无限制</span>
                            );
                          })()}
                          {source.quota_limit === 0 && (
                            <span className="text-xs text-muted-foreground">无限制</span>
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="text-xs text-muted-foreground">
                          <div>{source.total_requests?.toLocaleString() || 0} 请求</div>
                          <div>{source.total_tokens?.toLocaleString() || 0} tokens</div>
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" className="shrink-0" onClick={() => {
                            console.log('[Sources] 点击编辑, source.id:', source.id, 'source.api_urls type:', typeof source.api_urls);
                            // 防御：api_urls 可能是 JSON 字符串，先解析
                            let urls = source.api_urls || {};
                            if (typeof urls === 'string') {
                              try { urls = JSON.parse(urls); } catch { urls = {}; }
                            }
                            urls = { ...urls };
                            const proto = source.protocol || 'openai';
                            if (!urls[proto] && source.base_url) {
                              urls[proto] = source.base_url;
                            }
                            setEditDialog(source.id);
                            setEditForm({ name: source.name, base_url: source.base_url, api_key: source.api_key, protocol: source.protocol, max_concurrent: source.max_concurrent, quota_limit: source.quota_limit, weight: source.weight, strip_tools: source.strip_tools, api_keys: source.api_keys || {}, api_urls: urls });
                          }} title="编辑">
                            <Edit2 className="w-3 h-3" />
                          </Button>
                          <Button size="sm" variant="outline" className="shrink-0" onClick={() => handleTest(source.id)} disabled={testing === source.id} title="测试Key">
                            <RefreshCw className={`w-3 h-3 ${testing === source.id ? 'animate-spin' : ''}`} />
                          </Button>
                          <Button size="sm" variant="outline" className="shrink-0" onClick={() => handleFetchModels(source.id)} title="获取模型">
                            <Download className="w-3 h-3" />
                          </Button>
                          <Button size="sm" variant={source.is_active ? 'outline' : 'secondary'} className="shrink-0" onClick={() => toggleSource(source.id, source.is_active)} title={source.is_active ? '禁用' : '启用'}>
                            {source.is_active ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                          </Button>
                          <Button size="sm" variant="destructive" className="shrink-0" onClick={() => handleDelete(source.id)} title="删除">
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {sources.length > SOURCE_PAGE_SIZE && (
              <div className="p-3 border-t flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  共 {String(sources.length)} 个源站，第 {String(sourcePage + 1)} / {String(Math.ceil(sources.length / SOURCE_PAGE_SIZE))} 页
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={sourcePage === 0} onClick={() => setSourcePage(p => p - 1)}>上一页</Button>
                  <Button variant="outline" size="sm" disabled={(sourcePage + 1) * SOURCE_PAGE_SIZE >= sources.length} onClick={() => setSourcePage(p => p + 1)}>下一页</Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 均衡实例管理 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              <CardTitle>均衡实例管理</CardTitle>
              {instances.length > 0 && (
                <Badge variant="secondary">{instances.length} 个实例</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              选择入站模型并添加均衡源站，组合为对外暴露的实例
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowAddInstance(true)}>
            <Plus className="w-4 h-4 mr-2" />
            新建实例
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {instances.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Inbox className="w-10 h-10 mb-3 text-muted-foreground/50" />
              <p className="text-sm">暂无实例</p>
              <p className="text-xs mt-1">选择入站模型并添加均衡源站，创建对外暴露的实例</p>
            </div>
          ) : (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-3 text-left font-medium">名称</th>
                      <th className="px-4 py-3 text-left font-medium">入站模型</th>
                      <th className="px-4 py-3 text-left font-medium">成员</th>
                      <th className="px-4 py-3 text-left font-medium">叠加模式</th>
                      <th className="px-4 py-3 text-left font-medium">出站模型</th>
                      <th className="px-4 py-3 text-left font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.slice(instancePage * INSTANCE_PAGE_SIZE, (instancePage + 1) * INSTANCE_PAGE_SIZE).map((inst) => (
                      <Fragment key={inst.id}>
                        <tr className="border-b hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3 font-medium">{inst.name}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-0.5">
                              <code className="text-xs">{inst.inbound_model_id}</code>
                              <span className="text-[10px] text-muted-foreground">
                                {sources.find(s => s.id === inst.inbound_source_id)?.name || `源站#${inst.inbound_source_id}`}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <Users className="w-3.5 h-3.5 text-muted-foreground" />
                              <span>{(inst.members || []).length}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <select
                              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                              value={inst.stack_mode || 'merged'}
                              onChange={(e) => handleUpdateInstanceStackMode(inst.id, e.target.value)}
                            >
                              <option value="merged">负载均衡</option>
                              <option value="failover">主备切换</option>
                            </select>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-xs font-mono">{inst.outbound_model_id}</Badge>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() => {
                                  const next = new Set(expandedInstances);
                                  if (next.has(inst.id)) next.delete(inst.id); else next.add(inst.id);
                                  setExpandedInstances(next);
                                }}
                                title={expandedInstances.has(inst.id) ? '收起' : '展开'}
                              >
                                {expandedInstances.has(inst.id) ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 w-8 p-0 text-blue-500 hover:text-blue-600"
                                onClick={() => handleOpenEditInstance(inst)}
                                title="编辑"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                                onClick={() => handleDeleteInstance(inst.id)}
                                title="删除"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {expandedInstances.has(inst.id) && (
                          <tr>
                            <td colSpan={6} className="px-4 py-3 bg-muted/30">
                              <div className="space-y-3">
                                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                  <Users className="w-3.5 h-3.5" />
                                  成员源站
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                  {(inst.members || []).map(m => (
                                    <div key={m.id} className="rounded-lg border bg-card p-3 space-y-2">
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                          <span className="font-medium text-sm">{m.source_name}</span>
                                          {m.source_id === inst.inbound_source_id && (
                                            <Badge variant="secondary" className="text-[10px]">主</Badge>
                                          )}
                                        </div>
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        源站ID: {m.source_id}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              {instances.length > INSTANCE_PAGE_SIZE && (
                <div className="flex items-center justify-between px-4 py-3 border-t">
                  <span className="text-sm text-muted-foreground">
                    共 {String(instances.length)} 个，第 {String(instancePage + 1)} / {String(Math.ceil(instances.length / INSTANCE_PAGE_SIZE))} 页
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={instancePage === 0} onClick={() => setInstancePage(p => p - 1)}>
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      上一页
                    </Button>
                    <Button variant="outline" size="sm" disabled={(instancePage + 1) * INSTANCE_PAGE_SIZE >= instances.length} onClick={() => setInstancePage(p => p + 1)}>
                      下一页
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 新建实例弹窗 */}
      {showAddInstance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[520px] max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>新建实例</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateInstance} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">实例名称</label>
                  <Input
                    value={newInstance.name}
                    onChange={(e) => setNewInstance({ ...newInstance, name: e.target.value })}
                    placeholder="mimo-cluster"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">入站模型</label>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={`${newInstance.inbound_model_id}::${newInstance.inbound_source_id}`}
                    onChange={(e) => {
                      const [modelId, sourceId] = e.target.value.split('::');
                      setNewInstance({
                        ...newInstance,
                        inbound_model_id: modelId,
                        inbound_source_id: parseInt(sourceId),
                        member_source_ids: [],
                        outbound_configs: {}
                      });
                    }}
                  >
                    <option value="::">选择模型...</option>
                    {models.filter(m => !m.instance_id && !/_\d+$/.test(m.model_id)).map(m => (
                      <option key={`${m.id}`} value={`${m.model_id}::${m.source_id}`}>
                        {m.model_id} ({m.source_name})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">均衡源站</label>
                  <div className="border rounded-md p-3 space-y-2 max-h-48 overflow-y-auto">
                    {newInstance.inbound_source_id ? (
                      newInstanceEligibleSources.length > 0 ? newInstanceEligibleSources.map(s => (
                        <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newInstance.member_source_ids.includes(s.id)}
                            onChange={(e) => {
                              setNewInstance(prev => {
                                const ids = new Set(prev.member_source_ids);
                                const configs = { ...prev.outbound_configs };
                                const inboundModel = findInboundModel(prev.inbound_model_id, prev.inbound_source_id);
                                if (e.target.checked) {
                                  ids.add(s.id);
                                  if (inboundModel) {
                                    configs[s.id] = makeDefaultOutboundConfig(s.id, inboundModel, prev.outbound_model_id, false);
                                  }
                                } else {
                                  ids.delete(s.id);
                                  delete configs[s.id];
                                }
                                return { ...prev, member_source_ids: Array.from(ids), outbound_configs: configs };
                              });
                            }}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm">{s.name}</span>
                          <Badge variant="secondary" className="text-[10px]">{{relay:'透传',openai:'OpenAI',anthropic:'Anthropic',gemini:'Gemini',bedrock:'Bedrock'}[s.protocol] || s.protocol}</Badge>
                        </label>
                      )) : (
                        <p className="text-sm text-muted-foreground">没有其他源站注册了该模型</p>
                      )
                    ) : (
                      <p className="text-sm text-muted-foreground">请先选择入站模型</p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">出站模型 ID</label>
                  <Input
                    value={newInstance.outbound_model_id}
                    onChange={(e) => setNewInstance({ ...newInstance, outbound_model_id: e.target.value })}
                    placeholder="留空则使用入站模型ID（自动防冲突）"
                  />
                  <p className="text-xs text-muted-foreground">对外暴露的模型ID，所有用户请求时使用此ID</p>
                </div>
                <OutboundConfigSection
                  configs={newInstance.outbound_configs}
                  onChange={(configs) => setNewInstance({ ...newInstance, outbound_configs: configs })}
                  memberSourceIds={newInstance.member_source_ids}
                  inboundSourceId={newInstance.inbound_source_id}
                  inboundModel={findInboundModel(newInstance.inbound_model_id, newInstance.inbound_source_id)}
                  outboundModelId={newInstance.outbound_model_id}
                />
                <div className="space-y-2">
                  <label className="text-sm font-medium">叠加模式</label>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={newInstance.stack_mode}
                    onChange={(e) => setNewInstance({ ...newInstance, stack_mode: e.target.value })}
                  >
                    <option value="merged">负载均衡</option>
                    <option value="failover">主备切换</option>
                  </select>
                </div>
                <div className="flex gap-2 justify-end pt-2">
                  <Button variant="outline" onClick={() => setShowAddInstance(false)} type="button">取消</Button>
                  <Button type="submit">创建</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 编辑实例弹窗 */}
      {editInstanceDialog && (() => {
        const editingInst = instances.find(i => i.id === editInstanceDialog);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card className="w-[520px] max-h-[90vh] overflow-y-auto">
              <CardHeader>
                <CardTitle>编辑实例</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleUpdateInstance} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">实例名称</label>
                    <Input
                      value={editInstanceForm.name}
                      onChange={(e) => setEditInstanceForm({ ...editInstanceForm, name: e.target.value })}
                      placeholder="mimo-cluster"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">入站模型</label>
                    <div className="h-10 w-full rounded-md border border-input bg-muted px-3 text-sm flex items-center text-muted-foreground">
                      {editingInst?.inbound_model_id} ({sources.find(s => s.id === editingInst?.inbound_source_id)?.name || `源站#${editingInst?.inbound_source_id}`})
                    </div>
                    <p className="text-xs text-muted-foreground">入站模型不可修改</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">均衡源站</label>
                    <div className="border rounded-md p-3 space-y-2 max-h-48 overflow-y-auto">
                      {editInstanceEligibleSources.length > 0 ? editInstanceEligibleSources.map(s => (
                        <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editInstanceForm.member_source_ids.includes(s.id)}
                            onChange={(e) => {
                              setEditInstanceForm(prev => {
                                const ids = new Set(prev.member_source_ids);
                                const configs = { ...prev.outbound_configs };
                                const editingInst = instances.find(i => i.id === editInstanceDialog);
                                const inboundModel = editingInst ? findInboundModel(editingInst.inbound_model_id, editingInst.inbound_source_id) : null;
                                if (e.target.checked) {
                                  ids.add(s.id);
                                  if (!configs[s.id] && inboundModel) {
                                    configs[s.id] = makeDefaultOutboundConfig(s.id, inboundModel, prev.outbound_model_id || editingInst?.outbound_model_id, false);
                                  }
                                } else {
                                  ids.delete(s.id);
                                  delete configs[s.id];
                                }
                                return { ...prev, member_source_ids: Array.from(ids), outbound_configs: configs };
                              });
                            }}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm">{s.name}</span>
                          <Badge variant="secondary" className="text-[10px]">{{relay:'透传',openai:'OpenAI',anthropic:'Anthropic',gemini:'Gemini',bedrock:'Bedrock'}[s.protocol] || s.protocol}</Badge>
                        </label>
                      )) : (
                        <p className="text-sm text-muted-foreground">没有其他源站注册了该模型</p>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">出站模型 ID</label>
                    <Input
                      value={editInstanceForm.outbound_model_id}
                      onChange={(e) => setEditInstanceForm({ ...editInstanceForm, outbound_model_id: e.target.value })}
                      placeholder="对外暴露的模型ID"
                    />
                  </div>
                  {(() => {
                    const editingInst = instances.find(i => i.id === editInstanceDialog);
                    return editingInst ? (
                      <OutboundConfigSection
                        configs={editInstanceForm.outbound_configs}
                        onChange={(configs) => setEditInstanceForm({ ...editInstanceForm, outbound_configs: configs })}
                        memberSourceIds={editInstanceForm.member_source_ids}
                        inboundSourceId={editingInst.inbound_source_id}
                        inboundModel={findInboundModel(editingInst.inbound_model_id, editingInst.inbound_source_id)}
                        outboundModelId={editInstanceForm.outbound_model_id || editingInst.outbound_model_id}
                      />
                    ) : null;
                  })()}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">叠加模式</label>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={editInstanceForm.stack_mode}
                      onChange={(e) => setEditInstanceForm({ ...editInstanceForm, stack_mode: e.target.value })}
                    >
                      <option value="merged">负载均衡</option>
                      <option value="failover">主备切换</option>
                    </select>
                  </div>
                  <div className="flex gap-2 justify-end pt-2">
                    <Button variant="outline" onClick={() => setEditInstanceDialog(null)} type="button">取消</Button>
                    <Button type="submit">保存</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        );
      })()}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle>模型管理</CardTitle>
            <Input
              placeholder="搜索模型..."
              value={modelSearch}
              onChange={(e) => { setModelSearch(e.target.value); setMgmtPage(0); }}
              className="h-8 w-48 text-sm"
            />
            <select
              className="h-8 rounded border bg-background px-2 text-sm"
              value={modelGroupFilter}
              onChange={(e) => { setModelGroupFilter(e.target.value); setMgmtPage(0); }}
            >
              <option value="all">全部分组</option>
              {groups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}
            </select>
          </div>
          <Button size="sm" onClick={() => setShowAddModel(!showAddModel)}>
            <Plus className="w-3 h-3 mr-1" />
            添加模型
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {showAddModel && (
            <div className="p-4 border-b bg-muted/30 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  className="h-8 rounded border bg-background px-2 text-sm"
                  value={newModel.source_id}
                  onChange={(e) => setNewModel({ ...newModel, source_id: e.target.value })}
                >
                  <option value="">选择源站</option>
                  {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <Input
                  value={newModel.model_id}
                  onChange={(e) => setNewModel({ ...newModel, model_id: e.target.value })}
                  placeholder="模型ID (如 gpt-4o)"
                  className="w-48 h-8 text-sm"
                />
                <Button size="sm" className="h-8" onClick={handleAddModel}>添加</Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => { setShowAddModel(false); setNewModel({ source_id: '', model_id: '', model_group: ['default'] }); }}>取消</Button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">分组:</span>
                {groups.map(g => {
                  const selected = newModel.model_group.includes(g.name);
                  return (
                    <label key={g.id} className={`flex items-center gap-0.5 text-xs px-2 py-0.5 rounded border cursor-pointer ${selected ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-accent'}`}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={selected}
                        onChange={() => {
                          const cur = newModel.model_group;
                          const next = selected ? cur.filter(n => n !== g.name) : [...cur, g.name];
                          setNewModel({ ...newModel, model_group: next.length > 0 ? next : ['default'] });
                        }}
                      />
                      {g.name}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          {/* Batch action bar */}
          {selectedModelIds.length > 0 && (
            <div className="p-3 border-b bg-muted/30 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">已选 {String(selectedModelIds.length)} 个</span>
              <Button size="sm" variant="outline" onClick={() => batchUpdateModels({ is_active: 1 })}>批量启用</Button>
              <Button size="sm" variant="outline" onClick={() => batchUpdateModels({ is_active: 0 })}>批量禁用</Button>
              <Button size="sm" variant="destructive" onClick={batchDeleteModels}>
                <Trash2 className="w-3 h-3 mr-1" /> 批量删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedModelIds([])}>取消选择</Button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <th className="p-4 text-left w-10">
                    <input
                      type="checkbox"
                      ref={el => {
                        if (!el) return;
                        const filtered = models.filter(m => {
                          if (modelGroupFilter !== 'all' && !parseGroups(m.model_group).includes(modelGroupFilter)) return false;
                          if (modelSearch) {
                            const q = modelSearch.toLowerCase();
                            return (m.model_id || '').toLowerCase().includes(q) || (m.source_model_id || '').toLowerCase().includes(q) || (m.model_alias || '').toLowerCase().includes(q) || (m.source_name || '').toLowerCase().includes(q);
                          }
                          return true;
                        });
                        const pageModels = filtered.slice(mgmtPage * MGMT_PAGE_SIZE, (mgmtPage + 1) * MGMT_PAGE_SIZE);
                        const allPageSelected = pageModels.length > 0 && pageModels.every(m => selectedModelIds.includes(m.id));
                        const somePageSelected = pageModels.some(m => selectedModelIds.includes(m.id));
                        el.indeterminate = somePageSelected && !allPageSelected;
                      }}
                      checked={(() => {
                        const filtered = models.filter(m => {
                          if (modelGroupFilter !== 'all' && !parseGroups(m.model_group).includes(modelGroupFilter)) return false;
                          if (modelSearch) {
                            const q = modelSearch.toLowerCase();
                            return (m.model_id || '').toLowerCase().includes(q) || (m.source_model_id || '').toLowerCase().includes(q) || (m.model_alias || '').toLowerCase().includes(q) || (m.source_name || '').toLowerCase().includes(q);
                          }
                          return true;
                        });
                        const pageModels = filtered.slice(mgmtPage * MGMT_PAGE_SIZE, (mgmtPage + 1) * MGMT_PAGE_SIZE);
                        return pageModels.length > 0 && pageModels.every(m => selectedModelIds.includes(m.id));
                      })()}
                      onChange={() => {
                        const filtered = models.filter(m => {
                          if (modelGroupFilter !== 'all' && !parseGroups(m.model_group).includes(modelGroupFilter)) return false;
                          if (modelSearch) {
                            const q = modelSearch.toLowerCase();
                            return (m.model_id || '').toLowerCase().includes(q) || (m.source_model_id || '').toLowerCase().includes(q) || (m.model_alias || '').toLowerCase().includes(q) || (m.source_name || '').toLowerCase().includes(q);
                          }
                          return true;
                        });
                        const pageModels = filtered.slice(mgmtPage * MGMT_PAGE_SIZE, (mgmtPage + 1) * MGMT_PAGE_SIZE);
                        const allPageSelected = pageModels.length > 0 && pageModels.every(m => selectedModelIds.includes(m.id));
                        const allAllSelected = filtered.length > 0 && filtered.every(m => selectedModelIds.includes(m.id));

                        if (allAllSelected) {
                          setSelectedModelIds([]);
                        } else if (allPageSelected) {
                          setSelectedModelIds(filtered.map(m => m.id));
                        } else {
                          setSelectedModelIds(prev => [...new Set([...prev, ...pageModels.map(m => m.id)])]);
                        }
                      }}
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium">源站模型ID</th>
                  <th className="p-4 text-left text-sm font-medium">中转站模型ID</th>
                  <th className="p-4 text-left text-sm font-medium">别名</th>
                  <th className="p-4 text-left text-sm font-medium">源站</th>
                  <th className="p-4 text-left text-sm font-medium">均衡状态</th>
                  <th className="p-4 text-left text-sm font-medium">母组/均衡组</th>
                  <th className="p-4 text-left text-sm font-medium">输入价格(未/缓)</th>
                  <th className="p-4 text-left text-sm font-medium">输出价格</th>
                  <th className="p-4 text-left text-sm font-medium">模型能力</th>
                  <th className="p-4 text-left text-sm font-medium">倍率</th>
                  <th className="p-4 text-left text-sm font-medium">并发(每个用户)</th>
                  <th className="p-4 text-left text-sm font-medium">状态</th>
                  <th className="p-4 text-left text-sm font-medium min-w-[180px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {models.filter(m => {
                  if (modelGroupFilter !== 'all' && !parseGroups(m.model_group).includes(modelGroupFilter)) return false;
                  if (modelSearch) {
                    const q = modelSearch.toLowerCase();
                    return (m.model_id || '').toLowerCase().includes(q) || (m.source_model_id || '').toLowerCase().includes(q) || (m.model_alias || '').toLowerCase().includes(q) || (m.source_name || '').toLowerCase().includes(q);
                  }
                  return true;
                }).slice(mgmtPage * MGMT_PAGE_SIZE, (mgmtPage + 1) * MGMT_PAGE_SIZE).map((model) => (
                  <tr key={model.id} className={`border-b ${selectedModelIds.includes(model.id) ? 'bg-muted/30' : ''}`}>
                    <td className="p-4">
                      <input
                        type="checkbox"
                        checked={selectedModelIds.includes(model.id)}
                        onChange={() => toggleModelSelect(model.id)}
                      />
                    </td>
                    <td className="p-4 font-mono text-sm">{model.source_model_id || displayModelId(model.model_id)}</td>
                    <td className="p-4">
                      {editingModel === model.id ? (
                        <Input value={model.model_id} onChange={(e) => {
                          const updated = models.map(m => m.id === model.id ? { ...m, model_id: e.target.value } : m);
                          setModels(updated);
                        }} className="w-32 h-6 text-xs font-mono" />
                      ) : (
                        <div className="flex items-center gap-1">
                          <code className="text-xs">{model.model_id}</code>
                          {model.instance_id ? (
                            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">实例</Badge>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="p-4">
                      {editingModel === model.id ? (
                        <Input
                          value={model.model_alias || ''}
                          onChange={(e) => {
                            const updated = models.map(m => m.id === model.id ? { ...m, model_alias: e.target.value } : m);
                            setModels(updated);
                          }}
                          className="w-24 h-7 text-xs"
                          placeholder="别名"
                        />
                      ) : (
                        <span className="text-sm text-muted-foreground">{String(model.model_alias || '-')}</span>
                      )}
                    </td>
                    <td className="p-4 text-sm">{model.source_name}</td>
                    <td className="p-4">{getModelBalanceStatus(model)}</td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-1 items-center cursor-pointer" onClick={() => setGroupEditModel(model)}>
                        {parseGroups(model.model_group).map(g => (
                          <span key={String(g)} className="inline-block text-xs border rounded px-1.5 py-0.5">{String(g)}</span>
                        ))}
                        <Edit2 className="w-3 h-3 text-muted-foreground shrink-0" />
                      </div>
                    </td>
                    <td className="p-4 text-sm">
                      {editingModel === model.id ? (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-0.5">
                            <span className="text-[10px] text-muted-foreground">未</span>
                            <Input type="number" value={model.input_price ?? 0.025} onChange={(e) => {
                              const updated = models.map(m => m.id === model.id ? { ...m, input_price: parseFloat(e.target.value) } : m);
                              setModels(updated);
                            }} className="w-16 h-5 text-xs px-1" step="0.001" />
                          </div>
                          <div className="flex items-center gap-0.5">
                            <span className="text-[10px] text-muted-foreground">缓</span>
                            <Input type="number" value={model.input_price_cache ?? 0.02} onChange={(e) => {
                              const updated = models.map(m => m.id === model.id ? { ...m, input_price_cache: parseFloat(e.target.value) } : m);
                              setModels(updated);
                            }} className="w-16 h-5 text-xs px-1" step="0.001" />
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs">
                          <span>未:{String(model.input_price ?? 0.025)}</span>
                          <span className="text-muted-foreground ml-1">缓:{String(model.input_price_cache ?? 0.02)}</span>
                        </div>
                      )}
                    </td>
                    <td className="p-4 text-sm">
                      {editingModel === model.id ? (
                        <Input type="number" value={model.output_price ?? 2} onChange={(e) => {
                          const updated = models.map(m => m.id === model.id ? { ...m, output_price: parseFloat(e.target.value) } : m);
                          setModels(updated);
                        }} className="w-20 h-6 text-xs" step="0.01" />
                      ) : (
                        <div className="text-xs">{model.output_price ?? 2}</div>
                      )}
                    </td>
                    <td className="p-4">
                      {editingModel === model.id ? (
                        <div className="flex flex-row flex-wrap gap-2">
                          <label className="flex items-center gap-0.5 text-xs whitespace-nowrap">
                            <input type="checkbox" checked={!!model.supports_tools} onChange={(e) => {
                              const updated = models.map(m => m.id === model.id ? { ...m, supports_tools: e.target.checked ? 1 : 0 } : m);
                              setModels(updated);
                            }} />
                            工具
                          </label>
                          <label className="flex items-center gap-0.5 text-xs whitespace-nowrap">
                            <input type="checkbox" checked={!!model.supports_json} onChange={(e) => {
                              const updated = models.map(m => m.id === model.id ? { ...m, supports_json: e.target.checked ? 1 : 0 } : m);
                              setModels(updated);
                            }} />
                            JSON
                          </label>
                          <label className="flex items-center gap-0.5 text-xs whitespace-nowrap">
                            <input type="checkbox" checked={!!model.supports_fim} onChange={(e) => {
                              const updated = models.map(m => m.id === model.id ? { ...m, supports_fim: e.target.checked ? 1 : 0 } : m);
                              setModels(updated);
                            }} />
                            FIM
                          </label>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={model.supports_tools ? 'success' : 'secondary'} className="text-[10px] px-1.5">
                            {model.supports_tools ? '工具' : '无工具'}
                          </Badge>
                          <Badge variant={model.supports_json ? 'success' : 'secondary'} className="text-[10px] px-1.5">
                            JSON
                          </Badge>
                          {model.supports_fim ? (
                            <Badge variant="success" className="text-[10px] px-1.5">FIM</Badge>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="p-4 text-sm">{model.rate_multiplier || 1}x</td>
                    <td className="p-4">
                      {editingModel === model.id ? (
                        <Input type="number" value={model.max_concurrent ?? 100} onChange={(e) => {
                          const updated = models.map(m => m.id === model.id ? { ...m, max_concurrent: parseInt(e.target.value) } : m);
                          setModels(updated);
                        }} className="w-16 h-6 text-xs" min="1" />
                      ) : (
                        <span className="text-sm">{String(model.max_concurrent ?? 100)}</span>
                      )}
                    </td>
                    <td className="p-4">{getModelRoutingStatus(model)}</td>
                    <td className="p-4">
                      <div className="flex items-center gap-1.5">
                        {editingModel === model.id ? (
                          <>
                            <Button size="sm" variant="outline" onClick={() => updateModel(model.id, {
                              model_id: model.model_id,
                              model_alias: model.model_alias,
                              input_price: model.input_price,
                              input_price_cache: model.input_price_cache,
                              output_price: model.output_price,
                              model_group: model.model_group,
                              supports_tools: model.supports_tools,
                              supports_json: model.supports_json,
                              supports_fim: model.supports_fim,
                              max_concurrent: model.max_concurrent
                            })}>保存</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingModel(null)}>取消</Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" className="shrink-0" disabled={!!model.instance_id} onClick={() => { console.log('[Sources] 点击模型编辑, model.id:', model.id); setEditingModel(model.id); }}>编辑</Button>
                            <Button size="sm" variant="outline" className="shrink-0" onClick={() => handleValidateModel(model)} title="验证模型">验证</Button>
                            <Button size="sm" variant="outline" className="shrink-0" onClick={() => handleTestModel(model)} disabled={testingModelId === model.id} title="测试Key">
                              <RefreshCw className={`w-3 h-3 ${testingModelId === model.id ? 'animate-spin' : ''}`} />
                            </Button>
                            <Button size="sm" variant={model.is_active ? 'secondary' : 'success'} className="shrink-0" onClick={() => updateModel(model.id, { is_active: model.is_active ? 0 : 1 })}>
                              {model.is_active ? '禁用' : '启用'}
                            </Button>
                            <Button size="sm" variant="destructive" className="shrink-0" disabled={!!model.instance_id} onClick={() => deleteModel(model.id)}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          {(() => {
            const filtered = models.filter(m => {
              if (modelGroupFilter !== 'all' && !parseGroups(m.model_group).includes(modelGroupFilter)) return false;
              if (modelSearch) {
                const q = modelSearch.toLowerCase();
                return (m.model_id || '').toLowerCase().includes(q) || (m.source_model_id || '').toLowerCase().includes(q) || (m.model_alias || '').toLowerCase().includes(q) || (m.source_name || '').toLowerCase().includes(q);
              }
              return true;
            });
            return filtered.length > MGMT_PAGE_SIZE && (
              <div className="p-3 border-t flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  共 {String(filtered.length)} 个模型，第 {String(mgmtPage + 1)} / {String(Math.ceil(filtered.length / MGMT_PAGE_SIZE))} 页
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={mgmtPage === 0} onClick={() => setMgmtPage(p => p - 1)}>上一页</Button>
                  <Button variant="outline" size="sm" disabled={(mgmtPage + 1) * MGMT_PAGE_SIZE >= filtered.length} onClick={() => setMgmtPage(p => p + 1)}>下一页</Button>
                </div>
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {fetchDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[640px] max-h-[80vh] flex flex-col">
            <CardHeader>
              <CardTitle>
                {detectedModels ? (
                  <span className="flex items-center gap-2">
                    选择要导入的模型
                    {detectedProtocol && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                        自动检测协议: {detectedProtocol}
                      </span>
                    )}
                  </span>
                ) : '正在检测模型...'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 flex-1 overflow-hidden flex flex-col">
              {detecting ? (
                <div className="flex items-center justify-center py-10">
                  <RefreshCw className="w-6 h-6 animate-spin mr-2" />
                  <span>正在从源站获取模型列表...</span>
                </div>
              ) : detectedModels ? (
                <>
                  {/* Price settings */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium">输入价格 (未命中/元/1M)</label>
                      <Input
                        type="number"
                        value={fetchParams.default_input_price}
                        onChange={(e) => setFetchParams({ ...fetchParams, default_input_price: parseFloat(e.target.value) })}
                        min="0"
                        step="0.001"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">输入价格 (缓存命中/元/1M)</label>
                      <Input
                        type="number"
                        value={fetchParams.default_input_price_cache}
                        onChange={(e) => setFetchParams({ ...fetchParams, default_input_price_cache: parseFloat(e.target.value) })}
                        min="0"
                        step="0.001"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">输出价格 (元/1M)</label>
                      <Input
                        type="number"
                        value={fetchParams.default_output_price}
                        onChange={(e) => setFetchParams({ ...fetchParams, default_output_price: parseFloat(e.target.value) })}
                        min="0"
                        step="0.01"
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">模型分组</label>
                    <div className="flex flex-wrap gap-2">
                      {groups.map(g => {
                        const selected = fetchParams.default_groups?.includes(g.name);
                        return (
                          <label key={g.id} className={`flex items-center gap-1 text-xs px-2 py-1 rounded border cursor-pointer ${selected ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-accent'}`}>
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={selected}
                              onChange={() => {
                                const current = fetchParams.default_groups || ['default'];
                                if (selected) {
                                  // Don't allow deselecting if it's the last one
                                  if (current.length <= 1) return;
                                  setFetchParams({ ...fetchParams, default_groups: current.filter(n => n !== g.name) });
                                } else {
                                  setFetchParams({ ...fetchParams, default_groups: [...current, g.name] });
                                }
                              }}
                            />
                            {g.name}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Model list */}
                  <div className="flex-1 overflow-auto border rounded-md">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted sticky top-0">
                        <tr>
                          <th className="p-2 text-left w-10">
                            <input
                              type="checkbox"
                              ref={el => {
                                if (!el || !detectedModels) return;
                                const allSelectable = detectedModels.filter(m => !m.already_exists);
                                const pageModels = detectedModels.slice(modelPage * MODEL_PAGE_SIZE, (modelPage + 1) * MODEL_PAGE_SIZE);
                                const pageSelectable = pageModels.filter(m => !m.already_exists);
                                const allAllSelected = allSelectable.length > 0 && allSelectable.every(m => selectedModels.includes(m.id));
                                const allPageSelected = pageSelectable.length > 0 && pageSelectable.every(m => selectedModels.includes(m.id));
                                el.indeterminate = !allAllSelected && allPageSelected;
                              }}
                              checked={(() => {
                                const pageModels = detectedModels.slice(modelPage * MODEL_PAGE_SIZE, (modelPage + 1) * MODEL_PAGE_SIZE);
                                const selectable = pageModels.filter(m => !m.already_exists);
                                return selectable.length > 0 && selectable.every(m => selectedModels.includes(m.id));
                              })()}
                              onChange={toggleAllModels}
                            />
                          </th>
                          <th className="p-2 text-left">模型ID</th>
                          <th className="p-2 text-left w-24">状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detectedModels.slice(modelPage * MODEL_PAGE_SIZE, (modelPage + 1) * MODEL_PAGE_SIZE).map((m, i) => (
                          <tr key={modelPage * MODEL_PAGE_SIZE + i} className={`border-b ${m.already_exists ? 'opacity-50' : 'hover:bg-muted/50'}`}>
                            <td className="p-2">
                              <input
                                type="checkbox"
                                disabled={m.already_exists}
                                checked={selectedModels.includes(m.id)}
                                onChange={() => toggleModelSelection(m.id)}
                              />
                            </td>
                            <td className="p-2 font-mono text-xs">{m.id}</td>
                            <td className="p-2">
                              {m.already_exists ? (
                                <Badge variant="secondary" className="text-xs">已存在</Badge>
                              ) : (
                                <Badge variant="success" className="text-xs">可导入</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                        {detectedModels.length === 0 && (
                          <tr key="empty">
                            <td colSpan={3} className="p-4 text-center text-muted-foreground">未发现任何模型</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {detectedModels.length > MODEL_PAGE_SIZE && (
                    <div className="flex items-center justify-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={modelPage === 0}
                        onClick={() => setModelPage(p => p - 1)}
                      >
                        上一页
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {String(modelPage + 1)} / {String(Math.ceil(detectedModels.length / MODEL_PAGE_SIZE))}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={(modelPage + 1) * MODEL_PAGE_SIZE >= detectedModels.length}
                        onClick={() => setModelPage(p => p + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      共 {String(detectedModels.length)} 个模型，已选 {String(selectedModels.length)} 个
                      <span className="ml-2 text-muted-foreground/60">(点击全选: 第一次选当前页，第二次选全部)</span>
                    </span>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => { setFetchDialog(null); setDetectedModels(null); setSelectedModels([]); }}>取消</Button>
                      <Button onClick={executeImportModels} disabled={selectedModels.length === 0 || importing}>
                        {importing ? (
                          <><RefreshCw className="w-3 h-3 animate-spin mr-1" /> 导入中...</>
                        ) : (
                          `导入选中 (${selectedModels.length})`
                        )}
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}

      {fetchResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[500px]">
            <CardHeader>
              <CardTitle>导入结果</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-4 text-sm">
                <div>总计发现: <strong>{fetchResult.total}</strong></div>
                <div>新导入: <strong className="text-green-600">{fetchResult.imported}</strong></div>
                <div>跳过/重命名: <strong className="text-yellow-600">{fetchResult.skipped.length}</strong></div>
              </div>
              {fetchResult.skipped.length > 0 && (
                <div className="max-h-60 overflow-auto border rounded-md">
                  <table className="w-full text-xs">
                    <thead className="border-b bg-muted sticky top-0">
                      <tr>
                        <th className="p-2 text-left">模型ID</th>
                        <th className="p-2 text-left">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fetchResult.skipped.map((s, i) => (
                        <tr key={i} className="border-b">
                          <td className="p-2 font-mono">{s.id}</td>
                          <td className="p-2">
                            {s.stored_as ? (
                              <span className="text-yellow-600">重命名 → {String(s.stored_as)}</span>
                            ) : (
                              <span className="text-muted-foreground">{String(s.reason)}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex justify-end">
                <Button onClick={() => setFetchResult(null)}>确定</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {validateProtocolDialog !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[420px]">
            <CardHeader>
              <CardTitle>选择验证协议</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                为 <span className="font-medium text-foreground">{validateProtocolDialog.source_name}</span> 的 <span className="font-mono">{validateProtocolDialog.model_id}</span> 选择验证协议。
              </p>
              <div className="space-y-2">
                <label className="text-sm font-medium">协议</label>
                <select
                  className="w-full h-10 rounded border bg-background px-3 text-sm"
                  value={validateProtocol}
                  onChange={(e) => setValidateProtocol(e.target.value)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="bedrock">Bedrock</option>
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setValidateProtocolDialog(null); setValidateProtocol('openai'); }}>取消</Button>
                <Button onClick={handleConfirmValidateProtocol}>开始验证</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {validateDialog !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[480px]">
            <CardHeader>
              <CardTitle>模型验证结果</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {validating ? (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="w-5 h-5 animate-spin mr-2" />
                  <span className="text-sm text-muted-foreground">正在检测模型是否存在...</span>
                </div>
              ) : validateResult ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">状态:</span>
                    {validateResult.status === 'ok' ? (
                      <Badge variant="success">有效</Badge>
                    ) : validateResult.status === 'not_found' ? (
                      <Badge variant="warning">不存在</Badge>
                    ) : validateResult.status === 'unsupported' ? (
                      <Badge variant="secondary">不支持</Badge>
                    ) : (
                      <Badge variant="destructive">错误</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">源站:</span>
                      <div className="font-medium">{String(validateResult.sourceName || '-')}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">协议:</span>
                      <div className="font-medium uppercase">{String(validateResult.protocol || '-')}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">模型ID:</span>
                      <div className="font-mono">{String(validateResult.modelId || '-')}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">延迟:</span>
                      <div className="font-medium">{typeof validateResult.latencyMs === 'number' ? `${validateResult.latencyMs}ms` : '-'}</div>
                    </div>
                  </div>
                  {validateResult.error && (
                    <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                      {String(validateResult.error)}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    检测时间: {validateResult.checkedAt ? new Date(validateResult.checkedAt).toLocaleString() : '-'}
                  </div>
                </div>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setValidateDialog(null); setValidateResult(null); }}>关闭</Button>
                {validateResult && (
                  <Button onClick={() => {
                    const model = models.find(m => m.id === validateDialog);
                    if (model) {
                      setValidateResult(null);
                      handleValidateModel(model);
                    }
                  }} disabled={validating}>重新验证</Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {(editDialog !== null && editDialog !== undefined) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[400px]">
            <CardHeader>
              <CardTitle>编辑源站设置</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">名称</label>
                <Input
                  value={editForm.name || ''}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Key</label>
                <Input
                  type="password"
                  value={editForm.api_key || ''}
                  onChange={(e) => setEditForm({ ...editForm, api_key: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">各协议独立 URL（留空则使用默认 URL）</label>
                <p className="text-sm font-medium text-muted-foreground">冗余使用，不建议一个源站出现其他地方的url，如果需要请使用叠加模式的主备模式。</p>
                <div className="grid grid-cols-2 gap-3">
                  {[['openai', 'OpenAI URL'], ['anthropic', 'Anthropic URL'], ['gemini', 'Gemini URL'], ['bedrock', 'Bedrock URL']].map(([proto, label]) => (
                    <div key={proto} className="space-y-1">
                      <label className="text-xs text-muted-foreground">{label}</label>
                      <Input
                        value={editForm.api_urls?.[proto] || ''}
                        onChange={(e) => setEditForm({ ...editForm, api_urls: { ...editForm.api_urls, [proto]: e.target.value } })}
                        placeholder="https://..."
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">最大并发</label>
                <Input
                  type="number"
                  value={editForm.max_concurrent}
                  onChange={(e) => setEditForm({ ...editForm, max_concurrent: parseInt(e.target.value) })}
                  min="1"
                  max="100"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">权重</label>
                <Input
                  type="number"
                  value={editForm.weight}
                  onChange={(e) => setEditForm({ ...editForm, weight: parseInt(e.target.value) })}
                  min="1"
                  max="100"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="strip-tools"
                  checked={!!editForm.strip_tools}
                  onChange={(e) => setEditForm({ ...editForm, strip_tools: e.target.checked ? 1 : 0 })}
                />
                <label htmlFor="strip-tools" className="text-sm font-medium">剥离Tools参数 (源站不支持工具调用时开启)</label>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">额度限制 (Token数, 0=无限制)</label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={editForm.quota_limit}
                    onChange={(e) => setEditForm({ ...editForm, quota_limit: parseInt(e.target.value) })}
                    min="0"
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await api.put(`/admin/sources/${editDialog}`, { quota_used: 0 });
                        setEditForm({ ...editForm, quota_used: 0 });
                        loadData();
                      } catch (err) {
                        alert('清洗失败: ' + (err.response?.data?.error || err.message));
                      }
                    }}
                  >
                    清洗额度
                  </Button>
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setEditDialog(null)}>取消</Button>
                <Button onClick={async () => {
                  try {
                    const payload = { ...editForm };
                    console.log('[Sources] 保存源站, id:', editDialog, 'payload:', JSON.stringify(payload, null, 2));
                    if (payload.protocol !== 'relay') {
                      payload.protocol = detectProtocol(payload.api_urls);
                    }
                    // 从 api_urls 中取第一个非空的作为 base_url
                    const firstUrl = Object.values(payload.api_urls || {}).find(u => u);
                    if (firstUrl) payload.base_url = firstUrl;
                    const res = await api.put(`/admin/sources/${editDialog}`, payload);
                    console.log('[Sources] 保存成功:', res.data);
                    setEditDialog(null);
                    loadData();
                  } catch (err) {
                    console.error('[Sources] 保存失败:', err);
                    const detail = err.response?.data?.error || err.message || JSON.stringify(err);
                    showAlert('保存失败: ' + detail);
                  }
                }}>保存</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {groupEditModel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[400px]">
            <CardHeader>
              <CardTitle>编辑模型分组 - {displayModelId(groupEditModel.model_id)}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {groups.map(g => {
                  const selected = parseGroups(groupEditModel.model_group).includes(g.name);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      className={`text-sm px-3 py-1.5 rounded border cursor-pointer ${selected ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-accent'}`}
                      onClick={() => {
                        const cur = parseGroups(groupEditModel.model_group);
                        const next = selected ? cur.filter(n => n !== g.name) : [...cur, g.name];
                        setGroupEditModel({ ...groupEditModel, model_group: next.length > 0 ? next : ['default'] });
                      }}
                    >
                      {selected && <span className="mr-1">✓</span>}
                      {g.name}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setGroupEditModel(null)}>取消</Button>
                <Button onClick={async () => {
                  await updateModel(groupEditModel.id, { model_group: groupEditModel.model_group });
                  setModels(prev => prev.map(m => m.id === groupEditModel.id ? { ...m, model_group: groupEditModel.model_group } : m));
                  setGroupEditModel(null);
                }}>保存</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
