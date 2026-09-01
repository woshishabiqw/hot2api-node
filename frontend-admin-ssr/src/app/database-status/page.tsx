'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/Card';
import { Button } from '@/components/Button';
import { Badge } from '@/components/Badge';
import { Database, RefreshCw, CheckCircle, XCircle, AlertCircle, Settings, Wifi, WifiOff } from 'lucide-react';

export default function DatabaseStatus() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);

  // 延迟格式化函数
  const formatLatency = (nanoseconds: number | null | undefined) => {
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
    } finally {
      setLoading(false);
    }
  };

  const handleReconnectRedis = async () => {
    setReconnecting(true);
    try {
      await api.post('/admin/database/redis/reconnect');
      await loadStatus();
    } catch (e) {
      console.error('[DatabaseStatus] Failed to reconnect Redis:', e);
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
    </div>
  );
}
