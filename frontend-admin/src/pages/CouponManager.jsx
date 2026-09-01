import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { showAlert, showConfirm } from '../components/Dialog';
import api from '../lib/api';
import { cn } from '../lib/utils';
import {
  Ticket, Plus, Trash2, Edit2, X, Search, Users, Gift,
  ChevronLeft, ChevronRight, Loader2
} from 'lucide-react';

const PAGE_SIZE = 20;

const typeLabel = (type) => {
  if (type === 'percentage') return '百分比折扣';
  return '满减券';
};

function CouponFormModal({ coupon, onClose, onSave }) {
  const [form, setForm] = useState({
    name: coupon?.name || '',
    description: coupon?.description || '',
    type: coupon?.type || 'threshold_fixed',
    threshold: coupon?.threshold ?? '',
    discount_amount: coupon?.discount_amount ?? '',
    discount_rate: coupon?.discount_rate ?? '',
    max_uses: coupon?.max_uses ?? '',
    valid_start: coupon?.valid_start ? coupon.valid_start.slice(0, 16) : '',
    valid_end: coupon?.valid_end ? coupon.valid_end.slice(0, 16) : '',
    is_active: coupon ? coupon.is_active !== false && coupon.is_active !== 0 && coupon.is_active !== 'false' : true,
  });
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!form.name.trim()) return showAlert('请输入优惠券名称');
    setLoading(true);
    try {
      const payload = {
        ...form,
        threshold: parseFloat(form.threshold) || 0,
        discount_amount: parseFloat(form.discount_amount) || 0,
        discount_rate: parseFloat(form.discount_rate) || 0,
        max_uses: parseInt(form.max_uses) || 0,
        valid_start: form.valid_start || null,
        valid_end: form.valid_end || null,
      };
      if (coupon) {
        await api.put(`/billing/admin/coupons/${coupon.id}`, payload);
      } else {
        await api.post('/billing/admin/coupons', payload);
      }
      onSave();
      onClose();
    } catch (e) {
      showAlert(e.response?.data?.error || '保存失败');
    }
    setLoading(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-card border shadow-2xl rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col pointer-events-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
            <h2 className="text-lg font-semibold">{coupon ? '编辑优惠券' : '新增优惠券'}</h2>
            <button onClick={onClose} className="p-2 rounded-md hover:bg-muted transition-colors"><X className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">名称 <span className="text-red-500">*</span></label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例如：新用户满100减20" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">说明</label>
              <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="优惠券使用说明" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium">类型</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="threshold_fixed">满减券</option>
                  <option value="percentage">百分比折扣</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">状态</label>
                <select value={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.value === 'true' })} className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="true">启用</option>
                  <option value="false">停用</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium">满多少可用</label>
                <Input type="number" value={form.threshold} onChange={e => setForm({ ...form, threshold: e.target.value })} placeholder="100" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">{form.type === 'percentage' ? '折扣率 (0.15 = 85折)' : '减免金额'}</label>
                <Input type="number" value={form.type === 'percentage' ? form.discount_rate : form.discount_amount} onChange={e => setForm({ ...form, [form.type === 'percentage' ? 'discount_rate' : 'discount_amount']: e.target.value })} placeholder={form.type === 'percentage' ? '0.15' : '20'} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium">最多使用次数 (0 不限)</label>
                <Input type="number" value={form.max_uses} onChange={e => setForm({ ...form, max_uses: e.target.value })} placeholder="0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium">生效时间</label>
                <Input type="datetime-local" value={form.valid_start} onChange={e => setForm({ ...form, valid_start: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">过期时间</label>
                <Input type="datetime-local" value={form.valid_end} onChange={e => setForm({ ...form, valid_end: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button size="sm" onClick={submit} disabled={loading}>{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : '保存'}</Button>
              <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function IssueCouponModal({ coupons, onClose, onIssued }) {
  const [selectedCouponId, setSelectedCouponId] = useState('');
  const [usernames, setUsernames] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!selectedCouponId) return showAlert('请选择优惠券');
    const list = usernames.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) return showAlert('请输入至少一个用户名');
    setLoading(true);
    try {
      await api.post('/billing/admin/user-coupons/issue', {
        coupon_id: parseInt(selectedCouponId),
        usernames: list,
        expires_at: expiresAt || null,
      });
      onIssued();
      onClose();
    } catch (e) {
      showAlert(e.response?.data?.error || '发放失败');
    }
    setLoading(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-card border shadow-2xl rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col pointer-events-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
            <h2 className="text-lg font-semibold">发放优惠券</h2>
            <button onClick={onClose} className="p-2 rounded-md hover:bg-muted transition-colors"><X className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">优惠券</label>
              <select value={selectedCouponId} onChange={e => setSelectedCouponId(e.target.value)} className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">请选择</option>
                {coupons.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({typeLabel(c.type)})</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">目标用户（用户名，用空格或逗号分隔）</label>
              <textarea value={usernames} onChange={e => setUsernames(e.target.value)} placeholder="例如：zhangsan lisi" className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm resize-none" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">用户券过期时间（可选）</label>
              <Input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
            </div>
            <div className="flex gap-2 pt-2">
              <Button size="sm" onClick={submit} disabled={loading}>{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : '发放'}</Button>
              <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function CouponManager() {
  const [tab, setTab] = useState('templates');
  const [coupons, setCoupons] = useState([]);
  const [userCoupons, setUserCoupons] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState(null);
  const [showIssue, setShowIssue] = useState(false);
  const [filterUser, setFilterUser] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState(new Set());
  const [selectedUserCouponIds, setSelectedUserCouponIds] = useState(new Set());

  const fetchCoupons = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/billing/admin/coupons');
      setCoupons(res.data?.coupons || []);
    } catch (e) {
      showAlert('获取优惠券列表失败');
    }
    setLoading(false);
  }, []);

  const fetchUserCoupons = useCallback(async (p, username = filterUser) => {
    setLoading(true);
    try {
      const params = { page: p, limit: PAGE_SIZE };
      if (username.trim()) params.username = username.trim();
      const res = await api.get('/billing/admin/user-coupons', { params });
      setUserCoupons(res.data?.coupons || []);
      setTotalPages(res.data?.totalPages || 1);
      setPage(res.data?.page || p);
    } catch (e) {
      showAlert('获取用户优惠券失败');
    }
    setLoading(false);
  }, [filterUser]);

  useEffect(() => {
    fetchCoupons();
  }, [fetchCoupons]);

  useEffect(() => {
    if (tab === 'issued') fetchUserCoupons(1);
  }, [tab]);

  useEffect(() => {
    setSelectedTemplateIds(new Set());
    setSelectedUserCouponIds(new Set());
  }, [tab]);

  const toggleTemplateSelect = (id) => {
    setSelectedTemplateIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllTemplates = () => {
    if (selectedTemplateIds.size === coupons.length && coupons.length > 0) {
      setSelectedTemplateIds(new Set());
    } else {
      setSelectedTemplateIds(new Set(coupons.map(c => c.id)));
    }
  };

  const toggleUserCouponSelect = (id) => {
    setSelectedUserCouponIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllUserCoupons = () => {
    if (selectedUserCouponIds.size === userCoupons.length && userCoupons.length > 0) {
      setSelectedUserCouponIds(new Set());
    } else {
      setSelectedUserCouponIds(new Set(userCoupons.map(uc => uc.id)));
    }
  };

  const handleBatchDelete = async () => {
    if (selectedTemplateIds.size === 0) return;
    if (!await showConfirm(`确定删除选中的 ${selectedTemplateIds.size} 个优惠券模板？`)) return;
    try {
      await api.post('/billing/admin/coupons/batch-delete', { ids: Array.from(selectedTemplateIds) });
      setSelectedTemplateIds(new Set());
      fetchCoupons();
    } catch (e) {
      showAlert('批量删除失败');
    }
  };

  const handleBatchStatus = async (isActive) => {
    if (selectedTemplateIds.size === 0) return;
    try {
      await api.post('/billing/admin/coupons/batch-status', { ids: Array.from(selectedTemplateIds), is_active: isActive });
      setSelectedTemplateIds(new Set());
      fetchCoupons();
    } catch (e) {
      showAlert(isActive ? '批量启用失败' : '批量停用失败');
    }
  };

  const handleBatchRevoke = async () => {
    if (selectedUserCouponIds.size === 0) return;
    if (!await showConfirm(`确定收回选中的 ${selectedUserCouponIds.size} 张未使用用户优惠券？`)) return;
    try {
      await api.post('/billing/admin/user-coupons/batch-revoke', { ids: Array.from(selectedUserCouponIds) });
      setSelectedUserCouponIds(new Set());
      fetchUserCoupons(page);
    } catch (e) {
      showAlert('批量收回失败');
    }
  };

  const handleDelete = async (id) => {
    if (!await showConfirm('确定删除该优惠券模板？已发放的券将保留但无法再新建。')) return;
    try {
      await api.delete(`/billing/admin/coupons/${id}`);
      fetchCoupons();
    } catch (e) {
      showAlert('删除失败');
    }
  };

  const handleRevoke = async (id) => {
    if (!await showConfirm('确定收回这张未使用的用户优惠券？')) return;
    try {
      await api.post(`/billing/admin/user-coupons/${id}/revoke`);
      fetchUserCoupons(page);
    } catch (e) {
      showAlert('收回失败');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Ticket className="w-6 h-6 text-primary" />
            优惠券管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">管理优惠券模板、发放记录与用户持有的优惠券</p>
        </div>
        <div className="flex gap-2">
          {tab === 'templates' && (
            <Button onClick={() => { setEditingCoupon(null); setShowForm(true); }}>
              <Plus className="w-4 h-4 mr-1" /> 新增优惠券
            </Button>
          )}
          {tab === 'issued' && (
            <Button onClick={() => setShowIssue(true)}>
              <Gift className="w-4 h-4 mr-1" /> 发放优惠券
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-2 border-b">
        <button
          onClick={() => setTab('templates')}
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
            tab === 'templates' ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          优惠券模板
        </button>
        <button
          onClick={() => setTab('issued')}
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
            tab === 'issued' ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          用户优惠券
        </button>
      </div>

      {tab === 'templates' && (
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <CardTitle className="text-base">模板列表</CardTitle>
              {selectedTemplateIds.size > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">已选 {selectedTemplateIds.size} 项</span>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleBatchStatus(true)}>启用</Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleBatchStatus(false)}>停用</Button>
                  <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={handleBatchDelete}>删除</Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loading && <div className="py-8 text-center text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>}
            {!loading && coupons.length === 0 && (
              <div className="py-12 text-center text-muted-foreground text-sm">暂无优惠券模板，点击右上角创建</div>
            )}
            {!loading && coupons.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted">
                    <tr>
                      <th className="p-3 text-left w-10">
                        <input
                          type="checkbox"
                          checked={coupons.length > 0 && coupons.every(c => selectedTemplateIds.has(c.id))}
                          onChange={toggleAllTemplates}
                          className="rounded border-gray-300"
                        />
                      </th>
                      <th className="p-3 text-left">名称</th>
                      <th className="p-3 text-left">类型</th>
                      <th className="p-3 text-left">门槛 / 优惠</th>
                      <th className="p-3 text-left">已用/上限</th>
                      <th className="p-3 text-left">有效期</th>
                      <th className="p-3 text-left">状态</th>
                      <th className="p-3 text-left w-32">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coupons.map(c => (
                      <tr key={c.id} className="border-b">
                        <td className="p-3">
                          <input
                            type="checkbox"
                            checked={selectedTemplateIds.has(c.id)}
                            onChange={() => toggleTemplateSelect(c.id)}
                            className="rounded border-gray-300"
                          />
                        </td>
                        <td className="p-3">
                          <div className="font-medium">{c.name}</div>
                          <div className="text-xs text-muted-foreground">{c.description || '-'}</div>
                        </td>
                        <td className="p-3">{typeLabel(c.type)}</td>
                        <td className="p-3">
                          {c.type === 'percentage' ? (
                            <span>折扣率 {(parseFloat(c.discount_rate || 0) * 100).toFixed(0)}%</span>
                          ) : (
                            <span>满 ¥{(c.threshold || 0).toFixed(2)} 减 ¥{(c.discount_amount || 0).toFixed(2)}</span>
                          )}
                        </td>
                        <td className="p-3">{c.used_count || 0} / {c.max_uses || '∞'}</td>
                        <td className="p-3 text-xs">
                          {c.valid_start ? new Date(c.valid_start).toLocaleString('zh-CN') : '不限'}<br />
                          {c.valid_end ? new Date(c.valid_end).toLocaleString('zh-CN') : '不限'}
                        </td>
                        <td className="p-3">
                          <Badge variant={c.is_active ? 'success' : 'secondary'}>{c.is_active ? '启用' : '停用'}</Badge>
                        </td>
                        <td className="p-3">
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => { setEditingCoupon(c); setShowForm(true); }}><Edit2 className="w-3.5 h-3.5" /></Button>
                            <Button size="sm" variant="destructive" className="h-7 px-2" onClick={() => handleDelete(c.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'issued' && (
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <CardTitle className="text-base">用户持有列表</CardTitle>
              {selectedUserCouponIds.size > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">已选 {selectedUserCouponIds.size} 项</span>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleBatchRevoke}>批量收回</Button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filterUser}
                    onChange={e => setFilterUser(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && fetchUserCoupons(1)}
                    placeholder="按用户名筛选"
                    className="pl-9 h-8 text-sm w-48"
                  />
                </div>
                <Button size="sm" variant="outline" onClick={() => fetchUserCoupons(1)}>查询</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading && <div className="py-8 text-center text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>}
            {!loading && userCoupons.length === 0 && (
              <div className="py-12 text-center text-muted-foreground text-sm">暂无用户优惠券</div>
            )}
            {!loading && userCoupons.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted">
                    <tr>
                      <th className="p-3 text-left w-10">
                        <input
                          type="checkbox"
                          checked={userCoupons.length > 0 && userCoupons.every(uc => selectedUserCouponIds.has(uc.id))}
                          onChange={toggleAllUserCoupons}
                          className="rounded border-gray-300"
                        />
                      </th>
                      <th className="p-3 text-left">用户</th>
                      <th className="p-3 text-left">优惠券</th>
                      <th className="p-3 text-left">类型 / 优惠</th>
                      <th className="p-3 text-left">状态</th>
                      <th className="p-3 text-left">发放时间</th>
                      <th className="p-3 text-left">过期时间</th>
                      <th className="p-3 text-left">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userCoupons.map(uc => (
                      <tr key={uc.id} className="border-b">
                        <td className="p-3">
                          <input
                            type="checkbox"
                            checked={selectedUserCouponIds.has(uc.id)}
                            onChange={() => toggleUserCouponSelect(uc.id)}
                            className="rounded border-gray-300"
                          />
                        </td>
                        <td className="p-3">{uc.username || uc.user_id}</td>
                        <td className="p-3">{uc.coupon_name}</td>
                        <td className="p-3">
                          {uc.type === 'percentage' ? (
                            <span>折扣率 {(parseFloat(uc.discount_rate || 0) * 100).toFixed(0)}%</span>
                          ) : (
                            <span>满 ¥{(uc.threshold || 0).toFixed(2)} 减 ¥{(uc.discount_amount || 0).toFixed(2)}</span>
                          )}
                        </td>
                        <td className="p-3">
                          <Badge variant={uc.status === 'unused' ? 'success' : uc.status === 'used' ? 'secondary' : 'outline'}>{uc.status}</Badge>
                        </td>
                        <td className="p-3 text-xs">{uc.issued_at ? new Date(uc.issued_at).toLocaleString('zh-CN') : '-'}</td>
                        <td className="p-3 text-xs">{uc.expires_at ? new Date(uc.expires_at).toLocaleString('zh-CN') : '-'}</td>
                        <td className="p-3">
                          {uc.status === 'unused' && (
                            <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => handleRevoke(uc.id)}>收回</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-4 border-t mt-4">
                <div className="text-xs text-muted-foreground">第 {page} / {totalPages} 页</div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => fetchUserCoupons(page - 1)} disabled={page <= 1}><ChevronLeft className="w-4 h-4" /></Button>
                  <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => fetchUserCoupons(page + 1)} disabled={page >= totalPages}><ChevronRight className="w-4 h-4" /></Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {showForm && (
        <CouponFormModal
          coupon={editingCoupon}
          onClose={() => setShowForm(false)}
          onSave={() => { fetchCoupons(); if (tab === 'issued') fetchUserCoupons(page); }}
        />
      )}
      {showIssue && (
        <IssueCouponModal
          coupons={coupons}
          onClose={() => setShowIssue(false)}
          onIssued={() => fetchUserCoupons(page)}
        />
      )}
    </div>
  );
}
