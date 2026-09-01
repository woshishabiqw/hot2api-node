import { useState, useEffect } from 'react';
import { Card } from './Card';
import { Input } from './Input';
import { Button } from './Button';
import { Badge } from './Badge';
import {
  Loader2, Landmark,
  Plus, Trash2, Edit2, X, Check, RefreshCw, Eye, EyeOff
} from 'lucide-react';
import api from '../lib/api';
import { showAlert, showConfirm } from './Dialog';

// Hardcoded supported channel types. The backend also supports these.
// channelTypes from /meta only reflects existing DB rows, so we merge to allow
// adding the first Alipay / WeChat channel even when none exist yet.
const SUPPORTED_CHANNEL_TYPES = ['alipay', 'wechat', 'stripe'];

const FIELD_SCHEMAS = {
  alipay: [
    {
      key: 'appId',
      label: 'AppID',
      type: 'text',
      required: true,
      placeholder: '例如：9021000162614057',
      description: '支付宝开放平台 → 应用详情 → APPID。沙箱环境一般为 16 位数字。',
    },
    {
      key: 'privateKey',
      label: '应用私钥',
      type: 'textarea',
      required: true,
      fullWidth: true,
      placeholder: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...',
      description: '支付宝开放平台 → 应用信息 → 接口加签方式 → 应用私钥。支持 PKCS1（-----BEGIN RSA PRIVATE KEY-----）和 PKCS8（-----BEGIN PRIVATE KEY-----）格式。',
    },
    {
      key: 'alipayPublicKey',
      label: '支付宝公钥',
      type: 'textarea',
      required: true,
      fullWidth: true,
      placeholder: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...',
      description: '【重要】不是「应用公钥」！必须从支付宝开放平台 → 接口加签方式 → 支付宝公钥 复制，用于验证支付宝异步通知签名。',
    },
    {
      key: 'gateway',
      label: '支付宝网关',
      type: 'text',
      default: 'https://openapi.alipaydev.com/gateway.do',
      fullWidth: true,
      placeholder: 'https://openapi.alipaydev.com/gateway.do',
      description: '沙箱环境请填写 https://openapi.alipaydev.com/gateway.do；生产环境请填写 https://openapi.alipay.com/gateway.do。',
    },
    {
      key: 'notifyUrl',
      label: '异步通知地址（notify_url）',
      type: 'text',
      fullWidth: true,
      placeholder: 'https://你的域名/api/billing/notify',
      description: '支付宝服务器异步通知地址，必须是公网可访问地址，建议以 /api/billing/notify 结尾。',
    },
    {
      key: 'returnUrl',
      label: '同步返回地址（return_url）',
      type: 'text',
      fullWidth: true,
      placeholder: 'https://你的域名/wallet',
      description: '支付完成后浏览器同步跳转地址，建议填写用户钱包页公网地址。',
    },
    {
      key: 'appGatewayUrl',
      label: '应用网关地址',
      type: 'text',
      fullWidth: true,
      description: '可选。生活号、小程序等场景需要，普通网站支付可留空。',
    },
    {
      key: 'authCallbackUrl',
      label: '授权回调地址',
      type: 'text',
      fullWidth: true,
      description: '可选。用户授权回调地址，普通网站支付可留空。',
    },
    {
      key: 'encryptType',
      label: '接口内容加密方式',
      type: 'select',
      options: ['', 'AES', 'RSA'],
      description: '可选。如果支付宝控制台开启了「接口内容加密」，请与控制台保持一致；未开启请留空。',
    },
  ],
  wechat: [
    { key: 'appId', label: 'App ID', type: 'text', required: true },
    { key: 'mchId', label: '商户号', type: 'text', required: true },
    { key: 'apiKey', label: 'API Key', type: 'textarea', required: true, fullWidth: true },
    { key: 'notifyUrl', label: '通知地址', type: 'text', fullWidth: true },
  ],
  stripe: [
    { key: 'secretKey', label: 'Secret Key (sk_test_...)', type: 'textarea', required: true, fullWidth: true },
    { key: 'publishableKey', label: 'Publishable Key (pk_test_...)', type: 'text', required: true, fullWidth: true },
    { key: 'webhookSecret', label: 'Webhook Secret (whsec_...)', type: 'textarea', fullWidth: true },
  ],
};

