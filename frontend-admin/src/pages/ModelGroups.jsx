import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { Plus, Trash2, Edit2, X, Check, Layers } from 'lucide-react';
import { showAlert, showConfirm } from '../components/Dialog';

function displayModelId(modelId) {
  return modelId.replace(/_\d+$/, '');
}

function parseGroups(str) {
  if (!str) return ['default'];
  if (Array.isArray(str)) return str.length > 0 ? str : ['default'];
  try {
    const arr = JSON.parse(str);
    return Array.isArray(arr) && arr.length > 0 ? arr : ['default'];
  } catch { return [str]; }
}

export default function ModelGroups() {
  const [groups, setGroups] = useState([]);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [manageGroup, setManageGroup] = useState(null);
  const [selectedModels, setSelectedModels] = useState([]);
  const [editingPrices, setEditingPrices] = useState({});
  const [savingPrice, setSavingPrice] = useState(null);

  const [newGroup, setNewGroup] = useState({
    name: '',
    description: '',
    rate_multiplier: 1
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [groupsRes, modelsRes] = await Promise.all([
        api.get('/admin/model-groups'),
        api.get('/admin/models')
      ]);
      setGroups(groupsRes.data || []);
      setModels(modelsRes.data || []);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    try {
      await api.post('/admin/model-groups', newGroup);
      setNewGroup({ name: '', description: '', rate_multiplier: 1 });
      setShowAdd(false);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '添加失败');
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      await api.put(`/admin/model-groups/${id}`, data);
      setEditingId(null);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '更新失败');
    }
  };

  const handleDelete = async (id) => {
    if (!await showConfirm('确定要删除这个模型分组吗？')) return;
    try {
      await api.delete(`/admin/model-groups/${id}`);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const toggleActive = async (id, isActive) => {
    try {
      await api.put(`/admin/model-groups/${id}`, { is_active: isActive ? 0 : 1 });
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const getGroupModels = (groupName) => models.filter(m => parseGroups(m.model_group).includes(groupName));

  const openManage = (groupName) => {
    setManageGroup(groupName);
    setSelectedModels(getGroupModels(groupName).map(m => m.id));
  };

  const handleAssignModels = async () => {
    if (!manageGroup) return;
    try {
      // Build updates: add/remove manageGroup from each model's groups
      const updates = models.map(m => {
        const groups = parseGroups(m.model_group);
        const shouldHave = selectedModels.includes(m.id);
        const has = groups.includes(manageGroup);
        let newGroups;
        if (shouldHave && !has) {
          newGroups = [...groups, manageGroup];
        } else if (!shouldHave && has) {
          newGroups = groups.filter(g => g !== manageGroup);
          if (newGroups.length === 0) newGroups = ['default'];
        } else {
          return null; // no change
        }
        return { id: m.id, model_group: newGroups };
      }).filter(Boolean);

      for (const upd of updates) {
        await api.put(`/admin/models/${upd.id}`, { model_group: upd.model_group });
      }
      setManageGroup(null);
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '操作失败');
    }
  };

  const toggleModelSelect = (modelId) => {
    setSelectedModels(prev =>
      prev.includes(modelId) ? prev.filter(id => id !== modelId) : [...prev, modelId]
    );
  };

  const handleSavePrice = async (modelId) => {
    const prices = editingPrices[modelId];
    if (!prices) return;
    setSavingPrice(modelId);
    try {
      await api.put(`/admin/models/${modelId}`, {
        input_price: parseFloat(prices.input_price) || 0,
        input_price_cache: parseFloat(prices.input_price_cache) || 0,
        output_price: parseFloat(prices.output_price) || 0,
        completion_price: parseFloat(prices.output_price) || 0
      });
      setEditingPrices(prev => { const n = { ...prev }; delete n[modelId]; return n; });
      loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '保存价格失败');
    } finally {
      setSavingPrice(null);
    }
  };

  const startEditPrice = (model) => {
    setEditingPrices(prev => ({
      ...prev,
      [model.id]: {
        input_price: model.input_price ?? 0.025,
        input_price_cache: model.input_price_cache ?? 0.02,
        output_price: model.output_price ?? 2
      }
    }));
  };

  if (loading) {
    return <div className="text-center py-10">加载中...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">模型分组</h1>
        <Button onClick={() => setShowAdd(!showAdd)}>
          <Plus className="w-4 h-4 mr-2" />
          添加分组
        </Button>
      </div>

      {showAdd && (
        <Card>
          <CardHeader>
            <CardTitle>添加新分组</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">分组名称</label>
                  <Input
                    value={newGroup.name}
                    onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                    placeholder="premium"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">描述</label>
                  <Input
                    value={newGroup.description}
                    onChange={(e) => setNewGroup({ ...newGroup, description: e.target.value })}
                    placeholder="高级模型分组"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">倍率</label>
                  <Input
                    type="number"
                    value={newGroup.rate_multiplier}
                    onChange={(e) => setNewGroup({ ...newGroup, rate_multiplier: parseFloat(e.target.value) })}
                    min="0.01"
                    step="0.01"
                  />
                </div>
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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <th className="p-4 text-left text-sm font-medium">名称</th>
                  <th className="p-4 text-left text-sm font-medium">描述</th>
                  <th className="p-4 text-left text-sm font-medium">倍率</th>
                  <th className="p-4 text-left text-sm font-medium">模型数</th>
                  <th className="p-4 text-left text-sm font-medium">状态</th>
                  <th className="p-4 text-left text-sm font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const groupModels = getGroupModels(group.name);
                  return (
                    <tr key={group.id} className="border-b">
                      <td className="p-4 font-medium">
                        {editingId === group.id ? (
                          <Input
                            defaultValue={group.name}
                            id={`edit-name-${group.id}`}
                            className="w-32 h-7 text-xs"
                          />
                        ) : (
                          <div className="flex items-center gap-2">
                            {group.name}
                            {group.is_system ? <Badge variant="secondary" className="text-xs">系统</Badge> : null}
                          </div>
                        )}
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">
                        {editingId === group.id ? (
                          <Input
                            defaultValue={group.description || ''}
                            id={`edit-desc-${group.id}`}
                            className="w-48 h-7 text-xs"
                          />
                        ) : (
                          group.description || '-'
                        )}
                      </td>
                      <td className="p-4">
                        {editingId === group.id ? (
                          <Input
                            type="number"
                            defaultValue={group.rate_multiplier}
                            id={`edit-rate-${group.id}`}
                            className="w-20 h-7 text-xs"
                            min="0.01"
                            step="0.01"
                          />
                        ) : (
                          <Badge variant="secondary">{group.rate_multiplier}x</Badge>
                        )}
                      </td>
                      <td className="p-4">
                        <Button size="sm" variant="outline" onClick={() => openManage(group.name)} title="管理模型">
                          <Layers className="w-3 h-3 mr-1" />
                          {groupModels.length}
                        </Button>
                      </td>
                      <td className="p-4">
                        <Badge variant={group.is_active ? 'success' : 'destructive'}>
                          {group.is_active ? '启用' : '禁用'}
                        </Badge>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {editingId === group.id ? (
                            <>
                              <Button size="sm" variant="outline" onClick={() => {
                                const name = document.getElementById(`edit-name-${group.id}`).value;
                                const desc = document.getElementById(`edit-desc-${group.id}`).value;
                                const rate = document.getElementById(`edit-rate-${group.id}`).value;
                                handleUpdate(group.id, { name, description: desc, rate_multiplier: parseFloat(rate) });
                              }}>
                                <Check className="w-3 h-3" />
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                <X className="w-3 h-3" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" onClick={() => setEditingId(group.id)}>
                                <Edit2 className="w-3 h-3" />
                              </Button>
                              <Button size="sm" variant={group.is_active ? 'secondary' : 'success'} onClick={() => toggleActive(group.id, group.is_active)}>
                                {group.is_active ? '禁用' : '启用'}
                              </Button>
                              {!group.is_system && (
                                <Button size="sm" variant="destructive" onClick={() => handleDelete(group.id)}>
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {groups.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-muted-foreground">
                      暂无模型分组
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {manageGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[950px] max-h-[80vh]">
            <CardHeader>
              <CardTitle>管理分组模型 - {manageGroup}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                勾选要添加到此分组的模型，取消勾选会从此分组移除（模型可属于多个分组）。
              </p>
              <div className="max-h-80 overflow-auto border rounded-md">
                {models.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground">暂无模型，请先在源站管理中导入模型</div>
                ) : (
                  <table className="w-full">
                    <thead className="border-b sticky top-0 bg-background">
                      <tr>
                        <th className="p-2 text-left w-10">
                          <input
                            type="checkbox"
                            checked={selectedModels.length === models.length}
                            onChange={(e) => setSelectedModels(e.target.checked ? models.map(m => m.id) : [])}
                          />
                        </th>
                        <th className="p-2 text-left text-xs font-medium">模型ID</th>
                        <th className="p-2 text-left text-xs font-medium">当前分组</th>
                        <th className="p-2 text-left text-xs font-medium">输入(未命中/命中)</th>
                        <th className="p-2 text-left text-xs font-medium">输出</th>
                        <th className="p-2 text-left text-xs font-medium">源站</th>
                        <th className="p-2 text-left text-xs font-medium w-16">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((model) => {
                        const isEditing = editingPrices[model.id];
                        return (
                        <tr key={model.id} className="border-b hover:bg-accent/50">
                          <td className="p-2" onClick={() => toggleModelSelect(model.id)} style={{cursor:'pointer'}}>
                            <input
                              type="checkbox"
                              checked={selectedModels.includes(model.id)}
                              onChange={() => toggleModelSelect(model.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className="p-2 text-sm font-mono" title={model.model_id}>{displayModelId(model.model_id)}</td>
                          <td className="p-2">
                            <div className="flex flex-wrap gap-1">
                              {parseGroups(model.model_group).map(g => (
                                <Badge key={g} variant={g === manageGroup ? 'default' : 'outline'} className="text-xs">{g}</Badge>
                              ))}
                            </div>
                          </td>
                          <td className="p-2">
                            {isEditing ? (
                              <div className="flex gap-1">
                                <Input type="number" className="w-16 h-6 text-xs" value={isEditing.input_price} min="0" step="0.001"
                                  onChange={(e) => setEditingPrices(prev => ({ ...prev, [model.id]: { ...prev[model.id], input_price: e.target.value } }))}
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <Input type="number" className="w-16 h-6 text-xs" value={isEditing.input_price_cache} min="0" step="0.001"
                                  onChange={(e) => setEditingPrices(prev => ({ ...prev, [model.id]: { ...prev[model.id], input_price_cache: e.target.value } }))}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            ) : (
                              <div className="text-xs">{model.input_price ?? 0.025}/{model.input_price_cache ?? 0.02}</div>
                            )}
                          </td>
                          <td className="p-2">
                            {isEditing ? (
                              <Input type="number" className="w-16 h-6 text-xs" value={isEditing.output_price} min="0" step="0.01"
                                onChange={(e) => setEditingPrices(prev => ({ ...prev, [model.id]: { ...prev[model.id], output_price: e.target.value } }))}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <div className="text-xs">{model.output_price ?? 2}</div>
                            )}
                          </td>
                          <td className="p-2 text-xs text-muted-foreground">{model.source_name}</td>
                          <td className="p-2">
                            {isEditing ? (
                              <div className="flex gap-1">
                                <Button size="sm" variant="outline" className="h-6 w-6 p-0" disabled={savingPrice === model.id} onClick={() => handleSavePrice(model.id)}>
                                  <Check className="w-3 h-3" />
                                </Button>
                                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setEditingPrices(prev => { const n = { ...prev }; delete n[model.id]; return n; })}>
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            ) : (
                              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => startEditPrice(model)}>
                                <Edit2 className="w-3 h-3" />
                              </Button>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setManageGroup(null)}>取消</Button>
                <Button onClick={handleAssignModels}>保存 ({selectedModels.length} 个模型)</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
