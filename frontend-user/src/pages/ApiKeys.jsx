import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { Plus, Trash2, Copy, Check, ChevronDown, ChevronUp, Edit2 } from 'lucide-react';
import { MultiSelect } from '../components/MultiSelect';

export default function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const [expandedKey, setExpandedKey] = useState(null);
  const [showKey, setShowKey] = useState(null);
  const [editDialog, setEditDialog] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editLimitType, setEditLimitType] = useState('all');
  const [availableModels, setAvailableModels] = useState([]);
  const [availableGroups, setAvailableGroups] = useState([]);
  const [modelLimit, setModelLimit] = useState([]);
  const [groupLimit, setGroupLimit] = useState([]);
  const [limitType, setLimitType] = useState('all');

  const [newKeyData, setNewKeyData] = useState({
    name: '',
    expires_at: '',
    quota_limit: 0,
    quota_type: 'tokens',
    currency: 'CNY'
  });

  useEffect(() => {
    loadKeys();
    loadModelsAndGroups();
  }, []);

  const loadKeys = async () => {
    setLoading(true);
    try {
      const res = await api.get('/user/keys');
      setKeys(res.data || []);
    } finally {
      setLoading(false);
    }
  };

  const loadModelsAndGroups = async () => {
    try {
      const [modelsRes, groupsRes] = await Promise.all([
        api.get('/user/models'),
        api.get('/user/model-groups')
      ]);
      setAvailableModels(modelsRes.data || []);
      setAvailableGroups(groupsRes.data || []);
    } catch (e) {
      console.error('Failed to load models/groups:', e);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: newKeyData.name || 'API Key',
        model_limit: modelLimit.length > 0 ? JSON.stringify(modelLimit) : 'all',
        group_limit: groupLimit.length > 0 ? JSON.stringify(groupLimit) : 'all',
        quota_limit: parseInt(newKeyData.quota_limit) || 0,
        quota_type: newKeyData.quota_type,
        currency: newKeyData.currency
      };
      if (newKeyData.expires_at) {
        payload.expires_at = newKeyData.expires_at;
      }
      const res = await api.post('/user/keys', payload);
      setNewKey(res.data);
      setNewKeyData({ name: '', expires_at: '', quota_limit: 0, quota_type: 'tokens', currency: 'CNY' });
      setModelLimit([]);
      setGroupLimit([]);
      setShowCreate(false);
      loadKeys();
    } catch (err) {
      alert(err.response?.data?.error || '创建失败');
    }
  };

  const handleEditSave = async () => {
    try {
      const payload = { ...editForm };
      if (payload.model_limit && Array.isArray(payload.model_limit)) {
        payload.model_limit = payload.model_limit.length > 0 ? JSON.stringify(payload.model_limit) : 'all';
      }
      if (payload.group_limit && Array.isArray(payload.group_limit)) {
        payload.group_limit = payload.group_limit.length > 0 ? JSON.stringify(payload.group_limit) : 'all';
      }
      await api.put(`/user/keys/${editDialog}`, payload);
      setEditDialog(null);
      loadKeys();
    } catch (err) {
      alert(err.response?.data?.error || '保存失败');
    }
  };

  const openEdit = (key) => {
    let ml = [], gl = [];
    try { ml = key.model_limit === 'all' ? [] : JSON.parse(key.model_limit); } catch { ml = [key.model_limit]; }
    try { gl = key.group_limit === 'all' ? [] : JSON.parse(key.group_limit); } catch { gl = [key.group_limit]; }
    setEditDialog(key.id);
    setEditLimitType(ml.length > 0 ? 'model' : gl.length > 0 ? 'group' : 'all');
    setEditForm({
      name: key.name || '',
      model_limit: ml,
      group_limit: gl,
      quota_limit: key.quota_limit || 0,
      quota_type: key.quota_type || 'tokens',
      expires_at: key.expires_at ? key.expires_at.substring(0, 16) : '',
      rate_limit: key.rate_limit || 60,
      max_concurrent: key.max_concurrent || 500
    });
  };

  const handleDelete = async (id) => {
    if (!confirm('确定要删除这个API密钥吗？此操作无法撤销。')) return;
    try {
      await api.delete(`/user/keys/${id}`);
      loadKeys();
    } catch (err) {
      alert(err.response?.data?.error || '删除失败');
    }
  };

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (loading) {
    return <div className="text-center py-10">加载中...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">API密钥</h1>

      {newKey && (
        <Card className="border-green-500">
          <CardHeader>
            <CardTitle className="text-green-500">新API密钥已创建</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              新API密钥已创建，您也可以在密钥列表中随时查看。
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 p-3 bg-muted rounded-md text-sm font-mono break-all">
                {newKey.key}
              </code>
              <Button
                variant="outline"
                onClick={() => copyToClipboard(newKey.key, 'new')}
              >
                {copiedId === 'new' ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setNewKey(null)}
            >
              关闭
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus className="w-4 h-4 mr-2" />
          创建密钥
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader>
            <CardTitle>创建新密钥</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">密钥名称</label>
                  <Input
                    value={newKeyData.name}
                    onChange={(e) => setNewKeyData({ ...newKeyData, name: e.target.value })}
                    placeholder="我的API密钥"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">过期时间 (可选)</label>
                  <Input
                    type="datetime-local"
                    value={newKeyData.expires_at}
                    onChange={(e) => setNewKeyData({ ...newKeyData, expires_at: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">额度限制</label>
                  <Input
                    type="number"
                    value={newKeyData.quota_limit}
                    onChange={(e) => setNewKeyData({ ...newKeyData, quota_limit: e.target.value })}
                    placeholder="0 = 无限制"
                    min="0"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">额度类型</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={newKeyData.quota_type}
                    onChange={(e) => setNewKeyData({ ...newKeyData, quota_type: e.target.value })}
                  >
                    <option value="currency">金额</option>
                    <option value="tokens">Token数量</option>
                  </select>
                </div>
                {newKeyData.quota_type === 'currency' && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">币种</label>
                    <select
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={newKeyData.currency}
                      onChange={(e) => setNewKeyData({ ...newKeyData, currency: e.target.value })}
                    >
                      <option value="CNY">CNY (¥)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">限制方式</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={limitType}
                  onChange={(e) => { setLimitType(e.target.value); setModelLimit([]); setGroupLimit([]); }}
                >
                  <option value="all">不限制 (全部可用)</option>
                  <option value="model">按模型限制</option>
                  <option value="group">按分组限制</option>
                </select>
              </div>
              {limitType === 'model' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">选择允许的模型</label>
                  <MultiSelect
                    options={availableModels.map(m => ({ value: m.model_id, label: m.model_id, description: m.model_group }))}
                    value={modelLimit}
                    onChange={setModelLimit}
                    placeholder="请选择模型"
                  />
                </div>
              )}
              {limitType === 'group' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">选择允许的分组</label>
                  <MultiSelect
                    options={availableGroups.map(g => ({ value: g.name, label: g.name, description: g.description }))}
                    value={groupLimit}
                    onChange={setGroupLimit}
                    placeholder="请选择分组"
                  />
                </div>
              )}
              <div className="flex gap-2">
                <Button type="submit">创建</Button>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>我的API密钥</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {keys.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              暂无API密钥，请创建一个。
            </div>
          ) : (
            <div className="divide-y">
              {keys.map((key) => {
                const isExpired = key.expires_at && new Date(key.expires_at) < new Date();
                const isQuotaExhausted = key.quota_limit > 0 && key.quota_used >= key.quota_limit;
                const statusLabel = !key.is_active ? '禁用' : isExpired ? '已过期' : isQuotaExhausted ? '已耗尽' : '正常';
                const statusVariant = !key.is_active ? 'destructive' : isExpired ? 'destructive' : isQuotaExhausted ? 'warning' : 'success';

                return (
                  <div key={key.id}>
                    <div className="flex items-center justify-between p-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{key.name || 'API密钥'}</span>
                          <Badge variant={statusVariant}>{statusLabel}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <code className="text-sm text-muted-foreground font-mono">
                            {showKey === key.id ? (key.key || key.key_prefix) : key.key_prefix}
                          </code>
                          {key.key && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setShowKey(showKey === key.id ? null : key.id)}
                              className="h-6 px-2 text-xs"
                            >
                              {showKey === key.id ? '隐藏' : '查看'}
                            </Button>
                          )}
                          {key.key && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => copyToClipboard(key.key, key.id)}
                              className="h-6 px-2 text-xs"
                            >
                              {copiedId === key.id ? '已复制' : '复制'}
                            </Button>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          创建于: {new Date(key.created_at).toLocaleDateString()}
                          {key.last_used_at && (
                            <> | 最后使用: {new Date(key.last_used_at).toLocaleDateString()}</>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setExpandedKey(expandedKey === key.id ? null : key.id)}
                        >
                          {expandedKey === key.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          详情
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openEdit(key)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(key.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {expandedKey === key.id && (
                      <div className="px-4 pb-4 bg-muted/30">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                          <div>
                            <span className="text-muted-foreground">模型限制:</span>
                            <div className="font-medium">
                              {key.model_limit === 'all' ? '全部模型' : (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {(() => { try { return JSON.parse(key.model_limit); } catch { return [key.model_limit]; } })().map(m => (
                                    <Badge key={m} variant="outline" className="text-xs">{m}</Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">分组限制:</span>
                            <div className="font-medium">
                              {key.group_limit === 'all' ? '全部分组' : (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {(() => { try { return JSON.parse(key.group_limit); } catch { return [key.group_limit]; } })().map(g => (
                                    <Badge key={g} variant="outline" className="text-xs">{g}</Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">额度:</span>
                            <div className="font-medium">
                              {key.quota_limit > 0 ? (
                                <>
                                  {key.quota_type === 'currency' ? (
                                    <>
                                      ¥{key.quota_used?.toFixed(2) || '0.00'} / ¥{key.quota_limit?.toLocaleString()}
                                      <span className="text-xs text-muted-foreground ml-1">(金额)</span>
                                    </>
                                  ) : (
                                    <>
                                      {Math.round(key.quota_used || 0).toLocaleString()} / {key.quota_limit?.toLocaleString()}
                                      <span className="text-xs text-muted-foreground ml-1">(tokens)</span>
                                    </>
                                  )}
                                </>
                              ) : '无限制'}
                            </div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">过期时间:</span>
                            <div className="font-medium">
                              {key.expires_at ? new Date(key.expires_at).toLocaleString() : '永不过期'}
                            </div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">并发:</span>
                            <div className="font-medium">{key.current_concurrent || 0}/{key.max_concurrent || 500}</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">限流:</span>
                            <div className="font-medium">{key.rate_limit || 60} 次/分钟</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">总请求:</span>
                            <div className="font-medium">{key.total_requests?.toLocaleString() || 0}</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">总Token:</span>
                            <div className="font-medium">{key.total_tokens?.toLocaleString() || 0}</div>
                          </div>
                        </div>
                        {key.quota_limit > 0 && (
                          <div className="mt-3">
                            <div className="flex justify-between text-xs text-muted-foreground mb-1">
                              <span>额度使用</span>
                              <span>{Math.round((key.quota_used / key.quota_limit) * 100)}%</span>
                            </div>
                            <div className="h-2 bg-secondary rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary transition-all"
                                style={{ width: `${Math.min(100, (key.quota_used / key.quota_limit) * 100)}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {editDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-[500px]">
            <CardHeader>
              <CardTitle>编辑密钥</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">密钥名称</label>
                <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">限制方式</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editLimitType}
                  onChange={(e) => { setEditLimitType(e.target.value); setEditForm({ ...editForm, model_limit: [], group_limit: [] }); }}
                >
                  <option value="all">不限制</option>
                  <option value="model">按模型限制</option>
                  <option value="group">按分组限制</option>
                </select>
              </div>
              {editLimitType === 'model' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">选择允许的模型</label>
                  <MultiSelect
                    options={availableModels.map(m => ({ value: m.model_id, label: m.model_id }))}
                    value={Array.isArray(editForm.model_limit) ? editForm.model_limit : []}
                    onChange={(val) => setEditForm({ ...editForm, model_limit: val })}
                    placeholder="请选择模型"
                  />
                </div>
              )}
              {editLimitType === 'group' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">选择允许的分组</label>
                  <MultiSelect
                    options={availableGroups.map(g => ({ value: g.name, label: g.name }))}
                    value={Array.isArray(editForm.group_limit) ? editForm.group_limit : []}
                    onChange={(val) => setEditForm({ ...editForm, group_limit: val })}
                    placeholder="请选择分组"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">额度限制 (0=无限制)</label>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs px-2"
                      onClick={async () => {
                        if (!confirm('确定要清洗该密钥的已用额度吗？此操作不可撤销。')) return;
                        try {
                          await api.post(`/user/keys/${editDialog}/clear-quota`);
                          setEditForm({ ...editForm, quota_used: 0 });
                          loadKeys();
                          alert('余额已清洗');
                        } catch (err) {
                          alert(err.response?.data?.error || '清洗失败');
                        }
                      }}
                    >
                      清洗余额
                    </Button>
                  </div>
                  <Input type="number" value={editForm.quota_limit} onChange={(e) => setEditForm({ ...editForm, quota_limit: e.target.value })} min="0" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">过期时间</label>
                  <Input type="datetime-local" value={editForm.expires_at} onChange={(e) => setEditForm({ ...editForm, expires_at: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">限流 (次/分钟)</label>
                  <Input type="number" value={editForm.rate_limit} onChange={(e) => setEditForm({ ...editForm, rate_limit: parseInt(e.target.value) || 60 })} min="1" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">最大并发</label>
                  <Input type="number" value={editForm.max_concurrent} onChange={(e) => setEditForm({ ...editForm, max_concurrent: parseInt(e.target.value) || 500 })} min="1" />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setEditDialog(null)}>取消</Button>
                <Button onClick={handleEditSave}>保存</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