const getDefaultConfig = (type) => {
  const schema = FIELD_SCHEMAS[type];
  if (!schema) return {};
  return schema.reduce((acc, field) => {
    acc[field.key] = field.default ?? '';
    return acc;
  }, {});
};

const SENSITIVE_CONFIG_KEYS = ['privateKey', 'alipayPublicKey', 'secretKey', 'apiKey', 'webhookSecret', 'publishableKey'];

function maskConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const masked = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_CONFIG_KEYS.includes(key) && typeof value === 'string' && value.length > 8) {
      masked[key] = value.slice(0, 4) + '****' + value.slice(-4);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

const validateConfig = (type, config) => {
  const schema = FIELD_SCHEMAS[type];
  if (!schema) return null;
  for (const field of schema) {
    const value = (config[field.key] || '').toString().trim();
    if (field.required && !value) {
      return `${field.label} 不能为空`;
    }
  }

  if (type === 'alipay') {
    const privateKey = (config.privateKey || '').trim();
    const publicKey = (config.alipayPublicKey || '').trim();

    if (privateKey && !privateKey.includes('-----BEGIN')) {
      return '应用私钥格式不正确，必须以 -----BEGIN PRIVATE KEY----- 或 -----BEGIN RSA PRIVATE KEY----- 开头';
    }
    if (privateKey && !(privateKey.includes('PRIVATE KEY-----') && privateKey.includes('-----END'))) {
      return '应用私钥格式不完整，请检查是否包含完整的 BEGIN/END 标记';
    }
    if (publicKey && !publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
      return '支付宝公钥格式不正确，必须以 -----BEGIN PUBLIC KEY----- 开头';
    }
    if (publicKey && !publicKey.includes('-----END PUBLIC KEY-----')) {
      return '支付宝公钥格式不完整，请检查是否包含完整的 END 标记';
    }

    const notifyUrl = (config.notifyUrl || '').trim();
    const returnUrl = (config.returnUrl || '').trim();
    const urlPattern = /^https?:\/\/.+/;
    if (notifyUrl && !urlPattern.test(notifyUrl)) {
      return '异步通知地址必须以 http:// 或 https:// 开头';
    }
    if (returnUrl && !urlPattern.test(returnUrl)) {
      return '同步返回地址必须以 http:// 或 https:// 开头';
    }
  }

  return null;
};

function ConfigField({ field, value, onChange, compact = false }) {
  const placeholder = field.placeholder || `${field.label}${field.required ? ' *' : ''}`;
  const inputClass = compact
    ? 'w-full min-w-[220px] rounded-md border border-input bg-background px-2 py-1 text-xs resize-y'
    : 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y';

  let input;
  if (field.type === 'textarea') {
    input = (
      <textarea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClass}
        rows={compact ? 2 : 3}
      />
    );
  } else if (field.type === 'select') {
    input = (
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      >
        <option value="">请选择 {field.label}</option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  } else {
    input = (
      <Input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={compact ? 'h-7 text-xs' : ''}
      />
    );
  }

  if (compact) return input;

  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">
        {field.label}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {input}
      {field.description && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">{field.description}</p>
      )}
    </div>
  );
}

