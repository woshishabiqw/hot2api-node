import { useState, useEffect, useRef, useCallback } from 'react';
import { Shield, Lock, Loader2 } from 'lucide-react';
import { Button } from './Button';
import api from '../lib/api';

// PIN digit input component
function PinInput({ length = 6, onComplete, disabled = false, error = '' }) {
  const [digits, setDigits] = useState(Array(length).fill(''));
  const inputRefs = useRef([]);

  useEffect(() => {
    if (!disabled && inputRefs.current[0]) {
      inputRefs.current[0].focus();
    }
  }, [disabled]);

  const handleChange = (index, value) => {
    if (!/^\d*$/.test(value)) return;
    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);

    if (value && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newDigits.every(d => d !== '') && newDigits[length - 1] !== '') {
      onComplete(newDigits.join(''));
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const nonDigit = /\D/g;
    const pasted = e.clipboardData.getData('text').replace(nonDigit, '').slice(0, length);
    if (!pasted) return;
    const newDigits = [...digits];
    for (let i = 0; i < pasted.length && i < length; i++) {
      newDigits[i] = pasted[i];
    }
    setDigits(newDigits);
    const focusIndex = Math.min(pasted.length, length - 1);
    inputRefs.current[focusIndex]?.focus();

    if (newDigits.every(d => d !== '')) {
      onComplete(newDigits.join(''));
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-2">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={el => { inputRefs.current[i] = el; }}
            type="password"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            disabled={disabled}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            className="w-12 h-14 text-center text-2xl font-bold rounded-lg border-2 border-input bg-background focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all disabled:opacity-50"
            autoComplete="off"
          />
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export default function SecondAuthGate({ children }) {
  const [status, setStatus] = useState('loading'); // loading, setup, verify, verified
  const [error, setError] = useState('');
  const [setupPin, setSetupPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [setupStep, setSetupStep] = useState(1);

  const checkStatus = useCallback(async () => {
    const secondToken = localStorage.getItem('second_auth_token');
    if (secondToken) {
      // Verify token is still valid by calling a lightweight endpoint
      // We'll let the API interceptor handle 401s, but here we just
      // assume it's valid and let API calls validate it
      setStatus('verified');
      return;
    }

    try {
      const res = await api.get('/auth/second-password/status');
      if (res.data?.need_setup) {
        setStatus('setup');
      } else {
        setStatus('verify');
      }
    } catch (err) {
      if (err.response?.status === 401) {
        // Main auth expired
        localStorage.removeItem('token');
        localStorage.removeItem('second_auth_token');
        window.location.href = '/login';
      } else {
        setStatus('verify');
      }
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Silent renewal: refresh second auth token every 10 minutes
  useEffect(() => {
    if (status !== 'verified') return;
    const interval = setInterval(() => {
      const secondToken = localStorage.getItem('second_auth_token');
      if (!secondToken) return;
      api.post('/auth/second-password/refresh', {}, {
        headers: { 'X-Second-Auth-Token': secondToken }
      }).then((res) => {
        if (res.data?.second_token) {
          localStorage.setItem('second_auth_token', res.data?.second_token);
        }
      }).catch(() => {
        // Refresh failed (e.g., token expired or reset) - let next API call trigger re-auth
      });
    }, 10 * 60 * 1000); // 10 minutes
    return () => clearInterval(interval);
  }, [status]);

  // Listen for 401 SECOND_AUTH_REQUIRED from API
  useEffect(() => {
    const interceptor = api.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          const code = error.response?.data?.code;
          if (code === 'SECOND_AUTH_REQUIRED' || code === 'SECOND_AUTH_EXPIRED' || code === 'SECOND_AUTH_INVALID' || code === 'SECOND_AUTH_RESET') {
            localStorage.removeItem('second_auth_token');
            setStatus('verify');
            setError('二级认证已过期，请重新输入');
          }
        }
        return Promise.reject(error);
      }
    );
    return () => {
      api.interceptors.response.eject(interceptor);
    };
  }, []);

  const handleVerify = async (pin) => {
    setError('');
    try {
      const res = await api.post('/auth/second-password/verify', { password: pin });
      if (res.data?.second_token) {
        localStorage.setItem('second_auth_token', res.data?.second_token);
        setStatus('verified');
      }
    } catch (err) {
      const msg = err.response?.data?.error || '验证失败';
      setError(msg);
      if (err.response?.data?.need_setup) {
        setStatus('setup');
      }
    }
  };

  const handleSetup = async () => {
    setError('');
    if (setupPin.length !== 6 || !/^\d{6}$/.test(setupPin)) {
      setError('请输入6位数字PIN码');
      return;
    }
    if (setupPin !== confirmPin) {
      setError('两次输入的PIN码不一致');
      return;
    }

    try {
      const res = await api.post('/auth/second-password/setup', {
        password: setupPin,
        confirm_password: confirmPin
      });
      if (res.data?.second_token) {
        localStorage.setItem('second_auth_token', res.data?.second_token);
        setStatus('verified');
      }
    } catch (err) {
      const msg = err.response?.data?.error || '设置失败';
      setError(msg);
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (status === 'verified') {
    return children;
  }

  if (status === 'setup') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Shield className="w-6 h-6 text-primary" />
            </div>
            <h2 className="text-2xl font-bold">设置二级密码</h2>
            <p className="text-sm text-muted-foreground">
              为了保障后台安全，请设置6位数字二级密码（PIN）
            </p>
          </div>

          {setupStep === 1 ? (
            <div className="space-y-4">
              <PinInput
                length={6}
                onComplete={(pin) => { setSetupPin(pin); setSetupStep(2); setError(''); }}
                error={error}
              />
              <p className="text-center text-sm text-muted-foreground">输入6位数字PIN码</p>
            </div>
          ) : (
            <div className="space-y-4">
              <PinInput
                length={6}
                onComplete={(pin) => setConfirmPin(pin)}
                error={error}
              />
              <p className="text-center text-sm text-muted-foreground">再次确认PIN码</p>
              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={() => { setSetupStep(1); setSetupPin(''); setConfirmPin(''); setError(''); }}>
                  重新输入
                </Button>
                <Button onClick={handleSetup} disabled={confirmPin.length !== 6}>
                  确认设置
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // verify
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-2xl font-bold">二级认证</h2>
          <p className="text-sm text-muted-foreground">
            请输入6位数字二级密码以进入管理后台
          </p>
        </div>

        <PinInput
          length={6}
          onComplete={handleVerify}
          error={error}
        />

        <p className="text-center text-xs text-muted-foreground">
          如果忘记二级密码，请联系系统管理员重置
        </p>
      </div>
    </div>
  );
}
