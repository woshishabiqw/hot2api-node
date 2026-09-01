import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Loader2, Save, Users, Settings } from 'lucide-react';
import { AlertCircle, CheckCircle, X } from 'lucide-react';
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

export default function UsersNewConfig() {
  const [config, setConfig] = useState({
    tpm: 10000000,
    rpm: 100,
    tpd: 1000000000,
    max_concurrent: 100
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => setToast({ message, type });

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/users/defaults');
      const data = res.data || {};
      setConfig({
        tpm: data.tpm ?? 10000000,
        rpm: data.rpm ?? 100,
        tpd: data.tpd ?? 1000000000,
        max_concurrent: data.max_concurrent ?? 100
      });
    } catch (e) {
      showToast('加载配置失败', 'error');
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/admin/users/defaults', {
        tpm: parseInt(config.tpm, 10) || 0,
        rpm: parseInt(config.rpm, 10) || 0,
        tpd: parseInt(config.tpd, 10) || 0,
        max_concurrent: parseInt(config.max_concurrent, 10) || 100
      });
      showToast('新用户默认配置已保存');
    } catch (e) {
      showToast(e.response?.data?.error || '保存失败', 'error');
    }
    setSaving(false);
  };

  const handleChange = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="w-6 h-6 text-primary" />
          新用户配置
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          配置新建用户 / Key / 模型时的默认限额与并发参数
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="w-4 h-4 text-primary" />
            默认配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium">TPM（每分钟 Tokens，默认 10,000,000）</label>
                  <Input
                    type="number"
                    min="0"
                    value={config.tpm}
                    onChange={e => handleChange('tpm', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">0 表示无限制</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">RPM（每分钟请求数，默认 100）</label>
                  <Input
                    type="number"
                    min="0"
                    value={config.rpm}
                    onChange={e => handleChange('rpm', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">0 表示无限制</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">TPD（每日 Tokens，默认 10,000,000）</label>
                  <Input
                    type="number"
                    min="0"
                    value={config.tpd}
                    onChange={e => handleChange('tpd', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">0 表示无限制</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">默认并发数（默认 100）</label>
                  <Input
                    type="number"
                    min="0"
                    value={config.max_concurrent}
                    onChange={e => handleChange('max_concurrent', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">源站管理-模型管理的默认并发已迁移至此</p>
                </div>
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
    </div>
  );
}
