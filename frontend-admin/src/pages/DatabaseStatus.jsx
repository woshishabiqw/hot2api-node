import { useEffect, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Input } from '../components/Input';
import { showAlert, showConfirm } from '../components/Dialog';
import { cn } from '../lib/utils';
import { Database, RefreshCw, CheckCircle, XCircle, AlertCircle, Settings, Wifi, WifiOff, AlertTriangle, X } from 'lucide-react';

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

export default function DatabaseStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
  };

  // 延迟格式化函数
  const formatLatency = (nanoseconds) => {
    if (nanoseconds === null || nanoseconds === undefined) return 'N/A';
    
    if (nanoseconds < 1000) {
      // 纳秒
      return `${Math.round(nanoseconds)} ns`;
    } else if (nanoseconds < 1000000) {
      // 微秒
      return `${(nanoseconds / 1000).toFixed(1)} μs`;
    } else {
      // 毫秒
      return `${(nanoseconds / 1000000).toFixed(2)} ms`;
    }
  };

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadStatus = async () => {
    try {
      const res = await api.get('/admin/database/status');
      setStatus(res.data);
    } catch (e) {
      console.error('[DatabaseStatus] Failed to load status:', e);
      showToast('加载数据库状态失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleReconnectRedis = async () => {
    setReconnecting(true);
    try {
      await api.post('/admin/database/redis/reconnect');
      showToast('Redis 重连成功');
      await loadStatus();
    } catch (e) {
      console.error('[DatabaseStatus] Failed to reconnect Redis:', e);
      showToast('Redis 重连失败：' + (e.response?.data?.error || e.message), 'error');
    } finally {
      setReconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">数据库状态</h1>
        <Button onClick={loadStatus} variant="outline" size="sm">
          <RefreshCw className="w-4 h-4 mr-2" />
          刷新
        </Button>
      </div>

      {/* PostgreSQL 状态 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            PostgreSQL
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {status?.postgresql?.connected ? (
                  <CheckCircle className="w-5 h-5 text-emerald-500" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-500" />
                )}
                <span className="font-medium">连接状态</span>
              </div>
              <Badge variant={status?.postgresql?.connected ? 'success' : 'destructive'}>
                {status?.postgresql?.connected ? '已连接' : '未连接'}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">适配器</div>
                <div className="font-medium">{status?.postgresql?.adapter || 'N/A'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">错误信息</div>
                <div className="font-medium text-red-500">{status?.postgresql?.error || '无'}</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Redis 状态 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {status?.redis?.connected ? (
              <Wifi className="w-5 h-5 text-emerald-500" />
            ) : (
              <WifiOff className="w-5 h-5 text-red-500" />
            )}
            Redis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {status?.redis?.connected ? (
                  <CheckCircle className="w-5 h-5 text-emerald-500" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-500" />
                )}
                <span className="font-medium">连接状态</span>
              </div>
              <Badge variant={status?.redis?.connected ? 'success' : 'destructive'}>
                {status?.redis?.connected ? '已连接' : '未连接'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {status?.redis?.ready ? (
                  <CheckCircle className="w-5 h-5 text-emerald-500" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                )}
                <span className="font-medium">就绪状态</span>
              </div>
              <Badge variant={status?.redis?.ready ? 'success' : 'secondary'}>
                {status?.redis?.ready ? '就绪' : '未就绪'}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">连接地址</div>
                <div className="font-medium">{status?.redis?.url || 'N/A'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">数据库</div>
                <div className="font-medium">{status?.redis?.config?.database !== undefined ? status?.redis?.config?.database : 'N/A'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">启用状态</div>
                <div className="font-medium">{status?.redis?.config?.enabled ? '启用' : '禁用'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">键前缀</div>
                <div className="font-medium">{status?.redis?.config?.keyPrefix !== undefined ? status?.redis?.config?.keyPrefix : 'N/A'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">延迟</div>
                <div className="font-medium">{formatLatency(status?.redis?.latency)}</div>
              </div>
            </div>
            <Button
              onClick={handleReconnectRedis}
              disabled={reconnecting}
              variant="outline"
              size="sm"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${reconnecting ? 'animate-spin' : ''}`} />
              {reconnecting ? '重连中...' : '重新连接'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 缓存状态 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            缓存服务
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {status?.cache?.useRedis ? (
                  <Wifi className="w-5 h-5 text-emerald-500" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                )}
                <span className="font-medium">缓存模式</span>
              </div>
              <Badge variant={status?.cache?.useRedis ? 'success' : 'secondary'}>
                {status?.cache?.useRedis ? 'Redis' : '内存缓存'}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Redis 连接</div>
                <div className="font-medium">{status?.cache?.redisConnected ? '已连接' : '未连接'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">内存缓存大小</div>
                <div className="font-medium">{status?.cache?.memoryCacheSize || 0} 项</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 配置说明 */}
      <Card className="border-dashed">
        <CardContent className="pt-6">
          <div className="text-sm text-muted-foreground space-y-2">
            <p><strong>配置文件位置：</strong> backend/config/redis.json</p>
            <p><strong>实时生效：</strong> 修改配置文件后自动重新连接，无需重启服务</p>
            <p><strong>配置格式：</strong></p>
            <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
{`{
  "url": "redis://localhost:6379",
  "enabled": true,
  "database": 0,
  "keyPrefix": "traa:",
  "maxRetries": 3,
  "retryDelay": 1000
}`}
            </pre>
          </div>
        </CardContent>
      </Card>

      <InitDatabaseCard />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function InitDatabaseCard() {
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState('');
  const [initing, setIniting] = useState(false);

  const handleInit = async () => {
    if (pin.length !== 6) {
      showAlert('请输入6位安全密码');
      return;
    }
    const ok = await showConfirm('确认初始化数据库？这将重置所有表结构并保留默认数据。');
    if (!ok) return;
    setIniting(true);
    try {
      await api.post('/admin/init-database', { pin });
      showAlert('数据库初始化成功');
      setShowPin(false);
      setPin('');
    } catch (err) {
      showAlert(err.response?.data?.error || '初始化失败');
    } finally {
      setIniting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="w-5 h-5" />
          危险操作
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between p-4 border rounded-lg border-destructive/30">
          <div>
            <div className="font-medium">初始化数据库</div>
            <div className="text-sm text-muted-foreground">
              重置所有表结构并重新创建默认数据（管理员、默认分组、计费计划等）
            </div>
          </div>
          <Button variant="destructive" onClick={() => setShowPin(true)} disabled={initing}>
            <Database className="w-4 h-4 mr-2" />
            {initing ? '初始化中...' : '初始化'}
          </Button>
        </div>

        {showPin && (
          <div className="mt-4 p-4 border rounded-lg bg-muted/30 space-y-3">
            <div className="text-sm font-medium">请输入6位安全密码</div>
            <Input
              type="password"
              maxLength={6}
              placeholder="安全密码"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-48"
            />
            <div className="flex gap-2">
              <Button onClick={handleInit} disabled={initing || pin.length !== 6}>
                确认
              </Button>
              <Button variant="outline" onClick={() => { setShowPin(false); setPin(''); }}>
                取消
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
