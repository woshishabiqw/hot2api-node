import { useState, useEffect, useRef, useCallback } from 'react';
import { Shield, Lock, Loader2, X } from 'lucide-react';
import { Button } from './Button';
import api from '../lib/api';
import { setRequestSecondAuth } from '../lib/second-auth-request';


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
        // 焦点由 disabled effect 在 loading 复位后自动处理，避免双重 focus 导致输入框闪烁/卡顿
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [error, length]);

  const handleChange = (index, value) => {
    if (disabled) return;
    if (!/^\d*$/.test(value)) return;
    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);

    if (value && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newDigits.every(d => d !== '')) {
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
    if (disabled) return;
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
      {error && <p className="text-sm text-destructive text-center max-w-xs">{error}</p>}
    </div>
  );
}

export default function SecondAuthDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [setupPin, setSetupPin] = useState('');
  const [setupStep, setSetupStep] = useState(1);
  const [confirmKey, setConfirmKey] = useState(0);
  const promiseRef = useRef(null);
  const openingRef = useRef(false);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setLoading(false);
    setError('');
    setSetupPin('');
    setSetupStep(1);
    setConfirmKey(v => v + 1);
    const deferred = promiseRef.current;
    promiseRef.current = null;
    if (deferred) {
      deferred.reject(new Error('二级认证已取消'));
    }
  }, []);

  const finish = useCallback((token) => {
    setDialog(null);
    setLoading(false);
    setError('');
    setSetupPin('');
    setSetupStep(1);
    setConfirmKey(v => v + 1);
    const deferred = promiseRef.current;
    promiseRef.current = null;
    if (deferred) {
      deferred.resolve(token);
    }
  }, []);

  const requestSecondAuthImpl = useCallback(async (options = {}) => {
    const existing = localStorage.getItem('second_auth_token');
    if (existing && !options.force) {
      return existing;
    }

    if (promiseRef.current) {
      return promiseRef.current.promise;
    }

    // Guard against race conditions where multiple callers enter here concurrently.
    if (openingRef.current) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (promiseRef.current) {
        return promiseRef.current.promise;
      }
    }
    openingRef.current = true;

    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    promiseRef.current = deferred;

    let mode = 'verify';
    try {
      const res = await api.get('/auth/second-password/status');
      if (res.data?.need_setup) {
        mode = 'setup';
      }
    } catch (err) {
      // 无法获取状态时按验证处理；如果用户尚未设置 PIN，验证接口会返回 need_setup，
      // 对话框会自动切换到设置模式。
      mode = 'verify';
    } finally {
      openingRef.current = false;
    }

    setDialog({ mode, reason: options.reason || '' });
    setLoading(false);
    setError('');
    setSetupPin('');
    setSetupStep(1);
    setConfirmKey(v => v + 1);

    return deferred.promise;
  }, []);

  useEffect(() => {
    setRequestSecondAuth(requestSecondAuthImpl);
    return () => {
      setRequestSecondAuth(() => Promise.reject(new Error('SecondAuthDialogProvider not mounted')));
      // If the provider is unmounted while a dialog is pending, reject the promise to unblock callers.
      if (promiseRef.current) {
        const deferred = promiseRef.current;
        promiseRef.current = null;
        openingRef.current = false;
        deferred.reject(new Error('SecondAuthDialogProvider unmounted'));
      }
    };
  }, [requestSecondAuthImpl]);

  const handleVerify = async (pin) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/auth/second-password/verify', { password: pin });
      if (res.data?.second_token) {
        localStorage.setItem('second_auth_token', res.data.second_token);
        finish(res.data.second_token);
      } else {
        setError(res.data?.error || '验证失败');
        setLoading(false);
      }
    } catch (err) {
      const msg = err.response?.data?.error || '验证失败';
      setError(msg);
      setLoading(false);
      if (err.response?.data?.need_setup) {
        setSetupPin('');
        setSetupStep(1);
        setConfirmKey(v => v + 1);
        setDialog(prev => prev ? { ...prev, mode: 'setup' } : prev);
      }
    }
  };

  const handleSetup = async (confirmPin) => {
    setLoading(true);
    setError('');

    if (!/^\d{6}$/.test(setupPin)) {
      setError('请输入6位数字PIN码');
      setLoading(false);
      return;
    }
    if (setupPin !== confirmPin) {
      setError('两次输入的PIN码不一致');
      setLoading(false);
      return;
    }

    try {
      const res = await api.post('/auth/second-password/setup', {
        password: setupPin,
        confirm_password: confirmPin
      });
      if (res.data?.second_token) {
        localStorage.setItem('second_auth_token', res.data.second_token);
        finish(res.data.second_token);
      } else {
        setError(res.data?.error || '设置失败');
        setLoading(false);
      }
    } catch (err) {
      const msg = err.response?.data?.error || '设置失败';
      setError(msg);
      setLoading(false);
    }
  };

  const startVerify = (
    <div className="w-full max-w-md space-y-6 p-1">
      <div className="text-center space-y-2">
        <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Lock className="w-6 h-6 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">二级认证</h2>
        <p className="text-sm text-muted-foreground">
          {dialog?.reason || '请输入6位数字二级密码以继续当前操作'}
        </p>
      </div>

      <PinInput
        length={6}
        onComplete={handleVerify}
        disabled={loading}
        error={error}
      />

      {loading && (
        <div className="flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}
    </div>
  );

  const startSetup = (
    <div className="w-full max-w-md space-y-6 p-1">
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
            disabled={loading}
            error={error}
          />
          <p className="text-center text-sm text-muted-foreground">输入6位数字PIN码</p>
        </div>
      ) : (
        <div className="space-y-4">
          <PinInput
            key={confirmKey}
            length={6}
            onComplete={(pin) => {
              if (pin === setupPin) {
                handleSetup(pin);
              } else {
                setError('两次输入的PIN码不一致');
                setConfirmKey(v => v + 1);
              }
            }}
            disabled={loading}
            error={error}
          />
          <p className="text-center text-sm text-muted-foreground">再次确认PIN码</p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={() => { setSetupStep(1); setSetupPin(''); setError(''); }} disabled={loading}>
              重新输入
            </Button>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}
    </div>
  );

  useEffect(() => {
    if (!dialog) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeDialog();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dialog, closeDialog]);

  return (
    <>
      {children}
      {dialog && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
        >
          <div className="relative bg-card border rounded-lg shadow-lg p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <button
              onClick={closeDialog}
              className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>

            {dialog.mode === 'setup' ? startSetup : startVerify}
          </div>
        </div>
      )}
    </>
  );
}
