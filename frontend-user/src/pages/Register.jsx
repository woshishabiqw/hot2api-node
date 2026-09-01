import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';

export default function Register() {
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    emailCode: '',
    captchaCode: '',
    captchaToken: ''
  });
  const [config, setConfig] = useState({
    registrationEnabled: true,
    captchaEnabled: false,
    emailVerificationEnabled: false,
    approvalMode: 'auto'
  });
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    if (config.captchaEnabled) {
      loadCaptcha();
    }
  }, [config.captchaEnabled]);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const loadConfig = async () => {
    if (window.__REGISTRATION_CONFIG__) {
      setConfig(window.__REGISTRATION_CONFIG__);
      return;
    }
    try {
      const res = await axios.get('/api/auth/config');
      setConfig(res.data);
    } catch (e) {
      setError('加载注册配置失败');
    }
  };

  const loadCaptcha = async () => {
    try {
      const res = await axios.get('/api/auth/captcha');
      setCaptchaSvg(res.data.svg);
      setForm(prev => ({ ...prev, captchaToken: res.data.token, captchaCode: '' }));
    } catch (e) {
      setError('图形验证码加载失败');
    }
  };

  const handleSendEmailCode = async () => {
    if (!form.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setSendingCode(true);
    setError('');
    try {
      await axios.post('/api/auth/send-email-code', { email: form.email });
      setCountdown(60);
      setSuccess('验证码已发送，请查收邮件');
    } catch (e) {
      setError(e.response?.data?.error || '验证码发送失败');
    }
    setSendingCode(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      await axios.post('/api/auth/register', {
        username: form.username,
        email: config.emailVerificationEnabled ? form.email : undefined,
        emailCode: config.emailVerificationEnabled ? form.emailCode : undefined,
        password: form.password,
        captchaToken: config.captchaEnabled ? form.captchaToken : undefined,
        captchaCode: config.captchaEnabled ? form.captchaCode : undefined,
      });

      if (config.approvalMode === 'manual') {
        setSuccess('注册成功，请等待管理员审批');
      } else {
        setSuccess('注册成功，请登录');
        setTimeout(() => navigate('/login'), 1500);
      }
    } catch (e) {
      setError(e.response?.data?.error || '注册失败');
      if (config.captchaEnabled) {
        loadCaptcha();
      }
    }
    setLoading(false);
  };

  const update = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  if (!config.registrationEnabled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center">注册已关闭</CardTitle>
          </CardHeader>
          <CardContent className="text-center text-muted-foreground">
            当前已关闭自助注册，请联系管理员。
            <div className="mt-4">
              <Link to="/login" className="text-primary hover:underline text-sm">返回登录</Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">注册账号</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                {error}
              </div>
            )}
            {success && (
              <div className="p-3 rounded-md bg-emerald-500/10 text-emerald-600 text-sm">
                {success}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">用户名</label>
              <Input
                value={form.username}
                onChange={(e) => update('username', e.target.value)}
                placeholder="至少 3 个字符"
                required
                minLength={3}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">密码</label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                placeholder="至少 8 位，包含字母和数字"
                required
                minLength={8}
              />
            </div>
            {config.emailVerificationEnabled && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">邮箱</label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => update('email', e.target.value)}
                    placeholder="请输入邮箱"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">邮箱验证码</label>
                  <div className="flex gap-2">
                    <Input
                      value={form.emailCode}
                      onChange={(e) => update('emailCode', e.target.value)}
                      placeholder="6 位验证码"
                      required
                      maxLength={6}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleSendEmailCode}
                      disabled={sendingCode || countdown > 0}
                    >
                      {countdown > 0 ? `${countdown}s` : (sendingCode ? '发送中...' : '获取验证码')}
                    </Button>
                  </div>
                </div>
              </>
            )}
            {config.captchaEnabled && (
              <div className="space-y-2">
                <label className="text-sm font-medium">图形验证码</label>
                <div className="flex gap-2">
                  <Input
                    value={form.captchaCode}
                    onChange={(e) => update('captchaCode', e.target.value)}
                    placeholder="请输入验证码"
                    required
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={loadCaptcha}
                    className="shrink-0 rounded-md border overflow-hidden w-[120px] h-10"
                    dangerouslySetInnerHTML={{ __html: captchaSvg }}
                  />
                </div>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '注册中...' : '注册'}
            </Button>
            <div className="text-center text-sm">
              <Link to="/login" className="text-primary hover:underline">已有账号？去登录</Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
