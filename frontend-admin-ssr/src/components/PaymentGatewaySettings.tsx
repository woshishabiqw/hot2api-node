import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { Card } from './Card';
import { Input } from './Input';
import { Button } from './Button';
import { Badge } from './Badge';
import {
  Loader2, Landmark, Lock, LogOut, Shield,
  Plus, Trash2, Edit2, X, Check, RefreshCw, Eye, EyeOff
} from 'lucide-react';
import { cn } from '../lib/utils';
import api from '../lib/api';
import { showAlert, showConfirm } from './Dialog';

const API_URL = (import.meta as any).env?.VITE_API_URL || '/api';

function PinInput({ length = 6, onComplete, disabled = false, error = '' }) {
  const [digits, setDigits] = useState(Array(length).fill(''));
  const inputRefs = useRef([]);

  useEffect(() => {
    if (!disabled && inputRefs.current[0]) {
      inputRefs.current[0].focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => {
        setDigits(Array(length).fill(''));
        inputRefs.current[0]?.focus();
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const handleChange = (index, value) => {
    if (!/^\d*$/.test(value)) return;
    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);
    if (value && index < length - 1) inputRefs.current[index + 1]?.focus();
    if (newDigits.every(d => d !== '')) onComplete(newDigits.join(''));
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) inputRefs.current[index - 1]?.focus();
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    const newDigits = [...digits];
    for (let i = 0; i < pasted.length && i < length; i++) newDigits[i] = pasted[i];
    setDigits(newDigits);
    const fi = Math.min(pasted.length, length - 1);
    inputRefs.current[fi]?.focus();
    if (newDigits.every(d => d !== '')) onComplete(newDigits.join(''));
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-2">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={el => { inputRefs.current[i] = el; }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={d}
            disabled={disabled}
            onChange={e => handleChange(i, e.target.value)}
            onKeyDown={e => handleKeyDown(i, e)}
            onPaste={handlePaste}
            className={cn(
              "w-12 h-14 text-center text-2xl font-bold rounded-lg border-2 bg-background outline-none transition-all",
              error ? "border-red-500 focus:border-red-500" : "border-input focus:border-primary focus:ring-2 focus:ring-primary/20"
            )}
          />
        ))}
      </div>
      {error && <div className="text-sm text-red-500">{error}</div>}
    </div>
  );
}