export default function PaymentGatewaySettings() {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [showConfig, setShowConfig] = useState({});
  const [channelTypes, setChannelTypes] = useState([]);
  const [envTypes, setEnvTypes] = useState([]);
  const [editForm, setEditForm] = useState(null);

  const [newChannel, setNewChannel] = useState({
    name: '', type: '', config: '', env: 'production', priority: 0, use_qrcode: false, qr_expire_seconds: 600, configMode: 'manual', manualConfig: {}
  });

  const loadChannels = async () => {
    setLoading(true);
    try {
      const res = await api.get('/payment-gateway/payment-channels');
      setChannels(res.data || []);
    } catch (e) {
      showAlert('加载通道配置失败');
    } finally {
      setLoading(false);
    }
  };

  const loadChannelMeta = async () => {
    try {
      const res = await api.get('/payment-gateway/payment-channels/meta');
      setChannelTypes(res.data.types || []);
      setEnvTypes(res.data.envs || []);
    } catch (e) {
      console.error('Failed to load channel meta:', e);
    }
  };

  useEffect(() => {
    loadChannels();
    loadChannelMeta();
  }, []);

  const handleAdd = async () => {
    if (!newChannel.name || !newChannel.type) {
      showAlert('请填写名称和类型');
      return;
    }

    let configObj = {};
    if (newChannel.configMode === 'json') {
      try {
        configObj = JSON.parse(newChannel.config || '{}');
      } catch {
        showAlert('配置 JSON 格式错误');
        return;
      }
    } else {
      const err = validateConfig(newChannel.type, newChannel.manualConfig);
      if (err) {
        showAlert(err);
        return;
      }
      configObj = { ...newChannel.manualConfig };
    }

    try {
      await api.post('/payment-gateway/payment-channels', {
        name: newChannel.name,
        type: newChannel.type,
        config: configObj,
        env: newChannel.env,
        priority: parseInt(newChannel.priority) || 0,
        use_qrcode: newChannel.use_qrcode,
        qr_expire_seconds: parseInt(newChannel.qr_expire_seconds) || 600
      });
      setShowAdd(false);
      setNewChannel({ name: '', type: '', config: '', env: 'production', priority: 0, use_qrcode: false, qr_expire_seconds: 600, configMode: 'manual', manualConfig: {} });
      loadChannels();
    } catch (err) {
      showAlert(err.response?.data?.error || '添加失败');
    }
  };

  const handleDelete = async (id) => {
    if (!await showConfirm('确定要删除这个支付通道配置吗？')) return;
    try {
      await api.delete(`/payment-gateway/payment-channels/${id}`);
      loadChannels();
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败');
    }
  };

  const handleToggle = async (id) => {
    try {
      await api.post(`/payment-gateway/payment-channels/${id}/toggle`);
      loadChannels();
    } catch (err) {
      showAlert('操作失败');
    }
  };

  const handleSetPrimary = async (id) => {
    try {
      await api.post(`/payment-gateway/payment-channels/${id}/set-primary`);
      loadChannels();
    } catch (err) {
      showAlert('设置主通道失败');
    }
  };

  const handleTest = async (id) => {
    setTestingId(id);
    try {
      const res = await api.post(`/payment-gateway/payment-channels/${id}/test`);
      showAlert(res.data.success ? `连接测试成功: ${res.data.message}` : `连接测试失败: ${res.data.message}`);
    } catch (err) {
      showAlert('测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const startEdit = (id) => {
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    const hasSchema = !!FIELD_SCHEMAS[ch.type];
    setEditForm({
      id: ch.id,
      name: ch.name,
      env: ch.env,
      priority: ch.priority,
      use_qrcode: ch.use_qrcode,
      qr_expire_seconds: ch.qr_expire_seconds ?? 600,
      configMode: hasSchema ? 'manual' : 'json',
      manualConfig: hasSchema ? { ...getDefaultConfig(ch.type), ...(ch.config || {}) } : {},
      configStr: JSON.stringify(ch.config || {}, null, 2),
    });
    setEditingId(id);
  };

  const handleSaveEdit = async () => {
    if (!editForm) return;
    const id = editForm.id;
    const ch = channels.find((c) => c.id === id);

    let configObj = {};
    if (editForm.configMode === 'json') {
      try {
        configObj = JSON.parse(editForm.configStr || '{}');
      } catch {
        showAlert('配置 JSON 格式错误');
        return;
      }
    } else {
      const err = validateConfig(ch?.type, editForm.manualConfig);
      if (err) {
        showAlert(err);
        return;
      }
      configObj = { ...editForm.manualConfig };
    }

    try {
      await api.put(`/payment-gateway/payment-channels/${id}`, {
        name: editForm.name,
        env: editForm.env,
        priority: parseInt(editForm.priority) || 0,
        config: configObj,
        use_qrcode: editForm.use_qrcode,
        qr_expire_seconds: parseInt(editForm.qr_expire_seconds) || 600
      });
      setEditingId(null);
      setEditForm(null);
      loadChannels();
    } catch (err) {
      showAlert(err.response?.data?.error || '保存失败');
    }
  };

  const toggleShowConfig = (id) => {
    setShowConfig((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const renderSchemaFields = (type, config, onChange, compact = false) => {
    const schema = FIELD_SCHEMAS[type];
    if (!schema) {
      return <p className="text-xs text-muted-foreground">当前类型不支持手动字段配置，请使用 JSON 模式</p>;
    }
    return (
      <div className={compact ? 'space-y-1' : 'grid grid-cols-1 md:grid-cols-2 gap-4'}>
        {schema.map((field) => (
          <div key={field.key} className={!compact && field.fullWidth ? 'md:col-span-2' : ''}>
            <ConfigField
              field={field}
              value={config[field.key]}
              onChange={(value) => onChange(field.key, value)}
              compact={compact}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6 mt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Landmark className="w-5 h-5" />
          支付通道配置
        </h3>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4 mr-1" /> 添加通道
          </Button>
        </div>
      </div>

      {/* Add Channel Modal */}
      {showAdd && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setShowAdd(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <div className="bg-card border shadow-2xl rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col pointer-events-auto">
              <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
                <h2 className="text-lg font-semibold">新增支付通道</h2>
                <button onClick={() => setShowAdd(false)} className="p-2 rounded-md hover:bg-muted transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">名称</label>
                    <Input value={newChannel.name} onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })} placeholder="如：支付宝生产环境" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">类型</label>
                    <select
                      value={newChannel.type}
                      onChange={(e) => {
                        const type = e.target.value;
                        setNewChannel((prev) => ({
                          ...prev,
                          type,
                          manualConfig: getDefaultConfig(type)
                        }));
                      }}
                      className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">请选择</option>
                      {SUPPORTED_CHANNEL_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">环境</label>
                    <select value={newChannel.env} onChange={(e) => setNewChannel({ ...newChannel, env: e.target.value })} className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                      {['production', 'sandbox'].map((env) => (
                        <option key={env} value={env}>{env === 'production' ? '生产环境' : env === 'sandbox' ? '沙盒环境' : env}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium mb-2 block">配置方式</label>
                  <div className="flex gap-2">
                    <Button size="sm" variant={newChannel.configMode === 'manual' ? 'default' : 'outline'} onClick={() => setNewChannel((prev) => ({ ...prev, configMode: 'manual' }))}>手动输入</Button>
                    <Button size="sm" variant={newChannel.configMode === 'json' ? 'default' : 'outline'} onClick={() => setNewChannel((prev) => ({ ...prev, configMode: 'json' }))}>JSON 编辑</Button>
                  </div>
                </div>

                {newChannel.configMode === 'manual' ? (
                  <div className="space-y-4">
                    {newChannel.type ? (
                      renderSchemaFields(
                        newChannel.type,
                        newChannel.manualConfig,
                        (key, value) => setNewChannel((prev) => ({
                          ...prev,
                          manualConfig: { ...prev.manualConfig, [key]: value }
                        }))
                      )
                    ) : (
                      <p className="text-sm text-muted-foreground">请先选择通道类型以显示对应字段</p>
                    )}
                    <div>
                      <label className="text-xs font-medium">优先级（越高越优先）</label>
                      <Input type="number" value={newChannel.priority} onChange={(e) => setNewChannel({ ...newChannel, priority: e.target.value })} min="0" className="w-32" />
                    </div>
                    {newChannel.type === 'alipay' && (
                      <div className="md:col-span-2 flex flex-wrap items-end gap-4">
                        <div className="flex items-center gap-2">
                          <input
                            id="new-use-qrcode"
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            checked={newChannel.use_qrcode}
                            onChange={(e) => setNewChannel({ ...newChannel, use_qrcode: e.target.checked })}
                          />
                          <label htmlFor="new-use-qrcode" className="text-xs font-medium">使用官方二维码支付</label>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-medium">二维码有效期（秒）</label>
                          <Input type="number" value={newChannel.qr_expire_seconds} onChange={(e) => setNewChannel({ ...newChannel, qr_expire_seconds: e.target.value })} min="60" className="w-28" />
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1 md:col-span-2">
                      <label className="text-xs font-medium">配置 JSON</label>
                      <textarea
                        value={newChannel.config}
                        onChange={(e) => setNewChannel({ ...newChannel, config: e.target.value })}
                        placeholder='{ "appId": "", "privateKey": "", "alipayPublicKey": "" }'
                        className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">优先级（越高越优先）</label>
                      <Input type="number" value={newChannel.priority} onChange={(e) => setNewChannel({ ...newChannel, priority: e.target.value })} min="0" />
                    </div>
                    {newChannel.type === 'alipay' && (
                      <div className="md:col-span-3 flex flex-wrap items-end gap-4">
                        <div className="flex items-center gap-2">
                          <input
                            id="new-use-qrcode-json"
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            checked={newChannel.use_qrcode}
                            onChange={(e) => setNewChannel({ ...newChannel, use_qrcode: e.target.checked })}
                          />
                          <label htmlFor="new-use-qrcode-json" className="text-xs font-medium">使用官方二维码支付</label>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-medium">二维码有效期（秒）</label>
                          <Input type="number" value={newChannel.qr_expire_seconds} onChange={(e) => setNewChannel({ ...newChannel, qr_expire_seconds: e.target.value })} min="60" className="w-28" />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button size="sm" onClick={handleAdd}>保存</Button>
                  <Button size="sm" variant="outline" onClick={() => setShowAdd(false)}>取消</Button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Edit Channel Modal */}
      {editingId && editForm && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => { setEditingId(null); setEditForm(null); }} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <div className="bg-card border shadow-2xl rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col pointer-events-auto">
              <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
                <h2 className="text-lg font-semibold">编辑支付通道</h2>
                <button onClick={() => { setEditingId(null); setEditForm(null); }} className="p-2 rounded-md hover:bg-muted transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">名称</label>
                    <Input value={editForm.name} onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="如：支付宝生产环境" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">类型</label>
                    <Input value={editForm.id ? channels.find((c) => c.id === editForm.id)?.type : ''} disabled className="bg-muted" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">环境</label>
                    <select value={editForm.env} onChange={(e) => setEditForm((prev) => ({ ...prev, env: e.target.value }))} className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                      {['production', 'sandbox'].map((env) => (
                        <option key={env} value={env}>{env === 'production' ? '生产环境' : env === 'sandbox' ? '沙盒环境' : env}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium mb-2 block">配置方式</label>
                  <div className="flex gap-2">
                    <Button size="sm" variant={editForm.configMode === 'manual' ? 'default' : 'outline'} onClick={() => setEditForm((prev) => ({ ...prev, configMode: 'manual' }))}>手动输入</Button>
                    <Button size="sm" variant={editForm.configMode === 'json' ? 'default' : 'outline'} onClick={() => setEditForm((prev) => ({ ...prev, configMode: 'json' }))}>JSON 编辑</Button>
                  </div>
                </div>

                {editForm.configMode === 'manual' ? (
                  <div className="space-y-4">
                    {renderSchemaFields(
                      channels.find((c) => c.id === editForm.id)?.type,
                      editForm.manualConfig,
                      (key, value) => setEditForm((prev) => ({
                        ...prev,
                        manualConfig: { ...prev.manualConfig, [key]: value }
                      }))
                    )}
                    <div>
                      <label className="text-xs font-medium">优先级（越高越优先）</label>
                      <Input type="number" value={editForm.priority} onChange={(e) => setEditForm((prev) => ({ ...prev, priority: e.target.value }))} min="0" className="w-32" />
                    </div>
                    {channels.find((c) => c.id === editForm.id)?.type === 'alipay' && (
                      <div className="md:col-span-2 flex flex-wrap items-end gap-4">
                        <div className="flex items-center gap-2">
                          <input
                            id="edit-use-qrcode"
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            checked={editForm.use_qrcode}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, use_qrcode: e.target.checked }))}
                          />
                          <label htmlFor="edit-use-qrcode" className="text-xs font-medium">使用官方二维码支付</label>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-medium">二维码有效期（秒）</label>
                          <Input type="number" value={editForm.qr_expire_seconds} onChange={(e) => setEditForm((prev) => ({ ...prev, qr_expire_seconds: e.target.value }))} min="60" className="w-28" />
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1 md:col-span-2">
                      <label className="text-xs font-medium">配置 JSON</label>
                      <textarea
                        value={editForm.configStr}
                        onChange={(e) => setEditForm((prev) => ({ ...prev, configStr: e.target.value }))}
                        placeholder='{ "appId": "", "privateKey": "", "alipayPublicKey": "" }'
                        className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">优先级（越高越优先）</label>
                      <Input type="number" value={editForm.priority} onChange={(e) => setEditForm((prev) => ({ ...prev, priority: e.target.value }))} min="0" />
                    </div>
                    {channels.find((c) => c.id === editForm.id)?.type === 'alipay' && (
                      <div className="md:col-span-3 flex flex-wrap items-end gap-4">
                        <div className="flex items-center gap-2">
                          <input
                            id="edit-use-qrcode-json"
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            checked={editForm.use_qrcode}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, use_qrcode: e.target.checked }))}
                          />
                          <label htmlFor="edit-use-qrcode-json" className="text-xs font-medium">使用官方二维码支付</label>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-medium">二维码有效期（秒）</label>
                          <Input type="number" value={editForm.qr_expire_seconds} onChange={(e) => setEditForm((prev) => ({ ...prev, qr_expire_seconds: e.target.value }))} min="60" className="w-28" />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button size="sm" onClick={handleSaveEdit}>保存</Button>
                  <Button size="sm" variant="outline" onClick={() => { setEditingId(null); setEditForm(null); }}>取消</Button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted">
              <tr>
                <th className="p-3 text-left">名称</th>
                <th className="p-3 text-left">类型</th>
                <th className="p-3 text-left">环境</th>
                <th className="p-3 text-left">状态</th>
                <th className="p-3 text-left">QR支付</th>
                <th className="p-3 text-left">主通道</th>
                <th className="p-3 text-left">优先级</th>
                <th className="p-3 text-left">配置</th>
                <th className="p-3 text-left w-48">操作</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => (
                <tr key={ch.id} className="border-b">
                  <td className="p-3"><span className="font-medium">{ch.name}</span></td>
                  <td className="p-3">
                    <Badge variant={ch.type === 'alipay' ? 'default' : 'secondary'}>
                      {ch.type === 'alipay' ? '支付宝' : ch.type === 'stripe' ? 'Stripe' : '微信支付'}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Badge variant={ch.env === 'sandbox' ? 'warning' : 'outline'} className="text-xs">
                      {ch.env === 'sandbox' ? '沙盒' : '生产'}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Badge variant={ch.is_active ? 'success' : 'destructive'} className="text-xs">
                      {ch.is_active ? '启用' : '禁用'}
                    </Badge>
                  </td>
                  <td className="p-3">
                    {ch.type === 'alipay' && ch.use_qrcode ? (
                      <Badge variant="success" className="text-xs">已启用</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    {ch.is_primary ? (
                      <Badge variant="success" className="text-xs">主通道</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => handleSetPrimary(ch.id)}>设为主通道</Button>
                    )}
                  </td>
                  <td className="p-3"><span>{ch.priority}</span></td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => toggleShowConfig(ch.id)}>
                        {showConfig[ch.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      </Button>
                      {showConfig[ch.id] && (
                        <pre className="text-[10px] bg-muted p-1 rounded max-w-xs overflow-auto">{JSON.stringify(maskConfig(ch.config) || {}, null, 2)}</pre>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => startEdit(ch.id)}><Edit2 className="w-3 h-3" /></Button>
                      <Button size="sm" variant={ch.is_active ? 'secondary' : 'success'} className="h-6 text-xs px-2" onClick={() => handleToggle(ch.id)}>
                        {ch.is_active ? '禁用' : '启用'}
                      </Button>
                      <Button size="sm" variant="outline" className="h-6 px-2" disabled={testingId === ch.id} onClick={() => handleTest(ch.id)}>
                        {testingId === ch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      </Button>
                      <Button size="sm" variant="destructive" className="h-6 px-2" onClick={() => handleDelete(ch.id)}><Trash2 className="w-3 h-3" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
              {channels.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-muted-foreground text-sm">暂无支付通道配置</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
