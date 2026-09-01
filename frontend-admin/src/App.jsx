import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

const routerFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
};
import { ThemeProvider } from './hooks/useTheme';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { DialogProvider } from './components/Dialog';
import ErrorBoundary from './components/ErrorBoundary';

import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Sources from './pages/Sources';
import UsersCurrent from './pages/UsersCurrent';
import UsersNewConfig from './pages/UsersNewConfig';
import UsersRegistration from './pages/UsersRegistration';
import Settings from './pages/Settings';
import SecuritySettings from './pages/SecuritySettings';
import ModelGroups from './pages/ModelGroups';
import AuditLogs from './pages/AuditLogs';
import LogManagement from './pages/LogManagement';
import Probe from './pages/Probe';
import Workspaces from './pages/Workspaces';
import PaymentManager from './pages/PaymentManager';
import PaymentGateway from './pages/PaymentGateway';
import Orders from './pages/Orders';
import InvoiceManager from './pages/InvoiceManager';
import CouponManager from './pages/CouponManager';
import Routing from './pages/Routing';
import SecondAuthDialogProvider from './components/SecondAuthDialog';

import DatabaseStatus from './pages/DatabaseStatus';
import CacheManagement from './pages/CacheManagement';
import ModelPlazaConfig from './pages/ModelPlazaConfig';
import WebChatConfig from './pages/WebChatConfig';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  if (!user) {
    return <Navigate to="/login" />;
  }

  if (!['admin', 'moderator'].includes(user.role)) {
    return <Navigate to="/login" />;
  }

  return children;
}

function AdminRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  if (!user || !['admin', 'moderator'].includes(user.role)) {
    return <Navigate to="/login" replace />;
  }

  return (
    <ErrorBoundary>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/users" element={<Navigate to="/users/current" replace />} />
          <Route path="/users/current" element={<UsersCurrent />} />
          <Route path="/users/new-config" element={<UsersNewConfig />} />
          <Route path="/users/registration" element={<UsersRegistration />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/security" element={<SecuritySettings />} />
          <Route path="/model-groups" element={<ModelGroups />} />
          <Route path="/audit-logs" element={<AuditLogs />} />
          <Route path="/log-management" element={<LogManagement />} />
          <Route path="/probe" element={<Probe />} />
          <Route path="/routing" element={<Routing />} />

          <Route path="/workspaces" element={<Workspaces />} />
          <Route path="/model-plaza-config" element={<ModelPlazaConfig />} />
          <Route path="/database-status" element={<DatabaseStatus />} />
          <Route path="/cache-management" element={<CacheManagement />} />
          <Route path="/webchat-config" element={<WebChatConfig />} />
          <Route path="/billing" element={<PaymentManager />} />
          <Route path="/payment-gateway" element={<PaymentGateway />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/invoices" element={<InvoiceManager />} />
          <Route path="/coupons" element={<CouponManager />} />
          </Routes>
        </Layout>
    </ErrorBoundary>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const handleMainAuthExpired = () => {
      navigate('/login', { replace: true });
    };
    window.addEventListener('main-auth-expired', handleMainAuthExpired);
    return () => window.removeEventListener('main-auth-expired', handleMainAuthExpired);
  }, [navigate]);

  useEffect(() => {
    if (!user) return;
    const SECOND_AUTH_IDLE_TIMEOUT = 32 * 60 * 1000; // 32 minutes
    const PAYMENT_AUTH_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    let secondAuthTimer;
    let paymentAuthTimer;

    const lockSecondAuth = () => {
      localStorage.removeItem('second_auth_token');
      window.dispatchEvent(new CustomEvent('second-auth-idle-locked'));
    };

    const lockPaymentAuth = () => {
      localStorage.removeItem('payment_auth_token');
      window.dispatchEvent(new CustomEvent('payment-auth-idle-locked'));
    };

    const resetTimers = () => {
      clearTimeout(secondAuthTimer);
      clearTimeout(paymentAuthTimer);
      secondAuthTimer = setTimeout(lockSecondAuth, SECOND_AUTH_IDLE_TIMEOUT);
      paymentAuthTimer = setTimeout(lockPaymentAuth, PAYMENT_AUTH_IDLE_TIMEOUT);
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(e => document.addEventListener(e, resetTimers, { passive: true }));
    resetTimers();

    return () => {
      clearTimeout(secondAuthTimer);
      clearTimeout(paymentAuthTimer);
      events.forEach(e => document.removeEventListener(e, resetTimers));
    };
  }, [user]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<AdminRoutes />} />
          </Routes>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <DialogProvider>
        <SecondAuthDialogProvider>
          <AuthProvider>
            <BrowserRouter future={routerFuture}>
              <AppRoutes />
            </BrowserRouter>
          </AuthProvider>
        </SecondAuthDialogProvider>
      </DialogProvider>
    </ThemeProvider>
  );
}