export default function PaymentGatewaySettings() {
  const { token } = useAuth();
  const [paymentToken, setPaymentToken] = useState(localStorage.getItem('payment_auth_token') || '');
  const [needSetup, setNeedSetup] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [pinError, setPinError] = useState('');
  const [gateLoading, setGateLoading] = useState(false);
  const [pinAttempt, setPinAttempt] = useState(0);

  // Channel management state
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [showConfig, setShowConfig] = useState({});

  const [newChannel, setNewChannel] = useState({
    name: '', type: 'alipay', config: '', env: 'production', priority: 0, use_qrcode: false, qr_expire_seconds: 600
  });

  useEffect(() => {
    api.get('/auth/payment-password/status')
      .then(res => { setNeedSetup(res.data.need_setup); setCheckingStatus(false); })
      .catch(() => setCheckingStatus(false));
  }, [token]);

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

  useEffect(() => { if (paymentToken) loadChannels(); }, [paymentToken]);

  const verifyPin = async (pin) => {
    setGateLoading(true); setPinError('');
    try {
      const res = await api.post('/auth/payment-password/verify', { password: pin });
      if (res.data?.second_token) {
        localStorage.setItem('payment_auth_token', res.data.second_token);
        setPaymentToken(res.data.second_token);
      } else {
        setPinError(res.data?.error || '密码错误');
      }
    } catch (err) {
      console.error('[PaymentAuth] verify error:', err.response?.data || err.message);
      setPinError(err.response?.data?.error || '密码错误');
      setPinAttempt(prev => prev + 1);
    }
    setGateLoading(false);
  };

  const setupPin = async (pin, confirmPin) => {
    if (pin !== confirmPin) { setPinError('两次输入不一致'); return; }
    setGateLoading(true); setPinError('');
    try {
      const res = await api.post('/auth/payment-password/setup', { password: pin, confirm_password: confirmPin });
      if (res.data?.second_token) {
        localStorage.setItem('payment_auth_token', res.data.second_token);
        setPaymentToken(res.data.second_token); setNeedSetup(false);
      } else { setPinError(res.data?.error || '设置失败'); }
    } catch (err) {
      console.error('[PaymentAuth] setup error:', err.response?.data || err.message);
      setPinError(err.response?.data?.error || '网络错误，请检查后端服务');
    }
    setGateLoading(false);
  };

  const handleAdd = async () => {
    let configObj = {};
    try {
      configObj = JSON.parse(newChannel.config || '{}');
    } catch {
      showAlert('配置 JSON 格式错误');
      return;
    }
    try {
      await api.post('/payment-gateway/payment-channels', {
        name: newChannel.name,
        type: newChannel.type,
        config: configObj,
        env: newChannel.env,
        priority: parseInt(String(newChannel.priority)) || 0,
        use_qrcode: newChannel.type === 'alipay' ? newChannel.use_qrcode : false,
        qr_expire_seconds: newChannel.type === 'alipay' ? parseInt(String(newChannel.qr_expire_seconds)) || 600 : 600
      });
      setShowAdd(false);
      setNewChannel({ name: '', type: 'alipay', config: '', env: 'production', priority: 0, use_qrcode: false, qr_expire_seconds: 600 });
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

  const handleSaveEdit = async (id) => {
    const name = (document.getElementById(`edit-name-${id}`) as HTMLInputElement | null)?.value;
    const env = (document.getElementById(`edit-env-${id}`) as HTMLInputElement | null)?.value;
    const priority = (document.getElementById(`edit-priority-${id}`) as HTMLInputElement | null)?.value;
    const configStr = (document.getElementById(`edit-config-${id}`) as HTMLTextAreaElement | null)?.value;
    const useQrcodeEl = document.getElementById(`edit-use-qrcode-${id}`) as HTMLInputElement | null;
    const qrExpireEl = document.getElementById(`edit-qr-expire-seconds-${id}`) as HTMLInputElement | null;
    let configObj = {};
    try {
      configObj = JSON.parse(configStr || '{}');
    } catch {
      showAlert('配置 JSON 格式错误');
      return;
    }
    const ch = channels.find((c) => c.id === id);
    const payload: any = {
      name, env, priority: parseInt(priority) || 0, config: configObj
    };
    if (ch?.type === 'alipay') {
      payload.use_qrcode = !!useQrcodeEl?.checked;
      payload.qr_expire_seconds = parseInt(qrExpireEl?.value || '600') || 600;
    }
    try {
      await api.put(`/payment-gateway/payment-channels/${id}`, payload);
      setEditingId(null);
      loadChannels();
    } catch (err) {
      showAlert(err.response?.data?.error || '保存失败');
    }
  };

  const toggleShowConfig = (id) => {
    setShowConfig(prev => ({ ...prev, [id]: !prev[id] }));
  };

  if (checkingStatus) {
    return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (!paymentToken) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-8">
          <div className="flex flex-col items-center gap-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Shield className="w-8 h-8 text-primary" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-bold">{needSetup ? '设置支付接口密码' : '支付接口验证'}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {needSetup ? '首次使用支付渠道，请设置6位数字支付接口密码' : '请输入6位数字支付接口密码以继续'}
              </p>
            </div>
            {needSetup ? <SetupPinForm onSubmit={setupPin} disabled={gateLoading} error={pinError} /> : (
              <>
                <PinInput key={pinAttempt} onComplete={verifyPin} disabled={gateLoading} error={pinError} />
                {gateLoading && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
              </>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 mt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Landmark className="w-5 h-5" />
          支付通道配置
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { localStorage.removeItem('payment_auth_token'); setPaymentToken(''); }}>
            <LogOut className="w-4 h-4 mr-1" /> 退出验证
          </Button>
          <Button onClick={() => setShowAdd(!showAdd)}>
            <Plus className="w-4 h-4 mr-1" /> 添加通道
          </Button>
        </div>
      </div>

      {showAdd && (
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-4">新增支付通道</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">名称</label>
              <Input value={newChannel.name} onChange={e => setNewChannel({ ...newChannel, name: e.target.value })} placeholder="如：支付宝生产环境" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">类型</label>
              <select value={newChannel.type} onChange={e => setNewChannel({ ...newChannel, type: e.target.value })} className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="alipay">支付宝</option>
                <option value="wechat">微信支付</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">环境</label>
              <select value={newChannel.env} onChange={e => setNewChannel({ ...newChannel, env: e.target.value })} className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="production">生产环境</option>
                <option value="sandbox">沙盒环境</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="space-y-1 md:col-span-2">
              <label className="text-xs font-medium">配置 JSON</label>
              <textarea
                value={newChannel.config}
                onChange={e => setNewChannel({ ...newChannel, config: e.target.value })}
                placeholder={`{ "appId": "", "privateKey": "", "alipayPublicKey": "" }`}
                className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">优先级（越高越优先）</label>
              <Input type="number" value={newChannel.priority} onChange={e => setNewChannel({ ...newChannel, priority: e.target.value })} min="0" />
            </div>
          </div>
          {newChannel.type === 'alipay' && (
            <div className="flex flex-wrap items-end gap-4 mb-4">
              <div className="flex items-center gap-2">
                <input
                  id="new-use-qrcode"
                  type="checkbox"
                  className="h-4 w-4 rounded border-input"
                  checked={newChannel.use_qrcode}
                  onChange={e => setNewChannel({ ...newChannel, use_qrcode: e.target.checked })}
                />
                <label htmlFor="new-use-qrcode" className="text-xs font-medium">使用官方二维码支付</label>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium">二维码有效期（秒）</label>
                <Input type="number" value={newChannel.qr_expire_seconds} onChange={e => setNewChannel({ ...newChannel, qr_expire_seconds: e.target.value })} min="60" className="w-28" />
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd}>保存</Button>
            <Button size="sm" variant="outline" onClick={() => setShowAdd(false)}>取消</Button>
          </div>
        </Card>
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
                  <td className="p-3">
                    {editingId === ch.id ? (
                      <Input id={`edit-name-${ch.id}`} defaultValue={ch.name} className="h-7 text-xs" />
                    ) : (
                      <span className="font-medium">{ch.name}</span>
                    )}
                  </td>
                  <td className="p-3">
                    <Badge variant={ch.type === 'alipay' ? 'default' : 'secondary'}>
                      {ch.type === 'alipay' ? '支付宝' : '微信支付'}
                    </Badge>
                  </td>
                  <td className="p-3">
                    {editingId === ch.id ? (
                      <select id={`edit-env-${ch.id}`} defaultValue={ch.env} className="h-7 text-xs rounded border border-input bg-background px-2">
                        <option value="production">生产</option>
                        <option value="sandbox">沙盒</option>
                      </select>
                    ) : (
                      <Badge variant={ch.env === 'sandbox' ? 'warning' : 'outline'} className="text-xs">
                        {ch.env === 'sandbox' ? '沙盒' : '生产'}
                      </Badge>
                    )}
                  </td>
                  <td className="p-3">
                    <Badge variant={ch.is_active ? 'success' : 'destructive'} className="text-xs">
                      {ch.is_active ? '启用' : '禁用'}
                    </Badge>
                  </td>
                  <td className="p-3">
                    {editingId === ch.id && ch.type === 'alipay' ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <input
                            id={`edit-use-qrcode-${ch.id}`}
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            defaultChecked={ch.use_qrcode}
                          />
                          <label htmlFor={`edit-use-qrcode-${ch.id}`} className="text-xs font-medium">官方二维码</label>
                        </div>
                        <Input id={`edit-qr-expire-seconds-${ch.id}`} type="number" defaultValue={ch.qr_expire_seconds ?? 600} min="60" className="h-6 text-xs w-20" />
                      </div>
                    ) : ch.type === 'alipay' && ch.use_qrcode ? (
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
                  <td className="p-3">
                    {editingId === ch.id ? (
                      <Input id={`edit-priority-${ch.id}`} type="number" defaultValue={ch.priority} className="h-7 text-xs w-16" />
                    ) : (
                      <span>{ch.priority}</span>
                    )}
                  </td>
                  <td className="p-3">
                    {editingId === ch.id ? (
                      <textarea
                        id={`edit-config-${ch.id}`}
                        defaultValue={JSON.stringify(ch.config || {}, null, 2)}
                        className="w-48 h-20 rounded border border-input bg-background px-2 py-1 text-xs font-mono resize-none"
                      />
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => toggleShowConfig(ch.id)}>
                          {showConfig[ch.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </Button>
                        {showConfig[ch.id] && (
                          <pre className="text-[10px] bg-muted p-1 rounded max-w-xs overflow-auto">{JSON.stringify(ch.config || {}, null, 2)}</pre>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      {editingId === ch.id ? (
                        <>
                          <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => handleSaveEdit(ch.id)}><Check className="w-3 h-3" /></Button>
                          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setEditingId(null)}><X className="w-3 h-3" /></Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => setEditingId(ch.id)}><Edit2 className="w-3 h-3" /></Button>
                          <Button size="sm" variant={ch.is_active ? 'secondary' : 'success'} className="h-6 text-xs px-2" onClick={() => handleToggle(ch.id)}>
                            {ch.is_active ? '禁用' : '启用'}
                          </Button>
                          <Button size="sm" variant="outline" className="h-6 px-2" disabled={testingId === ch.id} onClick={() => handleTest(ch.id)}>
                            {testingId === ch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          </Button>
                          <Button size="sm" variant="destructive" className="h-6 px-2" onClick={() => handleDelete(ch.id)}><Trash2 className="w-3 h-3" /></Button>
                        </>
                      )}
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

function SetupPinForm({ onSubmit, disabled, error }) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState(1);

  const handlePinComplete = (p) => {
    setPin(p);
    setStep(2);
  };

  const handleConfirmComplete = (p) => {
    setConfirmPin(p);
    onSubmit(pin, p);
  };

  return (
    <div className="w-full flex flex-col items-center gap-4">
      {step === 1 ? (
        <>
          <div className="text-sm font-medium">请设置6位支付接口密码</div>
          <PinInput onComplete={handlePinComplete} disabled={disabled} error={error} />
        </>
      ) : (
        <>
          <div className="text-sm font-medium">请再次确认</div>
          <PinInput onComplete={handleConfirmComplete} disabled={disabled} error={error} />
          <button onClick={() => { setStep(1); setPin(''); setConfirmPin(''); }} className="text-sm text-primary hover:underline">
            重新输入
          </button>
        </>
      )}
      {disabled && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
    </div>
  );
}
