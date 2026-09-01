import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { Loader2, Save, ShieldCheck, UserPlus, UserCheck, UserX, AlertCircle, CheckCircle, X, Settings, Mail, Send } from 'lucide-react';
import { cn } from '../lib/utils';
import api from '../lib/api';

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
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}

function Toggle({ label, description, checked, onChange, disabled }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">{label}</label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? 'bg-primary' : 'bg-input'
        )}
      >
        <span
          className={cn(
            "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform",
            checked ? 'translate-x-5' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  );
}

export default function UsersRegistration() {
  const [config, setConfig] = useState({
    registration_enabled: true,
    captcha_enabled: false,
    email_verification_enabled: false,
    registration_approval_mode: 'auto'
  });
  const [mailConfig, setMailConfig] = useState({
    host: '',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: ''
  });
  const [testEmail, setTestEmail] = useState('');
  const [savingMail, setSavingMail] = useState(false);
  const [testingMail, setTestingMail] = useState(false);
  const [pending, setPending] = useState([]);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [loadingPending, setLoadingPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => setToast({ message, type });

  useEffect(() => {
    loadConfig();
    loadPending();
  }, []);

  const loadConfig = async () => {
    setLoadingConfig(true);
    try {
      const [regRes, mailRes] = await Promise.all([
        window.__REGISTRATION_CONFIG__
          ? Promise.resolve({ data: window.__REGISTRATION_CONFIG__ })
          : api.get('/admin/registration/config'),
        api.get('/admin/mail/config')
      ]);
      const data = regRes.data || {};
      setConfig({
        registration_enabled: data.registrationEnabled ?? data.registration_enabled ?? true,
        captcha_enabled: data.captchaEnabled ?? data.captcha_enabled ?? false,
        email_verification_enabled: data.emailVerificationEnabled ?? data.email_verification_enabled ?? false,
        registration_approval_mode: data.approvalMode ?? data.registration_approval_mode ?? 'auto'
      });
      const m = mailRes.data || {};
      setMailConfig({
        host: m.host || '',
        port: m.port ?? 465,
        secure: m.secure ?? true,
        user: m.user || '',
        pass: '',
        from: m.from || ''
      });
    } catch (e) {
      showToast('加载配置失败', 'error');
    }
    setLoadingConfig(false);
  };

  const loadPending = async () => {
    setLoadingPending(true);
    try {
      const res = await api.get('/admin/registration/pending');
      setPending(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      showToast('加载待审批用户失败', 'error');
    }
    setLoadingPending(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/admin/registration/config', {
        registration_enabled: config.registration_enabled,
        captcha_enabled: config.captcha_enabled,
        email_verification_enabled: config.email_verification_enabled,
        registration_approval_mode: config.registration_approval_mode
      });
      showToast('注册配置已保存');
    } catch (e) {
      showToast(e.response?.data?.error || '保存失败', 'error');
    }
    setSaving(false);
  };

  const handleSaveMail = async () => {
    setSavingMail(true);
    try {
      await api.put('/admin/mail/config', {
        host: mailConfig.host,
        port: parseInt(mailConfig.port, 10) || 465,
        secure: mailConfig.secure,
        user: mailConfig.user,
        pass: mailConfig.pass,
        from: mailConfig.from
      });
      showToast('邮件配置已保存');
    } catch (e) {
      showToast(e.response?.data?.error || '保存邮件配置失败', 'error');
    }
    setSavingMail(false);
  };

  const handleTestMail = async () => {
    if (!testEmail) return;
    setTestingMail(true);
    try {
      await api.post('/admin/mail/test', { to: testEmail });
      showToast('测试邮件已发送');
    } catch (e) {
      showToast(e.response?.data?.error || '测试邮件发送失败', 'error');
    }
    setTestingMail(false);
  };

  const handleApprove = async (id) => {
    setActionId(id);
    try {
      await api.post(`/admin/registration/${id}/approve`);
      showToast('用户已通过');
      loadPending();
    } catch (e) {
      showToast(e.response?.data?.error || '审批失败', 'error');
    }
    setActionId(null);
  };

  const handleReject = async (id) => {
    setActionId(id);
    try {
      await api.post(`/admin/registration/${id}/reject`);
      showToast('用户已拒绝');
      loadPending();
    } catch (e) {
      showToast(e.response?.data?.error || '拒绝失败', 'error');
    }
    setActionId(null);
  };

  const formatTime = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    return isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
  };

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-primary" />
          注册管理
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          管理用户注册开关、图形验证码与人工审批
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="w-4 h-4 text-primary" />
            注册配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {loadingConfig ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Toggle
                  label="允许用户注册"
                  description="关闭后将禁止新用户注册"
                  checked={config.registration_enabled}
                  onChange={(value) => setConfig(prev => ({ ...prev, registration_enabled: value }))}
                />
                <Toggle
                  label="启用图形验证码"
                  description="注册时要求填写图形验证码"
                  checked={config.captcha_enabled}
                  onChange={(value) => setConfig(prev => ({ ...prev, captcha_enabled: value }))}
                />
                <Toggle
                  label="启用邮箱验证"
                  description="注册时需验证邮箱验证码"
                  checked={config.email_verification_enabled}
                  onChange={(value) => setConfig(prev => ({ ...prev, email_verification_enabled: value }))}
                />
              </div>

              <div className="space-y-2 max-w-md">
                <label className="text-sm font-medium">审批模式</label>
                <select
                  value={config.registration_approval_mode}
                  onChange={e => setConfig(prev => ({ ...prev, registration_approval_mode: e.target.value }))}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="auto">自动通过（默认）</option>
                  <option value="manual">人工审批</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  人工审批模式下，新注册用户需要管理员在下方列表通过后才能登录
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  保存配置
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="w-4 h-4 text-primary" />
            SMTP 邮件配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {loadingConfig ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium">SMTP 服务器</label>
                  <Input
                    value={mailConfig.host}
                    onChange={e => setMailConfig(prev => ({ ...prev, host: e.target.value }))}
                    placeholder="例如 smtp.example.com"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">端口</label>
                  <Input
                    type="number"
                    value={mailConfig.port}
                    onChange={e => setMailConfig(prev => ({ ...prev, port: e.target.value }))}
                    placeholder="465"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">账号</label>
                  <Input
                    value={mailConfig.user}
                    onChange={e => setMailConfig(prev => ({ ...prev, user: e.target.value }))}
                    placeholder="发件邮箱账号"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">密码 / 授权码</label>
                  <Input
                    type="password"
                    value={mailConfig.pass}
                    onChange={e => setMailConfig(prev => ({ ...prev, pass: e.target.value }))}
                    placeholder="留空表示不修改"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">发件人</label>
                  <Input
                    value={mailConfig.from}
                    onChange={e => setMailConfig(prev => ({ ...prev, from: e.target.value }))}
                    placeholder="例如 noreply@example.com"
                  />
                </div>
                <div className="flex items-end">
                  <Toggle
                    label="使用 SSL/TLS"
                    description="secure 模式（通常端口 465 开启）"
                    checked={mailConfig.secure}
                    onChange={(value) => setMailConfig(prev => ({ ...prev, secure: value }))}
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2 border-t">
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <Input
                    value={testEmail}
                    onChange={e => setTestEmail(e.target.value)}
                    placeholder="输入测试收件邮箱"
                    className="w-full sm:w-64"
                  />
                  <Button variant="outline" onClick={handleTestMail} disabled={testingMail || !testEmail}>
                    {testingMail ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                    测试
                  </Button>
                </div>
                <Button onClick={handleSaveMail} disabled={savingMail}>
                  {savingMail ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  保存邮件配置
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-primary" />
            待审批用户
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingPending ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : pending.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              暂无待审批用户
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-4 font-medium">用户名</th>
                    <th className="text-left py-3 px-4 font-medium">角色</th>
                    <th className="text-left py-3 px-4 font-medium">注册时间</th>
                    <th className="text-right py-3 px-4 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map(user => (
                    <tr key={user.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-3 px-4">{user.username}</td>
                      <td className="py-3 px-4">
                        <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
                          {user.role === 'admin' ? '管理员' : '用户'}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">{formatTime(user.created_at)}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleApprove(user.id)}
                            disabled={actionId === user.id}
                          >
                            {actionId === user.id ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <UserCheck className="w-3.5 h-3.5 mr-1" />}
                            通过
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleReject(user.id)}
                            disabled={actionId === user.id}
                          >
                            {actionId === user.id ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <UserX className="w-3.5 h-3.5 mr-1" />}
                            拒绝
                          </Button>
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
    </div>
  );
}
