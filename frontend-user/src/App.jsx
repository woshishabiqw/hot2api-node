import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

const routerFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
};
import { ThemeProvider } from './hooks/useTheme';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import ApiKeys from './pages/ApiKeys';
import Usage from './pages/Usage';
import Docs from './pages/Docs';
import Models from './pages/Models';
import Chat from './pages/Chat';
import Workspaces from './pages/Workspaces';
import Wallet from './pages/Wallet';
import Coupons from './pages/Coupons';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  
  if (!user) {
    return <Navigate to="/login" />;
  }
  
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/*"
          element={
            <PrivateRoute>
              <Layout>
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/keys" element={<ApiKeys />} />
                    <Route path="/usage" element={<Usage />} />
                    <Route path="/models" element={<Models />} />
                    <Route path="/chat" element={<Chat />} />
                    <Route path="/docs" element={<Docs />} />
                    <Route path="/workspaces" element={<Workspaces />} />
                    <Route path="/wallet" element={<Wallet />} />
                    <Route path="/coupons" element={<Coupons />} />
                  </Routes>
                </ErrorBoundary>
              </Layout>
            </PrivateRoute>
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter future={routerFuture}>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
