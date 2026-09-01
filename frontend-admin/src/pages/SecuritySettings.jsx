import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { Plus, Trash2, Edit2, Check, X, Shield, Server, Cpu } from 'lucide-react';
import { showAlert, showConfirm } from '../components/Dialog';

export default function SecuritySettings() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ ip: '', reason: '', enabled: true, expires_at: '' });

  const [nginxControlled, setNginxControlled] = useState(false);
  const [nginxCapabilities, setNginxCapabilities] = useState({});
  const [serverConfig, setServerConfig] = useState(null);
  const [nginxSecurity, setNginxSecurity] = useState({
    server_tokens: false,
    security_headers: false,
    admin_ip_allowlist: [],
    rate_limit: { enabled: false, rps: 10, burst: 20 },
    timeouts: { client_body: 60, client_header: 60, send: 60 },
  });
  const [nginxSaving, setNginxSaving] = useState(false);
  const [nginxStatus, setNginxStatus] = useState(null);
  const [nginxStatusLoading, setNginxStatusLoading] = useState(false);

  const [nodeSecurity, setNodeSecurity] = useState({
    ipRateLimit: { enabled: false, windowSeconds: 60, maxRequests: 100 },
    bodyLimitMb: 10,
    corsOrigins: '',
    requestTimeoutSeconds: 130,
  });
  const [nodeSaving, setNodeSaving] = useState(false);

  useEffect(() => { loadData(); loadServerConfig(); loadNginxStatus(); loadNodeSecurity(); }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      loadNginxStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

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

  const loadNginxStatus = async () => {
    setNginxStatusLoading(true);
    try {
      const res = await api.get('/admin/nginx-status');
      setNginxStatus(res.data);
    } catch (err) {
      // Ignore polling errors so the UI doesn't flash alerts.
    } finally {
      setNginxStatusLoading(false);
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

  const loadServerConfig = async () => {
    try {
      const res = await api.get('/admin/server-config');
      const cfg = res.data;
      setServerConfig(cfg);
      setNginxControlled(cfg.nginx_controlled === true);
      setNginxCapabilities(cfg.nginx_capabilities || {});
      const sec = cfg.nginx?.security || {};
      setNginxSecurity({
        server_tokens: sec.server_tokens === true,
        security_headers: sec.security_headers === true,
        admin_ip_allowlist: Array.isArray(sec.admin_ip_allowlist) ? sec.admin_ip_allowlist : [],
        rate_limit: {
          enabled: sec.rate_limit?.enabled === true,
          rps: sec.rate_limit?.rps ?? 10,
          burst: sec.rate_limit?.burst ?? 20,
        },
        timeouts: {
          client_body: sec.timeouts?.client_body ?? 60,
          client_header: sec.timeouts?.client_header ?? 60,
          send: sec.timeouts?.send ?? 60,
        },
      });
    } catch (err) {
      // Server config may be unavailable in some test setups; ignore.
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

  const handleNginxSave = async () => {
    if (!serverConfig) return;
    setNginxSaving(true);
    try {
      // Strip UI-only fields returned by GET /admin/server-config
      const { nginx_controlled, nginx_capabilities, ...cleanConfig } = serverConfig;
      const payload = {
        ...cleanConfig,
        nginx: {
          ...(cleanConfig.nginx || {}),
          security: nginxSecurity,
        },
      };
      // The backend only accepts security fields when nginx_controlled is true.
      const res = await api.put('/admin/server-config', payload);
      showAlert(res.data?.nginx_reloaded
        ? 'Nginx 安全配置已保存并生效'
        : `Nginx 安全配置已保存（${res.data?.nginx_reload_message || '未重载'}）`);
      await loadServerConfig();
    } catch (err) {
      showAlert(err.response?.data?.error || '保存失败');
    } finally {
      setNginxSaving(false);
    }
  };

  const toggleBool = (key) => {
    setNginxSecurity(s => ({ ...s, [key]: !s[key] }));
  };

  const updateRateLimit = (field, value) => {
    setNginxSecurity(s => ({
      ...s,
      rate_limit: { ...s.rate_limit, [field]: value },
    }));
  };

  const updateTimeout = (field, value) => {
    setNginxSecurity(s => ({
      ...s,
      timeouts: { ...s.timeouts, [field]: value },
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
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-5 h-5 text-primary" />
              Nginx 层安全
            </div>
            {nginxStatus && (
              <Badge variant={nginxStatus.controlled ? (nginxStatus.running ? 'default' : 'destructive') : 'outline'}>
                {nginxStatusLoading ? '检测中…' : nginxStatus.controlled ? (nginxStatus.running ? '运行中' : '未运行') : '未控制'}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!nginxControlled ? (
            <div className="text-sm text-muted-foreground">
              当前未使用项目自带的 Nginx，Nginx 层安全选项已禁用。Node.js 后端的安全策略仍然生效。
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  id="server_tokens"
                  type="checkbox"
                  checked={nginxSecurity.server_tokens}
                  onChange={() => toggleBool('server_tokens')}
                />
                <label htmlFor="server_tokens" className="text-sm">隐藏 Nginx 版本号（server_tokens off）</label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="security_headers"
                  type="checkbox"
                  checked={nginxSecurity.security_headers}
                  onChange={() => toggleBool('security_headers')}
                />
                <label htmlFor="security_headers" className="text-sm">启用 Nginx 安全响应头（Permissions-Policy）</label>
              </div>

              <div>
                <label className="text-xs text-muted-foreground block mb-1">管理后台 IP 白名单（每行一个 CIDR，留空表示不限制）</label>
                <textarea
                  className="w-full min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="例如：&#10;127.0.0.1/32&#10;10.0.0.0/24"
                  value={nginxSecurity.admin_ip_allowlist.join('\n')}
                  onChange={e => setNginxSecurity(s => ({ ...s, admin_ip_allowlist: e.target.value.split('\n').map(x => x.trim()).filter(Boolean) }))}
                />
              </div>

              {nginxCapabilities.limit_req && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      id="rate_limit_enabled"
                      type="checkbox"
                      checked={nginxSecurity.rate_limit.enabled}
                      onChange={e => updateRateLimit('enabled', e.target.checked)}
                    />
                    <label htmlFor="rate_limit_enabled" className="text-sm">启用 API 速率限制（limit_req）</label>
                  </div>
                  {nginxSecurity.rate_limit.enabled && (
                    <div className="grid grid-cols-2 gap-3 pl-6">
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">每秒请求数（rps）</label>
                        <Input
                          type="number"
                          min={1}
                          max={10000}
                          value={nginxSecurity.rate_limit.rps}
                          onChange={e => updateRateLimit('rps', parseInt(e.target.value) || 10)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">突发容量（burst）</label>
                        <Input
                          type="number"
                          min={1}
                          max={100000}
                          value={nginxSecurity.rate_limit.burst}
                          onChange={e => updateRateLimit('burst', parseInt(e.target.value) || 20)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">client_body_timeout（秒）</label>
                  <Input
                    type="number"
                    min={1}
                    max={3600}
                    value={nginxSecurity.timeouts.client_body}
                    onChange={e => updateTimeout('client_body', parseInt(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">client_header_timeout（秒）</label>
                  <Input
                    type="number"
                    min={1}
                    max={3600}
                    value={nginxSecurity.timeouts.client_header}
                    onChange={e => updateTimeout('client_header', parseInt(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">send_timeout（秒）</label>
                  <Input
                    type="number"
                    min={1}
                    max={3600}
                    value={nginxSecurity.timeouts.send}
                    onChange={e => updateTimeout('send', parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>

              <Button onClick={handleNginxSave} disabled={nginxSaving}>
                {nginxSaving ? '保存中…' : '保存 Nginx 安全配置'}
              </Button>
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
