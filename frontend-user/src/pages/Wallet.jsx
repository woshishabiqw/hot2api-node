import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../lib/api';
import { fmtMoney, cn, formatAmountInput } from '../lib/utils';
import { useAuth } from '../hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import QRCode from 'qrcode';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import SearchableSelect from '../components/SearchableSelect';
import {
  Wallet,
  CreditCard,
  History,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  X,
  Loader2,
  QrCode,
  ShoppingCart,
  Download,
  Receipt,
  FileText,
  Check,
  Clock,
  ExternalLink,
  Shield
} from 'lucide-react';

function Toast({ message, type, onClose }) {
  const [exiting, setExiting] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const timer = setTimeout(() => setExiting(true), 4000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => onCloseRef.current(), 300);
    return () => clearTimeout(timer);
  }, [exiting]);

  const handleClose = () => setExiting(true);

  return (
    <div
      className={cn(
        "fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium",
        exiting ? 'animate-toast-slide-out-right' : 'animate-toast-slide-in-right',
        type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
      )}
    >
      {type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
      {message}
      <button onClick={handleClose} className="ml-2 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}

function InvoiceProcessingModal({ open }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <style>{`
        @keyframes invoice-load {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(0%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
      <div className="bg-background rounded-xl shadow-2xl border w-full max-w-sm p-6 text-center space-y-4">
        <div className="flex justify-center">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
        </div>
        <h2 className="text-lg font-semibold">发票开具中</h2>
        <p className="text-sm text-muted-foreground">正在连接税务数字系统，请稍候…</p>
        <div className="h-2 w-full bg-muted rounded-full overflow-hidden relative">
          <div
            className="absolute inset-y-0 left-0 w-1/2 bg-primary rounded-full"
            style={{ animation: 'invoice-load 2.5s ease-in-out infinite' }}
          />
        </div>
        <p className="text-xs text-muted-foreground">预计等待 3 ~ 5 秒</p>
      </div>
    </div>
  );
}

function normalizePaymentUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) return url;
  // Backend returns paths relative to its internal mount (e.g. /billing/pay-mock).
  // In production nginx exposes the API under /api, so prefix relative paths.
  return `/api${url.startsWith('/') ? '' : '/'}${url}`;
}

function getInvoiceToastMessage(invoice) {
  if (invoice.status === 'issued' && invoice.invoice_no) {
    return `订单 #${invoice.order_id} 开票成功：${invoice.invoice_no}`;
  }
  if (invoice.review_status === 'pending' || invoice.status === 'pending') {
    return `订单 #${invoice.order_id} 开票申请已提交，等待审核通过`;
  }
  return `订单 #${invoice.order_id} 开票申请已提交`;
}

const statusBadgeVariant = (status) => {
  switch (status) {
    case 'paid': return 'success';
    case 'pending': return 'secondary';
    case 'failed': return 'destructive';
    case 'expired': return 'destructive';
    case 'cancelled':
    case 'closed':
    case 'refunded': return 'outline';
    default: return 'secondary';
  }
};

function formatInvoiceExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function hoursUntilInvoiceExpiry(iso) {
  if (!iso) return Infinity;
  return (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60);
}

const SUPPORTED_CHANNELS = [
  { type: 'alipay', label: '支付宝' },
  { type: 'wechat', label: '微信支付' },
  { type: 'stripe', label: 'Stripe' },
];

export default function WalletPage() {
  const { token } = useAuth();
  const [workspaces, setWorkspaces] = useState([]);
  const [channels, setChannels] = useState([]);
  const [selectedWs, setSelectedWs] = useState(null);
  const [billingRecords, setBillingRecords] = useState([]);
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [qrUrl, setQrUrl] = useState(null);
  const [pendingOrderId, setPendingOrderId] = useState(null);
  const [qrToken, setQrToken] = useState(null);
  const [qrExpireAt, setQrExpireAt] = useState(null);
  const [qrCountdown, setQrCountdown] = useState(null);
  const [paymentForm, setPaymentForm] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [cancelLoadingId, setCancelLoadingId] = useState(null);
  const [cancelModalOrder, setCancelModalOrder] = useState(null);
  const [orderSort, setOrderSort] = useState('id_desc');
  const [orderPage, setOrderPage] = useState(1);
  const [orderStatusFilter, setOrderStatusFilter] = useState('');
  const [orderTotal, setOrderTotal] = useState(0);
  const [orderTotalPages, setOrderTotalPages] = useState(1);
  const [selectedOrderIds, setSelectedOrderIds] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [invoiceProcessing, setInvoiceProcessing] = useState(false);
  const [userBalance, setUserBalance] = useState(0);
  const [rejectReasonModal, setRejectReasonModal] = useState(null);
  const [rechargeTarget, setRechargeTarget] = useState('account'); // 'account' = 用户独立余额, 'workspace' = Workspace 余额
  const [coupons, setCoupons] = useState([]);
  const [selectedCoupon, setSelectedCoupon] = useState(null);
  const [showCouponModal, setShowCouponModal] = useState(false);
  const [couponsLoading, setCouponsLoading] = useState(false);
  const [pendingStreamOrders, setPendingStreamOrders] = useState([]); // SSE pending orders with countdown
  const [orderCountdowns, setOrderCountdowns] = useState({}); // Local per-order countdowns
  const ORDER_PAGE_SIZE = 30;

  const showToast = (message, type = 'success') => setToast({ message, type });
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  // Validate a backend response before displaying a QR code modal.
  // Prevents showing a QR code when the order is missing, expired, or invalid.
  const isValidQrResponse = (data) => {
    if (!data || typeof data !== 'object') return { valid: false, reason: '响应数据为空' };
    if (!data.id || !Number.isFinite(Number(data.id))) return { valid: false, reason: '订单 ID 无效' };
    if (data.status !== 'pending') return { valid: false, reason: `订单状态为 ${data.status || '未知'}，无法支付` };
    const qr = data.qrDataUrl || data.qr_data_url;
    if (!qr || typeof qr !== 'string' || !qr.startsWith('data:image')) return { valid: false, reason: '二维码数据无效' };
    return { valid: true };
  };

  const clearQrState = () => {
    setQrUrl(null);
    setPendingOrderId(null);
    setQrToken(null);
    setQrExpireAt(null);
    setPaymentForm(null);
  };

  // Compute remaining seconds for a pending order based on SSE data
  const getCountdown = (expiresAt) => {
    if (!expiresAt) return null;
    const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    return remaining;
  };

  const formatCountdown = (seconds) => {
    if (seconds === null || seconds === undefined) return '';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const fetchWorkspaces = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/workspaces');
      const list = res.data || [];
      setWorkspaces(list);
      setSelectedWs(prev => {
        if (prev) {
          const updated = list.find(w => w.id === prev.id);
          if (updated && updated.balance !== prev.balance) return updated;
          return prev;
        }
        return list.length > 0 ? list[0] : prev;
      });
    } catch (e) {
      showToast('获取 Workspace 失败', 'error');
    }
    setLoading(false);
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await api.get('/payment-gateway/payment-channels');
      setChannels((res.data || []).filter(c => c.is_active));
    } catch (e) {
      console.error('Failed to fetch channels:', e);
    }
  }, []);

  const fetchBillingRecords = useCallback(async (workspaceId) => {
    if (!workspaceId) return;
    try {
      const res = await api.get(`/workspaces/${workspaceId}/billing`);
      setBillingRecords(res.data.records || []);
    } catch (e) {
      console.error('Failed to fetch billing records:', e);
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    try {
      const res = await api.get('/billing/invoices?limit=1000');
      setInvoices(res.data?.invoices || []);
    } catch (e) {
      console.error('Failed to fetch invoices:', e);
    }
  }, []);

  const fetchUserBalance = useCallback(async () => {
    try {
      const res = await api.get('/billing/user-balance');
      setUserBalance(res.data?.balance || 0);
    } catch (e) {
      console.error('Failed to fetch user balance:', e);
    }
  }, []);

  const fetchCoupons = useCallback(async (filterAmount) => {
    setCouponsLoading(true);
    try {
      const params = {};
      if (!Number.isNaN(parseFloat(filterAmount)) && filterAmount !== '') params.amount = parseFloat(filterAmount);
      const res = await api.get('/billing/my-coupons', { params });
      setCoupons(res.data?.coupons || []);
    } catch (e) {
      console.error('Failed to fetch coupons:', e);
    }
    setCouponsLoading(false);
  }, []);

  const openCouponModal = () => {
    fetchCoupons(amount);
    setShowCouponModal(true);
  };

  const selectCoupon = (coupon) => {
    setSelectedCoupon(coupon);
    setShowCouponModal(false);
  };

  const clearCoupon = () => {
    setSelectedCoupon(null);
  };

  const payableAmount = useMemo(() => {
    const value = parseFloat(amount);
    if (Number.isNaN(value)) return null;
    if (!selectedCoupon) return value;
    const threshold = selectedCoupon.threshold || 0;
    if (value < threshold) return value;
    let discount = 0;
    if (selectedCoupon.type === 'percentage') {
      discount = value * (selectedCoupon.discount_rate || 0);
    } else {
      discount = Math.min(selectedCoupon.discount_amount || 0, value);
    }
    discount = Math.round(discount * 100) / 100;
    return Math.max(0, Math.round((value - discount) * 100) / 100);
  }, [amount, selectedCoupon]);

  useEffect(() => {
    // Re-validate selected coupon when amount changes
    if (!selectedCoupon) return;
    const value = parseFloat(amount);
    if (Number.isNaN(value)) {
      setSelectedCoupon(null);
      return;
    }
    const threshold = selectedCoupon.threshold || 0;
    if (value < threshold) {
      setSelectedCoupon(null);
    }
  }, [amount]);

  const fetchOrders = useCallback(async (page = orderPage, sort = orderSort, status = orderStatusFilter) => {
    setOrdersLoading(true);
    try {
      const params = {
        limit: ORDER_PAGE_SIZE,
        page,
        sort,
      };
      if (status) params.status = status;
      const res = await api.get('/billing/orders', { params });
      setOrders(res.data?.orders || []);
      setOrderTotal(res.data?.total || 0);
      setOrderTotalPages(res.data?.totalPages || 1);
      setOrderPage(res.data?.page || page);
    } catch (e) {
      console.error('Failed to fetch orders:', e);
      showToast('获取订单记录失败', 'error');
    }
    setOrdersLoading(false);
  }, [orderPage, orderSort, orderStatusFilter]);

  const toggleSelectOrder = (id) => {
    setSelectedOrderIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleSelectAll = () => {
    if (selectedOrderIds.length === orders.length) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(orders.map(o => o.id));
    }
  };

  const withInvoiceDelay = async (fn) => {
    setInvoiceProcessing(true);
    const delay = 3000 + Math.floor(Math.random() * 2000);
    await new Promise(r => setTimeout(r, delay));
    try {
      await fn();
    } finally {
      setInvoiceProcessing(false);
    }
  };

  const handleBatchCancel = async () => {
    const ids = selectedOrderIds.filter(id => orders.find(o => o.id === id)?.status === 'pending');
    if (ids.length === 0) return showToast('没有可取消的待支付订单', 'error');
    setBatchLoading(true);
    try {
      await api.post('/billing/orders/batch-cancel', { ids });
      showToast(`已取消 ${ids.length} 个订单`);
      setSelectedOrderIds([]);
      fetchOrders();
      fetchInvoices();
    } catch (e) {
      showToast(e.response?.data?.error || '批量取消失败', 'error');
    }
    setBatchLoading(false);
  };

  const handleBatchInvoice = async () => {
    const ids = selectedOrderIds.filter(id => orders.find(o => o.id === id)?.status === 'paid');
    if (ids.length === 0) return showToast('请选择已支付订单进行开票', 'error');
    setBatchLoading(true);
    try {
      await withInvoiceDelay(async () => {
        const res = await api.post('/billing/orders/batch-invoice', { ids });
        const ok = res.data.results.filter(r => r.success).length;
        showToast(`成功提交 ${ok} / ${ids.length} 个开票申请（审核通过后生成文件）`);
      });
      setSelectedOrderIds([]);
      fetchInvoices();
    } catch (e) {
      showToast(e.response?.data?.error || '批量开票失败', 'error');
    }
    setBatchLoading(false);
  };

  const handleInvoiceOrder = async (order) => {
    try {
      await withInvoiceDelay(async () => {
        const res = await api.post(`/billing/orders/${order.id}/invoice`);
        showToast(getInvoiceToastMessage(res.data.invoice));
      });
      fetchInvoices();
    } catch (e) {
      showToast(e.response?.data?.error || '开票失败', 'error');
    }
  };

  const handleDownloadInvoice = (inv) => {
    if (!inv.invoice_url) return showToast('发票文件未生成', 'error');
    if (inv.status === 'removed') return showToast('发票文件已过期', 'error');
    const liveToken = localStorage.getItem('token') || token;
    window.open('/api' + inv.invoice_url + '?token=' + encodeURIComponent(liveToken), '_blank');
  };

  const getInvoiceForOrder = (orderId) => invoices.find(inv => inv.order_id === orderId);

  // Handle Stripe / payment callback results on page load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    const tradeNo = params.get('trade_no');

    const checkReturnOrder = async () => {
      if (tradeNo) {
        try {
          const res = await api.get(`/billing/orders/by-trade-no/${tradeNo}`);
          const order = res.data;
          if (order.status === 'paid') {
            showToast(`订单 ${tradeNo} 充值成功`);
            fetchWorkspaces();
            fetchOrders();
            fetchUserBalance();
            if (selectedWs && selectedWs.id === order.workspace_id) fetchBillingRecords(order.workspace_id);
          } else if (['failed', 'cancelled', 'closed', 'expired'].includes(order.status)) {
            showToast(`订单 ${tradeNo} 支付失败或已取消`, 'error');
            fetchOrders();
          } else if (order.status === 'pending') {
            // Start polling until payment is confirmed
            setPendingOrderId(order.id);
            showToast('正在确认支付结果…', 'success');
            fetchOrders();
          }
        } catch (e) {
          console.error('Failed to check return order:', e);
          if (payment === 'success') {
            showToast(tradeNo ? `订单 ${tradeNo} 充值成功` : '充值成功');
            fetchWorkspaces();
            fetchOrders();
            fetchUserBalance();
          } else if (payment === 'cancelled' || payment === 'failed') {
            showToast(tradeNo ? `订单 ${tradeNo} 支付失败或已取消` : '支付失败或已取消', 'error');
            fetchOrders();
          }
        }
      } else {
        if (payment === 'success') {
          showToast('充值成功');
          fetchWorkspaces();
          fetchOrders();
          fetchUserBalance();
        } else if (payment === 'cancelled' || payment === 'failed') {
          showToast('支付失败或已取消', 'error');
          fetchOrders();
        }
      }
      // Clean query params without reload
      window.history.replaceState({}, document.title, window.location.pathname);
    };

    if (payment) {
      checkReturnOrder();
    }
  }, []);

  useEffect(() => {
    fetchWorkspaces();
    fetchChannels();
    fetchOrders();
    fetchInvoices();
    fetchUserBalance();
  }, [fetchWorkspaces, fetchChannels, fetchOrders, fetchInvoices, fetchUserBalance]);

  // SSE: real-time invoice status updates with auto reconnect
  useEffect(() => {
    if (!token) return;
    let es = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000;
    const connect = () => {
      es = new EventSource(`/api/billing/invoices/stream?token=${encodeURIComponent(token)}`);
      es.addEventListener('invoice:updated', () => { fetchInvoices(); });
      es.addEventListener('invoice:created', () => { fetchInvoices(); });
      es.onopen = () => { reconnectDelay = 2000; };
      es.onerror = () => {
        if (es) es.close();
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      };
    };
    connect();
    return () => {
      clearTimeout(reconnectTimer);
      if (es) es.close();
    };
  }, [token, fetchInvoices]);

  // Local countdown for pending orders (fallback when SSE is delayed/disconnected)
  useEffect(() => {
    const update = () => {
      const next = {};
      orders.forEach(order => {
        if (order.status === 'pending' && order.expires_at) {
          next[order.id] = getCountdown(order.expires_at);
        }
      });
      setOrderCountdowns(next);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [orders]);

  // SSE: real-time pending order countdowns with auto reconnect
  useEffect(() => {
    if (!token) return;
    let es = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000;
    const connect = () => {
      es = new EventSource(`/api/billing/orders/pending-stream?token=${encodeURIComponent(token)}`);
      es.addEventListener('pending:orders', (e) => {
        const data = JSON.parse(e.data);
        setPendingStreamOrders(data.orders || []);
      });
      es.addEventListener('pending:tick', (e) => {
        const data = JSON.parse(e.data);
        setPendingStreamOrders(data.orders || []);
        // If an order we were tracking disappeared (paid/cancelled/expired), refresh the list
        if (pendingStreamOrders.length > 0 && (data.orders || []).length < pendingStreamOrders.length) {
          fetchOrders();
        }
      });
      es.onopen = () => { reconnectDelay = 2000; };
      es.onerror = () => {
        if (es) es.close();
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      };
    };
    connect();
    return () => {
      clearTimeout(reconnectTimer);
      if (es) es.close();
    };
  }, [token, fetchOrders]);

  useEffect(() => {
    if (selectedWs) {
      fetchBillingRecords(selectedWs.id);
    } else {
      setBillingRecords([]);
    }
  }, [selectedWs, fetchBillingRecords]);

  useEffect(() => {
    if (!pendingOrderId) return;

    const checkOrder = async () => {
      try {
        const params = qrToken ? { qr_token: qrToken } : {};
        const res = await api.get(`/billing/orders/${pendingOrderId}`, { params });
        const order = res.data;
        if (order.status === 'paid') {
          clearInterval(interval);
          setPendingOrderId(null);
          setQrUrl(null);
          setQrToken(null);
          setQrExpireAt(null);
          setPaymentForm(null);
          showToast('充值成功');
          fetchWorkspaces();
          fetchOrders();
          fetchUserBalance();
          if (selectedWs) fetchBillingRecords(selectedWs.id);
        } else if (['failed', 'cancelled', 'closed', 'expired'].includes(order.status)) {
          clearInterval(interval);
          setPendingOrderId(null);
          setQrUrl(null);
          setQrToken(null);
          setQrExpireAt(null);
          setPaymentForm(null);
          showToast('充值失败或已取消', 'error');
          fetchOrders();
        }
      } catch (e) {
        console.error('Failed to check order:', e);
      }
    };

    const interval = setInterval(checkOrder, 3000);
    return () => clearInterval(interval);
  }, [pendingOrderId, qrToken, selectedWs, fetchWorkspaces, fetchBillingRecords, fetchOrders, fetchUserBalance]);

  // QR code expiration countdown
  useEffect(() => {
    if (!qrExpireAt) {
      setQrCountdown(null);
      return;
    }
    const update = () => {
      const remaining = Math.max(0, Math.floor((new Date(qrExpireAt).getTime() - Date.now()) / 1000));
      setQrCountdown(remaining);
      if (remaining <= 0) {
        setPendingOrderId(null);
        setQrUrl(null);
        setQrToken(null);
        setQrExpireAt(null);
        setPaymentForm(null);
        showToastRef.current('二维码已过期，请重新发起充值', 'error');
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [qrExpireAt]);

  const handleRecharge = async () => {
    const value = parseFloat(amount);
    const minAmount = channel === 'stripe' ? 3.5 : 1;
    if (!amount || isNaN(value) || value < minAmount) {
      showToast(`充值金额最小为 ¥${minAmount.toFixed(2)}`, 'error');
      return;
    }
    if (value > 1000) {
      showToast('充值金额最大为 ¥1000.00', 'error');
      return;
    }
    // Enforce two decimal places
    const decimals = (amount.split('.')[1] || '').length;
    if (decimals > 2) {
      showToast('充值金额最多保留两位小数', 'error');
      return;
    }

    if (!channel) {
      showToast('请选择支付渠道', 'error');
      return;
    }
    if (rechargeTarget === 'workspace' && !selectedWs) {
      showToast('请选择工作空间', 'error');
      return;
    }

    setActionLoading(true);
    try {
      const returnUrl = window.location.origin + '/wallet';
      const payload = {
        amount: value,
        channel,
        payment_method: 'qrcode',
        return_url: returnUrl,
        target: rechargeTarget,
        coupon_id: selectedCoupon?.id || undefined,
      };
      if (rechargeTarget === 'workspace' && selectedWs) {
        payload.workspace_id = selectedWs.id;
      }

      const res = await api.post('/billing/recharge', payload);

      const data = res.data || {};
      const qr = data.qrDataUrl || data.qr_data_url;

      if (qr) {
        const validation = isValidQrResponse(data);
        if (!validation.valid) {
          showToast(validation.reason, 'error');
          setActionLoading(false);
          return;
        }
        setQrUrl(qr);
        setPendingOrderId(data.id);
        setQrToken(data.qr_token || null);
        setQrExpireAt(data.qr_expire_at || null);
        setPaymentForm(data.payment_form || data.form || null);
      } else if (channel === 'stripe' && (data.paymentUrl || data.payment_url)) {
        // Stripe: redirect current page to Stripe Checkout
        window.location.href = normalizePaymentUrl(data.paymentUrl || data.payment_url);
      } else if (data.paymentUrl || data.payment_url) {
        const url = normalizePaymentUrl(data.paymentUrl || data.payment_url);
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (!opened) {
          window.location.href = url;
        }
        if (data.id) {
          setPendingOrderId(data.id);
        }
        fetchOrders();
      } else if (data.form || data.payment_form) {
        document.body.innerHTML = data.form || data.payment_form;
        document.body.querySelector('form')?.submit();
      } else {
        showToast('充值请求已提交');
        fetchWorkspaces();
        fetchOrders();
        if (selectedWs) fetchBillingRecords(selectedWs.id);
      }
    } catch (e) {
      showToast(e.response?.data?.error || '充值失败', 'error');
    }
    setActionLoading(false);
  };

  const openCancelModal = (order) => setCancelModalOrder(order);
  const closeCancelModal = () => setCancelModalOrder(null);

  const confirmCancelOrder = async () => {
    if (!cancelModalOrder) return;
    setCancelLoadingId(cancelModalOrder.id);
    try {
      await api.post(`/billing/orders/${cancelModalOrder.id}/cancel`);
      showToast('订单已取消');
      fetchOrders();
      if (pendingOrderId === cancelModalOrder.id) {
        setPendingOrderId(null);
        setQrUrl(null);
      }
    } catch (e) {
      showToast(e.response?.data?.error || '取消失败', 'error');
    }
    setCancelLoadingId(null);
    setCancelModalOrder(null);
  };

  const handleCancelQr = () => {
    setQrUrl(null);
    setPendingOrderId(null);
    setQrToken(null);
    setQrExpireAt(null);
    setPaymentForm(null);
  };

  // Continue payment for an existing pending order (re-open QR modal / form)
  const continuePayment = async (order) => {
    try {
      setActionLoading(true);
      let metadata = {};
      try {
        metadata = JSON.parse(order.metadata || '{}');
      } catch { /* ignore */ }

      if (order.channel === 'alipay') {
        const res = await api.post(`/billing/orders/${order.id}/continue-pay`, {
          qr_token: metadata.qr_token
        });
        const data = res.data || {};

        if (data.use_qrcode) {
          const qrDataUrl = data.qrDataUrl || data.qr_data_url || await QRCode.toDataURL(data.qrCode || data.qr_code, { width: 300, margin: 2 });
          const validation = isValidQrResponse({ ...data, qrDataUrl, status: data.status || order.status });
          if (!validation.valid) {
            showToast(validation.reason, 'error');
            return;
          }
          setQrUrl(qrDataUrl);
          setPendingOrderId(order.id);
          setQrToken(data.qrToken || data.qr_token);
          setQrExpireAt(data.qrExpireAt || data.qr_expire_at);
          setPaymentForm(data.paymentForm || data.payment_form || null);
        } else if (data.paymentForm || data.payment_form || data.form) {
          const form = data.paymentForm || data.payment_form || data.form;
          document.body.innerHTML = form;
          document.body.querySelector('form')?.submit();
        } else {
          showToast('暂无可用支付方式', 'error');
        }
      } else {
        showToast('该渠道暂不支持继续支付', 'error');
      }
    } catch (e) {
      showToast(e.response?.data?.error || '继续支付失败', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleJumpToAlipay = () => {
    if (!paymentForm) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = paymentForm;
    const form = wrapper.querySelector('form');
    if (form) {
      form.setAttribute('target', '_blank');
      form.setAttribute('rel', 'noopener noreferrer');
      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);
    } else {
      const urlMatch = paymentForm.match(/action=["']([^"']+)["']/i);
      if (urlMatch && urlMatch[1]) {
        window.open(urlMatch[1], '_blank', 'noopener,noreferrer');
      }
    }
  };

  const selectedWorkspaceName = useMemo(() => {
    return workspaces.find(w => w.id === selectedWs?.id)?.name || selectedWs?.name || '';
  }, [workspaces, selectedWs]);

  // Find the active pending order for the currently selected recharge target
  // Prefer SSE stream, but fall back to the paginated orders list so the UI
  // still works when the SSE connection is delayed or disconnected.
  const currentPendingOrder = useMemo(() => {
    const fromStream = () => {
      if (rechargeTarget === 'workspace') {
        return pendingStreamOrders.find(o => o.workspace_id === selectedWs?.id);
      }
      return pendingStreamOrders.find(o => o.workspace_id === null || o.workspace_id === undefined);
    };
    const fromList = () => {
      if (rechargeTarget === 'workspace') {
        return orders.find(o => o.status === 'pending' && o.workspace_id === selectedWs?.id);
      }
      return orders.find(o => o.status === 'pending' && (o.workspace_id === null || o.workspace_id === undefined));
    };
    return fromStream() || fromList();
  }, [pendingStreamOrders, orders, rechargeTarget, selectedWs]);

  const currentPendingCountdown = currentPendingOrder ? getCountdown(currentPendingOrder.expires_at) : null;

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <InvoiceProcessingModal open={invoiceProcessing} />

      {/* Coupon Selection Modal */}
      {showCouponModal && (
        <>
          <div className="fixed inset-0 z-[140] bg-black/50" onClick={() => setShowCouponModal(false)} />
          <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 pointer-events-none">
            <div className="bg-card border shadow-2xl rounded-xl w-full max-w-md max-h-[80vh] flex flex-col pointer-events-auto">
              <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
                <h2 className="text-lg font-semibold">选择优惠券</h2>
                <button onClick={() => setShowCouponModal(false)} className="p-2 rounded-md hover:bg-muted transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {couponsLoading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                ) : coupons.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">暂无可用优惠券</div>
                ) : (
                  coupons.map((coupon) => (
                    <div
                      key={coupon.id}
                      onClick={() => coupon.applicable && selectCoupon(coupon)}
                      className={cn(
                        "rounded-lg border p-3 transition-colors",
                        coupon.applicable ? "cursor-pointer hover:border-primary hover:bg-primary/5" : "opacity-50 cursor-not-allowed"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{coupon.name}</div>
                        {coupon.applicable && <Badge variant="default">可用</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        满 ¥{coupon.threshold.toFixed(2)} 减 ¥{coupon.discount_amount.toFixed(2)}
                      </div>
                      {coupon.description && <div className="text-xs text-muted-foreground mt-1">{coupon.description}</div>}
                      {coupon.expires_at && (
                        <div className="text-xs text-muted-foreground mt-1">有效期至 {new Date(coupon.expires_at).toLocaleString('zh-CN')}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Wallet className="w-8 h-8" />
            我的钱包
          </h1>
          <p className="text-sm text-muted-foreground mt-1">管理 Workspace 余额、充值、计费与订单</p>
        </div>
        <Button variant="outline" onClick={() => { fetchWorkspaces(); fetchOrders(); fetchUserBalance(); }} disabled={loading || ordersLoading}>
          <RefreshCw className={cn("w-4 h-4 mr-2", (loading || ordersLoading) && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recharge */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-primary" />
              余额充值
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">充值类型</label>
              <div className="flex items-center gap-2 bg-muted/40 rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => setRechargeTarget('account')}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                    rechargeTarget === 'account' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  用户充值
                </button>
                <button
                  type="button"
                  onClick={() => setRechargeTarget('workspace')}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                    rechargeTarget === 'workspace' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  Workspace 充值
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                {rechargeTarget === 'account'
                  ? '充值金额进入当前用户的账户独立余额，无需依赖 Workspace'
                  : '充值金额进入所选 Workspace 的余额'}
              </p>
            </div>

            <div className="rounded-lg bg-primary/5 p-4 text-center ring-2 ring-primary transition-all">
              <div className="text-xs text-muted-foreground">
                {rechargeTarget === 'account' ? '账户独立余额' : `${selectedWs?.name || 'Workspace'} 余额`}
              </div>
              <div className="text-2xl font-bold text-primary mt-1">
                ¥{fmtMoney(rechargeTarget === 'account' ? userBalance : (selectedWs?.balance || 0))}
              </div>
            </div>

            {rechargeTarget === 'workspace' && (
              <SearchableSelect
                label="选择 Workspace"
                placeholder="搜索 Workspace 名称 / ID"
                options={workspaces}
                value={selectedWs?.id}
                onChange={ws => setSelectedWs(ws || null)}
                getValue={ws => ws.id}
                getLabel={ws => `${ws.name} (ID: ${ws.id})`}
                disabled={workspaces.length === 0}
              />
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">充值金额</label>
              <Input
                type="number"
                min={channel === 'stripe' ? '3.50' : '1.00'}
                max="1000"
                step="0.01"
                placeholder="100.00"
                value={amount}
                onChange={e => setAmount(formatAmountInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {channel === 'stripe'
                  ? 'Stripe 最低 ¥3.50，最高 ¥1000.00，最多两位小数'
                  : '支持 ¥1.00 ~ ¥1000.00，最多两位小数'}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">支付渠道</label>
              <select
                value={channel}
                onChange={e => setChannel(e.target.value)}
                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">{channels.length === 0 ? '暂无可用渠道' : '请选择'}</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.type}>
                    {ch.name} ({ch.env === 'production' ? '生产' : '沙盒'})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">优惠券</label>
                {selectedCoupon && (
                  <button onClick={clearCoupon} className="text-xs text-destructive hover:underline">清除</button>
                )}
              </div>
              {selectedCoupon ? (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <div className="font-medium">{selectedCoupon.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    满 ¥{selectedCoupon.threshold.toFixed(2)} 减 ¥{selectedCoupon.discount_amount.toFixed(2)}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">未选择优惠券</div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={openCouponModal}
                disabled={!amount || Number.isNaN(parseFloat(amount))}
              >
                {selectedCoupon ? '更换优惠券' : '选择优惠券'}
              </Button>
            </div>

            {payableAmount !== null && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                <div className="text-xs text-muted-foreground">需支付金额</div>
                <div className="text-xl font-bold text-primary">¥{fmtMoney(payableAmount)}</div>
                {selectedCoupon && selectedCoupon.discount > 0 && (
                  <div className="text-xs text-muted-foreground mt-1">
                    已优惠 ¥{fmtMoney(selectedCoupon.discount)}
                  </div>
                )}
              </div>
            )}

            {currentPendingOrder && (
              <div className="rounded-md border border-orange-200 bg-orange-50 p-3 text-sm dark:border-orange-900 dark:bg-orange-950/30">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-orange-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="font-medium text-orange-800 dark:text-orange-300">
                      {rechargeTarget === 'workspace' ? '该 Workspace 存在未支付订单' : '账户存在未支付订单'}
                    </div>
                    <div className="text-xs text-orange-700 dark:text-orange-400 mt-0.5">
                      订单 #{currentPendingOrder.id} 将在 <span className="font-mono font-medium">{formatCountdown(currentPendingCountdown)}</span> 后过期，点击下方「继续支付」完成该订单。
                    </div>
                  </div>
                </div>
              </div>
            )}

            <Button
              className="w-full"
              onClick={currentPendingOrder ? () => continuePayment(currentPendingOrder) : handleRecharge}
              disabled={actionLoading || (rechargeTarget === 'workspace' && !selectedWs) || loading}
              title={rechargeTarget === 'workspace' && !selectedWs ? '请先选择一个 Workspace' : loading ? '正在加载...' : ''}
            >
              {actionLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CreditCard className="w-4 h-4 mr-2" />}
              {currentPendingOrder ? '继续支付' : '充值'}
            </Button>

            {rechargeTarget === 'workspace' && !selectedWs && !loading && (
              <p className="text-xs text-red-500">
                当前未选择 Workspace，无法充值。请确认账户下存在 Workspace。
              </p>
            )}

            {channel === 'stripe' && (
              <p className="text-xs text-muted-foreground">
                Stripe 将跳转到专属 Checkout 页面完成支付
              </p>
            )}
          </CardContent>
        </Card>

        {/* Order History */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <ShoppingCart className="w-5 h-5 text-primary" />
                订单管理
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={orderStatusFilter}
                  onChange={e => { setOrderStatusFilter(e.target.value); setOrderPage(1); }}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">全部状态</option>
                  <option value="pending">待支付</option>
                  <option value="paid">已支付</option>
                  <option value="cancelled">已取消</option>
                  <option value="refunded">已退款</option>
                  <option value="expired">已过期</option>
                  <option value="failed">支付失败</option>
                </select>
                <select
                  value={orderSort}
                  onChange={e => { setOrderSort(e.target.value); setOrderPage(1); }}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="id_asc">订单 ID 从小到大</option>
                  <option value="id_desc">订单 ID 从大到小</option>
                  <option value="amount_asc">金额从低到高</option>
                  <option value="amount_desc">金额从高到低</option>
                  <option value="created_asc">时间从早到晚</option>
                  <option value="created_desc">时间从晚到早</option>
                </select>
                <span className="text-xs text-muted-foreground whitespace-nowrap">共 {orderTotal} 条</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {selectedOrderIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-3 p-2 bg-muted/40 rounded-md">
                <span className="text-xs text-muted-foreground">已选 {selectedOrderIds.length} 项</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={handleBatchCancel}
                  disabled={batchLoading}
                >
                  {batchLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <X className="w-3 h-3 mr-1" />}
                  批量取消
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={handleBatchInvoice}
                  disabled={batchLoading}
                >
                  {batchLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CreditCard className="w-3 h-3 mr-1" />}
                  批量开票
                </Button>
              </div>
            )}

            {ordersLoading && orders.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                加载中…
              </div>
            ) : orders.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center bg-muted/30 rounded-md">
                暂无订单记录
              </div>
            ) : (
              <div className="overflow-x-auto overflow-y-auto max-h-[420px] -mx-6 px-6">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-2 font-medium whitespace-nowrap w-8">
                        <input
                          type="checkbox"
                          checked={orders.length > 0 && selectedOrderIds.length === orders.length}
                          onChange={toggleSelectAll}
                          className="rounded border-input"
                        />
                      </th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">订单 ID</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">流水号</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">Workspace</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">金额</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">优惠券</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">渠道</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">状态</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">过期时间</th>
                      <th className="pb-2 pr-4 font-medium whitespace-nowrap">创建时间</th>
                      <th className="pb-2 font-medium whitespace-nowrap text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {orders.map(order => {
                      const invoice = getInvoiceForOrder(order.id);
                      const streamOrder = order.status === 'pending' ? pendingStreamOrders.find(o => o.id === order.id) : null;
                      const countdown = streamOrder ? getCountdown(streamOrder.expires_at) : (orderCountdowns[order.id] ?? null);
                      return (
                        <tr key={order.id} className="hover:bg-muted/30 transition-colors">
                          <td className="py-3 pr-2">
                            <input
                              type="checkbox"
                              checked={selectedOrderIds.includes(order.id)}
                              onChange={() => toggleSelectOrder(order.id)}
                              className="rounded border-input"
                            />
                          </td>
                          <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{order.id}</td>
                          <td className="py-3 pr-4 font-mono text-xs">{order.trade_no}</td>
                          <td className="py-3 pr-4">{order.workspace_name || '-'}</td>
                          <td className="py-3 pr-4 text-right font-medium">¥{fmtMoney(order.amount)}</td>
                          <td className="py-3 pr-4 text-xs">
                            {order.coupon_name ? (
                              <div>
                                <div className="font-medium">{order.coupon_name}</div>
                                {order.discount_amount > 0 && (
                                  <div className="text-green-600">-¥{fmtMoney(order.discount_amount)}</div>
                                )}
                              </div>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="py-3 pr-4 capitalize">{order.channel}</td>
                          <td className="py-3 pr-4">
                            <Badge variant={statusBadgeVariant(order.status)} className="text-[10px] h-5">
                              {order.status}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4 whitespace-nowrap">
                            {countdown !== null && countdown > 0 ? (
                              <span className="text-xs text-orange-600 font-medium tabular-nums">
                                {formatCountdown(countdown)}
                              </span>
                            ) : countdown === 0 ? (
                              <span className="text-xs text-muted-foreground">已过期</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-muted-foreground whitespace-nowrap">
                            {order.created_at ? new Date(order.created_at).toLocaleString('zh-CN') : '-'}
                          </td>
                          <td className="py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {order.status === 'pending' ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="default"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => continuePayment(order)}
                                    disabled={actionLoading}
                                  >
                                    {actionLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CreditCard className="w-3 h-3 mr-1" />}
                                    继续支付
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => openCancelModal(order)}
                                    disabled={cancelLoadingId === order.id}
                                  >
                                    {cancelLoadingId === order.id ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <X className="w-3 h-3 mr-1" />}
                                    取消
                                  </Button>
                                </>
                              ) : null}
                              {order.status === 'paid' && (!invoice || invoice.status !== 'issued') ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => handleInvoiceOrder(order)}
                                >
                                  开票
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {orderTotalPages > 1 && (
              <div className="flex items-center justify-between pt-4 border-t mt-4">
                <div className="text-xs text-muted-foreground">
                  第 {orderPage} / {orderTotalPages} 页
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => setOrderPage(p => Math.max(1, p - 1))}
                    disabled={orderPage <= 1 || ordersLoading}
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => setOrderPage(p => Math.min(orderTotalPages, p + 1))}
                    disabled={orderPage >= orderTotalPages || ordersLoading}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Invoice Management */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Receipt className="w-5 h-5 text-primary" />
            发票管理
          </CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center bg-muted/30 rounded-md">
              暂无发票记录
            </div>
          ) : (
            <div className="space-y-2 max-h-[360px] overflow-auto pr-1">
              {invoices.map(inv => (
                <div key={inv.id} className="flex items-center justify-between px-4 py-3 rounded-md bg-muted/30 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{inv.title || 'Workspace 充值'}</span>
                      <Badge variant={inv.status === 'issued' ? 'success' : inv.status === 'failed' ? 'destructive' : inv.status === 'rejected' ? 'outline' : inv.status === 'removed' ? 'secondary' : 'secondary'} className="text-[10px] h-5">
                        {inv.status === 'issued' ? '已开票' : inv.status === 'failed' ? '失败' : inv.status === 'rejected' ? '已拒绝' : inv.status === 'removed' ? '已移除' : '待处理'}
                      </Badge>
                      {inv.review_status && (
                        <Badge variant={inv.review_status === 'approved' ? 'success' : inv.review_status === 'rejected' ? 'destructive' : 'warning'} className="text-[10px] h-5">
                          {inv.review_status === 'approved' ? '已审核' : inv.review_status === 'rejected' ? '审核拒绝' : '审核中'}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      发票号：{inv.invoice_no || '-'} · 金额 ¥{fmtMoney(inv.amount)} · {inv.created_at ? new Date(inv.created_at).toLocaleString('zh-CN') : '-'}
                      {inv.status === 'issued' && inv.file_expires_at && (
                        <span className="ml-2">
                          有效期至：{formatInvoiceExpiry(inv.file_expires_at)}
                          {hoursUntilInvoiceExpiry(inv.file_expires_at) <= 24 && (
                            <span className="text-destructive ml-1">(即将过期)</span>
                          )}
                        </span>
                      )}
                    </div>
                    {inv.rejected_reason && (
                      <button
                        onClick={() => setRejectReasonModal(inv.rejected_reason)}
                        className="text-xs text-destructive mt-1 underline hover:no-underline"
                      >
                        查看拒绝说明
                      </button>
                    )}
                  </div>
                  <div className="shrink-0 ml-4">
                    {inv.status === 'issued' && inv.invoice_url ? (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleDownloadInvoice(inv)}>
                        <Download className="w-3 h-3 mr-1" />
                        下载
                      </Button>
                    ) : inv.status === 'removed' ? (
                      <span className="text-xs text-muted-foreground">已过期</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reject Reason Modal */}
      {rejectReasonModal && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-background rounded-xl shadow-2xl border w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-destructive" />
                <h2 className="text-lg font-semibold">拒绝说明</h2>
              </div>
              <button onClick={() => setRejectReasonModal(null)} className="p-1.5 rounded-md hover:bg-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <div className="max-h-[300px] overflow-auto text-sm whitespace-pre-wrap bg-muted/30 rounded-md p-4">
                {rejectReasonModal}
              </div>
              <div className="mt-4 flex justify-end">
                <Button onClick={() => setRejectReasonModal(null)}>关闭</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Billing Records }}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="w-5 h-5 text-primary" />
            计费记录
            {selectedWorkspaceName && <span className="text-sm font-normal text-muted-foreground">- {selectedWorkspaceName}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!selectedWs ? (
            <div className="text-sm text-muted-foreground py-8 text-center bg-muted/30 rounded-md">
              请选择工作空间
            </div>
          ) : billingRecords.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center bg-muted/30 rounded-md">
              暂无计费记录
            </div>
          ) : (
            <div className="space-y-2 max-h-[500px] overflow-auto pr-1">
              {billingRecords.map(record => (
                <div key={record.id} className="flex items-center justify-between px-4 py-3 rounded-md bg-muted/30 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{record.description || record.type}</div>
                    <div className="text-xs text-muted-foreground">
                      {record.created_at ? new Date(record.created_at).toLocaleString('zh-CN') : '-'}
                    </div>
                  </div>
                  <div className={cn(
                    "font-medium shrink-0 ml-4",
                    record.type === 'recharge' ? 'text-green-600' : 'text-red-600'
                  )}>
                    {record.type === 'recharge' ? '+' : '-'}¥{fmtMoney(Math.abs(record.amount))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cancel Order Modal */}
      {cancelModalOrder && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-background rounded-xl shadow-2xl border w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-destructive" />
                <h2 className="text-lg font-semibold">取消订单</h2>
              </div>
              <button
                onClick={closeCancelModal}
                className="p-1.5 rounded-md hover:bg-muted transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                确定要取消订单 <span className="font-mono font-medium text-foreground">#{cancelModalOrder.id}</span> 吗？此操作不可撤销。
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={closeCancelModal}>
                  再想想
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={confirmCancelOrder}
                  disabled={cancelLoadingId === cancelModalOrder.id}
                >
                  {cancelLoadingId === cancelModalOrder.id ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  确认取消
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Alipay QR Modal */}
      {qrUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-background rounded-xl shadow-2xl border w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div className="flex items-center gap-2">
                <QrCode className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">扫码支付</h2>
              </div>
              <button
                onClick={handleCancelQr}
                className="p-1.5 rounded-md hover:bg-muted transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 flex flex-col items-center text-center space-y-4">
              <img
                src={qrUrl}
                alt="支付宝付款二维码"
                className="w-64 h-64 rounded-lg border object-contain"
              />
              <div className="space-y-1">
                <p className="text-base font-medium">请使用支付宝扫一扫</p>
                <p className="text-sm text-muted-foreground">支付完成后将自动到账</p>
              </div>
              {qrCountdown !== null && (
                <div className="flex items-center gap-2 text-sm font-medium text-amber-600 bg-amber-50 px-3 py-1.5 rounded-md">
                  <Clock className="w-4 h-4" />
                  <span>二维码有效期：{Math.floor(qrCountdown / 60)}:{String(qrCountdown % 60).padStart(2, '0')}</span>
                </div>
              )}
              <Button variant="default" className="w-full" onClick={handleJumpToAlipay} disabled={!paymentForm}>
                <ExternalLink className="w-4 h-4 mr-2" />
                跳转支付宝网页付款
              </Button>
              <div className="text-left w-full rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5" />
                  安全提示
                </p>
                <p>• 请认准支付宝官方域名（alipay.com），谨防钓鱼网站。</p>
                <p>• 请勿将二维码截图或发送给他人，避免资金被劫持。</p>
                <p>• 完成支付前请勿关闭本窗口，支付结果将自动同步。</p>
              </div>
              <Button variant="outline" className="w-full" onClick={handleCancelQr}>
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
