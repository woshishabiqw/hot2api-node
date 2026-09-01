import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import axios from 'axios';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [config, setConfig] = useState({ captchaEnabled: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { user, login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    console.log('[Login] user changed:', !!user);
    if (user) {
      console.log('[Login] navigating to /');
      navigate('/', { replace: true });
    }
  }, [user, navigate]);

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    if (config.captchaEnabled) {
      loadCaptcha();
    }
  }, [config.captchaEnabled]);

  const loadConfig = async () => {
    if (window.__REGISTRATION_CONFIG__) {
      setConfig(window.__REGISTRATION_CONFIG__);
      return;
    }
    try {
      const res = await axios.get('/api/auth/config');
      setConfig(res.data || { captchaEnabled: false });
    } catch (e) {
      console.error('Failed to load login config:', e);
    }
  };

  const loadCaptcha = async () => {
    try {
      const res = await axios.get('/api/auth/captcha');
      setCaptchaSvg(res.data.svg);
      setCaptchaToken(res.data.token);
      setCaptchaCode('');
    } catch (e) {
      setError('图形验证码加载失败');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login({
        username,
        password,
        captchaToken: config.captchaEnabled ? captchaToken : undefined,
        captchaCode: config.captchaEnabled ? captchaCode : undefined,
      });
      // AppRoutes will auto-redirect to / when user is set
    } catch (err) {
      setError(err.response?.data?.error || '登录失败');
      if (config.captchaEnabled) {
        loadCaptcha();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">Fuck网关</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">用户名</label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">密码</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                required
              />
            </div>
            {config.captchaEnabled && (
              <div className="space-y-2">
                <label className="text-sm font-medium">图形验证码</label>
                <div className="flex gap-2">
                  <Input
                    value={captchaCode}
                    onChange={(e) => setCaptchaCode(e.target.value)}
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
              {loading ? '登录中...' : '登录'}
            </Button>
            <div className="text-center text-sm">
              <Link to="/register" className="text-primary hover:underline">没有账号？去注册</Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
