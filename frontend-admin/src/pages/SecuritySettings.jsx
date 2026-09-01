import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { Plus, Trash2, Edit2, Check, X, Shield, Cpu } from 'lucide-react';
import { showAlert, showConfirm } from '../components/Dialog';

export default function SecuritySettings() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ ip: '', reason: '', enabled: true, expires_at: '' });

  const [nodeSecurity, setNodeSecurity] = useState({
    ipRateLimit: { enabled: false, windowSeconds: 60, maxRequests: 100 },
    bodyLimitMb: 10,
    corsOrigins: '',
    requestTimeoutSeconds: 130,
  });
  const [nodeSaving, setNodeSaving] = useState(false);

  useEffect(() => { loadData(); loadNodeSecurity(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/security/ip-blacklist');
      setList(res.data?.list || []);
    } catch (err) {
      showAlert(err.response?.data?.error || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const loadNodeSecurity = async () => {
    try {
      const res = await api.get('/admin/security/node-config');
      const data = res.data || {};
      setNodeSecurity({
        ipRateLimit: {
          enabled: data.ipRateLimit?.enabled === true,
          windowSeconds: data.ipRateLimit?.windowSeconds ?? 60,
          maxRequests: data.ipRateLimit?.maxRequests ?? 100,
        },
        bodyLimitMb: data.bodyLimitMb ?? 10,
        corsOrigins: data.corsOrigins ?? '',
        requestTimeoutSeconds: data.requestTimeoutSeconds ?? 130,
      });
    } catch (err) {
      // Node security config may be unavailable; ignore.
    }
  };

  const resetForm = () => {
    setForm({ ip: '', reason: '', enabled: true, expires_at: '' });
    setShowAdd(false);
    setEditingId(null);
  };

  const validateIp = (ip) => {
    const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    if (!cidrRegex.test(ip)) return false;
    const [addr, prefix] = ip.split('/');
    for (const o of addr.split('.')) {
      const n = parseInt(o, 10);
      if (Number.isNaN(n) || n < 0 || n > 255) return false;
    }
    if (prefix !== undefined) {
      const p = parseInt(prefix, 10);
      if (Number.isNaN(p) || p < 0 || p > 32) return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validateIp(form.ip)) {
      return showAlert('请输入有效的 IPv4 地址或 CIDR，例如 192.168.1.1 或 10.0.0.0/24');
    }
    try {
      const payload = { ...form };
      if (!payload.expires_at) delete payload.expires_at;
      if (editingId) {
        await api.put(`/admin/security/ip-blacklist/${editingId}`, payload);
      } else {
        await api.post('/admin/security/ip-blacklist', payload);
      }
      resetForm();
      await loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '保存失败');
    }
  };

  const handleDelete = async (item) => {
    if (!(await showConfirm(`确定要删除黑名单 ${item.ip} 吗？`))) return;
    try {
      await api.delete(`/admin/security/ip-blacklist/${item.id}`);
      await loadData();
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const startEdit = (item) => {
    setEditingId(item.id);
    setForm({
      ip: item.ip,
      reason: item.reason || '',
      enabled: item.enabled,
      expires_at: item.expires_at ? item.expires_at.slice(0, 16) : ''
    });
    setShowAdd(true);
  };

  const handleNodeSecuritySave = async () => {
    setNodeSaving(true);
    try {
      const res = await api.put('/admin/security/node-config', nodeSecurity);
      showAlert('Node 层安全配置已保存');
      setNodeSecurity(res.data?.config || nodeSecurity);
    } catch (err) {
      showAlert(err.response?.data?.error || '保存失败');
    } finally {
      setNodeSaving(false);
    }
  };

  const updateNodeIpRateLimit = (field, value) => {
    setNodeSecurity(s => ({
      ...s,
      ipRateLimit: { ...s.ipRateLimit, [field]: value },
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            安全管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">IP 黑名单、访问控制与安全策略</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>IP 黑名单</span>
            <Button size="sm" onClick={() => setShowAdd(true)} disabled={showAdd}>
              <Plus className="w-4 h-4 mr-1" />
              添加
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {showAdd && (
            <div className="mb-4 p-4 border rounded-lg bg-muted/30 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">IP / CIDR</label>
                  <Input
                    placeholder="例如 192.168.1.1 或 10.0.0.0/24"
                    value={form.ip}
                    onChange={e => setForm({ ...form, ip: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">过期时间（可选）</label>
                  <Input
                    type="datetime-local"
                    value={form.expires_at}
                    onChange={e => setForm({ ...form, expires_at: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">原因（可选）</label>
                <Input
                  placeholder="封禁原因"
                  value={form.reason}
                  onChange={e => setForm({ ...form, reason: e.target.value })}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="enabled"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm({ ...form, enabled: e.target.checked })}
                />
                <label htmlFor="enabled" className="text-sm">启用</label>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave}><Check className="w-4 h-4 mr-1" />保存</Button>
                <Button size="sm" variant="outline" onClick={resetForm}><X className="w-4 h-4 mr-1" />取消</Button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-center py-8 text-muted-foreground">加载中…</div>
          ) : list.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">暂无黑名单</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">IP / CIDR</th>
                    <th className="px-4 py-3 text-left font-medium">原因</th>
                    <th className="px-4 py-3 text-left font-medium">状态</th>
                    <th className="px-4 py-3 text-left font-medium">过期时间</th>
                    <th className="px-4 py-3 text-left font-medium">创建时间</th>
                    <th className="px-4 py-3 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(item => (
                    <tr key={item.id} className="border-b hover:bg-muted/30">
                      <td className="px-4 py-3 font-mono">{item.ip}</td>
                      <td className="px-4 py-3 text-muted-foreground">{item.reason || '-'}</td>
                      <td className="px-4 py-3">
                        <Badge variant={item.enabled ? 'default' : 'outline'}>
                          {item.enabled ? '启用' : '禁用'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{item.expires_at ? new Date(item.expires_at).toLocaleString('zh-CN') : '永久'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{new Date(item.created_at).toLocaleString('zh-CN')}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => startEdit(item)}><Edit2 className="w-4 h-4" /></Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleDelete(item)}><Trash2 className="w-4 h-4" /></Button>
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-primary" />
            Node.js 层安全
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                id="node_ip_rate_limit"
                type="checkbox"
                checked={nodeSecurity.ipRateLimit.enabled}
                onChange={e => updateNodeIpRateLimit('enabled', e.target.checked)}
              />
              <label htmlFor="node_ip_rate_limit" className="text-sm">启用全局 IP 速率限制（Node 层兜底）</label>
            </div>
            {nodeSecurity.ipRateLimit.enabled && (
              <div className="grid grid-cols-2 gap-3 pl-6">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">时间窗口（秒）</label>
                  <Input
                    type="number"
                    min={1}
                    max={3600}
                    value={nodeSecurity.ipRateLimit.windowSeconds}
                    onChange={e => updateNodeIpRateLimit('windowSeconds', parseInt(e.target.value) || 60)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">窗口内最大请求数</label>
                  <Input
                    type="number"
                    min={1}
                    max={100000}
                    value={nodeSecurity.ipRateLimit.maxRequests}
                    onChange={e => updateNodeIpRateLimit('maxRequests', parseInt(e.target.value) || 100)}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">请求体大小限制（MB）</label>
              <Input
                type="number"
                min={1}
                max={100}
                value={nodeSecurity.bodyLimitMb}
                onChange={e => setNodeSecurity(s => ({ ...s, bodyLimitMb: parseInt(e.target.value) || 10 }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">全局请求超时（秒）</label>
              <Input
                type="number"
                min={1}
                max={3600}
                value={nodeSecurity.requestTimeoutSeconds}
                onChange={e => setNodeSecurity(s => ({ ...s, requestTimeoutSeconds: parseInt(e.target.value) || 130 }))}
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">CORS 来源白名单（逗号分隔，留空使用默认）</label>
            <Input
              value={nodeSecurity.corsOrigins}
              onChange={e => setNodeSecurity(s => ({ ...s, corsOrigins: e.target.value }))}
              placeholder="例如 http://localhost:3001,http://localhost:3002"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            注意：请求体大小、超时和 CORS 源保存后需要重启后端服务才能生效。
          </p>

          <Button onClick={handleNodeSecuritySave} disabled={nodeSaving}>
            {nodeSaving ? '保存中…' : '保存 Node 层安全配置'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
