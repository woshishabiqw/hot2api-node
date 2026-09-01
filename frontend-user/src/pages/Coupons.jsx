import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../lib/api';
import { fmtMoney, cn } from '../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Ticket, Loader2, RefreshCw } from 'lucide-react';

const statusTabs = [
  { key: '', label: '全部' },
  { key: 'unused', label: '未使用' },
  { key: 'used', label: '已使用' },
  { key: 'expired', label: '已过期' },
  { key: 'cancelled', label: '已失效' },
];

const statusBadgeVariant = (status) => {
  switch (status) {
    case 'unused': return 'success';
    case 'used': return 'secondary';
    case 'expired': return 'warning';
    case 'cancelled': return 'destructive';
    default: return 'outline';
  }
};

const statusLabel = (status) => {
  switch (status) {
    case 'unused': return '未使用';
    case 'used': return '已使用';
    case 'expired': return '已过期';
    case 'cancelled': return '已失效';
    default: return status;
  }
};

const typeLabel = (type) => {
  if (type === 'percentage') return '百分比折扣';
  return '满减券';
};

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function CouponsPage() {
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const fetchCoupons = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter && filter !== 'expired') params.status = filter;
      const res = await api.get('/billing/my-coupons/all', { params });
      let list = res.data?.coupons || [];
      if (filter === 'expired') {
        list = list.filter(c => c.effective_status === 'expired');
      }
      setCoupons(list);
    } catch (e) {
      console.error('Failed to fetch coupons:', e);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchCoupons();
  }, [fetchCoupons]);

  const filteredCoupons = useMemo(() => {
    return coupons;
  }, [coupons]);

  const discountText = (c) => {
    if (c.type === 'percentage') {
      return `${Math.round((1 - (c.discount_rate || 0)) * 100)} 折`;
    }
    return `减 ¥${fmtMoney(c.discount_amount)}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Ticket className="w-8 h-8" />
            我的优惠券
          </h1>
          <p className="text-sm text-muted-foreground mt-1">查看已领取的优惠券与使用记录</p>
        </div>
        <Button variant="outline" onClick={fetchCoupons} disabled={loading}>
          <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {statusTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={cn(
              "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
              filter === tab.key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-input hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && filteredCoupons.length === 0 && (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && filteredCoupons.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            暂无符合条件的优惠券
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filteredCoupons.map((c) => (
          <Card key={c.id} className={cn("overflow-hidden", c.effective_status !== 'unused' && "opacity-70")}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <CardTitle className="text-base font-semibold">{c.name}</CardTitle>
                <Badge variant={statusBadgeVariant(c.effective_status)}>
                  {statusLabel(c.effective_status)}
                </Badge>
              </div>
              {c.description && <p className="text-xs text-muted-foreground mt-1">{c.description}</p>}
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-primary">{discountText(c)}</span>
                <span className="text-xs text-muted-foreground">{typeLabel(c.type)}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                满 ¥{fmtMoney(c.threshold)} 可用
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {c.valid_start && <span>生效 {formatDate(c.valid_start)}</span>}
                {c.valid_end && <span>截止 {formatDate(c.valid_end)}</span>}
                {c.expires_at && <span>过期 {formatDate(c.expires_at)}</span>}
              </div>
              {c.used_at && <div className="text-xs text-muted-foreground">使用时间 {formatDate(c.used_at)}</div>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
